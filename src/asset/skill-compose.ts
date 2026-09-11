import { defineTool } from "../platform/ports/tool-factory.ts";
import { z } from "zod";
import type { ResolvedRole, ResolvedSkill, ResolvedReference, ResolvedSubAgent } from "../types.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("skill-compose");

// ── Recursive skill collector ───────────────────────────────────────────────

interface SkillEntry {
  skill: ResolvedSkill;
  source: string;
}

function collectSkills(role: ResolvedRole): SkillEntry[] {
  const results: SkillEntry[] = [];
  for (const s of role.skills) {
    results.push({ skill: s, source: role.id });
  }
  function walk(subagents: ResolvedSubAgent[], parentSource: string) {
    for (const sub of subagents) {
      for (const s of sub.skills) {
        results.push({ skill: s, source: `${parentSource}/${sub.id}` });
      }
      walk(sub.subagents, `${parentSource}/${sub.id}`);
    }
  }
  walk(role.subagents, role.id);
  return results;
}

// ── Reference deduplication ─────────────────────────────────────────────────

interface DedupedReference {
  name: string;
  filePath: string;
  description: string;
  sourceSkills: string[];
}

function deduplicateReferences(
  entries: SkillEntry[],
): DedupedReference[] {
  const seen = new Map<string, DedupedReference>();

  for (const entry of entries) {
    for (const ref of entry.skill.references) {
      const existing = seen.get(ref.filePath);
      if (existing) {
        if (!existing.sourceSkills.includes(entry.skill.name)) {
          existing.sourceSkills.push(entry.skill.name);
        }
      } else {
        seen.set(ref.filePath, {
          name: ref.name,
          filePath: ref.filePath,
          description: ref.description,
          sourceSkills: [entry.skill.name],
        });
      }
    }
  }

  return Array.from(seen.values());
}

// ── Conflict detection ──────────────────────────────────────────────────────

interface ReferenceConflict {
  refName: string;
  paths: string[];
  skills: string[];
}

function detectReferenceConflicts(entries: SkillEntry[]): ReferenceConflict[] {
  // Index references by name — collect all (filePath, skillName) pairs per name
  const byName = new Map<string, Array<{ filePath: string; skillName: string }>>();

  for (const entry of entries) {
    for (const ref of entry.skill.references) {
      const list = byName.get(ref.name);
      if (list) {
        list.push({ filePath: ref.filePath, skillName: entry.skill.name });
      } else {
        byName.set(ref.name, [{ filePath: ref.filePath, skillName: entry.skill.name }]);
      }
    }
  }

  const conflicts: ReferenceConflict[] = [];
  for (const [refName, occurrences] of byName) {
    const uniquePaths = new Set(occurrences.map((o) => o.filePath));
    if (uniquePaths.size > 1) {
      conflicts.push({
        refName,
        paths: Array.from(uniquePaths),
        skills: Array.from(new Set(occurrences.map((o) => o.skillName))),
      });
    }
  }

  return conflicts;
}

// ── Markdown rendering ──────────────────────────────────────────────────────

function renderFoundTable(entries: SkillEntry[]): string {
  // Aggregate reference counts per skill
  const skillCounts = new Map<string, { source: string; refCount: number }>();
  for (const entry of entries) {
    const key = entry.skill.name;
    const existing = skillCounts.get(key);
    if (existing) {
      // Keep the source from the first occurrence (most verbose)
      continue;
    }
    skillCounts.set(key, {
      source: entry.source,
      refCount: entry.skill.references.length,
    });
  }

  const rows: string[] = [];
  for (const [skillName, info] of skillCounts) {
    rows.push(`| ${skillName} | ${info.source} | ${info.refCount} |`);
  }

  if (rows.length === 0) return "";

  return (
    "### Found Skills\n\n" +
    "| Skill | Source | References Count |\n" +
    "|-------|--------|-----------------|\n" +
    rows.join("\n")
  );
}

function renderCombinedReferences(deduped: DedupedReference[]): string {
  if (deduped.length === 0) {
    return "### Combined References (deduplicated)\n\nNo references found in matched skills.";
  }

  const rows = deduped.map(
    (r) =>
      `| ${r.name} | ${r.description} | ${r.sourceSkills.join(", ")} |`,
  );

  return (
    "### Combined References (deduplicated)\n\n" +
    "| Name | Description | Source Skills |\n" +
    "|------|-------------|--------------|\n" +
    rows.join("\n")
  );
}

function renderConflicts(conflicts: ReferenceConflict[]): string {
  if (conflicts.length === 0) return "### Conflicts\n\nNo conflicts detected.";

  const rows = conflicts.map((c) => {
    const pathDetail = c.paths
      .map((p, i) => `${p} (${c.skills[i] ?? "unknown"})`)
      .join(" vs ");
    return `- ⚠️ Reference "${c.refName}" exists at different paths: ${pathDetail}`;
  });

  return `### Conflicts\n\n${rows.join("\n")}`;
}

function renderMissingSkills(
  requested: string[],
  foundNames: Set<string>,
): string {
  const missing = requested.filter((n) => !foundNames.has(n));
  if (missing.length === 0) return "";

  const rows = missing.map(
    (n) => `- ❌ ${n} not found in any loaded role`,
  );

  return `### Missing Skills\n\n${rows.join("\n")}`;
}

function renderSummary(
  foundCount: number,
  dedupCount: number,
  conflictCount: number,
  missingCount: number,
): string {
  return `**Summary:** ${foundCount} skills found, ${dedupCount} unique references, ${conflictCount} conflicts, ${missingCount} missing.`;
}

// ── Public factory ──────────────────────────────────────────────────────────

export function createSkillComposeTool(resolvedRoles: ResolvedRole[]) {
  // Pre-collect all skills at tool creation time
  const allSkills = resolvedRoles.flatMap(collectSkills);

  return defineTool({
    description:
      "Analyze skill combinations for conflicts and reference deduplication. Given a list of skill names, scans all loaded roles and their sub-agents to find matching skills, deduplicates their references by file path, and detects reference-path conflicts where two skills reference the same document name at different file paths.",
    args: {
      skill_names: z
        .array(z.string())
        .min(1)
        .describe("Skill names to compose and analyze"),
      check_conflicts: z
        .boolean()
        .optional()
        .default(true)
        .describe("Check for tool permission conflicts"),
    },
    async execute(input) {
      if (resolvedRoles.length === 0) {
        return "No roles loaded. Cannot analyze skills.";
      }

      // 1. Find matching skills by name
      const requestedNames = input.skill_names;
      const matched: SkillEntry[] = [];
      const foundNames = new Set<string>();

      for (const entry of allSkills) {
        if (requestedNames.includes(entry.skill.name)) {
          matched.push(entry);
          foundNames.add(entry.skill.name);
        }
      }

      if (matched.length === 0) {
        return `No matching skills found for: ${requestedNames.join(", ")}`;
      }

      // 2. Deduplicate references
      const deduped = deduplicateReferences(matched);

      // 3. Detect conflicts (when check_conflicts is true)
      const conflicts: ReferenceConflict[] = input.check_conflicts
        ? detectReferenceConflicts(matched)
        : [];

      // 4. Detect missing skills
      const missing = requestedNames.filter((n) => !foundNames.has(n));

      // 5. Build output markdown
      const parts: string[] = [
        "## Skill Composition Analysis",
        "",
        `**Requested:** ${requestedNames.join(", ")}`,
        "",
        renderFoundTable(matched),
        "",
        renderCombinedReferences(deduped),
        "",
        renderConflicts(conflicts),
        "",
        renderMissingSkills(requestedNames, foundNames),
        "",
        renderSummary(matched.length, deduped.length, conflicts.length, missing.length),
      ];

      return parts.filter((p) => p !== "").join("\n");
    },
  });
}
