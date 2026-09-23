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
 *   (cwd, version, ...), append(type, data, opts), deriveMessages(),
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
import type { DshContentBlock } from "./agent-registrar.ts";
import type {
  SessionInfo,
  Message,
  FileDiff,
  Todo,
  SessionStatus,
} from "../../types.ts";

// ── Structural dsh session types ─────────────────────────────────────────────

/**
 * Structural `SessionEvent` from `@deepseek-ai/dsh-session` (§4.1).
 *
 * rc.6 models `time` as a REQUIRED top-level Unix-epoch-millisecond `number`
 * on the event envelope (`dsh-session/lib/types/types.d.ts:426`), stamped by
 * `append()` (`lib/index.js:1456`) — not a nested `{ created }` object and not
 * an optional `timestamp`/`at`. `seq` is required in rc.6 too, but stays
 * optional here because rolebox only reads it after a safe-integer guard.
 */
export interface DshSessionEventLike {
  readonly type: string;
  readonly seq?: number;
  readonly id?: string;
  readonly sessionID?: string;
  readonly data?: unknown;
  readonly time: number;
  readonly [key: string]: unknown;
}

/** Structural `Message` from `@deepseek-ai/dsh-llm` (§4.1). */
export interface DshMessageLike {
  readonly id: string;
  readonly role: string;
  readonly content: DshContentBlock[];
  readonly source?: unknown;
  readonly [key: string]: unknown;
}

/** Structural `Session` from `@deepseek-ai/dsh-session` (§4.1). */
export interface DshSessionLike {
  readonly id: string;
  readonly seq: number;
  readonly events: readonly DshSessionEventLike[];
  readonly header?: {
    readonly cwd?: string;
    /** On-disk format version (rc.6 `SessionHeader.version`, types.d.ts:46). */
    readonly version?: number;
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
    boundary?: number,
    childSessionId?: string,
  ): DshSessionLike;
  flush?(session: DshSessionLike): Promise<boolean>;
}

// ── Adapter implementation ───────────────────────────────────────────────────

/**
 * Optional per-session agent-delivery seam for {@link DshSessionAdapter.prompt}.
 *
 * dsh (DeepSeek Harness) has NO `prompt` on the SessionStore — prompting is
 * driven by the live agent loop, so rolebox's graph-notify reminders (which
 * are delivered through `ISessionClient.prompt`, the SAME path opencode/Pi
 * use) need a host-way in. On dsh that way is the live `Agent` surface
 * (`ctx.agents` → `AgentRegistry.get(sessionId)` → one of the agent's
 * delivery members), which this seam abstracts so the adapter stays SDK-free
 * (the dsh surface is consumed structurally against the shapes verified in
 * `docs/dsh-plugin-contract.md` §4.2 — the Agent signature is duck-typed).
 *
 * The plugin's injector selects the delivery member from `noReply`, matching
 * opencode/Pi semantics (`triggerTurn = !noReply`): `noReply: true` uses the
 * non-waking `inject` member only (:124-132 — queues model-facing context
 * WITHOUT waking an idle driver); `noReply: false` uses a WAKING member —
 * `steer` (rc.6 runtime-types.d.ts:116-123: an idle driver starts a turn; a
 * running driver consumes it at its next step boundary), then `followup`
 * (:110-115: queues an ordinary follow-up turn and wakes the driver);
 * `undefined` keeps the legacy best-effort preference (waking preferred,
 * `inject` fallback). A member the chosen mode requires but the agent does not
 * expose degrades to `null` rather than silently delivering with the wrong
 * wake behavior.
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
   *   session that owns the graph run this reminder reports on).
   * @param text      - The `<system-reminder>` body (contains the graph
   *   marker + agent). Already carries the resolved agent inline.
   * @param options   - Optional prompt metadata forwarded from
   *   `ISessionClient.prompt` (`agent`, `noReply`). `noReply` SELECTS the
   *   delivery member (see the interface docstring): `true` = non-waking
   *   `inject`, `false` = waking `steer`/`followup`, `undefined` = legacy
   *   best-effort.
   * @returns A message id (unique per injected message), or `null` when the
   *   session has no live agent / the required delivery member is absent, so
   *   the caller can degrade cleanly.
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

    const messageTimes = buildMessageTimes(session.events ?? []);
    // rc.6 `ToolResultBlock` has no `name` (types.d.ts:68-74); resolve the
    // label by pairing each result's `toolCallId` with its `tool-call`.
    const toolCallNames = buildToolCallNames(dshMessages);
    const messages = dshMessages.map((m) =>
      this.toMessage(m, id, messageTimes, toolCallNames),
    );
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
      // rc.6 declares `todo/write` data as `{ todos: TodoItem[] }`
      // (dsh-session/lib/types/types.d.ts:315-317). Anything else is ignored.
      if (!isRecord(data) || !Array.isArray(data.todos)) continue;
      for (const item of data.todos) {
        const todo = toTodo(item);
        if (todo) todos.push(todo);
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
   * it is resolved to the rc.6 fork boundary — the inclusive source event
   * `seq` of the event carrying that message id (`types/index.d.ts:413`;
   * `lib/index.js:1858-1861`). An id that matches no event is refused
   * (`null`) rather than silently forking at the source's last event.
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

    let boundary: number | undefined;
    if (options?.messageID !== undefined) {
      boundary = this.resolveBoundarySeq(source, options.messageID);
      if (boundary === undefined) {
        this._log.debug("fork() messageID did not resolve to an event seq", {
          id,
          messageID: options.messageID,
        });
        return null;
      }
    }

    try {
      const forked = this.store.fork(source, boundary);
      const info = this.toSessionInfo(forked, options?.directory);
      info.parentID = id;
      return info;
    } catch (err) {
      this._log.warn("fork() failed", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Create a new session via the dsh SessionStore.
   *
   * rc.6 folds `meta.cwd` / `meta.parentSession` into the persisted
   * `SessionHeader` (`types/types.d.ts:84-100`; `lib/index.js:1653-1663`); a
   * top-level `{directory}` is ignored. `directory` is therefore forwarded as
   * `meta.cwd` — so `header.cwd`, and thus `list(directory)` filtering, agree —
   * and `parentID` as `meta.parentSession` for durable lineage across reload.
   * Both are also recorded on the returned SessionInfo. Returns null when dsh
   * rejects creation.
   */
  async create(options: {
    directory: string;
    agent?: string;
    parentID?: string;
  }): Promise<SessionInfo | null> {
    this._log.debug("create() creating session", { options });
    try {
      const meta: { cwd?: string; parentSession?: string } = {};
      if (options.directory) meta.cwd = options.directory;
      if (options.parentID) meta.parentSession = options.parentID;
      const createOptions = Object.keys(meta).length > 0 ? { meta } : undefined;
      const session = this.store.create(undefined, createOptions);
      const info = this.toSessionInfo(session, options.directory);
      // Mirror the durable `header.parentSession` recorded above.
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
   * this routes the prompt's text into the target session's agent — the dsh
   * equivalent of opencode/Pi's `sessionClient.prompt` used by graph-notify to
   * deliver a `<system-reminder>` to the orchestrator. The injector selects the
   * delivery member from `options.noReply` (matching opencode/Pi
   * `triggerTurn = !noReply`): `true` uses the non-waking `inject` member,
   * `false` uses a waking `steer`/`followup` member, `undefined` keeps the
   * legacy best-effort preference (rc.6 runtime-types.d.ts:110-132).
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

  /**
   * Resolve a rolebox message id to the rc.6 fork boundary — the inclusive
   * source event `seq` of the event that carries that message. rc.6 `fork`
   * takes a numeric seq, not a message id (`types/index.d.ts:413`;
   * `lib/index.js:1858-1861`), so a caller's `messageID` must be mapped
   * through the event log first. Scans the REAL rc.6 event data shapes
   * (`types/types.d.ts:262,278,306`):
   *
   *   - `user/message`      → `data.id`
   *   - `assistant/message` → `data.message.id`
   *   - `tool/result`       → `data.message.id`
   *
   * @returns The matching event's `seq`, or `undefined` when no event carries
   *   the given message id (the caller decides how to degrade).
   */
  private resolveBoundarySeq(
    session: DshSessionLike,
    messageID: string,
  ): number | undefined {
    for (const evt of session.events) {
      let id: unknown;
      if (evt.type === "user/message") {
        id = isRecord(evt.data) ? evt.data.id : undefined;
      } else if (evt.type === "assistant/message" || evt.type === "tool/result") {
        const data = isRecord(evt.data) ? evt.data : {};
        const message = isRecord(data.message) ? data.message : {};
        id = message.id;
      } else {
        continue;
      }
      if (
        id === messageID &&
        typeof evt.seq === "number" &&
        Number.isSafeInteger(evt.seq) &&
        evt.seq >= 0
      ) {
        return evt.seq;
      }
    }
    return undefined;
  }

  /** True when the session's `header.cwd` matches the given directory. */
  private matchesDirectory(session: DshSessionLike, directory: string): boolean {
    const cwd = session.header?.cwd;
    if (typeof cwd !== "string") return false;
    return stripTrailingSep(cwd) === stripTrailingSep(directory);
  }

  /**
   * Map a dsh Session into a rolebox SessionInfo. Title is derived from the
   * first user message text; `time` is the min/max event `time` (rc.6 stamps
   * every event with a required top-level `time: number`).
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
        header && typeof header.version === "number"
          ? String(header.version)
          : "1.0",
      time: { created, updated },
    };
  }

  /**
   * Map a dsh Message into a rolebox `{ info, parts }` message.
   *
   * Message time is taken from the owning session event's `time` (via
   * `messageTimes`), because rc.6 `Message` carries no `timestamp` and no
   * source `time` (`dsh-llm/lib/types/message.d.ts:120-128`). A message id
   * absent from the event log (e.g. a synthetic/derived message) gets `0` —
   * there is no reliable timestamp to fall back to, and inventing `Date.now()`
   * would silently fabricate a time.
   */
  private toMessage(
    dshMessage: DshMessageLike,
    sessionID: string,
    messageTimes: ReadonlyMap<string, number>,
    toolCallNames: ReadonlyMap<string, string>,
  ): Message {
    const info: Message["info"] = {
      id: dshMessage.id,
      sessionID,
      role: dshMessage.role === "assistant" ? "assistant" : "user",
      time: { created: messageTimes.get(dshMessage.id) ?? 0 },
    };

    // Best-effort metadata from the dsh message `source`. rc.6 model messages
    // carry `provider`/`model` (`dsh-llm/lib/types/message.d.ts:15-24`); no
    // message source has `agent`, so `info.agent` is intentionally unset.
    const source = isRecord(dshMessage.source) ? dshMessage.source : undefined;
    if (source) {
      if (typeof source.model === "string") info.modelID = source.model;
      if (typeof source.provider === "string") info.providerID = source.provider;
    }

    const parts = (dshMessage.content ?? []).map((block, index) =>
      this.toPart(block, sessionID, dshMessage.id, index, toolCallNames),
    );
    return { info, parts };
  }

  /**
   * Map a dsh ContentBlock into a rolebox message Part.
   *
   * A `tool-call` block's `arguments` is a raw JSON string and is parsed into
   * the part's `state.input`. A `tool-result` block has no `name` in rc.6, so
   * its label is resolved by pairing `toolCallId` against the `tool-call`
   * blocks in the same derived message set (`toolCallNames`); an unpaired
   * result is labeled `"unknown"`.
   */
  private toPart(
    block: DshContentBlock,
    sessionID: string,
    messageID: string,
    index: number,
    toolCallNames: ReadonlyMap<string, string>,
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
      case "tool-call": {
        // rc.6 `ToolCallBlock.arguments` is a RAW JSON STRING as produced by
        // the model (`dsh-llm/lib/types/types.d.ts:59-66`). Parse it; a
        // malformed or non-object payload degrades to `{}` and never throws.
        let input: Record<string, unknown> = {};
        if (typeof block.arguments === "string") {
          try {
            const parsed: unknown = JSON.parse(block.arguments);
            if (isRecord(parsed)) {
              input = parsed;
            } else {
              this._log.debug(
                "toPart() tool-call arguments parsed to a non-object; using empty input",
                { id, raw: block.arguments.slice(0, 200) },
              );
            }
          } catch {
            this._log.debug(
              "toPart() failed to parse tool-call arguments JSON; using empty input",
              { id, raw: block.arguments.slice(0, 200) },
            );
          }
        }
        return {
          id,
          sessionID,
          messageID,
          type: "tool",
          callID: block.id ?? id,
          tool: block.name ?? "unknown",
          state: {
            status: "running",
            input,
          },
        };
      }
      case "tool-result": {
        // rc.6 `ToolResultBlock` carries only `toolCallId` and NO `name`
        // (`dsh-llm/lib/types/types.d.ts:68-74`). Recover the label by pairing
        // `toolCallId` with the matching `tool-call`; unpaired → "unknown".
        const callID = block.toolCallId ?? block.id ?? id;
        const tool =
          (typeof block.toolCallId === "string"
            ? toolCallNames.get(block.toolCallId)
            : undefined) ?? "unknown";
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
 *
 * rc.6 `user/message` data IS the `UserMessage` — `content` is TOP-LEVEL on
 * `data` (`dsh-session/lib/types/types.d.ts:262`; `dsh-llm/lib/types/
 * message.d.ts:120-137`), NOT nested under `data.message`. (Only
 * `assistant/message` and `tool/result` nest the message under `data.message`.)
 */
function deriveTitle(
  events: readonly DshSessionEventLike[],
): string | undefined {
  for (const evt of events) {
    if (evt.type !== "user/message") continue;
    const data = isRecord(evt.data) ? evt.data : {};
    const content = data.content;
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
 * The session's created/updated timestamps — the min and max event `time` in
 * the log. rc.6 `SessionEvent.time` is a required top-level Unix-epoch-
 * millisecond `number` (`dsh-session/lib/types/types.d.ts:426`) stamped by
 * `append()` (`lib/index.js:1456`), so the log is authoritative. Only a
 * genuinely empty (or otherwise unusable) log falls back to the current time.
 */
function deriveTimes(
  events: readonly DshSessionEventLike[],
): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const evt of events) {
    const time = evt.time;
    if (typeof time !== "number" || !Number.isFinite(time)) continue;
    if (time < min) min = time;
    if (time > max) max = time;
  }
  if (min === Infinity) {
    const now = Date.now();
    return [now, now];
  }
  return [min, max];
}

/**
 * Map each dsh message id to the `time` of the session event that owns it, so
 * `toMessage` can stamp a real timestamp (rc.6 `Message` has no timestamp of
 * its own). Scans the rc.6 event data shapes (`types/types.d.ts:262,278,306`),
 * the same shapes {@link resolveBoundarySeq} reads:
 *
 *   - `user/message`      → `data.id`
 *   - `assistant/message` → `data.message.id`
 *   - `tool/result`       → `data.message.id`
 *
 * The first event wins when a message id appears more than once. Ids absent
 * from the log are simply not present in the returned map.
 */
function buildMessageTimes(
  events: readonly DshSessionEventLike[],
): Map<string, number> {
  const times = new Map<string, number>();
  for (const evt of events) {
    let id: unknown;
    if (evt.type === "user/message") {
      id = isRecord(evt.data) ? evt.data.id : undefined;
    } else if (evt.type === "assistant/message" || evt.type === "tool/result") {
      const data = isRecord(evt.data) ? evt.data : {};
      const message = isRecord(data.message) ? data.message : {};
      id = message.id;
    } else {
      continue;
    }
    if (typeof id === "string" && !times.has(id)) {
      times.set(id, evt.time);
    }
  }
  return times;
}

/**
 * Build a `toolCallId → tool name` map from every `tool-call` block across the
 * derived message set. rc.6 `ToolResultBlock` carries only `toolCallId` and no
 * `name` (`dsh-llm/lib/types/types.d.ts:68-74`), so
 * {@link DshSessionAdapter.toPart} uses this to label a `tool-result` part with
 * the name of the tool call it answers. The first name wins when a call id
 * appears more than once; calls without a string id are skipped.
 */
function buildToolCallNames(
  messages: readonly DshMessageLike[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (
        block.type === "tool-call" &&
        typeof block.id === "string" &&
        typeof block.name === "string" &&
        !names.has(block.id)
      ) {
        names.set(block.id, block.name);
      }
    }
  }
  return names;
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
