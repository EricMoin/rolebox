import type { FnState } from "./runtime-state.ts";

export interface CooldownRule {
  atCount: number;
  cooldownTurns: number;
}

export interface SafetyConfig {
  globalMaxTurns: number;
  perFnMax: number;
  /**
   * When `continuationCount` reaches `atCount`, force a cooldown of
   * `cooldownTurns` turns. Defaults to {@link DEFAULT_COOLDOWN_RULES}.
   */
  cooldownRules?: CooldownRule[];
}

export const DEFAULT_COOLDOWN_RULES: CooldownRule[] = [
  { atCount: 3, cooldownTurns: 1 },
  { atCount: 5, cooldownTurns: 3 },
];

export interface ContinuationDecision {
  shouldContinue: boolean;
  reminder?: string;
  reason: string;
}

export interface ContinuationInput {
  fnName: string;
  st: FnState;
  reason: string;
  cfg: SafetyConfig;
  totalContinuationsThisBurst: number;
  lastTwoOutputsIdentical?: boolean;
  modelAskedQuestion?: boolean;
}

function blockingReason(opts: ContinuationInput): string | null {
  const { st, cfg } = opts;
  if (opts.totalContinuationsThisBurst >= cfg.globalMaxTurns) return "global cap";
  if (st.continuationCount >= cfg.perFnMax) return "per-fn cap";
  if (opts.lastTwoOutputsIdentical) return "loop detected";
  if (opts.modelAskedQuestion) return "model asked a question";
  if (st.currentTurn < st.cooldownUntilTurn) return "cooldown";
  return null;
}

/**
 * SIDE EFFECT: when continuation is allowed this mutates `opts.st`
 * (increments `continuationCount` and may set `cooldownUntilTurn`). Call
 * exactly once per decision point — a second call counts as another turn.
 */
export function decideContinuation(opts: ContinuationInput): ContinuationDecision {
  const blocked = blockingReason(opts);
  if (blocked) return { shouldContinue: false, reason: blocked };

  const { st, cfg } = opts;
  st.continuationCount += 1;
  for (const rule of cfg.cooldownRules ?? DEFAULT_COOLDOWN_RULES) {
    if (st.continuationCount === rule.atCount) {
      st.cooldownUntilTurn = st.currentTurn + rule.cooldownTurns;
    }
  }

  const finalWarning =
    st.continuationCount >= cfg.perFnMax
      ? " This is your FINAL continuation — produce your output NOW, even if incomplete."
      : "";
  const reminder = `<system-reminder>[auto-continue ${st.continuationCount}/${cfg.perFnMax} for ${opts.fnName}: ${opts.reason}] Self-diagnose before continuing. FALSE continuation: your last action was a non-blocking dispatch (e.g., graph_run returned "running") or you are awaiting approval / an external result, AND no newly-arrived results arrived this turn → emit signal(type="blocked") and end the turn; do NOT narrate, do NOT poll. LEGITIMATE continuation: a concrete next step is executable right now with information already available → continue working. Tie-breaker: Can I do real work with what I have right now? No → blocked; Yes → continue.${finalWarning}</system-reminder>`;

  return { shouldContinue: true, reminder, reason: opts.reason };
}
