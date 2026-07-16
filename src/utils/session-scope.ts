/**
 * Shared session-scope building logic.
 *
 * Reads raw dispatch state files to compute the set of child session IDs
 * that belong to a given parent session. Used by both the CLI monitor and
 * TUI sidebar to scope activity display to the current session's subtree.
 *
 * @module
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Build a set of session IDs that belong to the given parent session.
 *
 * Reads raw dispatch-*.json files (which contain parentSessionId, unlike
 * the MonitorSnapshot which strips it) and collects all childSessionIds
 * where parentSessionId === currentSessionId.
 *
 * Also includes the currentSessionId itself (for functions activated
 * directly in the primary session).
 */
export function buildSessionScope(stateDir: string, currentSessionId: string): Set<string> {
  const scope = new Set<string>([currentSessionId]);
  try {
    for (const f of readdirSync(stateDir)) {
      if (!f.startsWith("dispatch-") || !f.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(readFileSync(join(stateDir, f), "utf-8") as string) as {
          tasks?: Array<{ parentSessionId?: string; sessionId?: string }>;
        };
        for (const t of raw.tasks ?? []) {
          if (t.parentSessionId === currentSessionId && t.sessionId) {
            scope.add(t.sessionId);
          }
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* dir missing */ }
  return scope;
}
