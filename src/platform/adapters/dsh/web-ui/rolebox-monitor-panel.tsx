/**
 * RoleboxMonitorPanel — the rolebox RUN CONSOLE as a dsh RIGHT-SIDEBAR TAB BODY
 * (browser half).
 *
 * The page is a right-Sidebar page type: `client.ts` registers the type in
 * `ctx.sidebarRightTabs` (id/kind `rolebox-monitor`) and this component as
 * its BODY in the keyed `'sidebar.right.pane.tab'` seat under the type's
 * `id`. The user opens it from the right-Sidebar guide capsule ("Rolebox") or
 * from the Rolebox settings page's "Open monitor" control
 * (`ctx.sidebarRight.openTab`). Monitoring is live, session-scoped evidence,
 * so it belongs BESIDE the conversation — the sidebar tab — while the
 * `settings.section` page answers the static question "what roles are
 * loaded" (`rolebox-roles-panel.tsx`). This body consumes none of the tab's
 * business data; it renders global rolebox state.
 *
 * ── What this surface is for ──────────────────────────────────────────────
 * A developer glancing right from their conversation asks, in order:
 *
 *   1. is anything running, and is anything waiting on ME?
 *   2. which session am I in, and as which role?
 *   3. what is each run doing right now — which node, which round, for how
 *      long, at what cost?
 *   4. if something broke, WHAT broke and why?
 *
 * The console therefore reads top-down as VERDICT → IDENTITY → EVIDENCE →
 * REFERENCE, and every section is a LEDGER (aligned rows) rather than a card:
 * one hairline-separated block per object, one row per unit of work. It is
 * deliberately denser than the settings page — this surface is an instrument,
 * and a monitoring instrument that hides its readings behind a click is a
 * decoration.
 *
 * ── Wire contract (the shape the panel actually receives) ─────────────────
 * `GET /rolebox/status` is composed by `web-rolebox-monitor-route.ts`:
 *
 *     { ok, loops: { count, states: LoopSummaryDto[] },
 *       engineGraphs: EngineGraphSnapshot[],
 *       sessions: { count, mostRecentId, activeRoles } }
 *
 * The previous revision of this panel read `loops` as a bare array or a
 * keyed map and `sessions.recentIds`, so against the real backend the Loops
 * section never mounted and the session roster degraded to a bare count. Both
 * seats are now read in BOTH their real and their tolerant legacy shapes (see
 * {@link extractLoops} / {@link extractSessions}), and the fields the wire
 * carries but nothing rendered — per-loop error reason, round and run timing,
 * worker session, tree parentage, cancel requests; per-graph node ledger,
 * frontier, start time and staleness — are rendered.
 *
 * `GET /rolebox/metrics` returns `metrics.snapshot()` verbatim: named
 * counters, gauges and histograms whose KEYS may carry Prometheus-style labels
 * (`name{agent=x}`) and whose histograms carry `buckets/sum/count`. The
 * panel parses the key (as the TUI monitor and CLI already do), labels the
 * readings, and derives `avg/p50/p95/n` from the buckets. An empty snapshot
 * is NOT a silent section: the registry is gated by `ROLEBOX_METRICS`, so an
 * empty payload renders the reason instead of vanishing.
 *
 * ── Design posture ────────────────────────────────────────────────────────
 *   - Verdict first. {@link renderAttentionBand} is the first child of the
 *     body and the panel's only focal point.
 *   - State is never coloured text. The host palette measures
 *     `state-success-primary` at 2.09:1 and `state-warn-primary` at 1.99:1 as
 *     marks on their own tints — both fail 3:1 for non-text. A state is
 *     therefore a tint fill plus the normalised state WORD, with the raw
 *     backend phase/status string always in the DOM beside it, so nobody has
 *     to memorise the engine vocabulary and an unrecognised value degrades to
 *     a neutral chip rather than to a false success or failure.
 *   - Facts, not sentences. Counts are rendered as labelled fields
 *     (`Failed 1`), never glued into one dotted metadata line, so the eye can
 *     scan the label column and the value column independently.
 *   - Nothing is invented. Every number comes from the payload; the exact
 *     value of every rounded reading (`1.2k`, `3m`) rides a `title`.
 *     "All clear" is claimed only when every phase was actually read.
 *   - Live work leads. Node and session ledgers sort what is RUNNING, BLOCKED
 *     or FAILED above what is finished or queued, and cap the rest behind an
 *     accessible disclosure, so the common case (a long graph, one hot node)
 *     is one glance instead of one scroll.
 *
 * The component accepts the framework's `sessionId` standard prop (session
 * scope) so the roster can mark and lead with the session the user is looking
 * at; it degrades silently when the host does not supply one.
 *
 * CHROME FOR A NARROW COLUMN: the right Sidebar can be docked narrow (about
 * 280px of content). Every chrome row wraps or truncates with a `title`
 * recovery, padding is tighter than the settings page's, and the sections stay
 * strictly single-column.
 *
 * This module is BROWSER code: it must not import node builtins, and it uses
 * the browser `fetch` global with relative (same-origin) paths. The shared
 * formatters it imports are pure module-level functions from `src/utils`.
 *
 * @module
 */

import { useEffect, useRef, useState } from "react";
import { monitorClass } from "./rolebox-monitor-panel.css.ts";
import {
  formatCount,
  formatRelativeTime,
} from "../../../../utils/text-format.ts";
import {
  formatDuration,
  shortSessionId,
} from "../../../../utils/display-helpers.ts";

// ── Endpoint contract ──────────────────────────────────────────────────────

/** `GET /rolebox/status` — composed rolebox runtime health (same-origin). */
export const STATUS_ENDPOINT = "/rolebox/status";

/** `GET /rolebox/metrics` — `metrics.snapshot()` (counters/gauges/histograms). */
export const METRICS_ENDPOINT = "/rolebox/metrics";

/**
 * `GET /rolebox/events` — the change-signal channel (server-sent events).
 *
 * The host writes a frame whenever rolebox state moves (a loop transition, a
 * graph settling, a state file changing) and nothing on a schedule. The console
 * answers a frame by refetching the composed snapshot, so the snapshot stays
 * the single source of truth and this channel never carries a delta.
 */
export const EVENTS_ENDPOINT = "/rolebox/events";

/**
 * Shortest gap between two signal-driven refetches.
 *
 * The host already coalesces its frames; this is the client's own floor, so a
 * burst that arrives across several frames still costs one request — and so a
 * console left open on a busy afternoon cannot turn a chatty channel into a
 * request storm.
 */
export const SIGNAL_REFETCH_MS = 600;

/** How often the local clock advances the ages on screen. */
export const CLOCK_TICK_MS = 1000;

/** How the console is being kept up to date. */
export type PanelLive = "connecting" | "live" | "manual";

/** The word shown beside the freshness stamp. */
export const LIVE_LABEL: Record<PanelLive, string> = {
  connecting: "connecting",
  live: "live",
  manual: "manual refresh",
};

// ── Structural DTOs (mirror the backend shapes) ────────────────────────────

/**
 * Structural loop-summary DTO — one entry of `loops.states` in the
 * `GET /rolebox/status` body. Mirrors `LoopSummaryDto`
 * (web-rolebox-monitor-route.ts), which projects `LoopState`
 * (`src/loop/types.ts`). Every key is optional so a partial backend payload
 * degrades gracefully.
 */
export interface MonitorLoopDto {
  originSessionId?: string;
  agent?: string;
  phase?: string;
  current?: number;
  total?: number;
  mode?: string;
  /** Set when this loop is a tree worker of another loop. */
  parentLoopId?: string;
  /** Dispatch task id of the active worker round. */
  activeWorkerTaskId?: string;
  /** Session id of the active worker round. */
  activeWorkerSessionId?: string;
  /** Whether cancellation has been requested but not yet observed. */
  cancelRequested?: boolean;
  /** Unix ms when the loop started. */
  startedAt?: number;
  /** Unix ms of the most recent state update. */
  updatedAt?: number;
  /** Unix ms when the current round started. */
  roundStartedAt?: number;
  /** Dispatched rounds recorded so far. */
  roundCount?: number;
  /** Failure description while the loop phase is `error`. */
  errorReason?: string;
}

/** Structural graph-budget DTO — the `budget` seat of an engine-graph block. */
export interface MonitorBudgetDto {
  sessionsSpawned?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCost?: number;
}

/** Structural loop-group DTO — one loop group of an engine-graph snapshot. */
export interface MonitorLoopGroupDto {
  id?: string;
  traversalCount?: number;
  maxTraversals?: number;
}

/**
 * Structural per-node DTO — one entry of a graph snapshot's `nodes` seat
 * (`GraphNodeSnapshot`, monitor-reader-types.ts). This is the developer-facing
 * core of the console: which node is running, under which agent, how long it
 * has been going and whether it has already retried.
 */
export interface MonitorGraphNodeDto {
  nodeId?: string;
  agent?: string;
  status?: string;
  /** First signal the node observed (`answer`, `revise_needed`, …). */
  signalType?: string;
  /** ISO timestamp when the node started. */
  startedAt?: string;
  /** ISO timestamp when the node completed. */
  completedAt?: string;
  /** Retries attempted so far. */
  retryCount?: number;
  /**
   * Failure reason recorded by the engine for a failing terminal node
   * (`GraphNodeSnapshot.errorReason`, monitor-reader-types.ts). Rendered as the
   * node row's `error` fact so the cause is visible, not just the status.
   */
  errorReason?: string;
  /** Loop group this node belongs to. */
  loopGroupId?: string;
  /** Dispatch task id spawned for this node. */
  dispatchTaskId?: string;
  /** Session id of the node's dispatch task. */
  dispatchSessionId?: string;
}

/**
 * Structural engine-graph DTO — one item of the `engineGraphs` seat. Mirrors
 * `EngineGraphSnapshot` (`src/cli/commands/monitor/monitor-reader-types.ts`);
 * the panel consumes the display-relevant subset.
 */
export interface MonitorEngineGraphDto {
  graph?: import("../../../../graph/query/graph-query.ts").GraphView;
  graphId?: string;
  phase?: string;
  nodeCount?: number;
  nodeStatusCounts?: Record<string, number>;
  nodes?: MonitorGraphNodeDto[];
  budget?: MonitorBudgetDto;
  /** Node ids awaiting dispatch. */
  frontier?: string[];
  loopGroups?: MonitorLoopGroupDto[];
  /** ISO timestamp when the graph started. */
  startedAt?: string;
  /** ISO timestamp of the last state update. */
  updatedAt?: string;
  /** Raw epoch-ms of the last state update (source of truth for staleness). */
  updatedAtMs?: number;
  /** Whether any per-node checkpoints were recorded. */
  hasCheckpoints?: boolean;
}

/**
 * Structural sessions DTO — the `sessions` seat of `GET /rolebox/status`:
 * count, the most recent id, and the active role per session (a null role means
 * the session is running the base agent). Also accepted as a bare array of
 * `{ id }` records for robustness.
 */
export interface MonitorSessionsDto {
  count?: number;
  mostRecentId?: string | null;
  activeRoles?: Record<string, string | null>;
  /** Legacy/array form: ids without roles. */
  recentIds?: string[];
}

/**
 * Structural `GET /rolebox/status` success body. All seats are optional: an
 * older or partially populated backend must degrade to the sections it has,
 * never fail the panel.
 */
export interface MonitorStatusBody {
  timestamp?: string;
  /** `{ count, states }` on the wire; array/keyed map tolerated. */
  loops?: { count?: number; states?: MonitorLoopDto[] } | MonitorLoopDto[] | Record<string, MonitorLoopDto>;
  engineGraphs?: MonitorEngineGraphDto[];
  sessions?: MonitorSessionsDto | Array<{ id?: string }>;
}

/** Structural metric-value DTO — one counter or gauge snapshot. */
export interface MonitorMetricValueDto {
  value?: number;
  labels?: Record<string, string>;
}

/** Structural histogram DTO — one histogram snapshot. */
export interface MonitorHistogramDto {
  buckets?: Record<string, number>;
  sum?: number;
  count?: number;
  labels?: Record<string, string>;
}

/**
 * Structural `GET /rolebox/metrics` success body — mirrors
 * `MetricsSnapshot` (`src/dispatch/persistence/metrics.ts`).
 */
export interface MonitorMetricsBody {
  counters?: Record<string, MonitorMetricValueDto>;
  gauges?: Record<string, MonitorMetricValueDto>;
  histograms?: Record<string, MonitorHistogramDto>;
}

// ── Run-state vocabulary ───────────────────────────────────────────────────

/**
 * Normalised run state derived from a raw backend phase string.
 *
 * The panel must never make the user memorise the backend vocabulary (engine
 * phases `idle | executing | complete`, the eight-state loop machine, the
 * nine engine node statuses), and it must never guess: an unrecognised value
 * degrades to `unknown` — never to a false success or a false failure.
 * `stopped` is deliberately distinct from `failed`: a cancelled or
 * interrupted run stopped, but it did not break, and calling it "Failed" would
 * be a lie. `pending` is the fourth reading a developer needs and the only one
 * the phase vocabulary alone cannot express — a node waiting for a dispatch
 * slot is not "running" and certainly not "unknown".
 */
export type RoleboxRunState =
  | "failed"
  | "blocked"
  | "stopped"
  | "pending"
  | "complete"
  | "running"
  | "idle"
  | "unknown";

/** The word rendered in the state chip — always paired with the raw phase. */
export const RUN_STATE_LABEL: Record<RoleboxRunState, string> = {
  failed: "Failed",
  blocked: "Blocked",
  stopped: "Stopped",
  pending: "Queued",
  complete: "Done",
  running: "Running",
  idle: "Idle",
  unknown: "Unknown",
};

const FAILED_PHASE =
  /\b(fail|failed|failure|error|errored|reject|rejected|crash|crashed|broken)\b/;
const STOPPED_PHASE =
  /\b(cancel\w*|interrupt\w*|abort\w*|terminat\w*|timeout|timed_out|stopped)\b/;
const IDLE_PHASE = /\bidle\b/;
const BLOCKED_PHASE =
  /\b(block\w*|paus\w*|halt\w*|suspend\w*|stall\w*|gated)\b/;
const COMPLETE_PHASE =
  /\b(complete\w*|done|finish\w*|success\w*|closed)\b/;
const RUNNING_PHASE =
  /\b(run\w*|execut\w*|activ\w*|in_progress|progress\w*|await\w*|dispatch\w*|pending|start\w*|summar\w*|finaliz\w*|initializ\w*|working|processing)\b/;

/**
 * Classify a raw phase into a {@link RoleboxRunState}. Order matters: failure
 * is tested first, then stopped, idle, blocked, complete, and running last —
 * so `awaiting_worker` classifies as running rather than as blocked, and
 * `cancelled` as stopped rather than as unknown.
 *
 * `idle` is matched explicitly: it is the engine's initial and resting phase
 * (`EnginePhase = idle | executing | complete`), and letting it fall through
 * to `unknown` would have the UI say "I cannot read this" about a value it is
 * displaying right next to the chip.
 */
export function classifyRunPhase(phase: string | undefined): RoleboxRunState {
  if (typeof phase !== "string" || phase === "") return "unknown";
  const value = phase.toLowerCase();
  if (FAILED_PHASE.test(value)) return "failed";
  if (STOPPED_PHASE.test(value)) return "stopped";
  if (IDLE_PHASE.test(value)) return "idle";
  if (BLOCKED_PHASE.test(value)) return "blocked";
  if (COMPLETE_PHASE.test(value)) return "complete";
  if (RUNNING_PHASE.test(value)) return "running";
  return "unknown";
}

/**
 * Classify an engine NODE status into a {@link RoleboxRunState}.
 *
 * Node statuses are not phases and cannot be routed through
 * {@link classifyRunPhase}: `pending` matches that function's RUNNING set and
 * would report a queued node as executing, `escalate` matches nothing at all
 * and would report a node that is waiting on a human as unreadable, and
 * `ready` is the engine's own name for "awaiting dispatch". Those three are
 * therefore resolved here, and everything else falls through to the phase
 * classifier so both surfaces agree on `running` / `complete` / `error`.
 */
export function classifyNodeStatus(status: string | undefined): RoleboxRunState {
  if (typeof status !== "string" || status === "") return "unknown";
  const value = status.toLowerCase();
  if (value === "escalate" || value === "blocked") return "blocked";
  if (value === "pending" || value === "ready") return "pending";
  return classifyRunPhase(value);
}

/**
 * The panel's headline verdict. Every label comes from the payload and every
 * count is derived — nothing here is estimated or invented.
 */
export interface MonitorAttention {
  failed: string[];
  blocked: string[];
  /** Labels whose phase could not be classified. Not an alarm — an admission. */
  unknown: string[];
  /** Units actively running (graphs + loops). */
  running: number;
  /** Units holding a queued node or waiting to start. */
  pending: number;
  /** Units finished successfully. */
  complete: number;
  /**
   * Units that stopped without breaking — cancelled, interrupted, timed out.
   *
   * Counted rather than forgotten: a stopped run is not an alarm, but it IS a
   * unit the panel draws a row for, and a verdict that cannot see it ends up
   * contradicting the evidence beneath it ("No graphs or loops are reporting"
   * printed over a cancelled loop's own row).
   */
  stopped: number;
  /** Units resting at the engine's idle phase (its initial persisted phase). */
  idle: number;
  /** Every unit the verdict read — graphs + loops, whatever their state. */
  units: number;
  needsAttention: boolean;
}

/**
 * Derive the attention verdict from engine graphs and loops.
 *
 * A graph can carry a failed or blocked NODE while its own phase still reads
 * running; that is surfaced too, because work has stopped somewhere inside it.
 * A cancelled or interrupted run is `stopped` and deliberately does NOT raise
 * attention — the user already ended it.
 */
export function deriveAttention(
  graphs: MonitorEngineGraphDto[],
  loops: MonitorLoopDto[],
): MonitorAttention {
  const failed: string[] = [];
  const blocked: string[] = [];
  // Named unclassified locally: the word unknown is a reserved type keyword.
  const unclassified: string[] = [];
  let running = 0;
  let pending = 0;
  let complete = 0;
  let stopped = 0;
  let idle = 0;

  const note = (state: RoleboxRunState): void => {
    if (state === "running") running += 1;
    else if (state === "pending") pending += 1;
    else if (state === "complete") complete += 1;
    else if (state === "stopped") stopped += 1;
    else if (state === "idle") idle += 1;
  };

  for (const graph of graphs) {
    let state = classifyRunPhase(graph.phase);
    for (const [name, count] of Object.entries(graph.nodeStatusCounts ?? {})) {
      if (typeof count !== "number" || count <= 0) continue;
      // A FINISHED graph keeps its own verdict. A node that timed out, was
      // cancelled, or simply completed on the way here converged on the
      // engine's terminal `done` status (`VALID_NODE_TRANSITIONS` in
      // src/graph/engine/node-lifecycle.ts), so its count is history — work
      // that ended, one way or another — and letting it raise the band would
      // pin a permanent red mark on finished work beside that graph's own Done
      // chip. A monitoring surface that cries wolf is worse than one that says
      // nothing.
      const key = name.toLowerCase();
      // `blocked` is the ONE node status that stays LIVE across a terminal
      // phase: the deleted engine's cancel() left a human-in-the-loop gate for
      // the human while forcing the phase to `complete` anyway, and the record
      // still carries the blocked node even though the approval tool that once
      // resolved it (graph_approve) no longer exists. This repo's own monitor
      // reader keeps exactly that graph out of its staleness filter so "a
      // human-in-the-loop approval pause is never hidden as dead". Claiming
      // "All clear" over a pending approval is under-reporting of the costliest
      // kind: the user is the one being waited on.
      if (key === "blocked") {
        if (state !== "failed") state = "blocked";
        continue;
      }
      if (graph.phase === "complete") continue;
      // `escalate` is a real NodeStatus that matches no phase regex. The host's
      // own renderer paints it as an error: a node is waiting on a human.
      if (key === "escalate") {
        if (state !== "failed") state = "blocked";
        continue;
      }
      const nodeState = classifyRunPhase(key);
      // On a LIVE graph, a node that failed, timed out or was cancelled means
      // the run is not healthy.
      if (nodeState === "failed" || nodeState === "stopped") state = "failed";
      else if (nodeState === "blocked" && state !== "failed") state = "blocked";
    }
    const label = graph.graphId ?? "unnamed graph";
    if (state === "failed") failed.push(label);
    else if (state === "blocked") blocked.push(label);
    else if (state === "unknown") unclassified.push(label);
    else note(state);
  }

  for (const loop of loops) {
    const state = classifyRunPhase(loop.phase);
    const label = loop.originSessionId ?? "unnamed loop";
    if (state === "failed") failed.push(label);
    else if (state === "blocked") blocked.push(label);
    else if (state === "unknown") unclassified.push(label);
    else note(state);
  }

  return {
    failed,
    blocked,
    unknown: unclassified,
    running,
    pending,
    complete,
    stopped,
    idle,
    units: graphs.length + loops.length,
    needsAttention: failed.length + blocked.length > 0,
  };
}

/**
 * One plain-text sentence for the live region and for `title` recoveries.
 *
 * Deliberately prose rather than a row of dot-separated tokens: the visible
 * band renders labelled count fields instead (see {@link renderAttentionBand}),
 * and a sentence is what a screen reader should hear in one announcement.
 */
export function describeAttention(attention: MonitorAttention): string {
  const parts: string[] = [];
  if (attention.failed.length > 0) {
    parts.push("Failed: " + attention.failed.join(", "));
  }
  if (attention.blocked.length > 0) {
    parts.push("Blocked: " + attention.blocked.join(", "));
  }
  if (attention.unknown.length > 0) {
    parts.push("Unrecognized: " + attention.unknown.join(", "));
  }
  if (parts.length > 0) return parts.join(". ");
  // "Nothing is reporting" is a claim about the PAYLOAD, so it is made only
  // when the payload genuinely carried no unit. A stopped or idle unit is a
  // unit: it keeps its own sentence rather than being described as absence.
  if (attention.units === 0) return "No graphs or loops are reporting";
  const buckets: string[] = [];
  if (attention.running > 0) {
    buckets.push(
      attention.running + (attention.running === 1 ? " run active" : " runs active"),
    );
  }
  if (attention.pending > 0) buckets.push(attention.pending + " queued");
  if (attention.complete > 0) buckets.push(attention.complete + " complete");
  if (attention.stopped > 0) buckets.push(attention.stopped + " stopped");
  if (attention.idle > 0) buckets.push(attention.idle + " idle");
  return buckets.length > 0 ? buckets.join(", ") : "Nothing running";
}

/**
 * The verdict's attention sentence, agreeing in number: "1 needs attention" /
 * "2 need attention". Shared by the panel `title` and the live region so the
 * two can never disagree about the same snapshot.
 */
function attentionPhrase(count: number): string {
  return formatCount(count) + (count === 1 ? " needs attention" : " need attention");
}

/** Row cap per metric group before the "Show all" disclosure appears. */
export const GROUP_ROW_LIMIT = 8;

/**
 * Node rows shown per graph before the "Show all" disclosure appears.
 *
 * Four is the number that fits a 280px column beside the graph's own readings
 * without the block pushing its neighbours off screen; live rows are sorted to
 * the front, so the cap hides finished work rather than the interesting kind.
 */
export const NODE_ROW_LIMIT = 4;

/** Session rows shown in the roster before its disclosure appears. */
export const SESSION_ROW_LIMIT = 6;

/**
 * Cells in a loop's round progress bar. The bar is a proportion, not a
 * per-round ledger: a 200-round loop must not stretch the row.
 */
export const ROUND_CELL_LIMIT = 12;

/**
 * How long one seat's request may hang before it fails into the error path.
 *
 * A bare `fetch` has no deadline: a request that never answers leaves the
 * skeleton on screen with the panel's only control disabled, which is a
 * recovery path of zero width. The abort is a platform timer, not a scheduled
 * poll — the panel still issues exactly one request per seat per refresh.
 */
export const FETCH_TIMEOUT_MS = 15_000;

/**
 * Request options for one seat fetch — a bounded signal where the platform
 * provides one (`AbortSignal.timeout`, Chrome 103+ / Safari 16+), and nothing
 * where it does not, so an older host degrades to the unbounded request rather
 * than throwing.
 */
function seatRequestInit(): RequestInit {
  const timeout = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal })
    ?.timeout;
  return typeof AbortSignal !== "undefined" && typeof timeout === "function"
    ? { signal: timeout.call(AbortSignal, FETCH_TIMEOUT_MS) }
    : {};
}

/**
 * How long a non-terminal graph may go without a state update before the
 * console says so. Purely a presentation threshold over the payload's own
 * `updatedAtMs` — the panel reports the age, it does not diagnose the cause.
 */
export const GRAPH_QUIET_MS = 120_000;

// ── Props ──────────────────────────────────────────────────────────────────

/**
 * Props of the docked tab body.
 *
 * The body is registered into the keyed `'sidebar.right.pane.tab'` seat with
 * no inject face, so the framework hands it the standard session-scope kit plus
 * the entry's empty business face. `sessionId` is the one standard prop this
 * component reads: marking the session the user is actually looking at (and
 * leading the roster with it) is the difference between a list of ids and an
 * answer to "where am I". It is optional here so a host that supplies a
 * narrower seat still renders the panel.
 *
 * `t` is declared (optional) only for structural completeness: the panel
 * renders hardcoded English text (this plugin registers no locale
 * dictionaries, and unknown keys must not be routed through `t`).
 */
export interface RoleboxMonitorPanelProps {
  /** Session the panel is docked beside (session-scope standard prop). */
  sessionId?: string;
  /** Locale seat (accepted, not used — hardcoded English copy). */
  t?: (key: string, params?: Record<string, unknown>) => string;
}

// ── Internal helpers ───────────────────────────────────────────────────────

/** Status-seat state: the rendered text plus whether it is an error. */
interface PanelStatus {
  text: string;
  error: boolean;
}

/**
 * One reading in a ledger lane.
 *
 * `label` is what the reading MEANS and stays in the accessibility tree; the
 * glyph is what the eye uses to find it. A lane of twenty readings at 11px is
 * unreadable as prose and perfectly readable as shapes.
 */
interface MetaFact {
  label: string;
  value: string;
  /** Full, unrounded value for the `title` recovery. */
  title?: string;
  /** Glyph for the label slot. Omitted ⇒ the label word renders instead. */
  icon?: RoleboxIcon;
  /** State glyph for the label slot (the strip legend uses the strip's shapes). */
  state?: RoleboxRunState;
  /** Render the label word beside the glyph (for readings a glyph cannot carry). */
  word?: string;
}

/**
 * Parse one `/rolebox/events` frame. Unknown or malformed frames are ignored
 * rather than thrown: the channel is a hint, and a console that dies on a
 * frame it does not recognize would be worse than one that ignores it.
 */
function parseEventFrame(data: unknown): { type: string } | null {
  if (typeof data !== "string" || data === "") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (!isRecord(parsed) || typeof parsed.type !== "string") return null;
    return { type: parsed.type };
  } catch {
    return null;
  }
}

/** The live dot's modifier — the word beside it carries the meaning too. */
function liveDotModifier(live: PanelLive): string {
  if (live === "live") return monitorClass.liveDotOn;
  if (live === "connecting") return monitorClass.liveDotPending;
  return monitorClass.liveDotOff;
}

/** Render an error/status message as a string (browser-safe, no node builtins). */
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Structural record guard (non-null, non-array object). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Finite-number guard. */
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Non-empty-string guard. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Normalize an `activeRoles`-shaped record (string or null values only). */
function asStringOrNullRecord(value: unknown): Record<string, string | null> {
  if (!isRecord(value)) return {};
  const out: Record<string, string | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || item === null) out[key] = item;
  }
  return out;
}

/** Format a count for display; non-finite/absent values render as "—". */
function count(value: unknown): string {
  const n = asNumber(value);
  return n === undefined ? "—" : formatCount(n);
}

/** Same as {@link count}, but omits the row entirely when the value is absent. */
function optionalFact(
  label: string,
  value: unknown,
  format: (n: number) => string,
  titleFormat: (n: number) => string = formatCount,
  icon?: RoleboxIcon,
): MetaFact | null {
  const n = asNumber(value);
  if (n === undefined) return null;
  return { label, value: format(n), title: titleFormat(n), ...(icon ? { icon } : {}) };
}

/**
 * Compact a token count for a narrow column: exact under 1000, then `1.2k`
 * and `3.4M`. The exact figure always rides the row's `title`.
 */
function compactTokens(n: number): string {
  if (Math.abs(n) < 1000) return formatCount(n);
  if (Math.abs(n) < 1_000_000) return (n / 1000).toFixed(1) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}

/**
 * Format a currency amount, trimming trailing zeros.
 *
 * An amount too small to show at four decimals renders as `<$0.0001` rather
 * than as a flat `$0`: a spend that happened must not read as no spend. The
 * exact value always rides the row's `title`.
 */
function formatCost(n: number): string {
  if (n === 0) return "$0";
  if (Math.abs(n) < 0.0001) return (n < 0 ? ">-$0.0001" : "<$0.0001");
  const fixed = n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return "$" + fixed;
}

/** The `title` for a cost fact — always carries the currency symbol. */
function costTitle(n: number): string {
  return "$" + formatCount(n);
}

/**
 * Reduce an arbitrary identifier to a token safe for `id`/`aria-controls`
 * wiring: letters, digits, `-` and `_` survive, every other run collapses to a
 * single dash. Two different graph ids can collide here — which is harmless,
 * because the pair only has to be unique among the ledgers ON SCREEN, and each
 * graph renders one.
 */
function domIdPart(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe === "" ? "graph" : safe;
}

/**
 * Shorten an identifier for a narrow column.
 *
 * dsh session ids are `session-<uuid>`; stripping the constant prefix and
 * keeping the first eight uuid characters is what distinguishes two sessions at
 * a glance, which the generic {@link shortSessionId} cannot do (it would render
 * every dsh session as "ses…" plus a five-character tail). Every other shape
 * falls through to the shared helper. The full id always rides the `title`.
 */
function shortId(id: string | undefined): string {
  if (id === undefined || id === "") return "unknown";
  if (id.startsWith("session-")) {
    const rest = id.slice("session-".length);
    return rest.slice(0, 8) + "\u2026";
  }
  return shortSessionId(id);
}

/**
 * Milliseconds a unit of work has been running, measured against the moment
 * the panel's snapshot landed (`now`). Returns `undefined` for absent,
 * non-positive or future timestamps — an epoch-0 value is the reader's own
 * "this field was missing" placeholder, and rendering it as an age would print
 * a confident "20,717 days ago" over a field that was never written.
 */
function elapsedMs(startedAtMs: unknown, now: number): number | undefined {
  const start = asNumber(startedAtMs);
  if (start === undefined || start <= 0 || now <= 0) return undefined;
  const delta = now - start;
  return delta >= 0 ? delta : undefined;
}

/**
 * Parse an ISO timestamp into epoch ms; `undefined` when unreadable or when it
 * resolves to the epoch itself (the monitor reader substitutes
 * `new Date(0).toISOString()` for a missing `updatedAt`, so "1970-01-01" means
 * "no reading", not "very old").
 */
function parseIsoMs(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * Split a metric key into its name and Prometheus-style labels, mirroring
 * `parseMetricKey` in `src/cli/commands/monitor/monitor-helpers.ts` — the CLI,
 * the TUI and this console must read the same key identically.
 */
function parseMetricKey(key: string): {
  name: string;
  labels: Record<string, string>;
} {
  const braceIdx = key.indexOf("{");
  if (braceIdx === -1) return { name: key, labels: {} };
  const name = key.slice(0, braceIdx);
  const labelsPart = key.endsWith("}") ? key.slice(braceIdx + 1, -1) : key.slice(braceIdx + 1);
  const labels: Record<string, string> = {};
  for (const part of labelsPart.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    labels[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
  }
  return { name, labels };
}

/**
 * The bucket boundary at which the observation count first reaches `pct` of
 * all observations.
 *
 * The registry's buckets are CUMULATIVE — `Histogram.observe` increments every
 * boundary at or above the sample (Prometheus `le` style), so the last bucket
 * holds the whole population. The counts are therefore compared against the
 * threshold directly and never accumulated: summing them would count every
 * observation once per boundary it satisfies and report a p95 far below the
 * truth. (The CLI/TUI helper this was modelled on does sum them; the console
 * must not repeat that reading.) Returns `undefined` when nothing was
 * observed.
 */
function histogramPercentile(
  buckets: Record<string, number>,
  total: number,
  pct: number,
): number | undefined {
  if (total <= 0) return undefined;
  const threshold = total * pct;
  const sorted = Object.entries(buckets)
    .map(([k, v]) => [Number(k), v] as const)
    .filter(([boundary, observed]) =>
      Number.isFinite(boundary) && Number.isFinite(observed),
    )
    .sort((a, b) => a[0] - b[0]);
  for (const [boundary, observed] of sorted) {
    if (observed >= threshold) return boundary;
  }
  return sorted.length > 0 ? sorted[sorted.length - 1]![0] : undefined;
}

/** Milliseconds as a duration reading, or "—" when the input is unusable. */
function duration(ms: number | undefined): string {
  return ms === undefined ? "—" : formatDuration(ms);
}

// ── Payload extraction (defensive normalization) ───────────────────────────

/**
 * Extract the loop list from the `loops` seat.
 *
 * The wire shape is `{ count, states }` (web-rolebox-monitor-route.ts). The
 * two older shapes are still accepted — a bare array, and an object-keyed map
 * produced when a Map is JSON-serialized — because a panel that silently drops
 * the loops seat is exactly the failure this console was rebuilt to end: the
 * previous reader sent `{ count, states }` through the map branch and filtered
 * every entry out, so the Loops section never mounted against the real server.
 */
function extractLoops(body: unknown): MonitorLoopDto[] {
  if (!isRecord(body)) return [];
  const loops = body.loops;
  if (Array.isArray(loops)) return loops.filter(isRecord) as MonitorLoopDto[];
  if (isRecord(loops)) {
    if (Array.isArray(loops.states)) {
      return loops.states.filter(isRecord) as MonitorLoopDto[];
    }
    // A keyed map: every value that is itself a record is a loop. `count` and
    // `states` are filtered out by the record guard for every non-map shape.
    return Object.values(loops).filter(isRecord) as MonitorLoopDto[];
  }
  return [];
}

/** Extract the engine-graph list (array only). */
function extractGraphs(body: unknown): MonitorEngineGraphDto[] {
  if (!isRecord(body)) return [];
  const graphs = body.engineGraphs;
  if (!Array.isArray(graphs)) return [];
  return graphs.filter(isRecord) as MonitorEngineGraphDto[];
}

/** Extract the per-node list of one graph snapshot (array only). */
function extractNodes(graph: MonitorEngineGraphDto): MonitorGraphNodeDto[] {
  return Array.isArray(graph.nodes)
    ? (graph.nodes.filter(isRecord) as MonitorGraphNodeDto[])
    : [];
}

/**
 * Extract the sessions seat, tolerating the real `{ count, mostRecentId,
 * activeRoles }` object and a bare array of `{ id }` records.
 */
function extractSessions(body: unknown): MonitorSessionsDto {
  if (!isRecord(body)) return {};
  const raw = body.sessions;
  if (Array.isArray(raw)) {
    const recentIds = raw
      .filter(isRecord)
      .map((session) => (typeof session.id === "string" ? session.id : ""))
      .filter((id) => id.length > 0);
    return { count: recentIds.length, recentIds, activeRoles: {} };
  }
  if (isRecord(raw)) {
    const recentIds = Array.isArray(raw.recentIds)
      ? raw.recentIds.filter((id): id is string => typeof id === "string")
      : [];
    return {
      count: asNumber(raw.count),
      mostRecentId: typeof raw.mostRecentId === "string" ? raw.mostRecentId : null,
      recentIds,
      activeRoles: asStringOrNullRecord(raw.activeRoles),
    };
  }
  return {};
}

/** One row of the session roster: the id, the role running in it, its rank. */
interface SessionRow {
  id: string;
  role: string | null;
  /** The session this panel is docked beside. */
  current: boolean;
  /** The session the store last touched. */
  mostRecent: boolean;
}

/**
 * Build the session roster from the sessions seat plus the panel's own session.
 *
 * Ordering answers the developer's first question ("where am I?") before the
 * historical one: the docked session leads, the most recently touched session
 * follows, and the remainder is ordered by id so successive refreshes do not
 * shuffle the list under the cursor. Ties are impossible: ids are unique.
 */
function buildSessionRows(
  sessions: MonitorSessionsDto,
  currentSessionId: string | undefined,
): SessionRow[] {
  const roles = sessions.activeRoles ?? {};
  const ids = new Set<string>(Object.keys(roles));
  for (const id of sessions.recentIds ?? []) ids.add(id);
  if (typeof sessions.mostRecentId === "string") ids.add(sessions.mostRecentId);
  if (currentSessionId !== undefined && currentSessionId !== "") {
    ids.add(currentSessionId);
  }

  const rows: SessionRow[] = [...ids].map((id) => ({
    id,
    role: roles[id] ?? null,
    current: id === currentSessionId,
    mostRecent: id === sessions.mostRecentId,
  }));

  return rows.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (a.mostRecent !== b.mostRecent) return a.mostRecent ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Extract named metric entries (counters/gauges) as `[name, snapshot]` pairs. */
function extractMetrics(
  body: unknown,
  seat: "counters" | "gauges",
): Array<[string, MonitorMetricValueDto]> {
  if (!isRecord(body)) return [];
  const record = body[seat];
  if (!isRecord(record)) return [];
  return Object.entries(record).filter(
    (entry): entry is [string, MonitorMetricValueDto] => isRecord(entry[1]),
  );
}

/** Extract named histogram entries as `[name, snapshot]` pairs. */
function extractHistograms(body: unknown): Array<[string, MonitorHistogramDto]> {
  if (!isRecord(body)) return [];
  const record = body.histograms;
  if (!isRecord(record)) return [];
  return Object.entries(record).filter(
    (entry): entry is [string, MonitorHistogramDto] => isRecord(entry[1]),
  );
}

// ── Shared chrome ──────────────────────────────────────────────────────────

/** Map a run state to its chip modifier class. */
function chipModifier(state: RoleboxRunState): string {
  if (state === "failed") return monitorClass.chipFailed;
  if (state === "blocked") return monitorClass.chipBlocked;
  if (state === "stopped") return monitorClass.chipStopped;
  if (state === "pending") return monitorClass.chipPending;
  if (state === "idle") return monitorClass.chipIdle;
  if (state === "complete") return monitorClass.chipComplete;
  if (state === "running") return monitorClass.chipRunning;
  return monitorClass.chipUnknown;
}

/**
 * The normalised state chip. Deliberately NOT `aria-hidden`: the word is the
 * channel that survives total loss of hue perception, so it must be announced
 * — and it always sits beside the raw backend phase, never instead of it.
 */
function renderChip(state: RoleboxRunState) {
  return (
    <span className={monitorClass.chip + " " + chipModifier(state)}>
      <StateGlyph state={state} size={14} />
      {RUN_STATE_LABEL[state]}
    </span>
  );
}

/** The quiet half of the chip family: a categorical value with no state. */
function renderTextChip(text: string, title?: string) {
  return (
    <span className={monitorClass.chipQuiet} title={title ?? text}>
      {text}
    </span>
  );
}

/**
 * The node/run status glyph — a shape channel that survives greyscale,
 * colour-blindness and a 4px-wide cell. Every glyph is decorative: the status
 * WORD sits beside it in the same row, so the glyph is `aria-hidden` and the
 * meaning never depends on it.
 */
function StateGlyph({
  state,
  size = 16,
}: {
  state: RoleboxRunState;
  size?: number;
}) {
  // Same 16 grid and stroke weight as the icon set, so a state mark and a
  // reading glyph never look like two different drawing styles.
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    "aria-hidden": "true",
  } as const;
  const stroke = {
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  if (state === "complete") {
    return (
      <svg {...common}>
        <path d="m3.5 8.4 3 3 6-7" {...stroke} />
      </svg>
    );
  }
  if (state === "failed") {
    return (
      <svg {...common}>
        <path d="m4.3 4.3 7.4 7.4M11.7 4.3 4.3 11.7" {...stroke} />
      </svg>
    );
  }
  if (state === "blocked") {
    return (
      <svg {...common}>
        <rect x="4" y="3.5" width="2.6" height="9" rx="1" fill="currentColor" />
        <rect x="9.4" y="3.5" width="2.6" height="9" rx="1" fill="currentColor" />
      </svg>
    );
  }
  if (state === "stopped") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="5.2" {...stroke} />
        <path d="M4.9 11.1 11.1 4.9" {...stroke} />
      </svg>
    );
  }
  if (state === "pending") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="4.6" {...stroke} />
      </svg>
    );
  }
  if (state === "running") {
    return (
      <svg {...common}>
        <path d="M5.4 3.6 12.2 8l-6.8 4.4z" fill="currentColor" />
      </svg>
    );
  }
  // idle / unknown — a neutral dash: the panel is not claiming a state.
  return (
    <svg {...common}>
      <path d="M4.4 8h7.2" {...stroke} />
    </svg>
  );
}


// ── Icon vocabulary ────────────────────────────────────────────────────────

/**
 * The console's glyph names. One closed set, one 16x16 grid, one stroke weight
 * (1.3) and one colour source (`currentColor`), so a lane of readings reads as
 * one instrument instead of a paragraph: the eye lands on the SHAPE and only
 * consults the value when the shape is the one it is looking for.
 *
 * The words did not disappear — every label still renders in the accessibility
 * tree (see {@link renderFact}) and every icon's meaning is repeated in its
 * row's `title` — but a dense column of "agent … status … retries … loop …
 * session" at 11px is noise, and noise is what the console cannot afford.
 */
export type RoleboxIcon =
  | "sessions"
  | "graphs"
  | "loops"
  | "metrics"
  | "agent"
  | "session"
  | "task"
  | "signal"
  | "retry"
  | "in"
  | "out"
  | "cost"
  | "clock"
  | "start"
  | "frontier"
  | "round"
  | "mode"
  | "send"
  | "branch"
  | "cancel";

/** Path data per icon, drawn as strokes on a 16x16 grid. */
const ICON_PATHS: Record<RoleboxIcon, string[]> = {
  sessions: [
    "M6 2.6a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z",
    "M1.8 14.2c0-2.6 1.9-4.4 4.2-4.4s4.2 1.8 4.2 4.4",
    "M11.8 5.2a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4Z",
    "M10.6 14.2c0-2 .9-3.4 2.4-3.8",
  ],
  graphs: [
    "M4.6 2.4a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8Z",
    "M11.6 8.8a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8Z",
    "M6.3 6.5 9.9 9.5",
    "M4.6 7.2v4h4.8",
  ],
  loops: [
    "M2 8a6 6 0 0 1 10-4.3",
    "M14 8a6 6 0 0 1-10 4.3",
    "M12.4 1.8v2.6h-2.6",
    "M3.6 14.2v-2.6h2.6",
  ],
  metrics: ["M3.2 13V9.4", "M6.4 13V5.6", "M9.6 13V7.6", "M12.8 13V3.4"],
  agent: [
    "M8 2.1a3.1 3.1 0 1 1 0 6.2 3.1 3.1 0 0 1 0-6.2Z",
    "M2.4 14.4c0-2.8 2.4-4.6 5.6-4.6s5.6 1.8 5.6 4.6",
  ],
  session: [
    "M2.4 2.8h11.2v10.4H2.4z",
    "M5.2 6.4 7.4 8.4 5.2 10.4",
    "M9 10.4h2.6",
  ],
  task: ["M2.6 5.4 4.4 7.2l3-3.4", "M2.6 11.8 4.4 13.6l3-3.4", "M9.6 6.4h4.2", "M9.6 12.8h4.2"],
  signal: ["M8.6 2.4 4 8.6h3.1L7 13.6l4.6-6.2H8.5z"],
  retry: ["M13.4 8a5.4 5.4 0 1 1-1.7-3.9", "M13.6 2.4v2.6h-2.6"],
  in: ["M8 2.6v6.6", "M5.2 6.4 8 9.2l2.8-2.8", "M3 13.2h10"],
  out: ["M8 9.2V2.6", "M5.2 5.4 8 2.6l2.8 2.8", "M3 13.2h10"],
  cost: [
    "M8 2.6a5.4 5.4 0 1 1 0 10.8A5.4 5.4 0 0 1 8 2.6Z",
    "M8 4.8v6.4",
    "M6.2 6.6h2.6a1.3 1.3 0 0 1 0 2.6H6.2",
  ],
  clock: ["M8 2.6a5.4 5.4 0 1 1 0 10.8A5.4 5.4 0 0 1 8 2.6Z", "M8 5v3.2l2.2 1.3"],
  start: ["M8 2.6a5.4 5.4 0 1 1 0 10.8A5.4 5.4 0 0 1 8 2.6Z", "M6.6 5.8 10.2 8l-3.6 2.2z"],
  frontier: ["M2 8h7.8", "M6.8 4.6 10.2 8 6.8 11.4", "M13 2.6v10.8"],
  round: ["M2.8 4.4A2 2 0 0 1 4.8 2.4h6.4a2 2 0 0 1 2 2v7.2a2 2 0 0 1-2 2H4.8a2 2 0 0 1-2-2z", "M6.6 6.6 8 5.6v4.8"],
  mode: ["M8 2.6 13.4 5.8 8 9 2.6 5.8z", "M3 8.8 8 11.8l5-3"],
  send: ["M13.4 2.6 7.2 13.4 5.7 8.7 2.6 7z"],
  branch: [
    "M4.8 1.8a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z",
    "M4.8 10.2a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z",
    "M12 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z",
    "M4.8 5.8v4.4",
    "M6.8 4.4c2.8.5 3.8 1.7 3.8 3.6",
  ],
  cancel: ["M8 2.6a5.4 5.4 0 1 1 0 10.8A5.4 5.4 0 0 1 8 2.6Z", "m6.2 6.2 3.6 3.6", "m9.8 6.2-3.6 3.6"],
};

/**
 * One icon. Decorative by contract: every icon sits beside either its value
 * (a fact row) or a word (a chip), so it is always `aria-hidden` and never the
 * only carrier of a meaning.
 */
function Icon({ name, size = 14 }: { name: RoleboxIcon; size?: number }) {
  return (
    <svg
      className={monitorClass.icon}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name].map((d) => (
        <path d={d} key={d} />
      ))}
    </svg>
  );
}

/**
 * Alert glyph — a 14x14 circled exclamation. State is never carried by colour
 * alone, so every error surface pairs its tint with this glyph and its text.
 * A local SVG: the dock's glyphs are deliberately not imported across modules.
 */
function AlertGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="5.6" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M7 4.1v4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="7" cy="10.3" r=".85" fill="currentColor" />
    </svg>
  );
}

/**
 * Question glyph — the band's NEUTRAL half. Rendered while the verdict admits
 * it could not classify every phase, so a check mark never reads "all good"
 * over an admission.
 */
function QuestionGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="5.6" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M5.5 5.5a1.6 1.6 0 1 1 2.3 1.5c-.6.3-.8.7-.8 1.3v.2"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
      <circle cx="7" cy="10.4" r=".8" fill="currentColor" />
    </svg>
  );
}

/** Check glyph — the calm half of the attention band's verdict. */
function CheckGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="m2.8 7.6 3.1 3.1 5.3-6.6"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * One reading: a glyph, an optional word, and the value.
 *
 * The `<dt>` always carries the label TEXT (visually hidden when the glyph
 * stands in for it) and the row's `title` repeats it, so the meaning survives
 * for a screen reader, for a hovering mouse, and for a reader who does not know
 * the icon yet — while the lane itself stays shapes and numbers.
 */
function renderFact(fact: MetaFact, key: string) {
  const described = fact.label + ": " + (fact.title ?? fact.value);
  return (
    <div className={monitorClass.fact} key={key} title={described}>
      {fact.state !== undefined && (
        <span className={monitorClass.factIcon} aria-hidden="true">
          <StateGlyph state={fact.state} />
        </span>
      )}
      {fact.state === undefined && fact.icon !== undefined && (
        <span className={monitorClass.factIcon} aria-hidden="true">
          <Icon name={fact.icon} />
        </span>
      )}
      <dt className={fact.word === undefined ? monitorClass.srOnly : monitorClass.factWord}>
        {fact.word ?? fact.label}
      </dt>
      <dd className={monitorClass.factValue}>{fact.value}</dd>
    </div>
  );
}

/** The facts that survived their absent-value guards, or null when none did. */
function renderFacts(facts: Array<MetaFact | null>, className: string) {
  const present = facts.filter((fact): fact is MetaFact => fact !== null);
  if (present.length === 0) return null;
  return (
    <dl className={className}>
      {present.map((fact, index) => renderFact(fact, fact.label + index))}
    </dl>
  );
}

/**
 * The "Show all N" / "Show fewer" disclosure for a capped ledger, rendered only
 * when the list exceeds its cap. Reference data is demoted, not hidden: the
 * full set stays one click away.
 */
function renderOverflowToggle(
  group: string,
  total: number,
  limit: number,
  expanded: boolean,
  onToggle: (group: string) => void,
  label: string,
) {
  if (total <= limit) return null;
  return (
    <button
      type="button"
      className={monitorClass.more}
      aria-expanded={expanded}
      aria-controls={group}
      onClick={() => onToggle(group)}
    >
      {expanded ? "Show fewer" : "Show all " + total + " " + label}
    </button>
  );
}

// ── Sections ───────────────────────────────────────────────────────────────

/**
 * The verdict band: the panel's only focal point, and the first thing read.
 *
 * Two parts, both derived from the payload: the VERDICT word (with its glyph)
 * and the FACTS behind it, rendered as labelled count fields. Anything that
 * actually needs the developer is then named — a row per failed or blocked
 * unit — because "2 need attention" without saying which two is an alarm, not
 * an answer. A calm band carries no invented reassurance: with nothing
 * reporting at all it says so rather than claiming success.
 */
function renderAttentionBand(attention: MonitorAttention) {
  const alert = attention.needsAttention;
  const unreadable = !alert && attention.unknown.length > 0;
  // "All clear" is earned by work that is actually progressing or finished.
  // Units that merely exist — stopped, idle, or none at all — get the plain
  // reading instead, so the headline never contradicts a row drawn beneath it.
  const working =
    attention.running > 0 || attention.pending > 0 || attention.complete > 0;
  const title = alert
    ? "Needs attention"
    : unreadable
      ? "Partly unreadable"
      : working
        ? "All clear"
        : "Nothing running";

  // The verdict's evidence, drawn in the SAME vocabulary as the strip and the
  // node rows: the shape that stands for a state is the shape you count.
  const facts: Array<MetaFact | null> = [
    attention.failed.length > 0
      ? { label: "failed", value: formatCount(attention.failed.length), state: "failed" }
      : null,
    attention.blocked.length > 0
      ? { label: "blocked", value: formatCount(attention.blocked.length), state: "blocked" }
      : null,
    attention.running > 0
      ? { label: "running", value: formatCount(attention.running), state: "running" }
      : null,
    attention.pending > 0
      ? { label: "queued", value: formatCount(attention.pending), state: "pending" }
      : null,
    attention.complete > 0
      ? { label: "done", value: formatCount(attention.complete), state: "complete" }
      : null,
    attention.stopped > 0
      ? { label: "stopped", value: formatCount(attention.stopped), state: "stopped" }
      : null,
    attention.idle > 0
      ? { label: "idle", value: formatCount(attention.idle), state: "idle" }
      : null,
    attention.unknown.length > 0
      ? {
          label: "unreadable",
          value: formatCount(attention.unknown.length),
          state: "unknown",
        }
      : null,
  ];

  const named = [
    ...attention.failed.map((label) => ({ label, state: "failed" as const })),
    ...attention.blocked.map((label) => ({ label, state: "blocked" as const })),
    ...attention.unknown.map((label) => ({ label, state: "unknown" as const })),
  ];

  return (
    <section
      className={
        monitorClass.attention +
        " " +
        (alert ? monitorClass.attentionAlert : monitorClass.attentionCalm)
      }
      aria-labelledby="rolebox-monitor-attention-title"
    >
      <div className={monitorClass.attentionHead}>
        <span className={monitorClass.attentionGlyph} aria-hidden="true">
          {alert ? <AlertGlyph /> : unreadable ? <QuestionGlyph /> : <CheckGlyph />}
        </span>
        <span
          id="rolebox-monitor-attention-title"
          className={monitorClass.attentionTitle}
        >
          {title}
        </span>
      </div>
      {renderFacts(facts, monitorClass.attentionFacts)}
      {named.length > 0 && (
        <ul className={monitorClass.attentionList}>
          {named.map((item) => (
            <li className={monitorClass.attentionItem} key={item.state + item.label}>
              <span className={monitorClass.attentionItemState}>
                {RUN_STATE_LABEL[item.state]}
              </span>
              <span
                className={monitorClass.attentionItemLabel}
                title={item.label}
              >
                {item.label.startsWith("session-") ? shortId(item.label) : item.label}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One graph as a ledger block: identity + state, the node strip, the run's
 * readings, then the node ledger and loop groups.
 *
 * The strip carries EXACTLY one cell per node in the graph's own declaration
 * order — no normalised sampling, so a three-node graph shows three cells and a
 * thirty-node graph shows thirty. Each cell keeps its own `title`, and the
 * counts are restated as text in the readings below, so the strip is a
 * position-preserving overview rather than the only channel.
 */
function renderGraphBlock(
  graph: MonitorEngineGraphDto,
  now: number,
  isExpanded: (group: string) => boolean,
  toggleGroup: (group: string) => void,
) {
  const nodes = extractNodes(graph);
  const counts = Object.entries(graph.nodeStatusCounts ?? {}).filter(
    ([, value]) => typeof value === "number" && value > 0,
  );
  const budget = graph.budget ?? {};
  const loopGroups = Array.isArray(graph.loopGroups)
    ? (graph.loopGroups.filter(isRecord) as MonitorLoopGroupDto[])
    : [];
  const state = classifyRunPhase(graph.phase);

  // Live work first: a developer opens this panel to see the hot node, so the
  // ledger is ordered by what is happening now (running, blocked, failed,
  // queued) and only then by declaration order for finished work.
  const priority = (node: MonitorGraphNodeDto): number => {
    const s = classifyNodeStatus(node.status);
    if (s === "running") return 0;
    if (s === "blocked") return 1;
    if (s === "failed") return 2;
    if (s === "pending") return 3;
    if (s === "stopped") return 4;
    return 5;
  };
  const ordered = nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => {
      const delta = priority(a.node) - priority(b.node);
      return delta !== 0 ? delta : a.index - b.index;
    })
    .map((entry) => entry.node);

  const totalNodes = asNumber(graph.nodeCount) ?? nodes.length;
  // A graph id is arbitrary text (model- or user-supplied), so it is reduced to
  // a DOM-id-safe token before it names the ledger's list/label pair.
  const group = "rolebox-monitor-nodes-" + domIdPart(graph.graphId ?? "graph");
  const expanded = isExpanded(group);
  const visible = expanded ? ordered : ordered.slice(0, NODE_ROW_LIMIT);

  const rawUpdatedMs = asNumber(graph.updatedAtMs);
  const updatedMs =
    rawUpdatedMs !== undefined && rawUpdatedMs > 0
      ? rawUpdatedMs
      : parseIsoMs(graph.updatedAt);
  const quietMs = updatedMs === undefined ? undefined : now - updatedMs;
  const quiet = quietMs !== undefined && quietMs > GRAPH_QUIET_MS && graph.phase !== "complete";

  // The strip's legend: the SAME shapes the strip draws, counted. The word is
  // only rendered for a status the shape vocabulary does not already cover.
  const statusFacts: Array<MetaFact | null> = counts.map(([name, value]) => {
    const nodeState = classifyNodeStatus(name);
    return {
      label: name,
      value: formatCount(value as number),
      state: nodeState,
    };
  });

  return (
    <div className={monitorClass.graph} key={graph.graphId ?? "graph"}>
      <div className={monitorClass.graphHead}>
        <span className={monitorClass.graphId} title={graph.graphId}>
          {graph.graphId ?? "unnamed graph"}
        </span>
        <span className={monitorClass.graphState}>
          <span className={monitorClass.raw} title={graph.phase ?? "unknown"}>
            {graph.phase ?? "unknown"}
          </span>
          {renderChip(state)}
        </span>
      </div>

      {graph.graph?.current && (
        <details>
          <summary>Attempts, results, approvals and budget</summary>
          <pre>{JSON.stringify(graph.graph.runs, null, 2)}</pre>
        </details>
      )}
      {nodes.length > 0 && (
        <div className={monitorClass.strip} aria-hidden="true">
          {nodes.map((node, index) => (
            <span
              className={
                monitorClass.stripCell +
                " " +
                stripCellModifier(classifyNodeStatus(node.status))
              }
              key={(node.nodeId ?? "node") + index}
              title={(node.nodeId ?? "node") + " — " + (node.status ?? "unknown")}
            />
          ))}
        </div>
      )}

      {renderFacts(
        [
          // The strip's legend: one field per node status, in the same order
          // the engine reports them. The total lives on the ledger heading
          // below, so it is not repeated here.
          ...statusFacts,
          optionalFact("frontier", graph.frontier?.length, formatCount, formatCount, "frontier"),
          optionalFact("sessions", budget.sessionsSpawned, formatCount, formatCount, "sessions"),
          optionalFact("tokens in", budget.totalInputTokens, compactTokens, formatCount, "in"),
          optionalFact("tokens out", budget.totalOutputTokens, compactTokens, formatCount, "out"),
          optionalFact("cost", budget.totalCost, formatCost, costTitle, "cost"),
          graph.startedAt && parseIsoMs(graph.startedAt) !== undefined
            ? {
                label: "started",
                value: formatRelativeTime(parseIsoMs(graph.startedAt) ?? 0, now),
                title: graph.startedAt,
                icon: "start" as const,
              }
            : null,
          updatedMs !== undefined
            ? {
                label: "updated",
                value: formatRelativeTime(updatedMs, now),
                title: graph.updatedAt ?? "",
                icon: "clock" as const,
              }
            : null,
        ],
        monitorClass.facts,
      )}

      {quiet && (
        <p className={monitorClass.note}>
          No state updates for {formatDuration(quietMs ?? 0)}.
        </p>
      )}

      {loopGroups.length > 0 &&
        renderFacts(
          loopGroups.map((group) => ({
            label: "loop group",
            value:
              (group.id ?? "?") +
              " " +
              count(group.traversalCount) +
              "/" +
              count(group.maxTraversals),
            title: group.id ?? "unnamed loop group",
            icon: "loops" as const,
          })),
          monitorClass.facts,
        )}

      {totalNodes > 0 && (
        <div className={monitorClass.nodeGroup}>
          <h4 className={monitorClass.subTitle} id={group + "-title"}>
            <span className={monitorClass.sectionIcon} aria-hidden="true">
              <Icon name="graphs" size={14} />
            </span>
            Nodes
            <span className={monitorClass.subCount}>{count(totalNodes)}</span>
          </h4>
          {ordered.length > 0 && (
            <ul className={monitorClass.nodeList} id={group} aria-labelledby={group + "-title"}>
              {visible.map((node, index) => renderNodeRow(node, now, index))}
            </ul>
          )}
          {renderOverflowToggle(
            group,
            ordered.length,
            NODE_ROW_LIMIT,
            expanded,
            toggleGroup,
            "nodes",
          )}
          {totalNodes > ordered.length && (
            // The snapshot's own node total can exceed the per-node records it
            // carries; the ledger says so rather than looking complete.
            <p className={monitorClass.note}>
              {formatCount(totalNodes - ordered.length)} more node
              {totalNodes - ordered.length === 1 ? "" : "s"} not reported.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The state's own token, for the two places that tint a shape rather than fill
 * a cell (a node glyph, a loop glyph).
 */
function stateToken(state: RoleboxRunState): string {
  if (state === "failed") return monitorClass.toneFailed;
  if (state === "blocked") return monitorClass.toneBlocked;
  if (state === "stopped") return monitorClass.toneStopped;
  if (state === "running") return monitorClass.toneRunning;
  return monitorClass.toneCalm;
}

/** Strip-cell modifier class for a node state. */
function stripCellModifier(state: RoleboxRunState): string {
  if (state === "failed") return monitorClass.stripFailed;
  if (state === "blocked") return monitorClass.stripBlocked;
  if (state === "stopped") return monitorClass.stripStopped;
  if (state === "pending") return monitorClass.stripPending;
  if (state === "complete") return monitorClass.stripComplete;
  if (state === "running") return monitorClass.stripRunning;
  return monitorClass.stripUnknown;
}

/**
 * One node row: the node's IDENTITY and its state on the first line, the facts
 * about it on the second.
 *
 * The state is a SHAPE plus a colour (with the raw status word in the row's
 * `title`), because the graph head already carries the worded chip and because
 * "status running" spelling out what a play triangle already says is exactly
 * the text wall this console was rebuilt to remove. The first line is a grid,
 * so ids align down the column however long they are.
 */
function renderNodeRow(node: MonitorGraphNodeDto, now: number, index: number) {
  const state = classifyNodeStatus(node.status);
  const startedMs = parseIsoMs(node.startedAt);
  const completedMs = parseIsoMs(node.completedAt);
  const spent =
    startedMs !== undefined && completedMs !== undefined
      ? completedMs - startedMs
      : elapsedMs(startedMs, now);

  const facts: Array<MetaFact | null> = [
    node.agent ? { label: "agent", value: node.agent, title: node.agent, icon: "agent" } : null,
    node.signalType
      ? { label: "signal", value: node.signalType, title: node.signalType, icon: "signal" }
      : null,
    node.retryCount !== undefined && node.retryCount > 0
      ? { label: "retries", value: formatCount(node.retryCount), icon: "retry" }
      : null,
    // The reason a node died is the one reading a failing row must not lose;
    // the label renders as a word (no dedicated glyph).
    node.errorReason
      ? { label: "error", value: node.errorReason, title: node.errorReason }
      : null,
    node.loopGroupId
      ? { label: "loop", value: node.loopGroupId, title: node.loopGroupId, icon: "loops" }
      : null,
    node.dispatchSessionId
      ? {
          label: "session",
          value: shortId(node.dispatchSessionId),
          title: node.dispatchSessionId,
          icon: "session",
        }
      : null,
    node.dispatchTaskId
      ? {
          label: "task",
          value: shortId(node.dispatchTaskId),
          title: node.dispatchTaskId,
          icon: "task",
        }
      : null,
  ];

  return (
    <li
      className={monitorClass.nodeRow}
      key={(node.nodeId ?? "node") + index}
      title={(node.nodeId ?? "unnamed node") + " — " + (node.status ?? "unknown")}
    >
      <div className={monitorClass.nodeHead}>
        <span className={monitorClass.nodeGlyph + " " + stateToken(state)}>
          <StateGlyph state={state} />
        </span>
        <span className={monitorClass.nodeId} title={node.nodeId}>
          {node.nodeId ?? "unnamed node"}
        </span>
        <span className={monitorClass.nodeTime}>{duration(spent)}</span>
      </div>
      {renderFacts(facts, monitorClass.nodeFacts)}
    </li>
  );
}

/**
 * The round progress bar: one cell per requested round, filled up to the round
 * in flight, with the reading beside it.
 *
 * The bar answers "how far through is this?" — a question a "3/5" string makes
 * the reader do arithmetic to answer, and the reason loop rows get a graphic of
 * their own. Cells are capped at {@link ROUND_CELL_LIMIT}: past that the bar
 * reports the ratio it was given and the text carries the exact numbers, rather
 * than pretending to be pixel-accurate.
 */
function renderRoundProgress(current: number | undefined, total: number | undefined) {
  if (current === undefined || total === undefined || total <= 0) return null;
  const cells = Math.min(total, ROUND_CELL_LIMIT);
  const filled = Math.max(0, Math.min(cells, Math.round((current / total) * cells)));
  return (
    <span
      className={monitorClass.progress}
      title={formatCount(current) + " of " + formatCount(total) + " rounds"}
    >
      {Array.from({ length: cells }, (_, index) => (
        <span
          className={
            index < filled
              ? monitorClass.progressCell + " " + monitorClass.progressOn
              : monitorClass.progressCell
          }
          key={index}
        />
      ))}
      <span className={monitorClass.progressText}>
        {formatCount(current)}/{formatCount(total)}
      </span>
    </span>
  );
}

/**
 * One loop row. Loops are the rolebox primitive developers drive directly, so
 * this row answers the four questions a loop raises — which round, how far
 * through, in which mode, and (on failure) why — plus the worker session that
 * round is running in.
 */
function renderLoopRow(loop: MonitorLoopDto, now: number) {
  const state = classifyRunPhase(loop.phase);
  const current = asNumber(loop.current);
  const total = asNumber(loop.total);
  const round =
    current === undefined || total === undefined
      ? "—"
      : formatCount(current) + "/" + formatCount(total);

  const facts: Array<MetaFact | null> = [
    { label: "round", value: round, icon: "round" },
    elapsedMs(loop.roundStartedAt, now) !== undefined
      ? {
          label: "round time",
          value: duration(elapsedMs(loop.roundStartedAt, now)),
          icon: "clock",
        }
      : null,
    elapsedMs(loop.startedAt, now) !== undefined
      ? { label: "elapsed", value: duration(elapsedMs(loop.startedAt, now)), icon: "clock" }
      : null,
    loop.mode ? { label: "mode", value: loop.mode, title: loop.mode, icon: "mode" } : null,
    loop.roundCount !== undefined
      ? { label: "dispatched", value: formatCount(loop.roundCount), icon: "send" }
      : null,
    loop.agent ? { label: "agent", value: loop.agent, title: loop.agent, icon: "agent" } : null,
    loop.activeWorkerSessionId
      ? {
          label: "worker",
          value: shortId(loop.activeWorkerSessionId),
          title: loop.activeWorkerSessionId,
          icon: "session",
        }
      : null,
    loop.parentLoopId
      ? {
          label: "parent loop",
          value: shortId(loop.parentLoopId),
          title: loop.parentLoopId,
          icon: "branch",
        }
      : null,
    loop.activeWorkerTaskId
      ? {
          label: "task",
          value: shortId(loop.activeWorkerTaskId),
          title: loop.activeWorkerTaskId,
          icon: "task",
        }
      : null,
    loop.cancelRequested
      ? { label: "cancelling", value: "requested", icon: "cancel" }
      : null,
  ];

  return (
    <div className={monitorClass.loop} key={loop.originSessionId ?? "loop"}>
      <div className={monitorClass.loopHead}>
        <span className={monitorClass.loopGlyph + " " + stateToken(state)}>
          <StateGlyph state={state} />
        </span>
        <span className={monitorClass.loopId} title={loop.originSessionId}>
          {shortId(loop.originSessionId)}
        </span>
        {renderChip(state)}
      </div>
      <div className={monitorClass.loopBar}>
        {renderRoundProgress(current, total)}
        <span className={monitorClass.raw} title={loop.phase ?? "unknown"}>
          {loop.phase ?? "unknown"}
        </span>
      </div>
      {renderFacts(facts, monitorClass.facts)}
      {loop.errorReason && (
        <p className={monitorClass.error}>
          <span className={monitorClass.errorGlyph} aria-hidden="true">
            <AlertGlyph size={16} />
          </span>
          <span className={monitorClass.errorText} title={loop.errorReason}>
            {loop.errorReason}
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * A section heading: the glyph that anchors the section, its name, its count,
 * and an optional note. Every section wears the same head, which is what makes
 * a narrow column scannable — a reader finds "the one with the bar-chart glyph"
 * without reading a word.
 */
function renderSectionTitle(
  id: string,
  icon: RoleboxIcon,
  title: string,
  count: string,
  note?: string,
) {
  return (
    <h3 id={id} className={monitorClass.sectionTitle}>
      <span className={monitorClass.sectionIcon} aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      {title}
      <span className={monitorClass.sectionCount}>{count}</span>
      {note !== undefined && <span className={monitorClass.sectionNote}>{note}</span>}
    </h3>
  );
}

/**
 * One metric name, its label chips, and its reading — in the panel's shared
 * chip language, so a metric's labels and a session's role are the same kind of
 * thing to look at.
 */
function renderMetricRow(
  name: string,
  labels: Record<string, string>,
  value: string,
  title: string,
) {
  return (
    <div className={monitorClass.metricRow} key={name}>
      <span className={monitorClass.metricName} title={name}>
        {name}
      </span>
      {Object.entries(labels).map(([label, labelValue]) => (
        <span className={monitorClass.chipQuiet} key={label}>
          {label}={labelValue}
        </span>
      ))}
      <span className={monitorClass.metricValue} title={title}>
        {value}
      </span>
    </div>
  );
}

/**
 * The latency distribution as a strip: one cell per non-empty bucket, its
 * WIDTH proportional to how many observations landed at or below that
 * boundary, so the shape of the tail is visible without arithmetic.
 *
 * Widths are geometry that comes from the data, not from a design token, so
 * this is the one place the module sets an inline length. The cumulative
 * buckets are differenced back into per-bucket counts first — drawing the
 * cumulative counts would render a monotone wedge and say nothing.
 */
function renderDistribution(buckets: Record<string, number>, samples: number) {
  if (samples <= 0) return null;
  const ordered = Object.entries(buckets)
    .map(([boundary, observed]) => [Number(boundary), observed] as const)
    .filter(([boundary, observed]) => Number.isFinite(boundary) && observed > 0)
    .sort((a, b) => a[0] - b[0]);
  if (ordered.length === 0) return null;

  let previous = 0;
  const perBucket = ordered.map(([boundary, cumulative]) => {
    const slice = Math.max(0, cumulative - previous);
    previous = cumulative;
    return { boundary, slice };
  });
  const peak = perBucket.reduce((max, bucket) => Math.max(max, bucket.slice), 0);
  if (peak <= 0) return null;

  const first = ordered[0]![0];
  const last = ordered[ordered.length - 1]![0];
  return (
    <span
      className={monitorClass.chart}
      aria-hidden="true"
      title={formatCount(samples) + " samples, ≤" + duration(last)}
    >
      <span className={monitorClass.chartBars}>
        {perBucket.map((bucket) => (
          <span
            className={monitorClass.chartBar}
            key={bucket.boundary}
            style={{ flexGrow: bucket.slice }}
          />
        ))}
      </span>
      <span className={monitorClass.chartAxis}>
        {"≤" + duration(first) + " … ≤" + duration(last)}
      </span>
    </span>
  );
}

/**
 * One histogram: the distribution's SHAPE, then its readings as the panel's
 * usual glyph lanes — the average as the headline value, and p50/p95/samples
 * as facts beneath it.
 */
function renderHistogramRow(name: string, histogram: MonitorHistogramDto) {
  const parsed = parseMetricKey(name);
  const buckets = isRecord(histogram.buckets)
    ? (histogram.buckets as Record<string, number>)
    : {};
  const samples = asNumber(histogram.count) ?? 0;
  const sum = asNumber(histogram.sum) ?? 0;
  const avg = samples > 0 ? Math.round(sum / samples) : undefined;
  const p50 = histogramPercentile(buckets, samples, 0.5);
  const p95 = histogramPercentile(buckets, samples, 0.95);

  return (
    <div className={monitorClass.metricRow} key={name}>
      <span className={monitorClass.metricName} title={name}>
        {parsed.name}
      </span>
      {Object.entries(parsed.labels).map(([label, labelValue]) => (
        <span className={monitorClass.chipQuiet} key={label}>
          {label}={labelValue}
        </span>
      ))}
      <span className={monitorClass.metricValue}>
        {samples > 0 ? formatDuration(avg ?? 0) : "no samples"}
      </span>
      {samples > 0 && (
        <div className={monitorClass.metricExtra}>
          {renderDistribution(buckets, samples)}
          {renderFacts(
            [
              p50 !== undefined
                ? { label: "p50", value: duration(p50), icon: "clock" as const }
                : null,
              p95 !== undefined
                ? { label: "p95", value: duration(p95), icon: "clock" as const }
                : null,
              { label: "samples", value: formatCount(samples), icon: "metrics" as const },
            ],
            monitorClass.facts,
          )}
        </div>
      )}
    </div>
  );
}

/** One metric group (counters / gauges / histograms) with its overflow cap. */
function renderMetricGroup(
  title: string,
  icon: RoleboxIcon,
  group: string,
  size: number,
  isExpanded: (group: string) => boolean,
  toggleGroup: (group: string) => void,
  rows: unknown[],
) {
  if (size === 0) return null;
  const expanded = isExpanded(group);
  return (
    <div className={monitorClass.metricGroup}>
      <h4 className={monitorClass.subTitle} id={group + "-title"}>
        <span className={monitorClass.sectionIcon} aria-hidden="true">
          <Icon name={icon} size={14} />
        </span>
        {title}
        <span className={monitorClass.subCount}>{formatCount(size)}</span>
      </h4>
      <div className={monitorClass.metricList} id={group} aria-labelledby={group + "-title"}>
        {rows.slice(0, expanded ? size : GROUP_ROW_LIMIT)}
      </div>
      {renderOverflowToggle(group, size, GROUP_ROW_LIMIT, expanded, toggleGroup, "readings")}
    </div>
  );
}

/** The session roster: who is running what, this session first. */
function renderSessionSection(
  rows: SessionRow[],
  census: number,
  isExpanded: (group: string) => boolean,
  toggleGroup: (group: string) => void,
) {
  // The heading never claims fewer sessions than the roster lists.
  const declaredCount = Math.max(census, rows.length);
  const group = "rolebox-monitor-sessions";
  const expanded = isExpanded(group);
  const visible = expanded ? rows : rows.slice(0, SESSION_ROW_LIMIT);
  const roles = new Set(
    rows.map((row) => row.role).filter((role): role is string => typeof role === "string"),
  );
  // The census can exceed the roster when the backend counts sessions it does
  // not report identities for; the roster then says so instead of pretending
  // the list is complete.
  const unreported = Math.max(0, census - rows.length);

  return (
    <section
      className={monitorClass.section}
      aria-labelledby="rolebox-monitor-sessions-title"
    >
      {renderSectionTitle(
        "rolebox-monitor-sessions-title",
        "sessions",
        "Sessions",
        formatCount(declaredCount),
        roles.size > 0
          ? formatCount(roles.size) + " active " + (roles.size === 1 ? "role" : "roles")
          : undefined,
      )}
      {rows.length === 0 ? (
        <p className={monitorClass.state}>No sessions reported.</p>
      ) : (
        <ul className={monitorClass.sessionList} id={group}>
          {visible.map((row) => (
            <li
              className={
                row.current
                  ? monitorClass.sessionRow + " " + monitorClass.sessionRowCurrent
                  : monitorClass.sessionRow
              }
              key={row.id}
            >
              <span
                className={
                  monitorClass.sessionGlyph +
                  " " +
                  (row.current ? monitorClass.toneRunning : monitorClass.toneCalm)
                }
              >
                <Icon name={row.current ? "session" : "sessions"} size={14} />
              </span>
              <span className={monitorClass.sessionId} title={row.id}>
                {shortId(row.id)}
              </span>
              {renderTextChip(
                row.role ?? "base",
                row.role ?? "base agent (no role switched)",
              )}
              {row.current && (
                <span className={monitorClass.sessionMarker}>this session</span>
              )}
              {!row.current && row.mostRecent && (
                <span className={monitorClass.sessionMarker}>latest</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {unreported > 0 && (
        <p className={monitorClass.note}>
          {formatCount(unreported)} more session{unreported === 1 ? "" : "s"} not
          reported by name.
        </p>
      )}
      {renderOverflowToggle(
        group,
        rows.length,
        SESSION_ROW_LIMIT,
        expanded,
        toggleGroup,
        "sessions",
      )}
    </section>
  );
}

// ── The panel ──────────────────────────────────────────────────────────────

/**
 * The run console: fetches `GET /rolebox/status` and `GET /rolebox/metrics`
 * on mount (and on every manual refresh), then renders the verdict, the session
 * roster, one ledger block per engine graph, one row per loop, and the metric
 * readings — with loading / error / empty states that say what is missing and
 * why. It never polls: the freshness stamp is the snapshot's own time, and
 * every duration in the body is relative to that moment, so nothing on screen
 * silently ages.
 *
 * @param props - docked tab-body props (see {@link RoleboxMonitorPanelProps}).
 */
export function RoleboxMonitorPanel(props: RoleboxMonitorPanelProps) {
  const [statusBody, setStatusBody] = useState<MonitorStatusBody | null>(null);
  const [metricsBody, setMetricsBody] = useState<MonitorMetricsBody | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<PanelStatus>({
    text: "Loading monitoring data…",
    error: false,
  });
  /** Moment the current snapshot landed — the reference for every age. */
  const [loadedAt, setLoadedAt] = useState(0);
  /**
   * Manual-refresh trigger. The load effect depends on it: bumping the token
   * re-runs the effect (with cleanup of the previous in-flight fetch).
   */
  const [refreshToken, setRefreshToken] = useState(0);
  /**
   * Groups the user has expanded past their cap. Reference data starts
   * collapsed; a new array is always written so the state comparison sees a
   * change.
   */
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
  /**
   * Why the metrics seat is not on screen, or null when it loaded.
   *
   * Kept as a message rather than a flag: the metrics endpoint is env-gated and
   * optional, so when it fails the console must say WHICH thing failed instead
   * of quietly dropping a section.
   */
  const [metricsError, setMetricsError] = useState<string | null>(null);
  /**
   * How updates are arriving. `connecting` until the channel answers, `live`
   * once it does, `manual` when the platform has no EventSource or the channel
   * never opened — in which case the console behaves exactly as it did before
   * the channel existed.
   */
  const [live, setLive] = useState<PanelLive>("connecting");
  /**
   * The local clock. Every age on screen ("12s ago", "8m") is measured against
   * THIS, not against the moment the snapshot landed, so a run that is still
   * going counts up while you watch it instead of freezing at its last fetch.
   */
  const [now, setNow] = useState(() => Date.now());
  /** When the snapshot last landed, for the refetch floor (a ref, not state). */
  const lastLoadRef = useRef(0);

  // The local clock. A single interval, no request: the panel never polls.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  /**
   * The change-signal channel.
   *
   * One `EventSource` per mounted console. A `changed` frame schedules a
   * refetch at most once per {@link SIGNAL_REFETCH_MS}; a platform without
   * `EventSource`, a channel that errors, or a host that predates the endpoint
   * all degrade to `manual` — the console's original behaviour.
   *
   * The subscription itself never restarts: reconnection is the browser's job,
   * and the load effect is what the frame drives.
   */
  useEffect(() => {
    if (typeof EventSource === "undefined") {
      setLive("manual");
      return;
    }
    const source = new EventSource(EVENTS_ENDPOINT);
    let timer: ReturnType<typeof setTimeout> | null = null;
    source.onopen = () => setLive("live");
    source.onerror = () => setLive("manual");
    source.onmessage = (event: MessageEvent) => {
      const frame = parseEventFrame(event.data);
      if (frame === null || frame.type !== "changed") return;
      if (timer !== null) return;
      const wait = Math.max(0, SIGNAL_REFETCH_MS - (Date.now() - lastLoadRef.current));
      timer = setTimeout(() => {
        timer = null;
        setRefreshToken((count) => count + 1);
      }, wait);
    };
    return () => {
      if (timer !== null) clearTimeout(timer);
      source.close();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Distinguish the first load from a refresh: the skeleton only substitutes
    // for content that has never rendered, and the seat names which one is
    // happening.
    const isInitialLoad = statusBody === null;
    setLoading(true);
    setStatus({
      text: isInitialLoad ? "Loading monitoring data…" : "Refreshing…",
      error: false,
    });

    /** One seat's read, settled on its own so neither seat can fail the other. */
    async function readSeat(
      endpoint: string,
    ): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
      try {
        const response = await fetch(endpoint, seatRequestInit());
        if (!response.ok) return { ok: false, error: "HTTP " + response.status };
        const body = (await response.json().catch(() => null)) as unknown;
        // A 2xx whose body is not an object is a broken contract, not an empty
        // reading: reporting it as "nothing is running" would under-report.
        if (!isRecord(body)) {
          return { ok: false, error: "unexpected response body" };
        }
        return { ok: true, body };
      } catch (err) {
        return { ok: false, error: toMessage(err) };
      }
    }

    async function load(): Promise<void> {
      try {
        // The two endpoints are INDEPENDENT surfaces — metrics are env-gated and
        // optional, status is the page — so they settle separately: a metrics
        // hiccup must not blank a console whose status seat answered.
        const [statusSeat, metricsSeat] = await Promise.all([
          readSeat(STATUS_ENDPOINT),
          readSeat(METRICS_ENDPOINT),
        ]);
        if (cancelled) return;
        const now = Date.now();

        if (metricsSeat.ok) {
          setMetricsBody(metricsSeat.body as MonitorMetricsBody);
          setMetricsError(null);
        } else {
          // Whatever metrics already on screen stay; the seat reports why.
          setMetricsError(metricsSeat.error);
        }

        if (!statusSeat.ok) {
          setStatus({
            text: "Failed to load monitoring data: " + statusSeat.error,
            error: true,
          });
          return;
        }

        const nextStatus = statusSeat.body as MonitorStatusBody;
        setStatusBody(nextStatus);
        setLoadedAt(now);
        lastLoadRef.current = now;
        // The seat is the live region, and it carries the VERDICT alone. The
        // freshness stamp deliberately lives OUTSIDE it: with updates arriving
        // on their own, a timestamp inside the region would re-announce itself
        // every few seconds and bury the one sentence that matters.
        const verdict = deriveAttention(
          extractGraphs(nextStatus),
          extractLoops(nextStatus),
        );
        setStatus({
          text:
            (verdict.needsAttention
              ? attentionPhrase(verdict.failed.length + verdict.blocked.length)
              : verdict.unknown.length > 0
                ? verdict.unknown.length +
                  (verdict.unknown.length === 1 ? " state" : " states") +
                  " unreadable"
                : // A calm refresh says WHAT it saw, not merely that it looked:
                  // a stopped or idle unit is a reading.
                  describeAttention(verdict)) +
            (metricsSeat.ok ? "" : " · metrics unavailable"),
          error: false,
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  // Defensive normalization — each seat guards its payload, so a partial
  // backend renders the sections it has.
  const loops = extractLoops(statusBody);
  const graphs = extractGraphs(statusBody);
  const sessions = extractSessions(statusBody);
  const counters = extractMetrics(metricsBody, "counters");
  const gauges = extractMetrics(metricsBody, "gauges");
  const histograms = extractHistograms(metricsBody);
  const sessionRows = buildSessionRows(sessions, props.sessionId);
  const metricCount = counters.length + gauges.length + histograms.length;
  /**
   * Sessions the PAYLOAD names.
   *
   * Deliberately not `sessionRows.length`: the roster always carries the
   * session this panel is docked beside (the framework hands the body that id),
   * so counting its rows would make "nothing is reporting" and "the load
   * failed" unreachable for every real session — the failed state's Retry
   * control included. A response with no session census is empty data.
   */
  const census = Math.max(
    asNumber(sessions.count) ?? 0,
    Object.keys(sessions.activeRoles ?? {}).length,
    Array.isArray(sessions.recentIds) ? sessions.recentIds.length : 0,
    typeof sessions.mostRecentId === "string" ? 1 : 0,
  );
  const hasData =
    graphs.length > 0 || loops.length > 0 || metricCount > 0 || census > 0;

  const attention = deriveAttention(graphs, loops);

  const isExpanded = (group: string): boolean => expandedGroups.includes(group);
  const toggleGroup = (group: string): void => {
    setExpandedGroups((previous) =>
      previous.includes(group)
        ? previous.filter((key) => key !== group)
        : [...previous, group],
    );
  };

  const refresh = (): void => setRefreshToken((count) => count + 1);

  // Body posture: a full loading state only while nothing has rendered yet; the
  // full error state only when there is nothing to fall back on; the data body
  // (with a retry row when the last status read failed) whenever there is data
  // to show, and the empty state when there is not. The RETRY control travels
  // with the message in both error cases — a failed read always has a way back,
  // whether or not the other seat answered.
  let body: unknown;
  if (loading && statusBody === null && metricsBody === null) {
    // The header seat is the panel's ONE live region and already announces the
    // load, so the skeleton stays purely decorative: a second live region with
    // the same sentence would have every screen reader say it twice.
    body = (
      <div className={monitorClass.loading}>
        <div className={monitorClass.skeleton} aria-hidden="true">
          {[0, 1].map((section) => (
            <div className={monitorClass.skeletonCard} key={section}>
              <span className={monitorClass.skeletonBarWide} />
              {[0, 1, 2].map((row) => (
                <div className={monitorClass.skeletonRow} key={row}>
                  <span className={monitorClass.skeletonIcon} />
                  <span className={monitorClass.skeletonBar} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  } else if (status.error && !hasData) {
    body = (
      <div
        className={monitorClass.state + " " + monitorClass.stateError}
        role="alert"
      >
        <span className={monitorClass.errorGlyph} aria-hidden="true">
          <AlertGlyph size={16} />
        </span>
        <span className={monitorClass.errorText}>{status.text}</span>
        <button type="button" className={monitorClass.retry} onClick={refresh}>
          Retry
        </button>
      </div>
    );
  } else if (!hasData) {
    // Nothing is happening. Say so, and say what would appear here — an empty
    // panel is otherwise indistinguishable from a broken one, and a bare
    // sentence reads as a failure rather than as calm.
    body = (
      <div className={monitorClass.body}>
        {renderAttentionBand(attention)}
        <div className={monitorClass.empty} role="status">
          <span className={monitorClass.emptyIcon} aria-hidden="true">
            <Icon name="graphs" size={24} />
          </span>
          <span className={monitorClass.emptyTitle}>
            No graphs, loops or sessions are reporting.
          </span>
          <span className={monitorClass.emptyHint}>
            Graphs, loops and their rounds appear here while they run; sessions
            appear with the role each one is using.
          </span>
        </div>
      </div>
    );
  } else {
    body = (
      <div className={monitorClass.body}>
        {/* A failed status read keeps its message AND its way back, whether or
            not the other seat answered: partial data must never cost the user
            their recovery control. Deliberately not a live region — the header
            seat announces, and this row re-renders on every refresh. */}
        {status.error && (
          <div className={monitorClass.error}>
            <span className={monitorClass.errorGlyph} aria-hidden="true">
              <AlertGlyph size={16} />
            </span>
            <span className={monitorClass.errorText}>{status.text}</span>
            <button type="button" className={monitorClass.retry} onClick={refresh}>
              Retry
            </button>
          </div>
        )}
        {/* The verdict leads the evidence. Deliberately NOT role="alert": the
            header seat is the live region, and a band that re-renders on every
            refresh must not re-announce itself. */}
        {renderAttentionBand(attention)}

        {renderSessionSection(sessionRows, census, isExpanded, toggleGroup)}

        {graphs.length > 0 && (
          <section
            className={monitorClass.section}
            aria-labelledby="rolebox-monitor-graphs-title"
          >
            {renderSectionTitle(
              "rolebox-monitor-graphs-title",
              "graphs",
              "Engine graphs",
              formatCount(graphs.length),
            )}
            {graphs.map((graph) =>
              renderGraphBlock(graph, now, isExpanded, toggleGroup),
            )}
          </section>
        )}

        {loops.length > 0 && (
          <section
            className={monitorClass.section}
            aria-labelledby="rolebox-monitor-loops-title"
          >
            {renderSectionTitle(
              "rolebox-monitor-loops-title",
              "loops",
              "Loops",
              formatCount(loops.length),
            )}
            <div className={monitorClass.loopList}>
              {loops.map((loop) => renderLoopRow(loop, now))}
            </div>
          </section>
        )}

        <section
          className={monitorClass.section}
          aria-labelledby="rolebox-monitor-metrics-title"
        >
          {renderSectionTitle(
            "rolebox-monitor-metrics-title",
            "metrics",
            "Metrics",
            formatCount(metricCount),
          )}
          {metricCount === 0 ? (
            // An empty snapshot is explained rather than hidden, and the reason
            // has to be TRUE: the registry always reports its core dispatch
            // seats, so "nothing is counted" would be a lie. What the gate
            // actually takes away is everything else.
            <p className={monitorClass.state}>
              {metricsError !== null
                ? "Metrics could not be loaded: " + metricsError + "."
                : "No samples recorded. Rolebox measures anything beyond the core dispatch counters only while ROLEBOX_METRICS is set."}
            </p>
          ) : (
            <>
              {renderMetricGroup(
                "Counters",
                "metrics",
                "rolebox-monitor-counters",
                counters.length,
                isExpanded,
                toggleGroup,
                counters.map(([name, metric]) => {
                  const parsed = parseMetricKey(name);
                  return renderMetricRow(
                    parsed.name,
                    { ...parsed.labels, ...(metric.labels ?? {}) },
                    count(metric.value),
                    name + " = " + count(metric.value),
                  );
                }),
              )}
              {renderMetricGroup(
                "Gauges",
                "frontier",
                "rolebox-monitor-gauges",
                gauges.length,
                isExpanded,
                toggleGroup,
                gauges.map(([name, metric]) => {
                  const parsed = parseMetricKey(name);
                  return renderMetricRow(
                    parsed.name,
                    { ...parsed.labels, ...(metric.labels ?? {}) },
                    count(metric.value),
                    name + " = " + count(metric.value),
                  );
                }),
              )}
              {renderMetricGroup(
                "Histograms",
                "clock",
                "rolebox-monitor-histograms",
                histograms.length,
                isExpanded,
                toggleGroup,
                histograms.map(([name, histogram]) =>
                  renderHistogramRow(name, histogram),
                ),
              )}
            </>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="rolebox-monitor" data-rolebox-monitor aria-busy={loading}>
      <div className={monitorClass.panel}>
        <header className={monitorClass.header}>
          <div className={monitorClass.titleRow}>
            {/* The tab chip carries the surface name; the body keeps its own
                heading so the reading sections stay named in the a11y tree. */}
            <h2 className={monitorClass.title}>Rolebox</h2>
            {/* How updates arrive, and when the snapshot was taken. Outside the
                live region on purpose (see the status seat below). */}
            <span
              className={monitorClass.live}
              title={
                live === "live"
                  ? "Updates arrive when rolebox state changes."
                  : live === "connecting"
                    ? "Opening the change channel…"
                    : "The change channel is unavailable — use Refresh."
              }
            >
              <span
                className={monitorClass.liveDot + " " + liveDotModifier(live)}
                aria-hidden="true"
              />
              <span className={monitorClass.liveLabel}>{LIVE_LABEL[live]}</span>
              <span className={monitorClass.liveTime}>
                {loadedAt === 0
                  ? "—"
                  : new Date(loadedAt).toLocaleTimeString()}
              </span>
            </span>
          </div>
          <button
            type="button"
            className={monitorClass.refresh}
            disabled={loading}
            onClick={refresh}
          >
            {loading ? (
              <span className={monitorClass.spinner} aria-hidden="true" />
            ) : (
              <span className={monitorClass.buttonGlyph} aria-hidden="true">
                <Icon name="retry" size={14} />
              </span>
            )}
            Refresh
          </button>
          <span
            role="status"
            title={status.text}
            className={
              status.error
                ? monitorClass.status + " " + monitorClass.statusError
                : monitorClass.status
            }
          >
            {/* The body always carries the full message beside its Retry
                control (the alert state, or the retry row when other seats
                answered), so the seat states the outcome instead of repeating
                the sentence verbatim. Its title keeps the full text. */}
            {status.error ? "Load failed" : status.text}
          </span>
        </header>
        {body}
      </div>
    </div>
  );
}
