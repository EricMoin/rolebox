/**
 * The DSH `agent/pre-step` listener that feeds turn recall, and optionally
 * runs its one-shot LLM query scout.
 *
 * The HANDOFF is the reason the listener exists on every host. The agent loop
 * claims a step's user message out of the inbox BEFORE it appends it to the
 * session log, so at the recall render the log holds the PREVIOUS prompt — or,
 * on the first turn, no prompt at all. The listener reads the step's admitted
 * user message from the payload (its stable message id and text) and notes it
 * on the recall provider (`notePrompt`) for the same step's context refresh.
 * This happens before and independently of every scout gate, so recall works
 * with no LLM at all.
 *
 * The deterministic recall tier then searches the memory store with the
 * query extracted from the user's own prompt — its labelled question or final
 * question paragraph, function words dropped — which is cheap and private but
 * lexical: a request phrased in terms a stored entry never used finds nothing.
 * When the host exposes a stream-capable llm, this adapter also runs ONE
 * bounded `ctx.llm.stream` call asking for a small JSON list of project
 * concepts likely relevant to that same question. The queries are handed to
 * the recall provider (`offerQueries`), whose context refresh later in the
 * same step merges them with the deterministic hits.
 *
 * The scout is opt-in by size and by weakness: in the default `auto` mode it
 * runs only when the workspace memory is large ({@link DEFAULT_MIN_ENTRIES})
 * AND the deterministic search is weak (fewer than two hits); `always` runs it
 * whenever memory is on; `deterministic` never does. Graph workers, subagent
 * sessions, `memory.recall: false` roles and turns with no new human prompt
 * are skipped, so the cost stays attached to a real user request. The model
 * route comes from the step's own selection when the installed host provides
 * one, else the session's last routed header, else the agent's creation
 * options; a host that exposes none still gets the prompt noted, without a
 * call. The call is bounded by the turn signal plus a hard timeout that races
 * the stream (so a provider ignoring the abort cannot stall the step), emits
 * no memory write, never mutates the step's messages and never throws into
 * the host: any failure yields no offer and the waterfall still returns
 * `next()`'s decision. A failure is logged as one closed, content-free reason,
 * so a live miss is diagnosable without exposing the prompt, the model output
 * or the extracted queries.
 *
 * @module
 */

import { isAbsolute } from "node:path";
import type { MemoryEntry } from "../../../memory/types.ts";
import { MemoryStore } from "../../../memory/store.ts";
import {
  memoryPromptQuery,
  memoryPromptQueryText,
  memoryPromptTerms,
} from "../../../memory/normalize.ts";
import { createSubLogger, formatError } from "../../../logger.ts";
import { resolveDshSessionContext, type DshContextAgent, type DshContextOptions } from "./session-context.ts";
import { latestPayloadPrompt, type DshPrompt } from "./session-prompt.ts";
import type { DshCordisContext } from "./event-bridge.ts";
import type { DshMemoryRecall } from "./memory-recall.ts";

const log = createSubLogger("dsh-memory-scout");

/** Default bound on the scout call, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 3000;

/** Default minimum number of stored entries before `auto` scouts. */
const DEFAULT_MIN_ENTRIES = 20;

/** Default cap on offered queries. */
const DEFAULT_MAX_QUERIES = 5;

/** Deterministic hits at or above this count make the search strong enough. */
const AUTO_WEAK_HITS = 2;

/** Hits inspected when grading the deterministic search. */
const AUTO_HIT_PROBE_LIMIT = 5;

/** Minimum number of search terms a prompt must yield before scouting. */
const MIN_PROMPT_TERMS = 2;

/** Output cap for the one-shot scout call. */
const SCOUT_MAX_TOKENS = 600;

/** Characters of the extracted question sent to the scout model. */
const MAX_PROMPT_CHARS = 4000;

/** Response characters collected from the scout stream. */
const MAX_RESPONSE_CHARS = 2000;

/** Longest accepted query, in characters. */
const MAX_QUERY_CHARS = 80;

/** Upper bound on remembered offer keys (oldest evicted). */
const OFFERED_LIMIT = 128;

/** Entries the session-focus block owns are never counted as recall hits. */
const FOCUS_TAG = "session-focus";
const FOCUS_TITLE_PREFIX = "Session focus";

/** Instruction sent as the scout request's system prompt. */
const SCOUT_INSTRUCTION =
  "Return ONLY one JSON object of the form {\"queries\": [\"...\"]} with 3 to 6 short terms or " +
  "phrases naming the project concepts (modules, files, technologies, decisions, constraints) " +
  "that are likely relevant to the user's request. Use the user's language. No prose, no markdown.";

/**
 * Structural subset of the dsh `GenerateOptions` the scout fills in. The
 * provider and model come from the step's own selection, so the one-shot call
 * travels the same route as the conversation.
 */
export interface DshMemoryScoutRequest {
  provider: string;
  model: string;
  system?: string;
  messages: Array<{ role: "user"; content: Array<{ type: "text"; text: string }> }>;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  sessionId?: string;
}

/**
 * Structural subset of the dsh `LlmRuntime` (`ctx.llm`) the scout consumes:
 * one streaming one-shot call. The host's `StreamChunk` values are inspected
 * structurally, so this adapter imports no dsh package.
 */
export interface DshMemoryScoutLlm {
  stream(options: DshMemoryScoutRequest): AsyncIterable<unknown>;
}

/** Construction options for {@link installDshMemoryScout}. */
export interface DshMemoryScoutOptions {
  /** Shared session-context resolver (roles, active role, workspace, tools). */
  context: DshContextOptions;
  /** The recall provider that receives the offered queries. */
  recall: DshMemoryRecall;
  /**
   * The host llm service. Without a `stream` function the listener still
   * installs and notes the prompt; only the scout call is skipped.
   */
  llm?: DshMemoryScoutLlm;
  /** Bound on one scout call, in milliseconds (default: 3000). */
  timeoutMs?: number;
  /** Minimum stored entries before `auto` scouts (default: 20). */
  minEntries?: number;
  /** Cap on offered queries (default: 5). */
  maxQueries?: number;
}

/** One structurally parsed `agent/pre-step` payload. */
interface ScoutStep {
  agent: DshContextAgent;
  session: NonNullable<DshContextAgent["session"]>;
  sessionId: string;
  messages: readonly unknown[];
  /** The payload's own model selection, when this host generation has one. */
  selection: unknown;
  /** The payload's turn abort signal (validated only when the scout runs). */
  signal: unknown;
}

/** A resolved provider/model route for the scout's one-shot call. */
interface ScoutRoute {
  provider: string;
  model: string;
}

/**
 * Closed, content-free reasons a scout call can produce no queries. The reason
 * is logged so a live miss stays diagnosable without putting the prompt, the
 * model's output, an error message or the queries in the log.
 */
type ScoutNoQueryReason =
  | "timeout"
  | "aborted"
  | "stream-error"
  | "empty-stream"
  | "invalid-json"
  | "empty-queries";

/** One scout call's result: sanitized queries, or a closed miss reason. */
type ScoutExtraction =
  | { readonly ok: true; readonly queries: readonly string[] }
  | { readonly ok: false; readonly reason: ScoutNoQueryReason };

/**
 * Install the prompt handoff, and the query scout when the host allows it, on
 * the `agent/pre-step` waterfall.
 *
 * The listener is ALWAYS registered: the recall provider needs the step's
 * admitted user message whether or not a model call is possible, because the
 * session log does not hold that message yet. Without a stream-capable llm it
 * only notes the prompt and returns `next()`'s decision. With one it also runs
 * the scout while that decision is already in flight, then returns the
 * decision unchanged — the listener can never reject a step or rewrite its
 * messages. Every failure is contained and logged without the prompt text.
 *
 * @param ctx - The cordis context event bus.
 * @param options - See {@link DshMemoryScoutOptions}.
 * @returns A disposer that removes the listener.
 */
export function installDshMemoryScout(
  ctx: DshCordisContext,
  options: DshMemoryScoutOptions,
): () => void {
  const llm = options.llm !== undefined && typeof options.llm.stream === "function"
    ? options.llm
    : undefined;
  const offered = new Set<string>();
  const listener = async (...args: unknown[]): Promise<unknown> => {
    const decisionPromise = nextDecision(args[1]);
    // Observe a rejection while the handoff/scout runs so a failing decision
    // is never reported as unhandled; the final await still rethrows it.
    decisionPromise?.catch(() => {});
    try {
      await handoffStep(options, llm, offered, args[0]);
    } catch (error) {
      log.debug("Memory scout failed", { error: formatError(error) });
    }
    return decisionPromise === undefined ? undefined : await decisionPromise;
  };
  let dispose: (() => void) | void;
  try {
    dispose = ctx.on("agent/pre-step", listener);
  } catch (error) {
    log.debug("Memory handoff listener registration failed", { error: formatError(error) });
    return () => {};
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    dispose?.();
  };
}

// ── Handoff and scout paths ────────────────────────────────────────────────

/**
 * Note the step's admitted user message for the recall provider, then scout
 * for it when this host can make the call and every gate passes.
 *
 * The handoff runs first, before any scout gate: the recall needs THIS step's
 * prompt even when the role, the workspace, the mode or the llm would skip the
 * model call. It is contained on its own so a failing recall provider cannot
 * suppress a later step's scout either.
 *
 * @param options - Construction options.
 * @param llm - The stream-capable llm service, when the host has one.
 * @param offered - Session/prompt keys already scouted.
 * @param payload - The raw `agent/pre-step` payload.
 */
async function handoffStep(
  options: DshMemoryScoutOptions,
  llm: DshMemoryScoutLlm | undefined,
  offered: Set<string>,
  payload: unknown,
): Promise<void> {
  const step = parseStep(payload);
  if (step === undefined) return;
  const prompt = latestPayloadPrompt(step.messages);
  if (prompt === undefined) return;
  // The admitted message is the current prompt: hand it to the recall render
  // before (and independently of) any scout gate.
  notePrompt(options.recall, step, prompt);
  if (llm === undefined) return;
  await scout(options, llm, offered, step, prompt);
}

/**
 * Run the gated one-shot scout for the step's payload prompt. Every early
 * return is a deliberate skip; a thrown error is contained by the listener.
 *
 * @param options - Construction options.
 * @param llm - The stream-capable llm service.
 * @param offered - Session/prompt keys already scouted.
 * @param step - The parsed payload.
 * @param prompt - The payload's current user-authored prompt.
 */
async function scout(
  options: DshMemoryScoutOptions,
  llm: DshMemoryScoutLlm,
  offered: Set<string>,
  step: ScoutStep,
  prompt: DshPrompt,
): Promise<void> {
  const resolved = resolveDshSessionContext(options.context, step.agent);
  if (resolved.worker) return;
  const role = resolved.role;
  const memory = role?.config.memory;
  if (memory?.recall === false) return;
  const mode = memory?.recall_mode ?? "auto";
  if (mode === "deterministic") return;
  // A subagent shares the parent's workspace memory; its own turns must not
  // multiply the parent's one-shot calls.
  if (isSubagentSession(step.session)) return;
  const directory = resolved.directory;
  if (directory === undefined || !isAbsolute(directory)) return;
  // A prompt must be specific enough on its own; the scout can widen retrieval
  // for it, but never rescues an unusably short prompt. The count is the
  // prompt-tuned term list (extracted task, function words dropped), not the
  // raw token count.
  if (memoryPromptTerms(prompt.text).length < MIN_PROMPT_TERMS) return;
  const offerKey = `${step.sessionId}:${prompt.key}`;
  if (offered.has(offerKey)) return;
  // Resolve the route (and the turn signal) before the size probe and before
  // remembering the prompt: a host that cannot route is not a scouted prompt.
  const route = scoutRoute(step);
  if (route === undefined || !isAbortSignal(step.signal)) return;

  const minEntries = positiveInteger(options.minEntries, DEFAULT_MIN_ENTRIES);
  if (mode === "auto" && !isSearchWeak(directory, prompt.text, role?.id ?? "", minEntries)) return;

  rememberOffer(offered, offerKey);
  const extraction = await extractQueries(llm, {
    provider: route.provider,
    model: route.model,
    // The scout must see the actual question, not a long instruction
    // preamble that would bias the concepts it proposes.
    prompt: memoryPromptQueryText(prompt.text),
    signal: step.signal,
    sessionId: step.sessionId,
    timeoutMs: positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxQueries: positiveInteger(options.maxQueries, DEFAULT_MAX_QUERIES),
  });
  if (!extraction.ok) {
    // Closed vocabulary only: the prompt, the model output and the queries
    // never reach the log.
    log.debug("Memory scout produced no queries", {
      sessionId: step.sessionId,
      promptKey: prompt.key,
      reason: extraction.reason,
    });
    return;
  }
  options.recall.offerQueries(step.sessionId, prompt.key, extraction.queries);
  log.debug("Memory scout offered queries", {
    sessionId: step.sessionId,
    promptKey: prompt.key,
    queries: extraction.queries.length,
  });
}

/**
 * Note one payload prompt on the recall provider. A provider that throws is
 * logged (never with the prompt text) and cannot fail the step.
 *
 * @param recall - The recall provider that renders the block.
 * @param step - The parsed payload.
 * @param prompt - The prompt to note.
 */
function notePrompt(recall: DshMemoryRecall, step: ScoutStep, prompt: DshPrompt): void {
  try {
    recall.notePrompt(step.sessionId, prompt.key, prompt.text);
  } catch (error) {
    log.debug("Memory recall prompt handoff failed", {
      sessionId: step.sessionId,
      error: formatError(error),
    });
  }
}

/**
 * Parse the waterfall payload structurally. Missing agent/session/messages
 * resolve to "nothing handed off and nothing scouted"; the model selection and
 * signal are kept raw because they are validated only when the scout can run.
 *
 * @param payload - The raw `agent/pre-step` payload.
 * @returns The parsed step, or `undefined`.
 */
function parseStep(payload: unknown): ScoutStep | undefined {
  if (!isRecord(payload)) return undefined;
  const agent = payload.agent;
  if (!isContextAgent(agent)) return undefined;
  const session = agent.session;
  if (session === undefined || typeof session.id !== "string" || session.id.length === 0) return undefined;
  const messages = payload.messages;
  if (!Array.isArray(messages)) return undefined;
  return {
    agent,
    session,
    sessionId: session.id,
    messages,
    selection: payload.modelSelection,
    signal: payload.signal,
  };
}

// ── Route ───────────────────────────────────────────────────────────────────

/**
 * Resolve the provider/model route the scout call should travel.
 *
 * The call must use the route the step's own request will use. The
 * `agent/pre-step` payload carries an explicit `modelSelection` only on some
 * host generations — the installed 0.2.x payload has none — so the resolution
 * follows the host's own order: the step's selection, then the session's last
 * routed header (`session.requestHeader().config`), then the agent's creation
 * options (`agent.options`). A host exposing none leaves the prompt noted and
 * the scout skipped rather than guessing a route.
 *
 * @param step - The parsed payload.
 * @returns The resolved route, or `undefined`.
 */
function scoutRoute(step: ScoutStep): ScoutRoute | undefined {
  const selected = routeOf(step.selection);
  if (selected !== undefined) return selected;
  const header = requestHeaderRoute(step.session);
  if (header !== undefined) return header;
  return isRecord(step.agent) ? routeOf(step.agent.options) : undefined;
}

/** Read `provider`/`model` from a value when both are non-empty strings. */
function routeOf(value: unknown): ScoutRoute | undefined {
  if (!isRecord(value)) return undefined;
  const provider = value.provider;
  const model = value.model;
  if (typeof provider !== "string" || provider.length === 0) return undefined;
  if (typeof model !== "string" || model.length === 0) return undefined;
  return { provider, model };
}

/**
 * Read the session's last routed header config as a route. Structural and
 * fail-soft: a session without `requestHeader`, a throwing read or a header
 * without a provider/model pair yields no route.
 *
 * @param session - The step's session.
 * @returns The header route, or `undefined`.
 */
function requestHeaderRoute(session: unknown): ScoutRoute | undefined {
  if (!isRecord(session)) return undefined;
  const requestHeader = session.requestHeader;
  if (typeof requestHeader !== "function") return undefined;
  let header: unknown;
  try {
    header = requestHeader.call(session);
  } catch {
    return undefined;
  }
  if (!isRecord(header)) return undefined;
  return routeOf(header.config);
}

/**
 * Grade the deterministic search: the memory store must be large enough AND
 * the prompt's own search must find fewer than two non-focus entries. The
 * probe uses the same prompt-tuned query the recall provider searches with
 * ({@link memoryPromptQuery}), so the grade matches what the deterministic
 * tier would actually retrieve for the extracted question.
 *
 * @param directory - Absolute workspace directory.
 * @param promptText - The latest human prompt.
 * @param roleId - Acting role id; `''` restricts reads to workspace entries.
 * @param minEntries - Minimum stored entry count.
 * @returns `true` when the scout should run.
 */
function isSearchWeak(
  directory: string,
  promptText: string,
  roleId: string,
  minEntries: number,
): boolean {
  const query = memoryPromptQuery(promptText);
  if (!query) return false;
  const store = MemoryStore.open(directory);
  try {
    if (store.stats().total < minEntries) return false;
    const hits = store.search({ query, roleId, limit: AUTO_HIT_PROBE_LIMIT });
    let strong = 0;
    for (const hit of hits) {
      if (isFocusEntry(hit)) continue;
      strong += 1;
      if (strong >= AUTO_WEAK_HITS) return false;
    }
    return true;
  } finally {
    store.close();
  }
}

/**
 * Run the one-shot call and parse its JSON query list.
 *
 * The request is bounded by the turn signal AND an independent timeout. The
 * timeout is a hard bound, not merely an abort: stream consumption races the
 * deadline, so a provider that ignores the abort signal cannot hold the
 * `agent/pre-step` waterfall open past `timeoutMs`, and a chunk that arrives
 * after the deadline is discarded rather than offered. Text deltas are
 * authoritative; a block-end chunk carries the text its block already
 * streamed, so it is used only when no delta produced text.
 *
 * Every miss is one closed {@link ScoutNoQueryReason}, never a bare
 * `undefined`, so a timeout, a turn abort, a throwing stream, an empty stream,
 * unparseable JSON and an empty query list stay distinguishable to the caller
 * without carrying the prompt or the model's output.
 *
 * @param llm - The stream-capable llm service.
 * @param input - The extracted question, route, signal and bounds.
 * @returns The sanitized queries, or the content-free miss reason.
 */
async function extractQueries(
  llm: DshMemoryScoutLlm,
  input: {
    provider: string;
    model: string;
    prompt: string;
    signal: AbortSignal;
    sessionId: string;
    timeoutMs: number;
    maxQueries: number;
  },
): Promise<ScoutExtraction> {
  const controller = new AbortController();
  const forwardTurnAbort = (): void => controller.abort();
  if (input.signal.aborted) return { ok: false, reason: "aborted" };
  input.signal.addEventListener("abort", forwardTurnAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    let stream: AsyncIterable<unknown>;
    try {
      stream = llm.stream({
        provider: input.provider,
        model: input.model,
        system: SCOUT_INSTRUCTION,
        messages: [{
          role: "user",
          content: [{ type: "text", text: truncate(input.prompt, MAX_PROMPT_CHARS) }],
        }],
        maxTokens: SCOUT_MAX_TOKENS,
        temperature: 0,
        signal: controller.signal,
        sessionId: input.sessionId,
      });
    } catch {
      return { ok: false, reason: "stream-error" };
    }
    // The rejection stays observed here: a provider that ignores the abort may
    // still fail after the deadline has already returned.
    const collected = collectResponseText(stream, controller.signal).then(
      (text) => ({ text }),
      () => ({ failed: true as const }),
    );
    const deadline = new Promise<{ readonly timedOut: true }>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve({ timedOut: true });
      }, input.timeoutMs);
    });
    const raced = await Promise.race([collected, deadline]);
    if ("timedOut" in raced || timedOut) return { ok: false, reason: "timeout" };
    if (controller.signal.aborted) return { ok: false, reason: "aborted" };
    if ("failed" in raced) return { ok: false, reason: "stream-error" };
    if (raced.text === undefined) return { ok: false, reason: "aborted" };
    if (raced.text.trim().length === 0) return { ok: false, reason: "empty-stream" };
    return parseQueries(raced.text, input.maxQueries);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    input.signal.removeEventListener("abort", forwardTurnAbort);
  }
}

/**
 * Collect the response text from one stream without outliving the deadline.
 *
 * The signal is checked before every chunk and once more after the loop, so a
 * late chunk is never parsed. Text deltas are joined; a block-end chunk is
 * only the fallback for a provider that emits no delta text.
 *
 * @param stream - The provider's chunk stream.
 * @param signal - The deadline/turn signal.
 * @returns The collected text, or `undefined` once the deadline expired.
 */
async function collectResponseText(
  stream: AsyncIterable<unknown>,
  signal: AbortSignal,
): Promise<string | undefined> {
  let deltas = "";
  let blocks = "";
  for await (const chunk of stream) {
    if (signal.aborted) return undefined;
    const delta = deltaText(chunk);
    if (delta !== undefined && delta.length > 0) {
      deltas += delta;
      if (deltas.length >= MAX_RESPONSE_CHARS) return deltas.slice(0, MAX_RESPONSE_CHARS);
      continue;
    }
    const block = blockEndText(chunk);
    if (block !== undefined) blocks += block;
  }
  if (signal.aborted) return undefined;
  const text = deltas.length > 0 ? deltas : blocks;
  return text.length > MAX_RESPONSE_CHARS ? text.slice(0, MAX_RESPONSE_CHARS) : text;
}

/** The text a `text-delta` chunk carries, when it carries any. */
function deltaText(chunk: unknown): string | undefined {
  if (!isRecord(chunk) || chunk.type !== "text-delta") return undefined;
  return typeof chunk.text === "string" ? chunk.text : undefined;
}

/** The text a `block-end` chunk carries for one completed text block. */
function blockEndText(chunk: unknown): string | undefined {
  if (!isRecord(chunk) || chunk.type !== "block-end") return undefined;
  const block = chunk.block;
  if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return undefined;
  return block.text;
}

/**
 * Parse the first JSON object in a model response and read its `queries`
 * member (an array of strings, or a single string).
 *
 * @param text - The collected response text.
 * @param maxQueries - Cap on accepted queries.
 * @returns The sanitized queries, or the content-free miss reason.
 */
function parseQueries(text: string, maxQueries: number): ScoutExtraction {
  const payload = firstJsonObject(text);
  if (!isRecord(payload)) return { ok: false, reason: "invalid-json" };
  const raw = payload.queries;
  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : undefined;
  if (list === undefined) return { ok: false, reason: "invalid-json" };
  const queries = sanitizeQueries(
    list.filter((entry): entry is string => typeof entry === "string"),
    maxQueries,
  );
  return queries.length === 0
    ? { ok: false, reason: "empty-queries" }
    : { ok: true, queries };
}

/**
 * Extract the first complete JSON object from a response, tolerating a code
 * fence or surrounding prose. A brace count outside string literals finds the
 * matching close, so nested objects and braces in strings are handled.
 *
 * @param text - The response text.
 * @returns The parsed JSON value, or `undefined`.
 */
function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char !== "}") continue;
    depth -= 1;
    if (depth !== 0) continue;
    try {
      return JSON.parse(text.slice(start, index + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Trim, whitespace-collapse and bound extracted queries, dropping empties and
 * case-insensitive duplicates in first-seen order.
 *
 * @param queries - Candidate queries.
 * @param maxQueries - Cap on accepted queries.
 * @returns The usable queries.
 */
function sanitizeQueries(queries: readonly string[], maxQueries: number): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const query of queries) {
    const normalized = query.replace(/\s+/g, " ").trim();
    if (normalized.length === 0 || normalized.length > MAX_QUERY_CHARS) continue;
    const folded = normalized.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    kept.push(normalized);
    if (kept.length >= maxQueries) break;
  }
  return kept;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Call the waterfall's `next` when it is a function, else report absence. */
function nextDecision(next: unknown): Promise<unknown> | undefined {
  if (typeof next !== "function") return undefined;
  return (next as () => Promise<unknown>)();
}

/** Remember one scouted prompt, evicting the oldest beyond the cap. */
function rememberOffer(offered: Set<string>, key: string): void {
  offered.add(key);
  while (offered.size > OFFERED_LIMIT) {
    const oldest = offered.values().next();
    if (oldest.done) return;
    offered.delete(oldest.value);
  }
}

/** True for a dsh subagent session (both the durable origin and lineage). */
function isSubagentSession(session: NonNullable<DshContextAgent["session"]>): boolean {
  const header = session.header;
  if (header === undefined) return false;
  if (header.origin === "subagent") return true;
  return typeof header.parentSession === "string" && header.parentSession.length > 0;
}

/** True for the session-focus entry recall must never repeat. */
function isFocusEntry(entry: MemoryEntry): boolean {
  return entry.tags.includes(FOCUS_TAG) || entry.title.startsWith(FOCUS_TITLE_PREFIX);
}

/** Clamp an option to a positive integer, else its default. */
function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Truncate by code point so a long prompt cannot inflate the request. */
function truncate(text: string, limit: number): string {
  const points = Array.from(text);
  return points.length <= limit ? text : points.slice(0, limit).join("");
}

/** True for a plain record (not an array or null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the value is the live agent shape the context resolver needs. */
function isContextAgent(value: unknown): value is DshContextAgent {
  if (!isRecord(value)) return false;
  const session = value.session;
  return isRecord(session) && typeof session.id === "string";
}

/** Structurally recognize an AbortSignal (the waterfall passes a real one). */
function isAbortSignal(value: unknown): value is AbortSignal {
  return isRecord(value) &&
    typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function";
}
