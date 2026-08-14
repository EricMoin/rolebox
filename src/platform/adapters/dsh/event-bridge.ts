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
 * The cordis ctx is consumed structurally (duck-typed). This module does NOT
 * import `@deepseek-ai/cordis` or any `@deepseek-ai/*` package, and MUST NOT
 * import from `@opencode-ai/*`.
 *
 * @module
 */

import type { Logger } from "tslog";
import type { ILogObj } from "tslog";
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
 */
export interface DshCordisContext {
  /** Subscribe to a cordis/dsh event. Returns an unsubscribe disposer. */
  on(event: string, listener: (...args: unknown[]) => void): (() => void) | void;
  /** Emit a cordis/dsh event. */
  emit(event: string, ...args: unknown[]): void;
}

// ── dsh-to-canonical event type mapping ──────────────────────────────────────

/**
 * Mapping from dsh event type strings to canonical event types.
 *
 * Includes both top-level service events (`session/created`, `tools/result`,
 * ...) and the `SessionEvent` sub-types carried inside `session/event`
 * payloads (`user/message`, `turn/end`, `todo/write`, ... — see
 * `dsh-plugin-contract.md` §4.1 for the full vocabulary). Unrecognised types
 * resolve to "unknown".
 */
const DSH_EVENT_TYPE_MAP: Record<string, CanonicalEventType> = {
  // Session service events (dsh-session §4.1)
  "session/created": "session.created",
  "session/disposed": "session.deleted",
  "session/event": "session.updated",
  "session/flush": "session.updated",

  // Tools service events (dsh-tools §3.5)
  "tools/result": "part.updated",
  "tools/change": "session.updated",

  // SessionEvent sub-types carried by session/event payloads
  "user/message": "message.created",
  "assistant/message": "message.created",
  "assistant/chunk": "part.updated",
  "tool/call": "part.created",
  "tool/result": "message.updated",
  "turn/start": "session.status",
  "turn/end": "session.idle",
  "step/start": "session.status",
  "step/end": "session.status",
  "todo/write": "session.updated",
  "request/header": "session.updated",
  "request/context": "session.updated",
  "session/end-seed": "session.updated",
};

/**
 * Map a dsh event type string to a CanonicalEventType.
 * Unknown or unmapped types resolve to "unknown".
 */
export function mapDshEventType(dshType: string): CanonicalEventType {
  return DSH_EVENT_TYPE_MAP[dshType] ?? "unknown";
}

/** Top-level dsh session service events the bridge subscribes to. */
export const DSH_SESSION_EVENTS = [
  "session/created",
  "session/disposed",
  "session/event",
  "session/flush",
] as const;

/** Top-level dsh tools service events the bridge subscribes to. */
export const DSH_TOOLS_EVENTS = ["tools/result", "tools/change"] as const;

// ── Adapter implementation ───────────────────────────────────────────────────

/**
 * IEventBridge implementation that adapts dsh cordis events into the
 * canonical event system.
 *
 * Subscribes to the dsh session/tools service events on construction and
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
    // (plus a flush result boolean for session/flush).
    this.register(ctx, "session/created", (session) => ({
      properties: { session, sessionID: extractSessionId(session) },
    }));
    this.register(ctx, "session/disposed", (session) => ({
      properties: { session, sessionID: extractSessionId(session) },
    }));
    this.register(ctx, "session/flush", (session, flushed) => ({
      properties: {
        session,
        sessionID: extractSessionId(session),
        flushed,
      },
    }));

    // session/event — payload is a SessionEvent; its own `type` refines the
    // canonical mapping (rawType = the sub-type).
    this.register(ctx, "session/event", (sessionEvent) => {
      const rec = isRecord(sessionEvent) ? sessionEvent : {};
      return {
        type: typeof rec.type === "string" ? rec.type : "session/event",
        properties: {
          ...rec,
          sourceEvent: "session/event",
          sessionID: extractSessionId(rec),
        },
      };
    });

    // tools/result — payload is the frozen ToolExecutionResult (+ exec input).
    this.register(ctx, "tools/result", (exec, result) => ({
      properties: { exec, result, sessionID: extractSessionId(exec) },
    }));

    // tools/change — payload is the registered/removed ToolDefinition.
    this.register(ctx, "tools/change", (definition) => ({
      properties: { definition },
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
