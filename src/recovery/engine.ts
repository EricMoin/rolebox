import type { RecoveryConfig, RecoveryError, RecoveryErrorCategory, RecoveryAttempt } from "./types.ts";
import { RecoveryStateStore } from "./state.ts";
import { RecoveryMetricsCollector } from "./metrics.ts";
import { PatternRegistry, createDefaultPatterns } from "./error-detection.ts";
import { StrategyRegistry } from "./strategies/registry.ts";
import { registerBuiltinStrategies } from "./strategies/index.ts";
import { RecoveryChainExecutor } from "./chain-executor.ts";
import { appendCorrection } from "../hooks/context.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("recovery:engine");

export interface RecoveryEngineDeps {
  /** Map of pending corrections keyed by sessionID — used for prompt injection */
  pendingCorrections: Map<string, string>;
  /** Optional opencode client for strategies that need API access */
  client?: unknown;
}

export class RecoveryEngine {
  private config: RecoveryConfig;
  private stateStore: RecoveryStateStore;
  private metrics: RecoveryMetricsCollector;
  private patternRegistry: PatternRegistry;
  private strategyRegistry: StrategyRegistry;
  private chainExecutor: RecoveryChainExecutor;
  private deps: RecoveryEngineDeps;

  constructor(
    config: RecoveryConfig,
    stateStore: RecoveryStateStore,
    deps: RecoveryEngineDeps,
  ) {
    this.config = config;
    this.stateStore = stateStore;
    this.deps = deps;

    this.metrics = new RecoveryMetricsCollector();

    this.patternRegistry = new PatternRegistry();
    for (const pattern of createDefaultPatterns()) {
      this.patternRegistry.register(pattern);
    }

    this.strategyRegistry = new StrategyRegistry();
    registerBuiltinStrategies(this.strategyRegistry);

    this.chainExecutor = new RecoveryChainExecutor(this.strategyRegistry, this.config);

    log.info("RecoveryEngine initialized", {
      enabled: config.enabled,
      chains: Object.keys(config.chains),
      strategies: this.strategyRegistry.names(),
    });
  }

  /**
   * Attempt to recover from an error.
   * @param sessionID The session that encountered the error
   * @param error The error to recover from
   * @param category Optional explicit category; auto-detected if not provided
   * @returns Recovery outcome
   */
  async recover(
    sessionID: string,
    error: unknown,
    category?: RecoveryErrorCategory,
  ): Promise<{ recovered: boolean; message?: string }> {
    if (!this.config.enabled) {
      return { recovered: false };
    }

    let recoveryError: RecoveryError | null;
    if (category) {
      recoveryError = this.patternRegistry.detectCategory(error, category);
      // If explicit category provided but no pattern matched, construct a basic error
      if (!recoveryError) {
        const msg = typeof error === "string" ? error :
          error instanceof Error ? error.message :
          typeof error === "object" && error !== null && typeof (error as Record<string, unknown>).message === "string"
            ? (error as Record<string, unknown>).message as string
            : String(error ?? "");
        recoveryError = {
          category,
          errorType: "unknown",
          message: msg,
          raw: error,
          timestamp: Date.now(),
        };
      }
    } else {
      recoveryError = this.patternRegistry.detectFirst(error);
      if (!recoveryError) {
        log.debug("No recovery pattern matched for error", { sessionID });
        return { recovered: false };
      }
    }

    if (this.config.collectMetrics) {
      this.metrics.recordErrorType(recoveryError.errorType);
    }

    const chainConfig = this.config.chains[recoveryError.category];
    if (!chainConfig || chainConfig.enabled === false) {
      log.debug("No recovery chain for category", { category: recoveryError.category, sessionID });
      return { recovered: false };
    }

    // inject closure uses appendCorrection for prompt injection
    const inject = (text: string): void => {
      appendCorrection(this.deps.pendingCorrections, sessionID, text);
    };

    // onAttempt records to both state store and metrics
    const onAttempt = (attempt: RecoveryAttempt): void => {
      if (this.config.persistState) {
        this.stateStore.recordAttempt(sessionID, attempt);
      }
      if (this.config.collectMetrics) {
        this.metrics.recordAttempt(attempt.category, attempt.strategy, attempt.result);
      }
    };

    log.info("Starting recovery chain", {
      sessionID,
      category: recoveryError.category,
      errorType: recoveryError.errorType,
      chainLength: chainConfig.chain.length,
    });

    const result = await this.chainExecutor.executeChain(
      sessionID,
      recoveryError,
      chainConfig,
      inject,
      this.deps.client,
      onAttempt,
    );

    if (this.config.collectMetrics) {
      this.metrics.recordChainOutcome(recoveryError.category, result.status);
    }

    switch (result.status) {
      case "recovered":
        log.info("Recovery successful", { sessionID, totalAttempts: result.totalAttempts });
        if (this.config.persistState) {
          this.stateStore.delete(sessionID);
        }
        return { recovered: true, message: result.finalError };

      case "aborted":
        log.warn("Recovery aborted", { sessionID, reason: result.finalError, totalAttempts: result.totalAttempts });
        return { recovered: false, message: result.finalError };

      case "exhausted":
        log.warn("Recovery exhausted", { sessionID, reason: result.finalError, totalAttempts: result.totalAttempts });
        return { recovered: false, message: result.finalError };
    }
  }

  registerStrategy(strategy: import("./types.ts").RecoveryStrategy): void {
    this.strategyRegistry.register(strategy);
  }

  registerErrorPattern(pattern: import("./types.ts").ErrorPattern): void {
    this.patternRegistry.register(pattern);
  }

  getMetrics(): import("./types.ts").RecoveryMetricsSnapshot {
    return this.metrics.getSnapshot();
  }

  getPatternRegistry(): PatternRegistry {
    return this.patternRegistry;
  }

  getStrategyRegistry(): StrategyRegistry {
    return this.strategyRegistry;
  }

  async dispose(): Promise<void> {
    if (this.config.persistState && this.config.collectMetrics) {
      this.stateStore.flushSync();
    }
    log.info("RecoveryEngine disposed");
  }
}
