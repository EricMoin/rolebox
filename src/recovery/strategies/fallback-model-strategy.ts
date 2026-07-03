import type { RecoveryStrategy, RecoveryStrategyContext, RecoveryStrategyResult } from "../types.ts";

export const fallbackModelStrategy: RecoveryStrategy = {
  name: "fallback_model",
  async execute(ctx: RecoveryStrategyContext): Promise<RecoveryStrategyResult> {
    const model = ctx.stepConfig.model as string | undefined;
    if (!model) {
      return { status: "next_strategy", reason: "no fallback model configured" };
    }
    const client = ctx.client as { session?: { promptAsync?: (args: { path: { id: string }; body: Record<string, unknown> }) => Promise<unknown> } } | undefined;
    if (!client?.session?.promptAsync) {
      return { status: "next_strategy", reason: "promptAsync not available" };
    }
    try {
      await client.session.promptAsync({
        path: { id: ctx.sessionID },
        body: {
          parts: [{ type: "text", text: `[RECOVERY] Retrying with fallback model after error: ${ctx.error.message}` }],
          model: { providerID: "fallback", modelID: model },
        },
      });
      return { status: "success", message: "re-prompted with fallback model" };
    } catch {
      return { status: "next_strategy", reason: "fallback model prompt failed" };
    }
  },
};
