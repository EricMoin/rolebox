import type { FnState } from "./runtime-state.ts";

export interface SafetyConfig {
  globalMaxTurns: number;
  perFnMax: number;
}

export interface ContinuationDecision {
  shouldContinue: boolean;
  reminder?: string;
  reason: string;
}

export function decideContinuation(opts: {
  fnName: string;
  st: FnState;
  reason: string;
  cfg: SafetyConfig;
  totalContinuationsThisBurst: number;
  lastTwoOutputsIdentical?: boolean;
  modelAskedQuestion?: boolean;
}): ContinuationDecision {
  const { st, cfg } = opts;

  if (opts.totalContinuationsThisBurst >= cfg.globalMaxTurns) {
    return { shouldContinue: false, reason: "global cap" };
  }
  if (st.continuationCount >= cfg.perFnMax) {
    return { shouldContinue: false, reason: "per-fn cap" };
  }
  if (opts.lastTwoOutputsIdentical) {
    return { shouldContinue: false, reason: "loop detected" };
  }
  if (opts.modelAskedQuestion) {
    return { shouldContinue: false, reason: "model asked a question" };
  }
  if (st.currentTurn < st.cooldownUntilTurn) {
    return { shouldContinue: false, reason: "cooldown" };
  }

  st.continuationCount += 1;
  if (st.continuationCount === 3) {
    st.cooldownUntilTurn = st.currentTurn + 1;
  }
  if (st.continuationCount === 5) {
    st.cooldownUntilTurn = st.currentTurn + 3;
  }

  const reminder = `<system-reminder>[auto-continue ${st.continuationCount}/${cfg.perFnMax} for ${opts.fnName}: ${opts.reason}] Continue until this function's completion condition is met. Do not stop yet.</system-reminder>`;

  return { shouldContinue: true, reminder, reason: opts.reason };
}
