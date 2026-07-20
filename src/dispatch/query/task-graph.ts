import { defineTool } from "../../platform/ports/tool-factory.ts";
import { z } from "zod";
import type { DispatchManager } from "../core/manager.ts";
import type { DispatchTask } from "../types.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("task:graph");

// ── Internal tree node ───────────────────────────────────────────────────────

interface TaskNode {
  task: DispatchTask;
  depth: number;
  children: TaskNode[];
}

// ── Factory function ─────────────────────────────────────────────────────────

export function createTaskGraphTool(dispatchManager: DispatchManager) {
  return defineTool({
    description:
      "Visualise the dispatch task dependency tree starting from a root session. Builds a parent-child tree from DispatchTask parentSessionId/sessionId relations. Shows indented tree with status, agent, nesting depth, and optional result summaries. Rolebox-specific: opencode session_list only shows flat task lists.",
    args: {
      root_session: z
        .string()
        .min(1)
        .describe("Session ID to use as tree root — shows all tasks dispatched from this session"),
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
      include_result_summary: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include result preview (first 100 chars) for completed tasks (default true)"),
    },
    async execute(input) {
      const maxDepth = input.depth ?? 5;
      const showStatus = input.include_status !== false;
      const showResult = input.include_result_summary !== false;

      const allTasks = dispatchManager.getAllTasks();
      const rootTask = allTasks.find((t) => t.sessionId === input.root_session);

      const visited = new Set<string>();
      const children = buildChildren(dispatchManager, input.root_session, 1, maxDepth, visited);

      // No data at all
      if (children.length === 0 && !rootTask) {
        return `No tasks found for session \`${input.root_session}\`.`;
      }

      // Collect completed task IDs for parallel result fetching
      const completedIds: string[] = [];
      if (rootTask && rootTask.status === "completed") completedIds.push(rootTask.id);
      collectCompletedIds(children, completedIds);

      // Fetch result previews
      const previews = new Map<string, string>();
      if (showResult && completedIds.length > 0) {
        await fetchPreviews(dispatchManager, completedIds, previews);
      }

      // Render
      return renderTree(rootTask, children, previews, showStatus, input.root_session, maxDepth);
    },
  });
}

// ── Tree building (synchronous — uses dispatchManager.getTasksByParent) ──────

function buildChildren(
  dispatchManager: DispatchManager,
  parentSessionId: string,
  currentDepth: number,
  maxDepth: number,
  visited: Set<string>,
): TaskNode[] {
  // Cycle protection: skip if this session was already visited
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

// ── Result fetching ──────────────────────────────────────────────────────────

async function fetchPreviews(
  dispatchManager: DispatchManager,
  taskIds: string[],
  previews: Map<string, string>,
): Promise<void> {
  const results = await Promise.allSettled(
    taskIds.map((id) =>
      dispatchManager.getResult(id).then((r) => ({
        id,
        text:
          r.kind === "ok" && r.resultText
            ? r.resultText.length > 100
              ? r.resultText.slice(0, 100) + "..."
              : r.resultText
            : "",
      })),
    ),
  );

  for (const r of results) {
    if (r.status === "fulfilled" && r.value.text) {
      previews.set(r.value.id, r.value.text);
    }
  }
}

// ── Tree rendering (with box-drawing characters) ─────────────────────────────

function renderTree(
  rootTask: DispatchTask | undefined,
  children: TaskNode[],
  previews: Map<string, string>,
  showStatus: boolean,
  rootSession: string,
  maxDepth: number,
): string {
  const totalNodes = rootTask ? 1 + countNodes(children) : countNodes(children);
  const lines: string[] = [];

  lines.push(`## Task Tree: \`${rootSession}\``);
  lines.push(`**Total tasks:** ${totalNodes}  |  **Depth limit:** ${maxDepth}`);
  lines.push("");

  // Root task line (if found)
  if (rootTask) {
    lines.push(formatLabel(rootTask, 0, showStatus, previews.get(rootTask.id)));
  }

  // Render children with proper tree prefixes
  for (let i = 0; i < children.length; i++) {
    const isLast = i === children.length - 1;
    renderBranch(children[i], rootTask ? "" : "", isLast, showStatus, previews, lines);
  }

  return lines.join("\n");
}

function renderBranch(
  node: TaskNode,
  prefix: string,
  isLast: boolean,
  showStatus: boolean,
  previews: Map<string, string>,
  lines: string[],
): void {
  const connector = isLast ? "└── " : "├── ";
  lines.push(prefix + connector + formatLabel(node.task, node.depth, showStatus, previews.get(node.task.id)));

  const childPrefix = prefix + (isLast ? "    " : "│   ");
  for (let i = 0; i < node.children.length; i++) {
    renderBranch(node.children[i], childPrefix, i === node.children.length - 1, showStatus, previews, lines);
  }
}

function formatLabel(
  task: DispatchTask,
  depth: number,
  showStatus: boolean,
  resultPreview: string | undefined,
): string {
  let label = `\`${task.id}\``;

  if (showStatus) {
    label += ` (${task.status}, depth=${depth}`;
    if (task.agent) label += `, agent=${task.agent}`;
    label += `)`;
  } else {
    label += ` [depth=${depth}]`;
  }

  // Continuation annotation
  if (task.continuationOf) {
    label += ` → continues \`${task.continuationOf}\``;
  }

  // Error detail
  if (task.status === "error" && task.error) {
    const short = task.error.length > 60 ? task.error.slice(0, 60) + "..." : task.error;
    label += ` [${sanitizeError(short)}]`;
  }

  // Result preview
  if (resultPreview) {
    label += `: ${resultPreview}`;
  }

  return label;
}

/**
 * Strip JSON wrapping from common dispatch error shapes so the preview
 * is readable in the tree view.
 */
function sanitizeError(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const err = (parsed as Record<string, unknown>).error;
      return typeof err === "string" ? err : text;
    }
  } catch {
    // Not JSON — use as-is
  }
  return text;
}

function countNodes(children: TaskNode[]): number {
  let count = 0;
  for (const child of children) {
    count += 1 + countNodes(child.children);
  }
  return count;
}
