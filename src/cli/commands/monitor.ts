import { defineCommand } from "citty";
import { bold, dim, red, green, cyan, yellow } from "../format.ts";
import { readMonitorSnapshot, resolveProjectRoot } from "./monitor-reader.ts";
import type { MonitorSnapshot } from "./monitor-reader.ts";

// ── Helpers ──────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
}

function statusIcon(status: string): string {
  switch (status) {
    case "running":
      return cyan("●");
    case "completed":
      return green("✓");
    case "error":
      return red("✗");
    case "pending":
      return yellow("⚡");
    case "cancelled":
      return dim("⊘");
    case "timeout":
      return yellow("⌛");
    default:
      return "?";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Renderers ────────────────────────────────────────────────────

function renderHeader(projectDir: string): void {
  const headerContent = `  rolebox monitor · ${projectDir}`;
  const boxWidth = Math.max(headerContent.length + 4, 50);
  const dashes = "─".repeat(boxWidth - 2);
  console.log(`┌${dashes}┐`);
  console.log(headerContent);
  console.log(`└${dashes}┘`);
}

function renderTasks(snapshot: MonitorSnapshot, all: boolean, tailChars: number): void {
  const visible = all
    ? snapshot.tasks
    : snapshot.tasks.filter((t) =>
        ["running", "pending", "error"].includes(t.status),
      );

  console.log("");
  console.log(bold("Background Tasks"));
  console.log(dim("─".repeat(50)));

  if (visible.length === 0) {
    if (snapshot.tasks.length === 0) {
      console.log(`  ${dim("No dispatch activity recorded.")}`);
    } else {
      console.log(`  ${dim("No active tasks. Use --all to show completed tasks.")}`);
    }
    return;
  }

  for (const t of visible) {
    const icon = statusIcon(t.status);
    const statusPart = `${icon} ${t.status.padEnd(9)}`;
    const agentPart = truncate(t.agent, 24).padEnd(26);
    const descPart = (t.description || "").slice(0, 40);
    const durPart = formatDuration(t.durationMs);

    console.log(`  ${statusPart} ${agentPart} ${descPart.padEnd(30)} ${durPart}`);

    if (t.error) {
      const errLabel = t.error.startsWith("Error:")
        ? t.error
        : `Error: ${t.error}`;
      console.log(`              ${dim("└─")} ${red(errLabel)}`);
    }

    if (tailChars > 0 && t.resultPreview) {
      const charsLabel = t.resultTotalChars
        ? dim(` [${t.resultPreview.length}/${t.resultTotalChars} chars]`)
        : "";
      console.log(`              ${dim("╭─ output")}${charsLabel}`);
      const lines = t.resultPreview.split("\n");
      for (const line of lines) {
        console.log(`              ${dim("│")} ${line}`);
      }
      console.log(`              ${dim("╰─")}`);
    }
  }
}

function renderActiveFunctions(snapshot: MonitorSnapshot): void {
  console.log("");
  console.log(bold("Active Functions"));
  console.log(dim("─".repeat(50)));

  if (snapshot.activeFunctions.length === 0) {
    console.log(`  ${dim("No active functions.")}`);
    return;
  }

  const sessionMap = new Map<string, typeof snapshot.activeFunctions>();
  for (const af of snapshot.activeFunctions) {
    const group = sessionMap.get(af.sessionId) ?? [];
    group.push(af);
    sessionMap.set(af.sessionId, group);
  }

  for (const [sessionId, fns] of sessionMap) {
    const agentName = truncate(fns[0]?.agentId ?? "(primary)", 24);
    const shortId =
      sessionId.length > 3 ? sessionId.slice(0, 3) + "…" : sessionId;
    console.log(`  ${agentName} (session ${shortId})`);

    for (const fn of fns) {
      const arrow = dim("→");
      console.log(
        `    ${arrow} ${fn.name}  ${fn.phase}  continuations: ${fn.continuationCount}`,
      );
    }
  }
}

function renderHuman(snapshot: MonitorSnapshot, all: boolean, tailChars: number): void {
  renderHeader(snapshot.projectDir);
  renderTasks(snapshot, all, tailChars);
  renderActiveFunctions(snapshot);
  console.log("");
}

function renderJson(snapshot: MonitorSnapshot, ndjson: boolean): void {
  if (ndjson) {
    console.log(JSON.stringify(snapshot));
  } else {
    console.log(JSON.stringify(snapshot, null, 2));
  }
}

// ── Main ─────────────────────────────────────────────────────────

export async function monitor(
  watch: boolean,
  json: boolean,
  all: boolean,
  interval: number,
  tailChars = 0,
): Promise<void> {
  const projectDir = resolveProjectRoot(process.cwd());

  if (!watch) {
    const snapshot = readMonitorSnapshot(projectDir, tailChars);
    if (json) {
      renderJson(snapshot, false);
    } else {
      renderHuman(snapshot, all, tailChars);
    }
    return;
  }

  // Watch mode
  let exiting = false;
  process.on("SIGINT", () => {
    if (exiting) process.exit(0);
    exiting = true;
    process.stdout.write("\n");
    console.log(dim("\nMonitor stopped."));
    process.exit(0);
  });

  const refreshLabel = interval >= 1000 ? `${interval / 1000}s` : `${interval}ms`;

  while (true) {
    const snapshot = readMonitorSnapshot(projectDir, tailChars);

    process.stdout.write("\x1b[2J\x1b[H");

    if (json) {
      renderJson(snapshot, true);
    } else {
      renderHuman(snapshot, all, tailChars);
    }

    console.log(dim(`Refreshing every ${refreshLabel} · Ctrl+C to exit`));

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
      description: "Refresh interval in ms (default: 2000)",
    },
    tail: {
      type: "string",
      alias: ["t"],
      description: "Show last N characters of each task's output (default: 0, disabled)",
    },
  },
  async run({ args }) {
    const interval = args.interval ? parseInt(args.interval, 10) : 2000;
    if (isNaN(interval) || interval < 500) {
      console.error("Error: --interval must be a number >= 500");
      process.exit(1);
    }
    const tailChars = args.tail ? parseInt(args.tail, 10) : 0;
    if (isNaN(tailChars) || tailChars < 0) {
      console.error("Error: --tail must be a non-negative number");
      process.exit(1);
    }
    await monitor(args.watch ?? false, args.json ?? false, args.all ?? false, interval, tailChars);
  },
});
