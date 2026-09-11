import type { RecoveryStrategy, RecoveryStrategyContext, RecoveryStrategyResult } from "../types.ts";

export const truncateStrategy: RecoveryStrategy = {
  name: "truncate",
  async execute(ctx: RecoveryStrategyContext): Promise<RecoveryStrategyResult> {
    const maxTruncations = (ctx.stepConfig.max_truncations as number) ?? 8;
    const targetRatio = (ctx.stepConfig.target_ratio as number) ?? 0.5;
    const minOutputSize = (ctx.stepConfig.min_output_size as number) ?? 500;

    if (ctx.attempt >= maxTruncations) {
      return { status: "next_strategy", reason: `truncate exhausted (${ctx.attempt}/${maxTruncations})` };
    }

    ctx.inject(
      `\n[CONTEXT TRUNCATION] Context is too large (attempt ${ctx.attempt + 1}/${maxTruncations}). ` +
      `Reduce output by ~${Math.round((1 - targetRatio) * 100)}%. ` +
      `Keep only essential information. Minimum output size: ${minOutputSize} chars.\n`
    );
    return { status: "retry", reason: `truncation directive injected (attempt ${ctx.attempt + 1}/${maxTruncations})` };
  },
};
