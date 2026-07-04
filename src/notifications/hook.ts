// ── Event System Integration Layer ──────────────────────────────────────
//
// Maps rolebox lifecycle events to NotificationManager methods.
// Every handler is fire-and-forget — errors are caught and logged at debug
// level so they never propagate to the event system.
// -------------------------------------------------------------------------

import type { NotificationManager } from "./manager.ts";
import { createSubLogger } from "../logger.ts";
import type { Logger } from "tslog";
import type { ILogObj } from "tslog";

const log: Logger<ILogObj> = createSubLogger("NotificationHook");

// ── Public Interface ───────────────────────────────────────────────────

export interface NotificationEventHandlers {
  onSessionIdle(sessionID: string, agent?: string): void;
  onSessionError(sessionID: string, agent?: string, error?: unknown): void;
  onSessionDeleted(sessionID: string): void;
  onMessageUpdated(sessionID: string, agent?: string): void;
  onChatMessage(sessionID: string, agent?: string): void;
  onToolBefore(sessionID: string, tool: string, args?: unknown, agent?: string): void;
  onDispatchComplete(sessionID: string, agent?: string): void;
  onLoopComplete(sessionID: string, agent?: string): void;
}

// ── Helper Functions ───────────────────────────────────────────────────

/**
 * Extract sessionID from event properties, trying multiple key shapes.
 */
function getSessionID(
  properties: Record<string, unknown> | undefined,
): string | undefined {
  if (!properties) return undefined;

  if (typeof properties.sessionID === "string") {
    return properties.sessionID as string;
  }
  if (typeof properties.sessionId === "string") {
    return properties.sessionId as string;
  }

  // Nested info object (used by session.created / session.deleted)
  const info = properties.info as Record<string, unknown> | undefined;
  if (info) {
    if (typeof info.sessionID === "string") {
      return info.sessionID as string;
    }
    if (typeof info.sessionId === "string") {
      return info.sessionId as string;
    }
    if (typeof info.id === "string") {
      return info.id as string;
    }
  }

  return undefined;
}

/**
 * Extract agent from event properties.
 */
function getAgent(
  properties: Record<string, unknown> | undefined,
): string | undefined {
  if (!properties) return undefined;
  if (typeof properties.agent === "string") {
    return properties.agent as string;
  }
  return undefined;
}

// ── Handlers Factory ───────────────────────────────────────────────────

/**
 * Create thin handler functions that map rolebox events to notification
 * manager methods. Each handler is wrapped in try/catch and logs errors
 * at debug level — they are fire-and-forget and must never throw.
 */
export function createNotificationEventHandlers(
  manager: NotificationManager,
): NotificationEventHandlers {
  return {
    onSessionIdle(sessionID: string, agent?: string): void {
      try {
        manager.scheduleIdle(sessionID, agent);
      } catch (err) {
        log.debug("onSessionIdle failed", { sessionID, agent, err });
      }
    },

    onSessionError(sessionID: string, agent?: string, _error?: unknown): void {
      try {
        manager.handleSessionError(sessionID, agent);
      } catch (err) {
        log.debug("onSessionError failed", { sessionID, agent, err });
      }
    },

    onSessionDeleted(sessionID: string): void {
      try {
        manager.handleSessionDeleted(sessionID);
      } catch (err) {
        log.debug("onSessionDeleted failed", { sessionID, err });
      }
    },

    onMessageUpdated(sessionID: string, agent?: string): void {
      try {
        manager.handleMessageUpdated(sessionID, agent);
      } catch (err) {
        log.debug("onMessageUpdated failed", { sessionID, agent, err });
      }
    },

    onChatMessage(sessionID: string, agent?: string): void {
      try {
        manager.handleChatMessage(sessionID, agent);
      } catch (err) {
        log.debug("onChatMessage failed", { sessionID, agent, err });
      }
    },

    onToolBefore(
      sessionID: string,
      tool: string,
      args?: unknown,
      agent?: string,
    ): void {
      try {
        manager.handleToolBefore(sessionID, tool, args, agent);
      } catch (err) {
        log.debug("onToolBefore failed", { sessionID, tool, agent, err });
      }
    },

    onDispatchComplete(sessionID: string, agent?: string): void {
      try {
        manager.handleDispatchComplete(sessionID, agent);
      } catch (err) {
        log.debug("onDispatchComplete failed", { sessionID, agent, err });
      }
    },

    onLoopComplete(sessionID: string, agent?: string): void {
      try {
        manager.handleLoopComplete(sessionID, agent);
      } catch (err) {
        log.debug("onLoopComplete failed", { sessionID, agent, err });
      }
    },
  };
}

// ── Hook Factory ───────────────────────────────────────────────────────

/**
 * Create the notification hook — an object shaped for rolebox's event
 * handler system. Provides:
 *
 * - `event`: async dispatcher that routes lifecycle events to the
 *   appropriate handler based on event type string.
 * - `chatMessage`: direct handler for chat.message hook.
 * - `toolBefore`: direct handler for tool.execute.before hook.
 * - `dispatchComplete`: invoked from the dispatch manager.
 * - `loopComplete`: invoked from the loop coordinator.
 */
export function createNotificationHook(manager: NotificationManager) {
  const handlers = createNotificationEventHandlers(manager);

  return {
    event: async (input: {
      event: { type: string; properties?: Record<string, unknown> | undefined };
    }) => {
      const { type, properties } = input.event;
      const sessionID = getSessionID(properties);
      if (!sessionID) return;
      const agent = getAgent(properties);

      switch (type) {
        case "session.idle":
          handlers.onSessionIdle(sessionID, agent);
          break;
        case "session.error":
          handlers.onSessionError(sessionID, agent, properties?.error);
          break;
        case "session.deleted":
          handlers.onSessionDeleted(sessionID);
          break;
        case "message.updated":
          handlers.onMessageUpdated(sessionID, agent);
          break;
        // tool.execute.before is handled separately via tool-before hook, not event hook
      }
    },

    /** Handler for chat.message hook. */
    chatMessage: (input: { sessionID: string; agent?: string }) => {
      handlers.onChatMessage(input.sessionID, input.agent);
    },

    /** Handler for tool.execute.before hook. */
    toolBefore: (input: {
      tool: string;
      sessionID: string;
      callID: string;
      args?: unknown;
      agent?: string;
    }) => {
      handlers.onToolBefore(
        input.sessionID,
        input.tool,
        input.args,
        input.agent,
      );
    },

    /** Called from the dispatch manager on completion. */
    dispatchComplete: (sessionID: string, agent?: string) => {
      handlers.onDispatchComplete(sessionID, agent);
    },

    /** Called from the loop coordinator on completion. */
    loopComplete: (sessionID: string, agent?: string) => {
      handlers.onLoopComplete(sessionID, agent);
    },
  };
}
