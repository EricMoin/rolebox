/**
 * PiNotificationSessionClient — ISessionClient wrapper that adds parent
 * notification support for external sessions on the Pi platform.
 *
 * Wraps a PiProcessSessionAdapter (which manages child process sessions)
 * and adds the ability to send messages to external (parent) sessions via
 * Pi's ExtensionAPI (`pi.sendUserMessage`).
 *
 * Replaces the brittle JS Proxy previously used in `pi-extension.ts`.
 * The class is independently testable and has no dependency on the
 * extension entry point.
 *
 * @module
 */

import type { Logger } from "tslog";
import type { ILogObj } from "tslog";
import type { ISessionClient } from "../../ports/session-client.ts";
import type { IEventBridge } from "../../ports/event-bridge.ts";
import type { PiProcessSessionAdapter } from "./process-session.ts";
import type {
  SessionInfo,
  Message,
  FileDiff,
  Todo,
  SessionStatus,
} from "../../types.ts";

/**
 * Wraps a PiProcessSessionAdapter to add Pi notification support.
 *
 * All methods delegate to the inner adapter except `prompt` and
 * `promptSync`, which first check whether the inner adapter manages
 * the session (via its `processes` map). If it does, the operation
 * is delegated; otherwise, `prompt` uses `pi.sendUserMessage` and
 * `promptSync` returns `null`.
 */
export class PiNotificationSessionClient implements ISessionClient {
  private readonly inner: PiProcessSessionAdapter;
  private readonly pi: any;
  private readonly log: Logger<ILogObj>;
  private readonly eventBridge?: IEventBridge;

  constructor(
    inner: PiProcessSessionAdapter,
    pi: any,
    log: Logger<ILogObj>,
    eventBridge?: IEventBridge,
  ) {
    this.inner = inner;
    this.pi = pi;
    this.log = log;
    this.eventBridge = eventBridge;
  }

  // ── Delegated methods ────────────────────────────────────────────────────

  async list(directory?: string): Promise<SessionInfo[]> {
    return this.inner.list(directory);
  }

  async get(id: string, directory?: string): Promise<SessionInfo | null> {
    return this.inner.get(id, directory);
  }

  async messages(
    id: string,
    options?: { directory?: string; limit?: number },
  ): Promise<Message[]> {
    return this.inner.messages(id, options);
  }

  async children(id: string, directory?: string): Promise<SessionInfo[]> {
    return this.inner.children(id, directory);
  }

  async todo(id: string, directory?: string): Promise<Todo[]> {
    return this.inner.todo(id, directory);
  }

  async diff(
    id: string,
    options?: { directory?: string; messageID?: string },
  ): Promise<FileDiff[]> {
    return this.inner.diff(id, options);
  }

  async fork(
    id: string,
    options?: { directory?: string; messageID?: string },
  ): Promise<SessionInfo | null> {
    return this.inner.fork(id, options);
  }

  async status(id: string, directory?: string): Promise<SessionStatus | null> {
    return this.inner.status(id, directory);
  }

  async create(options: {
    directory: string;
    agent?: string;
    parentID?: string;
  }): Promise<SessionInfo | null> {
    return this.inner.create(options);
  }

  async abort(id: string): Promise<boolean> {
    return this.inner.abort(id);
  }

  async compact(id: string): Promise<boolean> {
    return this.inner.compact(id);
  }

  // ── Intercepted methods ──────────────────────────────────────────────────

  /**
   * Prompt a session.
   *
   * For sessions managed by the inner adapter (present in `processes`),
   * delegates to `inner.prompt()`. For external (parent) sessions, sends
   * the message via `pi.sendUserMessage()` if available.
   *
   * When `pi.sendUserMessage` is unavailable or throws, a warning is
   * logged and a `session.error` canonical event is emitted (when
   * an event bridge is configured) so the dispatch manager can detect
   * the stuck state.
   */
  async prompt(
    id: string,
    options: {
      parts: Array<{ type: string; text: string }>;
      noReply?: boolean;
      system?: string;
      agent?: string;
      model?: { providerID: string; modelID: string };
    },
  ): Promise<{ id: string } | null> {
    if (this._hasProcess(id)) {
      return this.inner.prompt(id, options);
    }

    if (typeof this.pi.sendUserMessage !== "function") {
      this.log.warn("Parent notification unavailable — no pi.sendUserMessage", {
        sessionId: id,
      });
      void this._emitNotificationError(id, "pi.sendUserMessage is not available");
      return null;
    }

    const text = options.parts
      ?.map((p) => p.text)
      .join("\n") ?? "";

    try {
      await this.pi.sendUserMessage(id, text);
      return { id };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn("Parent notification failed — pi.sendUserMessage threw", {
        sessionId: id,
        error: message,
      });
      void this._emitNotificationError(id, message);
      return null;
    }
  }

  /**
   * Prompt a session synchronously.
   *
   * For sessions managed by the inner adapter (present in `processes`),
   * delegates to `inner.promptSync()`. For external sessions, returns
   * `null` since synchronous prompting is not supported via notification.
   */
  async promptSync(
    id: string,
    options: {
      parts: Array<{ type: string; text: string }>;
      agent?: string;
      signal?: AbortSignal;
    },
  ): Promise<{ parts: Array<{ type: string; text?: string }> } | null> {
    if (this._hasProcess(id)) {
      return this.inner.promptSync(id, options);
    }

    this.log.warn("promptSync unavailable for external session", {
      sessionId: id,
    });
    return null;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Check whether the inner adapter has a managed process for the
   * given session ID. Uses the same private-field bypass pattern
   * as the original Proxy implementation.
   */
  private _hasProcess(id: string): boolean {
    const adapter = this.inner as any;
    return Boolean(adapter.processes?.has?.(id));
  }

  /**
   * Emit a `session.error` canonical event when notification fails.
   *
   * This is a fire-and-forget best-effort emission: any error from the
   * event bridge itself is swallowed (logged at debug level) so the
   * notification failure path always completes without throwing.
   *
   * When no event bridge is configured, this is a no-op.
   */
  private async _emitNotificationError(
    sessionId: string,
    reason: string,
  ): Promise<void> {
    if (!this.eventBridge) return;

    try {
      await this.eventBridge.emit({
        type: "session.error",
        rawType: "notification.error",
        properties: {
          sessionId,
          reason,
          source: "PiNotificationSessionClient",
        },
      });
    } catch (_err) {
      this.log.debug("Failed to emit session.error event", {
        sessionId,
        reason,
      });
    }
  }
}
