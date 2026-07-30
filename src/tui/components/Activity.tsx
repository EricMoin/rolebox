/**
 * TUI activity components — the core agent-centric live view.
 *
 * @module
 */

/** @jsxImportSource @opentui/solid */
import { Show, For } from "solid-js";
import type { RGBA } from "@opentui/core";
import type { ThemeColors } from "../helpers.ts";
import {
  rgbaToCSS, BOLD, DIM, DIM_ITALIC,
  truncate,
  G_SUB, G_RUNNING, G_PENDING, G_DONE,
  G_ERROR, G_BAR_ON, G_BAR_OFF, G_STALLED,
  G_RUNNING_COMPACT, G_DONE_COMPACT,
  MAX_DISPATCH_ROWS, MAX_FN_ROWS, MAX_GRAPH_ROWS, MAX_LOOP_ROWS,
  MAX_ENGINE_GRAPH_ROWS,
  agentLeaf, shortSessionId, formatDuration, formatTimeAgo, barSegments, statusVisual,
  engineNodeGlyph,
} from "../helpers.ts";
import { SIDEBAR_WIDTH, INDENT, VALUE_BUDGET, labelValue } from "../layout.ts";
import type {
  MonitorSnapshot,
  TaskSnapshot,
  ActiveFunction,
  LoopSnapshot,
  GraphSessionSnapshot,
  EngineGraphSnapshot,
} from "../../cli/commands/monitor/monitor-reader.ts";
import { deriveEnginePhase } from "../logic.ts";
import { renderProgressIndicator } from "./ProgressIndicator.tsx";

// ── Function line component ──────────────────────────────────────────────

export function renderFunctionLine(props: { c: ThemeColors; fn: ActiveFunction }) {
  const c = props.c;
  const fn = props.fn;
  const name = fn.name ?? "";
  const agent = fn.agentId ? agentLeaf(fn.agentId) : null;
  const isGated = fn.phase !== "active" && fn.phase !== "complete";

  return (
    <>
      <text>
        {agent !== null ? (
          <>
            <span fg={rgbaToCSS(c.primary)} attributes={BOLD}>{agent}</span>
            <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{" "}</span>
          </>
        ) : null}
        <span fg={rgbaToCSS(isGated ? c.warning : c.info)}>{name}</span>
      </text>
      {fn.continuationCount > 0 && (
        <text>
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>
            {INDENT + labelValue("cont", String(fn.continuationCount), VALUE_BUDGET)}
          </span>
        </text>
      )}
    </>
  );
}

// ── Dispatch row component ───────────────────────────────────────────────

/** Render a dimmed, indented secondary row for a dispatch / fn line. */
function dimRow(c: ThemeColors, opts: {
  label?: string | null;
  value: string;
  budget?: number;
  attr?: number;
  fg?: RGBA;
}) {
  const { label = null, value, budget = VALUE_BUDGET, attr = DIM, fg } = opts;
  const text = label !== null ? labelValue(label, value, budget) : truncate(value, budget);
  const color = fg ?? c.textMuted;
  return (
    <text>
      <span fg={rgbaToCSS(color)} attributes={attr}>{INDENT + text}</span>
    </text>
  );
}

export function renderDispatchRow(props: {
  c: ThemeColors;
  task: TaskSnapshot;
  snapTimestamp: string | undefined;
  selected?: boolean;
  /** Progress indicator data for this task (from snap.progress) */
  progress?: { latest_stage: string; percentage?: number; message: string; event_count: number };
  /** Whether this task has active checkpoint data */
  hasCheckpoints?: boolean;
}) {
  const c = props.c;
  const task = props.task;
  const sv = statusVisual(task.status, c);
  const agent = agentLeaf(task.agent ?? "");
  const sel = props.selected ?? false;
  const isRunning = task.status === "running";

  // Primary row: status glyph + agent name. Bold for running, normal otherwise;
  // selection is conveyed via the info color.
  const primaryAttr = isRunning ? BOLD : 0;
  const primaryRow = (
    <text>
      <span fg={rgbaToCSS(sel ? c.info : sv.color)} attributes={primaryAttr}>{sv.glyph}</span>
      <span fg={rgbaToCSS(sel ? c.info : c.text)} attributes={primaryAttr}>{" " + agent}</span>
    </text>
  );

  // Dimmed, indented secondary rows, in display order.
  const secondary: unknown[] = [];

  if (task.status === "running") {
    const snapTime = props.snapTimestamp ? new Date(props.snapTimestamp).getTime() : Date.now();
    const elapsed = snapTime - new Date(task.startedAt ?? 0).getTime();
    const dur = formatDuration(elapsed);
    const desc = task.description ?? null;
    const staleTimeout = task.staleTimeoutMs ?? 300_000;

    // Liveness indicator
    let activitySuffix: string | null = null;
    let isStalled = false;
    if (task.lastActivityAgoMs !== undefined && task.lastActivityAgoMs !== null) {
      if (task.lastActivityAgoMs > staleTimeout) {
        isStalled = true;
        activitySuffix = " " + G_STALLED + " stalled \u00b7 " + formatTimeAgo(task.lastActivityAgoMs) + " ago";
      } else {
        activitySuffix = " \u00b7 " + formatTimeAgo(task.lastActivityAgoMs) + " ago";
      }
    }

    const noOutputYet = task.hasProducedOutput === false && elapsed > 10_000;

    // duration + liveness
    secondary.push(dimRow(c, {
      label: "dur",
      value: dur + (activitySuffix ?? ""),
      fg: isStalled ? c.warning : undefined,
    }));
    // description (truncated to the sidebar value budget)
    if (desc) {
      secondary.push(dimRow(c, { label: "desc", value: desc }));
    }
    // progress stage
    if (props.progress) {
      const stageVal = props.progress.latest_stage + (props.progress.message ? ": " + props.progress.message : "");
      secondary.push(dimRow(c, { label: "stage", value: stageVal }));
    }
    // no-output-yet note
    if (noOutputYet) {
      secondary.push(dimRow(c, { value: "(no output yet)", attr: DIM_ITALIC }));
    }
  } else if (task.status === "pending") {
    secondary.push(dimRow(c, { label: "status", value: "queued" }));
  } else if (task.status === "error") {
    const reason = (task.description ?? task.error ?? "").trim();
    if (reason) {
      secondary.push(dimRow(c, {
        label: "error",
        value: reason,
        budget: SIDEBAR_WIDTH - INDENT.length,
      }));
    }
  } else {
    // timeout
    secondary.push(dimRow(c, { label: "dur", value: formatDuration(task.durationMs) }));
  }

  // Shared secondary rows: [CP] checkpoint marker, then session id.
  if (props.hasCheckpoints) {
    secondary.push(dimRow(c, { value: "[CP]", fg: c.secondary }));
  }
  if (task.sessionId) {
    secondary.push(dimRow(c, { label: "session", value: shortSessionId(task.sessionId) }));
  }

  return (
    <>
      {primaryRow}
      {secondary}
    </>
  );
}

// ── Graph activity component ─────────────────────────────────────────────

export function renderGraphActivity(props: {
  c: ThemeColors;
  graph: GraphSessionSnapshot;
  snap: MonitorSnapshot;
  sessionScope: Set<string>;
  currentSessionId: string;
}) {
  const { c, graph, snap, sessionScope, currentSessionId } = props;
  // agentId might be a session ID; if so, shorten it
  const rawAgent = graph.agentId ?? "(unknown)";
  const orch = rawAgent.startsWith("ses_") ? shortSessionId(rawAgent) : rawAgent;

  // Build node status: completed → ✓, frontier → · (or • if matching a running task)
  const allNodes = [...graph.completed, ...graph.frontier];
  const runningAgents = new Set(
    snap.tasks
      .filter((t) => t.status === "running" && t.sessionId && (sessionScope.has(t.sessionId) || t.sessionId === currentSessionId))
      .map((t) => agentLeaf(t.agent ?? ""))
  );

  return (
    <>
      <text>
        <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"graph · "}</span>
        <span fg={rgbaToCSS(c.text)}>{orch}</span>
      </text>
      {graph.iterationCount > 0 && dimRow(c, { label: "iter", value: String(graph.iterationCount) })}
      {graph.terminationReason && graph.status !== "active" && dimRow(c, { label: "term", value: graph.terminationReason })}
      {allNodes.length > 0 && (
        <For each={allNodes}>{(node) => {
          const nodeLeaf = agentLeaf(node);
          const isDone = graph.completed.includes(node);
          const isRunning = !isDone && runningAgents.has(nodeLeaf);
          const glyph = isDone ? G_DONE : isRunning ? G_RUNNING : G_PENDING;
          const color = isDone ? c.success : isRunning ? c.info : c.warning;
          return (
            <text>
              <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{INDENT}</span>
              <span fg={rgbaToCSS(color)}>{glyph + " "}</span>
              <span fg={rgbaToCSS(isDone ? c.textMuted : c.text)} attributes={isDone ? DIM : 0}>{truncate(nodeLeaf, VALUE_BUDGET)}</span>
            </text>
          );
        }}</For>
      )}
    </>
  );
}

// ── Engine graph (v2) activity component ─────────────────────────────────

/** Phase glyph + color for a graph-engine lifecycle phase. */
function enginePhaseVisual(phase: string, c: ThemeColors): { glyph: string; color: RGBA } {
  switch (phase) {
    case "executing": return { glyph: G_RUNNING, color: c.info };
    case "complete":  return { glyph: G_DONE,    color: c.success };
    case "idle":      return { glyph: G_PENDING, color: c.warning };
    default:          return { glyph: G_PENDING, color: c.warning };
  }
}

/** Color for a graph-engine node lifecycle status. */
function engineNodeColor(status: string, c: ThemeColors): RGBA {
  switch (status) {
    case "running":   return c.info;
    case "completed":
    case "done":      return c.success;
    case "blocked":
    case "pending":
    case "ready":     return c.warning;
    case "timeout":   return c.secondary;
    case "escalate":  return c.error;
    case "cancelled": return c.textMuted;
    default:          return c.warning;
  }
}

const MAX_ENGINE_NODES = 6;

/**
 * Render a rich graph-engine (v2) activity block: per-node status glyphs,
 * live signal (from graph events keyed by graphId), and cumulative budget.
 */
export function renderEngineGraphActivity(props: {
  c: ThemeColors;
  graph: EngineGraphSnapshot;
  /** graphId → most recent signal status, fed from live graph events. */
  graphSignals?: ReadonlyMap<string, string>;
}) {
  const { c, graph } = props;
  // A graph with any running node is never shown idle (a node may be executing
  // a shell command while the engine's persisted phase momentarily reads idle).
  const effectivePhase = deriveEnginePhase(graph);
  const phase = enginePhaseVisual(effectivePhase, c);
  const gid = shortSessionId(graph.graphId);

  // Recent live signal (graph_signal / node signal) if one fired for this graph.
  const liveSignal = props.graphSignals?.get(graph.graphId);

  const { sessionsSpawned, totalInputTokens, totalOutputTokens, totalCost } = graph.budget;
  const budgetLine =
    sessionsSpawned > 0 || totalInputTokens > 0 || totalCost > 0
      ? `${sessionsSpawned}s \u00b7 ` +
        `${Math.round(totalInputTokens / 1000)}k/\u00a0${Math.round(totalOutputTokens / 1000)}k tok \u00b7 ` +
        `$${totalCost.toFixed(2)}`
      : null;

  const nodes = graph.nodes ?? [];
  const shown = nodes.slice(0, MAX_ENGINE_NODES);
  const hidden = nodes.length - shown.length;

  return (
    <>
      <text>
        <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"engine · "}</span>
        <span fg={rgbaToCSS(phase.color)}>{phase.glyph + " "}</span>
        <span fg={rgbaToCSS(c.text)}>{gid + " "}</span>
        <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{effectivePhase}</span>
      </text>
      {liveSignal && liveSignal !== "" && dimRow(c, { label: "sig", value: liveSignal, fg: c.secondary })}
      {budgetLine !== null && dimRow(c, { label: "budget", value: budgetLine, budget: SIDEBAR_WIDTH - INDENT.length })}
      {shown.length > 0 && (
        <>
          <For each={shown}>{(node) => {
            const glyph = engineNodeGlyph(node.status);
            const color = engineNodeColor(node.status, c);
            const done = node.status === "completed" || node.status === "done";
            // Running nodes surface real runtime status (liveness since start)
            // rather than reading as a stale idle/placeholder.
            const liveness = node.status === "running" && node.startedAt
              ? " \u00b7 " + formatTimeAgo(Math.max(0, Date.now() - new Date(node.startedAt).getTime()))
              : "";
            return (
              <text>
                <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{INDENT}</span>
                <span fg={rgbaToCSS(color)}>{glyph + " "}</span>
                <span fg={rgbaToCSS(done ? c.textMuted : c.text)} attributes={done ? DIM : 0}>
                  {truncate(agentLeaf(node.agent), VALUE_BUDGET)}
                </span>
                {node.signalType && !done && (
                  <span fg={rgbaToCSS(c.secondary)}>{":" + node.signalType}</span>
                )}
                {liveness !== "" && (
                  <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{liveness}</span>
                )}
              </text>
            );
          }}</For>
          {hidden > 0 && dimRow(c, { value: "+" + hidden + " more" })}
        </>
      )}
    </>
  );
}

// ── Loop activity component ──────────────────────────────────────────────

export function renderLoopActivity(props: { c: ThemeColors; loop: LoopSnapshot }) {
  const { c, loop } = props;
  const agent = agentLeaf(loop.agent ?? "");

  if (loop.errorReason) {
    const reason = loop.errorReason;
    return (
      <>
        <text>
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"loop · "}</span>
          <span fg={rgbaToCSS(c.text)}>{agent}</span>
          <span fg={rgbaToCSS(c.error)}>{" " + G_ERROR}</span>
        </text>
        <text>
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{INDENT}{reason}</span>
        </text>
      </>
    );
  }

  const isActive = loop.activeWorkerSessionId !== undefined && loop.activeWorkerSessionId !== null;
  const glyph = isActive ? G_RUNNING : G_PENDING;
  const glyphColor = isActive ? c.info : c.warning;
  const { filled, empty } = barSegments(loop.current, loop.total);

  return (
    <>
      <text>
        <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"loop · "}</span>
        <span fg={rgbaToCSS(glyphColor)}>{glyph + " "}</span>
        <span fg={rgbaToCSS(c.text)}>{agent}</span>
      </text>
      <text>
        <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{INDENT}</span>
        <span fg={rgbaToCSS(c.text)}>{loop.current + "/" + loop.total + " "}</span>
        <span fg={rgbaToCSS(c.info)}>{G_BAR_ON.repeat(filled)}</span>
        <span fg={rgbaToCSS(c.borderSubtle)}>{G_BAR_OFF.repeat(empty)}</span>
      </text>
    </>
  );
}

// ── Aggregate activity component ─────────────────────────────────────────

export function renderActivity(props: {
  c: ThemeColors;
  fns: ActiveFunction[];
  tasks: TaskSnapshot[];
  graphs: GraphSessionSnapshot[];
  loops: LoopSnapshot[];
  engineGraphs?: EngineGraphSnapshot[];
  snap: MonitorSnapshot | null;
  sessionScope: Set<string>;
  currentSessionId: string;
  /** graphId → most recent signal status, from live graph events. */
  graphSignals?: ReadonlyMap<string, string>;
  selectedIndex?: number;
  /** Called when a task row is clicked — passes the row index. */
  onSelectTask?: (index: number) => void;
  /** Called when a task row is double-clicked or single-clicked on already-selected row. */
  onOpenDetail?: (index: number) => void;
}) {
  const { c, fns, tasks, graphs, loops, snap } = props;
  const engineGraphs = props.engineGraphs ?? [];

  // Nothing active → suppress entirely
  if (
    fns.length === 0 && tasks.length === 0 && graphs.length === 0 && loops.length === 0 &&
    engineGraphs.length === 0
  ) {
    return null;
  }

  return (
    <box marginBottom={1}>
      {/* Active functions */}
      {fns.length > 0 && (
        <For each={fns.slice(0, MAX_FN_ROWS)}>{(fn) => renderFunctionLine({ c, fn })}</For>
      )}

      {/* Active dispatches */}
      {tasks.length > 0 && (
        <>
          <For each={tasks.slice(0, MAX_DISPATCH_ROWS)}>{(task, i) => {
            const index = i();
            // Look up progress and checkpoint data for this task
            const taskProgress = snap?.progress?.[task.id];
            const taskCheckpoints = snap?.checkpoints?.[task.id];
            return (
              <box
                on:click={() => {
                  if (index === props.selectedIndex) {
                    props.onOpenDetail?.(index);
                  } else {
                    props.onSelectTask?.(index);
                  }
                }}
              >
                {renderDispatchRow({
                  c,
                  task,
                  snapTimestamp: snap?.timestamp,
                  selected: index === (props.selectedIndex ?? -1),
                  progress: taskProgress,
                  hasCheckpoints: taskCheckpoints !== undefined,
                })}
              </box>
            );
          }}</For>
          {tasks.length > MAX_DISPATCH_ROWS && (
            <text fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"  +" + (tasks.length - MAX_DISPATCH_ROWS) + " more"}</text>
          )}
        </>
      )}

      {/* Active graphs */}
      {graphs.length > 0 && (
        <>
          <For each={graphs.slice(0, MAX_GRAPH_ROWS)}>{(graph) => {
            if (!snap) return null;
            return renderGraphActivity({ c, graph, snap, sessionScope: props.sessionScope, currentSessionId: props.currentSessionId });
          }}</For>
        </>
      )}

      {/* Engine graphs (v2) — per-node status, live signals, budget */}
      {engineGraphs.length > 0 && (
        <>
          <For each={engineGraphs.slice(0, MAX_ENGINE_GRAPH_ROWS)}>{(graph) =>
            renderEngineGraphActivity({ c, graph, graphSignals: props.graphSignals })
          }</For>
          {engineGraphs.length > MAX_ENGINE_GRAPH_ROWS && (
            <text fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"  +" + (engineGraphs.length - MAX_ENGINE_GRAPH_ROWS) + " more engine graphs"}</text>
          )}
        </>
      )}

      {/* Active loops */}
      {loops.length > 0 && (
        <>
          <For each={loops.slice(0, MAX_LOOP_ROWS)}>{(loop) => renderLoopActivity({ c, loop })}</For>
        </>
      )}
    </box>
  );
}
