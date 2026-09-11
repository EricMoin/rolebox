import { defineTool } from "../platform/ports/tool-factory.ts";
import { z } from "zod";
import type { ResolvedRole, ResolvedFunction, Condition } from "../types.ts";

// ── Data structures ──────────────────────────────────────────────────────────

interface FunctionEntry {
  name: string;
  roleId: string;
  fn: ResolvedFunction;
}

interface GraphEdge {
  source: string;
  label: string;
  target: string;
}

// ── Function collection (recursive, following asset-search pattern) ──────────

function collectFunctions(roles: ResolvedRole[]): FunctionEntry[] {
  const entries: FunctionEntry[] = [];

  for (const role of roles) {
    for (const fn of role.functions) {
      entries.push({ name: fn.name, roleId: role.id, fn });
    }
    collectSubagentFunctions(role.subagents, role.id, entries);
  }

  return entries;
}

function collectSubagentFunctions(
  subagents: ResolvedRole["subagents"],
  parentRoleId: string,
  entries: FunctionEntry[],
): void {
  for (const sub of subagents) {
    for (const fn of sub.functions) {
      entries.push({ name: fn.name, roleId: `${parentRoleId}/${sub.id}`, fn });
    }
    if (sub.subagents && sub.subagents.length > 0) {
      collectSubagentFunctions(sub.subagents, `${parentRoleId}/${sub.id}`, entries);
    }
  }
}

// ── Edge deduplication ───────────────────────────────────────────────────────

function edgeKey(e: GraphEdge): string {
  return `${e.source}--${e.label}-->${e.target}`;
}

// ── Condition rendering ──────────────────────────────────────────────────────

function formatCondition(cond: Condition): string {
  if (typeof cond === "string") return cond;
  if ("all" in cond) return `all(${cond.all.map(formatCondition).join(", ")})`;
  if ("any" in cond) return `any(${cond.any.map(formatCondition).join(", ")})`;
  if ("not" in cond) return `not(${formatCondition(cond.not)})`;
  return JSON.stringify(cond);
}

// ── Dependencies renderer ────────────────────────────────────────────────────

function renderDependencies(functions: FunctionEntry[]): string {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  for (const entry of functions) {
    const fnName = entry.name;

    // requires → edges: fn requires dep -> fn → dep
    if (entry.fn.requires && entry.fn.requires.length > 0) {
      for (const dep of entry.fn.requires) {
        const e: GraphEdge = { source: fnName, label: "requires", target: dep };
        const key = edgeKey(e);
        if (!seen.has(key)) {
          seen.add(key);
          edges.push(e);
        }
      }
    }

    // produces → edges: fn produces artifact -> fn → artifact
    if (entry.fn.produces) {
      const e: GraphEdge = { source: fnName, label: "produces", target: entry.fn.produces };
      const key = edgeKey(e);
      if (!seen.has(key)) {
        seen.add(key);
        edges.push(e);
      }
    }

    // consumes → edges: fn consumes artifact -> fn → artifact
    if (entry.fn.consumes) {
      const e: GraphEdge = { source: fnName, label: "consumes", target: entry.fn.consumes };
      const key = edgeKey(e);
      if (!seen.has(key)) {
        seen.add(key);
        edges.push(e);
      }
    }
  }

  if (edges.length === 0) {
    return "No dependency edges found. Functions with `requires`, `produces`, or `consumes` fields will produce edges.";
  }

  const lines: string[] = [];
  lines.push(`## Function Dependency Graph (${functions.length} functions, ${edges.length} edges)`);
  lines.push("");

  // Collect all node names for context
  const allNodes = new Set<string>();
  for (const e of edges) {
    allNodes.add(e.source);
    allNodes.add(e.target);
  }

  lines.push(`**Nodes (${allNodes.size}):** ${[...allNodes].sort().join(", ")}`);
  lines.push("");

  // Edges as text arrows
  lines.push("**Edges:**");
  for (const e of edges) {
    lines.push(`  ${e.source} --${e.label}--> ${e.target}`);
  }

  return lines.join("\n");
}

// ── State machine renderer ───────────────────────────────────────────────────

function renderStateMachine(functions: FunctionEntry[]): string {
  const withTransitions = functions.filter((e) => e.fn.transitions && e.fn.transitions.length > 0);

  if (withTransitions.length === 0) {
    return "No functions with `transitions` found. Only functions that define state machine transitions appear in this view.";
  }

  const sections: string[] = [];
  sections.push(`## State Machine Graph (${withTransitions.length} functions with transitions)`);
  sections.push("");

  for (const entry of withTransitions) {
    const fnName = entry.name;
    const roleLabel = entry.roleId;
    sections.push(`### ${fnName} (${roleLabel})`);

    for (const t of entry.fn.transitions!) {
      const condition = formatCondition(t.when);

      if (t.activate && t.activate.length > 0) {
        for (const act of t.activate) {
          sections.push(`  |${fnName}| → (${condition}) → |${act}|`);
        }
      }

      if (t.deactivate && t.deactivate.length > 0) {
        for (const deact of t.deactivate) {
          sections.push(`  |${fnName}| → (${condition}) ✗ |${deact}|`);
        }
      }
    }
    sections.push("");
  }

  return sections.join("\n");
}

// ── Factory function ─────────────────────────────────────────────────────────

export function createFunctionGraphTool(roles: ResolvedRole[]) {
  const allFunctions = collectFunctions(roles);

  return defineTool({
    description:
      "Visualise function dependency and state-machine graphs across resolved roles and sub-agents. Shows how functions relate through requires/produces/consumes (dependencies mode) or how transitions activate/deactivate functions based on conditions (state_machine mode).",
    args: {
      role_id: z
        .string()
        .optional()
        .describe("Filter to functions belonging to a specific role (by role ID). When omitted, includes all roles and sub-agents."),
      focus: z
        .enum(["dependencies", "state_machine"])
        .optional()
        .default("dependencies")
        .describe("Graph type: 'dependencies' shows requires/produces/consumes DAG; 'state_machine' shows transition-based activation/deactivation flows."),
    },
    async execute(input) {
      if (allFunctions.length === 0) {
        return "No functions found. Make sure roles are properly loaded.";
      }

      // Filter by role_id if specified
      let functions = allFunctions;
      if (input.role_id) {
        functions = functions.filter(
          (f) => f.roleId === input.role_id || f.roleId.startsWith(input.role_id + "/"),
        );
      }

      if (functions.length === 0) {
        return `No functions found${input.role_id ? ` for role "${input.role_id}"` : ""}.`;
      }

      if (input.focus === "dependencies") {
        return renderDependencies(functions);
      } else {
        return renderStateMachine(functions);
      }
    },
  });
}
