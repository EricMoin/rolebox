/**
 * One-shot composer draft suggestion.
 *
 * This module owns the single model call behind the composer draft feature.
 * It is deliberately small and dependency-free at the edges: the host llm
 * service is consumed through the structural {@link DraftLlm} seam, so the
 * module never value-imports `@deepseek-ai/*` and is trivially testable with a
 * fake async iterable.
 *
 * Contract:
 *   - exactly ONE `llm.stream(...)` call per suggestion — no retry, ever;
 *   - only `text-delta` chunks contribute text; the first `finish` chunk ends
 *     the stream, and an `error`/`aborted` finish is a miss;
 *   - the call is bounded by `config.timeout_ms` through its OWN
 *     AbortController, linked to (but never replacing) the caller's signal, so
 *     a provider that ignores the abort cannot hold the caller past the
 *     deadline;
 *   - a thrown stream, a timeout, an abort and a draft that sanitizes to
 *     nothing are all reported as `kind: "none"` with a short stable reason;
 *   - the request carries only provider-neutral options (no stop sequences), so
 *     a host adapter that rejects unsupported `GenerateOptions` cannot fail the
 *     call before the model runs;
 *   - reasoning is disabled (`reasoningEffort: "off"`) because a one-line
 *     next-message prediction must not pay for chain-of-thought: thinking
 *     spends seconds before the first text delta and the caller's deadline
 *     then degrades the suggestion to a silent `none`.
 *
 * The parsed/draft text rules live in `./prompt.ts` and stay pure.
 *
 * @module
 */

import type { CopilotDraftConfig } from "../types.ts";
import { buildDraftPrompt, parseDraftResponse } from "./prompt.ts";

// ── Structural host llm seam ────────────────────────────────────────────────

/** One stream chunk, structurally (the host contract is merge-extensible). */
export interface DraftLlmChunk {
  /** Chunk tag; only `text-delta` and `finish` are read. */
  type: string;
  /** Text payload of a `text-delta` chunk. */
  text?: string;
  /**
   * Finish reason, structurally. The dsh `StreamChunk` finish reason is an
   * object (`{ kind: "stop" | "tool-calls" | "max-tokens" | "aborted" |
   * "error", failure? }`), not a string; `kind` is read and unknown kinds are
   * treated as a normal stop.
   */
  reason?: { kind?: string };
}

/**
 * One-shot request shape. Mirrors the host `GenerateOptions` subset the
 * suggester needs; see the agreed composer-draft contract.
 *
 * The shape stays provider-neutral: it carries no `stop` sequences. Host
 * adapters differ in which `GenerateOptions` they support, and some reject an
 * unsupported option outright instead of ignoring it (the dsh pi-ai adapter
 * throws `UNSUPPORTED_OPTION` for any `stop`), which would turn the whole
 * request into a miss before the model is ever called. A one-shot auxiliary
 * call therefore must not rely on stop sequences; boundedness comes from
 * `maxTokens` and the caller's deadline instead.
 */
export interface DraftLlmRequest {
  provider: string;
  model: string;
  system: string;
  messages: Array<{
    role: "user";
    content: Array<{ type: "text"; text: string }>;
  }>;
  temperature: number;
  maxTokens: number;
  /**
   * Disable reasoning for the one-shot draft.
   *
   * A short draft must not spend seconds thinking, and a reasoning route that
   * answers late is indistinguishable from a timeout: the caller only sees
   * `none`. Both host adapters accept `off` — llm-deepseek serializes
   * `thinking: { type: "disabled" }` and pi-ai resolves `off` to omitting the
   * reasoning option — so this stays a provider-neutral request field.
   */
  reasoningEffort?: "off";
  signal: AbortSignal;
}

/** Structural `LlmRuntime.stream()` seam (duck typed, never imported). */
export interface DraftLlm {
  stream(options: DraftLlmRequest): AsyncIterable<DraftLlmChunk>;
}

/** Input to {@link suggestDraft}. */
export interface SuggestDraftInput {
  /** Parsed draft config (timeout / character budget). */
  config: CopilotDraftConfig;
  /** Role-labeled transcript tail. */
  transcript: string;
  /** The host llm service. */
  llm: DraftLlm;
  /** Provider route selected from the role config. */
  provider: string;
  /** Model id selected from the role config. */
  model: string;
  /** Caller cancellation (turn/HTTP client). */
  signal: AbortSignal;
}

/** One suggestion's outcome. */
export type SuggestDraftResult =
  | { kind: "suggested"; text: string }
  | { kind: "none"; reason: string };

/** Internal aggregation outcome from one stream. */
type CollectedDraft =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "error" | "aborted" };

/**
 * Fixed sampling bounds for the one-shot draft request.
 *
 * `DRAFT_MAX_TOKENS` is generous on purpose: a reasoning-capable route may
 * spend output tokens on reasoning before emitting any text, and a small cap
 * (64) starves the draft so the answer sanitizes to nothing. This is a fixed
 * internal bound, not configuration.
 */
const DRAFT_TEMPERATURE = 0.2;
const DRAFT_MAX_TOKENS = 256;

/**
 * Ask the host for one short composer draft.
 *
 * @param input - Config, transcript, llm seam, route and caller signal.
 * @returns The sanitized draft, or a content-free miss reason.
 */
export async function suggestDraft(
  input: SuggestDraftInput,
): Promise<SuggestDraftResult> {
  if (input.signal.aborted) return { kind: "none", reason: "aborted" };

  const prompt = buildDraftPrompt({
    transcript: input.transcript,
    maxChars: input.config.max_chars,
  });

  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  input.signal.addEventListener("abort", forwardAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  try {
    let stream: AsyncIterable<DraftLlmChunk>;
    try {
      // Exactly ONE call: a synchronous throw is a miss, never a retry.
      stream = input.llm.stream({
        provider: input.provider,
        model: input.model,
        system: prompt.system,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt.user }],
          },
        ],
        temperature: DRAFT_TEMPERATURE,
        maxTokens: DRAFT_MAX_TOKENS,
        // Latency: a draft is one line of predicted next message, not a
        // reasoning task. Thinking would run for seconds before any
        // `text-delta` and the deadline below would report `none`.
        reasoningEffort: "off",
        signal: controller.signal,
      });
    } catch {
      return { kind: "none", reason: "stream-error" };
    }

    // The rejection is observed here: a provider that ignores the abort may
    // still fail after the deadline has already returned.
    const collected = collectDraft(stream, controller.signal).then(
      (value) => ({ value }),
      () => ({ failed: true as const }),
    );
    const deadline = new Promise<{ readonly deadline: true }>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve({ deadline: true });
      }, input.config.timeout_ms);
    });

    const raced = await Promise.race([collected, deadline]);
    if ("deadline" in raced || timedOut) {
      return { kind: "none", reason: "timeout" };
    }
    if ("failed" in raced) {
      return { kind: "none", reason: "stream-error" };
    }
    if (input.signal.aborted) return { kind: "none", reason: "aborted" };

    const outcome = raced.value;
    if (!outcome.ok) return { kind: "none", reason: outcome.reason };

    const text = parseDraftResponse(outcome.text, input.config.max_chars);
    if (text === null) return { kind: "none", reason: "empty-draft" };
    return { kind: "suggested", text };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    input.signal.removeEventListener("abort", forwardAbort);
  }
}

// ── Stream collection ───────────────────────────────────────────────────────

/**
 * Collect one stream's draft text.
 *
 * Only `text-delta` chunks contribute; the first `finish` ends the stream and
 * an `error`/`aborted` finish is a miss. The signal is checked before every
 * chunk and once more after the loop so a late chunk is never aggregated after
 * the caller or the deadline cancelled the call.
 *
 * @param stream - The provider's chunk stream.
 * @param signal - The deadline/turn signal.
 * @returns The aggregated text, or a miss reason.
 */
async function collectDraft(
  stream: AsyncIterable<DraftLlmChunk>,
  signal: AbortSignal,
): Promise<CollectedDraft> {
  let text = "";
  for await (const chunk of stream) {
    if (signal.aborted) return { ok: false, reason: "aborted" };
    if (chunk.type === "finish") {
      // The host finish reason is structural: `{ kind: ... }`. Read only the
      // kind and tolerate kinds this module does not know (a normal stop).
      const kind = chunk.reason?.kind;
      if (kind === "error") return { ok: false, reason: "error" };
      if (kind === "aborted") return { ok: false, reason: "aborted" };
      return { ok: true, text };
    }
    if (chunk.type === "text-delta" && typeof chunk.text === "string") {
      text += chunk.text;
    }
  }
  // A stream that ends without a terminal finish still carries usable deltas;
  // the host normalizes failures to a finish, so this is benign.
  if (signal.aborted) return { ok: false, reason: "aborted" };
  return { ok: true, text };
}
