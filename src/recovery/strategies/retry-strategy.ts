import type { RecoveryStrategy, RecoveryStrategyContext, RecoveryStrategyResult } from "../types.ts";

export const retryStrategy: RecoveryStrategy = {
  name: "retry",
  async execute(ctx: RecoveryStrategyContext): Promise<RecoveryStrategyResult> {
    const maxRetries = (ctx.stepConfig.max_retries as number) ?? 2;
    const backoffMs = (ctx.stepConfig.backoff_ms as number) ?? 2000;
    const backoffFactor = (ctx.stepConfig.backoff_factor as number) ?? 2;

    if (ctx.attempt >= maxRetries) {
      return { status: "next_strategy", reason: `retry exhausted (${ctx.attempt}/${maxRetries})` };
    }

    const delay = backoffMs * Math.pow(backoffFactor, ctx.attempt);
    return { status: "retry", delayMs: delay, reason: `retrying (attempt ${ctx.attempt + 1}/${maxRetries})` };
  },
};
