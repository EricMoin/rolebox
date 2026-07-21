import { defineTool } from "../platform/ports/tool-factory.ts";
import { z } from "zod";
import { KNOWN_CONDITIONS } from "../function/conditions.ts";
import type {
  ResolvedRole,
  ResolvedFunction,
  ResolvedReference,
  ResolvedSubAgent,
  Condition,
} from "../types.ts";
import type { ValidationIssue } from "./issue-renderer.ts";
import { renderIssues } from "./issue-renderer.ts";

// ── Condition name extraction ────────────────────────────────────────────────

/** Regex matching "cond_name(arg)" — same pattern used in conditions.ts */
const CALL_RE = /^([a-z][a-z0-9_]*)\(([^)]*)\)$/;

/**
 * Recursively extract all named condition references from a Condition value.
 */
function extractConditionNames(cond: Condition): string[] {
  if (typeof cond === "string") {
    const match = cond.match(CALL_RE);
    return [match ? match[1] : cond];
  }
  const names: string[] = [];
  if ("all" in cond && cond.all) {
    names.push(...cond.all.flatMap(extractConditionNames));
  }
  if ("any" in cond && cond.any) {
    names.push(...cond.any.flatMap(extractConditionNames));
  }
  if ("not" in cond && cond.not) {
    names.push(...extractConditionNames(cond.not));
  }
  return names;
}

// ── Asset collection ────────────────────────────────────────────────────────

interface NamedFunction {
  name: string;
  ownerId: string;
  fn: ResolvedFunction;
}

function collectAllFunctions(roles: ResolvedRole[]): Map<string, NamedFunction[]> {
  const map = new Map<string, NamedFunction[]>();
  for (const role of roles) {
    for (const fn of role.functions) {
      const entry: NamedFunction = { name: fn.name, ownerId: role.id, fn };
      const existing = map.get(fn.name);
      if (existing) {
        existing.push(entry);
      } else {
        map.set(fn.name, [entry]);
      }
    }
    collectSubagentFunctions(role.subagents, role.id, map);
  }
  return map;
}

function collectSubagentFunctions(
  subagents: ResolvedSubAgent[],
  parentId: string,
  map: Map<string, NamedFunction[]>,
): void {
  for (const sub of subagents) {
    const subId = `${parentId}/${sub.id}`;
    for (const fn of sub.functions) {
      const entry: NamedFunction = { name: fn.name, ownerId: subId, fn };
      const existing = map.get(fn.name);
      if (existing) {
        existing.push(entry);
      } else {
        map.set(fn.name, [entry]);
      }
    }
    if (sub.subagents && sub.subagents.length > 0) {
      collectSubagentFunctions(sub.subagents, subId, map);
    }
  }
}

// ── Validation logic ─────────────────────────────────────────────────────────

function checkMissingDependencies(
  roles: ResolvedRole[],
  knownFunctions: Set<string>,
  roleFilter?: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const role of roles) {
    if (roleFilter && role.id !== roleFilter && !role.id.startsWith(roleFilter + "/")) {
      checkRoleFunctions(role.functions, role.id, knownFunctions, issues);
      checkSubagentFunctions(role.subagents, role.id, knownFunctions, issues, roleFilter);
      continue;
    }
    checkRoleFunctions(role.functions, role.id, knownFunctions, issues);
    checkSubagentFunctions(role.subagents, role.id, knownFunctions, issues, roleFilter);
  }

  return issues;
}

function checkRoleFunctions(
  functions: ResolvedFunction[],
  ownerId: string,
  knownFunctions: Set<string>,
  issues: ValidationIssue[],
): void {
  for (const fn of functions) {
    if (!fn.requires || fn.requires.length === 0) continue;
    for (const dep of fn.requires) {
      if (!knownFunctions.has(dep)) {
        issues.push({
          asset: `${ownerId}/${fn.name}`,
          type: "function",
          issue: `requires nonexistent function: ${dep}`,
          severity: "error",
        });
      }
    }
  }
}

function checkSubagentFunctions(
  subagents: ResolvedSubAgent[],
  parentId: string,
  knownFunctions: Set<string>,
  issues: ValidationIssue[],
  roleFilter?: string,
): void {
  for (const sub of subagents) {
    const subId = `${parentId}/${sub.id}`;
    const matchesFilter =
      !roleFilter || subId === roleFilter || subId.startsWith(roleFilter + "/") || parentId.startsWith(roleFilter);
    if (matchesFilter) {
      checkRoleFunctions(sub.functions, subId, knownFunctions, issues);
    }
    if (sub.subagents && sub.subagents.length > 0) {
      checkSubagentFunctions(sub.subagents, subId, knownFunctions, issues, roleFilter);
    }
  }
}

function checkBrokenReferences(
  roles: ResolvedRole[],
  roleFilter?: string,
): Promise<ValidationIssue[]> {
  const checks: Array<{ ownerId: string; ref: ResolvedReference }> = [];
  for (const role of roles) {
    if (!roleFilter || role.id === roleFilter || role.id.startsWith(roleFilter + "/")) {
      for (const ref of role.references) {
        checks.push({ ownerId: role.id, ref });
      }
    }
    collectSubagentReferences(role.subagents, role.id, checks, roleFilter);
  }
  return resolveReferenceChecks(checks);
}

function collectSubagentReferences(
  subagents: ResolvedSubAgent[],
  parentId: string,
  checks: Array<{ ownerId: string; ref: ResolvedReference }>,
  roleFilter?: string,
): void {
  for (const sub of subagents) {
    const subId = `${parentId}/${sub.id}`;
    const matchesFilter =
      !roleFilter || subId === roleFilter || subId.startsWith(roleFilter + "/") || parentId.startsWith(roleFilter);
    if (matchesFilter) {
      for (const ref of sub.references) {
        checks.push({ ownerId: subId, ref });
      }
    }
    if (sub.subagents && sub.subagents.length > 0) {
      collectSubagentReferences(sub.subagents, subId, checks, roleFilter);
    }
  }
}

async function resolveReferenceChecks(
  checks: Array<{ ownerId: string; ref: ResolvedReference }>,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  for (const { ownerId, ref } of checks) {
    if (!ref.filePath) continue;
    try {
      const exists = await Bun.file(ref.filePath).exists();
      if (!exists) {
        issues.push({
          asset: `${ownerId}/${ref.name}`,
          type: "reference",
          issue: `file not found: ${ref.filePath}`,
          severity: "error",
        });
      }
    } catch (e) {
      issues.push({
        asset: `${ownerId}/${ref.name}`,
        type: "reference",
        issue: `Reference path could not be verified: ${ref.filePath} (${(e as Error).message})`,
        severity: "warning",
      });
    }
  }
  return issues;
}

function checkTransitionConditions(
  roles: ResolvedRole[],
  knownConditions: Set<string>,
  roleFilter?: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const role of roles) {
    if (!roleFilter || role.id === roleFilter || role.id.startsWith(roleFilter + "/")) {
      checkRoleTransitions(role.functions, role.id, knownConditions, issues);
      checkSubagentTransitions(role.subagents, role.id, knownConditions, issues, roleFilter);
    } else {
      checkSubagentTransitions(role.subagents, role.id, knownConditions, issues, roleFilter);
    }
  }
  return issues;
}

function checkRoleTransitions(
  functions: ResolvedFunction[],
  ownerId: string,
  knownConditions: Set<string>,
  issues: ValidationIssue[],
): void {
  for (const fn of functions) {
    if (!fn.transitions || fn.transitions.length === 0) continue;
    for (const t of fn.transitions) {
      const condNames = extractConditionNames(t.when);
      for (const name of condNames) {
        if (!knownConditions.has(name)) {
          issues.push({
            asset: `${ownerId}/${fn.name}`,
            type: "function",
            issue: `unknown condition: ${name}`,
            severity: "warning",
          });
        }
      }
    }
  }
}

function checkSubagentTransitions(
  subagents: ResolvedSubAgent[],
  parentId: string,
  knownConditions: Set<string>,
  issues: ValidationIssue[],
  roleFilter?: string,
): void {
  for (const sub of subagents) {
    const subId = `${parentId}/${sub.id}`;
    const matchesFilter =
      !roleFilter || subId === roleFilter || subId.startsWith(roleFilter + "/") || parentId.startsWith(roleFilter);
    if (matchesFilter) {
      checkRoleTransitions(sub.functions, subId, knownConditions, issues);
    }
    if (sub.subagents && sub.subagents.length > 0) {
      checkSubagentTransitions(sub.subagents, subId, knownConditions, issues, roleFilter);
    }
  }
}

// ── Public factory ───────────────────────────────────────────────────────────

export function createAssetValidateTool(resolvedRoles: ResolvedRole[]) {
  const functionMap = collectAllFunctions(resolvedRoles);
  const knownFunctionNames = new Set(functionMap.keys());

  return defineTool({
    description:
      "Validate asset integrity across all resolved roles and sub-agents. Checks three categories: (1) missing dependencies — function.requires references a function that does not exist; (2) broken reference paths — reference.filePath points to a file that does not exist on disk; (3) unknown transition conditions — transition.when references a condition name not in the registered condition vocabulary. Results are sorted by severity (errors first).",
    args: {
      role_id: z.string().optional()
        .describe("Limit validation to assets of a specific role (by role ID). When omitted, validates all roles and their sub-agents."),

    },
    async execute(input) {
      if (resolvedRoles.length === 0) {
        return "No roles loaded. Cannot validate assets.";
      }

      const issues: ValidationIssue[] = [];
      issues.push(...checkMissingDependencies(resolvedRoles, knownFunctionNames, input.role_id));
      issues.push(...(await checkBrokenReferences(resolvedRoles, input.role_id)));
      issues.push(...checkTransitionConditions(resolvedRoles, KNOWN_CONDITIONS, input.role_id));

      return renderIssues(issues, input.role_id);
    },
  });
}
