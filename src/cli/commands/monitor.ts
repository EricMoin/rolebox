import { defineCommand } from "citty";
import { bold, dim, red, soft } from "../format.ts";
import { readMonitorSnapshot, resolveProjectRoot } from "./monitor-reader.ts";
import { sleep } from "./monitor-helpers.ts";
import { DiffRenderer, renderHuman, renderJson, renderPrometheus, renderTaskDetail } from "./monitor-renderer.ts";

// ── Monitor options interface ──────────────────────────────────────

export interface MonitorOptions {
  noMetrics?: boolean;
  noStatus?: boolean;
  agent?: string;
  status?: string;
  sort?: string;
  taskId?: string;
  offset?: number;
  limit?: number;
  fullRedraw?: boolean;
  showNotifications?: boolean;
  export?: string;
  output?: string;
}

// ── Main ─────────────────────────────────────────────────────────

export async function monitor(
  watch: boolean,
  json: boolean,
  all: boolean,
  interval: number,
  tailChars = 0,
  options?: MonitorOptions,
): Promise<void> {
  const opts = options ?? {};
  const projectDir = resolveProjectRoot(process.cwd());

  // ── Task detail mode (one-shot, not watch compatible) ──
  if (opts.taskId) {
    renderTaskDetail(projectDir, opts.taskId, opts.offset ?? 0, opts.limit);
    return;
  }

  // ── Export mode ──
  const exportFormat = opts.export;
  if (exportFormat && exportFormat !== "summary") {
    const snapshot = readMonitorSnapshot(projectDir, tailChars);
    let output: string;

    switch (exportFormat) {
      case "json":
        output = JSON.stringify(snapshot, null, 2) + "\n";
        break;
      case "prometheus":
        output = renderPrometheus(snapshot);
        break;
      default:
        console.error(`Error: Unknown export format "${exportFormat}". Use "json", "prometheus", or "summary".`);
        process.exit(1);
    }

    if (opts.output) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(opts.output, output, "utf-8");
      console.log(`Exported to ${opts.output}`);
    } else {
      process.stdout.write(output);
    }
    return;
  }

  // ── One-shot mode ──
  if (!watch) {
    const snapshot = readMonitorSnapshot(projectDir, tailChars);
    if (json || opts.export === "json") {
      renderJson(snapshot, false);
    } else {
      renderHuman(snapshot, all, tailChars, opts);
    }
    return;
  }

  // ── Watch mode ──
  const diffRenderer = new DiffRenderer();
  let exiting = false;

  // Enter alternate screen buffer to preserve user's terminal history
  process.stdout.write("\x1b[?1049h");

  process.on("SIGINT", () => {
    if (exiting) process.exit(0);
    exiting = true;
    // Exit alternate screen buffer — restores original terminal content
    process.stdout.write("\x1b[?1049l");
    diffRenderer.dispose();
    console.log(dim("Monitor stopped."));
    process.exit(0);
  });

  const refreshLabel = interval >= 1000 ? `${interval / 1000}s` : `${interval}ms`;

  while (true) {
    const snapshot = readMonitorSnapshot(projectDir, tailChars);

    if (json || opts.export === "json") {
      process.stdout.write("\x1b[2J\x1b[H");
      renderJson(snapshot, true);
    } else {
      diffRenderer.beginFrame();
      renderHuman(snapshot, all, tailChars, opts);
      diffRenderer.endFrame(snapshot.tasks, false);
    }

    console.log(soft(`refreshing every ${refreshLabel} \u00b7 Ctrl+C to exit`));

    await sleep(interval);
  }
}

// ── citty command ────────────────────────────────────────────────

export default defineCommand({
  meta: {
    name: "monitor",
    description:
      "Show runtime dispatch activity and activated roles for the current project",
  },
  args: {
    watch: {
      type: "boolean",
      alias: ["w"],
      description: "Live-refresh dashboard (2s interval)",
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
    },
    all: {
      type: "boolean",
      alias: ["a"],
      description: "Include completed/cancelled tasks (default: only active)",
    },
    interval: {
      type: "string",
      alias: ["i"],
      description: "Refresh interval in ms (default: 1000)",
    },
    tail: {
      type: "string",
      alias: ["t"],
      description: "Show last N characters of each task's output (default: 0, disabled)",
    },
    "no-metrics": {
      type: "boolean",
      description: "Suppress the metrics section from output",
    },
    "no-status": {
      type: "boolean",
      description: "Hide the status overview panel",
    },
    agent: {
      type: "string",
      description: "Filter tasks by agent name (substring match, case-insensitive)",
    },
    status: {
      type: "string",
      description: "Comma-separated list of statuses to include (e.g., running,error)",
    },
    sort: {
      type: "string",
      description: "Sort tasks by: status, agent, duration, started (default: insertion order)",
    },
    "task-id": {
      type: "string",
      description: "Show full detail for a specific task ID (one-shot, disables watch)",
    },
    offset: {
      type: "string",
      description: "Character offset for task detail result text (default: 0)",
    },
    limit: {
      type: "string",
      description: "Character limit for task detail result text (default: full text)",
    },
    "full-redraw": {
      type: "boolean",
      description: "Force full screen clear on each refresh cycle (default: incremental)",
    },
    "show-notifications": {
      type: "boolean",
      description: "Show notification state section",
    },
    export: {
      type: "string",
      description: "Export format: json, prometheus, summary (overrides --json)",
    },
    output: {
      type: "string",
      description: "Write export output to file instead of stdout",
    },
  },
  async run({ args }) {
    const interval = args.interval ? parseInt(args.interval, 10) : 1000;
    if (isNaN(interval) || interval < 500) {
      console.error("Error: --interval must be a number >= 500");
      process.exit(1);
    }
    const tailChars = args.tail ? parseInt(args.tail, 10) : 0;
    if (isNaN(tailChars) || tailChars < 0) {
      console.error("Error: --tail must be a non-negative number");
      process.exit(1);
    }
    const offset = args.offset ? parseInt(args.offset, 10) : 0;
    if (isNaN(offset) || offset < 0) {
      console.error("Error: --offset must be a non-negative number");
      process.exit(1);
    }
    const limit = args.limit ? parseInt(args.limit, 10) : undefined;
    if (limit !== undefined && (isNaN(limit) || limit < 0)) {
      console.error("Error: --limit must be a non-negative number");
      process.exit(1);
    }

    const options: MonitorOptions = {
      noMetrics: args["no-metrics"] ?? false,
      noStatus: args["no-status"] ?? false,
      agent: args.agent,
      status: args.status,
      sort: args.sort,
      taskId: args["task-id"],
      offset,
      limit,
      fullRedraw: args["full-redraw"] ?? false,
      showNotifications: args["show-notifications"] ?? false,
      export: args.export,
      output: args.output,
    };

    await monitor(
      args.watch ?? false,
      args.json ?? false,
      args.all ?? false,
      interval,
      tailChars,
      options,
    );
  },
});
