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
  INDENT, truncate,
  G_SUB, G_FN, G_GATED, G_RUNNING, G_PENDING, G_DONE,
  G_ERROR, G_BAR_ON, G_BAR_OFF, G_STALLED,
  G_RUNNING_COMPACT, G_DONE_COMPACT,
  MAX_DISPATCH_ROWS, MAX_FN_ROWS, MAX_GRAPH_ROWS, MAX_LOOP_ROWS,
  MAX_ENGINE_GRAPH_ROWS,
  agentLeaf, shortSessionId, formatDuration, formatTimeAgo, barSegments, statusVisual,
  engineNodeGlyph,
} from "../helpers.ts";
import type {
  MonitorSnapshot,
  TaskSnapshot,
  ActiveFunction,
  LoopSnapshot,
  GraphSessionSnapshot,
  EngineGraphSnapshot,
} from "../../cli/commands/monitor/monitor-reader.ts";
import { renderProgressIndicator } from "./ProgressIndicator.tsx";

// ── Function line component ──────────────────────────────────────────────

export function renderFunctionLine(props: { c: ThemeColors; fn: ActiveFunction }) {
  const c = props.c;
  const fn = props.fn;
  const name = fn.name ?? "";
  const agent = fn.agentId ? agentLeaf(fn.agentId) : null;
  const isGated = fn.phase !== "active" && fn.phase !== "complete";

  return (
    <text>
      {agent !== null ? (
        <>
          <span fg={rgbaToCSS(c.primary)} attributes={BOLD}>{agent}</span>
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{" "}</span>
        </>
      ) : null}
      <span fg={rgbaToCSS(isGated ? c.warning : c.info)}>{(isGated ? G_GATED : G_FN) + " " + name}</span>
      {fn.continuationCount > 0 && (
        <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{" cont " + fn.continuationCount}</span>
      )}
    </text>
  );
}

// ── Dispatch row component ───────────────────────────────────────────────

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

  // Checkpoint badge
  const cpBadge = props.hasCheckpoints ? (
    <span fg={rgbaToCSS(c.secondary)} attributes={BOLD}>{" [CP]"}</span>
  ) : null;

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

    return (
      <text>
        <span fg={rgbaToCSS(sel ? c.info : sv.color)} attributes={sel ? BOLD : 0}>{sv.glyph}</span>
        <span fg={rgbaToCSS(sel ? c.info : c.text)} attributes={sel ? BOLD : 0}>{" " + agent}</span>
        {task.sessionId && (
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{" " + shortSessionId(task.sessionId)}</span>
        )}
        <span>{" "}</span>
        {isStalled ? (
          <span fg={rgbaToCSS(sel ? c.info : c.warning)} attributes={BOLD}>{dur + activitySuffix}</span>
        ) : (
          <span fg={rgbaToCSS(sel ? c.info : c.textMuted)} attributes={(sel ? BOLD : DIM)}>{dur + (activitySuffix ?? "")}</span>
        )}
        {cpBadge}
        {desc && <span fg={rgbaToCSS(sel ? c.info : c.textMuted)} attributes={(sel ? BOLD : DIM)}>{"  " + desc}</span>}
        {noOutputYet && <span fg={rgbaToCSS(c.textMuted)} attributes={DIM_ITALIC}>{" (no output yet)"}</span>}
        {props.progress && (
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{" \u00b7 " + truncate(props.progress.latest_stage + (props.progress.message ? ": " + props.progress.message : ""), 50)}</span>
        )}
      </text>
    );
  }

  if (task.status === "pending") {
    return (
      <text>
        <span fg={rgbaToCSS(sel ? c.info : sv.color)} attributes={sel ? BOLD : 0}>{sv.glyph}</span>
        <span fg={rgbaToCSS(sel ? c.info : c.text)} attributes={sel ? BOLD : 0}>{" " + agent}</span>
        {task.sessionId && (
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{" " + shortSessionId(task.sessionId)}</span>
        )}
        <span>{" "}</span>
        {cpBadge}
        <span fg={rgbaToCSS(sel ? c.info : c.textMuted)} attributes={(sel ? BOLD : DIM)}>{"queued"}</span>
      </text>
    );
  }

  if (task.status === "error") {
    const reason = (task.description ?? task.error ?? "").trim();
    return (
      <>
        <text>
          <span fg={rgbaToCSS(sel ? c.info : sv.color)} attributes={sel ? BOLD : 0}>{sv.glyph}</span>
          <span fg={rgbaToCSS(sel ? c.info : c.text)} attributes={sel ? BOLD : 0}>{" " + agent}</span>
          {task.sessionId && (
            <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{" " + shortSessionId(task.sessionId)}</span>
          )}
          <span>{" "}</span>
          {cpBadge}
        </text>
        {reason && (
          <text>
            <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{INDENT}{reason}</span>
          </text>
        )}
      </>
    );
  }

  // timeout
  const dur = formatDuration(task.durationMs);
  return (
    <text>
      <span fg={rgbaToCSS(sel ? c.info : sv.color)} attributes={sel ? BOLD : 0}>{sv.glyph}</span>
      <span fg={rgbaToCSS(sel ? c.info : c.text)} attributes={sel ? BOLD : 0}>{" " + agent}</span>
      {task.sessionId && (
        <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{" " + shortSessionId(task.sessionId)}</span>
      )}
      <span>{" "}</span>
      {cpBadge}
      <span fg={rgbaToCSS(sel ? c.info : c.textMuted)} attributes={(sel ? BOLD : DIM)}>{dur}</span>
    </text>
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
  const iter = graph.iterationCount > 0 ? " iter " + graph.iterationCount : "";

  // Build node status: completed → ✓, frontier → ● (or ▸ if matching a running task)
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
        {iter && <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{iter}</span>}
        {graph.terminationReason && graph.status !== "active" && (
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"  " + graph.terminationReason}</span>
        )}
      </text>
      {allNodes.length > 0 && (
        <text>
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"  "}</span>
          <For each={allNodes}>{(node, i) => {
            const nodeLeaf = agentLeaf(node);
            const isDone = graph.completed.includes(node);
            const isRunning = !isDone && runningAgents.has(nodeLeaf);
            const glyph = isDone ? G_DONE : isRunning ? G_RUNNING : G_PENDING;
            const color = isDone ? c.success : isRunning ? c.info : c.warning;
            return (
              <>
                {i() > 0 && <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"  "}</span>}
                <span fg={rgbaToCSS(color)}>{glyph + " "}</span>
                <span fg={rgbaToCSS(isDone ? c.textMuted : c.text)} attributes={isDone ? DIM : 0}>{nodeLeaf}</span>
              </>
            );
          }}</For>
        </text>
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
  const phase = enginePhaseVisual(graph.phase, c);
  const gid = shortSessionId(graph.graphId);

  // Recent live signal (graph_signal / node signal) if one fired for this graph.
  const liveSignal = props.graphSignals?.get(graph.graphId);

  const { sessionsSpawned, totalInputTokens, totalOutputTokens, totalCost } = graph.budget;
  const budgetLine =
    sessionsSpawned > 0 || totalInputTokens > 0 || totalCost > 0
      ? `  \u00b7 ` +
        `${sessionsSpawned}s \u00b7 ` +
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
        <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{graph.phase}</span>
        {liveSignal && liveSignal !== "" && (
          <span fg={rgbaToCSS(c.secondary)}>{"  sig " + liveSignal}</span>
        )}
        {budgetLine !== null && (
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{budgetLine}</span>
        )}
      </text>
      {shown.length > 0 && (
        <text>
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"  "}</span>
          <For each={shown}>{(node, i) => {
            const glyph = engineNodeGlyph(node.status);
            const color = engineNodeColor(node.status, c);
            const done = node.status === "completed" || node.status === "done";
            return (
              <>
                {i() > 0 && <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"  "}</span>}
                <span fg={rgbaToCSS(color)}>{glyph + " "}</span>
                <span fg={rgbaToCSS(done ? c.textMuted : c.text)} attributes={done ? DIM : 0}>
                  {agentLeaf(node.agent)}
                </span>
                {node.signalType && !done && (
                  <span fg={rgbaToCSS(c.secondary)}>{":" + node.signalType}</span>
                )}
              </>
            );
          }}</For>
          {hidden > 0 && (
            <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"  +" + hidden + " more"}</span>
          )}
        </text>
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
    <text>
      <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"loop · "}</span>
      <span fg={rgbaToCSS(glyphColor)}>{glyph + " "}</span>
      <span fg={rgbaToCSS(c.text)}>{agent + " "}</span>
      <span fg={rgbaToCSS(c.text)}>{loop.current + "/" + loop.total + " "}</span>
      <span fg={rgbaToCSS(c.info)}>{G_BAR_ON.repeat(filled)}</span>
      <span fg={rgbaToCSS(c.borderSubtle)}>{G_BAR_OFF.repeat(empty)}</span>
    </text>
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
