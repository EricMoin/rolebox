import type { RecoveryStrategy, RecoveryStrategyContext, RecoveryStrategyResult } from "../types.ts";

export const abortStrategy: RecoveryStrategy = {
  name: "abort",
  async execute(ctx: RecoveryStrategyContext): Promise<RecoveryStrategyResult> {
    const message = (ctx.stepConfig.message as string) ?? "Recovery aborted: all strategies exhausted";
    ctx.inject(`\n[RECOVERY ABORTED] ${message}\nError: ${ctx.error.message}\n`);
    return { status: "abort", reason: message };
  },
};
