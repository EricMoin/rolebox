import { KNOWN_CONDITIONS } from "../function/conditions.ts";
import { fileExists } from "../utils/fs.ts";
import type {
  ResolvedRole,
  ResolvedFunction,
  ResolvedReference,
  ResolvedSubAgent,
  Condition,
} from "../types.ts";

// ── Issue types ──────────────────────────────────────────────────────────────

export interface ValidationIssue {
  asset: string;
  type: "function" | "reference";
  issue: string;
  severity: "error" | "warning";
}

// ── Condition name extraction ────────────────────────────────────────────────

/** Regex matching "cond_name(arg)" — same pattern used in conditions.ts */
const CALL_RE = /^([a-z][a-z0-9_]*)\(([^)]*)\)$/;

/**
 * Recursively extract all named condition references from a Condition value.
 * Handles strings, all/any/not compound conditions, and nested conditions.
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

// ── Asset collection (recursive) ────────────────────────────────────────────

interface NamedFunction {
  name: string;
  ownerId: string;
  fn: ResolvedFunction;
}

export function collectAllFunctions(roles: ResolvedRole[]): Map<string, NamedFunction[]> {
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

// ── Validation checks ────────────────────────────────────────────────────────

/**
 * Check 1: Missing dependencies — verify every function.requires[] target exists
 * as a known function name across all roles and sub-agents.
 */
export function checkMissingDependencies(
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
      !roleFilter ||
      subId === roleFilter ||
      subId.startsWith(roleFilter + "/") ||
      parentId.startsWith(roleFilter);

    if (matchesFilter) {
      checkRoleFunctions(sub.functions, subId, knownFunctions, issues);
    }

    if (sub.subagents && sub.subagents.length > 0) {
      checkSubagentFunctions(sub.subagents, subId, knownFunctions, issues, roleFilter);
    }
  }
}

/**
 * Check 2: Broken reference paths — verify every ResolvedReference.filePath
 * exists on disk.
 */
export async function checkBrokenReferences(
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
      !roleFilter ||
      subId === roleFilter ||
      subId.startsWith(roleFilter + "/") ||
      parentId.startsWith(roleFilter);

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
    const exists = await fileExists(ref.filePath);
    if (!exists) {
      issues.push({
        asset: `${ownerId}/${ref.name}`,
        type: "reference",
        issue: `file not found: ${ref.filePath}`,
        severity: "error",
      });
    }
  }

  return issues;
}

/**
 * Check 3: Unknown transition conditions — verify every function transition's
 * when condition references a registered condition name.
 */
export function checkTransitionConditions(
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
      // "gate" is a sentinel handled by phase-machine.ts (t.when === "gate"
      // resolves to the function's own gateSatisfied), not a named condition.
      if (t.when === "gate") continue;
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
      !roleFilter ||
      subId === roleFilter ||
      subId.startsWith(roleFilter + "/") ||
      parentId.startsWith(roleFilter);

    if (matchesFilter) {
      checkRoleTransitions(sub.functions, subId, knownConditions, issues);
    }

    if (sub.subagents && sub.subagents.length > 0) {
      checkSubagentTransitions(sub.subagents, subId, knownConditions, issues, roleFilter);
    }
  }
}

// ── Issue rendering ──────────────────────────────────────────────────────────

export function renderIssues(
  issues: ValidationIssue[],
  roleFilter?: string,
): string {
  if (issues.length === 0) {
    const scope = roleFilter ? ` for role \`${roleFilter}\`` : "";
    return `## Asset Validation${scope}\n\n✅ All assets are valid — no issues found.`;
  }

  const sorted = [...issues].sort((a, b) => {
    const order: Record<string, number> = { error: 0, warning: 1 };
    return (order[a.severity] ?? 0) - (order[b.severity] ?? 0);
  });

  const errorCount = sorted.filter((i) => i.severity === "error").length;
  const warningCount = sorted.filter((i) => i.severity === "warning").length;

  const scope = roleFilter ? ` for role \`${roleFilter}\`` : "";
  const lines: string[] = [];
  lines.push(`## Asset Validation${scope}`);
  lines.push("");
  lines.push(`**${sorted.length} issue(s) found** — ${errorCount} error(s), ${warningCount} warning(s)`);
  lines.push("");

  const header = "| Asset | Type | Severity | Issue |";
  const separator = "|---|---|---|---|";
  lines.push(header);
  lines.push(separator);

  for (const issue of sorted) {
    const badge = issue.severity === "error" ? "🔴 error" : "🟡 warning";
    lines.push(`| \`${issue.asset}\` | ${issue.type} | ${badge} | ${issue.issue} |`);
  }

  return lines.join("\n");
}
