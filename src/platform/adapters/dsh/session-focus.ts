/**
 * Agent-curated session focus across dsh context compaction.
 *
 * dsh keeps a long session inside the model's window by replacing older
 * surface history with one model-written summary — the `compaction/summary`
 * session event, the same engine behind `/compact`. That summary is
 * conversation content and belongs to the session log and the live surface
 * only: copying it into rolebox memory would retain a transcript-shaped
 * artifact the user did not ask for.
 *
 * This adapter renders a bounded `## Session focus` system-prompt block
 * instead. The block describes the ONE memory entry the agent curates for the
 * session — current goal, key facts and decisions, constraints and
 * preferences, what needs attention now and open threads. It reads the entry
 * from the memory store and the session's compaction event time from the
 * session log, so it survives a restart; it never subscribes to events, never
 * writes memory and never reads the summary text.
 *
 * Every seam is structural (`DshContextOptions`, `DshSystemPromptContext`) and
 * fail-soft: the render provider returns `''` rather than throwing into the
 * host.
 *
 * @module
 */

import { isAbsolute } from "node:path";
import type { MemoryEntry } from "../../../memory/types.ts";
import { MemoryStore } from "../../../memory/store.ts";
import { memoryToolEnabled } from "../../../memory/tool-policy.ts";
import { createSubLogger, formatError } from "../../../logger.ts";
import { resolveDshSessionContext, type DshContextAgent, type DshContextOptions } from "./session-context.ts";
import { readDshSessionEvents } from "./session-events.ts";
import type { DshSystemPromptContext } from "./system-prompt.ts";

const log = createSubLogger("dsh-session-focus");

/** Content budget for the rendered entry, in code points. */
const DEFAULT_MAX_CHARS = 4000;

/** Marker appended when the entry content exceeds the budget. */
const TRUNCATION_MARKER = "\n\n… (truncated)";

/** Tag every agent-curated session-focus entry carries. */
const FOCUS_TAG = "session-focus";

/** Fallback title prefix for entries written without the tag. */
const FOCUS_TITLE_PREFIX = "session focus";

/** Memory title prefix the create recipe asks the agent to use. */
const FOCUS_TITLE = "Session focus";

/** dsh's session-id prefix; it carries no identity by itself. */
const SESSION_ID_PREFIX = "session-";

/** Number of session-id characters used in the entry title. */
const SHORT_SESSION_CHARS = 8;

/** dsh session event carrying a completed compaction summary. */
const COMPACTION_SUMMARY_EVENT = "compaction/summary";

/**
 * Construction options for {@link createDshSessionFocus}.
 */
export interface DshSessionFocusOptions {
  /** Shared session-context resolver (roles, active role, workspace, tools). */
  context: DshContextOptions;
  /** Max code points of entry content shown in the block (default: 4000). */
  maxChars?: number;
}

/**
 * The session-focus prompt provider: one render method, no state.
 */
export interface DshSessionFocus {
  /**
   * Render the `## Session focus` block for a prompt context.
   *
   * Returns `''` (the registry drops the contribution) when the session has no
   * focus entry and no authorized/registered `memory_write`, when the role
   * opts out with `memory.session_focus: false`, without an absolute
   * workspace, for a graph worker, or when the memory store is unavailable.
   * Never throws.
   *
   * @param ctx - The dsh system-prompt context.
   * @returns The block, or `''`.
   */
  render(ctx: DshSystemPromptContext): string;
}

/**
 * Create the `## Session focus` provider for one plugin instance.
 *
 * @param options - See {@link DshSessionFocusOptions}.
 * @returns The provider; rendering derives everything from the session log
 *          and the memory store on each call.
 */
export function createDshSessionFocus(options: DshSessionFocusOptions): DshSessionFocus {
  return {
    render(ctx: DshSystemPromptContext): string {
      return renderFocus(options, ctx);
    },
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────

/**
 * Render one prompt block. Fail-soft: every failure (a context resolver, the
 * session log, the store) degrades to `''` and is logged at debug level.
 *
 * @param options - Construction options.
 * @param ctx - The dsh system-prompt context.
 * @returns The block, or `''`.
 */
function renderFocus(options: DshSessionFocusOptions, ctx: DshSystemPromptContext): string {
  try {
    const sessionId = promptSessionId(ctx);
    if (!sessionId) return "";
    const agent = promptAgent(ctx, sessionId);
    const resolved = resolveDshSessionContext(options.context, agent);
    // Graph workers run under a dispatch grant, not the role's memory policy;
    // their continuity comes from the dispatch prompt.
    if (resolved.worker) return "";
    const role = resolved.role;
    if (role?.config.memory?.session_focus === false) return "";
    const directory = resolved.directory;
    if (!directory || !isAbsolute(directory)) return "";

    const names = toolAliases(options.context);
    const registered = registeredTools(options.context, agent);
    const canWrite = memoryToolEnabled("memory_write", role?.config.tools) &&
      registered.has(toolName(names, "memory_write"));
    const canUpdate = memoryToolEnabled("memory_update", role?.config.tools) &&
      registered.has(toolName(names, "memory_update"));

    const session = agent.session ?? sessionOf(options.context, sessionId);
    const compactionTime = lastCompactionTime(readDshSessionEvents(session));
    const entry = readFocusEntry(directory, sessionId, role?.id ?? "");
    if (!entry) {
      // Nothing to show and nothing the agent could write.
      if (!canWrite) return "";
      return renderCreateBlock({
        writeTool: toolName(names, "memory_write"),
        sessionId,
        scope: role ? "role" : "workspace",
        compactionTime,
      });
    }
    return renderEntryBlock({
      entry,
      maxChars: contentBudget(options.maxChars),
      canUpdate,
      updateTool: toolName(names, "memory_update"),
      compactionTime,
    });
  } catch (error) {
    log.debug("Session focus block unavailable", {
      error: formatError(error),
    });
    return "";
  }
}

/**
 * Render the block for an existing session-focus entry — its current content
 * bounded to `maxChars`, plus the update instruction when the agent holds
 * `memory_update`.
 *
 * @param input - The entry, the budget and the tool availability.
 * @returns The block, or `''` for an empty entry the agent cannot update.
 */
function renderEntryBlock(input: {
  entry: MemoryEntry;
  maxChars: number;
  canUpdate: boolean;
  updateTool: string;
  compactionTime: number | undefined;
}): string {
  const content = input.entry.content.trim();
  const stale = input.compactionTime !== undefined && updatedAtMs(input.entry) < input.compactionTime;
  const compactionAt = input.compactionTime === undefined ? "" : new Date(input.compactionTime).toISOString();
  if (!content) {
    // The entry exists but holds no content yet: name it so the agent fills
    // this one instead of creating a duplicate.
    if (!input.canUpdate) return "";
    const fill = `current goal; key facts and decisions; constraints and preferences; what needs attention now; open threads — concise, never the compaction summary or a transcript.`;
    return [
      "## Session focus",
      "",
      stale
        ? `Earlier history was compacted at ${compactionAt}; before continuing, fill the empty session-focus entry \`${input.entry.id}\` with ${input.updateTool}(id=${input.entry.id}): ${fill}`
        : `The session-focus entry \`${input.entry.id}\` is empty. Fill it with ${input.updateTool}(id=${input.entry.id}): ${fill}`,
    ].join("\n");
  }

  const block = ["## Session focus", "", truncateContent(content, input.maxChars)];
  if (input.canUpdate) {
    block.push(
      "",
      stale
        ? `Earlier history was compacted at ${compactionAt}; before continuing refresh this entry with ${input.updateTool}(id=${input.entry.id}) — keep what is still true, add what the compacted context still requires, drop resolved items; never paste the summary or transcript.`
        : `Update it with ${input.updateTool}(id=${input.entry.id}) when the goal, constraints or what needs attention changes.`,
    );
  }
  return block.join("\n");
}

/**
 * Render the create recipe shown while the session has no focus entry. A
 * compaction in the session log makes it urgent; otherwise it is stated as a
 * standing convention.
 *
 * @param input - Write tool name, session id, scope and compaction time.
 * @returns The block.
 */
function renderCreateBlock(input: {
  writeTool: string;
  sessionId: string;
  scope: "role" | "workspace";
  compactionTime: number | undefined;
}): string {
  const recipe = `write the single session-focus memory entry with ${input.writeTool}: title "${FOCUS_TITLE} — ${shortSession(input.sessionId)}", tags ["${FOCUS_TAG}"], category "note", relevance "high", scope "${input.scope}". Content: current goal; key facts and decisions; constraints and preferences; what needs attention now; open threads. Keep it concise — never the compaction summary or a transcript.`;
  return [
    "## Session focus",
    "",
    input.compactionTime === undefined
      ? `When this task has a goal, constraints or items worth carrying across compaction, ${recipe}`
      : `Earlier history was compacted at ${new Date(input.compactionTime).toISOString()}; before continuing, ${recipe}`,
  ].join("\n");
}

// ── Session log ─────────────────────────────────────────────────────────────

/**
 * Time (epoch ms) of the LAST `compaction/summary` event carrying a finite
 * time. The event's `data` (the summary) is never read.
 *
 * @param events - The session's event log.
 * @returns The epoch-ms time, or `undefined` when the session never compacted.
 */
function lastCompactionTime(events: readonly { type: string; data?: unknown }[]): number | undefined {
  let latest: number | undefined;
  for (const event of events) {
    if (event.type !== COMPACTION_SUMMARY_EVENT) continue;
    const time = "time" in event ? event.time : undefined;
    if (typeof time === "number" && Number.isFinite(time)) latest = time;
  }
  return latest;
}

/**
 * Find the most recently updated session-focus entry for a session, as
 * visible to the acting role. The store is opened and closed synchronously
 * (prompt assembly cannot await); a failure propagates to the fail-soft
 * renderer.
 *
 * @param directory - Absolute workspace directory.
 * @param sessionId - The dsh session the entry belongs to.
 * @param roleId - Acting role id; `''` restricts reads to workspace entries.
 * @returns The entry, or `undefined`.
 */
function readFocusEntry(directory: string, sessionId: string, roleId: string): MemoryEntry | undefined {
  const store = MemoryStore.open(directory);
  try {
    const entries = store.search({ query: FOCUS_TITLE, roleId, limit: 50 });
    let best: MemoryEntry | undefined;
    let bestUpdated = Number.NEGATIVE_INFINITY;
    for (const entry of entries) {
      if (entry.session_id !== sessionId) continue;
      if (!isFocusEntry(entry)) continue;
      if (best !== undefined && updatedAtMs(entry) <= bestUpdated) continue;
      best = entry;
      bestUpdated = updatedAtMs(entry);
    }
    return best;
  } finally {
    store.close();
  }
}

/** True when the entry carries the focus tag or the contractual title. */
function isFocusEntry(entry: MemoryEntry): boolean {
  return entry.tags.includes(FOCUS_TAG) || entry.title.toLowerCase().startsWith(FOCUS_TITLE_PREFIX);
}

/** Parse an entry's `updated_at`, treating an unparseable stamp as oldest. */
function updatedAtMs(entry: MemoryEntry): number {
  const parsed = Date.parse(entry.updated_at);
  return Number.isFinite(parsed) ? parsed : 0;
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

/** Resolve a tool's ACTUAL registered name. */
function toolName(names: ReadonlyMap<string, string>, name: string): string {
  return names.get(name) ?? name;
}

/** Clamp the configured content budget to a positive integer. */
function contentBudget(maxChars: number | undefined): number {
  return maxChars !== undefined && Number.isFinite(maxChars) && maxChars > 0
    ? Math.floor(maxChars)
    : DEFAULT_MAX_CHARS;
}

/** Truncate by code points and mark the cut. */
function truncateContent(content: string, maxChars: number): string {
  const points = Array.from(content);
  if (points.length <= maxChars) return content;
  return points.slice(0, maxChars).join("") + TRUNCATION_MARKER;
}

/**
 * Short session label used in the entry title.
 *
 * dsh session ids are `session-<uuid>` and the prefix alone is eight
 * characters, so slicing the raw id would make every create recipe read
 * `Session focus — session-` and no title unique. The prefix is stripped
 * first; only an id that is nothing but the prefix falls back to its raw
 * first characters.
 */
function shortSession(sessionId: string): string {
  const stripped = sessionId.startsWith(SESSION_ID_PREFIX)
    ? sessionId.slice(SESSION_ID_PREFIX.length)
    : sessionId;
  const source = stripped.length > 0 ? stripped : sessionId;
  return Array.from(source).slice(0, SHORT_SESSION_CHARS).join("");
}
