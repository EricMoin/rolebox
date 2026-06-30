import { createHash } from "node:crypto";
import {
  extractResultBlock as extractBlock,
} from "../dispatch/result-extractor.ts";

/**
 * Extract the result text from an assistant message.
 * Delegates to result-extractor.ts; returns only the text (not the wrapper).
 * When no ```result fence is present, returns the full input unchanged.
 */
export function extractResultBlock(rawAssistantText: string): string {
  return extractBlock(rawAssistantText).result;
}

/**
 * Trim and collapse all internal whitespace runs (spaces, tabs, newlines)
 * into single spaces. Used to produce stable comparison tokens for
 * result-equality checks (stuck detection, result_matches no_changes).
 */
export function normalizeResult(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Stable short sha256 hash of normalized result text (first 12 hex chars).
 */
export function hashResult(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/**
 * Truncate a result string to at most `maxChars` characters.
 * Pure function — no side effects.
 */
export function truncateResult(text: string, maxChars = 2048): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}
