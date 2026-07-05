import { defineCommand } from "citty";
import { bold, dim, red, green, cyan, yellow, magenta, gray, soft, border, sub, bright, white, padRight, stripAnsi, bar, shortenPath, SYM_DISPATCH, SYM_AWAIT, SYM_SUMMARIZE, SYM_COMPLETE, SYM_ERROR, SYM_CANCELLED, HLTH_OK, HLTH_DEGRADED, HLTH_ERROR } from "../format.ts";
import { readMonitorSnapshot, resolveProjectRoot, readTaskDetail } from "./monitor-reader.ts";
import type { MonitorSnapshot, TaskSnapshot, ActiveFunction, RecoveryMetrics, LoopSnapshot, GraphSessionSnapshot, DispatchSummary, ConcurrencyStatus } from "./monitor-reader.ts";

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

// ── Layout helpers ──────────────────────────────────────────────

/**
 * Compute a consistent content width based on terminal columns.
 * Clamped to [60, 96] for readability on wide terminals.
 */
function contentWidth(): number {
  const cols = process.stdout?.columns ?? 80;
  return Math.max(60, Math.min(cols - 2, 96));
}

/** Whether the terminal is in narrow mode (< 70 cols). */
function isNarrow(): boolean {
  return (process.stdout?.columns ?? 80) < 70;
}

// ── Helpers ──────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

export function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "\u2026" : s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Canonical glyph table for status display.
 * Returns just the glyph (caller adds color).
 */
function statusGlyph(status: string): string {
  switch (status) {
    case "running": return "\u25b8"; // ▸
    case "completed": return "\u2713"; // ✓
    case "error": return "\u2717"; // ✗
    case "pending": return "\u25cf"; // ●
    case "cancelled": return "\u2298"; // ⊘
    case "timeout": return "\u23f1"; // ⏱
    default: return "?";
  }
}

function statusColor(status: string): (s: string) => string {
  switch (status) {
    case "running": return cyan;
    case "completed": return green;
    case "error": return red;
    case "pending": return yellow;
    case "cancelled": return gray;
    case "timeout": return magenta;
    default: return dim;
  }
}

/**
 * Format a status line item: colored glyph + padded status word.
 * Total width: 11 chars.
 */
function statusCell(status: string): string {
  const color = statusColor(status);
  const glyph = statusGlyph(status);
  return color(`${glyph} ${status.padEnd(9)}`);
}

/**
 * Format a session ID for display, showing only the last 8 characters.
 */
function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 12) return sessionId;
  return "\u2026" + sessionId.slice(-8);
}

/**
 * Unified panel renderer — wraps content in a straight box-drawing
 * border with the title embedded in the top border.
 * In narrow mode, renders as a plain title + rule instead.
 */
function panel(title: string, lines: string[]): void {
  const w = contentWidth();
  const narrow = isNarrow();

  if (narrow) {
    console.log("");
    console.log(`  ${bold(cyan(title))}`);
    console.log(`  ${border("\u2500".repeat(Math.min(w, 50)))}`);
    for (const line of lines) {
      console.log(`  ${line}`);
    }
    return;
  }

  // ── Normal (wide) panel ──
  const titlePart = bold(cyan(title));
  const titleWidth = stripAnsi(titlePart).length;
  const fillLen = Math.max(1, w - 4 - titleWidth); // "┌ " + title + " ──... ┐"
  const borderTop = `  ${border("\u250c ")}${titlePart} ${border("\u2500".repeat(fillLen))}${border("\u2510")}`;
  console.log(borderTop);

  const innerWidth = w - 4; // 2 border chars each side
  for (const line of lines) {
    const trimmed = line.replace(/^  /, "");
    const content = stripAnsi(trimmed).length > innerWidth ? truncate(trimmed, innerWidth) : trimmed;
    const padLen = Math.max(0, innerWidth - stripAnsi(content).length);
    console.log(`  ${border("\u2502 ")}${content}${" ".repeat(padLen)}${border(" \u2502")}`);
  }

  const borderBottom = `  ${border("\u2514")}${border("\u2500".repeat(w - 2))}${border("\u2518")}`;
  console.log(borderBottom);
}

function computeHealthState(snapshot: MonitorSnapshot): { state: string; color: (s: string) => string } {
  const ds = snapshot.dispatchSummary;
  const hasError = ds.error > 0 || snapshot.loops.some((l) => l.phase === "error") || snapshot.tasks.some((t) => t.status === "error");
  if (hasError) return { state: "ERROR", color: red };

  const hasActive = ds.running > 0 || ds.pending > 0 || snapshot.loops.length > 0 || snapshot.activeFunctions.length > 0 || snapshot.graphSessions.some((g) => g.status === "active");
  if (hasActive) return { state: "ACTIVE", color: green };

  return { state: "IDLE", color: yellow };
}

// ── Metric name parser ─────────────────────────────────────────────

export function parseMetricKey(key: string): { name: string; labels: Record<string, string> } {
  const braceIdx = key.indexOf("{");
  if (braceIdx === -1) return { name: key, labels: {} };

  const name = key.slice(0, braceIdx);
  const labelsPart = key.slice(braceIdx + 1, key.length - 1);
  const labels: Record<string, string> = {};
  for (const part of labelsPart.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    labels[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
  }
  return { name, labels };
}

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

// ── Render: Header ─────────────────────────────────────────────────

function renderHeader(projectDir: string, refreshLabel?: string): void {
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

// ── Render: System Pulse ──────────────────────────────────────────

export function renderSystemPulse(snapshot: MonitorSnapshot): void {
  const hs = computeHealthState(snapshot);
  const ds = snapshot.dispatchSummary;

  const parts: string[] = [];
  parts.push(`${hs.color("\u25cf")} ${hs.color(hs.state)}`);

  if (ds.running > 0) parts.push(`${cyan("\u25b8")} ${cyan(String(ds.running))} ${dim("running")}`);
  if (ds.pending > 0) parts.push(`${yellow("\u25cf")} ${yellow(String(ds.pending))} ${dim("pending")}`);
  if (ds.completed > 0) parts.push(`${green("\u2713")} ${green(String(ds.completed))} ${dim("done")}`);
  if (ds.error > 0) parts.push(`${red("\u2717")} ${red(String(ds.error))} ${dim("error")}`);
  const elapsedTasks = snapshot.tasks.filter((t) => t.status === "running" || t.status === "completed" || t.status === "error");
  const elapsed = elapsedTasks.length > 0
    ? formatDuration(Math.max(...elapsedTasks.map((t) => t.durationMs)))
    : "";
  if (elapsed) parts.push(dim(elapsed));

  const pulseLine = parts.join("  ");
  panel("System Pulse", [pulseLine]);
}

// ── Render: Orchestration ─────────────────────────────────────────

function renderOrchestration(snapshot: MonitorSnapshot): void {
  const loops = snapshot.loops;
  const graphs = snapshot.graphSessions;

  if (loops.length === 0 && graphs.length === 0) return; // SUPPRESS

  const lines: string[] = [];

  // Loop rows
  for (const l of loops) {
    const phaseIcon = l.phase === "active"
      ? cyan("\u25b8")
      : l.phase === "error"
        ? red("\u2717")
        : yellow("\u25cf");
    const agentPart = bold(l.agent);
    const progressBar = l.total > 0 ? bar(l.current, l.total, 10) : "";
    const roundPart = l.total > 0 ? `${dim("round")} ${l.current}/${l.total}` : "";
    const elapsedPart = dim(formatDuration(l.elapsedMs));
    lines.push(`  ${phaseIcon} ${agentPart} ${roundPart} ${progressBar} ${elapsedPart}`.trim());
    if (l.errorReason) {
      // Strip "Error:" prefix if present
      const reason = l.errorReason.startsWith("Error:") ? l.errorReason.slice(6).trim() : l.errorReason;
      lines.push(`  ${" ".repeat(2)}${border("\u2514\u2500")} ${red(reason)}`);
    }
  }

  // Graph session rows — group by agentId for multi-session detection
  const graphByAgent = new Map<string, GraphSessionSnapshot[]>();
  for (const g of graphs) {
    const group = graphByAgent.get(g.agentId) ?? [];
    group.push(g);
    graphByAgent.set(g.agentId, group);
  }

  for (const [, sessions] of graphByAgent) {
    const showSessionIds = sessions.length > 1;
    for (const g of sessions) {
      const statusIcon = g.status === "active"
        ? cyan("\u25cf")
        : g.status === "complete"
          ? green("\u2713")
          : yellow("\u2298");
      let agentPart = bold(g.agentId);
      if (showSessionIds) {
        agentPart += ` ${soft("\u2026" + g.sessionId.slice(-8))}`;
      }
      const iterPart = `${dim("iter")} ${g.iterationCount}`;
      const frontierPreview = g.frontier
        .slice(0, 3)
        .map((n) => {
          const dotIdx = n.indexOf(".");
          return dotIdx > 0 ? n.slice(0, dotIdx) : n;
        });
      const frontStr = frontierPreview.length > 0
        ? ` [${frontierPreview.join(" ")}${g.frontier.length > 3 ? " \u2026" : ""}]`
        : "";
      lines.push(`  ${statusIcon} ${agentPart} ${iterPart}${frontStr}`);
      if (g.terminationReason && g.status !== "active") {
        lines.push(`  ${" ".repeat(2)}${border("\u2514\u2500")} ${dim(g.terminationReason)}`);
      }
    }
  }

  panel("Orchestration", lines);
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

  if (agentFilter && agentFilter.length > 0) {
    const pattern = agentFilter.toLowerCase();
    visible = visible.filter((t) => t.agent.toLowerCase().includes(pattern));
  }

  if (statusFilter && statusFilter.length > 0) {
    const statuses = statusFilter.split(",").map((s) => s.trim().toLowerCase());
    visible = visible.filter((t) => statuses.includes(t.status));
  }

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
        break;
    }
  }

  return visible;
}

// ── Render: Tasks + Concurrency ────────────────────────────────────

function renderTasks(
  snapshot: MonitorSnapshot,
  all: boolean,
  tailChars: number,
  agentFilter?: string,
  statusFilter?: string,
  sortField?: string,
): void {
  const visible = filterAndSortTasks(snapshot.tasks, all, agentFilter, statusFilter, sortField);
  const concur = snapshot.concurrency;
  const w = contentWidth();
  const narrow = isNarrow();
  const lines: string[] = [];

  const hasActiveFilters = (agentFilter && agentFilter.length > 0) || (statusFilter && statusFilter.length > 0);

  if (visible.length === 0) {
    let emptyMsg: string;
    if (hasActiveFilters) {
      emptyMsg = dim("\u25cb no tasks match filters");
    } else if (snapshot.tasks.length === 0) {
      emptyMsg = dim("\u25cb no dispatch activity");
    } else {
      emptyMsg = dim("\u25cb all tasks completed. use --all to show");
    }
    lines.push(`  ${emptyMsg}`);
    panel("Tasks", lines);
    return;
  }

  if (narrow) {
    // Narrow mode: simple list
    for (const t of visible) {
      const icon = statusGlyph(t.status);
      const color = statusColor(t.status);
      const statusPart = color(`${icon} ${t.status}`);
      const descPart = (t.description || "").slice(0, 40);
      lines.push(`  ${statusPart}  ${bold(truncate(t.agent, 20))}  ${descPart}`);
      if (t.error) {
        const errMsg = t.error.startsWith("Error:") ? t.error.slice(6).trim() : t.error;
        lines.push(`    ${border("\u2514\u2500")} ${red(errMsg)}`);
      }
      if (tailChars > 0 && t.resultPreview) {
        const previewLines = t.resultPreview.split("\n").slice(0, 3);
        for (const pl of previewLines) {
          lines.push(`    ${border("\u2502")} ${dim(pl)}`);
        }
      }
    }
  } else {
    // Default sort by urgency: running → pending → error → completed → cancelled → timeout
    const urgencyOrder: Record<string, number> = {
      running: 0,
      pending: 1,
      error: 2,
      completed: 3,
      cancelled: 4,
      timeout: 5,
    };
    const sorted = [...visible].sort(
      (a, b) => (urgencyOrder[a.status] ?? 99) - (urgencyOrder[b.status] ?? 99),
    );

    // Fixed-width columns
    const agentW = 20;
    // Description: flex, truncated to fit. Content width minus fixed columns.
    const statusW = 11; // glyph + space + status word, padded
    const durW = 8; // right-aligned
    const fixedW = statusW + 1 + agentW + 1 + durW + 1; // +1 for spacing
    const descW = Math.max(10, Math.min(50, w - 4 - fixedW)); // contentWidth - panel padding - fixed

    for (const t of sorted) {
      const sc = statusCell(t.status);
      const agentPart = bold(truncate(t.agent, agentW).padEnd(agentW));
      const descPart = truncate((t.description || ""), descW).padEnd(descW);
      const durPart = t.status === "pending" ? dim("\u2014".padStart(durW)) : dim(formatDuration(t.durationMs).padStart(durW));
      lines.push(`  ${sc} ${agentPart} ${descPart} ${durPart}`);

      if (t.error) {
        const errMsg = t.error.startsWith("Error:") ? t.error.slice(6).trim() : t.error;
        lines.push(`  ${" ".repeat(statusW + 1)}${border("\u2514\u2500")} ${red(errMsg)}`);
      }

      if (tailChars > 0 && t.resultPreview) {
        const totalChars = t.resultTotalChars ?? t.resultPreview.length;
        const charsLabel = dim(` [${t.resultPreview.length}/${totalChars} chars]`);
        lines.push(`  ${" ".repeat(statusW + 1)}${border("\u2564\u2500 output")}${charsLabel}`);
        const previewLines = t.resultPreview.split("\n");
        for (const pl of previewLines) {
          lines.push(`  ${" ".repeat(statusW + 1)}${border("\u2502")} ${pl}`);
        }
        lines.push(`  ${" ".repeat(statusW + 1)}${border("\u2570\u2500")}`);
      }
    }
  }

  // Concurrency inline (1 line under tasks)
  const shouldShowConcurrency = !(concur.limit === 0 && concur.active === 0 && concur.queued === 0);
  if (shouldShowConcurrency) {
    const activePart = `${cyan(String(concur.active))}${dim("/")}${white(String(concur.limit))}`;
    const queuedPart = concur.queued > 0 ? ` ${yellow("+" + String(concur.queued))} ${dim("queued")}` : "";
    lines.push(`  ${dim("slots")} ${activePart}${queuedPart}`);
  }

  panel("Tasks", lines);
}

// ── Render: Active Functions ───────────────────────────────────────

function renderActiveFunctions(snapshot: MonitorSnapshot): void {
  if (snapshot.activeFunctions.length === 0) return; // SUPPRESS

  const lines: string[] = [];
  const w = contentWidth();
  const narrow = isNarrow();

  // Group by agent, not session
  const agentMap = new Map<string, typeof snapshot.activeFunctions>();
  for (const af of snapshot.activeFunctions) {
    const agent = af.agentId ?? "(primary)";
    const group = agentMap.get(agent) ?? [];
    group.push(af);
    agentMap.set(agent, group);
  }

  // Track session IDs per agent for dedup
  const agentSessions = new Map<string, Set<string>>();
  for (const af of snapshot.activeFunctions) {
    const agent = af.agentId ?? "(primary)";
    const s = agentSessions.get(agent) ?? new Set();
    s.add(af.sessionId);
    agentSessions.set(agent, s);
  }

  for (const [agentName, fns] of agentMap) {
    const sessions = agentSessions.get(agentName)!;
    let header = `  ${bold(agentName)}`;
    if (sessions.size > 1) {
      // Show session IDs only when multiple sessions for same agent
      const sessionList = [...sessions].map((sid) => shortSessionId(sid)).join(", ");
      header += `  ${soft("[" + sessionList + "]")}`;
    }
    lines.push(header);

    for (const fn of fns) {
      const phaseGlyph = fn.phase === "active" ? cyan("\u2192") : yellow("\u23f8"); // → active, ⏸ gated
      const fnName = truncate(fn.name, narrow ? 24 : 30);
      const contPart = dim(`cont ${fn.continuationCount}`);
      const turnPart = fn.currentTurn !== undefined ? dim(`turn ${fn.currentTurn}`) : "";
      const gatePart = fn.phase === "gated"
        ? (fn.gateSatisfied ? dim("gate \u2713") : dim("gate \u2717"))
        : "";
      lines.push(`  ${" ".repeat(2)}${phaseGlyph} ${fnName}  ${contPart}${turnPart ? `  ${turnPart}` : ""}${gatePart ? `  ${gatePart}` : ""}`);
    }
  }

  panel("Functions", lines);
}

// ── Render: Recovery ────────────────────────────────────────────────

export function renderRecovery(snapshot: MonitorSnapshot): void {
  const recovery = snapshot.recovery;

  // SUPPRESS if no recovery data or totalAttempts === 0
  if (!recovery || recovery.totalAttempts === 0) return;

  const totalAttempts = recovery.totalAttempts;
  const successes = recovery.successfulRecoveries;
  const aborted = recovery.abortedChains;
  const exhausted = recovery.exhaustedChains;
  const successRate = totalAttempts > 0
    ? Math.round((successes / totalAttempts) * 100)
    : 0;

  const rateColor = successRate >= 80 ? green : successRate >= 50 ? yellow : red;

  const lines: string[] = [];

  // Summary line
  const summaryParts: string[] = [];
  summaryParts.push(`${bright(String(totalAttempts))} ${dim("attempts")}`);
  summaryParts.push(`${green(String(successes))} ${dim("recovered")}`);
  if (aborted > 0) summaryParts.push(`${yellow(String(aborted))} ${dim("aborted")}`);
  if (exhausted > 0) summaryParts.push(`${gray(String(exhausted))} ${dim("exhausted")}`);
  summaryParts.push(`${rateColor(`${successRate}%`)} ${dim("rate")}`);
  lines.push(`  ${summaryParts.join("  ")}`);

  // By category
  const catKeys = Object.keys(recovery.byCategory);
  if (catKeys.length > 0) {
    lines.push(`  ${sub("\u2500")} ${dim("by category")}`);
    for (const cat of catKeys) {
      const entry = recovery.byCategory[cat];
      const rate = entry.attempts > 0 ? Math.round((entry.successes / entry.attempts) * 100) : 0;
      lines.push(`    ${dim(cat.padEnd(20))} ${cyan(String(entry.attempts))}/${green(String(entry.successes))}  ${cyan(`${rate}%`)}`);
    }
  }

  // By strategy
  const stratKeys = Object.keys(recovery.byStrategy);
  if (stratKeys.length > 0) {
    lines.push(`  ${sub("\u2500")} ${dim("by strategy")}`);
    for (const strat of stratKeys) {
      const entry = recovery.byStrategy[strat];
      const rate = entry.attempts > 0 ? Math.round((entry.successes / entry.attempts) * 100) : 0;
      lines.push(`    ${dim(strat.padEnd(20))} ${cyan(String(entry.attempts))}/${green(String(entry.successes))}  ${cyan(`${rate}%`)}`);
    }
  }

  // Top errors (top 5)
  const errorKeys = Object.keys(recovery.errorTypeFrequency);
  if (errorKeys.length > 0) {
    lines.push(`  ${sub("\u2500")} ${dim("top errors")}`);
    const sorted = errorKeys
      .map((k) => ({ type: k, count: recovery.errorTypeFrequency[k] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    for (const err of sorted) {
      lines.push(`    ${dim(err.type.padEnd(30))} ${yellow(String(err.count))}`);
    }
  }

  panel("Recovery", lines);
}

// ── Render: Metrics ────────────────────────────────────────────────

export function renderMetrics(snapshot: MonitorSnapshot): void {
  const metrics = snapshot.metrics;

  // SUPPRESS if no metrics data
  if (!metrics) return;

  const lines: string[] = [];
  const w = contentWidth();
  const narrow = isNarrow();

  // ── Counters ──
  const counterKeys = Object.keys(metrics.counters);
  const counterGroups = new Map<string, Array<{ labels: Record<string, string>; value: number }>>();
  for (const key of counterKeys) {
    const { name, labels } = parseMetricKey(key);
    const entry = { labels, value: metrics.counters[key].value };
    const group = counterGroups.get(name) ?? [];
    group.push(entry);
    counterGroups.set(name, group);
  }

  for (const [name, entries] of counterGroups) {
    const unlabeled = entries.filter((e) => Object.keys(e.labels).length === 0);
    const labeled = entries.filter((e) => Object.keys(e.labels).length > 0);

    if (unlabeled.length > 0) {
      for (const e of unlabeled) {
        lines.push(`  ${dim(name)} ${bright(String(e.value))}`);
      }
    }
    if (labeled.length > 0) {
      for (const e of labeled) {
        const labelStr = Object.entries(e.labels)
          .map(([k, v]) => `${dim(k)}:${v}`)
          .join(" ");
        lines.push(`  ${dim(name)} ${labelStr} ${bright(String(e.value))}`);
      }
    }
  }

  // ── Gauges ──
  const gaugeKeys = Object.keys(metrics.gauges);
  if (gaugeKeys.length > 0) {
    lines.push(`  ${sub("\u2500")} ${dim("gauges")}`);
    for (const key of gaugeKeys) {
      const { name, labels } = parseMetricKey(key);
      const value = metrics.gauges[key].value;
      if (Object.keys(labels).length === 0) {
        lines.push(`  ${dim(name)} ${yellow(String(value))}`);
      } else {
        const labelStr = Object.entries(labels)
          .map(([k, v]) => `${dim(k)}:${v}`)
          .join(" ");
        lines.push(`  ${dim(name)} ${labelStr} ${yellow(String(value))}`);
      }
    }
  }

  // ── Histograms ──
  const histKeys = Object.keys(metrics.histograms);
  if (histKeys.length > 0) {
    lines.push(`  ${sub("\u2500")} ${dim("histograms")}`);
    for (const key of histKeys) {
      const { name, labels } = parseMetricKey(key);
      const h = metrics.histograms[key];
      const avg = h.count > 0 ? Math.round(h.sum / h.count) : 0;
      const p50 = histogramPercentile(h.buckets, h.count, 0.5);
      const p95 = histogramPercentile(h.buckets, h.count, 0.95);

      let labelStr = "";
      if (Object.keys(labels).length > 0) {
        labelStr = " " + Object.entries(labels)
          .map(([k, v]) => `${dim(k)}:${v}`)
          .join(" ");
      }
      lines.push(
        `  ${dim(name)}${labelStr} ${cyan(`avg=${avg}ms`)} ${cyan(`p50=${p50}ms`)} ${cyan(`p95=${p95}ms`)}  ${dim(`n=${h.count}`)}`,
      );
    }
  }

  panel("Metrics", lines);
}

// ── Render: Notifications ──────────────────────────────────────────

export function renderNotifications(snapshot: MonitorSnapshot): void {
  const notif = snapshot.notifications;
  const lines: string[] = [];

  if (!notif) {
    lines.push(`  ${dim("\u25cb No notification state available.")}`);
    panel("Notifications", lines);
    return;
  }

  const enabledSymbol = notif.enabled ? green("\u2713") : red("\u2717");
  lines.push(`  ${dim("Enabled")} ${enabledSymbol}`);

  if (notif.quietHoursActive) {
    lines.push(`  ${dim("Quiet hours")} ${yellow("active")}`);
  }

  if (notif.throttleStats) {
    lines.push(`  ${dim("Throttle")} ${notif.throttleStats.recentCount}/${notif.throttleStats.windowMs}ms`);
  }

  if (notif.recentEvents.length > 0) {
    const recent = notif.recentEvents.slice(-5);
    lines.push(`  ${dim("Recent events")}`);
    for (const evt of recent) {
      const ts = evt.ts.length > 19 ? evt.ts.slice(0, 19) : evt.ts;
      lines.push(`    ${dim(ts)} ${evt.type}`);
    }
  }

  panel("Notifications", lines);
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

// ── Render: Human (composite) ─────────────────────────────────────

function renderHuman(
  snapshot: MonitorSnapshot,
  all: boolean,
  tailChars: number,
  options?: MonitorOptions,
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

function renderJson(snapshot: MonitorSnapshot, ndjson: boolean): void {
  if (ndjson) {
    console.log(JSON.stringify(snapshot));
  } else {
    console.log(JSON.stringify(snapshot, null, 2));
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
