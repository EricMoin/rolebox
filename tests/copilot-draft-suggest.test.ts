import { describe, expect, it } from "vitest";
import {
  DEFAULT_COPILOT_DRAFT_CONFIG,
} from "../src/copilot/config.ts";
import type { CopilotDraftConfig } from "../src/copilot/types.ts";
import {
  suggestDraft,
} from "../src/copilot/draft/suggest.ts";
import type {
  DraftLlm,
  DraftLlmChunk,
  DraftLlmRequest,
  DraftModelInfo,
} from "../src/copilot/draft/suggest.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeConfig(
  overrides: Partial<CopilotDraftConfig> = {},
): CopilotDraftConfig {
  return {
    ...DEFAULT_COPILOT_DRAFT_CONFIG,
    enabled: true,
    provider: "test-provider",
    model: "test-model",
    ...overrides,
  };
}

/** A route that advertises the latency-saving `off` reasoning effort. */
const REASONING_OFF: DraftModelInfo = {
  reasoning: {
    efforts: [
      { id: "off" },
      { id: "low" },
      { id: "high" },
    ],
  },
};

/** A reasoning route that offers efforts but not `off`. */
const REASONING_WITHOUT_OFF: DraftModelInfo = {
  reasoning: { efforts: [{ id: "low" }, { id: "high" }] },
};

/** A non-reasoning route: no reasoning metadata at all. */
const NO_REASONING: DraftModelInfo = {};

interface FakeLlm {
  llm: DraftLlm;
  calls: () => number;
  requests: DraftLlmRequest[];
  capabilityReads: () => number;
}

interface FakeLlmOptions {
  /** Advertised capability; a function may reject (or throw) instead. */
  modelInfo?: DraftModelInfo | (() => Promise<DraftModelInfo>);
  /**
   * Mirror the host's `resolveCallWithInfo` validation: any present
   * `reasoningEffort` on a route without advertised reasoning metadata is
   * rejected before the adapter runs (`UNSUPPORTED_REASONING_EFFORT`).
   */
  rejectUnsupportedEffort?: boolean;
  /** Omit the optional capability seam, as a minimal host/fake would. */
  withoutCapability?: boolean;
}

/** Wrap a chunk factory in a counting DraftLlm with a capability seam. */
function fakeLlm(
  factory: (request: DraftLlmRequest) => AsyncIterable<DraftLlmChunk>,
  options: FakeLlmOptions = {},
): FakeLlm {
  let calls = 0;
  let capabilityReads = 0;
  const requests: DraftLlmRequest[] = [];
  const declared = options.modelInfo ?? REASONING_OFF;
  const llm: DraftLlm = {
    stream(request: DraftLlmRequest) {
      calls += 1;
      if (
        options.rejectUnsupportedEffort === true &&
        request.reasoningEffort !== undefined
      ) {
        // The host throws while resolving the call, before the adapter sees it.
        throw new Error("UNSUPPORTED_REASONING_EFFORT");
      }
      requests.push(request);
      return factory(request);
    },
  };
  if (options.withoutCapability !== true) {
    llm.resolveModelInfo = async () => {
      capabilityReads += 1;
      return typeof declared === "function" ? await declared() : declared;
    };
  }
  return {
    llm,
    calls: () => calls,
    requests,
    capabilityReads: () => capabilityReads,
  };
}

/** Stream of fixed chunks, then a terminal finish. */
function fixedStream(
  chunks: DraftLlmChunk[],
  finish: DraftLlmChunk = { type: "finish", reason: { kind: "stop" } },
): () => AsyncIterable<DraftLlmChunk> {
  return async function* () {
    for (const chunk of chunks) yield chunk;
    yield finish;
  };
}

const baseInput = (overrides: Partial<Parameters<typeof suggestDraft>[0]> = {}) => ({
  config: makeConfig(),
  transcript: "user: add retry\nassistant: where?",
  llm: fakeLlm(fixedStream([])).llm,
  provider: "test-provider",
  model: "test-model",
  signal: new AbortController().signal,
  ...overrides,
});

// ── Aggregation and termination ─────────────────────────────────────────────

describe("suggestDraft — aggregation", () => {
  it("joins text-delta chunks until finish", async () => {
    const fake = fakeLlm(
      fixedStream([
        { type: "text-delta", text: "Run " },
        { type: "text-delta", text: "the tests" },
      ]),
    );
    const result = await suggestDraft(baseInput({ llm: fake.llm }));
    expect(result).toEqual({ kind: "suggested", text: "Run the tests" });
  });

  it("ignores non-text chunks", async () => {
    const fake = fakeLlm(
      fixedStream([
        { type: "block-start" },
        { type: "reasoning-delta", text: "thinking..." },
        { type: "text-delta", text: "ok" },
      ]),
    );
    const result = await suggestDraft(baseInput({ llm: fake.llm }));
    expect(result).toEqual({ kind: "suggested", text: "ok" });
  });

  it("stops at finish and never consumes later deltas", async () => {
    let afterFinish = false;
    const fake = fakeLlm(async function* () {
      yield { type: "text-delta", text: "one" };
      yield { type: "finish", reason: { kind: "stop" } };
      afterFinish = true;
      yield { type: "text-delta", text: " two" };
    });
    const result = await suggestDraft(baseInput({ llm: fake.llm }));
    expect(result).toEqual({ kind: "suggested", text: "one" });
    expect(afterFinish).toBe(false);
  });

  it("makes exactly one stream call", async () => {
    const fake = fakeLlm(fixedStream([{ type: "text-delta", text: "ok" }]));
    await suggestDraft(baseInput({ llm: fake.llm }));
    expect(fake.calls()).toBe(1);
  });

  it("sends the agreed one-shot request shape", async () => {
    const fake = fakeLlm(fixedStream([{ type: "text-delta", text: "ok" }]));
    await suggestDraft(baseInput({ llm: fake.llm }));

    const request = fake.requests[0];
    expect(request.provider).toBe("test-provider");
    expect(request.model).toBe("test-model");
    expect(request.temperature).toBe(0.2);
    // Regression: reasoning-capable routes may spend output tokens on reasoning
    // before any text, so a 64-token cap starves the draft. One bounded call
    // still bounds the cost; the value stays a fixed internal constant.
    expect(request.maxTokens).toBe(256);
    // Regression: the request must stay provider-neutral. Some host adapters
    // reject unsupported GenerateOptions instead of ignoring them — the dsh
    // pi-ai adapter throws `UNSUPPORTED_OPTION` for ANY `stop`, which would turn
    // the one-shot call into a miss before the model is ever invoked. So the
    // recorded request must not carry the property at all.
    expect(request).not.toHaveProperty("stop");
    // Latency: a one-line next-message prediction must not pay for
    // chain-of-thought. The fake route below advertises `off`, which removes
    // the reasoning spend that otherwise pushes the answer past the deadline.
    expect(request.reasoningEffort).toBe("off");
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.system).toMatch(/next message the human user would send/i);
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0].role).toBe("user");
    expect(request.messages[0].content).toEqual([
      { type: "text", text: "Transcript:\nuser: add retry\nassistant: where?" },
    ]);
  });
});

// ── Reasoning capability ────────────────────────────────────────────────────

describe("suggestDraft — reasoning capability", () => {
  it("sends reasoningEffort off only when the route advertises it", async () => {
    const fake = fakeLlm(
      fixedStream([{ type: "text-delta", text: "ok" }]),
      { modelInfo: REASONING_OFF },
    );
    expect(await suggestDraft(baseInput({ llm: fake.llm }))).toEqual({
      kind: "suggested",
      text: "ok",
    });
    // The capability read is a metadata lookup, not a model call.
    expect(fake.capabilityReads()).toBe(1);
    expect(fake.calls()).toBe(1);
    expect(fake.requests[0].reasoningEffort).toBe("off");
  });

  it("omits reasoningEffort when the route offers efforts but not off", async () => {
    const fake = fakeLlm(
      fixedStream([{ type: "text-delta", text: "ok" }]),
      { modelInfo: REASONING_WITHOUT_OFF, rejectUnsupportedEffort: true },
    );
    expect(await suggestDraft(baseInput({ llm: fake.llm }))).toEqual({
      kind: "suggested",
      text: "ok",
    });
    expect(fake.capabilityReads()).toBe(1);
    expect(fake.calls()).toBe(1);
    expect(fake.requests[0]).not.toHaveProperty("reasoningEffort");
  });

  it("omits reasoningEffort on a non-reasoning route even when the host would reject it", async () => {
    // Regression: dsh-llm's resolveCallWithInfo throws
    // UNSUPPORTED_REASONING_EFFORT for ANY reasoningEffort on a model without
    // reasoning metadata (e.g. a plain pi-ai chat route). The fake mirrors
    // that validation, so a request carrying the field would fail before the
    // adapter and regress the draft to a silent `none`.
    const fake = fakeLlm(fixedStream([{ type: "text-delta", text: "ok" }]), {
      modelInfo: NO_REASONING,
      rejectUnsupportedEffort: true,
    });
    expect(await suggestDraft(baseInput({ llm: fake.llm }))).toEqual({
      kind: "suggested",
      text: "ok",
    });
    expect(fake.capabilityReads()).toBe(1);
    expect(fake.calls()).toBe(1);
    expect(fake.requests[0]).not.toHaveProperty("reasoningEffort");
  });

  it("omits reasoningEffort when the capability read rejects", async () => {
    const fake = fakeLlm(fixedStream([{ type: "text-delta", text: "ok" }]), {
      modelInfo: () => Promise.reject(new Error("INVALID_MODEL_INFO")),
    });
    expect(await suggestDraft(baseInput({ llm: fake.llm }))).toEqual({
      kind: "suggested",
      text: "ok",
    });
    expect(fake.capabilityReads()).toBe(1);
    expect(fake.calls()).toBe(1);
    expect(fake.requests[0]).not.toHaveProperty("reasoningEffort");
  });

  it("omits reasoningEffort when the llm seam has no capability read", async () => {
    const fake = fakeLlm(fixedStream([{ type: "text-delta", text: "ok" }]), {
      withoutCapability: true,
    });
    expect(await suggestDraft(baseInput({ llm: fake.llm }))).toEqual({
      kind: "suggested",
      text: "ok",
    });
    expect(fake.capabilityReads()).toBe(0);
    expect(fake.calls()).toBe(1);
    expect(fake.requests[0]).not.toHaveProperty("reasoningEffort");
  });

  it("does not call the model when the caller aborts during the capability read", async () => {
    const controller = new AbortController();
    let calls = 0;
    let capabilityReads = 0;
    const llm: DraftLlm = {
      async resolveModelInfo() {
        capabilityReads += 1;
        controller.abort();
        return REASONING_OFF;
      },
      stream() {
        calls += 1;
        return fixedStream([{ type: "text-delta", text: "never" }])();
      },
    };
    expect(
      await suggestDraft(baseInput({ llm, signal: controller.signal })),
    ).toEqual({ kind: "none", reason: "aborted" });
    expect(capabilityReads).toBe(1);
    expect(calls).toBe(0);
  });
});

// ── Misses ──────────────────────────────────────────────────────────────────

describe("suggestDraft — misses", () => {
  it("maps an error finish after text deltas to none, not to the partial draft", async () => {
    const fake = fakeLlm(
      fixedStream([{ type: "text-delta", text: "partial" }], {
        type: "finish",
        reason: { kind: "error" },
      }),
    );
    expect(await suggestDraft(baseInput({ llm: fake.llm }))).toEqual({
      kind: "none",
      reason: "error",
    });
  });

  it("keeps the text for a finish kind this module does not know", async () => {
    const fake = fakeLlm(
      fixedStream([{ type: "text-delta", text: "kept" }], {
        type: "finish",
        reason: { kind: "max-tokens" },
      }),
    );
    expect(await suggestDraft(baseInput({ llm: fake.llm }))).toEqual({
      kind: "suggested",
      text: "kept",
    });
  });

  it("maps an aborted finish to none", async () => {
    const fake = fakeLlm(
      fixedStream([], { type: "finish", reason: { kind: "aborted" } }),
    );
    expect(await suggestDraft(baseInput({ llm: fake.llm }))).toEqual({
      kind: "none",
      reason: "aborted",
    });
  });

  it("maps a thrown synchronous stream call to none without retrying", async () => {
    let calls = 0;
    const llm: DraftLlm = {
      stream() {
        calls += 1;
        throw new Error("no adapter");
      },
    };
    expect(await suggestDraft(baseInput({ llm }))).toEqual({
      kind: "none",
      reason: "stream-error",
    });
    expect(calls).toBe(1);
  });

  it("maps a rejecting iterator to none", async () => {
    const fake = fakeLlm(async function* () {
      throw new Error("provider fell over");
    });
    expect(await suggestDraft(baseInput({ llm: fake.llm }))).toEqual({
      kind: "none",
      reason: "stream-error",
    });
  });

  it("maps an empty response to none", async () => {
    const fake = fakeLlm(fixedStream([]));
    expect(await suggestDraft(baseInput({ llm: fake.llm }))).toEqual({
      kind: "none",
      reason: "empty-draft",
    });
  });

  it("maps the emitted none marker to none", async () => {
    const fake = fakeLlm(fixedStream([{ type: "text-delta", text: "[none]" }]));
    expect(await suggestDraft(baseInput({ llm: fake.llm }))).toEqual({
      kind: "none",
      reason: "empty-draft",
    });
  });
});

// ── Bounds ──────────────────────────────────────────────────────────────────

describe("suggestDraft — bounds", () => {
  it("enforces the configured timeout without waiting for the provider", async () => {
    const started = Date.now();
    const fake = fakeLlm(async function* (request) {
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "finish", reason: { kind: "aborted" } };
    });
    const result = await suggestDraft(
      baseInput({
        llm: fake.llm,
        config: makeConfig({ timeout_ms: 20 }),
      }),
    );
    expect(result).toEqual({ kind: "none", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fake.calls()).toBe(1);
  });

  it("returns none when the caller aborts mid-flight", async () => {
    const controller = new AbortController();
    const fake = fakeLlm(async function* (request) {
      yield { type: "text-delta", text: "partial" };
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "finish", reason: { kind: "aborted" } };
    });
    const pending = suggestDraft(
      baseInput({ llm: fake.llm, signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 5);
    expect(await pending).toEqual({ kind: "none", reason: "aborted" });
    expect(fake.calls()).toBe(1);
  });

  it("does not call the model when the caller signal is already aborted", async () => {
    const fake = fakeLlm(fixedStream([{ type: "text-delta", text: "ok" }]));
    const result = await suggestDraft(
      baseInput({ llm: fake.llm, signal: AbortSignal.abort() }),
    );
    expect(result).toEqual({ kind: "none", reason: "aborted" });
    expect(fake.calls()).toBe(0);
  });

  it("applies the configured max_chars to the draft", async () => {
    const fake = fakeLlm(
      fixedStream([{ type: "text-delta", text: "run the tests now please" }]),
    );
    const result = await suggestDraft(
      baseInput({ llm: fake.llm, config: makeConfig({ max_chars: 14 }) }),
    );
    expect(result).toEqual({ kind: "suggested", text: "run the tests" });
  });
});
