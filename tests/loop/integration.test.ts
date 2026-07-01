import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { LoopManager, LOOP_PROGRESS_MARKER } from "../../src/loop";
import type { LoopState } from "../../src/loop/types";
import { normalizeWorkspaceDir } from "../../src/state-paths";
import {
  createPluginHooks,
  activeLoopManager,
  pendingCorrections,
  userMessagedSessions,
  loopManagerMap,
  managerMap,
} from "../../src/plugin-hooks";

function loopMockClient(overrides?: {
  sessionCreate?: (...args: unknown[]) => unknown;
  sessionPromptAsync?: (...args: unknown[]) => unknown;
  sessionPrompt?: (...args: unknown[]) => unknown;
  sessionMessages?: (...args: unknown[]) => unknown;
  sessionDelete?: (...args: unknown[]) => unknown;
}): OpencodeClient {
  return {
    session: {
      create: mock(
        overrides?.sessionCreate ??
          (() =>
            Promise.resolve({
              data: { id: "test-session-1" },
              error: undefined,
            })),
      ),
      promptAsync: mock(
        overrides?.sessionPromptAsync ??
          (() =>
            Promise.resolve({
              data: undefined,
              error: undefined,
            })),
      ),
      prompt: mock(
        overrides?.sessionPrompt ??
          (() =>
            Promise.resolve({
              data: {
                parts: [{ type: "text" as const, text: "summary from mock" }],
              },
              error: undefined,
            })),
      ),
      messages: mock(
        overrides?.sessionMessages ??
          (() =>
            Promise.resolve({
              data: [],
              error: undefined,
            })),
      ),
      delete: mock(
        overrides?.sessionDelete ??
          (() =>
            Promise.resolve({
              data: true,
              error: undefined,
            })),
      ),
    },
  } as unknown as OpencodeClient;
}

function pluginMockClient(): OpencodeClient {
  return {
    session: {
      create: mock(() =>
        Promise.resolve({ data: { id: "test-child" }, error: undefined }),
      ),
      prompt: mock(() =>
        Promise.resolve({
          data: { parts: [{ type: "text", text: "ok" }] },
          error: undefined,
        }),
      ),
      promptAsync: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      messages: mock(() =>
        Promise.resolve({ data: [], error: undefined }),
      ),
      status: mock(() =>
        Promise.resolve({ data: {}, error: undefined }),
      ),
      abort: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      get: mock(() =>
        Promise.resolve({ data: { id: "test" }, error: undefined }),
      ),
      delete: mock(() =>
        Promise.resolve({ data: true, error: undefined }),
      ),
    },
  } as unknown as OpencodeClient;
}

function sequentialIds(prefix: string): () => unknown {
  let n = 1;
  return () =>
    Promise.resolve({ data: { id: `${prefix}-${n++}` }, error: undefined });
}

function promptAsyncBody(call: unknown[]): {
  agent?: string;
  parts?: Array<{ type: string; text?: string }>;
  noReply?: boolean;
} {
  const arg = (call[0] as { body?: Record<string, unknown> })?.body ?? {};
  return arg as {
    agent?: string;
    parts?: Array<{ type: string; text?: string }>;
    noReply?: boolean;
  };
}

function promptAsyncPathId(call: unknown[]): string | undefined {
  const arg = call[0] as { path?: { id?: string } } | undefined;
  return arg?.path?.id;
}

function callsTo(
  calls: unknown[][],
  sessionId: string,
): unknown[][] {
  return calls.filter((c) => promptAsyncPathId(c) === sessionId);
}

const ORIGIN_SID = "ses_origin";
const AGENT = "test-agent";
const PROMPT = "do the loop thing";

describe("LoopManager integration", () => {
  beforeEach(() => {
    mock.restore();
  });

  function newManager(client?: OpencodeClient): LoopManager {
    return new LoopManager(client ?? loopMockClient(), { delayMs: 0 });
  }

  // ── Scenario 1: iterations=1 (degenerate) ─────────────────────────
  describe("Scenario 1: iterations=1 degenerate", () => {
    it("completes immediately with zero children spawned", async () => {
      const client = loopMockClient();
      const manager = newManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 1,
      });

      await manager.onRoundComplete(ORIGIN_SID);

      expect(client.session.create).not.toHaveBeenCalled();

      const loop = manager.getLoopState(ORIGIN_SID);
      expect(loop).toBeDefined();
      expect(loop!.status).toBe("complete");
      expect(loop!.current).toBe(1);
    });

    it("injects a completion note with LOOP_PROGRESS_MARKER and noReply:true", async () => {
      const client = loopMockClient();
      const manager = newManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 1,
      });

      await manager.onRoundComplete(ORIGIN_SID);

      const allCalls = (client.session.promptAsync as any).mock.calls as unknown[][];
      const originCalls = callsTo(allCalls, ORIGIN_SID);
      expect(originCalls.length).toBeGreaterThanOrEqual(1);

      const last = originCalls[originCalls.length - 1];
      const body = promptAsyncBody(last);
      expect(body.noReply).toBe(true);
      expect(body.parts?.[0]?.text).toContain(LOOP_PROGRESS_MARKER);
      expect(body.parts?.[0]?.text).toContain("loop complete");
    });
  });

  // ── Scenario 2: iterations=3 fresh ────────────────────────────────
  describe("Scenario 2: iterations=3 fresh", () => {
    it("spawns 2 children with correct agent + base prompt, completes after 3 rounds", async () => {
      const client = loopMockClient({
        sessionCreate: sequentialIds("child"),
      });
      const manager = newManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });

      await manager.onRoundComplete(ORIGIN_SID);
      await manager.onRoundComplete("child-1");
      await manager.onRoundComplete("child-2");

      const loop = manager.getLoopState(ORIGIN_SID);
      expect(loop).toBeDefined();
      expect(loop!.status).toBe("complete");
      expect(loop!.current).toBe(3);
      expect(loop!.total).toBe(3);

      expect(client.session.create).toHaveBeenCalledTimes(2);

      const allPromptCalls = (client.session.promptAsync as any).mock.calls as unknown[][];
      const childCalls = allPromptCalls.filter(
        (c) => promptAsyncPathId(c)?.startsWith("child-"),
      );
      expect(childCalls.length).toBe(2);
      for (const call of childCalls) {
        const body = promptAsyncBody(call);
        expect(body.agent).toBe(AGENT);
        expect(body.parts?.[0]?.text).toBe(PROMPT);
      }
    });

    it("writes evidence JSON after 3-round fresh loop", async () => {
      const client = loopMockClient({
        sessionCreate: sequentialIds("child"),
      });
      const manager = newManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });

      await manager.onRoundComplete(ORIGIN_SID);
      await manager.onRoundComplete("child-1");
      await manager.onRoundComplete("child-2");

      const state = manager.getLoopState(ORIGIN_SID);
      expect(state).toBeDefined();

      const evidencePath = ".rolebox/evidence/final-qa/loop-3-fresh-state.json";
      mkdirSync(dirname(evidencePath), { recursive: true });
      writeFileSync(evidencePath, JSON.stringify(state, null, 2));

      const { readFileSync } = await import("node:fs");
      const raw = readFileSync(evidencePath, "utf-8");
      const parsed = JSON.parse(raw) as LoopState;
      expect(parsed.status).toBe("complete");
      expect(parsed.current).toBe(3);
      expect(parsed.total).toBe(3);
      expect(parsed.mode).toBe("fresh");
      expect(parsed.originSessionId).toBe(ORIGIN_SID);
    });
  });

  // ── Scenario 3: iterations=3 inherit ──────────────────────────────
  describe("Scenario 3: iterations=3 inherit", () => {
    it("summarizer invoked between rounds; child prompt begins with summary block", async () => {
      const SUMMARY_1 = "Round 1 summary: built auth module.";
      const SUMMARY_2 = "Round 2 summary: added tests.";

      let promptCallCount = 0;
      const client = loopMockClient({
        sessionCreate: sequentialIds("child"),
        sessionMessages: () =>
          Promise.resolve({
            data: [
              {
                info: { role: "assistant" as const },
                parts: [
                  { type: "text" as const, text: "I implemented the auth module." },
                ],
              },
            ],
            error: undefined,
          }),
        sessionPrompt: () => {
          promptCallCount++;
          return Promise.resolve({
            data: {
              parts: [
                {
                  type: "text" as const,
                  text: promptCallCount === 1 ? SUMMARY_1 : SUMMARY_2,
                },
              ],
            },
            error: undefined,
          });
        },
      });
      const manager = newManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "inherit",
        iterations: 3,
      });

      await manager.onRoundComplete(ORIGIN_SID);

      expect(client.session.prompt).toHaveBeenCalled();

      const allPrompts1 = (client.session.promptAsync as any).mock.calls as unknown[][];
      const child1Calls = allPrompts1.filter(
        (c) => promptAsyncPathId(c)?.startsWith("child-"),
      );
      expect(child1Calls.length).toBe(1);
      const child1Prompt = promptAsyncBody(child1Calls[0]).parts?.[0]?.text ?? "";
      expect(child1Prompt).toContain(SUMMARY_1);
      expect(child1Prompt).toContain("---");
      expect(child1Prompt).toContain(PROMPT);

      const loopAfterRound1 = manager.getByActiveSession("child-2");
      expect(loopAfterRound1?.lastSummary).toBe(SUMMARY_1);

      await manager.onRoundComplete("child-2");

      const allPrompts2 = (client.session.promptAsync as any).mock.calls as unknown[][];
      const child2Calls = allPrompts2.filter(
        (c) => promptAsyncPathId(c)?.startsWith("child-"),
      );
      expect(child2Calls.length).toBe(2);
      const child2Prompt = promptAsyncBody(child2Calls[1]).parts?.[0]?.text ?? "";
      expect(child2Prompt).toContain(SUMMARY_2);
      expect(child2Prompt).toContain(PROMPT);

      expect(promptCallCount).toBe(2);

      await manager.onRoundComplete("child-4");
      const finalLoop = manager.getLoopState(ORIGIN_SID);
      expect(finalLoop?.status).toBe("complete");
    });

    it("falls back to base prompt on summarizer ok:false", async () => {
      const client = loopMockClient({
        sessionCreate: sequentialIds("child"),
        sessionMessages: () =>
          Promise.resolve({
            data: [
              {
                info: { role: "assistant" as const },
                parts: [{ type: "text" as const, text: "Round 1 output." }],
              },
            ],
            error: undefined,
          }),
        sessionPrompt: () =>
          Promise.resolve({
            data: undefined,
            error: { message: "summarizer failed" },
          }),
      });
      const manager = newManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "inherit",
        iterations: 3,
      });

      await manager.onRoundComplete(ORIGIN_SID);

      const allPrompts = (client.session.promptAsync as any).mock.calls as unknown[][];
      const childCalls = allPrompts.filter(
        (c) => promptAsyncPathId(c)?.startsWith("child-"),
      );
      expect(childCalls.length).toBe(1);
      expect(promptAsyncBody(childCalls[0]).parts?.[0]?.text).toBe(PROMPT);
    });
  });

  // ── Scenario 4: Cancel mid-loop via user message ──────────────────
  describe("Scenario 4: Cancel mid-loop via user message", () => {
    let hooks: Awaited<ReturnType<typeof createPluginHooks>>;
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), "rolebox-loop-integ-"));
      pendingCorrections.clear();
      userMessagedSessions.clear();
      const client = pluginMockClient();
      hooks = await createPluginHooks([], client, new Map(), new Map(), tmpDir);
    });

    afterEach(() => {
      loopManagerMap.clear();
      managerMap.clear();
      rmSync(tmpDir, { recursive: true, force: true });
      mock.restore();
    });

    it("genuine user message on looping origin cancels remaining rounds", async () => {
      const sid = "ses_cancel_001";

      activeLoopManager!.register({
        originSessionId: sid,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });

      const advanceSpy = spyOn(activeLoopManager!, "onRoundComplete");
      await hooks.event({
        event: { type: "session.idle", properties: { sessionID: sid } },
      });
      expect(advanceSpy).toHaveBeenCalled();
      advanceSpy.mockRestore();

      mock.restore();

      const cancelSpy = spyOn(activeLoopManager!, "requestCancel");
      const output = {
        parts: [{ type: "text" as const, text: "stop the loop" }],
      };
      await hooks["chat.message"](
        { agent: AGENT, sessionID: sid },
        output,
      );

      expect(cancelSpy).toHaveBeenCalledWith(sid, "user message");
      expect(userMessagedSessions.has(sid)).toBe(true);
    });

    it("no further session.create after cancel via user message", async () => {
      const sid = "ses_cancel_002";

      activeLoopManager!.register({
        originSessionId: sid,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });

      await hooks.event({
        event: { type: "session.idle", properties: { sessionID: sid } },
      });

      expect(activeLoopManager!.getLoopState(sid)?.current).toBeGreaterThanOrEqual(1);

      activeLoopManager!.requestCancel(sid, "user message");

      expect(activeLoopManager!.getLoopState(sid)?.cancelRequested).toBe(true);

      const loop = activeLoopManager!.getLoopState(sid);
      if (loop && loop.activeSessionId !== sid) {
        await activeLoopManager!.onRoundComplete(loop.activeSessionId);
      }

      const finalLoop = activeLoopManager!.getLoopState(sid);
      expect(finalLoop?.status).toBe("cancelled");

      const allCalls = (activeLoopManager!["client"] as OpencodeClient).session
        .promptAsync as any;
      const originCalls = (allCalls.mock?.calls as unknown[][] ?? []).filter(
        (c: unknown[]) => {
          const arg = (c[0] as { path?: { id?: string } })?.path?.id;
          return arg === sid;
        },
      );
      const cancelNote = originCalls.find(
        (c: unknown[]) => {
          const body = (c[0] as { body?: { parts?: Array<{ text?: string }> } })?.body;
          return (body?.parts?.[0]?.text ?? "").includes("loop cancelled");
        },
      );
      expect(cancelNote).toBeDefined();
    });
  });

  // ── Scenario 5: Cancel race (cancelRequested during summarizer) ───
  describe("Scenario 5: Cancel race", () => {
    it("no child spawned when cancelRequested is set during summarizer await", async () => {
      let summarizerResolve: ((v: unknown) => void) | undefined;

      const client = loopMockClient({
        sessionCreate: sequentialIds("child"),
        sessionMessages: () =>
          Promise.resolve({
            data: [
              {
                info: { role: "assistant" as const },
                parts: [{ type: "text" as const, text: "round output" }],
              },
            ],
            error: undefined,
          }),
        sessionPrompt: () =>
          new Promise((resolve) => {
            summarizerResolve = resolve;
          }),
      });
      const manager = newManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "inherit",
        iterations: 3,
      });

      const advancePromise = manager.onRoundComplete(ORIGIN_SID);

      await new Promise((r) => setTimeout(r, 10));

      const loop = manager.getLoopState(ORIGIN_SID);
      expect(loop).toBeDefined();
      loop!.cancelRequested = true;

      summarizerResolve!({
        data: {
          parts: [{ type: "text" as const, text: "too late summary" }],
        },
        error: undefined,
      });

      await advancePromise;

      const createCalls = (client.session.create as any).mock.calls as unknown[][];
      const childCreateCalls = createCalls.filter(
        (c) => {
          const body = (c[0] as { body?: { parentID?: string } })?.body;
          return body?.parentID === ORIGIN_SID;
        },
      );
      expect(childCreateCalls.length).toBe(0);
      expect(loop!.status).toBe("cancelled");

      const allCalls = (client.session.promptAsync as any).mock.calls as unknown[][];
      const originCalls = callsTo(allCalls, ORIGIN_SID);
      const cancelCall = originCalls.find(
        (c) => (promptAsyncBody(c).parts?.[0]?.text ?? "").includes("loop cancelled"),
      );
      expect(cancelCall).toBeDefined();
    });
  });

  // ── Scenario 6: Child error ───────────────────────────────────────
  describe("Scenario 6: Child error", () => {
    it("handleSessionError on active child → error status + origin note, no further spawns", async () => {
      const client = loopMockClient({
        sessionCreate: sequentialIds("child"),
      });
      const manager = newManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });

      await manager.onRoundComplete(ORIGIN_SID);
      expect(manager.isLoopChild("child-1")).toBe(true);

      manager.handleSessionError("child-1", "API rate limit exceeded");

      const loop = manager.getLoopState(ORIGIN_SID);
      expect(loop).toBeDefined();
      expect(loop!.status).toBe("error");
      expect(loop!.errorReason).toBe("API rate limit exceeded");

      expect(manager.isLoopChild("child-1")).toBe(false);

      const allCalls = (client.session.promptAsync as any).mock.calls as unknown[][];
      const errorCalls = allCalls.filter(
        (c) =>
          promptAsyncPathId(c) === ORIGIN_SID &&
          (promptAsyncBody(c).parts?.[0]?.text ?? "").includes("error"),
      );
      expect(errorCalls.length).toBeGreaterThanOrEqual(1);

      expect(client.session.create).toHaveBeenCalledTimes(1);
    });

    it("subsequent onRoundComplete is a no-op after error status", async () => {
      const client = loopMockClient({
        sessionCreate: sequentialIds("child"),
      });
      const manager = newManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 3,
      });

      await manager.onRoundComplete(ORIGIN_SID);
      manager.handleSessionError("child-1", "error");

      const createCount = (client.session.create as any).mock.calls.length as number;

      await manager.onRoundComplete("child-1");

      expect((client.session.create as any).mock.calls.length).toBe(createCount);
    });
  });

  // ── Scenario 7: Summarizer timeout ────────────────────────────────
  describe("Scenario 7: Summarizer timeout", () => {
    it("falls back to base prompt when summarizer hangs (timeout)", async () => {
      const client = loopMockClient({
        sessionCreate: sequentialIds("child"),
        sessionMessages: () =>
          Promise.resolve({
            data: [
              {
                info: { role: "assistant" as const },
                parts: [{ type: "text" as const, text: "round output" }],
              },
            ],
            error: undefined,
          }),
        sessionPrompt: () => new Promise(() => {}),
      });

      const manager = newManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "inherit",
        iterations: 3,
      });

      const { createSummarizerFn } = await import("../../src/loop/summarizer");
      (manager as any)._summarizer = createSummarizerFn(client, { timeoutMs: 50 });

      await manager.onRoundComplete(ORIGIN_SID);

      const allPrompts = (client.session.promptAsync as any).mock.calls as unknown[][];
      const childCalls = allPrompts.filter(
        (c) => promptAsyncPathId(c)?.startsWith("child-"),
      );
      expect(childCalls.length).toBe(1);

      const childPrompt = promptAsyncBody(childCalls[0]).parts?.[0]?.text ?? "";
      expect(childPrompt).toBe(PROMPT);

      const loop = manager.getLoopState(ORIGIN_SID);
      expect(loop?.status).toBe("running");
      expect(loop?.current).toBe(2);
    });
  });

  // ── Scenario 8: Restart recovery ──────────────────────────────────
  describe("Scenario 8: Restart recovery", () => {
    it("persisted mid-loop state recovers as interrupted; user message injects recovery note", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-loop-recover-"));
      const client = pluginMockClient();

      try {
        const normalizedDir = normalizeWorkspaceDir(tmpDir);
        const manager1 = new LoopManager(client, { delayMs: 0 });
        manager1.setStoreDirectory(normalizedDir);

        manager1.register({
          originSessionId: "ses_recov",
          agent: "recover-agent",
          prompt: "recover me",
          mode: "fresh",
          iterations: 5,
        });

        await manager1.onRoundComplete("ses_recov");
        await manager1.onRoundComplete("test-child-1");

        manager1["_persist"]();
        const store = manager1["store"] as any;
        if (store) {
          const loops = (manager1 as any).loops;
          store.saveSync(loops);
        }

        pendingCorrections.clear();
        userMessagedSessions.clear();
        loopManagerMap.clear();
        managerMap.clear();

        const hooks = await createPluginHooks([], client, new Map(), new Map(), tmpDir);

        expect(activeLoopManager?.isLoopOrigin("ses_recov")).toBe(true);
        const recoveredLoop = activeLoopManager?.getLoopState("ses_recov");
        expect(recoveredLoop?.status).toBe("interrupted");
        expect(recoveredLoop?.current).toBeGreaterThan(1);

        const output = {
          parts: [{ type: "text" as const, text: "continue where we left off" }],
        };
        await hooks["chat.message"](
          { agent: "recover-agent", sessionID: "ses_recov" },
          output,
        );

        const correction = pendingCorrections.get("ses_recov");
        expect(correction).toBeDefined();
        expect(correction!).toContain(LOOP_PROGRESS_MARKER);
        expect(correction!).toContain("loop interrupted by restart");

        const updatedLoop = activeLoopManager?.getLoopState("ses_recov");
        expect(updatedLoop?.status).toBe("cancelled");
      } finally {
        loopManagerMap.clear();
        managerMap.clear();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("no auto-resume on recovery (interrupted loops don't auto-advance)", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-loop-noauto-"));
      const client = pluginMockClient();

      try {
        const normalizedDir = normalizeWorkspaceDir(tmpDir);
        const manager1 = new LoopManager(client, { delayMs: 0 });
        manager1.setStoreDirectory(normalizedDir);

        manager1.register({
          originSessionId: "ses_noauto",
          agent: AGENT,
          prompt: PROMPT,
          mode: "fresh",
          iterations: 3,
        });

        const store = manager1["store"] as any;
        if (store) {
          const loops = (manager1 as any).loops;
          store.saveSync(loops);
        }

        pendingCorrections.clear();
        userMessagedSessions.clear();
        loopManagerMap.clear();
        managerMap.clear();

        const hooks = await createPluginHooks([], client, new Map(), new Map(), tmpDir);

        const recoveredLoop = activeLoopManager?.getLoopState("ses_noauto");
        expect(recoveredLoop?.status).toBe("interrupted");

        const advanceSpy = spyOn(activeLoopManager!, "onRoundComplete");
        await hooks.event({
          event: { type: "session.idle", properties: { sessionID: "ses_noauto" } },
        });
        expect(advanceSpy).not.toHaveBeenCalled();
      } finally {
        loopManagerMap.clear();
        managerMap.clear();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ── Scenario 9: Recursion block ───────────────────────────────────
  describe("Scenario 9: Recursion block", () => {
    let hooks: Awaited<ReturnType<typeof createPluginHooks>>;
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), "rolebox-loop-recur-"));
      pendingCorrections.clear();
      userMessagedSessions.clear();
      const client = pluginMockClient();
      hooks = await createPluginHooks([], client, new Map(), new Map(), tmpDir);
    });

    afterEach(() => {
      loopManagerMap.clear();
      managerMap.clear();
      rmSync(tmpDir, { recursive: true, force: true });
      mock.restore();
    });

    it("rejects |loop| activation on a session already registered as loop origin", async () => {
      const sid = "ses_recursion";

      const output1 = {
        parts: [{ type: "text" as const, text: "|loop:3| first loop" }],
      };
      await hooks["chat.message"](
        { agent: AGENT, sessionID: sid },
        output1,
      );
      expect(activeLoopManager?.isLoopOrigin(sid)).toBe(true);

      const output2 = {
        parts: [{ type: "text" as const, text: "|loop:5| nested loop attempt" }],
      };
      await hooks["chat.message"](
        { agent: AGENT, sessionID: sid },
        output2,
      );

      const correction = pendingCorrections.get(sid);
      expect(correction).toContain("Nested loops are not supported");
    });

    it("does not block |loop| on a fresh non-loop session", async () => {
      const sid = "ses_fresh_loop";

      const output = {
        parts: [{ type: "text" as const, text: "|loop:2| start fresh" }],
      };
      await hooks["chat.message"](
        { agent: AGENT, sessionID: sid },
        output,
      );

      expect(activeLoopManager?.isLoopOrigin(sid)).toBe(true);
      const correction = pendingCorrections.get(sid);
      expect(correction ?? "").not.toContain("Nested loops are not supported");
    });
  });

  // ── Scenario 10: Progress-note hygiene ────────────────────────────
  describe("Scenario 10: Progress-note hygiene", () => {
    it("every origin-directed progress note uses noReply:true and includes LOOP_PROGRESS_MARKER", async () => {
      const client = loopMockClient({
        sessionCreate: sequentialIds("child"),
      });
      const manager = newManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 4,
      });

      await manager.onRoundComplete(ORIGIN_SID);
      await manager.onRoundComplete("child-1");
      await manager.onRoundComplete("child-2");
      await manager.onRoundComplete("child-3");

      const allCalls = (client.session.promptAsync as any).mock.calls as unknown[][];
      const originCalls = callsTo(allCalls, ORIGIN_SID);

      expect(originCalls.length).toBeGreaterThanOrEqual(3);

      for (const call of originCalls) {
        const body = promptAsyncBody(call);
        expect(body.noReply).toBe(true);
        const text = body.parts?.[0]?.text ?? "";
        expect(text).toContain(LOOP_PROGRESS_MARKER);
      }
    });

    it("progress notes do NOT add origin to userMessagedSessions", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-loop-hygiene-"));
      try {
        pendingCorrections.clear();
        userMessagedSessions.clear();

        const client = pluginMockClient();
        const hooks = await createPluginHooks([], client, new Map(), new Map(), tmpDir);

        const output = {
          parts: [
            {
              type: "text" as const,
              text: `${LOOP_PROGRESS_MARKER} round 1/5 done → starting round 2 (child test-child)]`,
            },
          ],
        };
        await hooks["chat.message"](
          { agent: AGENT, sessionID: "ses_hygiene" },
          output,
        );

        expect(userMessagedSessions.has("ses_hygiene")).toBe(false);
      } finally {
        loopManagerMap.clear();
        managerMap.clear();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("final completion note uses noReply:true", async () => {
      const client = loopMockClient();
      const manager = newManager(client);

      manager.register({
        originSessionId: ORIGIN_SID,
        agent: AGENT,
        prompt: PROMPT,
        mode: "fresh",
        iterations: 1,
      });

      await manager.onRoundComplete(ORIGIN_SID);

      const allCalls = (client.session.promptAsync as any).mock.calls as unknown[][];
      const originCalls = callsTo(allCalls, ORIGIN_SID);
      const last = originCalls[originCalls.length - 1];
      const body = promptAsyncBody(last);

      expect(body.noReply).toBe(true);
      expect(body.parts?.[0]?.text).toContain(LOOP_PROGRESS_MARKER);
      expect(body.parts?.[0]?.text).toContain("loop complete");
    });
  });
});
