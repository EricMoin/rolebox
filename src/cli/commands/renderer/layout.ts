import { bold, dim, red, green, cyan, yellow, soft, border, stripAnsi, shortenPath } from "../../format.ts";
import { readTaskDetail } from "../monitor/monitor-reader.ts";
import type { MonitorSnapshot, TaskSnapshot, DispatchSummary } from "../monitor/monitor-reader.ts";
import { formatDuration, truncate, statusGlyph, statusColor, statusCell, shortSessionId, contentWidth, isNarrow, parseMetricKey, formatPromLabels, histogramPercentile } from "../monitor/monitor-helpers.ts";
import { renderTasks } from "./table-helpers.ts";
import { renderSystemPulse, renderOrchestration, renderActiveFunctions, renderRecovery, renderMetrics, renderNotifications } from "./status-format.ts";

// ── Local options type (avoids circular dep with monitor.ts) ───────

export interface HumanRenderOptions {
  noMetrics?: boolean;
  noStatus?: boolean;
  agent?: string;
  status?: string;
  sort?: string;
  showNotifications?: boolean;
}

// ── Render: Header ─────────────────────────────────────────────────

export function renderHeader(projectDir: string, refreshLabel?: string): void {
  const w = contentWidth();
  const shortPath = shortenPath(projectDir);
  const pathDisplay = shortPath.length > 40 ? "\u2026" + shortPath.slice(-38) : shortPath;

  // Line 1: title + path (left) + refresh info (right-aligned)
  const title = `  ${bold(cyan("rolebox monitor"))}  ${soft(pathDisplay)}`;
  let rightPart = "";
  if (refreshLabel) {
    rightPart = soft(`watch \u00b7 ${refreshLabel}`);
  }
  const titleWidth = stripAnsi(title).length;
  const rightWidth = stripAnsi(rightPart).length;
  const gap = Math.max(1, w - titleWidth - rightWidth);
  console.log(title + " ".repeat(gap) + rightPart);

  // Line 2: full-width rule
  console.log(`  ${border("\u2500".repeat(w))}`);
}

// ── Render: Human (composite) ─────────────────────────────────────

export function renderHuman(
  snapshot: MonitorSnapshot,
  all: boolean,
  tailChars: number,
  options?: HumanRenderOptions,
): void {
  const opts = options ?? {};

  // Section order: Title Bar → System Pulse → Orchestration → Tasks
  // → Functions → Recovery → Metrics → (Notifications optional)

  renderHeader(snapshot.projectDir);

  if (!opts.noStatus) {
    renderSystemPulse(snapshot);
  }

  renderOrchestration(snapshot);
  renderTasks(snapshot, all, tailChars, opts.agent, opts.status, opts.sort);
  renderActiveFunctions(snapshot);

  if (!opts.noMetrics) {
    renderRecovery(snapshot);
    renderMetrics(snapshot);
  }

  if (opts.showNotifications) {
    renderNotifications(snapshot);
  }
}

// ── Render: JSON ───────────────────────────────────────────────────

export function renderJson(snapshot: MonitorSnapshot, ndjson: boolean): void {
  if (ndjson) {
    console.log(JSON.stringify(snapshot));
  } else {
    console.log(JSON.stringify(snapshot, null, 2));
  }
}

// ── Render: Task Detail ────────────────────────────────────────────

export function renderTaskDetail(projectDir: string, taskId: string, offset: number, limit: number | undefined): void {
  const detail = readTaskDetail(projectDir, taskId, offset, limit);
  if (!detail) {
    console.error(`Error: Task "${taskId}" not found.`);
    process.exit(1);
  }

  const t = detail.task;
  console.log(bold(`Task Detail: ${t.id}`));
  console.log(dim("\u2500".repeat(50)));
  console.log(`  ${dim("Status:".padEnd(14))} ${statusGlyph(t.status)} ${t.status}`);
  console.log(`  ${dim("Agent:".padEnd(14))} ${t.agent}`);
  if (t.description) console.log(`  ${dim("Description:".padEnd(14))} ${t.description}`);
  console.log(`  ${dim("Started:".padEnd(14))} ${t.startedAt}`);
  if (t.completedAt) console.log(`  ${dim("Completed:".padEnd(14))} ${t.completedAt}`);
  console.log(`  ${dim("Duration:".padEnd(14))} ${formatDuration(t.durationMs)}`);
  console.log(`  ${dim("Depth:".padEnd(14))} ${t.depth}`);
  console.log(`  ${dim("Mode:".padEnd(14))} ${t.mode}`);
  if (t.error) console.log(`  ${dim("Error:".padEnd(14))} ${red(t.error)}`);

  if (detail.totalChars > 0) {
    console.log("");
    const rangeStr = detail.truncated
      ? `showing ${detail.offset}..${detail.offset + detail.fullText.length} of ${detail.totalChars} chars`
      : `showing 0..${detail.totalChars} of ${detail.totalChars} chars`;
    console.log(bold(`Result  ${dim(rangeStr)}`));
    console.log(dim("\u2500".repeat(50)));
    const lines = detail.fullText.split("\n");
    for (const line of lines) {
      console.log(line);
    }
    if (detail.truncated) {
      console.log(dim(`... ${detail.totalChars - detail.offset - detail.fullText.length} more chars (use --offset and --limit)`));
    }
  } else {
    console.log(`  ${dim("No result output.")}`);
  }
}

// ── Diff Renderer ──────────────────────────────────────────────────

export class DiffRenderer {
  private prevTaskIds = new Set<string>();
  private firstRender = true;

  beginFrame(): void {
    process.stdout.write("\x1b[2J\x1b[H");
  }

  dispose(): void {
    // No cleanup needed.
  }

  endFrame(currentTasks: TaskSnapshot[], fullRedrawForced: boolean): void {
    const currentIds = new Set(currentTasks.map((t) => t.id));

    if (!this.firstRender && !fullRedrawForced) {
      const added = currentTasks.filter((t) => !this.prevTaskIds.has(t.id));
      const removed = [...this.prevTaskIds].filter((id) => !currentIds.has(id));
      const changed = currentTasks.filter((t) => this.prevTaskIds.has(t.id));

      if (added.length > 0 || removed.length > 0 || changed.length > 0) {
        const parts: string[] = [];
        if (added.length > 0) parts.push(green(`+${added.length}`));
        if (removed.length > 0) parts.push(red(`-${removed.length}`));
        if (changed.length > 0) parts.push(yellow(`\u223c${changed.length}`));
        console.log(`  ${soft("diff:")} ${parts.join(" ")}`);
      }
    }

    this.prevTaskIds = currentIds;
    this.firstRender = false;
  }

  get isFirstRender(): boolean {
    return this.firstRender;
  }
}

// ── Export Formats ─────────────────────────────────────────────────

export function renderPrometheus(snapshot: MonitorSnapshot): string {
  const lines: string[] = [];

  const metrics = snapshot.metrics;
  if (!metrics) {
    return "# No metrics data available.\n";
  }

  const knownMetrics: Record<string, { help: string; type: string }> = {
    dispatch_total: { help: "Total tasks dispatched", type: "counter" },
    dispatch_completed_total: { help: "Total tasks completed", type: "counter" },
    dispatch_error_total: { help: "Total tasks errored", type: "counter" },
    dispatch_cancelled_total: { help: "Total tasks cancelled", type: "counter" },
    dispatch_timeout_total: { help: "Total tasks timed out", type: "counter" },
    dispatch_rejected_total: { help: "Total tasks rejected", type: "counter" },
    dispatch_backpressure_retry_total: { help: "Total backpressure retries", type: "counter" },
    inflight_tasks: { help: "Currently in-flight tasks", type: "gauge" },
    concurrency_queued: { help: "Tasks queued for concurrency slot", type: "gauge" },
    concurrency_active: { help: "Active concurrency slots", type: "gauge" },
    concurrency_limit: { help: "Concurrency limit per slot", type: "gauge" },
    task_duration_ms: { help: "Task duration in milliseconds", type: "histogram" },
    queue_wait_ms: { help: "Queue wait time in milliseconds", type: "histogram" },
  };

  for (const [key, cs] of Object.entries(metrics.counters)) {
    const { name, labels } = parseMetricKey(key);
    const info = knownMetrics[name];
    if (info) {
      lines.push(`# HELP ${name} ${info.help}`);
      lines.push(`# TYPE ${name} ${info.type}`);
    }
    const labelStr = formatPromLabels(labels);
    lines.push(`${name}${labelStr} ${cs.value}`);
  }

  for (const [key, gs] of Object.entries(metrics.gauges)) {
    const { name, labels } = parseMetricKey(key);
    const info = knownMetrics[name];
    if (info) {
      lines.push(`# HELP ${name} ${info.help}`);
      lines.push(`# TYPE ${name} ${info.type}`);
    }
    const labelStr = formatPromLabels(labels);
    lines.push(`${name}${labelStr} ${gs.value}`);
  }

  for (const [key, hs] of Object.entries(metrics.histograms)) {
    const { name, labels } = parseMetricKey(key);
    const info = knownMetrics[name];
    if (info) {
      lines.push(`# HELP ${name} ${info.help}`);
      lines.push(`# TYPE ${name} ${info.type}`);
    }
    const labelStr = formatPromLabels(labels);

    const sortedBuckets = Object.entries(hs.buckets)
      .map(([k, v]) => [Number(k), v] as const)
      .sort((a, b) => a[0] - b[0]);

    for (const [boundary, count] of sortedBuckets) {
      lines.push(`${name}_bucket${labelStr}{le="${boundary}"} ${count}`);
    }
    lines.push(`${name}_bucket${labelStr}{le="+Inf"} ${hs.count}`);
    lines.push(`${name}_sum${labelStr} ${hs.sum}`);
    lines.push(`${name}_count${labelStr} ${hs.count}`);
  }

  return lines.join("\n") + "\n";
}
