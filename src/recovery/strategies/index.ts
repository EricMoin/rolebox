export { StrategyRegistry } from "./registry.ts";
export { retryStrategy } from "./retry-strategy.ts";
export { compactStrategy } from "./compact-strategy.ts";
export { fallbackModelStrategy } from "./fallback-model-strategy.ts";
export { abortStrategy } from "./abort-strategy.ts";
export { remindAndRetryStrategy } from "./remind-and-retry-strategy.ts";
export { truncateStrategy } from "./truncate-strategy.ts";
export { summarizeStrategy } from "./summarize-strategy.ts";

import { StrategyRegistry } from "./registry.ts";
import { retryStrategy } from "./retry-strategy.ts";
import { compactStrategy } from "./compact-strategy.ts";
import { fallbackModelStrategy } from "./fallback-model-strategy.ts";
import { abortStrategy } from "./abort-strategy.ts";
import { remindAndRetryStrategy } from "./remind-and-retry-strategy.ts";
import { truncateStrategy } from "./truncate-strategy.ts";
import { summarizeStrategy } from "./summarize-strategy.ts";

/** Register all built-in strategies on a registry */
export function registerBuiltinStrategies(registry: StrategyRegistry): void {
  registry.register(retryStrategy);
  registry.register(compactStrategy);
  registry.register(fallbackModelStrategy);
  registry.register(abortStrategy);
  registry.register(remindAndRetryStrategy);
  registry.register(truncateStrategy);
  registry.register(summarizeStrategy);
}
