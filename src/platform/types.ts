/**
 * Shared canonical types for the platform abstraction layer.
 * These types are platform-agnostic and must NOT import from any SDK.
 */

import type { z } from "zod";

// ── Tool types ───────────────────────────────────────────────────────────────

/**
 * Context provided to a tool's execute function.
 * Platform adapters map their native context to this shape.
 */
export type CanonicalToolContext = {
  sessionID: string;
  messageID: string;
  agent: string;
  /** Current project directory for this session. */
  directory: string;
  /** Project worktree root for this session. */
  worktree: string;
  abort: AbortSignal;
  metadata(input: {
    title?: string;
    metadata?: Record<string, unknown>;
  }): void;
  ask(input: {
    permission: string;
    patterns: string[];
    always: string[];
    metadata: Record<string, unknown>;
  }): Promise<void>;
};

export type ToolAttachment = {
  type: "file";
  mime: string;
  url: string;
  filename?: string;
};

export type ToolResult =
  | string
  | {
      title?: string;
      output: string;
      metadata?: Record<string, unknown>;
      attachments?: ToolAttachment[];
    };

/**
 * Optional deprecation info for a tool definition.
 * When set, the tool's description is augmented with a deprecation notice
 * in the LLM-facing system prompt, and invoking the tool logs a warning.
 * - `true` marks the tool as deprecated without additional context.
 * - `{ since, message }` provides version info and a migration hint.
 */
export type DeprecatedInfo = {
  /** Version or date when the deprecation took effect. */
  since: string;
  /** Migration hint or reason for deprecation. */
  message: string;
};

/**
 * A platform-agnostic tool definition.
 * This is the canonical shape that all tools define against.
 * Platform adapters compile this into their native tool format.
 */
export type CanonicalToolDef<Args extends z.ZodRawShape = z.ZodRawShape> = {
  description: string;
  /** Marks this tool as deprecated. The LLM will see a deprecation notice
   * and runtime invocations will emit a warning log.
   */
  deprecated?: boolean | DeprecatedInfo;
  args: Args;
  execute(
    args: z.infer<z.ZodObject<Args>>,
    context: CanonicalToolContext,
  ): Promise<ToolResult>;
};

// ── Event types ──────────────────────────────────────────────────────────────

/**
 * Canonical event types that the platform abstraction recognizes.
 * Platform adapters map their native event types to these.
 */
export type CanonicalEventType =
  | "session.idle"
  | "session.status"
  | "session.updated"
  | "session.error"
  | "session.created"
  | "session.deleted"
  | "message.created"
  | "message.updated"
  | "message.completed"
  | "part.created"
  | "part.updated"
  | "unknown";

/**
 * A platform-agnostic event. All platform events are normalized to this shape
 * before being processed by the core event handler.
 */
export type CanonicalEvent = {
  type: CanonicalEventType;
  /** Raw event type string from the platform (preserved for debugging). */
  rawType: string;
  /** Platform-specific event properties. */
  properties: Record<string, unknown>;
};

// ── Agent types ──────────────────────────────────────────────────────────────

/**
 * A platform-agnostic agent definition.
 * Platform adapters translate this to their native agent config format.
 */
export type AgentDefinition = {
  /** Unique agent identifier (e.g. "emperor--chancellor"). */
  id: string;
  /** Human-readable agent name. */
  name: string;
  /** Agent description. */
  description: string;
  /** System prompt for the agent. */
  systemPrompt: string;
  /** Optional model override. */
  model?: string;
  /** Optional role mode (e.g. "primary", "subagent") for file-based registrars. */
  mode?: string;
  /** Agent-specific tool permissions. */
  tools?: {
    allow?: string[];
    deny?: string[];
  };
  /** Max steps before forced termination. */
  maxSteps?: number;
};

// ── Session types (re-exported from session/types for convenience) ───────────

export type {
  SessionInfo,
  Message,
  FileDiff,
  Todo,
  SessionStatus,
} from "../session/types.ts";

/**
 * Error thrown when a platform SDK EXPLICITLY REJECTS a session create —
 * i.e. the result-tuple `error` field is present (a real server-side
 * rejection, e.g. HTTP 400 `BadRequestError`), as opposed to a transport /
 * network failure that manifests as a thrown exception.
 *
 * Distinguishing contract for the dispatch launcher's create-retry loop
 * (src/dispatch/core/task-launcher.ts — startBackgroundTask):
 *   - `SessionCreateRejectedError` → REJECTION → NEVER retried. The reason is
 *     surfaced verbatim so a rejection is never masked as "empty response".
 *   - any other thrown `Error`     → TRANSIENT transport failure → RETRIED.
 *   - a bare `null` return         → rejection with no reason available
 *     (still not retried).
 *
 * The `isSessionRejected` marker field makes the guard robust even if the class
 * is duplicated across module instances (Bun/deno cache isolation).
 */
export class SessionCreateRejectedError extends Error {
  readonly isSessionRejected = true as const;
  /** Structured code from the server, when available (e.g. SDK error `name`). */
  readonly code?: string;

  constructor(reason: string, code?: string) {
    super(reason);
    this.name = "SessionCreateRejectedError";
    this.code = code;
  }
}

/**
 * Type guard for `SessionCreateRejectedError`. Checks the structural marker so
 * a rejection thrown by another copy of the class (module-cache isolation) is
 * still recognized as non-transient.
 */
export function isSessionCreateRejected(
  err: unknown,
): err is SessionCreateRejectedError {
  return (
    err instanceof SessionCreateRejectedError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { isSessionRejected?: unknown }).isSessionRejected === true)
  );
}
