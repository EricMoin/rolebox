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
 * A platform-agnostic tool definition.
 * This is the canonical shape that all tools define against.
 * Platform adapters compile this into their native tool format.
 */
export type CanonicalToolDef<Args extends z.ZodRawShape = z.ZodRawShape> = {
  description: string;
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
