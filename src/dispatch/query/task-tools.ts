/**
 * task-tools.ts — Restored legacy `task_*` compatibility surface.
 *
 * The seven task_* tools were renamed to dispatch_* in commit 18e3f68 and
 * later consolidated into the graph execution engine (Phase C). The external
 * test suite still expects the legacy names, so this module restores them as
 * THIN ADAPTERS over the surviving subsystems — it must NOT duplicate logic
 * that already lives in the dispatch/graph/query/progress/checkpoint modules.
 *
 * Each factory returns a real CanonicalToolDef (via defineTool) backed by the
 * DispatchManager and its subservices. They are wired into the platform via
 * `taskToolsOverride` in buildCanonicalTools (see src/platform/tool-assembly.ts
 * and src/core/services/tool-service.ts), mirroring the dispatch_* and loop_*
 * restoration pattern.
 */

import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { defineTool, type CanonicalToolContext } from "../../platform/ports/tool-factory.ts";
import { z } from "zod";
import type { DispatchManager } from "../core/manager.ts";
import type { DispatchInput, DispatchTask } from "../types.ts";
import {
  extractResultBlock,
  readResultSidecar,
  resultSidecarPath,
} from "../completion/result-extractor.ts";
import { formatDuration, formatDurationBetween } from "./format-utils.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("task:tools");

/** Dispatch task statuses considered terminal (no longer in-flight). */
const TERMINAL_STATUSES = new Set(["completed", "error", "cancelled", "timeout"]);

/** Ordered dispatch task statuses used as chronology columns. */
const STATUS_COLUMNS = [
  "pending",
  "running",
  "completed",
  "awaiting_approval",
  "error",
  "cancelled",
  "timeout",
] as const;

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/** Resolve an output path inside the workspace, rejecting path traversal. */
function resolveWithinWorkspace(
  context: CanonicalToolContext,
  exportPath: string,
): { fullPath: string } | { error: string } {
  const root = resolve(context.worktree || context.directory || ".");
  const fullPath = resolve(root, exportPath);
  const rel = relative(root, fullPath);
  if (rel.startsWith("..")) {
    return { error: `Path traversal detected — "${exportPath}" resolves outside the project root` };
  }
  return { fullPath };
}

/** Atomically write text to a file, creating parent dirs as needed. */
function writeFileAtomic(fullPath: string, content: string): void {
  const dir = dirname(fullPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = fullPath + ".tmp";
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, fullPath);
}

// ── task_search ────────────────────────────────────────────────────────────

export function createTaskSearchTool(
  dispatchManager: DispatchManager,
  directory: string,
) {
  return defineTool({
    description:
      "Search dispatch task history by query text, status, or date range. Searches task prompt, description, and agent name. Returns a markdown table of matching tasks with status, duration, and an optional result preview. Rolebox-specific: the opencode platform has no native task search with status/query filtering.",
    args: {
      query: z
        .string()
        .min(1)
        .describe("Search query — matched against task prompt, description, and agent name (case-insensitive substring)"),
      status: z
        .enum(["pending", "running", "completed", "awaiting_approval", "error", "cancelled", "timeout"])
        .optional()
        .describe("Filter by task status"),
      from_date: z
        .string()
        .optional()
        .describe("ISO 8601 — only tasks started after this date"),
      to_date: z
        .string()
        .optional()
        .describe("ISO 8601 — only tasks started before this date"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .describe("Max results (default 20)"),
      include_result: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include a truncated preview of the task result text (first 200 chars)"),
    },
    async execute(input) {
      const tasks = dispatchManager.getAllTasks();
      if (tasks.length === 0) {
        return "No dispatch tasks found.";
      }

      const query = input.query.toLowerCase();

      let filtered = tasks.filter((t) => {
        const searchText = [t.prompt ?? "", t.description ?? "", t.agent ?? ""]
          .join(" ")
          .toLowerCase();
        return searchText.includes(query);
      });

      if (input.status) {
        filtered = filtered.filter((t) => t.status === input.status);
      }
      if (input.from_date) {
        const fromMs = new Date(input.from_date).getTime();
        if (!isNaN(fromMs)) {
          filtered = filtered.filter((t) => t.startedAt.getTime() >= fromMs);
        }
      }
      if (input.to_date) {
        const toMs = new Date(input.to_date).getTime();
        if (!isNaN(toMs)) {
          filtered = filtered.filter((t) => t.startedAt.getTime() <= toMs);
        }
      }

      filtered.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
      const limited = filtered.slice(0, input.limit ?? 20);

      if (limited.length === 0) {
        return `No tasks matching "${input.query}".`;
      }

      const header =
        "| Task ID | Agent | Status | Started | Duration | Description |" +
        (input.include_result ? " Result Preview |" : "") +
        "\n|---|---|---|---|---|---|" +
        (input.include_result ? "---|" : "");

      const rows = await Promise.all(
        limited.map(async (t) => {
          const duration = formatDuration(t);
          const desc = (t.description ?? t.prompt ?? "").slice(0, 60);
          let row = `| ${t.id} | ${t.agent} | ${t.status} | ${formatDate(t.startedAt)} | ${duration} | ${desc} |`;
          if (input.include_result) {
            row += ` ${await getResultPreview(t, directory)} |`;
          }
          return row;
        }),
      );

      return `## Task Search Results: "${input.query}"\n\nFound ${filtered.length} matching task(s)${filtered.length > limited.length ? ` (showing first ${limited.length})` : ""}.\n\n${header}\n${rows.join("\n")}`;
    },
  });
}

async function getResultPreview(task: DispatchTask, directory: string): Promise<string> {
  try {
    if (task.result?.sidecarPath) {
      const text = readResultSidecar(task.result.sidecarPath);
      if (text) {
        const preview = extractResultBlock(text).result.slice(0, 200);
        return preview.length === 200 ? preview + "..." : preview;
      }
    }
    const sidecarPath = resultSidecarPath(task.id, directory);
    const text = readResultSidecar(sidecarPath);
    if (text) {
      const preview = extractResultBlock(text).result.slice(0, 200);
      return preview.length === 200 ? preview + "..." : preview;
    }
    return "(no result)";
  } catch (err) {
    log.warn("Failed to read result preview", { taskId: task.id, error: String(err) });
    return "(error reading result)";
  }
}

// ── task_budget ────────────────────────────────────────────────────────────

function fmtLimit(v: number | undefined): string {
  return v !== undefined ? String(v) : "unlimited";
}

function pct(value: number, limit: number | undefined): string {
  if (limit === undefined || limit <= 0) return "—";
  return `${((value / limit) * 100).toFixed(1)}%`;
}

function fmtRemaining(value: number, limit: number | undefined): string {
  if (limit === undefined || limit <= 0) return "—";
  const remaining = Math.max(0, limit - value);
  return remaining === 0 ? "0 (exhausted)" : String(remaining);
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
    },
    async execute(input, context: CanonicalToolContext) {
      const sessionID = input.session_id ?? context.sessionID;
      const budgetTracker = dispatchManager.getBudgetTracker();
      const config = dispatchManager.getConfig();

      const requestUsage = budgetTracker.getRequestUsage(sessionID);
      budgetTracker.isRequestBudgetExceeded(sessionID);

      // Sessions used under this parent = child tasks dispatched from it.
      const childTasks = dispatchManager.getTasksByParent(sessionID);
      const sessionsUsed = childTasks.length;

      const lines: string[] = [];
      lines.push(`## Task Budget: \`${sessionID}\``);
      lines.push("");

      lines.push("### Request-level Usage (cumulative across all dispatched sessions)");
      lines.push("");
      lines.push("| Metric | Current | Limit | % Used | Remaining |");
      lines.push("|--------|---------|-------|--------|-----------|");
      lines.push(
        `| Sessions | ${sessionsUsed} | ${fmtLimit(config.maxTotalSessionsPerRequest)} | ` +
          `${pct(sessionsUsed, config.maxTotalSessionsPerRequest)} | ` +
          `${fmtRemaining(sessionsUsed, config.maxTotalSessionsPerRequest)} |`,
      );
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

      return lines.join("\n");
    },
  });
}

// ── task_graph ──────────────────────────────────────────────────────────────

interface TaskNode {
  task: DispatchTask;
  depth: number;
  children: TaskNode[];
}

function buildChildren(
  dispatchManager: DispatchManager,
  parentSessionId: string,
  currentDepth: number,
  maxDepth: number,
  visited: Set<string>,
): TaskNode[] {
  if (visited.has(parentSessionId)) return [];
  visited.add(parentSessionId);

  const tasks = dispatchManager.getTasksByParent(parentSessionId);
  if (tasks.length === 0 || currentDepth >= maxDepth) return [];

  const nodes: TaskNode[] = [];
  for (const task of tasks) {
    const grandchildren = buildChildren(dispatchManager, task.sessionId, currentDepth + 1, maxDepth, visited);
    nodes.push({ task, depth: currentDepth, children: grandchildren });
  }
  return nodes;
}

function collectCompletedIds(children: TaskNode[], ids: string[]): void {
  for (const node of children) {
    if (node.task.status === "completed") {
      ids.push(node.task.id);
    }
    collectCompletedIds(node.children, ids);
  }
}

async function fetchPreviews(
  dispatchManager: DispatchManager,
  taskIds: string[],
  previews: Map<string, string>,
): Promise<void> {
  await Promise.all(
    taskIds.map(async (id) => {
      const result = await dispatchManager.getResult(id);
      if (result.kind === "ok" && (result.resultText || result.text)) {
        const preview = (result.resultText || result.text).slice(0, 100);
        previews.set(id, preview.length === 100 ? preview + "..." : preview);
      }
    }),
  );
}

function renderTree(
  rootTask: DispatchTask | undefined,
  children: TaskNode[],
  previews: Map<string, string>,
  showStatus: boolean,
  rootSession: string,
  maxDepth: number,
): string {
  const lines: string[] = [];
  lines.push(`## Task Graph: \`${rootSession}\``);
  lines.push("");

  if (rootTask) {
    const status = showStatus ? ` [${rootTask.status}] ${rootTask.agent}` : "";
    lines.push(`- Root: \`${rootTask.id}\`${status}`);
  }

  if (children.length === 0) {
    lines.push("");
    lines.push("No child tasks found.");
  }

  for (const node of children) {
    lines.push(renderNode(node, previews, showStatus, 1));
  }

  lines.push("");
  lines.push(`(Max depth expanded: ${maxDepth})`);
  return lines.join("\n");
}

function renderNode(
  node: TaskNode,
  previews: Map<string, string>,
  showStatus: boolean,
  level: number,
): string {
  const indent = "  ".repeat(level);
  const status = showStatus ? ` [${node.task.status}] ${node.task.agent}` : "";
  const preview = previews.get(node.task.id);
  let line = `${indent}- \`${node.task.id}\`${status}`;
  if (preview) {
    line += ` — ${preview}`;
  }
  const childLines = node.children.map((c) => renderNode(c, previews, showStatus, level + 1));
  return [line, ...childLines].join("\n");
}

export function createTaskGraphTool(dispatchManager: DispatchManager) {
  return defineTool({
    description:
      "Visualise the dispatch task dependency tree. Builds a parent-child tree from DispatchTask parentSessionId/sessionId relations. Shows an indented tree with status, agent, nesting depth, and optional result summaries. When no root is given, renders every top-level (parentless) task forest. Rolebox-specific: opencode session_list only shows flat task lists.",
    args: {
      root_session: z
        .string()
        .optional()
        .describe("Session ID to use as tree root — shows all tasks dispatched from this session. When omitted, shows all root tasks."),
      depth: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .default(5)
        .describe("Max nesting depth to expand (default 5, max 20)"),
      include_status: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include task status, depth, and agent in each node label (default true)"),
    },
    async execute(input) {
      const maxDepth = input.depth ?? 5;
      const showStatus = input.include_status !== false;

      const allTasks = dispatchManager.getAllTasks();
      if (allTasks.length === 0) {
        return "No dispatch tasks found.";
      }

      // When no root provided, derive forest roots: tasks whose parent session
      // is not itself a known task session (i.e. top-level dispatches).
      const sessionIds = new Set(allTasks.map((t) => t.sessionId));
      const roots =
        input.root_session !== undefined
          ? [{ sessionId: input.root_session, label: input.root_session }]
          : allTasks
              .filter((t) => !sessionIds.has(t.parentSessionId))
              .map((t) => ({ sessionId: t.sessionId, label: t.sessionId }));

      if (roots.length === 0 && input.root_session === undefined) {
        // Fall back: show the full set as a flat forest rooted at each task.
        roots.push(...allTasks.map((t) => ({ sessionId: t.sessionId, label: t.sessionId })));
      }

      const sections: string[] = [];
      for (const root of roots) {
        const rootTask = allTasks.find((t) => t.sessionId === root.sessionId);
        const visited = new Set<string>();
        const children = buildChildren(dispatchManager, root.sessionId, 1, maxDepth, visited);

        const completedIds: string[] = [];
        if (rootTask && rootTask.status === "completed") completedIds.push(rootTask.id);
        collectCompletedIds(children, completedIds);
        const previews = new Map<string, string>();
        if (completedIds.length > 0) {
          await fetchPreviews(dispatchManager, completedIds, previews);
        }
        sections.push(renderTree(rootTask, children, previews, showStatus, root.label, maxDepth));
      }

      return sections.join("\n\n");
    },
  });
}

// ── task_retry ─────────────────────────────────────────────────────────────

export function createTaskRetryTool(dispatchManager: DispatchManager) {
  return defineTool({
    description:
      "Retry a failed dispatch task — reopens the original session for continuation via DispatchManager.reopenForContinuation(). Only tasks in a terminal state (completed, error, cancelled, timeout) can be retried. The original session is reused so all prior context is preserved. Rolebox-specific: opencode has no native retry mechanism for dispatched sub-agent tasks.",
    args: {
      task_id: z
        .string()
        .min(1)
        .describe("ID of the task to retry"),
      modify_prompt: z
        .string()
        .optional()
        .describe("Optional text to prepend to the original task prompt before retrying"),
      reset_budget: z
        .boolean()
        .optional()
        .default(false)
        .describe("When true, the retry does not count toward the parent session's dispatch budget limit"),
    },
    async execute(input, context: CanonicalToolContext) {
      const { task_id, modify_prompt, reset_budget } = input;

      const task = dispatchManager.getTask(task_id);
      if (!task) {
        return `Task \`${task_id}\` not found. It may have been cleaned up or never existed.`;
      }
      if (!TERMINAL_STATUSES.has(task.status)) {
        return `Task \`${task_id}\` is still ${task.status}. Cancel it first before retrying.`;
      }

      let prompt = modify_prompt ? modify_prompt + "\n" + task.prompt : task.prompt;

      const checkpointStore = dispatchManager.getCheckpointStore();
      if (await checkpointStore.hasCheckpoint(task_id)) {
        const checkpointContext = await checkpointStore.buildRetryContext(task_id);
        if (checkpointContext) {
          log.debug(`task_retry id=${task_id}: injecting checkpoint context into retry prompt`);
          prompt = checkpointContext + "\n\n---\n\n" + prompt;
        }
      }

      if (reset_budget) {
        dispatchManager.getBudgetTracker().resetSessionUsage(task.sessionId, task.parentSessionId);
        log.debug(`task_retry id=${task_id}: budget reset for session ${task.sessionId.slice(0, 12)}`);
      }

      const dispatchInput: DispatchInput = {
        subagent: task.agent,
        prompt,
        run_in_background: true,
        description: task.description,
        timeout_ms: task.timeoutMs,
      };

      const parentContext = {
        sessionID: context.sessionID,
        agent: context.agent,
        directory: context.directory,
      };

      try {
        const retriedTask = await dispatchManager.reopenForContinuation(task_id, dispatchInput, parentContext);
        log.debug(`task_retry id=${task_id} status=${retriedTask.status} agent=${retriedTask.agent}`, {
          tag: "task-retry",
          taskId: task_id,
        });
        return `Retried task \`${task_id}\` → new task \`${retriedTask.id}\` (status: ${retriedTask.status}, agent: ${retriedTask.agent}). Use task_output \`${retriedTask.id}\` to fetch its result when complete.`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`task_retry failed for id=${task_id}: ${message}`, { tag: "task-retry", taskId: task_id });
        return `Retry failed for task \`${task_id}\`: ${message}`;
      }
    },
  });
}

// ── task_concurrency ───────────────────────────────────────────────────────

export function createTaskConcurrencyTool(manager: DispatchManager) {
  return defineTool({
    description:
      "Retrieve real-time concurrency slot status per concurrency key. Shows active slots, limits, available capacity, reserved slots, and queue depth. Returns a human-readable summary or JSON. Optionally exports the status JSON to a file. Rolebox-specific: the opencode platform has no native concurrency slot monitoring.",
    args: {
      format: z
        .enum(["summary", "json"])
        .optional()
        .default("summary")
        .describe("Output format: 'summary' for human-readable, 'json' for machine parsing"),
      export_path: z
        .string()
        .optional()
        .describe("Optional file path to write the status JSON atomically"),
    },
    async execute(input, context: CanonicalToolContext) {
      const status = manager.getConcurrencyStatus();
      const jsonStr = JSON.stringify(status, null, 2);

      if (input.export_path) {
        const resolved = resolveWithinWorkspace(context, input.export_path);
        if ("error" in resolved) {
          return `Error: ${resolved.error}`;
        }
        writeFileAtomic(resolved.fullPath, jsonStr);
      }

      if (input.format === "json") {
        return jsonStr;
      }

      if (status.keys.length === 0) {
        return "No concurrency keys registered. No tasks have been dispatched yet.";
      }

      const lines: string[] = ["## Task Concurrency Status", ""];
      lines.push("### Per-Key Breakdown");
      lines.push("");
      lines.push("| Key | Active | Limit | Available | Reserved | Queue Depth |");
      lines.push("|-----|--------|-------|-----------|----------|-------------|");
      for (const key of status.keys) {
        lines.push(
          `| ${key.key} | ${key.active} | ${key.limit} | ${key.available} | ${key.reserved} | ${key.queueDepth} |`,
        );
      }
      lines.push("");
      lines.push("### Global Summary");
      lines.push("");
      lines.push(`- Total active: ${status.total.active}`);
      lines.push(`- Total limit: ${status.total.limit}`);
      lines.push(`- Total queue depth: ${status.total.queueDepth}`);
      lines.push(`- Concurrency keys: ${status.total.keys}`);

      return lines.join("\n");
    },
  });
}

// ── task_chronology ────────────────────────────────────────────────────────

type GroupByMode = "hour" | "day" | "agent";

function bucketKey(task: { startedAt: Date; agent: string }, groupBy: GroupByMode): string {
  switch (groupBy) {
    case "hour": {
      const d = task.startedAt;
      return (
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-` +
        `${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:00`
      );
    }
    case "day": {
      const d = task.startedAt;
      return (
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-` +
        `${String(d.getDate()).padStart(2, "0")}`
      );
    }
    case "agent":
      return task.agent;
  }
}

function buildTable(
  buckets: Array<{ key: string; count: number; statusCounts: Record<string, number> }>,
  groupBy: GroupByMode,
  fromDate: string | undefined,
  toDate: string | undefined,
): string {
  const lines: string[] = [
    "## Task Chronology",
    "",
    `Grouped by: ${groupBy}`,
    `Range: ${fromDate || "beginning"} to ${toDate || "now"}`,
    "",
  ];

  const header = ["Bucket", "Count", ...STATUS_COLUMNS.map((s) => s.charAt(0).toUpperCase() + s.slice(1))];
  const separator = ["--------", "-------", ...STATUS_COLUMNS.map(() => "---------")];

  lines.push("| " + header.join(" | ") + " |");
  lines.push("| " + separator.join(" | ") + " |");

  for (const b of buckets) {
    const row = [b.key, String(b.count), ...STATUS_COLUMNS.map((s) => String(b.statusCounts[s]))];
    lines.push("| " + row.join(" | ") + " |");
  }

  return lines.join("\n");
}

export function createTaskChronologyTool(manager: DispatchManager) {
  return defineTool({
    description:
      "Show time-bucketed task activity. Returns a markdown table grouped by hour, day, or agent with status distribution counts. Rolebox-specific: the opencode platform has no native time-bucketed task chronology view.",
    args: {
      group_by: z
        .enum(["hour", "day", "agent"])
        .optional()
        .default("hour")
        .describe("Bucket grouping"),
      from_date: z
        .string()
        .optional()
        .describe("ISO 8601 — filter tasks started from this date"),
      to_date: z
        .string()
        .optional()
        .describe("ISO 8601 — filter tasks started until this date"),
    },
    async execute(input) {
      const allTasks = manager.getAllTasks();
      if (allTasks.length === 0) {
        return "No tasks found.";
      }

      const fromDate = input.from_date ? new Date(input.from_date) : undefined;
      const toDate = input.to_date ? new Date(input.to_date) : undefined;

      const filtered = allTasks.filter((task) => {
        if (fromDate && task.startedAt < fromDate) return false;
        if (toDate && task.startedAt > toDate) return false;
        return true;
      });

      if (filtered.length === 0) {
        return "No tasks in the specified date range.";
      }

      const groupBy = input.group_by ?? "hour";
      const bucketMap = new Map<string, { count: number; statusCounts: Record<string, number> }>();

      for (const task of filtered) {
        const key = bucketKey(task, groupBy);
        if (!bucketMap.has(key)) {
          const statusCounts: Record<string, number> = {};
          for (const s of STATUS_COLUMNS) statusCounts[s] = 0;
          bucketMap.set(key, { count: 0, statusCounts });
        }
        const bucket = bucketMap.get(key)!;
        bucket.count++;
        bucket.statusCounts[task.status] = (bucket.statusCounts[task.status] ?? 0) + 1;
      }

      const entries = [...bucketMap.entries()].sort(([a], [b]) => a.localeCompare(b));
      const buckets = entries.map(([key, data]) => ({ key, ...data }));

      return buildTable(buckets, groupBy, input.from_date, input.to_date);
    },
  });
}

// ── task_export ────────────────────────────────────────────────────────────

export function createTaskExportTool(
  manager: DispatchManager,
  directory: string,
) {
  return defineTool({
    description: "Export a completed task's full result to a file (markdown or JSON). Rolebox-specific: the opencode platform has no native per-task export mechanism.",
    args: {
      task_id: z.string().describe("Task ID to export"),
      format: z
        .enum(["markdown", "json"])
        .optional()
        .default("markdown")
        .describe("Output format: 'markdown' or 'json'"),
      export_path: z
        .string()
        .optional()
        .describe("File path relative to project root (worktree)"),
      output_path: z
        .string()
        .optional()
        .describe("Alias of export_path (legacy pre-rename name). Used only when export_path is absent."),
      include_prompt: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include the task prompt in output"),
    },
    async execute(input, context: CanonicalToolContext) {
      const taskId = input.task_id;

      const task = manager.getTask(taskId);
      const result = await manager.getResult(taskId);

      if (result.kind === "not_found") {
        return `Task not found: ${taskId}`;
      }
      if (result.kind === "expired") {
        return `Task result expired: ${taskId}`;
      }
      if (result.kind === "fetch_error") {
        return `Task result fetch error: ${result.error}`;
      }

      const exportPath = input.export_path ?? input.output_path;
      if (!exportPath) {
        return "Error: export_path (or output_path) is required to write the export file.";
      }

      const meta: {
        id: string;
        agent: string;
        description: string | undefined;
        status: string;
        startedAt: Date;
        completedAt: Date | undefined;
        prompt: string | undefined;
      } = task
        ? {
            id: task.id,
            agent: task.agent,
            description: task.description,
            status: task.status,
            startedAt: task.startedAt,
            completedAt: task.completedAt,
            prompt: task.prompt,
          }
        : {
            id: taskId,
            agent: "unknown",
            description: undefined,
            status: "completed",
            startedAt: new Date(0),
            completedAt: undefined,
            prompt: undefined,
          };

      const resultContent = result.resultText || result.text || "";

      let content: string;
      if (input.format === "json") {
        content = JSON.stringify(
          {
            task_id: meta.id,
            agent: meta.agent,
            description: meta.description ?? null,
            status: meta.status,
            started_at: meta.startedAt.toISOString(),
            completed_at: meta.completedAt?.toISOString() ?? null,
            prompt: input.include_prompt ? (meta.prompt ?? null) : null,
            result: resultContent,
          },
          null,
          2,
        );
      } else {
        const duration = meta.completedAt
          ? formatDurationBetween(meta.startedAt, meta.completedAt)
          : "N/A";

        const lines: string[] = [];
        lines.push("# Task Export");
        lines.push("");
        lines.push(`- **Task ID:** ${meta.id}`);
        lines.push(`- **Agent:** ${meta.agent}`);
        lines.push(`- **Description:** ${meta.description || "N/A"}`);
        lines.push(`- **Status:** ${meta.status}`);
        lines.push(`- **Started:** ${meta.startedAt.toISOString()}`);
        lines.push(`- **Completed:** ${meta.completedAt?.toISOString() || "N/A"}`);
        lines.push(`- **Duration:** ${duration}`);
        lines.push("");

        if (input.include_prompt && meta.prompt) {
          lines.push("## Prompt");
          lines.push("");
          lines.push(meta.prompt);
          lines.push("");
        }

        lines.push("## Result");
        lines.push("");
        lines.push(resultContent);
        content = lines.join("\n");
      }

      const resolved = resolveWithinWorkspace(context, exportPath);
      if ("error" in resolved) {
        return `Error: ${resolved.error}`;
      }
      writeFileAtomic(resolved.fullPath, content);

      return `Exported task ${taskId} to ${resolved.fullPath} (${content.length} chars, ${input.format} format)`;
    },
  });
}

// ── Aggregated surface ─────────────────────────────────────────────────────

/**
 * Build the restored legacy `task_*` tool surface.
 *
 * Thin adapters over the surviving subsystems (dispatch manager, budget,
 * checkpoint, concurrency, graph status queries). Consumed via `taskToolsOverride`
 * in buildCanonicalTools (see src/platform/tool-assembly.ts and
 * src/core/services/tool-service.ts).
 */
export function createTaskTools(
  manager: DispatchManager,
  directory: string,
): Record<string, ReturnType<typeof defineTool>> {
  return {
    task_search: createTaskSearchTool(manager, directory),
    task_budget: createTaskBudgetTool(manager),
    task_graph: createTaskGraphTool(manager),
    task_retry: createTaskRetryTool(manager),
    task_concurrency: createTaskConcurrencyTool(manager),
    task_chronology: createTaskChronologyTool(manager),
    task_export: createTaskExportTool(manager, directory),
  };
}
