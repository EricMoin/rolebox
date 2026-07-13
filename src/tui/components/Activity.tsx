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
  G_SUB, G_FN, G_GATED, G_RUNNING, G_PENDING, G_DONE,
  G_ERROR, G_BAR_ON, G_BAR_OFF, G_STALLED,
  MAX_DISPATCH_ROWS, MAX_FN_ROWS, MAX_GRAPH_ROWS, MAX_LOOP_ROWS,
  agentLeaf, shortSessionId, formatDuration, formatTimeAgo, barSegments, statusVisual,
} from "../helpers.ts";
import type {
  MonitorSnapshot,
  TaskSnapshot,
  ActiveFunction,
  LoopSnapshot,
  GraphSessionSnapshot,
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
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{" | "}</span>
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
  const selPrefix = sel ? "▶ " : "  ";

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
      <>
        <text>
          <span fg={rgbaToCSS(sel ? c.info : c.textMuted)} attributes={DIM}>{selPrefix}</span>
          <span fg={rgbaToCSS(sv.color)}>{sv.glyph}</span>
          <span fg={rgbaToCSS(c.text)}>{" " + agent + " "}</span>
          {isStalled ? (
            <span fg={rgbaToCSS(c.warning)} attributes={BOLD}>{dur + activitySuffix}</span>
          ) : (
            <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{dur + (activitySuffix ?? "")}</span>
          )}
          {cpBadge}
          {desc && <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"  " + desc}</span>}
          {noOutputYet && <span fg={rgbaToCSS(c.textMuted)} attributes={DIM_ITALIC}>{" (no output yet)"}</span>}
        </text>
        {/* Progress indicator sub-line */}
        {props.progress && (
          <text>
            <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"  "}</span>
            {renderProgressIndicator({
              c,
              stage: props.progress.latest_stage,
              percentage: props.progress.percentage,
              message: props.progress.message,
              eventCount: props.progress.event_count,
            })}
          </text>
        )}
      </>
    );
  }

  if (task.status === "pending") {
    return (
      <text>
        <span fg={rgbaToCSS(sel ? c.info : c.textMuted)} attributes={DIM}>{selPrefix}</span>
        <span fg={rgbaToCSS(sv.color)}>{sv.glyph}</span>
        <span fg={rgbaToCSS(c.text)}>{" " + agent + " "}</span>
        {cpBadge}
        <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"queued"}</span>
      </text>
    );
  }

  if (task.status === "error") {
    const reason = (task.description ?? task.error ?? "").trim();
    return (
      <>
        <text>
          <span fg={rgbaToCSS(sel ? c.info : c.textMuted)} attributes={DIM}>{selPrefix}</span>
          <span fg={rgbaToCSS(sv.color)}>{sv.glyph}</span>
          <span fg={rgbaToCSS(c.text)}>{" " + agent}</span>
          {cpBadge}
        </text>
        {reason && (
          <text>
            <span fg={rgbaToCSS(c.borderSubtle)}>{"  " + G_SUB + " "}</span>
            <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{reason}</span>
          </text>
        )}
      </>
    );
  }

  // timeout
  const dur = formatDuration(task.durationMs);
  return (
    <text>
      <span fg={rgbaToCSS(sel ? c.info : c.textMuted)} attributes={DIM}>{selPrefix}</span>
      <span fg={rgbaToCSS(sv.color)}>{sv.glyph}</span>
      <span fg={rgbaToCSS(c.text)}>{" " + agent + " "}</span>
      {cpBadge}
      <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{dur}</span>
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
          <span fg={rgbaToCSS(c.borderSubtle)}>{"  " + G_SUB + " "}</span>
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{reason}</span>
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
  snap: MonitorSnapshot | null;
  sessionScope: Set<string>;
  currentSessionId: string;
  selectedIndex?: number;
  /** Called when a task row is clicked — passes the row index. */
  onSelectTask?: (index: number) => void;
  /** Called when a task row is double-clicked or single-clicked on already-selected row. */
  onOpenDetail?: (index: number) => void;
}) {
  const { c, fns, tasks, graphs, loops, snap } = props;

  // Nothing active → suppress entirely
  if (fns.length === 0 && tasks.length === 0 && graphs.length === 0 && loops.length === 0) {
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
          {fns.length > 0 && <text>{" "}</text>}
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
          {(fns.length > 0 || tasks.length > 0) && <text>{" "}</text>}
          <For each={graphs.slice(0, MAX_GRAPH_ROWS)}>{(graph) => {
            if (!snap) return null;
            return renderGraphActivity({ c, graph, snap, sessionScope: props.sessionScope, currentSessionId: props.currentSessionId });
          }}</For>
        </>
      )}

      {/* Active loops */}
      {loops.length > 0 && (
        <>
          {(fns.length > 0 || tasks.length > 0 || graphs.length > 0) && <text>{" "}</text>}
          <For each={loops.slice(0, MAX_LOOP_ROWS)}>{(loop) => renderLoopActivity({ c, loop })}</For>
        </>
      )}
    </box>
  );
}
