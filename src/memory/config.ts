import type { MemoryConfig } from "./types.ts";

export function parseMemoryConfig(raw: unknown): MemoryConfig | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("memory must be an object");
  }
  const fields = raw as Record<string, unknown>;
  const known = new Set(["inject", "max_inject", "min_relevance", "scope"]);
  for (const key of Object.keys(fields)) {
    if (!known.has(key)) throw new Error(`Unknown memory.${key} configuration field`);
  }
  const { inject, max_inject, min_relevance, scope } = fields;
  if (inject !== undefined && typeof inject !== "boolean") {
    throw new Error("memory.inject must be a boolean");
  }
  if (max_inject !== undefined && (typeof max_inject !== "number" || !Number.isInteger(max_inject) || max_inject < 0 || max_inject > 100)) {
    throw new Error("memory.max_inject must be an integer from 0 to 100");
  }
  if (min_relevance !== undefined && min_relevance !== "high" && min_relevance !== "medium" && min_relevance !== "low") {
    throw new Error('memory.min_relevance must be "high", "medium", or "low"');
  }
  if (scope !== undefined && scope !== "role" && scope !== "workspace" && scope !== "both") {
    throw new Error('memory.scope must be "role", "workspace", or "both"');
  }
  return {
    ...(inject === undefined ? {} : { inject }),
    ...(max_inject === undefined ? {} : { max_inject }),
    ...(min_relevance === undefined ? {} : { min_relevance }),
    ...(scope === undefined ? {} : { scope }),
  };
}
