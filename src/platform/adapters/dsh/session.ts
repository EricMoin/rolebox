/**
 * DshSessionAdapter — ISessionClient adapter over the dsh session service
 * (`ctx.sessions`, a `SessionStore` from `@deepseek-ai/dsh-session`).
 *
 * Verified dsh surface (`docs/dsh-plugin-contract.md` §4.1):
 *
 *   SessionStore: create(id?, options?) → Session | prepare(id?, options?) →
 *   Session | enter(session) | announce(session) | flush(session) |
 *   get(id) → Session | undefined | list() → Session[] |
 *   fork(source, boundary?, childSessionId?) → Session
 *
 *   Session: id, seq, events (readonly SessionEvent[]), surface, header
 *   (cwd, formatVersion, ...), append(type, data, opts), deriveMessages(),
 *   requestHeader(), requestContext()
 *
 * Mapping notes:
 *
 *   - `list(directory)` filters sessions whose `header.cwd` matches the
 *     directory (dsh sessions are global — ids are not directory-scoped).
 *   - `messages` maps `deriveMessages()` dsh messages
 *     (`{ id, role, content: ContentBlock[], source }`) into rolebox
 *     `{ info, parts }` messages; ContentBlocks become text/reasoning/tool
 *     parts.
 *   - `todo` / `diff` are extracted best-effort from the session event log
 *     (`todo/write` and `tool/result` events).
 *   - `status` is derived from the event log (`turn/start` / `turn/end`).
 *
 * Unsupported operations (dsh has no equivalent on this surface — each is a
 * documented graceful degradation, matching the Pi adapter's approach):
 *
 *   - `prompt` / `promptSync` — prompting is driven by the dsh agent loop
 *     (`ctx.agents` / agent inbox), not the SessionStore; return null.
 *   - `abort` — cancellation lives on `Agent.cancel(...)`, not the
 *     SessionStore; return false.
 *   - `compact` — dsh compaction is a data-level `surfaceOp: 'replace'`
 *     append on the session log, not an API; return false.
 *   - `children` — subagent child sessions are listed through
 *     `ctx.subagents.listChildren`, not the SessionStore; return [].
 *
 * The dsh session service is consumed structurally (duck-typed). This module
 * does NOT import `@deepseek-ai/dsh-session` or any `@deepseek-ai/*` package,
 * and MUST NOT import from `@opencode-ai/*`.
 *
 * @module
 */

import type { Logger } from "tslog";
import type { ILogObj } from "tslog";
import { randomUUID } from "node:crypto";
import { createSubLogger } from "../../../logger.ts";
import type { ISessionClient } from "../../ports/session-client.ts";
import type {
  SessionInfo,
  Message,
  FileDiff,
  Todo,
  SessionStatus,
} from "../../types.ts";

// ── Structural dsh session types ─────────────────────────────────────────────

/** Structural `SessionEvent` from `@deepseek-ai/dsh-session` (§4.1). */
export interface DshSessionEventLike {
  readonly type: string;
  readonly seq?: number;
  readonly id?: string;
  readonly sessionID?: string;
  readonly data?: unknown;
  readonly timestamp?: number;
  readonly at?: number;
  readonly time?: { created?: number };
  readonly [key: string]: unknown;
}

/** Structural `ContentBlock` from `@deepseek-ai/dsh-llm` (§3.4). */
export interface DshContentBlockLike {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: unknown;
  readonly toolCallId?: string;
  /** Nested blocks (tool-result content). */
  readonly content?: unknown;
  readonly isError?: boolean;
  readonly [key: string]: unknown;
}

/** Structural `Message` from `@deepseek-ai/dsh-llm` (§4.1). */
export interface DshMessageLike {
  readonly id: string;
  readonly role: string;
  readonly content: DshContentBlockLike[];
  readonly source?: unknown;
  readonly timestamp?: number;
  readonly [key: string]: unknown;
}

/** Structural `Session` from `@deepseek-ai/dsh-session` (§4.1). */
export interface DshSessionLike {
  readonly id: string;
  readonly seq: number;
  readonly events: readonly DshSessionEventLike[];
  readonly header?: {
    readonly cwd?: string;
    readonly formatVersion?: number;
    readonly [key: string]: unknown;
  };
  append(
    type: string,
    data: unknown,
    opts?: Record<string, unknown>,
  ): DshSessionEventLike;
  deriveMessages(): DshMessageLike[];
  readonly [key: string]: unknown;
}

/** Structural `SessionStore` from `@deepseek-ai/dsh-session` (§4.1). */
export interface DshSessionStoreLike {
  create(
    id?: string,
    options?: Record<string, unknown>,
  ): DshSessionLike;
  get(id: string): DshSessionLike | undefined;
  list(): DshSessionLike[];
  fork(
    source: DshSessionLike,
    boundary?: unknown,
    childSessionId?: string,
  ): DshSessionLike;
  flush?(session: DshSessionLike): Promise<boolean>;
}

// ── Adapter implementation ───────────────────────────────────────────────────

/**
 * Optional per-session agent-injection seam for {@link DshSessionAdapter.prompt}.
 *
 * dsh (DeepSeek Harness) has NO `prompt` on the SessionStore — prompting is
 * driven by the live agent loop, so rolebox's graph-notify reminders (which
 * are delivered through `ISessionClient.prompt`, the SAME path opencode/Pi
 * use) need a host-way in. On dsh that way is the live `Agent` surface
 * (`ctx.agents` → `AgentRegistry.get(sessionId)` → `Agent.inject`), which this
 * seam abstracts so the adapter stays SDK-free (the dsh surface is consumed
 * structurally against the shapes verified in `docs/dsh-plugin-contract.md`
 * §4.2 — the Agent signature is duck-typed).
 *
 * When the plugin provides an injector (wired from an optional `ctx.agents`
 * probe — the service may be absent in minimal/headless profiles), `prompt()`
 * routes the reminder into the target session's live agent. Absent → the
 * adapter keeps its documented no-op (returns `null`), and the graph engine's
 * F6 notifier logs the degraded reminder instead of crashing. This is
 * intentionally BEST-EFFORT: the `GraphNotifySource` config is wired on the
 * dsh path, but a session with no live agent (or a host without `ctx.agents`)
 * degrades to the same silent-drop marker the engine already records for a
 * missing emperor session, never a crash.
 */
export interface DshPromptInjector {
  /**
   * Inject a text reminder into a session's live agent.
   *
   * @param sessionId - The target dsh session id (the emperor/orchestrator
   *   session that drove `graph_run`, per the graph-notify owner-targeting).
   * @param text      - The `<system-reminder>` body (contains the graph
   *   marker + agent). Already carries the resolved agent inline.
   * @param options   - Optional prompt metadata forwarded from
   *   `ISessionClient.prompt` (`agent`, `noReply`); consumed as advisory.
   * @returns A message id, or `null` when the session has no live agent / the
   *   injection is unsupported, so the caller can degrade cleanly.
   */
  inject(
    sessionId: string,
    text: string,
    options?: { agent?: string; noReply?: boolean },
  ): Promise<{ id: string } | null>;
}

/** Options for constructing a {@link DshSessionAdapter}. */
export interface DshSessionAdapterOptions {
  /** Optional logger name override. */
  loggerName?: string;
  /**
   * Optional agent-injection seam (see {@link DshPromptInjector}). When
   * present, `prompt()` routes graph-notify reminders into the target session's
   * live agent; absent, `prompt()` keeps its documented no-op.
   */
  promptInjector?: DshPromptInjector;
}

/**
 * ISessionClient adapter for the dsh platform, backed by a structural
 * `SessionStore` (the `ctx.sessions` service).
 */
export class DshSessionAdapter implements ISessionClient {
  private readonly _log: Logger<ILogObj>;
  private readonly _promptInjector?: DshPromptInjector;

  /**
   * @param store   - The dsh `SessionStore` service (`ctx.sessions`).
   * @param options - Optional logger name override + agent-injection seam.
   */
  constructor(
    public readonly store: DshSessionStoreLike,
    options?: DshSessionAdapterOptions,
  ) {
    this._log = createSubLogger(options?.loggerName ?? "dsh-session");
    this._promptInjector = options?.promptInjector;
  }

  // ── Read methods ─────────────────────────────────────────────────────────

  /**
   * List sessions, optionally filtered to a working directory.
   * dsh sessions are global; when `directory` is provided only sessions whose
   * `header.cwd` matches it are returned.
   */
  async list(directory?: string): Promise<SessionInfo[]> {
    const sessions = this.store.list();
    const infos = sessions
      .filter(
        (s) => directory === undefined || this.matchesDirectory(s, directory),
      )
      .map((s) => this.toSessionInfo(s, directory));
    infos.sort((a, b) => b.time.created - a.time.created);
    this._log.debug("list() returning sessions", { count: infos.length });
    return infos;
  }

  /**
   * Get a single session by ID. dsh session ids are global, so `directory`
   * is ignored for lookup (it only labels the returned SessionInfo).
   */
  async get(
    id: string,
    directory?: string,
  ): Promise<SessionInfo | null> {
    this._log.debug("get() looking up session", { id });
    const session = this.store.get(id);
    if (!session) return null;
    return this.toSessionInfo(session, directory);
  }

  /**
   * Get messages for a session by mapping `deriveMessages()` into rolebox
   * `{ info, parts }` messages. ContentBlocks become text / reasoning / tool
   * parts. Unparseable sessions return [].
   */
  async messages(
    id: string,
    options?: { directory?: string; limit?: number },
  ): Promise<Message[]> {
    const session = this.store.get(id);
    if (!session) return [];

    let dshMessages: DshMessageLike[];
    try {
      dshMessages = session.deriveMessages();
    } catch (err) {
      this._log.debug("deriveMessages() failed", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    const messages = dshMessages.map((m) => this.toMessage(m, id));
    if (options?.limit && options.limit > 0) {
      return messages.slice(0, options.limit);
    }
    return messages;
  }

  /**
   * Get child sessions — unsupported on the dsh SessionStore.
   * Subagent child sessions are listed through `ctx.subagents.listChildren`
   * (a different service), so this always returns [].
   */
  async children(
    _id: string,
    _directory?: string,
  ): Promise<SessionInfo[]> {
    this._log.debug("children() is unsupported on dsh SessionStore — returning []");
    return [];
  }

  /**
   * Get todo items by scanning the session event log for `todo/write` events
   * (`dsh-plugin-contract.md` §4.1 log-only event types).
   */
  async todo(
    id: string,
    _directory?: string,
  ): Promise<Todo[]> {
    const session = this.store.get(id);
    if (!session) return [];

    const todos: Todo[] = [];
    for (const evt of session.events) {
      if (evt.type !== "todo/write") continue;
      const data = evt.data;
      if (Array.isArray(data)) {
        for (const item of data) {
          const todo = toTodo(item);
          if (todo) todos.push(todo);
        }
      } else if (isRecord(data)) {
        const todo = toTodo(data);
        if (todo) todos.push(todo);
        if (Array.isArray(data.items)) {
          for (const item of data.items) {
            const nested = toTodo(item);
            if (nested) todos.push(nested);
          }
        }
      }
    }
    return todos;
  }

  /**
   * Get file diffs by scanning `tool/result` events and parsing their
   * tool-result text output for JSON `{ file, before, after, ... }` entries
   * (mirrors the Pi adapter's diff extraction).
   */
  async diff(
    id: string,
    options?: { directory?: string; messageID?: string },
  ): Promise<FileDiff[]> {
    const session = this.store.get(id);
    if (!session) return [];

    const diffs: FileDiff[] = [];
    for (const evt of session.events) {
      if (evt.type !== "tool/result") continue;
      const data = isRecord(evt.data) ? evt.data : {};
      const message = isRecord(data.message) ? data.message : {};
      const content = message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!isRecord(block) || block.type !== "tool-result") continue;
        collectDiffsFromText(extractBlockText(block.content), diffs);
      }
    }

    // Deduplicate by file path.
    const seen = new Set<string>();
    return diffs.filter((d) => {
      if (seen.has(d.file)) return false;
      seen.add(d.file);
      return true;
    });
  }

  /**
   * Get the status of a session, derived from its event log: the last
   * `turn/start`/`turn/end` pair decides `busy` vs `idle`. Unknown sessions
   * return null.
   */
  async status(
    id: string,
    _directory?: string,
  ): Promise<SessionStatus | null> {
    const session = this.store.get(id);
    if (!session) return null;

    let lastStart = -1;
    let lastEnd = -1;
    session.events.forEach((e, i) => {
      if (e.type === "turn/start") lastStart = i;
      if (e.type === "turn/end") lastEnd = i;
    });

    // No turn recorded at all → idle (nothing in flight).
    if (lastStart === -1) return { type: "idle" };
    return lastEnd > lastStart ? { type: "idle" } : { type: "busy" };
  }

  // ── Mutation methods ──────────────────────────────────────────────────────

  /**
   * Fork a session. The new session's id is assigned by dsh; the fork's
   * `parentID` is set to the source id. When `options.messageID` is provided
   * it is passed as the fork boundary (best-effort — the exact boundary
   * shape is dsh-internal).
   */
  async fork(
    id: string,
    options?: { directory?: string; messageID?: string },
  ): Promise<SessionInfo | null> {
    this._log.debug("fork() forking session", { id, options });
    const source = this.store.get(id);
    if (!source) {
      this._log.debug("fork() source session not found", { id });
      return null;
    }

    try {
      const boundary =
        options?.messageID !== undefined
          ? { messageID: options.messageID }
          : undefined;
      const forked = this.store.fork(source, boundary);
      const info = this.toSessionInfo(forked, options?.directory);
      info.parentID = id;
      return info;
    } catch (err) {
      this._log.debug("fork() failed", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Create a new session via the dsh SessionStore. `directory` is forwarded
   * to `create()` as an options entry (best-effort passthrough to the
   * unverified `CreateSessionOptions` surface) and recorded on the returned
   * SessionInfo. Returns null when dsh rejects creation.
   */
  async create(options: {
    directory: string;
    agent?: string;
    parentID?: string;
  }): Promise<SessionInfo | null> {
    this._log.debug("create() creating session", { options });
    try {
      const createOptions = options.directory
        ? { directory: options.directory }
        : undefined;
      const session = this.store.create(undefined, createOptions);
      const info = this.toSessionInfo(session, options.directory);
      // dsh `create` has no parent link; record the requested parent
      // informatively so the caller can trace lineage.
      if (options.parentID) info.parentID = options.parentID;
      return info;
    } catch (err) {
      this._log.debug("create() failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Abort a running session — unsupported on the dsh SessionStore.
   * dsh cancellation lives on the agent (`Agent.cancel(cause, opts)`), which
   * is not reachable through this surface; return false.
   */
  async abort(_id: string): Promise<boolean> {
    this._log.debug("abort() is unsupported on dsh SessionStore — returning false");
    return false;
  }

  /**
   * Compact a session's context — unsupported. dsh compaction is a
   * data-level `surfaceOp: 'replace'` append on the session log, not a
   * SessionStore API; return false.
   */
  async compact(_id: string): Promise<boolean> {
    this._log.debug("compact() is unsupported on dsh SessionStore — returning false");
    return false;
  }

  /**
   * Prompt a session asynchronously (fire-and-forget).
   *
   * The dsh SessionStore has no `prompt`: prompting is driven by the live
   * agent loop. When the adapter was constructed with a {@link DshPromptInjector}
   * (the plugin wires one from the optional `ctx.agents` live-agent registry),
   * this routes the prompt's text into the target session's agent via
   * `Agent.inject` — the dsh equivalent of opencode/Pi's `sessionClient.prompt`
   * used by graph-notify to deliver a `<system-reminder>` to the orchestrator.
   *
   * No injector (or an injection that fails / finds no live agent) degrades
   * cleanly: the reminder is dropped the same way a missing emperor session is
   * dropped (the graph engine's F6 notifier logs a degraded marker), and the
   * adapter returns `null` to signal the caller no prompt was enqueued.
   */
  async prompt(
    id: string,
    options: {
      parts: Array<{ type: string; text: string }>;
      noReply?: boolean;
      system?: string;
      agent?: string;
      model?: { providerID: string; modelID: string };
      fromLoop?: boolean;
    },
  ): Promise<{ id: string } | null> {
    if (this._promptInjector) {
      const text = (options.parts ?? [])
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .join("");
      if (text) {
        try {
          const result = await this._promptInjector.inject(id, text, {
            agent: options.agent,
            noReply: options.noReply,
          });
          if (result) {
            this._log.debug("prompt() injected via dsh agent seam", { id });
            return result;
          }
        } catch (err) {
          this._log.debug("prompt() injector failed", {
            id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    this._log.debug("prompt() is unsupported on dsh SessionStore — returning null");
    return null;
  }

  /**
   * Prompt a session synchronously — unsupported (see `prompt`); return null.
   */
  async promptSync(
    _id: string,
    _options: {
      parts: Array<{ type: string; text: string }>;
      agent?: string;
      signal?: AbortSignal;
    },
  ): Promise<{ parts: Array<{ type: string; text?: string }> } | null> {
    this._log.debug("promptSync() is unsupported on dsh SessionStore — returning null");
    return null;
  }

  // ── Mapping helpers ───────────────────────────────────────────────────────

  /** True when the session's `header.cwd` matches the given directory. */
  private matchesDirectory(session: DshSessionLike, directory: string): boolean {
    const cwd = session.header?.cwd;
    if (typeof cwd !== "string") return false;
    return stripTrailingSep(cwd) === stripTrailingSep(directory);
  }

  /**
   * Map a dsh Session into a rolebox SessionInfo. Title is derived from the
   * first user message text; timestamps are best-effort extractions from the
   * event log (dsh events do not guarantee timestamps).
   */
  private toSessionInfo(
    session: DshSessionLike,
    directory?: string,
  ): SessionInfo {
    const header = isRecord(session.header) ? session.header : undefined;
    const cwd =
      header && typeof header.cwd === "string" ? header.cwd : undefined;
    const dir = directory ?? cwd ?? session.id;
    const events = session.events ?? [];
    const title = deriveTitle(events) ?? session.id;
    const [created, updated] = deriveTimes(events);

    return {
      id: session.id,
      projectID: dir,
      directory: dir,
      summary: { additions: 0, deletions: 0, files: 0, diffs: [] },
      title,
      version:
        header && typeof header.formatVersion === "number"
          ? String(header.formatVersion)
          : "1.0",
      time: { created, updated },
    };
  }

  /** Map a dsh Message into a rolebox `{ info, parts }` message. */
  private toMessage(dshMessage: DshMessageLike, sessionID: string): Message {
    const info: Message["info"] = {
      id: dshMessage.id,
      sessionID,
      role: dshMessage.role === "assistant" ? "assistant" : "user",
      time: { created: extractMessageTime(dshMessage) },
    };

    // Best-effort metadata from the dsh message `source`.
    const source = isRecord(dshMessage.source) ? dshMessage.source : undefined;
    if (source) {
      if (typeof source.agent === "string") info.agent = source.agent;
      if (typeof source.model === "string") info.modelID = source.model;
      if (typeof source.provider === "string") info.providerID = source.provider;
    }

    const parts = (dshMessage.content ?? []).map((block, index) =>
      this.toPart(block, sessionID, dshMessage.id, index),
    );
    return { info, parts };
  }

  /** Map a dsh ContentBlock into a rolebox message Part. */
  private toPart(
    block: DshContentBlockLike,
    sessionID: string,
    messageID: string,
    index: number,
  ): Message["parts"][number] {
    const id =
      typeof block.id === "string" ? block.id : `${messageID}-part-${index}`;

    switch (block.type) {
      case "text":
        return { id, sessionID, messageID, type: "text", text: block.text ?? "" };
      case "reasoning":
        return {
          id,
          sessionID,
          messageID,
          type: "reasoning",
          text: block.text ?? "",
          time: { start: 0 },
        };
      case "tool-call":
        return {
          id,
          sessionID,
          messageID,
          type: "tool",
          callID: block.id ?? id,
          tool: block.name ?? "unknown",
          state: {
            status: "running",
            input: isRecord(block.arguments) ? block.arguments : {},
          },
        };
      case "tool-result": {
        const callID = block.toolCallId ?? block.id ?? id;
        const tool = typeof block.name === "string" ? block.name : "unknown";
        const output = extractBlockText(block.content);
        const base = { id, sessionID, messageID, type: "tool" as const, callID, tool };
        if (block.isError) {
          return {
            ...base,
            state: {
              status: "error",
              error: output || "tool failed",
              time: { start: 0, end: 0 },
            },
          };
        }
        return {
          ...base,
          state: {
            status: "completed",
            input: {},
            output,
            title: tool,
            metadata: {},
            time: { start: 0, end: 0 },
          },
        };
      }
      default:
        return { id, sessionID, messageID, type: block.type || "unknown" };
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Structural record guard. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip trailing path separators for directory comparison. */
function stripTrailingSep(p: string): string {
  return p.replace(/[\\/]+$/, "");
}

/**
 * Derive a session title from the first user message text in the event log.
 * Mirrors the Pi adapter's title heuristic (slice 80 chars, newlines → space).
 */
function deriveTitle(
  events: readonly DshSessionEventLike[],
): string | undefined {
  for (const evt of events) {
    if (evt.type !== "user/message") continue;
    const data = isRecord(evt.data) ? evt.data : {};
    const message = isRecord(data.message) ? data.message : {};
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.trim().length > 0
      ) {
        const text = block.text.replace(/\n/g, " ").trim().slice(0, 80);
        if (text) return text;
      }
    }
  }
  return undefined;
}

/**
 * Best-effort created/updated timestamps from the event log. dsh events do
 * not guarantee timestamps; falls back to the current time.
 */
function deriveTimes(
  events: readonly DshSessionEventLike[],
): [number, number] {
  const stamps: number[] = [];
  for (const evt of events) {
    if (typeof evt.timestamp === "number") stamps.push(evt.timestamp);
    else if (typeof evt.at === "number") stamps.push(evt.at);
    else if (isRecord(evt.time) && typeof evt.time.created === "number") {
      stamps.push(evt.time.created);
    }
  }
  if (stamps.length === 0) {
    const now = Date.now();
    return [now, now];
  }
  return [Math.min(...stamps), Math.max(...stamps)];
}

/** Best-effort created timestamp for a dsh message. */
function extractMessageTime(message: DshMessageLike): number {
  if (typeof message.timestamp === "number") return message.timestamp;
  const source = isRecord(message.source) ? message.source : undefined;
  if (source && typeof source.time === "number") return source.time;
  return Date.now();
}

/** Extract plain text from a ContentBlock `content` bag (string or blocks). */
function extractBlockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (isRecord(b) && typeof b.text === "string" ? b.text : ""))
      .join("");
  }
  return "";
}

/** Map an unknown todo-ish value into a rolebox Todo, or undefined. */
function toTodo(value: unknown): Todo | undefined {
  if (!isRecord(value) || typeof value.content !== "string") return undefined;
  return {
    content: value.content,
    status: typeof value.status === "string" ? value.status : "pending",
    priority: typeof value.priority === "string" ? value.priority : "medium",
    id:
      typeof value.id === "string"
        ? value.id
        : typeof value.todoId === "string"
          ? value.todoId
          : randomUUID(),
  };
}

/**
 * Parse tool-result text for JSON `{ file, before, after, additions,
 * deletions }` entries and append them to `diffs`.
 */
function collectDiffsFromText(text: string, diffs: FileDiff[]): void {
  if (!text) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return; // Not JSON — not a structured diff.
  }
  if (!Array.isArray(parsed)) return;
  for (const item of parsed) {
    if (!isRecord(item) || typeof item.file !== "string") continue;
    diffs.push({
      file: item.file,
      before: typeof item.before === "string" ? item.before : "",
      after: typeof item.after === "string" ? item.after : "",
      additions: typeof item.additions === "number" ? item.additions : 0,
      deletions: typeof item.deletions === "number" ? item.deletions : 0,
    });
  }
}
