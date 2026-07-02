import type { FunctionCall } from "../function-parser.js";
import type { LoopMode } from "./types.js";
import { DEFAULT_ITERATIONS, MAX_ITERATIONS_HARD_CAP } from "./constants.js";

export interface ValidLoopParams {
  valid: true;
  iterations: number;
  mode: LoopMode;
  clamped?: boolean;
  warning?: string;
}

export interface InvalidLoopParams {
  valid: false;
  reason: string;
}

export type LoopParamsResult = ValidLoopParams | InvalidLoopParams;

const FRESH_ALIASES = new Set(["no-inherit", "off", "false"]);
const INHERIT_ALIASES = new Set(["on", "true"]);

/**
 * Parse a `FunctionCall` from `|loop:N,mode|` syntax into validated loop params.
 *
 * @param call - FunctionCall with `args` containing `_0`/`iterations` and `_1`/`mode`.
 *
 * Mode semantics in the unified-seed model:
 * - `"inherit"`: Prepend the unified summary from the previous round as a seed
 *   context for the next round (aliases: `"on"`, `"true"`).
 * - `"fresh"`: Start each round with no seed context — a clean slate
 *   (aliases: `"no-inherit"`, `"off"`, `"false"`).
 */
export function parseLoopParams(call: FunctionCall): LoopParamsResult {
  const { args } = call;

  const iterationsRaw =
    args.iterations !== undefined ? args.iterations : args._0;
  const modeRaw = args.mode !== undefined ? args.mode : args._1;

  let iterations: number;
  if (iterationsRaw === undefined || iterationsRaw === "") {
    iterations = DEFAULT_ITERATIONS;
  } else {
    const parsed = parseInt(iterationsRaw, 10);
    if (isNaN(parsed)) {
      iterations = DEFAULT_ITERATIONS;
    } else {
      iterations = parsed;
    }
  }

  if (iterations < 1) {
    return { valid: false, reason: "iterations must be >= 1" };
  }

  let clamped = false;
  if (iterations > MAX_ITERATIONS_HARD_CAP) {
    iterations = MAX_ITERATIONS_HARD_CAP;
    clamped = true;
  }

  let mode: LoopMode = "inherit";
  let warning: string | undefined;

  if (modeRaw !== undefined && modeRaw !== "") {
    const lower = modeRaw.toLowerCase();

    if (lower === "inherit") {
      mode = "inherit";
    } else if (lower === "fresh") {
      mode = "fresh";
    } else if (FRESH_ALIASES.has(lower)) {
      mode = "fresh";
    } else if (INHERIT_ALIASES.has(lower)) {
      mode = "inherit";
    } else {
      warning = `unknown mode "${modeRaw}" — defaulting to inherit`;
    }
  }

  return { valid: true, iterations, mode, ...(clamped ? { clamped } : {}), ...(warning ? { warning } : {}) };
}
