import type {
  TerminationReason,
  LoopCondition,
  ResolvedGraph,
} from "../types.ts";

const PRIORITY: Record<TerminationReason, number> = {
  converged: 0,
  result_match: 1,
  stuck: 2,
  max_iterations: 3,
  timeout: 4,
  error: 5,
};

interface EvalState {
  loopCounters?: Record<string, number>;
  lastResults?: Record<string, { hash: string; text: string }>;
  loopStartTimeMs?: number;
}

interface AsyncResults {
  converged?: boolean;
  resultMatch?: boolean;
}

function reasonPriority(a: TerminationReason, b: TerminationReason): number {
  return (PRIORITY[a] ?? 99) - (PRIORITY[b] ?? 99);
}

function conditionReason(cond: LoopCondition): TerminationReason {
  if ("max_iterations" in cond) return "max_iterations";
  if ("timeout_ms" in cond) return "timeout";
  if ("stuck" in cond) return "stuck";
  if ("converged" in cond) return "converged";
  if ("result_matches" in cond) return "result_match";
  return "error";
}

function checkCondition(
  cond: LoopCondition,
  state: EvalState,
  graph: ResolvedGraph,
  now: number,
  async?: AsyncResults,
): boolean {
  if ("max_iterations" in cond) {
    for (const group of graph.termination?.loopGroups ?? []) {
      if (group.maxIterations == null) continue;
      const counter = state.loopCounters?.[group.id] ?? 0;
      if (counter >= group.maxIterations) return true;
    }
    return false;
  }

  if ("timeout_ms" in cond) {
    const start = state.loopStartTimeMs ?? now;
    return now - start >= cond.timeout_ms;
  }

  if ("stuck" in cond) {
    const results = state.lastResults;
    if (!results) return false;
    const freq = new Map<string, number>();
    for (const r of Object.values(results)) {
      freq.set(r.hash, (freq.get(r.hash) ?? 0) + 1);
    }
    return Math.max(0, ...freq.values()) >= cond.stuck.repeats;
  }

  if ("converged" in cond) {
    return async?.converged === true;
  }

  if ("result_matches" in cond) {
    return async?.resultMatch === true;
  }

  return false;
}

export function evaluateSync(
  state: EvalState,
  graph: ResolvedGraph,
  now: number,
  asyncResults?: AsyncResults,
): TerminationReason | null {
  const term = graph.termination;
  if (!term) return null;

  const cfg = term.config;
  if (!cfg.any_of?.length && !cfg.all_of?.length) return null;

  if (cfg.any_of?.length) {
    for (const cond of cfg.any_of) {
      if (checkCondition(cond, state, graph, now, asyncResults)) {
        return conditionReason(cond);
      }
    }
  }

  if (cfg.all_of?.length) {
    const satisfied: TerminationReason[] = [];
    for (const cond of cfg.all_of) {
      if (checkCondition(cond, state, graph, now, asyncResults)) {
        satisfied.push(conditionReason(cond));
      }
    }
    if (satisfied.length === cfg.all_of.length) {
      satisfied.sort(reasonPriority);
      return satisfied[0];
    }
  }

  return null;
}
