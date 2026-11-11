/**
 * Tests for the turn-end pipeline after the copilot decision modes were
 * removed: `runTurnEndPipeline` must run ONLY the builtin
 * function-continuation source, with unchanged arguments and return semantics.
 *
 * The builtin source is exercised through the REAL function-session /
 * function-runtime state (no module stubbing), so these tests prove the actual
 * delegation rather than a mocked short-circuit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runTurnEndPipeline,
  type TurnEndPipelineContext,
  type TurnEndPipelineDeps,
} from "../../src/copilot/pipeline.ts";
import { evaluateBuiltinContinuation } from "../../src/copilot/sources/builtin.ts";
import type { ISessionClient } from "../../src/platform/ports/session-client.ts";
import { ArtifactStore } from "../../src/function/artifact-store.ts";
import { functionSessionState } from "../../src/function/session-state.ts";
import { functionRuntime } from "../../src/function/runtime-state.ts";
import type { ResolvedFunction } from "../../src/types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────

const SID = "sess-1";
const OTHER_SID = "sess-2";
const ROLE = "test-role";
const DIR = "/tmp/copilot-pipeline-test";

/** Minimal ISessionClient fake — records prompt/create/messages calls. */
function makeClient(): ISessionClient {
  return {
    messages: vi.fn(() => Promise.resolve([])),
    prompt: vi.fn(() => Promise.resolve({ id: "prompted" })),
    create: vi.fn(() => Promise.resolve({ id: "child-sess-1" })),
    promptSync: vi.fn(() => Promise.resolve({ parts: [] })),
    abort: vi.fn(() => Promise.resolve(true)),
  } as unknown as ISessionClient;
}

function makeDeps(client: ISessionClient): TurnEndPipelineDeps {
  return { session: client, dir: DIR };
}

function makeCtx(
  overrides: Partial<TurnEndPipelineContext> = {},
): TurnEndPipelineContext {
  return {
    activeSet: new Set<string>(),
    allFns: [],
    hasHandlers: false,
    lastText: "assistant finished describing the plan",
    artifacts: new ArtifactStore(DIR),
    sessionAgentRegistry: new Map([[SID, ROLE]]),
    ...overrides,
  };
}

/** Track every session.prompt call as { sid, text, agent }. */
function promptCalls(client: ISessionClient) {
  const calls = vi.mocked(client.prompt).mock.calls;
  return calls.map((call) => ({
    sid: call[0] as string,
    text: (call[1] as { parts: Array<{ type: string; text?: string }> }).parts[0]
      ?.text as string,
    agent: (call[1] as { agent?: string }).agent,
  }));
}

/** A minimal resolved function that wants a builtin continuation. */
function makeContinueFn(overrides: Partial<ResolvedFunction> = {}): ResolvedFunction {
  return {
    name: "plan",
    description: "Plan function",
    content: "Plan mode instructions",
    filePath: "/fake/plan.md",
    source: { type: "builtin" } as never,
    // Must evaluate FALSE with the test env; `plan_todos_complete` (for
    // example) is true with zero unchecked todos and would complete the fn.
    continue_until: "never_satisfied_condition",
    ...overrides,
  };
}

/** Activate + initialize a function that will want to continue. */
function activatePlan(sid: string, name = "plan"): void {
  functionSessionState.activate(sid, [name]);
  functionRuntime.init(sid, name, 1);
}

beforeEach(() => {
  functionSessionState.clear(SID);
  functionSessionState.clear(OTHER_SID);
  functionRuntime.clearSession(SID);
  functionRuntime.clearSession(OTHER_SID);
  functionRuntime.resetAll();
});

afterEach(() => {
  vi.restoreAllMocks();
  functionSessionState.clear(SID);
  functionSessionState.clear(OTHER_SID);
  functionRuntime.clearSession(SID);
  functionRuntime.clearSession(OTHER_SID);
  functionRuntime.resetAll();
});

// ── Builtin-only behavior ───────────────────────────────────────────────

describe("builtin-only turn-end pipeline", () => {
  it("returns false and sends nothing when no function is active", async () => {
    const client = makeClient();

    const result = await runTurnEndPipeline(makeDeps(client), SID, makeCtx());

    expect(result).toBe(false);
    expect(client.prompt).not.toHaveBeenCalled();
    expect(client.messages).not.toHaveBeenCalled();
    expect(client.create).not.toHaveBeenCalled();
    expect(client.promptSync).not.toHaveBeenCalled();
  });

  it("injects ONE builtin continuation and returns true", async () => {
    const client = makeClient();
    activatePlan(SID);

    const result = await runTurnEndPipeline(
      makeDeps(client),
      SID,
      makeCtx({
        activeSet: new Set(["plan"]),
        allFns: [makeContinueFn()],
      }),
    );

    expect(result).toBe(true);
    const calls = promptCalls(client);
    expect(calls).toHaveLength(1);
    expect(calls[0].sid).toBe(SID);
    expect(calls[0].text).toContain("[auto-continue");
    expect(calls[0].agent).toBe(ROLE);
    // No rules/LLM reads: the removed sources never run.
    expect(client.messages).not.toHaveBeenCalled();
    expect(client.create).not.toHaveBeenCalled();
    expect(client.promptSync).not.toHaveBeenCalled();
  });

  it("sends at most ONE continuation for several active functions", async () => {
    const client = makeClient();
    activatePlan(SID, "plan");
    activatePlan(SID, "build");

    const result = await runTurnEndPipeline(
      makeDeps(client),
      SID,
      makeCtx({
        activeSet: new Set(["plan", "build"]),
        allFns: [
          makeContinueFn({ name: "plan" }),
          makeContinueFn({ name: "build", filePath: "/fake/build.md" }),
        ],
      }),
    );

    expect(result).toBe(true);
    expect(promptCalls(client)).toHaveLength(1);
  });

  it("returns false when the continuation prompt fails and rolls the count back", async () => {
    const client = makeClient();
    vi.mocked(client.prompt).mockRejectedValueOnce(new Error("send failed"));
    activatePlan(SID);

    const result = await runTurnEndPipeline(
      makeDeps(client),
      SID,
      makeCtx({
        activeSet: new Set(["plan"]),
        allFns: [makeContinueFn()],
      }),
    );

    expect(result).toBe(false);
    expect(functionRuntime.get(SID, "plan")?.continuationCount).toBe(0);
  });

  it("delegates to evaluateBuiltinContinuation with identical prompt text", async () => {
    const pipelineClient = makeClient();
    const directClient = makeClient();
    activatePlan(SID);
    activatePlan(OTHER_SID);

    const ctxArgs = {
      activeSet: new Set(["plan"]),
      allFns: [makeContinueFn()],
      hasHandlers: false,
      lastText: "assistant finished describing the plan",
      artifacts: new ArtifactStore(DIR),
    };

    const pipelineResult = await runTurnEndPipeline(
      makeDeps(pipelineClient),
      SID,
      makeCtx({ ...ctxArgs, sessionAgentRegistry: new Map([[SID, ROLE]]) }),
    );

    const directResult = await evaluateBuiltinContinuation({
      sessionID: OTHER_SID,
      activeSet: ctxArgs.activeSet,
      allFns: ctxArgs.allFns,
      hasHandlers: ctxArgs.hasHandlers,
      lastText: ctxArgs.lastText,
      artifacts: ctxArgs.artifacts,
      workspaceDir: DIR,
      sessionAgentRegistry: new Map([[OTHER_SID, ROLE]]),
      session: directClient,
    });

    expect(pipelineResult).toBe(true);
    expect(directResult).toBe(true);
    const [pipelineCall] = promptCalls(pipelineClient);
    const [directCall] = promptCalls(directClient);
    expect(pipelineCall.text).toBe(directCall.text);
    expect(pipelineCall.agent).toBe(directCall.agent);
  });
});
