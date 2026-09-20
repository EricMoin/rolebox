/**
 * DshEventBridge — IEventBridge adapter for the dsh (DeepSeek Harness) platform.
 *
 * Bridges dsh's cordis event bus (`ctx.on` / `ctx.emit`) plus the dsh
 * session/tools service events into CanonicalEvents, following the same
 * pattern as PiEventBridge on the Pi side.
 *
 * Subscribed dsh events (verified against `docs/dsh-plugin-contract.md`):
 *
 *   - session service (`@deepseek-ai/dsh-session`, §4.1):
 *     `session/created`, `session/disposed`, `session/event`, `session/flush`
 *   - tools service (`@deepseek-ai/dsh-tools`, §3.5):
 *     `tools/result` (frozen final outcome), `tools/change` (registry change)
 *   - skill service (`@deepseek-ai/dsh-skill`):
 *     `skills/change` (unfiltered catalog-invalidation notification)
 *
 * `tools/pre-execute` / `tools/post-execute` are deliberately NOT bridged
 * here — those are the tool lifecycle extension points owned by
 * DshHookProvider (hook-provider.ts), which maps rolebox `tool-before` /
 * `tool-after` onto them.
 *
 * `session/event` carries per-event `SessionEvent` payloads whose own `type`
 * field (e.g. `user/message`, `turn/end`, `todo/write`) refines the canonical
 * mapping; the raw sub-type is preserved as `rawType`.
 *
 * The cordis ctx is consumed structurally (duck-typed) and the dsh payload shapes
 * are structural too. `@deepseek-ai/*` is imported type-only — the cordis `Events`
 * interface and the `declare module` augmentations that extend it — so those imports
 * erase at build time. This module MUST NOT value-import `@deepseek-ai/*` and MUST
 * NOT import from `@opencode-ai/*`.
 *
 * @module
 */

import type { Logger } from "tslog";
import type { ILogObj } from "tslog";
import type { Events } from "@deepseek-ai/cordis";
// Type-only service imports: each package ships a `declare module "@deepseek-ai/cordis"`
// augmentation adding its own events to `Events`. Importing them (erased at runtime) is what
// makes the bus-level table and the subscription lists below compiler-checked.
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-skill";
import type {} from "@deepseek-ai/dsh-tools";
import { createSubLogger } from "../../../logger.ts";
import type {
  CanonicalEvent,
  CanonicalEventHandler,
  CanonicalEventType,
  IEventBridge,
} from "../../ports/event-bridge.ts";

// ── Structural cordis ctx surface ────────────────────────────────────────────

/**
 * Minimal structural surface of a cordis `Context` event bus.
 *
 * Only `on` / `emit` are required — the two event operations the bridge uses
 * (cordis `Context` proxies both to its `EventsService`; see
 * `dsh-plugin-contract.md` §2.5). `on` returns a disposer, matching cordis.
 *
 * The event name stays `string` on purpose: this is the generic bus surface, which must
 * accept any structural host ctx. Vocabulary narrowing belongs at the call sites — here via
 * {@link DSH_SESSION_EVENTS} and in hook-provider.ts via its `keyof Events` mapping table.
 */
export interface DshCordisContext {
  /** Subscribe to a cordis/dsh event. Returns an unsubscribe disposer. */
  on(event: string, listener: (...args: unknown[]) => void): (() => void) | void;
  /** Emit a cordis/dsh event. */
  emit(event: string, ...args: unknown[]): void;
}

// ── dsh-to-canonical event type mapping ──────────────────────────────────────

/**
 * Cordis bus-level dsh events → canonical event types.
 *
 * These are the names `ctx.on(...)` accepts. `keyof Events` is augmented by the
 * `@deepseek-ai/dsh-*` service packages imported (type-only) above, so a bus name the host
 * does not declare — or a typo — fails `tsc` here instead of silently never firing.
 *
 * `SessionEvent` sub-types carried inside `session/event` payloads are a DIFFERENT
 * vocabulary (payload discriminators, never bus names); they live in
 * {@link DSH_SESSION_EVENT_TYPE_MAP}.
 */
const DSH_BUS_EVENT_TYPE_MAP = {
  // Session service events (dsh-session §4.1)
  "session/created": "session.created",
  "session/disposed": "session.deleted",
  "session/event": "session.updated",
  "session/flush": "session.updated",

  // Tools service events (dsh-tools §3.5)
  "tools/result": "part.updated",
  "tools/change": "session.updated",

  // `skills/change` (dsh skill service, index.ts:298) is the unfiltered
  // catalog-invalidation notification — a provider/catalog may be stale and
  // consumers should refetch. Forwarded on the same generic bucket rolebox
  // already uses for the analogous registry-change notification `tools/change`.
  "skills/change": "session.updated",
} as const satisfies Partial<Record<keyof Events, CanonicalEventType>>;

/**
 * `SessionEvent` sub-types carried inside `session/event` payloads → canonical event types.
 *
 * These are the `type` discriminators of appended session-log events, not cordis bus names,
 * so `keyof Events` cannot check them. The installed `SessionEventType` union is likewise
 * incomplete — several sub-types are declared by service packages that are not installed —
 * so the key set is guarded by `tests/platform/dsh-event-vocabulary.test.ts` against the
 * authoritative generated runtime catalog `KNOWN_SESSION_EVENT_TYPES`
 * (the catalog shipped by the pinned `@deepseek-ai/dsh-session`; membership, not a size).
 *
 * `assistant/chunk` is deliberately absent: it is not in `KNOWN_SESSION_EVENT_TYPES` (it
 * survives only in legacy fixtures, and dsh's own tests assert it never reaches a session
 * log), so that entry could never match.
 *
 * Vocabulary: `dsh-plugin-contract.md` §4.1. Every entry maps onto a canonical kind that
 * already exists above — no new vocabulary is introduced.
 */
export const DSH_SESSION_EVENT_TYPE_MAP = {
  // Message appends.
  "user/message": "message.created",
  "assistant/message": "message.created",

  // Tool lifecycle.
  "tool/call": "part.created",
  "tool/result": "message.updated",

  // Turn / step lifecycle.
  "turn/start": "session.status",
  "turn/end": "session.idle",
  "step/start": "session.status",
  "step/end": "session.status",

  // Log-only state / snapshot records.
  "todo/write": "session.updated",
  "request/header": "session.updated",
  "request/context": "session.updated",
  "session/end-seed": "session.updated",

  // Session-log events that resolved to "unknown" before this table grew.

  // Lifecycle state transitions (a start/end or awaiting/resolved pair) →
  // `session.status`, the same bucket as `turn/start` · `step/start` ·
  // `step/end`.
  "approval/asked": "session.status",
  "approval/decided": "session.status",
  "compaction/start": "session.status",
  "compaction/end": "session.status",

  // Paired hook invocation lifecycle → `part.created` / `part.updated`,
  // mirroring the `tool/call` · `tools/result` pair.
  "hook/invoked": "part.created",
  "hook/result": "part.updated",

  // Nested PTC (run_code sub-dispatch) lifecycle → `part.created` /
  // `part.updated`, the same tool-lifecycle pair as above.
  "tool/ptc-dispatch-start": "part.created",
  "tool/ptc-dispatch": "part.updated",

  // Log-only state / snapshot / mode / catalog records → `session.updated`,
  // the generic "something changed" bucket already used for `todo/write`,
  // `tools/change`, `request/header`, and `request/context`.
  "permission/preset": "session.updated",
  "compaction/summary": "session.updated",
  "plan/mode": "session.updated",
  "subagent/catalog": "session.updated",
  "subagent/descriptor": "session.updated",
} as const satisfies Record<string, CanonicalEventType>;

/** String-keyed views used by the tolerant lookup in {@link mapDshEventType}. */
const DSH_BUS_EVENT_LOOKUP: Record<string, CanonicalEventType> = DSH_BUS_EVENT_TYPE_MAP;
const DSH_SESSION_EVENT_LOOKUP: Record<string, CanonicalEventType> =
  DSH_SESSION_EVENT_TYPE_MAP;

/**
 * Map a dsh event type string to a CanonicalEventType.
 *
 * Looks up both host vocabularies in turn — cordis bus names (`session/created`,
 * `tools/result`, ...) and `session/event` payload sub-types (`user/message`,
 * `turn/end`, ...) — because both reach this function as a `rawType`. The `string`
 * parameter is deliberate: callers pass raw, unvalidated host discriminators. Unknown or
 * unmapped types resolve to "unknown".
 */
export function mapDshEventType(dshType: string): CanonicalEventType {
  return (
    DSH_BUS_EVENT_LOOKUP[dshType] ??
    DSH_SESSION_EVENT_LOOKUP[dshType] ??
    "unknown"
  );
}

/** Top-level dsh session service events the bridge subscribes to. */
export const DSH_SESSION_EVENTS = [
  "session/created",
  "session/disposed",
  "session/event",
  "session/flush",
] as const satisfies readonly (keyof Events)[];

/** Top-level dsh tools service events the bridge subscribes to. */
export const DSH_TOOLS_EVENTS = [
  "tools/result",
  "tools/change",
] as const satisfies readonly (keyof Events)[];

/**
 * Top-level dsh skill service events the bridge subscribes to.
 *
 * `skills/change` is the unfiltered catalog-invalidation notification emitted
 * when a skill provider, runtime contribution, or provider-backed catalog
 * changes (`@deepseek-ai/dsh-skill` index.ts:298).
 */
export const DSH_SKILL_EVENTS = [
  "skills/change",
] as const satisfies readonly (keyof Events)[];

// ── Adapter implementation ───────────────────────────────────────────────────

/**
 * IEventBridge implementation that adapts dsh cordis events into the
 * canonical event system.
 *
 * Subscribes to the dsh session/tools/skill service events on construction and
 * forwards each normalized event to registered handlers. General-purpose
 * handlers receive every event; type-specific handlers only receive events
 * matching their canonical type.
 */
export class DshEventBridge implements IEventBridge {
  /** General-purpose handlers invoked for every emitted event. */
  private readonly handlers: Set<CanonicalEventHandler> = new Set();

  /** Type-specific handlers, keyed by canonical event type. */
  private readonly typeHandlers: Map<
    CanonicalEventType,
    Set<CanonicalEventHandler>
  > = new Map();

  /** Cordis disposers returned by `ctx.on` — released by `dispose()`. */
  private readonly disposers: Array<() => void> = [];

  private readonly _log: Logger<ILogObj>;

  /**
   * @param ctx - Structural cordis context (`ctx.on` / `ctx.emit`).
   */
  constructor(ctx: DshCordisContext) {
    this._log = createSubLogger("dsh-event-bridge");
    this.wire(ctx);
  }

  // ── IEventBridge implementation ─────────────────────────────────────────

  /**
   * Subscribe a general-purpose event handler.
   * The handler receives all emitted canonical events.
   *
   * @param handler - Callback receiving the canonical event.
   * @returns An unsubscribe function that removes the handler.
   */
  on(handler: CanonicalEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Subscribe a type-specific event handler.
   * The handler only receives events matching the specified canonical type.
   *
   * @param type    - The canonical event type to subscribe to.
   * @param handler - Callback receiving the canonical event.
   * @returns An unsubscribe function that removes the handler.
   */
  onType(type: CanonicalEventType, handler: CanonicalEventHandler): () => void {
    let handlers = this.typeHandlers.get(type);
    if (!handlers) {
      handlers = new Set();
      this.typeHandlers.set(type, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers!.delete(handler);
      if (handlers!.size === 0) {
        this.typeHandlers.delete(type);
      }
    };
  }

  /**
   * Normalize a raw dsh event into a CanonicalEvent.
   *
   * Accepts two structural shapes (no SDK import needed):
   *
   *   - an object with a `type` string — the dsh event name (e.g.
   *     `session/created`) or a `SessionEvent` sub-type (e.g. `turn/end`);
   *     every other enumerable key becomes a `properties` entry.
   *   - a descriptor `{ event: <dsh event name>, payload: <object> }` — the
   *     form produced by the bridge's own dsh listeners; `payload` is merged
   *     into `properties`.
   *
   * @param rawEvent - The raw dsh event (unknown shape).
   * @returns A normalized CanonicalEvent.
   */
  normalize(rawEvent: unknown): CanonicalEvent {
    if (!isRecord(rawEvent)) {
      return { type: "unknown", rawType: "unknown", properties: {} };
    }

    // Descriptor form: { event, payload }
    const eventName =
      typeof rawEvent.event === "string" ? rawEvent.event : undefined;
    const rawType =
      typeof rawEvent.type === "string"
        ? rawEvent.type
        : (eventName ?? "unknown");
    const canonicalType = mapDshEventType(rawType);

    const properties: Record<string, unknown> = {};
    if (eventName !== undefined && rawEvent.payload !== undefined) {
      // Descriptor form — merge the payload bag.
      Object.assign(
        properties,
        isRecord(rawEvent.payload)
          ? rawEvent.payload
          : { payload: rawEvent.payload },
      );
    } else {
      // Plain form — capture everything except the type/event discriminators.
      for (const [key, value] of Object.entries(rawEvent)) {
        if (key === "type" || key === "event") continue;
        properties[key] = value;
      }
    }

    return { type: canonicalType, rawType, properties };
  }

  /**
   * Emit a canonical event to all matching subscribers.
   *
   * Dispatches to both general-purpose handlers and type-specific handlers.
   * All handlers are invoked and awaited; if any handler rejects, the error
   * is captured and re-thrown after all handlers have settled.
   *
   * @param event - The canonical event to dispatch.
   */
  async emit(event: CanonicalEvent): Promise<void> {
    const errors: unknown[] = [];

    // Dispatch to general-purpose handlers.
    for (const handler of this.handlers) {
      try {
        await handler(event);
      } catch (err) {
        errors.push(err);
      }
    }

    // Dispatch to type-specific handlers.
    const typeHandlerSet = this.typeHandlers.get(event.type);
    if (typeHandlerSet) {
      for (const handler of typeHandlerSet) {
        try {
          await handler(event);
        } catch (err) {
          errors.push(err);
        }
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `DshEventBridge.emit: ${errors.length} handler(s) failed for event "${event.type}"`,
      );
    }
  }

  /**
   * Unsubscribe every dsh event listener registered on the cordis ctx.
   * Idempotent — safe to call multiple times.
   */
  dispose(): void {
    const disposers = this.disposers.splice(0);
    for (const disposer of disposers) {
      try {
        disposer();
      } catch (err) {
        this._log.debug("dsh event disposer failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ── Private wiring ────────────────────────────────────────────────────────

  /**
   * Subscribe the dsh session/tools service events and forward normalized
   * events into the handler fan-out.
   */
  private wire(ctx: DshCordisContext): void {
    // session/created | session/disposed | session/flush — payload is a Session
    // (rc.6 emits a single `session` arg for all three; session/flush carries no
    // flush-result boolean).
    this.register(ctx, "session/created", (session) => ({
      properties: { session, sessionID: extractSessionId(session) },
    }));
    this.register(ctx, "session/disposed", (session) => ({
      properties: { session, sessionID: extractSessionId(session) },
    }));
    this.register(ctx, "session/flush", (session) => ({
      properties: {
        session,
        sessionID: extractSessionId(session),
      },
    }));

    // session/event — rc.6 emits (session, event): arg0 is the Session, arg1 is
    // the SessionEvent. Its own `type` refines the canonical mapping (rawType =
    // the sub-type); sessionID comes from the Session (arg0), not the event.
    this.register(ctx, "session/event", (session, sessionEvent) => {
      const rec = isRecord(sessionEvent) ? sessionEvent : {};
      return {
        type: typeof rec.type === "string" ? rec.type : "session/event",
        properties: {
          ...rec,
          sourceEvent: "session/event",
          sessionID: extractSessionId(session),
        },
      };
    });

    // tools/result — payload is the frozen ToolExecutionResult (+ exec input).
    this.register(ctx, "tools/result", (exec, result) => ({
      properties: { exec, result, sessionID: extractSessionId(exec) },
    }));

    // tools/change — rc.6 emits no args (a registry-subject notification).
    this.register(ctx, "tools/change", () => ({
      properties: {},
    }));

    // skills/change — the skill-service catalog-invalidation notification;
    // emits no args. Mapped to `session.updated` (rolebox's generic
    // "something changed" bucket, the same one `tools/change` uses).
    this.register(ctx, "skills/change", () => ({
      properties: {},
    }));
  }

  /**
   * Subscribe a single dsh event, building a canonical event from the raw
   * listener args and dispatching it (fire-and-forget; failures are logged).
   */
  private register(
    ctx: DshCordisContext,
    dshEvent: string,
    describe: (...args: unknown[]) => { type?: string; properties: Record<string, unknown> },
  ): void {
    const disposer = ctx.on(dshEvent, (...args) => {
      const raw = describe(...args);
      const canonical = this.normalize({
        type: raw.type ?? dshEvent,
        ...raw.properties,
      });
      // Dispatch is async (handlers may be async); never throw into cordis.
      this.emit(canonical).catch((err) => {
        this._log.debug("dsh event dispatch failed", {
          dshEvent,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
    if (disposer) this.disposers.push(disposer);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Structural record guard. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Best-effort extraction of a session id from an unknown dsh payload
 * (Session has `id`; exec inputs may carry `sessionID` / `sessionId`).
 */
function extractSessionId(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  if (typeof value.id === "string") return value.id;
  if (typeof value.sessionID === "string") return value.sessionID;
  if (typeof value.sessionId === "string") return value.sessionId;
  return undefined;
}
