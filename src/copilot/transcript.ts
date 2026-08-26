/**
 * Transcript assembly for the LLM-role copilot mode.
 *
 * Builds a role-labeled plain-text transcript of the tail window of a
 * session's conversation, for consumption by the copilot decision policy
 * and prompt builder. This module owns NO prompt template text — it only
 * formats. On read failure or timeout it returns null and the caller
 * treats that as "no transcript available".
 */

import type { ISessionClient } from "../platform/ports/session-client.ts";
import type { Part, ToolPart } from "../session/types.ts";
import { withTimeout, DEFAULT_TIMEOUT_MS } from "../utils/timeout.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("copilot-transcript");

/** Cap on a single tool-result summary line (kept brief by construction). */
const TOOL_SUMMARY_MAX = 120;

export interface TranscriptOptions {
  /** Number of most recent messages to include in the transcript window. */
  window_size: number;
  /** Hard cap on the returned transcript length; tail-truncated when exceeded. */
  max_chars: number;
  /** When true, append brief one-line summaries of tool results; when false, drop tool parts. */
  include_tools: boolean;
}

/**
 * Assemble a role-labeled plain-text transcript of the tail window of a
 * session's conversation.
 *
 * - Reads messages via `client.messages(sid, { limit: window_size })`,
 *   guarded by `withTimeout` (ROLEBOX_CLIENT_TIMEOUT_MS override applies,
 *   see src/utils/timeout.ts). The tail window is enforced defensively
 *   even if the client returns more messages than requested.
 * - Emits `user: <text>` / `assistant: <text>` lines from text parts. When
 *   `include_tools` is true, tool results are appended as brief one-line
 *   summaries; when false, tool parts are dropped entirely.
 * - Enforces `max_chars` by TAIL truncation: keeps the most recent content.
 * - Returns null on read failure or timeout; returns "" for an empty window.
 */
export async function assembleTranscript(
  client: ISessionClient,
  sid: string,
  opts: TranscriptOptions,
): Promise<string | null> {
  const windowSize = Math.max(0, opts.window_size);
  const maxChars = Math.max(0, opts.max_chars);

  try {
    const msgs = await withTimeout(
      client.messages(sid, { limit: windowSize }),
      DEFAULT_TIMEOUT_MS,
      `assembleTranscript:${sid}`,
      log,
    );
    if (msgs === null) return null;

    const tail = windowSize > 0 ? msgs.slice(-windowSize) : [];

    const lines: string[] = [];
    for (const msg of tail) {
      const role = msg.info?.role;
      // Only the canonical harness roles are labeled; adapter-specific
      // roles (e.g. toolResult) are never mislabeled as user/assistant.
      if (role !== "user" && role !== "assistant") continue;

      const text = msg.parts
        .filter(
          (p) =>
            p.type === "text" &&
            "text" in p &&
            typeof (p as { text?: string }).text === "string",
        )
        .map((p) => (p as { text: string }).text)
        .join("");
      if (text.length > 0) lines.push(`${role}: ${text}`);

      if (opts.include_tools) {
        for (const part of msg.parts) {
          const summary = summarizeTool(part);
          if (summary !== null) lines.push(`${role} ${summary}`);
        }
      }
    }

    let transcript = lines.join("\n");
    if (transcript.length > maxChars) {
      transcript = transcript.slice(transcript.length - maxChars);
    }
    return transcript;
  } catch {
    return null;
  }
}

/**
 * Type guard for tool parts. Required because `Part` carries a catch-all
 * member whose index signature would otherwise leave `state` as `unknown`
 * after a plain `type === "tool"` check.
 */
function isToolPart(part: Part): part is ToolPart {
  return (
    part.type === "tool" &&
    "state" in part &&
    "tool" in part &&
    "callID" in part
  );
}

/**
 * One-line summary of a tool result part, or null when the part is not a
 * tool result (non-tool parts, or tool parts still pending/running).
 */
function summarizeTool(part: Part): string | null {
  if (!isToolPart(part)) return null;
  const state = part.state;

  if (state.status === "completed") {
    const title =
      typeof state.title === "string" && state.title.length > 0
        ? state.title
        : null;
    const outputFirstLine = firstNonEmptyLine(state.output);
    const detail = title ?? outputFirstLine ?? "(no output)";
    return `[tool ${part.tool}] completed: ${truncate(detail, TOOL_SUMMARY_MAX)}`;
  }

  if (state.status === "error") {
    return `[tool ${part.tool}] error: ${truncate(String(state.error), TOOL_SUMMARY_MAX)}`;
  }

  // pending / running carry no result yet.
  return null;
}

/** First non-empty line of a string, trimmed; null when empty. */
function firstNonEmptyLine(text: string): string | null {
  if (typeof text !== "string") return null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/** Truncate to `max` chars; unchanged when already short enough. */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
