import { defineTool, type CanonicalToolContext } from "../../platform/ports/tool-factory.ts";
import { z } from "zod";
import type { DispatchManager } from "../core/manager.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("task:budget");

/**
 * Format a limit value for display: show the number when configured,
 * "unlimited" when undefined.
 */
function fmtLimit(v: number | undefined): string {
  return v !== undefined ? String(v) : "unlimited";
}

/**
 * Calculate percentage string, or "—" when limit is not configured or zero.
 */
function pct(value: number, limit: number | undefined): string {
  if (limit === undefined || limit <= 0) return "—";
  return `${((value / limit) * 100).toFixed(1)}%`;
}

/**
 * Calculate remaining quota, or "—" when limit is not configured.
 */
function fmtRemaining(value: number, limit: number | undefined): string {
  if (limit === undefined || limit <= 0) return "—";
  const remaining = Math.max(0, limit - value);
  if (remaining === 0) return "0 (exhausted)";
  return String(remaining);
}

export function createTaskBudgetTool(dispatchManager: DispatchManager) {
  return defineTool({
    description:
      "Query budget usage — token/cost consumption, remaining quota, and trigger limits for the current request. Rolebox-specific: the opencode platform has no native concept of dispatch budget tracking.",
    args: {
      session_id: z
        .string()
        .optional()
        .describe("Session ID to inspect (defaults to current tool context session ID)"),
      detail: z
        .boolean()
        .optional()
        .default(false)
        .describe("When true, include per-task usage breakdown for all child tasks dispatched from this session"),
    },
    async execute(input, context: CanonicalToolContext) {
      const sessionID = input.session_id ?? context.sessionID;
      const budgetTracker = dispatchManager.getBudgetTracker();
      const config = dispatchManager.getConfig();

      const requestUsage = budgetTracker.getRequestUsage(sessionID);
      const requestCheck = budgetTracker.isRequestBudgetExceeded(sessionID);

      const lines: string[] = [];
      lines.push(`## Task Budget: \`${sessionID}\``);
      lines.push("");

      // ── Request-level summary ──────────────────────────────────────────
      lines.push("### Request-level Usage (cumulative across all dispatched sessions)");
      lines.push("");
      lines.push("| Metric | Current | Limit | % Used | Remaining |");
      lines.push("|--------|---------|-------|--------|-----------|");
      lines.push(
        `| Input Tokens | ${requestUsage.inputTokens} | ${fmtLimit(config.maxInputTokensPerRequest)} | ` +
        `${pct(requestUsage.inputTokens, config.maxInputTokensPerRequest)} | ` +
        `${fmtRemaining(requestUsage.inputTokens, config.maxInputTokensPerRequest)} |`,
      );
      lines.push(
        `| Output Tokens | ${requestUsage.outputTokens} | ${fmtLimit(config.maxOutputTokensPerRequest)} | ` +
        `${pct(requestUsage.outputTokens, config.maxOutputTokensPerRequest)} | ` +
        `${fmtRemaining(requestUsage.outputTokens, config.maxOutputTokensPerRequest)} |`,
      );
      lines.push(
        `| Cost (USD) | ${requestUsage.cost.toFixed(6)} | ${fmtLimit(config.maxCostPerRequest)} | ` +
        `${pct(requestUsage.cost, config.maxCostPerRequest)} | ` +
        `${fmtRemaining(requestUsage.cost, config.maxCostPerRequest)} |`,
      );
      lines.push("");

      // ── Per-session limits ─────────────────────────────────────────────
      lines.push("### Per-session Limits");
      lines.push("");
      lines.push("| Metric | Limit |");
      lines.push("|--------|-------|");
      lines.push(`| Input Tokens (per session) | ${fmtLimit(config.maxInputTokensPerSession)} |`);
      lines.push(`| Cost (USD, per session) | ${fmtLimit(config.maxCostPerSession)} |`);
      lines.push(`| Total Sessions (per request) | ${fmtLimit(config.maxTotalSessionsPerRequest)} |`);
      lines.push("");

      // ── Budget exceeded warnings ───────────────────────────────────────
      if (requestCheck.exceeded) {
        lines.push("> ⚠️ **Request budget exceeded:** " + requestCheck.reason);
        lines.push("");
      }

      // ── Detail: per-task breakdown ─────────────────────────────────────
      if (input.detail) {
        const tasks = dispatchManager.getTasksByParent(sessionID);

        if (tasks.length === 0) {
          lines.push("### Per-task Breakdown");
          lines.push("");
          lines.push("No child tasks found for this session.");
        } else {
          lines.push(`### Per-task Breakdown (${tasks.length} tasks)`);
          lines.push("");
          lines.push(
            "| Task ID | Agent | Status | Input Tokens | Output Tokens | Cost (USD) | Budget Exceeded |",
          );
          lines.push(
            "|---------|-------|--------|-------------|--------------|------------|-----------------|",
          );

          for (const task of tasks) {
            // If the task never got a session (pending/error before session creation),
            // there is no session usage to show.
            let sessionUsage;
            let sessionCheck;
            if (task.sessionId) {
              sessionUsage = budgetTracker.getSessionUsage(task.sessionId);
              sessionCheck = budgetTracker.isSessionBudgetExceeded(task.sessionId);
            } else {
              sessionUsage = { inputTokens: 0, outputTokens: 0, cost: 0 };
              sessionCheck = { exceeded: false };
            }
            const exceededStr = sessionCheck.exceeded ? "⚠️ Yes" : "—";

            lines.push(
              `| ${task.id.slice(0, 16)} | ${task.agent} | ${task.status} | ` +
              `${sessionUsage.inputTokens} | ${sessionUsage.outputTokens} | ` +
              `${sessionUsage.cost.toFixed(6)} | ${exceededStr} |`,
            );
          }
        }
      }

      log.debug(
        `task_budget session=${sessionID.slice(0, 12)} detail=${input.detail}`,
        { tag: "budget-query", taskId: sessionID },
      );

      return lines.join("\n");
    },
  });
}
