// ── Issue types ──────────────────────────────────────────────────────────────

export interface ValidationIssue {
  asset: string;
  type: "function" | "reference";
  issue: string;
  severity: "error" | "warning";
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

  // Sort: errors first, then warnings
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

  // Summary table
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
