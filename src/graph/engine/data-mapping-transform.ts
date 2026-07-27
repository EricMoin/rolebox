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
 * A `mapping` that is undefined or carries no applicable field is a no-op and
 * returns the payload by reference. Otherwise the payload is shallow-cloned and
 * its `result` (truncated / key-stripped) and `artifacts` (filtered) are
 * updated. `fromNode`, `fromSignal`, and `budgetConsumed` are untouched.
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

  const exclude = mapping.exclude ?? [];
  const excludeSet = new Set(exclude);
  const maxChars = mapping.maxChars;

  let result = payload.result;
  let artifacts = payload.artifacts;

  // 1. Truncation (applied first so JSON key-stripping sees the truncated text).
  if (maxChars !== undefined && Number.isFinite(maxChars) && maxChars >= 0) {
    result = result.slice(0, maxChars);
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
