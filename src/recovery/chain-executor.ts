import type {
  RecoveryConfig,
  RecoveryChainConfig,
  RecoveryStrategyContext,
  RecoveryStrategyResult,
  RecoveryAttempt,
  RecoveryError,
} from "./types.ts";
import type { StrategyRegistry } from "./strategies/registry.ts";
import { createSubLogger } from "../logger.ts";
import type { ISessionClient } from "../platform/ports/session-client.ts";

const log = createSubLogger("recovery:chain-executor");

export interface ChainResult {
  status: "recovered" | "exhausted" | "aborted";
  finalError?: string;
  totalAttempts: number;
}

export class RecoveryChainExecutor {
  constructor(
    private registry: StrategyRegistry,
    private config: RecoveryConfig,
  ) {}

  async executeChain(
    sessionID: string,
    error: RecoveryError,
    chainConfig: RecoveryChainConfig,
    inject: (text: string) => void,
    client?: ISessionClient,
    onAttempt?: (attempt: RecoveryAttempt) => void,
  ): Promise<ChainResult> {
    if (chainConfig.enabled === false) {
      return { status: "exhausted", finalError: "chain disabled", totalAttempts: 0 };
    }

    const chain = chainConfig.chain;
    if (chain.length === 0) {
      return { status: "exhausted", finalError: "empty chain", totalAttempts: 0 };
    }

    let stepIndex = 0;
    let totalAttempts = 0;
    let stepAttempt = 0;

    while (stepIndex < chain.length) {
      if (totalAttempts >= this.config.maxTotalAttempts) {
        log.debug("Chain exhausted: global attempt limit reached", { sessionID, totalAttempts });
        return { status: "exhausted", finalError: "global attempt limit reached", totalAttempts };
      }

      const step = chain[stepIndex];
      const strategy = this.registry.get(step.strategy);

      if (!strategy) {
        log.warn("Strategy not found, skipping step", { strategy: step.strategy, sessionID });
        stepIndex++;
        stepAttempt = 0;
        continue;
      }

      const ctx: RecoveryStrategyContext = {
        sessionID,
        error,
        attempt: stepAttempt,
        stepConfig: step.config ?? {},
        inject,
        sessionClient: client,
      };

      let result: RecoveryStrategyResult;
      try {
        result = await strategy.execute(ctx);
      } catch (err) {
        log.warn("Strategy threw during execution", { strategy: step.strategy, err });
        result = { status: "next_strategy", reason: `strategy threw: ${err instanceof Error ? err.message : String(err)}` };
      }

      totalAttempts++;

      const attemptRecord: RecoveryAttempt = {
        category: error.category,
        errorType: error.errorType,
        timestamp: Date.now(),
        chainPosition: stepIndex,
        strategy: step.strategy,
        result: result.status,
        message: "message" in result ? result.message : "reason" in result ? result.reason : undefined,
      };
      onAttempt?.(attemptRecord);

      log.debug("Strategy executed", {
        sessionID, strategy: step.strategy, step: stepIndex,
        result: result.status, totalAttempts,
      });

      switch (result.status) {
        case "success":
          return { status: "recovered", totalAttempts, finalError: result.message };

        case "retry": {
          stepAttempt++;
          if (result.delayMs && result.delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, result.delayMs));
          }
          // Stay on same step (stepIndex unchanged)
          continue;
        }

        case "next_strategy":
          stepIndex++;
          stepAttempt = 0;
          continue;

        case "abort":
          return { status: "aborted", finalError: result.reason, totalAttempts };
      }
    }

    // Fell off end of chain
    return { status: "exhausted", finalError: "chain exhausted", totalAttempts };
  }
}
