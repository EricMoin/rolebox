import { defineTool } from "../platform/ports/tool-factory.ts";
import { z } from "zod";
import type { ResolvedRole, ResolvedFunction, ResolvedSkill, ResolvedReference } from "../types.ts";

interface AssetEntry {
  name: string;
  type: "skill" | "function" | "reference";
  description: string;
  roleId: string;
  filePath: string;
  phase?: string;
  tags: string[];
  searchText: string; // lowercased for matching
}

function collectAssets(roles: ResolvedRole[]): AssetEntry[] {
  const assets: AssetEntry[] = [];

  for (const role of roles) {
    // Skills
    for (const skill of role.skills) {
      const searchText = `${skill.name} ${skill.description}`.toLowerCase();
      assets.push({
        name: skill.name,
        type: "skill",
        description: skill.description,
        roleId: role.id,
        filePath: skill.filePath,
        tags: [],
        searchText,
      });
    }

    // Functions
    for (const fn of role.functions) {
      const searchText = `${fn.name} ${fn.description}`.toLowerCase();
      assets.push({
        name: fn.name,
        type: "function",
        description: fn.description,
        roleId: role.id,
        filePath: fn.filePath,
        phase: fn.phase,
        tags: [],
        searchText,
      });
    }

    // References
    for (const ref of role.references) {
      const searchText = `${ref.name} ${ref.description}`.toLowerCase();
      assets.push({
        name: ref.name,
        type: "reference",
        description: ref.description,
        roleId: role.id,
        filePath: ref.filePath,
        tags: [],
        searchText,
      });
    }

    // Also collect from subagents' skills/functions/references
    collectSubagentAssets(role.subagents, role.id, assets);
  }

  return assets;
}

function collectSubagentAssets(
  subagents: ResolvedRole["subagents"],
  parentRoleId: string,
  assets: AssetEntry[],
): void {
  for (const sub of subagents) {
    for (const skill of sub.skills) {
      const searchText = `${skill.name} ${skill.description}`.toLowerCase();
      assets.push({
        name: skill.name,
        type: "skill",
        description: skill.description,
        roleId: `${parentRoleId}/${sub.id}`,
        filePath: skill.filePath,
        tags: [],
        searchText,
      });
    }
    for (const fn of sub.functions) {
      const searchText = `${fn.name} ${fn.description}`.toLowerCase();
      assets.push({
        name: fn.name,
        type: "function",
        description: fn.description,
        roleId: `${parentRoleId}/${sub.id}`,
        filePath: fn.filePath,
        phase: fn.phase,
        tags: [],
        searchText,
      });
    }
    for (const ref of sub.references) {
      const searchText = `${ref.name} ${ref.description}`.toLowerCase();
      assets.push({
        name: ref.name,
        type: "reference",
        description: ref.description,
        roleId: `${parentRoleId}/${sub.id}`,
        filePath: ref.filePath,
        tags: [],
        searchText,
      });
    }
    // Recurse into nested subagents
    if (sub.subagents && sub.subagents.length > 0) {
      collectSubagentAssets(sub.subagents, `${parentRoleId}/${sub.id}`, assets);
    }
  }
}

interface ScoredAsset {
  entry: AssetEntry;
  score: number;
}
// ── Module-level cache for incremental index ─────────────────────────
//
// Caches collectAssets() results keyed by the roles array reference identity.
// This avoids re-collecting on every tool.execute() call while being safe
// across hot-reload (new roles → new reference → cache miss → re-collect).
//
// In test environments each test creates fresh roles, so reference comparison
// naturally prevents cross-test cache pollution.

let _lastRoles: ResolvedRole[] | null = null;
let _cachedAssets: AssetEntry[] | null = null;

/**
 * Invalidate the cached asset search index.
 * Called by the hot-reload service when roles are re-resolved.
 */
export function invalidateAssetIndex(): void {
  _lastRoles = null;
  _cachedAssets = null;
}

export function createAssetSearchTool(roles: ResolvedRole[]) {
  if (_cachedAssets === null || _lastRoles !== roles) {
    _cachedAssets = collectAssets(roles);
    _lastRoles = roles;
  }
  const allAssets = _cachedAssets;
  return defineTool({
    description:
      "Search rolebox assets (skills, functions, references) by keyword. Searches asset names and descriptions across all resolved roles and sub-agents. Returns matching assets sorted by relevance. Use this to discover which skill, function, or reference to load for a given task.",
    args: {
      query: z
        .string()
        .min(1)
        .describe("Search query — keywords matched against asset name and description. Multiple words use AND logic (all must match)."),
      type: z
        .enum(["skill", "function", "reference", "all"])
        .catch("all") // Normalize invalid values (e.g. literal string "undefined") to "all"
        .optional()
        .default("all")
        .describe("Filter by asset type"),
      role_id: z
        .string()
        .optional()
        .describe("Limit search to assets of a specific role (by role ID)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(20)
        .describe("Max results (default 20)"),
      format: z
        .enum(["markdown", "json"])
        .optional()
        .default("markdown")
        .describe("Output format: 'markdown' for human-readable, 'json' for machine parsing"),
    },
    async execute(input) {
      if (allAssets.length === 0) {
        return "No assets found. Make sure roles are properly loaded.";
      }

      // Parse query into keywords (AND logic)
      const keywords = input.query.toLowerCase().split(/\s+/).filter((k) => k.length > 0);

      // Filter by type. Normalize missing/invalid values — some models emit the
      // literal string "undefined" for an omitted arg — to "all" so the filter
      // never silently matches zero assets against a bogus type.
      const type =
        input.type === "skill" || input.type === "function" ||
        input.type === "reference" || input.type === "all"
          ? input.type
          : "all";
      let candidates = allAssets;
      if (type !== "all") {
        candidates = candidates.filter((a) => a.type === type);
      }

      // Filter by role_id
      if (input.role_id) {
        candidates = candidates.filter((a) => a.roleId === input.role_id || a.roleId.startsWith(input.role_id + "/"));
      }

      // Score each asset
      const scored: ScoredAsset[] = [];
      for (const asset of candidates) {
        const nameLower = asset.name.toLowerCase();
        const descLower = asset.description.toLowerCase();

        // All keywords must match (AND logic) — search in name + description
        const allMatch = keywords.every((kw) =>
          nameLower.includes(kw) || descLower.includes(kw),
        );
        if (!allMatch) continue;

        // Relevance scoring: name match × 3 + desc match × 1 + exact match bonus +10
        let score = 0;
        for (const kw of keywords) {
          if (nameLower.includes(kw)) score += 3;
          if (descLower.includes(kw)) score += 1;
        }
        // Exact name match bonus
        if (nameLower === input.query.toLowerCase()) {
          score += 10;
        }

        scored.push({ entry: asset, score });
      }

      // Sort by score descending, then by name
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.entry.name.localeCompare(b.entry.name);
      });

      const limited = scored.slice(0, input.limit ?? 20);

      if (limited.length === 0) {
        return `No assets matching "${input.query}"${type !== "all" ? ` of type "${type}"` : ""}.`;
      }

      if (input.format === "json") {
        return JSON.stringify(
          limited.map((s) => ({
            name: s.entry.name,
            type: s.entry.type,
            roleId: s.entry.roleId,
            description: s.entry.description,
            phase: s.entry.phase,
            score: s.score,
          })),
          null,
          2,
        );
      }

      const header = "| Name | Type | Role | Description |";
      const separator = "|---|---|---|---|";
      const rows = limited.map((s) => {
        const phase = s.entry.phase ? ` (${s.entry.phase})` : "";
        return `| ${s.entry.name} | ${s.entry.type}${phase} | ${s.entry.roleId} | ${s.entry.description} |`;
      });

      return `## Asset Search Results: "${input.query}"\n\nFound ${scored.length} matching asset(s)${scored.length > limited.length ? ` (showing first ${limited.length})` : ""}.\n\n${header}\n${separator}\n${rows.join("\n")}`;
    },
  });
}
