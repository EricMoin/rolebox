/**
 * Graph Execution Engine v2 — Join strategy resolution (compatibility re-export)
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * The ONE definition of the join vocabulary — the declared `JoinConfig`, the
 * runtime `ResolvedJoinStrategy`, the resolver `resolveJoinStrategy` and the
 * quorum reader `readQuorum` — now lives in the neutral domain module
 * (`src/graph/domain/join.ts`, P1 item 2). This file re-exports it so existing
 * importers (`src/graph/outcome/graph-state.ts`,
 * `src/graph/persistence/declared-state.ts`) keep their current import path
 * WITHOUT a second definition. Nothing is declared here; the re-exported
 * bindings are the SAME objects the domain module exports.
 */

export { readQuorum, resolveJoinStrategy } from "./domain/join.ts";
export type { ResolvedJoinStrategy } from "./domain/join.ts";
