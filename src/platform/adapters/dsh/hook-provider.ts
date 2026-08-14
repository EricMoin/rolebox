/**
 * DshHookProvider — IHookProvider adapter mapping rolebox hook kinds onto
 * dsh extension points.
 *
 * Rolebox hook kinds (the lifecycle handlers produced by HookService for
 * opencode — see `src/core/services/hook-service.ts:buildHandlers`) map onto
 * the verified dsh extension points (`docs/dsh-plugin-contract.md` §3.5
 * tools events, §4.1 session events) as follows:
 *
 *   | rolebox hook kind | dsh extension point                          | status |
 *   |-------------------|----------------------------------------------|--------|
 *   | tool-before       | `ctx.on("tools/pre-execute")`                | mapped |
 *   | tool-after        | `ctx.on("tools/post-execute")` + `tools/result` | mapped |
 *   | chat-message      | `ctx.on("session/event")` (user/assistant appends) | mapped |
 *   | system-transform  | — none —                                     | no-op  |
 *   | context           | — none —                                     | no-op  |
 *   | compaction        | — none —                                     | no-op  |
 *
 * ## Documented no-ops (rolebox hook kinds with NO dsh equivalent)
 *
 * - **system-transform**: dsh composes the model-facing system prompt from
 *   the mounted `systemPrompt` service (dsh-tools injects it, §3.1); there is
 *   no per-turn prompt transform hook to attach to. The handler in
 *   `getHandlers()` is a no-op.
 * - **context**: rolebox's `context` "hook" is a helper bundle
 *   (`src/hooks/context.ts` — `collectAllFunctions`, `appendCorrection`,
 *   `fetchLastAssistantText`) with no dsh event seam; its handler is a no-op.
 * - **compaction**: dsh compacts sessions through data-level
 *   `surfaceOp: 'replace'` appends on the session log (§4.1); there is no
 *   compaction lifecycle event. The handler is a no-op.
 *
 * Tool registration is NOT part of this provider: dsh tools are registered
 * through `ctx.tools.register(defineTool(...))`, owned by the parallel
 * `tool-factory.ts` adapter. `getHandlers().tool` is therefore an empty
 * record, kept for IHookProvider port conformance.
 *
 * All dsh types are structural (duck-typed). This module does NOT import
 * `@deepseek-ai/*` (or `@opencode-ai/*`).
 *
 * @module
 */

import type { Logger } from "tslog";
import type { ILogObj } from "tslog";
import { createSubLogger } from "../../../logger.ts";
import type { IHookProvider } from "../../ports/hook-provider.ts";
import type { DshCordisContext } from "./event-bridge.ts";

// ── Payload vocabulary ───────────────────────────────────────────────────────

/**
 * Normalized payload passed to a rolebox hook callback. Carries the dsh
 * event name it was produced from (`event`), the owning rolebox hook kind
 * (`hookKind`), and every enumerable field of the raw dsh event payload.
 */
export type DshHookPayload = Record<string, unknown> & {
  /** The dsh event name that produced this payload. */
  event: string;
  /** The rolebox hook kind this callback implements. */
  hookKind: DshHookKind;
};

/** The rolebox hook kinds this provider understands. */
export type DshHookKind =
  | "system-transform"
  | "chat-message"
  | "tool-before"
  | "tool-after"
  | "context"
  | "compaction";

/** Callback signature for a rolebox hook kind. */
export type DshHookCallback = (
  payload: DshHookPayload,
) => void | Promise<void>;

/** Mapped rolebox hook callbacks — only kinds with a dsh equivalent are wired. */
export interface DshHookProviderOptions {
  /** `tool-before` → `tools/pre-execute`. */
  toolBefore?: DshHookCallback;
  /** `tool-after` → `tools/post-execute` (mutate gate) and `tools/result` (frozen outcome). */
  toolAfter?: DshHookCallback;
  /** `chat-message` → `session/event` (user/message + assistant/message appends). */
  chatMessage?: DshHookCallback;
}

/**
 * Handler map returned by `getHandlers()`, keyed by rolebox hook kind.
 * Mapped kinds expose the listener registered on the dsh ctx; unmapped kinds
 * (`system-transform`, `context`, `compaction`) expose documented no-ops.
 */
export type DshHookHandlers = {
  "system-transform": DshHookCallback;
  "chat-message": DshHookCallback;
  "tool-before": DshHookCallback;
  "tool-after": DshHookCallback;
  "context": DshHookCallback;
  "compaction": DshHookCallback;
  /** Platform-native tool definitions — empty here; DshToolFactory owns registration. */
  tool: Record<string, unknown>;
  /** Unsubscribe every listener registered on the dsh ctx. */
  dispose: () => void;
};

// ── Adapter implementation ───────────────────────────────────────────────────

/**
 * IHookProvider implementation that wires rolebox hook kinds onto dsh
 * extension points on a cordis context.
 *
 * On construction it registers `ctx.on(...)` listeners for the mapped dsh
 * events. `getHandlers()` exposes one handler per rolebox hook kind (the
 * registered listeners for mapped kinds, documented no-ops for unmapped
 * kinds), plus `tool` and `dispose`.
 */
export class DshHookProvider implements IHookProvider {
  private readonly _log: Logger<ILogObj>;
  private readonly handlers: DshHookHandlers;
  /** Cordis disposers returned by `ctx.on` — released by `dispose()`. */
  private readonly disposers: Array<() => void> = [];

  /**
   * @param ctx     - Structural cordis context (`ctx.on` / `ctx.emit`).
   * @param options - Mapped rolebox hook callbacks (tool-before, tool-after,
   *                  chat-message). Kinds with no dsh equivalent
   *                  (system-transform, context, compaction) are not accepted
   *                  and remain documented no-ops.
   */
  constructor(
    private readonly ctx: DshCordisContext,
    private readonly options: DshHookProviderOptions = {},
  ) {
    this._log = createSubLogger("dsh-hook-provider");
    this.handlers = this.buildHandlers();
    this.wire();
  }

  /**
   * Return the assembled hook handlers, keyed by rolebox hook kind.
   */
  getHandlers(): Record<string, unknown> {
    return this.handlers;
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
        this._log.debug("dsh hook disposer failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ── Handler assembly ───────────────────────────────────────────────────────

  /**
   * Build the per-kind handler map. Mapped kinds invoke the user callback
   * with a normalized payload; unmapped kinds are documented no-ops.
   */
  private buildHandlers(): DshHookHandlers {
    const noop = (): void => {};
    return {
      "tool-before": (payload) =>
        this.options.toolBefore?.({ ...payload, hookKind: "tool-before" }),
      "tool-after": (payload) =>
        this.options.toolAfter?.({ ...payload, hookKind: "tool-after" }),
      "chat-message": (payload) =>
        this.options.chatMessage?.({ ...payload, hookKind: "chat-message" }),
      // No dsh equivalent — documented no-ops (see module docstring).
      "system-transform": noop,
      context: noop,
      compaction: noop,
      // Tool registration is owned by DshToolFactory (tool-factory.ts);
      // this provider keeps an empty record for port conformance.
      tool: {},
      dispose: () => this.dispose(),
    };
  }

  /**
   * Register the dsh event listeners for the mapped hook kinds.
   */
  private wire(): void {
    // dsh event → rolebox hook kind
    const mappings: Array<{ dshEvent: string; kind: DshHookKind }> = [
      // tool-before → tools/pre-execute (allow/deny/ask waterfall, §3.5)
      { dshEvent: "tools/pre-execute", kind: "tool-before" },
      // tool-after → tools/post-execute (accept/replace/block gate, §3.5)
      { dshEvent: "tools/post-execute", kind: "tool-after" },
      // tool-after also observes tools/result (frozen final outcome, §3.5)
      { dshEvent: "tools/result", kind: "tool-after" },
      // chat-message → session/event (message appends, §4.1)
      { dshEvent: "session/event", kind: "chat-message" },
    ];

    for (const { dshEvent, kind } of mappings) {
      const listener = (...args: unknown[]): void => {
        const payload = this.toPayload(dshEvent, args);
        // chat-message only reacts to message appends — other session event
        // sub-types (turn/start, todo/write, ...) belong to the event bridge.
        if (
          kind === "chat-message" &&
          payload.sessionEventType !== "user/message" &&
          payload.sessionEventType !== "assistant/message"
        ) {
          return;
        }
        const result = this.handlers[kind](payload);
        // Handlers may return a promise; never throw into cordis.
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((err) => {
            this._log.debug("dsh hook handler rejected", {
              kind,
              dshEvent,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      };
      const disposer = this.ctx.on(dshEvent, listener);
      if (disposer) this.disposers.push(disposer);
    }
  }

  /**
   * Build a normalized payload record from raw dsh listener args.
   *
   * Tolerates the two plausible dsh listener signatures: `(payload)` where
   * payload is an object, and `(name, payload)` where the tool name leads.
   * Common field aliases are normalized (`name` → `tool`, `callId` →
   * `callID`, `sessionId` → `sessionID`).
   */
  private toPayload(
    dshEvent: string,
    args: unknown[],
  ): DshHookPayload {
    const payload: DshHookPayload = {
      event: dshEvent,
      hookKind: "tool-before", // placeholder; set by the caller's kind wrapper
    };

    const [first, ...rest] = args;
    if (typeof first === "string") {
      payload.tool = first;
      if (rest.length > 0 && isRecord(rest[0])) {
        Object.assign(payload, rest[0]);
      } else {
        payload.payload = rest[0];
      }
    } else if (isRecord(first)) {
      Object.assign(payload, first);
    } else {
      payload.payload = first;
    }

    // Alias normalization.
    if (typeof payload.name === "string" && payload.tool === undefined) {
      payload.tool = payload.name;
    }
    if (typeof payload.callId === "string" && payload.callID === undefined) {
      payload.callID = payload.callId;
    }
    if (payload.sessionId !== undefined && payload.sessionID === undefined) {
      payload.sessionID = payload.sessionId;
    }
    // Session event sub-type, used for chat-message routing.
    if (dshEvent === "session/event") {
      payload.sessionEventType =
        typeof payload.type === "string" ? payload.type : undefined;
      // A SessionEvent's `id` IS the session id.
      if (payload.sessionID === undefined && typeof payload.id === "string") {
        payload.sessionID = payload.id;
      }
    }

    return payload;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Structural record guard. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
