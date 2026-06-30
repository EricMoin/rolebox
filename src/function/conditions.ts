import type { Condition } from "../types.ts";
import type { FnState } from "./runtime-state.ts";
import type { ArtifactStore } from "./artifact-store.ts";

export interface CondEnv {
  sessionID: string;
  fnName: string;
  state: FnState;
  artifacts: ArtifactStore;
  requiredEvidence: string[];
  userMessagedThisTurn: boolean;
}

/** Count unchecked "- [ ]" boxes in the synced todo blob (kv.__todos) or an artifact. */
function uncheckedTodos(env: CondEnv): number {
  const blob = (env.state.kv["__todos"] as string) ?? env.artifacts.read(env.sessionID, "plan") ?? "";
  const m = blob.match(/- \[ \]/g);
  return m ? m.length : 0;
}

function stateEquals(arg: string, env: CondEnv): boolean {
  const eq = arg.indexOf("=");
  const key = (eq === -1 ? arg : arg.slice(0, eq)).trim();
  const expected = eq === -1 ? "" : arg.slice(eq + 1).trim();
  return String(env.state.kv[key]) === expected;
}

/**
 * Closed vocabulary of named conditions, each mapping a parsed argument plus
 * the evaluation environment to a boolean. This object is the single source of
 * truth — {@link KNOWN_CONDITIONS} is derived from its keys so the validator
 * can never drift from the implementations.
 */
const NAMED_CONDITIONS: Record<string, (arg: string, env: CondEnv) => boolean> = {
  user_approval:       (_arg, env) => env.userMessagedThisTurn,
  artifact_exists:     (arg, env) => env.artifacts.exists(env.sessionID, arg),
  plan_todos_complete: (_arg, env) => uncheckedTodos(env) === 0,
  evidence_met:        (_arg, env) => env.requiredEvidence.every((t) => env.state.evidenceObserved[t] === true),
  tool_observed:       (arg, env) => env.state.toolsObserved.includes(arg),
  turn_count:          (arg, env) => (env.state.currentTurn - env.state.activatedAtTurn) >= Number(arg || "0"),
  state_eq:            stateEquals,
};

const CALL_RE = /^([a-z][a-z0-9_]*)\(([^)]*)\)$/;

function evalNamed(name: string, env: CondEnv): boolean {
  const call = name.match(CALL_RE);
  const id = call ? call[1] : name;
  const arg = call ? call[2].trim() : "";
  const handler = NAMED_CONDITIONS[id];
  return handler ? handler(arg, env) : false;
}

export function evaluateCondition(cond: Condition | undefined, env: CondEnv): boolean {
  if (cond === undefined) return false;
  if (typeof cond === "string") return evalNamed(cond, env);
  if ("all" in cond) return cond.all.every((c) => evaluateCondition(c, env));
  if ("any" in cond) return cond.any.some((c) => evaluateCondition(c, env));
  if ("not" in cond) return !evaluateCondition(cond.not, env);
  return false;
}

/** The ONLY allowed named conditions, derived from the registry above. */
export const KNOWN_CONDITIONS = new Set(Object.keys(NAMED_CONDITIONS));
