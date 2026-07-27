/**
 * Graph Execution Engine v2 — Default `on_condition` Edge Resolver
 *
 * Version: 2.0
 * Date: 2026-07-24
 *
 * The default {@link EdgeConditionResolver}: evaluates a named `on_condition`
 * edge condition against a source node's runtime state.
 *
 * Condition-name vocabulary: the names supported here intentionally mirror the
 * built-in vocabulary in `src/function/conditions.ts` (see the `NAMED_CONDITIONS`
 * keys there) so a graph author writing `on_condition: signal_observed(...)` or
 * `artifact_exists(...)` gets the same names they already know from function
 * frontmatter gates/transitions. We deliberately do NOT import from that module
 * and do NOT reuse its `CondEnv`/`FnState` evaluation mechanism: the engine has
 * no `FnState`, and importing `conditions.ts` would pull in its load-time
 * side effects (`createSubLogger`, `registerCondition`). Only the *names* are
 * shared, as a vocabulary contract — the engine evaluates them against
 * {@link NodeRuntimeState} instead of a `CondEnv`.
 *
 * Supported conditions (engine-evaluable without a `CondEnv`):
 * - `signal_observed(<type>)` — true when the source node has recorded a
 *   signal of the given type in `signalsObserved` (key presence, any payload).
 * - `artifact_exists(<name>)` — true when a file/dir named `<name>` exists
 *   relative to `process.cwd()` (node:fs `existsSync`).
 *
 * Unsupported conditions: everything else — including the `CondEnv`-dependent
 * names in the shared vocabulary (`user_approval`, `plan_todos_complete`,
 * `evidence_met`, `tool_observed`, `turn_count`, `state_eq`, `plan_incomplete`)
 * — returns `false`. A caller needing richer semantics injects its own resolver
 * via `createEngine({ conditionResolver })`.
 *
 * Design reference: `.rolebox/design/engine-state-machine.md` §3.3.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NodeRuntimeState } from "../../types.engine-v2.ts";
import type { EdgeConditionResolver } from "./engine-advance.ts";

/** Matches a `name(arg)` condition call. Mirrors `CALL_RE` in conditions.ts. */
const CALL_RE = /^([a-z][a-z0-9_]*)\(([^)]*)\)$/;

/**
 * The default `on_condition` edge resolver.
 *
 * @param condition The named condition, e.g. `signal_observed(answer)` or
 *                  `artifact_exists(docs/report.md)`.
 * @param source    The upstream node the edge originates from — carries the
 *                  `signalsObserved` ledger evaluated by `signal_observed`.
 * @returns true when the condition is supported and evaluates true, otherwise
 *          false. Unknown / unsupported conditions never activate the edge.
 */
export const defaultConditionResolver: EdgeConditionResolver = (
  condition: string,
  source: NodeRuntimeState,
): boolean => {
  const call = condition.match(CALL_RE);
  const name = call ? call[1] : condition;
  const arg = call ? call[2].trim() : "";

  switch (name) {
    case "signal_observed":
      // Key presence in the per-node signal ledger — any recorded payload counts.
      return arg !== "" && source.signalsObserved[arg] !== undefined;

    case "artifact_exists":
      // Existence relative to the working directory.
      return arg !== "" && existsSync(join(process.cwd(), arg));

    default:
      // Unknown name, or a known-but-`CondEnv`-dependent name (user_approval,
      // plan_todos_complete, evidence_met, tool_observed, turn_count, state_eq,
      // plan_incomplete) that the engine cannot evaluate without a FnState.
      return false;
  }
};

export default defaultConditionResolver;
