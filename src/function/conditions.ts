import type { Condition } from "../types.ts";
import type { FnState } from "./runtime-state.ts";
import type { ArtifactStore } from "./artifact-store.ts";
import { createSubLogger } from "../logger.ts";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";


const log = createSubLogger("conditions");

export interface CondEnv {
  sessionID: string;
  fnName: string;
  state: FnState;
  artifacts: ArtifactStore;
  requiredEvidence: string[];
  userMessagedThisTurn: boolean;
  workspaceDir: string;
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
 *
 * Built-in conditions:
 * - `user_approval()` — true when the user messaged this turn
 * - `artifact_exists(name)` — true when the named artifact file exists
 * - `plan_todos_complete()` — true when all todo items are checked
 * - `evidence_met()` — true when all required evidence is observed
 * - `tool_observed(name)` — true when the named tool has been called
 * - `signal_observed(type)` — true when the `signal` tool was called with the given type
 * - `turn_count(n)` — true when N or more turns have passed since activation
 * - `plan_incomplete(name)` — true when plan file has unchecked `- [ ]` checkboxes
 */
const NAMED_CONDITIONS: Record<string, (arg: string, env: CondEnv) => boolean> = {
  user_approval:       (_arg, env) => env.userMessagedThisTurn,
  artifact_exists:     (arg, env) => env.artifacts.exists(env.sessionID, arg),
  plan_todos_complete: (_arg, env) => uncheckedTodos(env) === 0,
  evidence_met:        (_arg, env) => env.requiredEvidence.every((t) => env.state.evidenceObserved[t] === true),
  tool_observed:       (arg, env) => env.state.toolsObserved.includes(arg),
  signal_observed:    (arg, env) => {
    const raw = env.state.kv["__signals_observed"];
    // Record format: Record<string, unknown> where key = signal type
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      return arg in (raw as Record<string, unknown>);
    }
    // Legacy string-array format (pre-ledger migration)
    if (Array.isArray(raw)) {
      return (raw as string[]).includes(arg);
    }
    return false;
  },
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

/** Known condition names, derived from NAMED_CONDITIONS keys.
 * Includes both built-in conditions and any registered via registerCondition().
 */
export const KNOWN_CONDITIONS = new Set<string>(Object.keys(NAMED_CONDITIONS));

/**
 * Refresh KNOWN_CONDITIONS to include any dynamically registered conditions.
 * Called after registerCondition() adds new entries.
 */
export function refreshKnownConditions(): void {
  for (const key of Object.keys(NAMED_CONDITIONS)) {
    KNOWN_CONDITIONS.add(key);
  }
}

/**
 * Register a custom named condition at runtime.
 * If the name already exists, logs a warning and overwrites.
 * @param name Condition name (used in frontmatter gate/transition/continue_until)
 * @param handler Function that evaluates the condition given an arg string and CondEnv
 */
export function registerCondition(
  name: string,
  handler: (arg: string, env: CondEnv) => boolean,
): void {
  if (NAMED_CONDITIONS[name]) {
    log.warn(`Condition '${name}' already registered — overwriting`);
  }
  NAMED_CONDITIONS[name] = handler;
  refreshKnownConditions();
}

registerCondition("plan_incomplete", (arg, env) => {
  const plansDir = join(env.workspaceDir, ".rolebox", "plans");
  const names: string[] = arg
    ? [arg]
    : (() => {
        try {
          return readdirSync(plansDir)
            .filter((f) => f.endsWith(".md"))
            .map((f) => f.slice(0, -3));
        } catch {
          return [];
        }
      })();
  for (const name of names) {
    try {
      const content = readFileSync(join(plansDir, `${name}.md`), "utf-8");
      if (/\- \[ \]/.test(content)) return true;
    } catch {
      continue;
    }
  }
  return false;
});
