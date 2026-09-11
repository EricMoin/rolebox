/**
 * End-to-end tests for the unified turn-end decision pipeline
 * (src/copilot/pipeline.ts) — subtask 8 of the copilot strategy.
 *
 * Covers the source-precedence contract and the at-most-one-injection
 * invariant:
 *
 *   1. copilot absent / enabled:false  → ONLY the builtin source runs
 *      (byte-identical legacy behavior); rules + LLM never consulted.
 *   2. builtin first                  → an injecting builtin beats matching
 *      user rules AND a would-advance LLM (one [auto-continue reminder,
 *      no COPILOT_MARKER).
 *   3. user rules next                → first match wins; continue/blocked/done
 *      inject ONE marked reply; `skip` consumes the turn (no injection AND no
 *      LLM fallthrough).
 *   4. LLM verdict last               → { advance:true } injects the marked
 *      replyText; advance:false or null → nothing.
 *   5. Structural invariant           → at most ONE session.prompt per idle.
 *
 * The builtin source is exercised through the REAL function-session /
 * function-runtime state (no module stubbing), so precedence tests prove the
 * actual decision order rather than a mocked short-circuit.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { runTurnEndPipeline } from "../src/copilot/pipeline.ts";
import type {
  TurnEndPipelineContext,
  TurnEndPipelineDeps,
} from "../src/copilot/pipeline.ts";
import { COPILOT_MARKER } from "../src/copilot/constants.ts";
import type {
  CopilotConfig,
  CopilotLlmConfig,
  CopilotRule,
} from "../src/copilot/types.ts";
import type { ISessionClient } from "../src/platform/ports/session-client.ts";
import { ArtifactStore } from "../src/function/artifact-store.ts";
import { functionSessionState } from "../src/function/session-state.ts";
import { functionRuntime } from "../src/function/runtime-state.ts";
import type { ResolvedFunction } from "../src/types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────

const SID = "sess-1";
const ROLE = "test-role";
const VERDICT_ROLE = "verdict-role";
const DIR = "/tmp/copilot-pipeline-test";

interface FakeMessage {
  info: { role: string };
  parts: Array<{ type: string; text?: string }>;
}

interface FakeClientOptions {
  messages?: FakeMessage[];
  verdictText?: string;
  createResult?: { id: string } | null;
}

/** Minimal ISessionClient fake — records prompt/create/promptSync calls. */
function makeClient(opts: FakeClientOptions = {}) {
  const client = {
    messages: mock(() => Promise.resolve(opts.messages ?? [])),
    prompt: mock(() => Promise.resolve({ id: "prompted" })),
    create: mock(() =>
      Promise.resolve(opts.createResult ?? { id: "child-sess-1" }),
    ),
    promptSync: mock(() =>
      Promise.resolve({
        parts: [
          {
            type: "text",
            text:
              opts.verdictText ??
              '{"advance":true,"replyText":"keep going"}',
          },
        ],
      }),
    ),
    abort: mock(() => Promise.resolve(true)),
  } as unknown as ISessionClient;
  return client;
}

function makeRule(overrides: Partial<CopilotRule> = {}): CopilotRule {
  return {
    id: "r1",
    match: { contains: "plan" },
    action: "continue",
    ...overrides,
  };
}

function makeLlm(overrides: Partial<CopilotLlmConfig> = {}): CopilotLlmConfig {
  return {
    role: VERDICT_ROLE,
    max_verdict_timeout_ms: 1000,
    transcript: { window_size: 10, max_chars: 5000, include_tools: false },
    ...overrides,
  };
}

function makeConfig(overrides: Partial<CopilotConfig> = {}): CopilotConfig {
  return {
    enabled: true,
    rules: [],
    llm: undefined,
    ...overrides,
  };
}

function makeDeps(
  client: ISessionClient,
  config?: CopilotConfig,
  overrides: Partial<TurnEndPipelineDeps> = {},
): TurnEndPipelineDeps {
  return {
    session: client,
    dir: DIR,
    copilotConfigs: config ? new Map([[ROLE, config]]) : undefined,
    resolvedSubagents: new Map([[VERDICT_ROLE, { parentFullId: "root-role" }]]),
    ...overrides,
  };
}

function makeCtx(
  overrides: Partial<TurnEndPipelineContext> = {},
): TurnEndPipelineContext {
  return {
    activeSet: new Set<string>(),
    allFns: [],
    hasHandlers: false,
    lastText: "assistant finished describing the plan and asks to proceed",
    artifacts: new ArtifactStore(DIR),
    sessionAgentRegistry: new Map([[SID, ROLE]]),
    ...overrides,
  };
}

/** Track every session.prompt call as { sid, text, agent }. */
function promptCalls(client: ISessionClient) {
  const calls = (client.prompt as ReturnType<typeof mock>).mock.calls;
  return calls.map((call: unknown[]) => ({
    sid: call[0] as string,
    text: (call[1] as { parts: Array<{ type: string; text?: string }> }).parts[0]
      ?.text as string,
    agent: (call[1] as { agent?: string }).agent,
  }));
}

/** A minimal resolved function that will want a builtin continuation. */
function makeContinueFn(overrides: Partial<ResolvedFunction> = {}): ResolvedFunction {
  return {
    name: "plan",
    description: "Plan function",
    content: "Plan mode instructions",
    filePath: "/fake/plan.md",
    source: { type: "builtin" } as never,
    // NOTE: must be a condition that evaluates FALSE with the test env —
    // `plan_todos_complete` (for example) is a registered condition that
    // evaluates true with zero unchecked todos, which would complete the fn
    // and make the builtin decline.
    continue_until: "never_satisfied_condition",
    ...overrides,
  };
}

beforeEach(() => {
  functionSessionState.clear(SID);
  functionRuntime.clearSession(SID);
  functionRuntime.resetAll();
});

afterEach(() => {
  mock.restore();
  functionSessionState.clear(SID);
  functionRuntime.clearSession(SID);
  functionRuntime.resetAll();
});

// ── 1. Disabled → legacy-identical (builtin only) ───────────────────────

describe("copilot absent / disabled → builtin-only (legacy-identical)", () => {
  it("runs ONLY the builtin source when copilotConfigs is absent", async () => {
    const client = makeClient();
    const result = await runTurnEndPipeline(
      makeDeps(client, undefined),
      SID,
      makeCtx(),
    );

    expect(result).toBe(false);
    expect(client.prompt).not.toHaveBeenCalled();
    expect(client.messages).not.toHaveBeenCalled();
    expect(client.create).not.toHaveBeenCalled();
  });

  it("runs ONLY the builtin source when copilot.enabled is false, even with rules + llm configured", async () => {
    const client = makeClient();
    const config = makeConfig({
      enabled: false,
      rules: [makeRule()],
      llm: makeLlm(),
    });

    const result = await runTurnEndPipeline(
      makeDeps(client, config),
      SID,
      makeCtx(),
    );

    expect(result).toBe(false);
    expect(client.prompt).not.toHaveBeenCalled();
    expect(client.messages).not.toHaveBeenCalled();
    expect(client.create).not.toHaveBeenCalled();
    expect(client.promptSync).not.toHaveBeenCalled();
  });

  it("returns false with no injection when enabled but no rules and no llm", async () => {
    const client = makeClient();
    const config = makeConfig(); // enabled, rules: [], llm: undefined

    const result = await runTurnEndPipeline(
      makeDeps(client, config),
      SID,
      makeCtx(),
    );

    expect(result).toBe(false);
    expect(client.prompt).not.toHaveBeenCalled();
  });
});

// ── 2. Builtin beats rules (strict precedence) ──────────────────────────

describe("builtin source precedence (builtin first)", () => {
  it("an injecting builtin beats matching rules AND a would-advance LLM — one [auto-continue reminder, no COPILOT_MARKER", async () => {
    const client = makeClient();
    const fn = makeContinueFn();
    // Rules WOULD match the lastText and the LLM WOULD advance — neither may
    // run once the builtin injects.
    const config = makeConfig({
      rules: [makeRule({ match: { contains: "proceed" }, reply: "Rule reply" })],
      llm: makeLlm(),
    });

    functionSessionState.activate(SID, ["plan"]);
    functionRuntime.init(SID, "plan", 1);

    const result = await runTurnEndPipeline(
      makeDeps(client, config),
      SID,
      makeCtx({
        activeSet: new Set(["plan"]),
        allFns: [fn],
      }),
    );

    expect(result).toBe(true);
    const calls = promptCalls(client);
    expect(calls).toHaveLength(1); // at most ONE injection per idle
    expect(calls[0].text).toContain("[auto-continue");
    expect(calls[0].text).not.toContain(COPILOT_MARKER);
    expect(calls[0].text).not.toContain("Rule reply");
    // The LLM source must never be consulted.
    expect(client.create).not.toHaveBeenCalled();
    expect(client.promptSync).not.toHaveBeenCalled();
  });

  it("a non-injecting builtin falls through to rules (builtin declines)", async () => {
    const client = makeClient();
    const config = makeConfig({
      rules: [makeRule({ action: "continue", reply: "Builtin declined; rule fires." })],
    });

    const result = await runTurnEndPipeline(
      makeDeps(client, config),
      SID,
      makeCtx({ activeSet: new Set(["plan"]) }), // active but NO runtime state → builtin skips
    );

    expect(result).toBe(true);
    const calls = promptCalls(client);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain(COPILOT_MARKER);
    expect(calls[0].text).toContain("Builtin declined; rule fires.");
  });
});

// ── 3. User rules (next in precedence) ──────────────────────────────────

describe("user heuristic rules", () => {
  it("a matching continue rule injects ONE marked reply and stops (LLM not reached)", async () => {
    const client = makeClient();
    const config = makeConfig({
      rules: [makeRule({ action: "continue", reply: "Keep going." })],
      llm: makeLlm(), // would advance if consulted — must not be
    });

    const result = await runTurnEndPipeline(
      makeDeps(client, config),
      SID,
      makeCtx(),
    );

    expect(result).toBe(true);
    const calls = promptCalls(client);
    expect(calls).toHaveLength(1);
    // Copilot-sourced injection: wrapped via buildReminder + COPILOT_MARKER.
    expect(calls[0].text).toContain("<system-reminder>");
    expect(calls[0].text).toContain(COPILOT_MARKER);
    expect(calls[0].text).toContain("Keep going.");
    // The injection is addressed to the session's role agent.
    expect(calls[0].sid).toBe(SID);
    expect(calls[0].agent).toBe(ROLE);
    // Precomputed lastText is reused — no lazy messages fetch.
    expect(client.messages).not.toHaveBeenCalled();
    // Rules won before the LLM was consulted.
    expect(client.create).not.toHaveBeenCalled();
  });

  it("uses the per-action default reply when the rule has no custom reply", async () => {
    const client = makeClient();
    const config = makeConfig({
      rules: [makeRule({ action: "continue", reply: undefined })],
    });

    const result = await runTurnEndPipeline(
      makeDeps(client, config),
      SID,
      makeCtx(),
    );

    expect(result).toBe(true);
    const calls = promptCalls(client);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("Continue.");
  });

  it("skip consumes the turn — no injection AND no LLM fallthrough", async () => {
    const client = makeClient();
    const config = makeConfig({
      rules: [makeRule({ action: "skip" })],
      llm: makeLlm(), // must never be consulted
    });

    const result = await runTurnEndPipeline(
      makeDeps(client, config),
      SID,
      makeCtx(),
    );

    expect(result).toBe(false);
    expect(client.prompt).not.toHaveBeenCalled();
    expect(client.create).not.toHaveBeenCalled();
    expect(client.promptSync).not.toHaveBeenCalled();
  });

  it("no rule matches → falls through to the LLM source", async () => {
    const client = makeClient({
      messages: [
        { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
      ],
      verdictText: '{"advance":true,"replyText":"llm takes over"}',
    });
    const config = makeConfig({
      rules: [makeRule({ match: { contains: "no-match-anywhere" } })],
      llm: makeLlm(),
    });

    const result = await runTurnEndPipeline(
      makeDeps(client, config),
      SID,
      makeCtx(),
    );

    expect(result).toBe(true);
    const calls = promptCalls(client);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("llm takes over");
  });
});

// ── 4. LLM verdict (last in precedence) ─────────────────────────────────

describe("LLM-role verdict source", () => {
  it("{ advance:true } injects the marked replyText", async () => {
    const client = makeClient({
      messages: [
        { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
      ],
      verdictText: '{"advance":true,"replyText":"Continue please"}',
    });
    const config = makeConfig({ llm: makeLlm() });

    const result = await runTurnEndPipeline(
      makeDeps(client, config),
      SID,
      makeCtx(),
    );

    expect(result).toBe(true);
    const calls = promptCalls(client);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("<system-reminder>");
    expect(calls[0].text).toContain(COPILOT_MARKER);
    expect(calls[0].text).toContain("Continue please");
    // The verdict child session is created with the origin as parent.
    expect(client.create).toHaveBeenCalledWith({
      directory: DIR,
      agent: VERDICT_ROLE,
      parentID: SID,
    });
  });

  it("{ advance:false } (hand control back) injects nothing", async () => {
    const client = makeClient({
      messages: [
        { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
      ],
      verdictText: '{"advance":false,"replyText":""}',
    });
    const config = makeConfig({ llm: makeLlm() });

    const result = await runTurnEndPipeline(
      makeDeps(client, config),
      SID,
      makeCtx(),
    );

    expect(result).toBe(false);
    expect(client.prompt).not.toHaveBeenCalled();
  });

  it("null verdict (unparseable LLM output) injects nothing", async () => {
    const client = makeClient({
      messages: [
        { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
      ],
      verdictText: "I think we should continue", // not JSON → null verdict
    });
    const config = makeConfig({ llm: makeLlm() });

    const result = await runTurnEndPipeline(
      makeDeps(client, config),
      SID,
      makeCtx(),
    );

    expect(result).toBe(false);
    expect(client.prompt).not.toHaveBeenCalled();
  });

  it("null verdict (transcript read failure) injects nothing", async () => {
    const client = makeClient({
      // messages returns [] → assembleTranscript yields "" — still a valid
      // transcript, so use a null-verdict instead to prove the failure path
      // shape; the transcript-failure path is covered by transcript tests.
      verdictText: '{"advance":true,"replyText":"should not inject"}',
    });
    // Force requestVerdict to null via an unknown role.
    const config = makeConfig({
      llm: makeLlm({ role: "no-such-role" }),
    });

    const result = await runTurnEndPipeline(
      makeDeps(client, config),
      SID,
      makeCtx(),
    );

    expect(result).toBe(false);
    expect(client.prompt).not.toHaveBeenCalled();
  });
});

// ── 5. At-most-one-injection invariant ──────────────────────────────────

describe("at most ONE injection per session.idle", () => {
  it("a rule injection short-circuits the would-advance LLM (single prompt)", async () => {
    const client = makeClient({
      messages: [
        { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
      ],
      verdictText: '{"advance":true,"replyText":"llm would fire"}',
    });
    const config = makeConfig({
      rules: [makeRule({ action: "continue", reply: "rule fires first" })],
      llm: makeLlm(),
    });

    const result = await runTurnEndPipeline(
      makeDeps(client, config),
      SID,
      makeCtx(),
    );

    expect(result).toBe(true);
    const calls = promptCalls(client);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("rule fires first");
    expect(calls[0].text).not.toContain("llm would fire");
    expect(client.create).not.toHaveBeenCalled();
  });

  it("first matching rule wins when several rules match (single prompt)", async () => {
    const client = makeClient();
    const config = makeConfig({
      rules: [
        makeRule({ id: "first", match: { contains: "plan" }, reply: "first wins" }),
        makeRule({ id: "second", match: { contains: "plan" }, reply: "second wins" }),
      ],
    });

    const result = await runTurnEndPipeline(
      makeDeps(client, config),
      SID,
      makeCtx(),
    );

    expect(result).toBe(true);
    const calls = promptCalls(client);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("first wins");
    expect(calls[0].text).not.toContain("second wins");
  });
});
