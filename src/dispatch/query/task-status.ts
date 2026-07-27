import { defineTool, type CanonicalToolContext } from "../../platform/ports/tool-factory.ts";
import { z } from "zod";
import type { DispatchManager } from "../core/manager.ts";
import { formatDuration, formatAge } from "./format-utils.ts";
import type { CanonicalToolDef } from "../../platform/types.ts";

// ─── Status glyphs ──────────────────────────────────────────────────────────

const STATUS_GLYPH: Record<string, string> = {
  running: "▸",
  pending: "●",
  completed: "✓",
  error: "✗",
  timeout: "◇",
  cancelled: "⊘",
};

function glyph(status: string): string {
  return STATUS_GLYPH[status] ?? "?";
}

// ─── Tool factory ──────────────────────────────────────────────────────────

/**
 * dispatch_status tool — all-tasks liveness summary (or per-task detail).
 * Compatibility shim restored after Phase C. Backed by DispatchManager query
 * methods (getTasksByParent / getTask / getEventState) — no graph logic.
 */
export function createDispatchStatusTool(manager: DispatchManager): CanonicalToolDef {
  return defineTool({
    description:
      "Proactively check task liveness on demand. Returns status and liveness " +
      "information for a specific task or all tasks dispatched by the calling " +
      "session. Unlike dispatch_output, this NEVER throws — even for running tasks. " +
      "Rolebox-specific: the opencode platform has no native per-task liveness query that distinguishes running from stale tasks.",
    args: {
      task_id: z
        .string()
        .optional()
        .describe(
          "Optional task ID. When omitted, returns a markdown-table summary of all tasks " +
          "for the calling session. When specified, returns detailed liveness info.",
        ),
    },
    async execute(input, context: CanonicalToolContext) {
      const sessionID = context.sessionID;

      if (input.task_id) {
        return getDetailedStatus(manager, input.task_id);
      }

      return getSessionSummary(manager, sessionID);
    },
  });
}

// ─── Summary mode (no task_id) ─────────────────────────────────────────────

function getSessionSummary(manager: DispatchManager, sessionID: string): string {
  const tasks = manager.getTasksByParent(sessionID);
  const eventState = manager.getEventState();

  if (tasks.length === 0) {
    return [
      "## Task Status",
      "",
      `No tasks found for session \`${sessionID.slice(0, 16)}…\`. No tasks have been dispatched from this agent yet.`,
    ].join("\n");
  }

  const lines: string[] = [];
  lines.push("## Task Status");
  lines.push("");
  lines.push(
    "| Glyph | Task ID | Agent | Status | Duration | Depth | Description | Last Activity | Calls | Output? | Consec. Failures |",
  );
  lines.push(
    "|-------|---------|-------|--------|----------|-------|-------------|---------------|-------|---------|------------------|",
  );

  for (const task of tasks) {
    const es = eventState.get(task.id);
    const lastActivity = es
      ? formatAge(Date.now() - es.lastProgressUpdate)
      : "—";
    const toolCalls = task.progress.toolCalls;
    const hasOutput = es?.hasProducedOutput ? "✓" : "—";
    const consecFailures =
      es && es.consecutiveFetchFailures > 0
        ? String(es.consecutiveFetchFailures)
        : "0";
    const desc = (task.description || task.prompt || "").slice(0, 40);

    lines.push(
      `| ${glyph(task.status)} | \`${task.id.slice(0, 16)}…\` | ${task.agent} | ${task.status} | ${formatDuration(task)} | ${task.depth ?? 0} | ${desc} | ${lastActivity} | ${toolCalls} | ${hasOutput} | ${consecFailures} |`,
    );
  }

  lines.push("");
  lines.push("### Legend");
  lines.push(`- ▸ running   ● pending   ✓ completed   ✗ error   ◇ timeout   ⊘ cancelled`);
  lines.push(`- \`Last Activity\`: time since last progress update (from eventState)`);
  lines.push(
    `- \`Calls\`: total tool calls made by the sub-agent so far`,
  );
  lines.push(
    `- \`Output?\`: has the sub-agent produced any output yet?`,
  );
  lines.push(
    `- \`Consec. Failures\`: consecutive fetch failures since last successful progress update. Values > 0 indicate possible hangs.`,
  );
  lines.push("");
  lines.push(
    `Use \`dispatch_status(task_id="bg_xxx")\` for detailed per-task liveness info.`,
  );

  return lines.join("\n");
}

// ─── Detailed mode (task_id specified) ──────────────────────────────────────

function getDetailedStatus(manager: DispatchManager, taskId: string): string {
  const task = manager.getTask(taskId);
  const eventState = manager.getEventState();
  const es = eventState.get(taskId);

  if (!task) {
    return [
      `## Task Status: \`${taskId}\``,
      "",
      `No active task found with ID: ${taskId}. The task may have been cleaned up or the ID may be incorrect.`,
      "",
      "Use dispatch_status() with no arguments to see all active tasks for this session.",
    ].join("\n");
  }

  const lines: string[] = [];
  lines.push(`## Task Status: \`${task.id}\``);
  lines.push("");

  // Identity
  lines.push("### Identity");
  lines.push(`- **Task ID**: \`${task.id}\``);
  lines.push(`- **Agent**: ${task.agent}`);
  lines.push(`- **Mode**: ${task.mode ?? "background"}`);
  lines.push(`- **Description**: ${task.description || "N/A"}`);
  lines.push(`- **Depth**: ${task.depth ?? 0}`);
  lines.push(`- **Session ID**: \`${task.sessionId}\``);
  lines.push(`- **Parent Session ID**: \`${task.parentSessionId}\``);
  if (task.concurrencyKey) {
    lines.push(`- **Concurrency Key**: ${task.concurrencyKey}`);
  }
  lines.push("");

  // Status
  lines.push(`### Status: ${glyph(task.status)} ${task.status}`);
  lines.push(`- **Started**: ${task.startedAt.toISOString()}`);
  if (task.completedAt) {
    lines.push(`- **Completed**: ${task.completedAt.toISOString()}`);
  }
  lines.push(`- **Duration**: ${formatDuration(task)}`);
  if (task.error) {
    lines.push(`- **Error**: ${task.error}`);
  }
  lines.push("");

  // Liveness (from eventState)
  if (es) {
    const lastActivityMs = Date.now() - es.lastProgressUpdate;
    lines.push("### Liveness");
    lines.push(
      `- **Last Activity**: ${formatAge(lastActivityMs)} ago (${new Date(es.lastProgressUpdate).toISOString()})`,
    );
    lines.push(`- **Last Event**: ${formatAge(Date.now() - es.lastEventAt)} ago`);
    lines.push(`- **Tool Calls**: ${task.progress.toolCalls}`);
    lines.push(`- **Has Produced Output**: ${es.hasProducedOutput ? "✓ yes" : "— no"}`);
    lines.push(`- **Last Message Count**: ${es.lastMessageCount}`);
    lines.push(`- **Message Count At Start**: ${es.messageCountAtStart}`);
    lines.push(`- **Consecutive Fetch Failures**: ${es.consecutiveFetchFailures > 0 ? `⚠️ ${es.consecutiveFetchFailures}` : "0"}`);

    if (es.pendingConfirm) {
      lines.push(
        `- **Pending Confirm**: messageCount=${es.pendingConfirm.messageCount} at=${new Date(es.pendingConfirm.at).toISOString()}`,
      );
    }
  } else {
    lines.push("### Liveness");
    lines.push("_(no eventState data — task may be pre-eventState era or just started)_");
    lines.push(`- **Tool Calls**: ${task.progress.toolCalls}`);
    lines.push(`- **Last Update**: ${task.progress.lastUpdate.toISOString()}`);
  }
  lines.push("");

  // Result (terminal tasks)
  if (task.status === "completed" || task.status === "error" || task.status === "cancelled" || task.status === "timeout") {
    lines.push("### Result");
    if (task.result) {
      lines.push(`- **Sidecar Path**: \`${task.result.sidecarPath}\``);
      lines.push(`- **Total Chars**: ${task.result.totalChars}`);
      lines.push(`- **Has \`result\` Fence**: ${task.result.hadFence ? "✓" : "—"}`);
      if (task.result.fetchError) {
        lines.push(`- **Fetch Error**: ${task.result.fetchError}`);
      }
      lines.push(`- **Materialized At**: ${task.result.materializedAt}`);
    } else {
      lines.push(
        "_(result not yet materialized — completing/harvesting in progress)_",
      );
    }
    lines.push("");
    lines.push(
      `Use \`dispatch_output(task_id="${task.id}")\` to retrieve the full result.`,
    );
  } else {
    lines.push(
      "Task is still in progress. Use dispatch_status() again later to check for updates.",
    );
  }

  return lines.join("\n");
}
