import { defineCommand } from "citty";
import { bold, dim, red, green, cyan, yellow } from "../format.ts";
import { readMonitorSnapshot, resolveProjectRoot, readTaskDetail } from "./monitor-reader.ts";
import type { MonitorSnapshot, TaskSnapshot, RecoveryMetrics } from "./monitor-reader.ts";

// ── Monitor options interface ──────────────────────────────────────

export interface MonitorOptions {
  noMetrics?: boolean;
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

// ── Helpers ──────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "\u2026" : s;
}

function statusIcon(status: string): string {
  switch (status) {
    case "running":
      return cyan("\u25cf");
    case "completed":
      return green("\u2713");
    case "error":
      return red("\u2717");
    case "pending":
      return yellow("\u26a1");
    case "cancelled":
      return dim("\u2298");
    case "timeout":
      return yellow("\u231b");
    default:
      return "?";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Metric name parser ─────────────────────────────────────────────

/**
 * Parse a metric key like `dispatch_total{agent=chancellor,mode=background}`
 * into its base name and label record.
 */
export function parseMetricKey(key: string): { name: string; labels: Record<string, string> } {
  const braceIdx = key.indexOf("{");
  if (braceIdx === -1) return { name: key, labels: {} };

  const name = key.slice(0, braceIdx);
  const labelsPart = key.slice(braceIdx + 1, key.length - 1); // drop trailing }
  const labels: Record<string, string> = {};
  for (const part of labelsPart.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    labels[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
  }
  return { name, labels };
}

/**
 * Format labels as Prometheus-style `{key="value"}` string.
 */
export function formatPromLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return "";
  const parts = keys.map((k) => `${k}="${labels[k]}"`);
  return `{${parts.join(",")}}`;
}

// ── Histogram percentile computation ───────────────────────────────

export function histogramPercentile(
  buckets: Record<string, number>,
  count: number,
  pct: number,
): number {
  const threshold = count * pct;
  const sorted = Object.entries(buckets)
    .map(([k, v]) => [Number(k), v] as const)
    .sort((a, b) => a[0] - b[0]);

  let cumulative = 0;
  for (const [boundary, bucketCount] of sorted) {
    cumulative += bucketCount;
    if (cumulative >= threshold) return boundary;
  }
  return sorted.length > 0 ? sorted[sorted.length - 1][0] : 0;
}

// ── Render: Metrics ────────────────────────────────────────────────

export function renderMetrics(snapshot: MonitorSnapshot): void {
  const metrics = snapshot.metrics;
  if (!metrics) {
    console.log("");
    console.log(bold("Metrics"));
    console.log(dim("\u2500".repeat(50)));
    console.log(`  ${dim("Metrics not enabled (set ROLEBOX_METRICS=1)")}`);
    return;
  }

  console.log("");
  console.log(bold("Metrics"));
  console.log(dim("\u2500".repeat(50)));

  // ── Counters ──
  const counterKeys = Object.keys(metrics.counters);
  // Group by base name
  const counterGroups = new Map<string, Array<{ labels: Record<string, string>; value: number }>>();
  for (const key of counterKeys) {
    const { name, labels } = parseMetricKey(key);
    const entry = { labels, value: metrics.counters[key].value };
    const group = counterGroups.get(name) ?? [];
    group.push(entry);
    counterGroups.set(name, group);
  }

  for (const [name, entries] of counterGroups) {
    // Separate unlabeled from labeled
    const unlabeled = entries.filter((e) => Object.keys(e.labels).length === 0);
    const labeled = entries.filter((e) => Object.keys(e.labels).length > 0);

    if (unlabeled.length > 0) {
      for (const e of unlabeled) {
        console.log(`  ${dim(name)} ${cyan(String(e.value))}`);
      }
    }
    if (labeled.length > 0) {
      // Group by label key
      for (const e of labeled) {
        const labelStr = Object.entries(e.labels)
          .map(([k, v]) => `${dim(k)}:${v}`)
          .join(" ");
        console.log(`  ${dim(name)} ${labelStr} ${cyan(String(e.value))}`);
      }
    }
  }

  // ── Gauges ──
  const gaugeKeys = Object.keys(metrics.gauges);
  if (gaugeKeys.length > 0) {
    console.log(`  ${dim("\u2500")}`);
    for (const key of gaugeKeys) {
      const { name, labels } = parseMetricKey(key);
      const value = metrics.gauges[key].value;
      if (Object.keys(labels).length === 0) {
        console.log(`  ${dim(name)} ${yellow(String(value))}`);
      } else {
        const labelStr = Object.entries(labels)
          .map(([k, v]) => `${dim(k)}:${v}`)
          .join(" ");
        console.log(`  ${dim(name)} ${labelStr} ${yellow(String(value))}`);
      }
    }
  }

  // ── Histograms ──
  const histKeys = Object.keys(metrics.histograms);
  if (histKeys.length > 0) {
    console.log(`  ${dim("\u2500")}`);
    for (const key of histKeys) {
      const { name, labels } = parseMetricKey(key);
      const h = metrics.histograms[key];
      const avg = h.count > 0 ? Math.round(h.sum / h.count) : 0;
      const p50 = histogramPercentile(h.buckets, h.count, 0.5);
      const p95 = histogramPercentile(h.buckets, h.count, 0.95);

      let labelStr = "";
      if (Object.keys(labels).length > 0) {
        labelStr =
          " " +
          Object.entries(labels)
            .map(([k, v]) => `${dim(k)}:${v}`)
            .join(" ");
      }
      console.log(
        `  ${dim(name)}${labelStr} ${cyan(`avg=${avg}ms`)} ${cyan(`p50=${p50}ms`)} ${cyan(`p95=${p95}ms`)}  ${dim(`n=${h.count}`)}`,
      );
    }
  }
}

// ── Render: Notifications ──────────────────────────────────────────

export function renderNotifications(snapshot: MonitorSnapshot): void {
  const notif = snapshot.notifications;
  console.log("");
  console.log(bold("Notifications"));
  console.log(dim("\u2500".repeat(50)));

  if (!notif) {
    console.log(`  ${dim("No notification state available.")}`);
    return;
  }

  const enabledSymbol = notif.enabled ? green("\u2713") : red("\u2717");
  console.log(`  ${dim("Enabled:")} ${enabledSymbol}`);

  if (notif.quietHoursActive) {
    console.log(`  ${dim("Quiet hours:")} ${yellow("active")}`);
  }

  if (notif.throttleStats) {
    console.log(
      `  ${dim("Throttle:")} ${notif.throttleStats.recentCount}/${notif.throttleStats.windowMs}ms`,
    );
  }

  if (notif.recentEvents.length > 0) {
    const recent = notif.recentEvents.slice(-5);
    console.log(`  ${dim("Recent events:")}`);
    for (const evt of recent) {
      const ts = evt.ts.length > 19 ? evt.ts.slice(0, 19) : evt.ts;
      console.log(`    ${dim(ts)} ${evt.type}`);
    }
  }
}

// ── Render: Recovery ────────────────────────────────────────────────

/**
 * Render recovery metrics section.
 * Shows total attempts, success rate, per-category/per-strategy breakdown,
 * and top error types. Suppressed when --no-metrics is set (same as Metrics).
 */
export function renderRecovery(snapshot: MonitorSnapshot): void {
  const recovery = snapshot.recovery;

  console.log("");
  console.log(bold("Recovery"));
  console.log(dim("\u2500".repeat(50)));

  if (!recovery) {
    console.log(`  ${dim("No recovery activity recorded.")}`);
    return;
  }

  // Overview line
  const totalAttempts = recovery.totalAttempts;
  const successes = recovery.successfulRecoveries;
  const aborted = recovery.abortedChains;
  const exhausted = recovery.exhaustedChains;
  const successRate = totalAttempts > 0
    ? Math.round((successes / totalAttempts) * 100)
    : 0;
  console.log(
    `  ${dim("attempts")} ${cyan(String(totalAttempts))}` +
    `  ${dim("recovered")} ${green(String(successes))}` +
    `  ${dim("aborted")} ${yellow(String(aborted))}` +
    `  ${dim("exhausted")} ${red(String(exhausted))}` +
    `  ${dim("rate")} ${successRate > 0 ? cyan(`${successRate}%`) : dim(`${successRate}%`)}`,
  );

  // By category
  const catKeys = Object.keys(recovery.byCategory);
  if (catKeys.length > 0) {
    console.log(`  ${dim("\u2500")}  ${dim("by category")}`);
    for (const cat of catKeys) {
      const entry = recovery.byCategory[cat];
      const rate = entry.attempts > 0
        ? Math.round((entry.successes / entry.attempts) * 100)
        : 0;
      console.log(
        `    ${dim(cat.padEnd(20))}` +
        ` ${cyan(String(entry.attempts))}/${green(String(entry.successes))}` +
        `  ${cyan(`${rate}%`)}`,
      );
    }
  }

  // By strategy
  const stratKeys = Object.keys(recovery.byStrategy);
  if (stratKeys.length > 0) {
    console.log(`  ${dim("\u2500")}  ${dim("by strategy")}`);
    for (const strat of stratKeys) {
      const entry = recovery.byStrategy[strat];
      const rate = entry.attempts > 0
        ? Math.round((entry.successes / entry.attempts) * 100)
        : 0;
      console.log(
        `    ${dim(strat.padEnd(20))}` +
        ` ${cyan(String(entry.attempts))}/${green(String(entry.successes))}` +
        `  ${cyan(`${rate}%`)}`,
      );
    }
  }

  // Top error types (top 5)
  const errorKeys = Object.keys(recovery.errorTypeFrequency);
  if (errorKeys.length > 0) {
    console.log(`  ${dim("\u2500")}  ${dim("top errors")}`);
    const sorted = errorKeys
      .map((k) => ({ type: k, count: recovery.errorTypeFrequency[k] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    for (const err of sorted) {
      console.log(`    ${dim(err.type.padEnd(30))} ${yellow(String(err.count))}`);
    }
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
  console.log(`  ${dim("Status:".padEnd(14))} ${statusIcon(t.status)} ${t.status}`);
  console.log(`  ${dim("Agent:".padEnd(14))} ${t.agent}`);
  if (t.description) console.log(`  ${dim("Description:".padEnd(14))} ${t.description}`);
  console.log(`  ${dim("Started:".padEnd(14))} ${t.startedAt}`);
  if (t.completedAt) console.log(`  ${dim("Completed:".padEnd(14))} ${t.completedAt}`);
  console.log(`  ${dim("Duration:".padEnd(14))} ${formatDuration(t.durationMs)}`);
  console.log(`  ${dim("Depth:".padEnd(14))} ${t.depth}`);
  console.log(`  ${dim("Mode:".padEnd(14))} ${t.mode}`);
  if (t.error) console.log(`  ${dim("Error:".padEnd(14))} ${red(t.error)}`);

  // Show result text
  if (detail.totalChars > 0) {
    console.log("");
    const rangeStr = detail.truncated
      ? `showing ${detail.offset}..${detail.offset + detail.fullText.length} of ${detail.totalChars} chars`
      : `showing 0..${detail.totalChars} of ${detail.totalChars} chars`;
    console.log(bold(`Result  ${dim(rangeStr)}`));
    console.log(dim("\u2500".repeat(50)));
    // Output the result text line by line
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

// ── Filtering & Sorting ────────────────────────────────────────────

export function filterAndSortTasks(
  tasks: TaskSnapshot[],
  all: boolean,
  agentFilter?: string,
  statusFilter?: string,
  sortField?: string,
): TaskSnapshot[] {
  let visible = all
    ? tasks
    : tasks.filter((t) => ["running", "pending", "error"].includes(t.status));

  // Apply --agent filter (substring match, case-insensitive)
  if (agentFilter && agentFilter.length > 0) {
    const pattern = agentFilter.toLowerCase();
    visible = visible.filter((t) => t.agent.toLowerCase().includes(pattern));
  }

  // Apply --status filter (comma-separated list)
  if (statusFilter && statusFilter.length > 0) {
    const statuses = statusFilter.split(",").map((s) => s.trim().toLowerCase());
    visible = visible.filter((t) => statuses.includes(t.status));
  }

  // Apply --sort
  if (sortField) {
    switch (sortField) {
      case "status": {
        const statusOrder: Record<string, number> = {
          running: 0,
          pending: 1,
          error: 2,
          completed: 3,
          timeout: 4,
          cancelled: 5,
        };
        visible = [...visible].sort(
          (a, b) => (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99),
        );
        break;
      }
      case "agent":
        visible = [...visible].sort((a, b) => a.agent.localeCompare(b.agent));
        break;
      case "duration":
        visible = [...visible].sort((a, b) => b.durationMs - a.durationMs);
        break;
      case "started":
        visible = [...visible].sort(
          (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
        );
        break;
      default:
        // unrecognized sort — keep insertion order
        break;
    }
  }

  return visible;
}

// ── Render: Tasks ──────────────────────────────────────────────────

function renderTasks(
  snapshot: MonitorSnapshot,
  all: boolean,
  tailChars: number,
  agentFilter?: string,
  statusFilter?: string,
  sortField?: string,
): void {
  const visible = filterAndSortTasks(snapshot.tasks, all, agentFilter, statusFilter, sortField);

  console.log("");
  console.log(bold("Background Tasks"));
  console.log(dim("\u2500".repeat(50)));

  // Check if user-specified filters produced empty results vs. natural empty
  const hasActiveFilters = (agentFilter && agentFilter.length > 0) || (statusFilter && statusFilter.length > 0);

  if (visible.length === 0) {
    if (hasActiveFilters) {
      console.log(`  ${dim("No tasks match filters.")}`);
    } else if (snapshot.tasks.length === 0) {
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
      console.log(`              ${dim("\u2514\u2500")} ${red(errLabel)}`);
    }

    if (tailChars > 0 && t.resultPreview) {
      const charsLabel = t.resultTotalChars
        ? dim(` [${t.resultPreview.length}/${t.resultTotalChars} chars]`)
        : "";
      console.log(`              ${dim("\u2564\u2500 output")}${charsLabel}`);
      const lines = t.resultPreview.split("\n");
      for (const line of lines) {
        console.log(`              ${dim("\u2502")} ${line}`);
      }
      console.log(`              ${dim("\u2570\u2500")}`);
    }
  }
}

// ── Render: Active Functions ───────────────────────────────────────

function renderActiveFunctions(snapshot: MonitorSnapshot): void {
  console.log("");
  console.log(bold("Active Functions"));
  console.log(dim("\u2500".repeat(50)));

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
      sessionId.length > 3 ? sessionId.slice(0, 3) + "\u2026" : sessionId;
    console.log(`  ${agentName} (session ${shortId})`);

    for (const fn of fns) {
      const arrow = dim("\u2192");
      console.log(
        `    ${arrow} ${fn.name}  ${fn.phase}  continuations: ${fn.continuationCount}`,
      );
    }
  }
}

// ── Diff Renderer ──────────────────────────────────────────────────

export class DiffRenderer {
  private prevTaskIds = new Set<string>();
  private prevLineCount = 0;
  private firstRender = true;
  private sigwinchHandler: (() => void) | null = null;
  private needsFullRedraw = false;

  constructor() {
    // Handle terminal resize — request full redraw on next cycle
    this.sigwinchHandler = () => {
      this.needsFullRedraw = true;
    };

    if (typeof process !== "undefined" && process.on) {
      process.on("SIGWINCH", this.sigwinchHandler);
    }
  }

  dispose(): void {
    if (this.sigwinchHandler && typeof process !== "undefined" && process.removeListener) {
      process.removeListener("SIGWINCH", this.sigwinchHandler);
    }
  }

  /**
   * Begin a new render frame.
   * On first render, no cursor adjustment. On subsequent renders, move cursor
   * up by previous line count and clear from cursor to end of screen.
   */
  beginFrame(): void {
    if (!this.firstRender && !this.needsFullRedraw) {
      if (this.prevLineCount > 0) {
        process.stdout.write(`\x1b[${this.prevLineCount}A`);
      }
      process.stdout.write(`\x1b[J`);
    }
  }

  /**
   * End a render frame. Computes diff stats and prints them.
   * Call this AFTER all render*() functions have been called.
   * @param lineCount — Total number of lines output in this frame
   * @param currentTasks — Current task list
   * @param fullRedrawForced — Whether a full redraw was forced this cycle
   */
  endFrame(lineCount: number, currentTasks: TaskSnapshot[], fullRedrawForced: boolean): void {
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
        console.log(`  ${dim("diff:")} ${parts.join(" ")}`);
        lineCount++;
      }
    }

    this.prevLineCount = lineCount;
    this.prevTaskIds = currentIds;
    this.firstRender = false;
    this.needsFullRedraw = false;
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

  // Known metric HELP/TYPE descriptions
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

  // Emit counters
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

  // Emit gauges
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

  // Emit histograms
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


function renderHuman(
  snapshot: MonitorSnapshot,
  all: boolean,
  tailChars: number,
  options?: MonitorOptions,
): void {
  const opts = options ?? {};
  renderHeader(snapshot.projectDir);
  renderTasks(snapshot, all, tailChars, opts.agent, opts.status, opts.sort);
  renderActiveFunctions(snapshot);

  if (!opts.noMetrics) {
    renderMetrics(snapshot);
    renderRecovery(snapshot);
  }

  if (opts.showNotifications) {
    renderNotifications(snapshot);
  }

  console.log("");
}
// ── Render: JSON ───────────────────────────────────────────────────

function renderJson(snapshot: MonitorSnapshot, ndjson: boolean): void {
  if (ndjson) {
    console.log(JSON.stringify(snapshot));
  } else {
    console.log(JSON.stringify(snapshot, null, 2));
  }
}

// ── Render: Header ─────────────────────────────────────────────────

function renderHeader(projectDir: string): void {
  const headerContent = `  rolebox monitor \u00b7 ${projectDir}`;
  const boxWidth = Math.max(headerContent.length + 4, 50);
  const dashes = "\u2500".repeat(boxWidth - 2);
  console.log(`\u250c${dashes}\u2510`);
  console.log(headerContent);
  console.log(`\u2514${dashes}\u2518`);
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

  process.on("SIGINT", () => {
    if (exiting) process.exit(0);
    exiting = true;
    diffRenderer.dispose();
    process.stdout.write("\n");
    console.log(dim("\nMonitor stopped."));
    process.exit(0);
  });

  const refreshLabel = interval >= 1000 ? `${interval / 1000}s` : `${interval}ms`;

  while (true) {
    const snapshot = readMonitorSnapshot(projectDir, tailChars);

    // In watch mode, use diff-based or full-redraw rendering
    if (json || opts.export === "json") {
      // JSON watch mode: still do full-clear for JSON (it's streaming)
      if (opts.fullRedraw || diffRenderer.isFirstRender) {
        process.stdout.write("\x1b[2J\x1b[H");
      }
      renderJson(snapshot, true);
    } else if (opts.fullRedraw) {
      process.stdout.write("\x1b[2J\x1b[H");
      renderHuman(snapshot, all, tailChars, opts);
    } else {
      // Diff-based incremental rendering
      diffRenderer.beginFrame();

      // Capture line count by wrapping console.log
      const lines: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        const line = args.join(" ");
        lines.push(line);
        origLog(...args);
      };

      renderHuman(snapshot, all, tailChars, opts);

      console.log = origLog;

      diffRenderer.endFrame(lines.length, snapshot.tasks, false);
    }

    console.log(dim(`Refreshing every ${refreshLabel} \u00b7 Ctrl+C to exit`));

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
    "no-metrics": {
      type: "boolean",
      description: "Suppress the metrics section from output",
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
