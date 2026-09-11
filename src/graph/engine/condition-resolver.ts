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
 *   The argument is normalized before the ledger lookup: surrounding
 *   whitespace is trimmed and the type is lowercased, so
 *   `signal_observed(ANSWER)`, `signal_observed( answer )`, and
 *   `signal_observed(Answer)` all match the lowercase signal-type key written
 *   by `recordSignalToLedger`. The vocabulary is all-lowercase, so the
 *   normalization is lossless. (A quoted argument, e.g.
 *   `signal_observed("answer")`, is NOT unquoted — quotes are not part of the
 *   vocabulary and the lookup fails.)
 * - `artifact_exists(<name>)` — true when a file/dir named `<name>` exists
 *   relative to the **engine process's** `process.cwd()` (node:fs
 *   `existsSync`). This is a documented contract: the base directory is the
 *   engine's working directory, NOT the graph's workspace or the source
 *   node's working directory. In a daemon / multi-project host those may
 *   differ, producing false positives or negatives for graph authors.
 *
 * Unsupported conditions: everything else evaluates `false`, including:
 * - the `CondEnv`-dependent names in the shared vocabulary (`user_approval`,
 *   `plan_todos_complete`, `evidence_met`, `tool_observed`, `turn_count`,
 *   `state_eq`, `plan_incomplete`); and
 * - **compound / boolean expressions** (e.g.
 *   `signal_observed(answer) and artifact_exists(x)`, `or`, negation): only
 *   single-argument `name(arg)` calls are recognized (see `CALL_RE` below);
 *   any other shape never matches and falls through to the default branch.
 *   There is no boolean algebra over conditions — a caller needing richer
 *   semantics injects its own resolver via `createEngine({ conditionResolver
 *   })`.
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
 *                  `artifact_exists(docs/report.md)`. `signal_observed`'s
 *                  argument is trimmed + lowercased before the ledger lookup;
 *                  `artifact_exists` resolves relative to the engine process's
 *                  cwd; compound expressions are unsupported and always false.
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
      // Key presence in the per-node signal ledger — any recorded payload
      // counts. The arg (already trimmed above) is lowercased so graph authors
      // can write `signal_observed(ANSWER)` / `signal_observed( answer )` and
      // still match the lowercase signal-type keys written verbatim by
      // `recordSignalToLedger` (signal-bridge.ts). All vocabulary signal types
      // are lowercase, so the normalization is lossless.
      return arg !== "" && source.signalsObserved[arg.toLowerCase()] !== undefined;

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
