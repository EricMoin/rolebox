/**
 * Dispatch integration tests — verifies the full dispatch lifecycle
 * using a real opencode server and real session APIs.
 *
 * These tests:
 *   - Start a real opencode server (via @opencode-ai/sdk)
 *   - Create a session on the platform
 *   - Launch a dispatch task via DispatchManager
 *   - Verify the task lifecycle (created → running → completed)
 *   - Extract result text from the completed session
 *
 * They are additive — they create new files under tests/integration/ and
 * do NOT modify any existing test files.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { createOpencodeServer, createOpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";

import { DispatchManager } from "../../src/dispatch/core/manager.ts";
import { DEFAULT_CONFIG } from "../../src/dispatch/config.ts";
import { OpencodeSessionAdapter } from "../../src/platform/adapters/opencode/session.ts";
import { cleanupTestState } from "./helpers.ts";
import { hasOpencode } from "../helpers/opencode";

// ── Server-level setup ──────────────────────────────────────────────────────

let server: { url: string; close(): void };
let client: OpencodeClient;
let tmpDir: string;

beforeAll(async () => {
  cleanupTestState();
  if (!hasOpencode()) return;
  // Start a real opencode server. Port 0 = random available port.
  server = await createOpencodeServer({ port: 0, timeout: 15_000 });
  client = createOpencodeClient({ baseUrl: server.url });
  tmpDir = mkdtempSync(path.join(tmpdir(), "dispatch-int-"));
});

afterAll(() => {
  if (server) server.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a parent session on the real platform.
 * Returns the session ID string.
 */
async function createParentSession(): Promise<string> {
  const result = await client.session.create({
    query: { directory: tmpDir },
  });
  expect(result.data).toBeDefined();
  return result.data!.id;
}

/**
 * Wait for a session to reach "completed" status by polling its messages
 * for a response with finish === "stop". Returns the last assistant text.
 */
async function waitForSessionCompletion(
  sessionId: string,
  timeoutMs = 60_000,
  pollIntervalMs = 500,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgResult = await client.session.messages({
      path: { id: sessionId },
    });
    const messages = msgResult.data ?? [];

    // Find the last assistant message with a "stop" finish reason
    const assistantMsgs = messages.filter(
      (m: any) =>
        m.info?.role === "assistant" && m.info?.finish === "stop",
    );
    if (assistantMsgs.length > 0) {
      const last = assistantMsgs[assistantMsgs.length - 1];
      const textParts = (last.parts ?? [])
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join(" ");
      return textParts || "(no text content)";
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return "TIMEOUT: session did not complete within the deadline";
}

/**
 * Extract assistant text from session messages.
 */
async function getSessionResult(sessionId: string): Promise<string> {
  const msgResult = await client.session.messages({
    path: { id: sessionId },
  });
  const messages = msgResult.data ?? [];
  const assistantMsgs = messages
    .filter((m: any) => m.info?.role === "assistant" && m.info?.finish === "stop")
    .sort(
      (a: any, b: any) => (a.info?.time?.created ?? 0) - (b.info?.time?.created ?? 0),
    );
  if (assistantMsgs.length === 0) return "";
  const last = assistantMsgs[assistantMsgs.length - 1];
  const texts = (last.parts ?? [])
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text);
  return texts.join(" ");
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe.skipIf(!hasOpencode())("dispatch integration — real platform API", () => {
  it("creates a real session on the opencode platform", async () => {
    const sessionId = await createParentSession();
    expect(sessionId).toBeTruthy();
    expect(sessionId).toMatch(/^ses_/);

    // Verify the session can be fetched back
    const getResult = await client.session.get({
      path: { id: sessionId },
    });
    expect(getResult.data).toBeDefined();
    expect(getResult.data!.id).toBe(sessionId);
  }, 15_000);

  it("launches a background dispatch task and transitions to running", async () => {
    const sessionAdapter = new OpencodeSessionAdapter(client);
    const manager = new DispatchManager(sessionAdapter, {
      ...DEFAULT_CONFIG,
      // Use large intervals so internal timers don't fire during the test
      watchdogIntervalMs: 120_000,
      globalSweepIntervalMs: 120_000,
      idleDebounceMs: 120_000,
    });
    manager.setStoreDirectory(tmpDir);
    await manager.recover();

    const parentSessionId = await createParentSession();

    const task = await manager.launch(
      {
        subagent: "emperor",
        prompt: "Say 'hello' and nothing else",
        run_in_background: true,
      },
      {
        sessionID: parentSessionId,
        agent: "emperor--jinyiwei",
        directory: tmpDir,
      },
    );

    // (a) Launch creates a task with running status
    expect(task.id).toBeTruthy();
    expect(task.id).toMatch(/^bg_/);
    expect(task.status).toBe("running");
    expect(task.agent).toBe("emperor");
    expect(task.sessionId).toBeTruthy();

    // (b) Session is created on the opencode platform
    const session = await client.session.get({
      path: { id: task.sessionId },
    });
    expect(session.data).toBeDefined();
    expect(session.data!.id).toBe(task.sessionId);
  }, 30_000);

  it("completes a dispatch session and produces a result (via promptAsync + polling)", async () => {
    // (c) Completion detection via polling
    const sessionId = await createParentSession();

    // Send a fire-and-forget prompt (same as what dispatch does internally)
    await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: "Reply with exactly one word: hello" }],
        agent: "emperor",
      },
    });

    // Poll until the assistant responds with a "stop" finish
    const resultText = await waitForSessionCompletion(sessionId, 60_000);

    // (d) Result text is extracted from the session
    expect(resultText).toBeTruthy();
    expect(resultText).not.toBe("TIMEOUT: session did not complete within the deadline");
    expect(resultText.toLowerCase()).toContain("hello");
  }, 120_000);

  it("extracts result text from a session using promptAsync", async () => {
    // Create a session and send a fire-and-forget prompt
    const sessionId = await createParentSession();
    await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: "Echo back: ping" }],
        agent: "emperor",
      },
    });

    const result = await waitForSessionCompletion(sessionId, 60_000);
    expect(result).toBeTruthy();
    expect(result).not.toBe("TIMEOUT: session did not complete within the deadline");
    expect(result.toLowerCase()).toContain("ping");
  }, 120_000);
});
