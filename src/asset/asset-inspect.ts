import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import type {
  ResolvedRole,
  ResolvedFunction,
  ResolvedSkill,
  ResolvedReference,
  ResolvedSubAgent,
} from "../types.ts";

/**
 * Internal result of a matched asset lookup, carrying the full resolved data
 * plus the owning role/subagent path for display.
 */
type MatchedFunction = {
  type: "function";
  data: ResolvedFunction;
  ownerId: string;
};

type MatchedSkill = {
  type: "skill";
  data: ResolvedSkill;
  ownerId: string;
};

type MatchedReference = {
  type: "reference";
  data: ResolvedReference;
  ownerId: string;
};

type MatchResult = MatchedFunction | MatchedSkill | MatchedReference;

/**
 * Recursively search a role and its subagent tree for an asset matching
 * the given name and type. Returns the first match found (deepest-first
 * within subagents, then role-level).
 */
function findAsset(
  roles: ResolvedRole[],
  name: string,
  type: "skill" | "function" | "reference",
): MatchResult | null {
  for (const role of roles) {
    // Recursive subagent search first (deeper assets take priority)
    const subResult = findInSubAgents(role.subagents, role.id, name, type);
    if (subResult) return subResult;

    // Check role-level assets
    const roleResult = findInCollection(role, name, type);
    if (roleResult) return roleResult;
  }
  return null;
}

function findInSubAgents(
  subagents: ResolvedSubAgent[],
  parentId: string,
  name: string,
  type: "skill" | "function" | "reference",
): MatchResult | null {
  for (const sub of subagents) {
    const subId = `${parentId}/${sub.id}`;

    // Recurse into nested subagents first
    if (sub.subagents && sub.subagents.length > 0) {
      const nested = findInSubAgents(sub.subagents, subId, name, type);
      if (nested) return nested;
    }

    // Check this subagent's collections
    if (type === "skill") {
      for (const skill of sub.skills) {
        if (skill.name === name) {
          return { type: "skill", data: skill, ownerId: subId };
        }
      }
    } else if (type === "function") {
      for (const fn of sub.functions) {
        if (fn.name === name) {
          return { type: "function", data: fn, ownerId: subId };
        }
      }
    } else if (type === "reference") {
      for (const ref of sub.references) {
        if (ref.name === name) {
          return { type: "reference", data: ref, ownerId: subId };
        }
      }
    }
  }
  return null;
}

function findInCollection(
  role: ResolvedRole,
  name: string,
  type: "skill" | "function" | "reference",
): MatchResult | null {
  if (type === "skill") {
    for (const skill of role.skills) {
      if (skill.name === name) {
        return { type: "skill", data: skill, ownerId: role.id };
      }
    }
  } else if (type === "function") {
    for (const fn of role.functions) {
      if (fn.name === name) {
        return { type: "function", data: fn, ownerId: role.id };
      }
    }
  } else if (type === "reference") {
    for (const ref of role.references) {
      if (ref.name === name) {
        return { type: "reference", data: ref, ownerId: role.id };
      }
    }
  }
  return null;
}

// ── Formatting helpers ─────────────────────────────────────────────────

function formatFunction(fn: ResolvedFunction, ownerId: string): string {
  const lines: string[] = [];
  lines.push(`## Function: ${fn.name}`);
  lines.push(`**Owner**: \`${ownerId}\``);
  lines.push(`**Description**: ${fn.description}`);
  lines.push(`**File**: \`${fn.filePath}\``);
  lines.push(`**Source**: ${fn.source}`);

  if (fn.params && Object.keys(fn.params).length > 0) {
    lines.push("");
    lines.push("### Parameters");
    for (const [key, value] of Object.entries(fn.params)) {
      lines.push(`- \`${key}\`: ${value}`);
    }
  }

  const optionalFields: [string, unknown][] = [
    ["Phase", fn.phase],
    ["Priority", fn.priority],
    ["Produces", fn.produces],
    ["Consumes", fn.consumes],
    ["Requires Evidence", fn.requires_evidence],
    ["State Schema Version", fn.state_schema_version],
    ["Continue Max", fn.continue_max],
    ["Handlers", fn.handlers],
  ];

  for (const [label, value] of optionalFields) {
    if (value !== undefined) {
      lines.push("");
      lines.push(`**${label}**: ${formatValue(value)}`);
    }
  }

  if (fn.requires && fn.requires.length > 0) {
    lines.push("");
    lines.push("### Requires");
    for (const r of fn.requires) {
      lines.push(`- \`${r}\``);
    }
  }

  if (fn.gate) {
    lines.push("");
    lines.push(`**Gate**: \`${formatCondition(fn.gate)}\``);
  }

  if (fn.continue_until) {
    lines.push("");
    lines.push(`**Continue Until**: \`${formatCondition(fn.continue_until)}\``);
  }

  if (fn.observe && fn.observe.length > 0) {
    lines.push("");
    lines.push("### Observe Specifications");
    for (let i = 0; i < fn.observe.length; i++) {
      const obs = fn.observe[i];
      lines.push(`- **${i + 1}.** \`on: ${obs.on}\``);
      if (obs.tool) lines.push(`  - tool: \`${obs.tool}\``);
      if (obs.when) lines.push(`  - when: \`${formatCondition(obs.when)}\``);
      if (obs.inject) lines.push(`  - inject: \`${obs.inject}\``);
      if (obs.set_evidence) lines.push(`  - set_evidence: \`${obs.set_evidence}\``);
      if (obs.capture_artifact) lines.push(`  - capture_artifact: \`${obs.capture_artifact}\``);
      if (obs.capture_payload_as) lines.push(`  - capture_payload_as: \`${obs.capture_payload_as}\``);
      if (obs.sync_todos) lines.push("  - sync_todos: true");
      if (obs.when_output) {
        lines.push("  - when_output:");
        if (obs.when_output.contains) lines.push(`    - contains: \`${obs.when_output.contains}\``);
        if (obs.when_output.not_contains) lines.push(`    - not_contains: \`${obs.when_output.not_contains}\``);
      }
    }
  }

  if (fn.transitions && fn.transitions.length > 0) {
    lines.push("");
    lines.push("### Transitions");
    for (let i = 0; i < fn.transitions.length; i++) {
      const t = fn.transitions[i];
      lines.push(`- **${i + 1}.** when: \`${formatCondition(t.when)}\``);
      if (t.activate && t.activate.length > 0) {
        lines.push(`  - activate: ${t.activate.map((a) => `\`${a}\``).join(", ")}`);
      }
      if (t.deactivate && t.deactivate.length > 0) {
        lines.push(`  - deactivate: ${t.deactivate.map((d) => `\`${d}\``).join(", ")}`);
      }
    }
  }

  return lines.join("\n");
}

function formatSkill(skill: ResolvedSkill, ownerId: string): string {
  const lines: string[] = [];
  lines.push(`## Skill: ${skill.name}`);
  lines.push(`**Owner**: \`${ownerId}\``);
  lines.push(`**Description**: ${skill.description}`);
  lines.push(`**Scope**: ${skill.scope}`);
  lines.push(`**File**: \`${skill.filePath}\``);

  if (skill.references && skill.references.length > 0) {
    lines.push("");
    lines.push("### Skill References");
    for (const ref of skill.references) {
      lines.push(`- \`${ref.name}\` — ${ref.description}`);
    }
  }

  return lines.join("\n");
}

function formatReference(ref: ResolvedReference, ownerId: string): string {
  const lines: string[] = [];
  lines.push(`## Reference: ${ref.name}`);
  lines.push(`**Owner**: \`${ownerId}\``);
  lines.push(`**Description**: ${ref.description}`);
  lines.push(`**File**: \`${ref.filePath}\``);
  lines.push(`**Scope**: ${ref.scope}`);
  lines.push(`**Relative Path**: \`${ref.relativePath}\``);
  return lines.join("\n");
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((v) => `\`${String(v)}\``).join(", ");
  }
  return String(value);
}

function formatCondition(cond: unknown): string {
  if (typeof cond === "string") return cond;
  try {
    return JSON.stringify(cond);
  } catch {
    return String(cond);
  }
}

// ── Public factory ─────────────────────────────────────────────────────

export function createAssetInspectTool(resolvedRoles: ResolvedRole[]) {
  return tool({
    description:
      "Inspect a single rolebox asset (skill, function, or reference) by exact name and type. Returns the complete frontmatter metadata for the matched asset, or a clear error if not found. Searches across all resolved roles and their sub-agents.",
    args: {
      name: z.string().min(1).describe("Exact name of the asset to inspect"),
      type: z
        .enum(["skill", "function", "reference"])
        .describe("Type of asset to inspect"),
    },
    async execute(input) {
      if (resolvedRoles.length === 0) {
        return "No roles loaded. Cannot inspect assets.";
      }

      const match = findAsset(resolvedRoles, input.name, input.type);

      if (!match) {
        return `Asset not found: no ${input.type} named "${input.name}" exists in any loaded role or sub-agent.`;
      }

      switch (match.type) {
        case "function":
          return formatFunction(match.data, match.ownerId);
        case "skill":
          return formatSkill(match.data, match.ownerId);
        case "reference":
          return formatReference(match.data, match.ownerId);
      }
    },
  });
}
