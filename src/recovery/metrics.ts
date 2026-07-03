import type { RecoveryMetricsSnapshot } from "./types.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("recovery:metrics");

export class RecoveryMetricsCollector {
  private totalAttempts = 0;
  private successfulRecoveries = 0;
  private abortedChains = 0;
  private exhaustedChains = 0;
  private byCategory = new Map<string, { attempts: number; successes: number }>();
  private byStrategy = new Map<string, { attempts: number; successes: number }>();
  private errorTypeFrequency = new Map<string, number>();

  recordAttempt(category: string, strategy: string, result: string): void {
    this.totalAttempts++;


    const catEntry = this.byCategory.get(category) ?? { attempts: 0, successes: 0 };
    catEntry.attempts++;
    if (result === "success") catEntry.successes++;
    this.byCategory.set(category, catEntry);


    const stratEntry = this.byStrategy.get(strategy) ?? { attempts: 0, successes: 0 };
    stratEntry.attempts++;
    if (result === "success") stratEntry.successes++;
    this.byStrategy.set(strategy, stratEntry);

    log.debug("Recorded attempt", { category, strategy, result, totalAttempts: this.totalAttempts });
  }

  recordChainOutcome(category: string, outcome: "recovered" | "exhausted" | "aborted"): void {
    switch (outcome) {
      case "recovered":
        this.successfulRecoveries++;
        break;
      case "aborted":
        this.abortedChains++;
        break;
      case "exhausted":
        this.exhaustedChains++;
        break;
    }


    const catEntry = this.byCategory.get(category) ?? { attempts: 0, successes: 0 };
    if (outcome === "recovered") catEntry.successes++;
    this.byCategory.set(category, catEntry);

    log.debug("Recorded chain outcome", { category, outcome });
  }

  recordErrorType(errorType: string): void {
    const count = this.errorTypeFrequency.get(errorType) ?? 0;
    this.errorTypeFrequency.set(errorType, count + 1);
  }

  getSnapshot(): RecoveryMetricsSnapshot {
    return {
      totalAttempts: this.totalAttempts,
      successfulRecoveries: this.successfulRecoveries,
      abortedChains: this.abortedChains,
      exhaustedChains: this.exhaustedChains,
      byCategory: Object.fromEntries(this.byCategory),
      byStrategy: Object.fromEntries(this.byStrategy),
      errorTypeFrequency: Object.fromEntries(this.errorTypeFrequency),
    };
  }

  flushTo(store: { save: (sessionID: string, state: unknown) => void }, sessionID: string): void {

    const snapshot = this.getSnapshot();
    store.save(sessionID, { metrics: snapshot });
    log.debug("Flushed metrics to state store", { sessionID });
  }

  reset(): void {
    this.totalAttempts = 0;
    this.successfulRecoveries = 0;
    this.abortedChains = 0;
    this.exhaustedChains = 0;
    this.byCategory.clear();
    this.byStrategy.clear();
    this.errorTypeFrequency.clear();
    log.debug("Metrics reset");
  }
}
