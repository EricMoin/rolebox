/**
 * Turn-scoped, query-aware memory recall for dsh.
 *
 * A long-running workspace accumulates memory that the model never sees when
 * the session start block was assembled hours ago. This adapter renders a
 * bounded `## Relevant memory` system-prompt block from the memories that
 * match the session's CURRENT human prompt — the per-turn counterpart of the
 * session-start `## Available memory` table. The prompt normally arrives
 * through {@link DshMemoryRecall.notePrompt}: the agent loop claims a step's
 * user message out of the inbox BEFORE appending it to the session log, so the
 * pre-step listener hands over the message the same step is working on. The
 * session log's newest user-authored message is the fallback for a render with
 * no handoff. The adapter never subscribes to events, never writes memory and
 * never includes summary content.
 *
 * Only a message the user actually authored drives retrieval: its `source.kind`
 * must be `user`, so injected runtime context, model selections, compaction
 * checkpoints and rolebox notices never pose as a prompt. The block is capped
 * in entries and code points, names each entry's id and content, and instructs
 * the agent to cite what it used. Rendering is fail-soft: every failure returns
 * `''`. An optional LLM query scout can offer extra queries for the same
 * prompt; {@link DshMemoryRecall.offerQueries} merges them after the
 * deterministic search without changing the caps or writing anything.
 *
 * @module
 */

import { workerTaskToolAllowed } from "../../../graph/host/tool-binding.ts";
import { isAbsolute } from "node:path";
import type { MemoryEntry } from "../../../memory/types.ts";
import { MemoryStore } from "../../../memory/store.ts";
import { memoryPromptQuery, memoryPromptTerms } from "../../../memory/normalize.ts";
import { memoryToolEnabled } from "../../../memory/tool-policy.ts";
import { createSubLogger, formatError } from "../../../logger.ts";
import { resolveDshSessionContext, type DshContextAgent, type DshContextOptions } from "./session-context.ts";
import { readDshSessionEvents } from "./session-events.ts";
import { latestUserPrompt, type DshPrompt } from "./session-prompt.ts";
import type { DshSystemPromptContext } from "./system-prompt.ts";

const log = createSubLogger("dsh-memory-recall");

/** Default cap on retrieved entries. */
const DEFAULT_MAX_ENTRIES = 3;

/** Default cap on the rendered block, in code points. */
const DEFAULT_MAX_CHARS = 3000;

/** Upper bound on cached renders (oldest entry evicted). */
const CACHE_LIMIT = 128;

/** Upper bound on remembered per-session prompts (oldest entry evicted). */
const PROMPT_LIMIT = 256;

/** Minimum number of search terms a prompt must yield before recall runs. */
const MIN_PROMPT_TERMS = 2;

/** Max scout queries folded into one render. */
const MAX_SCOUT_QUERIES = 3;

/** Max queries one offer may carry. */
const MAX_OFFERED_QUERIES = 5;

/** Longest accepted scout query, in characters. */
const MAX_QUERY_CHARS = 80;

/** Smallest useful content excerpt; below this an entry is dropped. */
const MIN_EXCERPT = 20;

/** Entries the session-focus block owns are never repeated here. */
const FOCUS_TAG = "session-focus";
const FOCUS_TITLE_PREFIX = "Session focus";

/** Heading and standing copy of the block. */
const HEADING = "## Relevant memory";
const INTRO = "Retrieved from workspace memory for this request.";
const CITATION =
  "When a retrieved memory changes what you do or say, name it (title or id) so the user can see what you remembered.";

/** Construction options for {@link createDshMemoryRecall}. */
export interface DshMemoryRecallOptions {
  /** Shared session-context resolver (roles, active role, workspace, tools). */
  context: DshContextOptions;
  /** Max entries shown in the block (default: 3). */
  maxEntries?: number;
  /** Max code points in the whole block (default: 3000). */
  maxChars?: number;
}

/** The recall prompt provider: one render method plus a per-instance cache. */
export interface DshMemoryRecall {
  /**
   * Render the `## Relevant memory` block for a prompt context.
   *
   * Returns `''` (the registry drops the contribution) when the session has no
   * user-authored prompt, the prompt yields fewer than two search terms, the
   * search finds nothing, when the role opts out with `memory.recall: false`,
   * without an absolute workspace, when a worker has no authorized memory tools,
   * or when the memory store is unavailable. Never throws.
   *
   * @param ctx - The dsh system-prompt context.
   * @returns The block, or `''`.
   */
  render(ctx: DshSystemPromptContext): string;
  /**
   * Note the user message the current step admitted, for {@link render}.
   *
   * The agent loop claims a step's user message out of the inbox BEFORE it
   * appends it to the session log, so a recall that only reads the log has no
   * prompt on the first turn and the PREVIOUS prompt on every later turn.
   * {@link installDshMemoryScout} calls this from `agent/pre-step` with the
   * payload's current user message, and the block then renders for the message
   * actually being worked on. The note replaces the session's previous prompt
   * and invalidates that session's cached renders so the step's later context
   * refresh re-renders for the new message. At most
   * {@link PROMPT_LIMIT} sessions are remembered, oldest evicted.
   *
   * @param sessionId - The session the message belongs to.
   * @param promptKey - The message's stable id (the scout's offer key).
   * @param text - The user-authored prompt text.
   */
  notePrompt(sessionId: string, promptKey: string, text: string): void;
  /**
   * Offer LLM-extracted search queries for one user-authored prompt.
   *
   * The offer is keyed by the session and the prompt key — the message id the
   * handoff noted, or the event sequence for a log-derived fallback — so it
   * only ever widens the render for exactly that message. The cached
   * deterministic block for the message is dropped so the next render merges
   * the offered queries; the step's later context refresh picks them up.
   * Queries are trimmed, whitespace-collapsed, bounded to 80 characters and
   * five entries, and de-duplicated case-insensitively.
   *
   * @param sessionId - The session whose prompt the queries describe.
   * @param promptKey - The message id (or fallback sequence key) the queries describe.
   * @param queries - Candidate search terms; invalid entries are dropped.
   */
  offerQueries(sessionId: string, promptKey: string, queries: readonly string[]): void;
}

/**
 * Create the `## Relevant memory` provider for one plugin instance.
 *
 * @param options - See {@link DshMemoryRecallOptions}.
 * @returns The provider; renders are cached per session/prompt-message/role so
 *          a turn's later prompt assemblies reuse the first block.
 */
export function createDshMemoryRecall(options: DshMemoryRecallOptions): DshMemoryRecall {
  const cache = new Map<string, string>();
  const offers = new Map<string, readonly string[]>();
  const prompts = new Map<string, DshPrompt>();
  return {
    render(ctx: DshSystemPromptContext): string {
      return renderRecall(options, cache, offers, prompts, ctx);
    },
    notePrompt(sessionId: string, promptKey: string, text: string): void {
      notePrompt(cache, prompts, sessionId, promptKey, text);
    },
    offerQueries(sessionId: string, promptKey: string, queries: readonly string[]): void {
      offerQueries(cache, offers, sessionId, promptKey, queries);
    },
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────

/**
 * Render one prompt block. Fail-soft: every failure (a context resolver, the
 * session log, the store) degrades to `''` and is logged at debug level.
 *
 * @param options - Construction options.
 * @param cache - The instance's render cache.
 * @param offers - The instance's scout query offers, keyed session/prompt.
 * @param prompts - The instance's noted per-session prompts.
 * @param ctx - The dsh system-prompt context.
 * @returns The block, or `''`.
 */
function renderRecall(
  options: DshMemoryRecallOptions,
  cache: Map<string, string>,
  offers: ReadonlyMap<string, readonly string[]>,
  prompts: ReadonlyMap<string, DshPrompt>,
  ctx: DshSystemPromptContext,
): string {
  try {
    const sessionId = promptSessionId(ctx);
    if (!sessionId) return "";
    const agent = promptAgent(ctx, sessionId);
    const resolved = resolveDshSessionContext(options.context, agent);
    const role = resolved.role;
    if (role?.config.memory?.recall === false) return "";
    const directory = resolved.directory;
    if (!directory || !isAbsolute(directory)) return "";

    const worker = resolved.worker;
    const registered = new Set([...registeredTools(options.context, agent)].filter(name =>
      !worker || workerTaskToolAllowed(name, worker.declaredTools, worker.inheritedTools)));
    const names = toolAliases(options.context);
    if (worker && !["memory_read", "memory_recall", "memory_list"].some(name =>
      availableTool(name, role?.config.tools, registered, names) !== undefined)) return "";
    const readTool = availableTool("memory_read", role?.config.tools, registered, names);
    const recallTool = availableTool("memory_recall", role?.config.tools, registered, names);

    const prompt = prompts.get(sessionId)
      ?? latestUserPrompt(readDshSessionEvents(agent.session ?? sessionOf(options.context, sessionId)));
    if (!prompt) return "";
    // A prompt must be specific enough on its own: the scout can widen
    // retrieval for it, but never rescues an unusably short prompt. The count
    // is the prompt-tuned term list (extracted task, function words dropped),
    // not the raw token count.
    if (memoryPromptTerms(prompt.text).length < MIN_PROMPT_TERMS) return "";

    const key = `${sessionId}:${prompt.key}:${role?.id ?? ""}:${JSON.stringify([readTool, recallTool])}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const maxEntries = entriesBudget(options.maxEntries);
    const queries = recallQueries(prompt.text, offers.get(`${sessionId}:${prompt.key}`));
    if (queries.length === 0) return "";
    const entries = recallEntries(directory, queries, role?.id ?? "", maxEntries);
    if (entries.length === 0) return "";

    const block = renderBlock({
      entries,
      maxChars: charsBudget(options.maxChars),
      readTool,
      recallTool,
    });
    remember(cache, key, block);
    return block;
  } catch (error) {
    log.debug("Relevant-memory block unavailable", {
      error: formatError(error),
    });
    return "";
  }
}

/**
 * Render the block: heading, retrieval statement (with the real read/search
 * tool names when the session holds them), one entry per hit and the citation
 * instruction. Entry excerpts are capped so the whole block stays within
 * `maxChars`; an excerpt that does not fit is truncated with `…`.
 *
 * @param input - Entries, the budget and the available tool names.
 * @returns The rendered block.
 */
function renderBlock(input: {
  entries: readonly MemoryEntry[];
  maxChars: number;
  readTool: string | undefined;
  recallTool: string | undefined;
}): string {
  const hint = toolHint(input.readTool, input.recallTool);
  const intro = hint ? `${INTRO} ${hint}` : INTRO;
  const footer = ["", CITATION];
  const parts: string[] = [HEADING, "", intro, ""];
  const limit = Math.max(0, input.maxChars - footer.join("\n").length - 1);
  let used = parts.join("\n").length;
  for (const entry of input.entries) {
    const headline = `- **${entry.title}** (\`${entry.id}\`, ${entry.scope}, ${entry.relevance})`;
    // newline + headline + newline + two-space indent + one reserved character
    const fixed = 1 + headline.length + 1 + 2 + 1;
    const available = limit - used - fixed;
    if (available < MIN_EXCERPT) break;
    const excerpt = excerptOf(entry.content, available);
    parts.push(headline, `  ${excerpt}`);
    used += fixed - 1 + excerpt.length;
  }
  parts.push(...footer);
  const block = parts.join("\n");
  if (block.length <= input.maxChars) return block;
  return `${block.slice(0, Math.max(0, input.maxChars - 1)).trimEnd()}…`;
}

/** The sentence naming the real read/search tools, or `''` without either. */
function toolHint(readTool: string | undefined, recallTool: string | undefined): string {
  const actions: string[] = [];
  if (readTool !== undefined) actions.push(`read a full entry with \`${readTool}\``);
  if (recallTool !== undefined) actions.push(`search for more with \`${recallTool}\``);
  if (actions.length === 0) return "";
  return `You can ${actions.join(" and ")}.`;
}

/** Collapse whitespace and truncate one content excerpt by code point. */
function excerptOf(content: string, limit: number): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  const points = Array.from(collapsed);
  if (points.length <= limit) return collapsed;
  const cut = Math.max(1, limit - 1);
  return `${points.slice(0, cut).join("").trimEnd()}…`;
}

// ── Retrieval ───────────────────────────────────────────────────────────────

/**
 * Build the ordered query list for one prompt: the deterministic query first,
 * then up to {@link MAX_SCOUT_QUERIES} offered queries, each normalized the
 * same prompt-tuned way (skipping empties and duplicates). The deterministic
 * query comes from the prompt's extracted question with function words
 * dropped ({@link memoryPromptQuery}), so a long instruction preamble cannot
 * starve the entities the question names. When the deterministic query is
 * empty — a defensive case, since the prompt already passed the term check —
 * the offered queries are still usable on their own.
 *
 * @param promptText - The user-authored prompt.
 * @param offered - The scout's queries for this exact prompt, when any.
 * @returns The normalized queries, deterministic first.
 */
function recallQueries(promptText: string, offered: readonly string[] | undefined): string[] {
  const queries: string[] = [];
  const deterministic = memoryPromptQuery(promptText);
  if (deterministic) queries.push(deterministic);
  let scouts = 0;
  for (const query of offered ?? []) {
    if (scouts >= MAX_SCOUT_QUERIES) break;
    if (queries.length >= MAX_SCOUT_QUERIES + 1) break;
    const normalized = memoryPromptQuery(query);
    if (!normalized || queries.includes(normalized)) continue;
    queries.push(normalized);
    scouts += 1;
  }
  return queries;
}

/**
 * Search the workspace memory once per query, then merge the ranked result
 * lists round-robin by query index and result rank — deterministic first hit,
 * first scout hit, second scout hit, deterministic second hit, and so on —
 * dropping the entries the session-focus block owns and de-duplicating by id.
 *
 * @param directory - Absolute workspace directory.
 * @param queries - The normalized queries, deterministic first.
 * @param roleId - Acting role id; `''` restricts reads to workspace entries.
 * @param limit - Max entries to keep.
 * @returns The merged entries, in round-robin ranked order.
 */
function recallEntries(
  directory: string,
  queries: readonly string[],
  roleId: string,
  limit: number,
): MemoryEntry[] {
  const store = MemoryStore.open(directory);
  try {
    const ranked = queries.map(query => store.search({ query, roleId, limit: limit * 3 }));
    const seen = new Set<string>();
    const entries: MemoryEntry[] = [];
    const longest = ranked.reduce((max, hits) => Math.max(max, hits.length), 0);
    for (let rank = 0; rank < longest; rank += 1) {
      for (const hits of ranked) {
        const entry = hits[rank];
        if (entry === undefined) continue;
        if (entry.tags.includes(FOCUS_TAG)) continue;
        if (entry.title.startsWith(FOCUS_TITLE_PREFIX)) continue;
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        entries.push(entry);
        if (entries.length >= limit) return entries;
      }
    }
    return entries;
  } finally {
    store.close();
  }
}

// ── Cache ───────────────────────────────────────────────────────────────────

/** Store a render and evict the oldest entry beyond {@link CACHE_LIMIT}. */
function remember(cache: Map<string, string>, key: string, block: string): void {
  cache.set(key, block);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    cache.delete(oldest.value);
  }
}

// ── Offers ──────────────────────────────────────────────────────────────────

/**
 * Store one sanitized query offer and invalidate every cached render for that
 * session/user sequence so the next render merges it.
 *
 * @param cache - The instance's render cache.
 * @param offers - The instance's offer map.
 * @param sessionId - The offered session.
 * @param promptKey - The prompt key (message id or fallback sequence key).
 * @param queries - Candidate queries; invalid entries are dropped.
 */
function offerQueries(
  cache: Map<string, string>,
  offers: Map<string, readonly string[]>,
  sessionId: string,
  promptKey: string,
  queries: readonly string[],
): void {
  if (!sessionId || !promptKey) return;
  const sanitized = sanitizeQueries(queries);
  if (sanitized.length === 0) return;
  offers.set(`${sessionId}:${promptKey}`, sanitized);
  while (offers.size > CACHE_LIMIT) {
    const oldest = offers.keys().next();
    if (oldest.done) break;
    offers.delete(oldest.value);
  }
  const prefix = `${sessionId}:${promptKey}:`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

// ── Prompt handoff ──────────────────────────────────────────────────────────

/**
 * Remember the prompt the current step admitted and drop the session's cached
 * renders so the next context refresh re-renders for it.
 *
 * The cached block of an EARLIER render for the same session can only belong
 * to an older prompt: invalidating every render of that session is what makes
 * the step's refresh see the new message instead of reusing the previous
 * turn's block. A re-note of the same session still re-inserts the entry, so
 * eviction keeps following the oldest-note order.
 *
 * @param cache - The instance's render cache.
 * @param prompts - The instance's noted prompts.
 * @param sessionId - The session the message belongs to.
 * @param promptKey - The message's stable id.
 * @param text - The user-authored prompt text.
 */
function notePrompt(
  cache: Map<string, string>,
  prompts: Map<string, DshPrompt>,
  sessionId: string,
  promptKey: string,
  text: string,
): void {
  if (!sessionId || !promptKey) return;
  prompts.delete(sessionId);
  prompts.set(sessionId, { key: promptKey, text });
  const prefix = `${sessionId}:`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
  while (prompts.size > PROMPT_LIMIT) {
    const oldest = prompts.keys().next();
    if (oldest.done) return;
    prompts.delete(oldest.value);
  }
}

/**
 * Trim, whitespace-collapse and bound offered queries, dropping empties and
 * case-insensitive duplicates in first-seen order.
 *
 * @param queries - Candidate queries.
 * @returns At most {@link MAX_OFFERED_QUERIES} usable queries.
 */
function sanitizeQueries(queries: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const query of queries) {
    if (typeof query !== "string") continue;
    const normalized = query.replace(/\s+/g, " ").trim();
    if (normalized.length === 0 || normalized.length > MAX_QUERY_CHARS) continue;
    const folded = normalized.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    kept.push(normalized);
    if (kept.length >= MAX_OFFERED_QUERIES) break;
  }
  return kept;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve the session id from a dsh prompt context. */
function promptSessionId(ctx: DshSystemPromptContext): string | undefined {
  if (typeof ctx.sessionID === "string" && ctx.sessionID) return ctx.sessionID;
  if (typeof ctx.sessionId === "string" && ctx.sessionId) return ctx.sessionId;
  if (typeof ctx.agent?.id === "string" && ctx.agent.id) return ctx.agent.id;
  return undefined;
}

/**
 * Resolve the agent for a prompt context: the model-facing agent, the assembly
 * scope when it is an object, or a minimal id-only agent.
 */
function promptAgent(ctx: DshSystemPromptContext, sessionId: string): DshContextAgent {
  const candidate = ctx.agent ?? ctx.scope;
  if (typeof candidate === "object" && candidate !== null) return candidate as DshContextAgent;
  return { id: sessionId };
}

/** Resolve the host's session object, tolerating a resolver that throws. */
function sessionOf(context: DshContextOptions, sessionId: string): DshContextAgent["session"] {
  try {
    return context.session(sessionId);
  } catch {
    return undefined;
  }
}

/** Registered tool names for the acting agent, tolerating a resolver that throws. */
function registeredTools(context: DshContextOptions, agent: DshContextAgent): ReadonlySet<string> {
  try {
    return new Set(context.tools(agent));
  } catch {
    return new Set<string>();
  }
}

/** The host's canonical → registered tool-name map (empty when absent). */
function toolAliases(context: DshContextOptions): ReadonlyMap<string, string> {
  try {
    return context.names?.() ?? new Map<string, string>();
  } catch {
    return new Map<string, string>();
  }
}

/** The tool's ACTUAL registered name when it is authorized and registered. */
function availableTool(
  name: string,
  tools: Record<string, boolean> | undefined,
  registered: ReadonlySet<string>,
  names: ReadonlyMap<string, string>,
): string | undefined {
  if (!memoryToolEnabled(name, tools)) return undefined;
  const actual = names.get(name) ?? name;
  return registered.has(actual) ? actual : undefined;
}

/** Clamp the configured entry budget to a positive integer. */
function entriesBudget(maxEntries: number | undefined): number {
  return maxEntries !== undefined && Number.isFinite(maxEntries) && maxEntries > 0
    ? Math.min(Math.floor(maxEntries), 10)
    : DEFAULT_MAX_ENTRIES;
}

/** Clamp the configured character budget to a positive integer. */
function charsBudget(maxChars: number | undefined): number {
  return maxChars !== undefined && Number.isFinite(maxChars) && maxChars > 0
    ? Math.floor(maxChars)
    : DEFAULT_MAX_CHARS;
}
