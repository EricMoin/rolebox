/**
 * Centralized registry for resolved role artifacts.
 *
 * Previously these Maps lived in src/index.ts, causing a circular dependency
 * when leaf modules (e.g., function-state.ts) needed to look up role functions.
 * By placing them in the resolver layer, the dependency direction is correct:
 * leaf modules → resolver/registry (domain layer), not leaf → entry point.
 */
import type { ResolvedFunction, ResolvedGraph } from "../types.ts";
import type { OpenRoleEntry } from "./open-roles.ts";

/** Map of roleId/subagentId → resolved functions for that agent. */
export const roleFunctionsMap = new Map<string, ResolvedFunction[]>();

/** Map of roleId → resolved collaboration graph. */
export const roleGraphMap = new Map<string, ResolvedGraph>();

/** Map of roleId → open-role registry entry (subagents exposed via exports). */
export const roleOpenRegistry = new Map<string, OpenRoleEntry>();
