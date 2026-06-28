import type { ResolvedFunction } from "../types.ts";
import { evaluateCondition, type CondEnv } from "./conditions.ts";

export interface TransitionResult {
  activate: string[];
  deactivate: string[];
}

export function evaluateGateAndTransitions(
  fn: ResolvedFunction,
  env: CondEnv,
): TransitionResult {
  const st = env.state;
  const out: TransitionResult = { activate: [], deactivate: [] };
  if (fn.gate !== undefined) {
    st.gateSatisfied = evaluateCondition(fn.gate, env);
    st.phase = st.gateSatisfied ? "active" : "gated";
  }
  for (const t of fn.transitions ?? []) {
    const fired =
      t.when === "gate"
        ? st.gateSatisfied
        : evaluateCondition(t.when, env);
    if (fired) {
      out.activate.push(...(t.activate ?? []));
      out.deactivate.push(...(t.deactivate ?? []));
    }
  }
  return out;
}
