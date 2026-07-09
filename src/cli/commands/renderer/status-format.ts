import { bold, dim, red, green, cyan, yellow, gray, soft, border, sub, bright, bar } from "../../format.ts";
import type { MonitorSnapshot, GraphSessionSnapshot } from "../monitor-reader.ts";
import { formatDuration, truncate, shortSessionId, contentWidth, isNarrow, parseMetricKey, histogramPercentile } from "../monitor-helpers.ts";
import { panel, computeHealthState } from "./table-helpers.ts";

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

export function renderOrchestration(snapshot: MonitorSnapshot): void {
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

// ── Render: Active Functions ───────────────────────────────────────

export function renderActiveFunctions(snapshot: MonitorSnapshot): void {
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
