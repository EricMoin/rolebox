import { defineTool } from "../platform/ports/tool-factory.ts";
import { z } from "zod";
import type {
  ResolvedRole,
  ResolvedSkill,
  ResolvedSubAgent,
  ResolvedReference,
} from "../types.ts";
import { loadSkillContent } from "../resolver/skill-resolver.ts";
import { formatError } from "../logger.ts";

// ── Recursive skill lookup (mirrors asset-inspect.ts findAsset traversal) ──

interface SkillMatch {
  skill: ResolvedSkill;
  ownerId: string;
}

/**
 * Find a skill by exact name across all roles and their nested subagent
 * trees. Mirrors the traversal in src/asset/asset-inspect.ts findAsset():
 * for each role, nested subagent skills are searched first (deepest-first —
 * a deeper subagent's skill wins over a shallower one), then the role's own
 * skills. The first matching role wins.
 */
function findSkill(
  roles: ResolvedRole[],
  name: string,
): SkillMatch | null {
  for (const role of roles) {
    // Recursive subagent search first (deeper assets take priority)
    const subResult = findSkillInSubAgents(role.subagents, role.id, name);
    if (subResult) return subResult;

    // Check role-level skills
    for (const skill of role.skills) {
      if (skill.name === name) {
        return { skill, ownerId: role.id };
      }
    }
  }
  return null;
}

function findSkillInSubAgents(
  subagents: ResolvedSubAgent[],
  parentId: string,
  name: string,
): SkillMatch | null {
  for (const sub of subagents) {
    const subId = `${parentId}/${sub.id}`;

    // Recurse into nested subagents first
    if (sub.subagents && sub.subagents.length > 0) {
      const nested = findSkillInSubAgents(sub.subagents, subId, name);
      if (nested) return nested;
    }

    // Check this subagent's skills
    for (const skill of sub.skills) {
      if (skill.name === name) {
        return { skill, ownerId: subId };
      }
    }
  }
  return null;
}

// ── Available-skill listing (for the not-found error) ─────────────────────

/**
 * Collect every skill name reachable from the resolved roles — role-level
 * skills plus all nested subagent skills — deduplicated and sorted.
 */
function collectSkillNames(roles: ResolvedRole[]): string[] {
  const names = new Set<string>();
  for (const role of roles) {
    for (const s of role.skills) names.add(s.name);
    const walk = (subagents: ResolvedSubAgent[]) => {
      for (const sub of subagents) {
        for (const s of sub.skills) names.add(s.name);
        walk(sub.subagents);
      }
    };
    walk(role.subagents);
  }
  return Array.from(names).sort();
}

// ── Payload + rendering ─────────────────────────────────────────────────────

/** Self-contained skill payload a harness with no other skill machinery
 * can act on: full SKILL.md content plus resolved reference metadata. */
export interface LoadedSkillPayload {
  name: string;
  description: string;
  scope: ResolvedSkill["scope"];
  path: string;
  content: string;
  references: Array<{
    name: string;
    path: string;
    description: string;
  }>;
}

function buildPayload(
  skill: ResolvedSkill,
  content: string,
): LoadedSkillPayload {
  const references = skill.references.map((ref: ResolvedReference) => ({
    name: ref.name,
    path: ref.filePath,
    description: ref.description,
  }));
  return {
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    path: skill.filePath,
    content,
    references,
  };
}

function renderPayload(payload: LoadedSkillPayload, ownerId: string): string {
  const lines: string[] = [
    `## Skill: ${payload.name}`,
    `**Owner**: \`${ownerId}\``,
    `**Description**: ${payload.description}`,
    `**Scope**: ${payload.scope}`,
    `**Path**: \`${payload.path}\``,
  ];

  if (payload.references.length > 0) {
    lines.push("", "### References");
    for (const ref of payload.references) {
      lines.push(
        `- \`${ref.name}\` — ${ref.description} (\`${ref.path}\`)`,
      );
    }
  }

  lines.push("", "### Content", "", payload.content);
  return lines.join("\n");
}

// ── Public factory ──────────────────────────────────────────────────────────

/**
 * Create the `load_role_skill` tool: resolve a skill by exact name across
 * all loaded roles and their nested subagent trees (deepest-first), load the
 * full SKILL.md content from disk, and return a complete, self-contained
 * payload so a harness with no other skill machinery can act on it.
 *
 * Deliberately named `load_role_skill` (not `skill`) to avoid collision with
 * any harness-native skill tool. Registered only on the Pi platform via
 * pi-extension.ts extraTools — NOT on opencode's tool-service.ts, which has
 * its own native skill mechanism.
 */
export function createLoadRoleSkillTool(resolvedRoles: ResolvedRole[]) {
  const availableNames = collectSkillNames(resolvedRoles);

  return defineTool({
    description:
      "Load a skill by exact name from the loaded roles and their nested sub-agents (deepest-first priority). Returns the full SKILL.md content plus resolved reference metadata as a complete, self-contained payload. Use this instead of any harness-native skill mechanism when you need the raw skill content and its references. Not-found errors list the available skill names.",
    args: {
      name: z
        .string()
        .min(1)
        .describe("Exact name of the skill to load"),
    },
    async execute(input) {
      if (resolvedRoles.length === 0) {
        return "No roles loaded. Cannot load skills.";
      }

      const match = findSkill(resolvedRoles, input.name);

      if (!match) {
        const list =
          availableNames.length > 0 ? availableNames.join(", ") : "(none)";
        return (
          `Skill not found: no skill named "${input.name}" exists in any ` +
          `loaded role or sub-agent.\nAvailable skills: ${list}`
        );
      }

      const { skill, ownerId } = match;

      let content: string;
      try {
        content = await loadSkillContent(skill);
      } catch (err) {
        // Missing/unreadable file on disk — graceful error, never throw.
        return (
          `Skill "${skill.name}" resolved to "${skill.filePath}" but its ` +
          `file could not be loaded: ${formatError(err).message}`
        );
      }

      const payload = buildPayload(skill, content);

      return {
        output: renderPayload(payload, ownerId),
        metadata: { payload },
      };
    },
  });
}
