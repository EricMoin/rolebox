/**
 * Open-role registry collector.
 *
 * An "open" role (`config.open === true`) exposes a subset of its subagents to
 * external consumers via `config.exports`. When `exports` is absent, only the
 * role id itself is addressable — subagents are NOT exposed.
 *
 * This module collects one entry per open role from the resolved role set and
 * resolves each export name to the subagent's full id (`roleId--slug`), using
 * the exact slug computation the orchestrator applies when building subagent
 * ids (src/resolver/orchestrator.ts:118-119). Unknown export names are logged
 * as warnings and skipped — resolution never fails because of them.
 */

import { createSubLogger } from "../logger.ts";
import type { Logger } from "tslog";
import type { ILogObj } from "tslog";
import type { ResolvedRole, ResolvedSubAgent } from "../types.ts";

/** A single open-role registry entry: the role's metadata plus resolved export ids. */
export interface OpenRoleEntry {
  /** Role id (directory name). */
  roleId: string;
  /** Role display name (`config.name`). */
  name: string;
  /** Role description (`config.description`). */
  description: string;
  /** Full subagent ids (`roleId--slug`) exposed by this role; empty when none. */
  exports: string[];
}

let log: Logger<ILogObj> = createSubLogger("open-roles");

/** @internal Test seam — swap the module-level logger for a mock. */
export function __setLoggerForTest(mockLog: Logger<ILogObj>): void {
  log = mockLog;
}

/**
 * Compute a subagent slug from its display name — exactly as the orchestrator
 * does when deriving subagent ids (src/resolver/orchestrator.ts:118).
 */
export function toSubagentSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}

/**
 * Collect open-role registry entries from a set of resolved roles.
 *
 * Only roles with `config.open === true` are included. Each `config.exports`
 * entry is matched (case/whitespace-insensitively) against the slug of every
 * subagent in the role's tree — top-level first, then nested — and resolved to
 * that subagent's full id. Export names that match no subagent are logged as
 * warnings and dropped; they never fail resolution.
 *
 * @param resolvedRoles - The fully resolved role set.
 * @returns A Map keyed by roleId, in input order.
 */
export function collectOpenRoles(
  resolvedRoles: ResolvedRole[],
): Map<string, OpenRoleEntry> {
  const registry = new Map<string, OpenRoleEntry>();

  for (const role of resolvedRoles) {
    if (role.config.open !== true) continue;

    const slugToId = new Map<string, string>();
    for (const subagent of role.subagents) {
      collectSubagentIds(subagent, slugToId);
    }

    const seen = new Set<string>();
    const exports: string[] = [];
    for (const exportName of role.config.exports ?? []) {
      const fullId = slugToId.get(toSubagentSlug(exportName));
      if (fullId === undefined) {
        log.warn(
          `Role "${role.id}" exports unknown subagent "${exportName}"`,
        );
        continue;
      }
      if (seen.has(fullId)) continue;
      seen.add(fullId);
      exports.push(fullId);
    }

    registry.set(role.id, {
      roleId: role.id,
      name: role.config.name ?? role.id,
      description: role.config.description ?? "",
      exports,
    });
  }

  return registry;
}

/**
 * Recursively index every subagent in the tree by its name-derived slug.
 * First registration wins (pre-order: top-level before nested), so a slug
 * collision between an ancestor and a descendant resolves to the ancestor.
 */
function collectSubagentIds(
  subagent: ResolvedSubAgent,
  acc: Map<string, string>,
): void {
  const slug = toSubagentSlug(subagent.config.name);
  if (!acc.has(slug)) {
    acc.set(slug, subagent.id);
  }
  for (const child of subagent.subagents) {
    collectSubagentIds(child, acc);
  }
}
