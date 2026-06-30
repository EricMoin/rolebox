import type {
  GraphExecutionState,
} from "./state.ts";
import type {
  ResolvedGraph,
  LoopCondition,
  TerminationConfig,
} from "../types.ts";
import { normalizeResult, hashResult } from "./result-capture.ts";

export type JudgeFn = (prompt: string, context: string) => Promise<boolean>;

interface EvalResult {
  converged: boolean;
  resultMatch: boolean;
}

export async function evaluateAsync(
  state: GraphExecutionState,
  graph: ResolvedGraph,
  deps: { judge: JudgeFn },
): Promise<EvalResult> {
  const termination = graph.termination;
  if (!termination) return { converged: false, resultMatch: false };

  const config = termination.config;

  const hasConverged = hasConditionType(config.any_of, "converged")
    || hasConditionType(config.all_of, "converged");
  const hasResultMatch = hasConditionType(config.any_of, "result_matches")
    || hasConditionType(config.all_of, "result_matches");

  const context = buildContext(state);

  const converged = hasConverged
    ? await evaluateConverged(config, context, deps.judge)
    : false;

  const resultMatch = hasResultMatch
    ? evaluateResultMatches(config, state)
    : false;

  return { converged, resultMatch };
}

function hasConditionType(
  conditions: LoopCondition[] | undefined,
  type: "converged" | "result_matches",
): boolean {
  if (!conditions) return false;
  return conditions.some((c) => type in c);
}

function buildContext(state: GraphExecutionState): string {
  const parts: string[] = [];
  parts.push(`iterationCount: ${state.iterationCount}`);
  parts.push(`completed: [${state.completed.join(", ")}]`);
  parts.push(`frontier: [${state.frontier.join(", ")}]`);
  parts.push(`status: ${state.status}`);
  if (state.lastResults) {
    for (const [agent, entry] of Object.entries(state.lastResults)) {
      parts.push(`result[${agent}]: ${entry.text.slice(0, 500)}`);
    }
  }
  return parts.join("\n");
}

async function evaluateConverged(
  config: TerminationConfig,
  context: string,
  judge: JudgeFn,
): Promise<boolean> {
  const anyOf = await evaluateConvergedList(config.any_of, context, judge, "any");
  const allOf = await evaluateConvergedList(config.all_of, context, judge, "all");
  return anyOf && allOf;
}

async function evaluateConvergedList(
  conditions: LoopCondition[] | undefined,
  context: string,
  judge: JudgeFn,
  mode: "any" | "all",
): Promise<boolean> {
  if (!conditions || conditions.length === 0) return true;

  const convergedConditions = conditions.filter(
    (c): c is { converged: string } => "converged" in c,
  );

  if (convergedConditions.length === 0) return true;

  const results = await Promise.all(
    convergedConditions.map(async (c): Promise<boolean> => {
      try {
        return await judge(c.converged, context);
      } catch {
        return false;
      }
    }),
  );

  return mode === "any" ? results.some(Boolean) : results.every(Boolean);
}

function evaluateResultMatches(
  config: TerminationConfig,
  state: GraphExecutionState,
): boolean {
  const anyOf = evaluateResultMatchList(config.any_of, state, "any");
  const allOf = evaluateResultMatchList(config.all_of, state, "all");
  return anyOf && allOf;
}

function evaluateResultMatchList(
  conditions: LoopCondition[] | undefined,
  state: GraphExecutionState,
  mode: "any" | "all",
): boolean {
  if (!conditions || conditions.length === 0) return true;

  const resultConditions = conditions.filter(
    (c): c is Extract<LoopCondition, { result_matches: unknown }> =>
      "result_matches" in c,
  );

  if (resultConditions.length === 0) return true;

  const results = resultConditions.map((c) =>
    evaluateSingleResultMatch(c.result_matches, state),
  );

  return mode === "any" ? results.some(Boolean) : results.every(Boolean);
}

interface ResultMatchesSpec {
  agent: string;
  contains?: string;
  regex?: string;
  score_gte?: number;
  no_changes?: boolean;
}

function evaluateSingleResultMatch(
  spec: ResultMatchesSpec,
  state: GraphExecutionState,
): boolean {
  const stored = state.lastResults?.[spec.agent];
  if (!stored) return false;

  const text = stored.text;

  if (spec.contains !== undefined) {
    return text.includes(spec.contains);
  }

  if (spec.regex !== undefined) {
    try {
      return new RegExp(spec.regex).test(text);
    } catch {
      return false;
    }
  }

  if (spec.score_gte !== undefined) {
    const match = text.match(/score:\s*(\d+)/i);
    if (!match) return false;
    const score = Number(match[1]);
    if (isNaN(score)) return false;
    return score >= spec.score_gte;
  }

  if (spec.no_changes !== undefined) {
    const normalized = normalizeResult(text);
    return hashResult(normalized) === stored.hash;
  }

  return false;
}
