import type { RecoveryStrategy } from "../types.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("recovery:strategy-registry");

export class StrategyRegistry {
  private strategies = new Map<string, RecoveryStrategy>();

  register(strategy: RecoveryStrategy): void {
    this.strategies.set(strategy.name, strategy);
    log.debug("Registered recovery strategy", { name: strategy.name });
  }

  get(name: string): RecoveryStrategy | undefined {
    return this.strategies.get(name);
  }

  has(name: string): boolean {
    return this.strategies.has(name);
  }

  names(): string[] {
    return Array.from(this.strategies.keys());
  }

  clear(): void {
    this.strategies.clear();
  }
}
