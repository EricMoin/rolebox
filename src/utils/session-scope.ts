/**
 * Shared session-scope building logic.
 *
 * Reads raw dispatch state files to compute the set of session IDs in a
 * session's dispatch subtree. Used by both the CLI monitor and the TUI sidebar
 * to scope activity display to the current session's subtree.
 *
 * The subtree is walked TRANSITIVELY. Each dispatch row records an edge
 * `parentSessionId -> sessionId`; starting from the current session (and any
 * explicit seeds), every reachable child is included, so grandchildren are in
 * scope and not only direct children.
 *
 * {@link BuildSessionScopeOptions.extraSessionIds} seeds sessions known from
 * another source. This is required for engine-graph nodes: a graph-dispatched
 * worker is parented by a graph-scoped key rather than by a session id, so no
 * session-to-session dispatch edge can reach it. Its own dispatch children ARE
 * reachable once the seed is in scope.
 *
 * The result is OBSERVABLE. A missing state directory is an EMPTY SOURCE, not a
 * failure (benign absence), and neither is a state file that disappears between
 * the directory scan and the read (the state GC may reclaim old files; that is
 * the only silent skip). Every other directory read, file read or JSON/shape
 * failure is recorded as a problem, and {@link SessionScopeResult.complete} is
 * exactly `problems.length === 0`, so a caller can distinguish "this session
 * has no children" from "the dispatch state could not be read".
 *
 * @module
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { errorText } from "./error-text.ts";

/** One dispatch state source that could not be read or understood. */
export interface SessionScopeProblem {
  code: "directory-unreadable" | "file-unreadable" | "malformed-file";
  path: string;
  message: string;
}

/** The computed scope plus whether every dispatch source was read. */
export interface SessionScopeResult {
  sessionIds: Set<string>;
  /** Exactly `problems.length === 0`. */
  complete: boolean;
  problems: SessionScopeProblem[];
}

/** Optional inputs for {@link buildSessionScope}. */
export interface BuildSessionScopeOptions {
  /** Extra root sessions to seed the transitive walk with. */
  extraSessionIds?: Iterable<string>;
}

/** Whether `value` is a non-array object (the parsed dispatch state / a row). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The errno code of a caught filesystem error, when it has one. */
function errnoCode(err: unknown): string | undefined {
  if (!isRecord(err)) return undefined;
  return typeof err.code === "string" ? err.code : undefined;
}

/**
 * Build the set of session IDs in the dispatch subtree of `currentSessionId`.
 *
 * Seeds the walk with `currentSessionId` plus every truthy
 * `options.extraSessionIds` entry, then follows `parentSessionId -> sessionId`
 * edges from every readable `dispatch-*.json` file in `stateDir` transitively
 * (bounded: each session is visited once, so cycles terminate).
 *
 * Never throws. Reads every dispatch source it can and reports the rest in
 * {@link SessionScopeResult.problems}; see the module docs for the benign
 * absence rules.
 *
 * @param stateDir - The `.rolebox/state` directory to scan.
 * @param currentSessionId - The session whose subtree is being scoped.
 * @param options - Optional extra seed sessions.
 * @returns the reachable session IDs and whether every source was read.
 */
export function buildSessionScope(
  stateDir: string,
  currentSessionId: string,
  options?: BuildSessionScopeOptions,
): SessionScopeResult {
  const problems: SessionScopeProblem[] = [];
  const sessionIds = new Set<string>([currentSessionId]);
  for (const extraSessionId of options?.extraSessionIds ?? []) {
    if (extraSessionId) sessionIds.add(extraSessionId);
  }

  let files: string[] = [];
  try {
    files = readdirSync(stateDir);
  } catch (err) {
    // An absent state dir is an EMPTY SOURCE, not a failure.
    if (errnoCode(err) !== "ENOENT") {
      problems.push({ code: "directory-unreadable", path: stateDir, message: errorText(err) });
    }
  }

  // parentSessionId -> child sessionIds, aggregated across every readable file.
  const childrenByParent = new Map<string, string[]>();

  for (const file of files) {
    // Only real dispatch state files: `.json.lock` and `.json.tmp` siblings are
    // not parsed state.
    if (!file.startsWith("dispatch-") || !file.endsWith(".json")) continue;
    const path = join(stateDir, file);

    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch (err) {
      // The ONLY silent skip: the state GC may reclaim a file between the
      // directory scan and this read, so its absence is benign, not a source
      // failure.
      if (errnoCode(err) === "ENOENT") continue;
      problems.push({ code: "file-unreadable", path, message: errorText(err) });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      problems.push({ code: "malformed-file", path, message: errorText(err) });
      continue;
    }

    if (!isRecord(parsed) || !Array.isArray(parsed.tasks)) {
      problems.push({ code: "malformed-file", path, message: "dispatch state has no tasks array" });
      continue;
    }

    for (const row of parsed.tasks) {
      // Row-shaped noise (foreign/partial rows) is not a source failure.
      if (!isRecord(row)) continue;
      const { parentSessionId, sessionId } = row;
      if (typeof parentSessionId !== "string" || parentSessionId === "") continue;
      if (typeof sessionId !== "string" || sessionId === "") continue;
      const children = childrenByParent.get(parentSessionId);
      if (children) children.push(sessionId);
      else childrenByParent.set(parentSessionId, [sessionId]);
    }
  }

  // Bounded BFS over the collected edges. A session already in `sessionIds` is
  // never queued again, so cycles terminate and each node is visited once.
  const queue = [...sessionIds];
  for (let index = 0; index < queue.length; index += 1) {
    const sessionId = queue[index];
    for (const child of childrenByParent.get(sessionId) ?? []) {
      if (sessionIds.has(child)) continue;
      sessionIds.add(child);
      queue.push(child);
    }
  }

  return { sessionIds, complete: problems.length === 0, problems };
}
