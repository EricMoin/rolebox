/**
 * The one result shape every `browse_*` tool returns.
 *
 * A successful result carries the canonical metadata a caller can rely on across
 * the whole family — `driver`, `action`, `session`, `page`, `url`, `title` — plus
 * whatever the action adds. A failure is never a thrown exception and never a
 * silent empty string: it is `Error: <cause>; <next step>.` with
 * `metadata.error = true` and `metadata.code` set to the closed
 * {@link BrowseErrorCode} value, so a model can branch on the code and a
 * transcript can still read the sentence.
 *
 * `hint` is folded into the same sentence rather than printed as a second one, so
 * the tool result stays one actionable instruction.
 */

import type { ToolAttachment, ToolResult } from "../platform/types.ts";
import { BrowseError, browseError, isBrowseError } from "./types.ts";

/** The driver every browse result names. */
export const BROWSE_DRIVER_NAME = "playwright";

/** What every result reports about where it ran. */
export interface BrowseResultContext {
  action: string;
  session: string;
  page?: string | null;
  url?: string | null;
  title?: string | null;
}

/** Build the metadata envelope shared by successes and failures. */
export function browseMetadata(
  context: BrowseResultContext,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    driver: BROWSE_DRIVER_NAME,
    action: context.action,
    session: context.session,
    page: context.page ?? "",
    url: context.url ?? "",
    title: context.title ?? "",
    ...extra,
  };
}

/** Build a successful tool result. */
export function browseResult(input: {
  title: string;
  output: string;
  context: BrowseResultContext;
  metadata?: Record<string, unknown>;
  attachments?: ToolAttachment[];
}): ToolResult {
  return {
    title: input.title,
    output: input.output,
    metadata: browseMetadata(input.context, input.metadata),
    ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
  };
}

/**
 * Build a failed tool result.
 *
 * `metadata.code` is always present so a caller can act on the failure class
 * without parsing the sentence.
 */
export function browseErrorResult(context: BrowseResultContext, error: unknown): ToolResult {
  const browse = toBrowseError(error);
  return {
    title: `${context.action} failed`,
    output: `Error: ${formatBrowseError(browse)}`,
    metadata: browseMetadata(context, {
      error: true,
      code: browse.code,
      ...(browse.hint === undefined ? {} : { hint: browse.hint }),
    }),
  };
}

/** Coerce any thrown value into a {@link BrowseError} without losing its message. */
export function toBrowseError(error: unknown): BrowseError {
  if (isBrowseError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return browseError(
    "protocol_error",
    message.trim() === "" ? "the operation failed without a message" : message,
    "Retry the operation; if it persists, check browse_status for the driver state.",
    error,
  );
}

/** Render a failure as `cause; next step.` — one sentence, no leading `Error:`. */
export function formatBrowseError(error: BrowseError): string {
  const cause = stripTrailing(error.message);
  if (error.hint === undefined || error.hint.trim() === "") return `${cause}.`;
  return `${cause}; ${lowerFirst(stripTrailing(error.hint))}.`;
}

/** Remove closing punctuation so the caller can add exactly one period. */
function stripTrailing(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/[.!?]+$/u, "");
}

/** Lowercase the first character unless it starts a code span or an acronym. */
function lowerFirst(value: string): string {
  if (value === "") return value;
  if (value.startsWith("`")) return value;
  const firstWord = value.split(" ")[0] ?? "";
  if (firstWord.length > 1 && firstWord === firstWord.toUpperCase()) return value;
  return `${value[0].toLowerCase()}${value.slice(1)}`;
}
