import type { RecoveryStrategy, RecoveryStrategyContext, RecoveryStrategyResult } from "../types.ts";

export const compactStrategy: RecoveryStrategy = {
  name: "compact",
  async execute(ctx: RecoveryStrategyContext): Promise<RecoveryStrategyResult> {
    const client = ctx.sessionClient;
    if (!client?.compact) {
      return { status: "next_strategy", reason: "compact not available on client" };
    }
    try {
      const ok = await client.compact(ctx.sessionID);
      if (ok) {
        return { status: "success", message: "context compacted" };
      }
      return { status: "next_strategy", reason: "compact returned false" };
    } catch {
      return { status: "next_strategy", reason: "compact failed" };
    }
  },
};
