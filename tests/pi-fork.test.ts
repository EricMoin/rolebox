/**
 * PiSessionAdapter fork() tests — filesystem-backed session forking.
 *
 * Verifies that fork() copies a session's JSONL file to a new id in the
 * same workspace directory, optionally truncating at a given messageID,
 * and returns null only when the source session file does not exist.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, basename, extname } from "node:path";
import { tmpdir } from "node:os";
import { PiSessionAdapter } from "../src/platform/adapters/pi/session.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a temporary fixture directory with the given workspace path encoding.
 * Returns the temp root path.
 */
function createFixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-fork-test-"));
}

/**
 * Build a workspace directory name matching Pi's path encoding.
 * Pi replaces "/" with ";" and prepends ";".
 */
function encodeWorkspacePath(absPath: string): string {
  const normalized = absPath.replace(/^\/+/, "");
  return ";" + normalized.split("/").join(";");
}

/**
 * Create a minimal message JSON for a user message in a session.
 */
function userMessage(
  sessionID: string,
  messageID: string,
  text: string,
  timestamp?: number,
): object {
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: timestamp ?? Date.now() },
    },
    parts: [
      {
        id: `${messageID}-p1`,
        sessionID,
        messageID,
        type: "text",
        text,
      },
    ],
  };
}

/**
 * Create a minimal message JSON for an assistant message.
 */
function assistantMessage(
  sessionID: string,
  messageID: string,
  text: string,
  timestamp?: number,
  modelID?: string,
): object {
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      time: { created: timestamp ?? Date.now(), completed: (timestamp ?? Date.now()) + 1000 },
      modelID: modelID ?? "test-model",
    },
    parts: [
      {
        id: `${messageID}-p1`,
        sessionID,
        messageID,
        type: "text",
        text,
      },
    ],
  };
}

/**
 * Create a JSONL file with the given message objects (one per line).
 */
function writeJsonlFile(filePath: string, messages: object[]): void {
  const lines = messages.map((m) => JSON.stringify(m)).join("\n");
  writeFileSync(filePath, lines + "\n", "utf-8");
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const SESSION_ID = "session-fork-source";
const MESSAGES = [
  userMessage(SESSION_ID, "msg-1", "Implement the login feature", 1700000000000),
  assistantMessage(SESSION_ID, "msg-2", "I'll add a login form component", 1700000010000, "claude-3"),
  userMessage(SESSION_ID, "msg-3", "Looks good, ship it", 1700000020000),
];

describe("PiSessionAdapter — fork()", () => {
  let tmpDir: string;
  let wsDir: string;
  let adapter: PiSessionAdapter;
  const TEST_WORKSPACE = "/Users/test/project";

  beforeEach(() => {
    tmpDir = createFixtureDir();
    wsDir = join(tmpDir, encodeWorkspacePath(TEST_WORKSPACE));
    mkdirSync(wsDir, { recursive: true });

    writeJsonlFile(join(wsDir, `${SESSION_ID}.jsonl`), MESSAGES);

    adapter = new PiSessionAdapter(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fork() returns SessionInfo with a different id", async () => {
    const forkInfo = await adapter.fork(SESSION_ID);
    expect(forkInfo).not.toBeNull();
    expect(forkInfo!.id).not.toBe(SESSION_ID);
    expect(forkInfo!.id.length).toBeGreaterThan(0);
  });

  it("fork() writes the new session file in the same workspace dir", async () => {
    const forkInfo = await adapter.fork(SESSION_ID);
    expect(forkInfo).not.toBeNull();

    const forkPath = join(wsDir, `${forkInfo!.id}.jsonl`);
    expect(existsSync(forkPath)).toBe(true);

    // Only the source + fork exist in the workspace dir.
    const files = readdirSync(wsDir)
      .filter((f) => extname(f) === ".jsonl")
      .map((f) => basename(f, ".jsonl"))
      .sort();
    expect(files).toEqual([SESSION_ID, forkInfo!.id].sort());
  });

  it("fork() produces a session whose messages equal the source", async () => {
    const forkInfo = await adapter.fork(SESSION_ID);
    expect(forkInfo).not.toBeNull();

    const sourceMessages = await adapter.messages(SESSION_ID);
    const forkMessages = await adapter.messages(forkInfo!.id);
    expect(forkMessages).toEqual(sourceMessages);
    expect(forkMessages).toHaveLength(MESSAGES.length);
  });

  it("fork() with messageID truncates to messages up to and including it", async () => {
    const forkInfo = await adapter.fork(SESSION_ID, { messageID: "msg-2" });
    expect(forkInfo).not.toBeNull();

    const forkMessages = await adapter.messages(forkInfo!.id);
    expect(forkMessages).toHaveLength(2);
    expect(forkMessages).toEqual(await adapter.messages(SESSION_ID, { limit: 2 }));
    expect(forkMessages.map((m) => m.info?.id)).toEqual(["msg-1", "msg-2"]);
  });

  it("fork() with messageID equal to the last message copies the full session", async () => {
    const forkInfo = await adapter.fork(SESSION_ID, { messageID: "msg-3" });
    expect(forkInfo).not.toBeNull();

    const forkMessages = await adapter.messages(forkInfo!.id);
    expect(forkMessages).toEqual(await adapter.messages(SESSION_ID));
  });

  it("fork() on a missing session id returns null", async () => {
    const forkInfo = await adapter.fork("non-existent-session");
    expect(forkInfo).toBeNull();
  });

  it("fork() honors the directory scope when provided", async () => {
    // Session is in TEST_WORKSPACE — forking with a different directory fails.
    const wrongDir = await adapter.fork(SESSION_ID, { directory: "/other/path" });
    expect(wrongDir).toBeNull();

    const rightDir = await adapter.fork(SESSION_ID, { directory: TEST_WORKSPACE });
    expect(rightDir).not.toBeNull();
    expect(rightDir!.id).not.toBe(SESSION_ID);
  });
});
