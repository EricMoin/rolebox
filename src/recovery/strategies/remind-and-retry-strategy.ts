import type { RecoveryStrategy, RecoveryStrategyContext, RecoveryStrategyResult } from "../types.ts";

export const remindAndRetryStrategy: RecoveryStrategy = {
  name: "remind_and_retry",
  async execute(ctx: RecoveryStrategyContext): Promise<RecoveryStrategyResult> {
    const maxRetries = (ctx.stepConfig.max_retries as number) ?? 2;
    const reminderText = (ctx.stepConfig.reminder_text as string) ??
      `[ERROR] A recovery action is needed. Please check your last action and retry.`;

    if (ctx.attempt >= maxRetries) {
      return { status: "next_strategy", reason: `remind_and_retry exhausted (${ctx.attempt}/${maxRetries})` };
    }

    ctx.inject(`\n${reminderText}\n`);
    return { status: "retry", delayMs: 1000, reason: `reminder injected (attempt ${ctx.attempt + 1}/${maxRetries})` };
  },
};
