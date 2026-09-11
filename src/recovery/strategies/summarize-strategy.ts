import type { RecoveryStrategy, RecoveryStrategyContext, RecoveryStrategyResult } from "../types.ts";

export const summarizeStrategy: RecoveryStrategy = {
  name: "summarize",
  async execute(ctx: RecoveryStrategyContext): Promise<RecoveryStrategyResult> {
    const model = (ctx.stepConfig.model as string) ?? "default";
    const client = ctx.sessionClient;

    if (!client?.prompt) {
      // Fallback: inject a summarize directive
      ctx.inject(
        `\n[CONTEXT SUMMARIZATION] Summarize the conversation so far, keeping key decisions, ` +
        `artifacts, and pending tasks. Then continue.\n`
      );
      return { status: "retry", reason: "summarize directive injected" };
    }

    try {
      await client.prompt(ctx.sessionID, {
        parts: [{ type: "text", text: `[RECOVERY] Summarize context to reduce token usage. Error was: ${ctx.error.message}` }],
        model: { providerID: "fallback", modelID: model },
      });
      return { status: "success", message: "context summarized via fallback model" };
    } catch {
      // Fallback to directive injection
      ctx.inject(
        `\n[CONTEXT SUMMARIZATION] Summarize the conversation so far, keeping key decisions, ` +
        `artifacts, and pending tasks. Then continue.\n`
      );
      return { status: "retry", reason: "summarize directive injected (API fallback)" };
    }
  },
};
