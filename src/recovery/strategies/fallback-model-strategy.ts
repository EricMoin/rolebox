import type { RecoveryStrategy, RecoveryStrategyContext, RecoveryStrategyResult } from "../types.ts";

export const fallbackModelStrategy: RecoveryStrategy = {
  name: "fallback_model",
  async execute(ctx: RecoveryStrategyContext): Promise<RecoveryStrategyResult> {
    const model = ctx.stepConfig.model as string | undefined;
    if (!model) {
      return { status: "next_strategy", reason: "no fallback model configured" };
    }
    const client = ctx.sessionClient;
    if (!client?.prompt) {
      return { status: "next_strategy", reason: "prompt not available" };
    }
    try {
      await client.prompt(ctx.sessionID, {
        parts: [{ type: "text", text: `[RECOVERY] Retrying with fallback model after error: ${ctx.error.message}` }],
        model: { providerID: "fallback", modelID: model },
      });
      return { status: "success", message: "re-prompted with fallback model" };
    } catch {
      return { status: "next_strategy", reason: "fallback model prompt failed" };
    }
  },
};
