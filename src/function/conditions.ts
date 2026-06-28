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

function evalNamed(name: string, env: CondEnv): boolean {
  const call = name.match(/^([a-z_]+)\(([^)]*)\)$/);
  const id = call ? call[1] : name;
  const arg = call ? call[2].trim() : "";
  switch (id) {
    case "user_approval":       return env.userMessagedThisTurn;
    case "artifact_exists":     return env.artifacts.exists(env.sessionID, arg);
    case "plan_todos_complete": return uncheckedTodos(env) === 0;
    case "evidence_met":        return env.requiredEvidence.every((t) => env.state.evidenceObserved[t] === true);
    case "tool_observed":       return env.state.toolsObserved.includes(arg);
    case "turn_count":          return (env.state.currentTurn - env.state.activatedAtTurn) >= Number(arg || "0");
    case "state_eq": {
      const [k, v] = arg.split("=");
      return String(env.state.kv[k?.trim()]) === (v?.trim() ?? "");
    }
    default:                    return false;
  }
}

export function evaluateCondition(cond: Condition | undefined, env: CondEnv): boolean {
  if (cond === undefined) return false;
  if (typeof cond === "string") return evalNamed(cond, env);
  if ("all" in cond) return cond.all.every((c) => evaluateCondition(c, env));
  if ("any" in cond) return cond.any.some((c) => evaluateCondition(c, env));
  if ("not" in cond) return !evaluateCondition(cond.not, env);
  return false;
}

/** The ONLY allowed named conditions — validate frontmatter against this. */
export const KNOWN_CONDITIONS = new Set([
  "user_approval", "artifact_exists", "plan_todos_complete",
  "evidence_met", "tool_observed", "turn_count", "state_eq",
]);
