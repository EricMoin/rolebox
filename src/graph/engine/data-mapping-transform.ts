/**
 * Graph Model v2 — Data Passthrough Transform
 *
 * Version: 2.0
 * Date: 2026-07-25
 *
 * Pure, side-effect-free application of an edge's `data_passthrough`
 * ({@link DataMapping}) to an {@link EdgePayload} before it is handed
 * downstream. The engine calls this once per activating edge so each
 * downstream edge can reshape the same upstream result independently.
 *
 * Semantics:
 *   - `maxChars` truncates `payload.result` to at most N characters.
 *   - `exclude` removes artifact paths whose full path or basename matches an
 *     excluded name, and — when `payload.result` is parseable JSON — drops the
 *     matching top-level keys from the JSON object.
 *
 * The module holds no state and mutates nothing: a payload that needs no
 * transformation is returned by reference (identity preserved); a payload that
 * does need a transformation is cloned shallowly first.
 *
 * Design reference: .rolebox/design/tool-merge-map.md §2.2 (data_passthrough).
 */

import type { EdgePayload } from "../../types.engine-v2.ts";
import type { DataMapping } from "../../types.graph-v2.ts";

/**
 * Apply an edge's {@link DataMapping} to an upstream payload.
 *
 * Application order (each step operates on the output of the previous):
 *   1. `fields` (include whitelist) — when non-empty, keep only the
 *      whitelisted top-level keys from `payload.result` (parsed as JSON).
 *      Non-JSON / non-object results pass through unchanged.
 *   2. `exclude` — strip matching top-level JSON keys and artifact paths.
 *   3. `maxChars` — truncate `payload.result` after both key-level
 *      transforms have been applied.
 *
 * A `mapping` that is undefined or carries no applicable field is a no-op and
 * returns the payload by reference. Otherwise the payload is shallow-cloned and
 * its `result` (whitelisted / key-stripped / truncated) and `artifacts`
 * (filtered) are updated. `fromNode`, `fromSignal`, and `budgetConsumed` are
 * untouched.
 *
 * @param payload - the upstream {@link EdgePayload}.
 * @param mapping - the edge's data passthrough mapping (optional).
 * @returns the transformed payload (a clone when a change applied, otherwise
 *   the same reference).
 */
export function applyDataMapping(
  payload: EdgePayload,
  mapping?: DataMapping,
): EdgePayload {
  if (!mapping) return payload;

  const fields = mapping.fields ?? [];
  const fieldsSet = fields.length > 0 ? new Set(fields) : null;
  const exclude = mapping.exclude ?? [];
  const excludeSet = new Set(exclude);
  const maxChars = mapping.maxChars;

  let result = payload.result;
  let artifacts = payload.artifacts;

  // 1. Fields whitelist (keep only listed top-level JSON keys). Applied first
  //    so `exclude` can still strip keys that survived the whitelist.
  if (fieldsSet && fieldsSet.size > 0) {
    result = keepJsonKeys(result, fieldsSet);
  }

  // 2. Exclusions (artifact paths + top-level JSON keys).
  if (excludeSet.size > 0) {
    if (payload.artifacts.length > 0) {
      artifacts = payload.artifacts.filter(
        (path) => !matchesExcluded(path, excludeSet),
      );
    }
    result = stripJsonKeys(result, excludeSet);
  }

  // 3. Truncation (applied last — after all key-level transforms).
  if (maxChars !== undefined && Number.isFinite(maxChars) && maxChars >= 0) {
    result = result.slice(0, maxChars);
  }

  const changed =
    result !== payload.result || artifacts !== payload.artifacts;
  return changed ? { ...payload, result, artifacts } : payload;
}

/**
 * An artifact path is excluded when its full path or its basename (the path
 * segment after the last `/`) exactly equals an excluded name.
 */
function matchesExcluded(path: string, excludeSet: Set<string>): boolean {
  if (excludeSet.has(path)) return true;
  const base = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
  return excludeSet.has(base);
}

/**
 * When `result` is a single top-level JSON object, keep only the whitelisted
 * keys and re-serialize. Any non-object (array, scalar, malformed JSON) is
 * returned unchanged — the result passes through without modification (the
 * include-whitelist semantic cannot be applied to a non-object shape, so the
 * original text is preserved as a safe fallback).
 */
function keepJsonKeys(result: string, fieldsSet: Set<string>): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    // Not valid JSON — cannot apply field whitelist, return original unchanged.
    return result;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    // Non-object JSON — include-whitelist is meaningless, return original.
    return result;
  }
  const obj = parsed as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  let changed = false;
  for (const [key, value] of Object.entries(obj)) {
    if (fieldsSet.has(key)) {
      kept[key] = value;
    } else {
      changed = true;
    }
  }
  return changed ? JSON.stringify(kept) : result;
}

/**
 * When `result` is a single top-level JSON object, delete the excluded keys
 * and re-serialize. Any non-object (array, scalar, malformed JSON) is returned
 * unchanged — key-stripping only applies to object shapes.
 */
function stripJsonKeys(result: string, excludeSet: Set<string>): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return result;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return result;
  }
  const obj = parsed as Record<string, unknown>;
  let changed = false;
  for (const key of excludeSet) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      delete obj[key];
      changed = true;
    }
  }
  return changed ? JSON.stringify(obj) : result;
}
