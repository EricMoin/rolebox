import type {
  TerminationConfig,
  LoopCondition,
  ResolvedTermination,
  LoopGroup,
} from "../types.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("graph-parser");

const KNOWN_CONDITION_KEYS = new Set<string>([
  "max_iterations",
  "timeout_ms",
  "converged",
  "result_matches",
  "stuck",
]);

/**
 * Register a custom termination condition key.
 */
export function addTerminationConditionKey(key: string): void {
  KNOWN_CONDITION_KEYS.add(key);
}

// Custom termination condition parsers
const customTerminationParsers = new Map<
  string,
  (
    value: unknown,
    fullObj: Record<string, unknown>,
    availableAgents: string[],
  ) => unknown | null
>();

/**
 * Register a custom termination condition parser.
 */
export function registerTerminationParser(
  key: string,
  parser: (
    value: unknown,
    fullObj: Record<string, unknown>,
    availableAgents: string[],
  ) => unknown | null,
): void {
  customTerminationParsers.set(key, parser);
  addTerminationConditionKey(key);
}

/**
 * Parse a raw termination config into a normalized `ResolvedTermination`.
 */
export function parseTermination(
  raw: unknown,
  availableAgents: string[],
  loopGroups: LoopGroup[],
): ResolvedTermination | undefined {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return undefined;
  }

  const obj = raw as Record<string, unknown>;
  const anyOf = parseConditionList(obj.any_of, availableAgents);
  const allOf = parseConditionList(obj.all_of, availableAgents);

  if (!anyOf && !allOf) return undefined;

  const config: TerminationConfig = {};
  if (anyOf) config.any_of = anyOf;
  if (allOf) config.all_of = allOf;

  const perLoopMaxIter = extractPerLoopMaxIterations(config);

  const resolvedGroups = loopGroups.map((lg) => ({
    ...lg,
    maxIterations: perLoopMaxIter ?? lg.maxIterations,
  }));

  return { config, loopGroups: resolvedGroups };
}

function parseConditionList(
  raw: unknown,
  availableAgents: string[],
): LoopCondition[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: LoopCondition[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      log.warn("termination condition is not an object, skipping");
      continue;
    }
    const obj = item as Record<string, unknown>;
    const parsed = parseLoopCondition(obj, availableAgents);
    if (parsed) result.push(parsed);
  }
  return result.length > 0 ? result : [];
}

function parseLoopCondition(
  obj: Record<string, unknown>,
  availableAgents: string[],
): LoopCondition | null {
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    log.warn("termination condition is an empty object, skipping");
    return null;
  }

  for (const key of keys) {
    if (KNOWN_CONDITION_KEYS.has(key)) {
      return parseKnownCondition(key, obj[key], obj, availableAgents);
    }
  }

  for (const [customKey, customParser] of customTerminationParsers) {
    if (customKey in obj) {
      const result = customParser(obj[customKey], obj, availableAgents);
      if (result !== null) return result as LoopCondition;
    }
  }

  log.warn(
    `unknown termination condition key(s): ${keys.join(", ")} — skipping`,
  );
  return null;
}

function parseKnownCondition(
  key: string,
  value: unknown,
  fullObj: Record<string, unknown>,
  availableAgents: string[],
): LoopCondition | null {
  for (const extraKey of Object.keys(fullObj)) {
    if (!KNOWN_CONDITION_KEYS.has(extraKey)) {
      log.warn(
        `unknown extra key "${extraKey}" in termination condition — ignored`,
      );
    }
  }

  switch (key) {
    case "max_iterations": {
      const n = typeof value === "number" ? value : NaN;
      if (isNaN(n) || n < 0) {
        log.warn(`invalid max_iterations value in termination: ${value}, skipping`);
        return null;
      }
      return { max_iterations: Math.max(0, n) };
    }
    case "timeout_ms": {
      const n = typeof value === "number" ? value : NaN;
      if (isNaN(n) || n <= 0) {
        log.warn(`invalid timeout_ms value in termination: ${value}, skipping`);
        return null;
      }
      return { timeout_ms: n };
    }
    case "converged": {
      if (typeof value !== "string" || value.trim() === "") {
        log.warn(`invalid converged agent reference: ${value}, skipping`);
        return null;
      }
      const agent = value.trim();
      if (!availableAgents.includes(agent)) {
        log.warn(`converged references unknown agent "${agent}"`);
      }
      return { converged: agent };
    }
    case "result_matches": {
      if (typeof value !== "object" || value === null) {
        log.warn(`invalid result_matches value: ${value}, skipping`);
        return null;
      }
      const rm = value as Record<string, unknown>;
      if (typeof rm.agent !== "string" || rm.agent.trim() === "") {
        log.warn("result_matches missing required 'agent' field, skipping");
        return null;
      }
      const agent = rm.agent.trim();
      if (!availableAgents.includes(agent)) {
        log.warn(`result_matches references unknown agent "${agent}"`);
      }
      const condition: Record<string, unknown> = { agent };
      if (typeof rm.contains === "string") condition.contains = rm.contains;
      if (typeof rm.regex === "string") condition.regex = rm.regex;
      if (typeof rm.score_gte === "number") condition.score_gte = rm.score_gte;
      if (typeof rm.no_changes === "boolean") {
        condition.no_changes = rm.no_changes;
      }
      return { result_matches: condition } as LoopCondition;
    }
    case "stuck": {
      if (typeof value !== "object" || value === null) {
        log.warn(`invalid stuck value: ${value}, skipping`);
        return null;
      }
      const s = value as Record<string, unknown>;
      const repeats =
        typeof s.repeats === "number" && s.repeats > 0 ? s.repeats : NaN;
      if (isNaN(repeats)) {
        log.warn(
          `stuck missing valid 'repeats' field: ${JSON.stringify(value)}, skipping`,
        );
        return null;
      }
      return { stuck: { repeats } };
    }
    default:
      return null;
  }
}

function extractPerLoopMaxIterations(
  config: TerminationConfig,
): number | undefined {
  const conditions = [...(config.any_of ?? []), ...(config.all_of ?? [])];
  for (const c of conditions) {
    if ("max_iterations" in c) return c.max_iterations;
  }
  return undefined;
}
