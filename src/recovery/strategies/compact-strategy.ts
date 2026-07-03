import type { RecoveryStrategy, RecoveryStrategyContext, RecoveryStrategyResult } from "../types.ts";

export const compactStrategy: RecoveryStrategy = {
  name: "compact",
  async execute(ctx: RecoveryStrategyContext): Promise<RecoveryStrategyResult> {
    // The client may have a compact/session method
    const client = ctx.client as { session?: { compact?: (args: { path: { id: string } }) => Promise<unknown> } } | undefined;
    if (!client?.session?.compact) {
      return { status: "next_strategy", reason: "compact not available on client" };
    }
    try {
      await client.session.compact({ path: { id: ctx.sessionID } });
      return { status: "success", message: "context compacted" };
    } catch {
      return { status: "next_strategy", reason: "compact failed" };
    }
  },
};
