/**
 * ISessionClient — port interface for session operations.
 *
 * Abstracts the platform-specific session API so that dispatch,
 * notifications, and other services can operate without knowing
 * whether they're running on opencode, Claude Code, MCP, or standalone.
 *
 * Must NOT import from @opencode-ai/plugin or @opencode-ai/sdk.
 */

import type {
  SessionInfo,
  Message,
  FileDiff,
  Todo,
  SessionStatus,
} from "../types.ts";

export interface ISessionClient {
  /** List sessions, optionally filtered by directory. */
  list(directory?: string): Promise<SessionInfo[]>;

  /** Get a single session by ID. */
  get(id: string, directory?: string): Promise<SessionInfo | null>;

  /** Get messages for a session. */
  messages(
    id: string,
    options?: { directory?: string; limit?: number },
  ): Promise<Message[]>;

  /** Get child sessions spawned from a parent session. */
  children(id: string, directory?: string): Promise<SessionInfo[]>;

  /** Get todo items for a session. */
  todo(id: string, directory?: string): Promise<Todo[]>;

  /** Get file diffs for a session. */
  diff(
    id: string,
    options?: { directory?: string; messageID?: string },
  ): Promise<FileDiff[]>;

  /** Fork a session at a specific message. */
  fork(
    id: string,
    options?: { directory?: string; messageID?: string },
  ): Promise<SessionInfo | null>;

  /** Get session status (idle, busy, retry). */
  status(id: string, directory?: string): Promise<SessionStatus | null>;

  /**
   * Prompt a session asynchronously (fire-and-forget).
   * Used for injecting notes and triggering sub-agent work.
   */
  prompt(
    id: string,
    options: {
      parts: Array<{ type: string; text: string }>;
      noReply?: boolean;
      system?: string;
      agent?: string;
      /** Optional model override for this prompt. Ignored if the platform does not support per-prompt model selection. */
      model?: { providerID: string; modelID: string };
    },
  ): Promise<{ id: string } | null>;

  /**
   * Prompt a session synchronously — waits for the LLM response.
   * Used by sync dispatch executor. Returns response parts or null on failure.
   * Accepts an optional AbortSignal for cancellation.
   */
  promptSync(
    id: string,
    options: {
      parts: Array<{ type: string; text: string }>;
      agent?: string;
      signal?: AbortSignal;
    },
  ): Promise<{ parts: Array<{ type: string; text?: string }> } | null>;

  /**
   * Create a new session.
   * Returns the session info if the platform supports session creation.
   */
  create(options: {
    directory: string;
    agent?: string;
    parentID?: string;
  }): Promise<SessionInfo | null>;

  /**
   * Abort a running session.
   * Returns true if the abort was acknowledged.
   */
  abort(id: string): Promise<boolean>;

  /**
   * Compact (summarize/compress) a session's conversation context.
   * Returns true if compaction succeeded. Platforms that do not
   * support context compaction return false.
   */
  compact?(id: string): Promise<boolean>;
}
