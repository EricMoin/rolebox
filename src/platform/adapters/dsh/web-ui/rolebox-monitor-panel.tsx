/**
 * RoleboxMonitorPanel — the rolebox contribution to the dsh
 * `'settings.section'` slot (browser half): a Monitoring page inside the
 * dsh settings panel.
 *
 * The dsh web app's sidebar column (session list + foot) exposes no
 * third-party list slot (verified against the shipped slots contracts —
 * `settings.trigger` is a single-kind slot already occupied by settings), so
 * the settings panel — reachable from the sidebar gear — is the one additive
 * entry point for monitoring; this component is the page registered there
 * (see `client.ts` for the registration and the structural slot contract).
 *
 * The panel is a root-scoped settings page (`{ kind: 'list', scope: 'root' }`
 * with owner share `{ close }`). It renders the rolebox runtime health:
 *
 *   - on mount it fetches the composed runtime status from
 *     `GET /rolebox/status` (loop summaries from the LoopCoordinator, live
 *     engine-graph snapshots via the monitor reader, session count / recent
 *     ids from the SessionStore, per-session active roles from the role
 *     switcher) and the metrics snapshot from `GET /rolebox/metrics`
 *     (`metrics.snapshot()` — counters/gauges/histograms; the snapshot
 *     always carries the core dispatch counters/gauges even under the
 *     `ROLEBOX_METRICS` gate) — both same-origin relative paths on the dsh
 *     web server;
 *   - it renders an Engine graphs section (one card per live graph: phase,
 *     node count + per-status node counts, budget tokens/cost, loop-group
 *     ids, last update), a Loops section (origin session, agent, phase,
 *     round progress), a Metrics section (counter and gauge readings —
 *     including the core dispatch counter/gauge — plus histogram
 *     sum/count), and a compact Sessions line (count, recent ids, active
 *     roles);
 *   - a manual Refresh control re-fetches both endpoints; while a fetch is
 *     in flight the panel is `aria-busy` and the control is disabled; the
 *     header status seat (`role="status"`, the live region) reports
 *     load/refresh outcomes and errors;
 *   - a manual "Reload roles" control POSTs `POST /rolebox/reload` (the
 *     in-process, non-destructive role reload) and then re-fetches the role
 *     state through the Refresh path; it is the reload's ONLY entry point (no
 *     CLI/TUI surface) and it NEVER polls — the request is issued from the
 *     click alone, and the status seat reports the outcome or the failure;
 *   - a failed initial load renders an explicit error state (`role="alert"`)
 *     with the server message and a Retry control; an empty snapshot (no
 *     graphs, no loops, no metrics, zero sessions) renders an explicit
 *     empty state; a refresh failure with previously rendered data keeps
 *     the data visible and reports the error on the status seat;
 *   - the body leads with a derived ATTENTION band ("does anything need
 *     me?") before it lists anything, because the panel is opened under time
 *     pressure. State is encoded as a pale tint fill plus the normalised
 *     state WORD, never as coloured text: measured against the host palette,
 *     `state-success-primary` is 2.09:1 and `state-warn-primary` 1.99:1 as
 *     marks on their own tints, so neither can serve as a foreground
 *     indicator. The raw backend phase always stays in the DOM beside the
 *     word, and an unrecognised phase degrades to a neutral chip rather than
 *     to a false success or failure;
 *   - every section guards its payload structurally, so a partially
 *     populated or older backend renders the sections it has instead of
 *     failing the whole panel.
 *
 * The slot contract (dsh-client-ui-slots' `SlotCore.register` /
 * `PropsRuntime` / `InjectFace` / `PropsLocale`) is consumed STRUCTURALLY —
 * `@deepseek-ai/dsh-client-ui-slots` is not installed yet, so
 * `RoleboxMonitorPanelProps` duck-types the composed props surface (see the
 * module docstring of `client.ts` for the citation map). The only external
 * module imported is `react`, whose type surface is supplied by the
 * temporary `react.stub.d.ts` in this directory.
 *
 * This module is BROWSER code: it must not import node builtins, and it uses
 * the browser `fetch` global with relative (same-origin) paths.
 *
 * @module
 */

import { useEffect, useState } from "react";
import { monitorClass } from "./rolebox-monitor-panel.css.ts";

// ── Endpoint contract ──────────────────────────────────────────────────────

/** `GET /rolebox/status` — composed rolebox runtime health (same-origin). */
export const STATUS_ENDPOINT = "/rolebox/status";

/** `GET /rolebox/metrics` — `metrics.snapshot()` (counters/gauges/histograms). */
export const METRICS_ENDPOINT = "/rolebox/metrics";

/**
 * `POST /rolebox/reload` — in-process, non-destructive role reload
 * (same-origin). The monitor panel is the ONLY entry point to it (locked
 * decision: no CLI/TUI surface), it is triggered MANUALLY (no polling), and a
 * successful reload is followed by a role-state re-fetch.
 */
export const RELOAD_ENDPOINT = "/rolebox/reload";

// ── Structural DTOs (mirror the backend / monitor-reader shapes) ───────────

/**
 * Structural loop-summary DTO — one entry of the `loops` seat of the
 * `GET /rolebox/status` body. Mirrors the `LoopState` runtime projection the
 * backend serializes (`src/loop/types.ts`); every key is optional so a
 * partial backend payload degrades gracefully.
 */
export interface MonitorLoopDto {
  originSessionId?: string;
  agent?: string;
  phase?: string;
  current?: number;
  total?: number;
  mode?: string;
  activeWorkerSessionId?: string;
}

/** Structural graph-budget DTO — the `budget` seat of an engine-graph card. */
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
 * Structural engine-graph DTO — one item of the `engineGraphs` seat of the
 * `GET /rolebox/status` body. Mirrors `EngineGraphSnapshot`
 * (`src/cli/commands/monitor/monitor-reader-types.ts`); the panel consumes
 * only the display-relevant subset.
 */
export interface MonitorEngineGraphDto {
  graphId?: string;
  phase?: string;
  nodeCount?: number;
  nodeStatusCounts?: Record<string, number>;
  budget?: MonitorBudgetDto;
  loopGroups?: MonitorLoopGroupDto[];
  updatedAt?: string;
}

/**
 * Structural sessions DTO — the `sessions` seat of the `GET /rolebox/status`
 * body (count + recent ids from the SessionStore, per-session active roles
 * from the role switcher). Also accepted as a bare array of `{ id }`
 * records for robustness.
 */
export interface MonitorSessionsDto {
  count?: number;
  recentIds?: string[];
  activeRoles?: Record<string, string | null>;
}

/**
 * Structural `GET /rolebox/status` success body. All seats are optional:
 * an older or partially populated backend must degrade to the sections it
 * has, never fail the panel.
 */
export interface MonitorStatusBody {
  timestamp?: string;
  /** Loop summaries — array, or object-keyed map when serialized as a Map. */
  loops?: MonitorLoopDto[] | Record<string, MonitorLoopDto>;
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
 * phases `idle | executing | complete` and the eight-state loop machine
 * `activating | dispatching | awaiting_worker | summarizing | finalizing |
 * complete | cancelled | interrupted | error`), and it must never guess: an
 * unrecognised value degrades to `unknown` — never to a false success or a
 * false failure. `stopped` is deliberately distinct from `failed`: a
 * cancelled or interrupted run stopped, but it did not break, and calling it
 * "Failed" would be a lie.
 */
export type RoleboxRunState =
  | "failed"
  | "blocked"
  | "stopped"
  | "complete"
  | "running"
  | "idle"
  | "unknown";

/** The word rendered in the state chip — always paired with the raw phase. */
export const RUN_STATE_LABEL: Record<RoleboxRunState, string> = {
  failed: "Failed",
  blocked: "Blocked",
  stopped: "Stopped",
  complete: "Complete",
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
 * The panel's headline verdict. Every label comes from the payload and every
 * count is derived — nothing here is estimated or invented.
 */
export interface MonitorAttention {
  failed: string[];
  blocked: string[];
  /** Labels whose phase could not be classified. Not an alarm — a admission. */
  unknown: string[];
  running: number;
  complete: number;
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
  let complete = 0;

  const note = (state: RoleboxRunState): void => {
    if (state === "running") running += 1;
    else if (state === "complete") complete += 1;
  };

  for (const graph of graphs) {
    let state = classifyRunPhase(graph.phase);
    for (const [name, count] of Object.entries(graph.nodeStatusCounts ?? {})) {
      if (typeof count !== "number" || count <= 0) continue;
      // A TERMINAL graph keeps its own verdict. `nodeStatusCounts` is a
      // snapshot of statuses that OUTLIVE the run — a cancelled or timed-out
      // node stays in the map for the life of the session — so letting those
      // counts raise the verdict would pin a permanent red band on finished
      // work, right beside that graph's own green Complete chip. A monitoring
      // surface that cries wolf is worse than one that says nothing.
      const key = name.toLowerCase();
      // `blocked` is the ONE node status that stays LIVE across a terminal
      // phase. engine.cancel() deliberately leaves a human-in-the-loop gate for
      // the human while forcing the phase to `complete` anyway, so the node is
      // still resolvable through graph_approve — and this repo's own monitor
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
    complete,
    needsAttention: failed.length + blocked.length > 0,
  };
}

/**
 * The band's detail line. Failures and blocks lead; unrecognised phases are
 * named rather than hidden, because a monitoring surface that silently drops
 * what it cannot read under-reports — the worst asymmetry available to it.
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
  if (parts.length > 0) return parts.join(" · ");
  if (attention.running === 0 && attention.complete === 0) return "No active work";
  return (
    attention.running +
    (attention.running === 1 ? " run active" : " runs active") +
    " · " +
    attention.complete +
    " complete"
  );
}

/** Row cap per metric group before the "Show all" disclosure appears. */
export const GROUP_ROW_LIMIT = 8;

// ── Props ──────────────────────────────────────────────────────────────────

/**
 * Composed props of the settings-page entry — a duck-type of the slot
 * framework's `PropsRuntime<'settings.section'> & InjectFace<...> &
 * PropsLocale<'settings'>` intersection, restricted to the seats this panel
 * acknowledges:
 *
 *   - `close` — the owner-share seat of the settings panel
 *     (`{ close }` per the dsh-client-ui-settings settings-panel share).
 *     Declared (optional) so the component satisfies the composed props
 *     structurally; the panel renders no close affordance of its own (the
 *     settings shell owns dismissal).
 *   - `t` — the locale seat promised by declaring a `locale`. Declared
 *     (optional) for the same reason the dock declares it: the panel
 *     renders hardcoded English text (the dictionary keys are not known at
 *     this layer and unknown keys must not be routed through `t`).
 *
 * Members the real composed props carry that this component does not consume
 * are simply not declared: a component with a narrower prop type accepts the
 * broader framework-supplied props structurally.
 */
export interface RoleboxMonitorPanelProps {
  /** Owner-share seat: closes the settings panel (declared, not consumed). */
  close?: () => void;
  /** Locale seat (declared `locale: 'settings'`); accepted, not used. */
  t?: (key: string, params?: Record<string, unknown>) => string;
}

// ── Internal helpers ───────────────────────────────────────────────────────

/** Status-seat state: the rendered text plus whether it is an error. */
interface PanelStatus {
  text: string;
  error: boolean;
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

/** Normalize an `activeRoles`-shaped record (string or null values only). */
function asStringOrNullRecord(value: unknown): Record<string, string | null> {
  if (!isRecord(value)) return {};
  const out: Record<string, string | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || item === null) out[key] = item;
  }
  return out;
}

/** Format a number for display; non-finite/absent values render as "—". */
function formatNumber(value: unknown): string {
  const n = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(n) ? String(n) : "—";
}

// ── Payload extraction (defensive normalization) ───────────────────────────

/** Extract the loop-summary list, tolerating array or object-keyed Map serialization. */
function extractLoops(body: unknown): MonitorLoopDto[] {
  if (!isRecord(body)) return [];
  const loops = body.loops;
  if (Array.isArray(loops)) return loops.filter(isRecord) as MonitorLoopDto[];
  if (isRecord(loops)) return Object.values(loops).filter(isRecord) as MonitorLoopDto[];
  return [];
}

/** Extract the engine-graph list (array only). */
function extractGraphs(body: unknown): MonitorEngineGraphDto[] {
  if (!isRecord(body)) return [];
  const graphs = body.engineGraphs;
  if (!Array.isArray(graphs)) return [];
  return graphs.filter(isRecord) as MonitorEngineGraphDto[];
}

/** Extract the sessions seat, tolerating a `{ count, recentIds }` object or an array of `{ id }` records. */
function extractSessions(body: unknown): MonitorSessionsDto {
  if (!isRecord(body)) return {};
  const raw = body.sessions;
  if (Array.isArray(raw)) {
    const recentIds = raw
      .filter(isRecord)
      .map((session) => (typeof session.id === "string" ? session.id : ""))
      .filter((id) => id.length > 0);
    return { count: recentIds.length, recentIds };
  }
  if (isRecord(raw)) {
    const recentIds = Array.isArray(raw.recentIds)
      ? raw.recentIds.filter((id): id is string => typeof id === "string")
      : [];
    return {
      count: asNumber(raw.count),
      recentIds,
      activeRoles: asStringOrNullRecord(raw.activeRoles),
    };
  }
  return {};
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

// ── Section renderers ───────────────────────────────────────────────────────

/** Map a run state to its chip modifier class. */
function chipModifier(state: RoleboxRunState): string {
  if (state === "failed") return monitorClass.chipFailed;
  if (state === "blocked") return monitorClass.chipBlocked;
  if (state === "stopped") return monitorClass.chipStopped;
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
      {RUN_STATE_LABEL[state]}
    </span>
  );
}

/**
 * The "Show all N" / "Show fewer" disclosure for a metric group, rendered only
 * when the group exceeds {@link GROUP_ROW_LIMIT}. Reference data is demoted,
 * not hidden: the full set stays one click away.
 */
function renderOverflowToggle(
  group: string,
  total: number,
  expanded: boolean,
  onToggle: (group: string) => void,
) {
  if (total <= GROUP_ROW_LIMIT) return null;
  return (
    <button
      type="button"
      className={monitorClass.more}
      aria-expanded={expanded}
      aria-controls={group}
      onClick={() => onToggle(group)}
    >
      {expanded ? "Show fewer" : "Show all " + total}
    </button>
  );
}

/**
 * Alert glyph — a 14x14 circled exclamation. State is never carried by colour
 * alone, so every error surface pairs its tint with this glyph and its text.
 * A local SVG: the dock's glyphs are deliberately not imported across modules.
 */
function AlertGlyph() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="5.4" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M7 4.3v3.7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="7" cy="10.1" r=".75" fill="currentColor" />
    </svg>
  );
}

/**
 * Question glyph — the band's NEUTRAL half. Rendered while the verdict admits
 * it could not classify every phase, so a check mark never reads "all good"
 * over an admission.
 */
function QuestionGlyph() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="5.4" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M5.7 5.6a1.4 1.4 0 1 1 2 1.3c-.5.2-.7.6-.7 1.1v.3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="7" cy="10.2" r=".7" fill="currentColor" />
    </svg>
  );
}

/** Check glyph — the calm half of the attention band's verdict. */
function CheckGlyph() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="m3.25 7.5 2.75 2.75 4.75-6"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * One engine-graph card: id + phase head, a definition-list of node and
 * budget readings (node count, per-status node counts, spawned sessions,
 * token in/out, cost), loop-group ids, and the last-update time. Long ids
 * truncate with a `title` recovery, mirroring the dock's protected-name
 * convention. Plain render function (called directly, not as a JSX
 * component — the dock convention keeps the render tree flat).
 */
function renderGraphCard(graph: MonitorEngineGraphDto) {
  const counts = Object.entries(graph.nodeStatusCounts ?? {});
  const budget = graph.budget ?? {};
  const loopGroups = Array.isArray(graph.loopGroups)
    ? (graph.loopGroups.filter(isRecord) as MonitorLoopGroupDto[])
    : [];
  return (
    <div className={monitorClass.graph}>
      <div className={monitorClass.graphHead}>
        <span className={monitorClass.graphId} title={graph.graphId}>
          {graph.graphId ?? "unknown"}
        </span>
        <span className={monitorClass.graphState}>
          <span className={monitorClass.phase} title={graph.phase ?? "unknown"}>
            {graph.phase ?? "unknown"}
          </span>
          {renderChip(classifyRunPhase(graph.phase))}
        </span>
      </div>
      <dl className={monitorClass.kv}>
        <div className={monitorClass.kvRow}>
          <dt>Nodes</dt>
          <dd>{formatNumber(graph.nodeCount)}</dd>
        </div>
        {counts.map(([name, value]) => (
          <div className={monitorClass.kvRow} key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        <div className={monitorClass.kvRow}>
          <dt>Sessions spawned</dt>
          <dd>{formatNumber(budget.sessionsSpawned)}</dd>
        </div>
        <div className={monitorClass.kvRow}>
          <dt>Tokens in/out</dt>
          <dd>
            {formatNumber(budget.totalInputTokens)} /{" "}
            {formatNumber(budget.totalOutputTokens)}
          </dd>
        </div>
        <div className={monitorClass.kvRow}>
          <dt>Cost</dt>
          <dd>{formatNumber(budget.totalCost)}</dd>
        </div>
      </dl>
      {loopGroups.length > 0 && (
        <div className={monitorClass.graphMeta}>
          Loops: {loopGroups.map((group) => group.id ?? "?").join(", ")}
        </div>
      )}
      <div className={monitorClass.graphMeta} title={graph.updatedAt}>
        Updated {graph.updatedAt ?? "—"}
      </div>
    </div>
  );
}

/** One loop row: origin session, agent, phase, and round progress. */
function renderLoopRow(loop: MonitorLoopDto) {
  return (
    <div className={monitorClass.loop}>
      <span className={monitorClass.loopId} title={loop.originSessionId}>
        {loop.originSessionId ?? "unknown"}
      </span>
      <span className={monitorClass.loopAgent} title={loop.agent ?? "—"}>
        {loop.agent ?? "—"}
      </span>
      <span className={monitorClass.loopPhase} title={loop.phase ?? "—"}>
        {loop.phase ?? "—"}
      </span>
      {renderChip(classifyRunPhase(loop.phase))}
      <span className={monitorClass.loopProgress}>
        {loop.current ?? 0}/{loop.total ?? 0}
      </span>
    </div>
  );
}

/** Compact sessions line: count, recent ids (annotated with active roles). */
function renderSessionsBlock(sessions: MonitorSessionsDto) {
  const count = sessions.count ?? 0;
  const parts =
    sessions.recentIds?.map((id) => {
      const role = sessions.activeRoles?.[id];
      return role === undefined || role === null ? id : id + " (" + role + ")";
    }) ?? [];
  return (
    <section
      className={monitorClass.section}
      aria-labelledby="rolebox-monitor-sessions-title"
    >
      <h2
        id="rolebox-monitor-sessions-title"
        className={monitorClass.sectionTitle}
      >
        Sessions
        <span className={monitorClass.sectionCount}>{count}</span>
      </h2>
      <p className={monitorClass.sessions}>
        {count} session{count === 1 ? "" : "s"}
        {parts.length > 0 ? " — " + parts.join(", ") : ""}
      </p>
    </section>
  );
}

// ── The panel ──────────────────────────────────────────────────────────────

/**
 * The Monitoring settings page: fetches `GET /rolebox/status` and
 * `GET /rolebox/metrics` on mount (and on every manual refresh), renders the
 * engine-graph / loop / metrics / sessions readings, and surfaces
 * loading / error / empty states with a live-region status seat
 * (`role="status"`) and an `aria-busy` panel while a fetch is in flight.
 * The header also carries the manual role-reload control
 * (`POST /rolebox/reload`), the reload's only entry point; it never polls.
 *
 * @param props - composed settings-page props (see {@link RoleboxMonitorPanelProps}).
 */
export function RoleboxMonitorPanel(_props: RoleboxMonitorPanelProps) {
  const [statusBody, setStatusBody] = useState<MonitorStatusBody | null>(null);
  const [metricsBody, setMetricsBody] = useState<MonitorMetricsBody | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<PanelStatus>({
    text: "Loading monitoring data…",
    error: false,
  });
  /**
   * Manual-refresh trigger. The load effect depends on it: bumping the token
   * re-runs the effect (with cleanup of the previous in-flight fetch).
   * Settings pages are root-scoped, so there is no session dependency.
   */
  const [refreshToken, setRefreshToken] = useState(0);
  /**
   * Metric groups the user has expanded past {@link GROUP_ROW_LIMIT}. Metrics
   * are reference data, so the overflow starts collapsed; a new array is always
   * written so the state comparison sees a change.
   */
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
  /**
   * Manual role-reload trigger (`POST /rolebox/reload`). MANUAL ONLY: the
   * request is issued from the button's click handler and never from a timer
   * or an interval — this panel does not poll.
   */
  const [reloading, setReloading] = useState(false);
  /**
   * Confirmation of the last successful role reload, held until the
   * follow-up role-state fetch lands. The fetch owns the status seat's steady
   * text, so without this hand-off the reload's confirmation would be
   * overwritten by the refresh the reload itself triggered.
   */
  const [reloadNotice, setReloadNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Distinguish the first load from a refresh: the skeleton only substitutes
    // for content that has never rendered, and the seat names which one is
    // happening.
    const isInitialLoad = statusBody === null && metricsBody === null;
    // Consume a pending role-reload confirmation: the fetch that follows a
    // successful reload is what reports it, so the seat shows the reload
    // outcome instead of a bare "Updated at" timestamp. Clearing it here (and
    // not on the success branch) keeps a stale confirmation from resurfacing
    // if this follow-up fetch itself fails.
    const reloadNoticeText = reloadNotice;
    setReloadNotice(null);
    setLoading(true);
    setStatus({
      text: isInitialLoad ? "Loading monitoring data…" : "Refreshing…",
      error: false,
    });

    async function load(): Promise<void> {
      try {
        const [statusRes, metricsRes] = await Promise.all([
          fetch(STATUS_ENDPOINT),
          fetch(METRICS_ENDPOINT),
        ]);
        if (cancelled) return;
        if (!statusRes.ok) throw new Error("HTTP " + statusRes.status);
        if (!metricsRes.ok) throw new Error("HTTP " + metricsRes.status);
        const statusData = (await statusRes.json().catch(() => null)) as unknown;
        const metricsData = (await metricsRes.json().catch(() => null)) as unknown;
        if (cancelled) return;
        // Malformed JSON bodies degrade to null → the empty state, never a crash.
        const nextStatus = isRecord(statusData)
          ? (statusData as MonitorStatusBody)
          : null;
        const nextMetrics = isRecord(metricsData)
          ? (metricsData as MonitorMetricsBody)
          : null;
        setStatusBody(nextStatus);
        setMetricsBody(nextMetrics);
        // The seat is the live region, so a refresh announces the VERDICT and
        // not merely a timestamp.
        const verdict = deriveAttention(
          extractGraphs(nextStatus),
          extractLoops(nextStatus),
        );
        setStatus({
          text:
            reloadNoticeText ??
            ("Updated at " +
              new Date().toLocaleTimeString() +
              (verdict.needsAttention
                ? " — " +
                  (verdict.failed.length + verdict.blocked.length) +
                  " need attention"
                : "") +
              (verdict.unknown.length > 0
                ? " — " + verdict.unknown.length + " state unrecognized"
                : "")),
          error: false,
        });
      } catch (err) {
        if (!cancelled) {
          setStatus({
            text: "Failed to load monitoring data: " + toMessage(err),
            error: true,
          });
        }
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
  const hasData =
    graphs.length > 0 ||
    loops.length > 0 ||
    counters.length > 0 ||
    gauges.length > 0 ||
    histograms.length > 0 ||
    (sessions.count ?? 0) > 0;

  const attention = deriveAttention(graphs, loops);
  const attentionCount = attention.failed.length + attention.blocked.length;
  const attentionDetail = describeAttention(attention);
  // "All clear" is a claim, so it is made only when every phase was actually
  // read. Unreadable phases downgrade the headline to a neutral admission.
  const attentionTitle = attention.needsAttention
    ? attentionCount + " need attention"
    : attention.unknown.length > 0
      ? attention.unknown.length + " state unrecognized"
      : "All clear";

  const isExpanded = (group: string): boolean => expandedGroups.includes(group);
  const toggleGroup = (group: string): void => {
    setExpandedGroups((previous) =>
      previous.includes(group)
        ? previous.filter((key) => key !== group)
        : [...previous, group],
    );
  };

  const refresh = (): void => setRefreshToken((count) => count + 1);

  /**
   * Reload roles: POST the in-process reload route, then re-fetch the role
   * state. MANUAL ONLY — this runs from the button's click handler and nothing
   * else; no timer and no interval is ever scheduled.
   *
   * This is NOT the dock's client-side `reload()`
   * (`role-switch-dock.tsx`), which merely re-reads the role list over GET.
   * This control is a different concern: it asks the server to re-discover and
   * re-resolve roles from disk and refresh every consumer of the previous role
   * state. The two are deliberately not merged.
   *
   * A failed reload leaves the previously rendered role state untouched (the
   * server preserved its state too), so the failure is reported on the status
   * seat without a follow-up fetch.
   */
  const reloadRoles = async (): Promise<void> => {
    if (reloading) return;
    setReloading(true);
    setStatus({ text: "Reloading roles…", error: false });
    try {
      const res = await fetch(RELOAD_ENDPOINT, { method: "POST" });
      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        // The route's stable error shape is { ok: false, error, disabled? };
        // a bodyless failure degrades to the HTTP status.
        const message =
          isRecord(body) && typeof body.error === "string"
            ? body.error
            : "HTTP " + res.status;
        setStatus({ text: "Role reload failed: " + message, error: true });
        return;
      }
      const record = isRecord(body) ? body : {};
      setReloadNotice(
        "Reloaded roles — " +
          (asNumber(record.discovered) ?? 0) +
          " discovered, " +
          (asNumber(record.resolved) ?? 0) +
          " resolved, " +
          (asNumber(record.skipped) ?? 0) +
          " skipped",
      );
      // Re-fetch the role state through the same path the Refresh control
      // uses; the notice rides that fetch so the seat reports the outcome.
      setRefreshToken((count) => count + 1);
    } catch (err) {
      setStatus({ text: "Role reload failed: " + toMessage(err), error: true });
    } finally {
      setReloading(false);
    }
  };

  // Body posture: a full loading state only while nothing has rendered yet
  // (a refresh with data keeps the data visible); the error state only when
  // there is no data to fall back on (a refresh failure with data reports on
  // the status seat instead); otherwise the data body or the empty state.
  let body: unknown;
  if (loading && statusBody === null && metricsBody === null) {
    // The live region is the ONLY `.rolebox-monitor-state` here so the status
    // seat stays unambiguous; the skeleton beside it is decorative, and its
    // bars mirror the real layout so the panel does not reflow when data lands.
    body = (
      <div className={monitorClass.loading}>
        <span
          className={monitorClass.state + " " + monitorClass.stateSr}
          role="status"
        >
          Loading monitoring data…
        </span>
        <div className={monitorClass.skeleton} aria-hidden="true">
          <div className={monitorClass.skeletonCard}>
            <span className={monitorClass.skeletonBarWide} />
            <span className={monitorClass.skeletonBarHalf} />
          </div>
          <div className={monitorClass.skeletonCard}>
            <span className={monitorClass.skeletonBarWide} />
            <span className={monitorClass.skeletonBar} />
            <span className={monitorClass.skeletonBar} />
            <span className={monitorClass.skeletonBar} />
          </div>
          <div className={monitorClass.skeletonCard}>
            <span className={monitorClass.skeletonBarWide} />
            <span className={monitorClass.skeletonBar} />
            <span className={monitorClass.skeletonBar} />
            <span className={monitorClass.skeletonBar} />
          </div>
        </div>
      </div>
    );
  } else if (status.error && !hasData) {
    body = (
      <div
        className={monitorClass.state + " " + monitorClass.stateError}
        role="alert"
      >
        <span className={monitorClass.attentionGlyph} aria-hidden="true">
          <AlertGlyph />
        </span>
        <span className={monitorClass.errorText}>{status.text}</span>
        <button
          type="button"
          className={monitorClass.retry}
          onClick={refresh}
        >
          Retry
        </button>
      </div>
    );
  } else if (!hasData) {
    body = (
      <div className={monitorClass.state} role="status">
        No monitoring data available
      </div>
    );
  } else {
    body = (
      <div className={monitorClass.body}>
        {/* The verdict leads the evidence. Deliberately NOT role="alert": the
            header seat is the live region, and a band that re-renders on every
            refresh must not re-announce itself. */}
        <section
          className={
            monitorClass.attention +
            " " +
            (attention.needsAttention
              ? monitorClass.attentionAlert
              : monitorClass.attentionCalm)
          }
          aria-labelledby="rolebox-monitor-attention-title"
        >
          <span className={monitorClass.attentionGlyph} aria-hidden="true">
            {attention.needsAttention ? (
              <AlertGlyph />
            ) : attention.unknown.length > 0 ? (
              <QuestionGlyph />
            ) : (
              <CheckGlyph />
            )}
          </span>
          <span
            id="rolebox-monitor-attention-title"
            className={monitorClass.attentionTitle}
          >
            {attentionTitle}
          </span>
          <span className={monitorClass.attentionDetail}>
            {attentionDetail}
          </span>
        </section>
        {graphs.length > 0 && (
          <section
            className={monitorClass.section}
            aria-labelledby="rolebox-monitor-graphs-title"
          >
            <h2
              id="rolebox-monitor-graphs-title"
              className={monitorClass.sectionTitle}
            >
              Engine graphs
              <span className={monitorClass.sectionCount}>
                {graphs.length}
              </span>
            </h2>
            {graphs.map((graph) => renderGraphCard(graph))}
          </section>
        )}
        {loops.length > 0 && (
          <section
            className={monitorClass.section}
            aria-labelledby="rolebox-monitor-loops-title"
          >
            <h2
              id="rolebox-monitor-loops-title"
              className={monitorClass.sectionTitle}
            >
              Loops
              <span className={monitorClass.sectionCount}>{loops.length}</span>
            </h2>
            {loops.map((loop) => renderLoopRow(loop))}
          </section>
        )}
        {(counters.length > 0 || gauges.length > 0 || histograms.length > 0) && (
          <section
            className={monitorClass.section}
            aria-labelledby="rolebox-monitor-metrics-title"
          >
            <h2
              id="rolebox-monitor-metrics-title"
              className={monitorClass.sectionTitle}
            >
              Metrics
              <span className={monitorClass.sectionCount}>
                {counters.length + gauges.length + histograms.length}
              </span>
            </h2>
            {counters.length > 0 && (
              <div className={monitorClass.metricGroup}>
                <h3 className={monitorClass.metricGroupTitle}>Counters</h3>
                <dl className={monitorClass.kv} id="rolebox-monitor-counters">
                  {counters
                    .slice(
                      0,
                      isExpanded("rolebox-monitor-counters")
                        ? counters.length
                        : GROUP_ROW_LIMIT,
                    )
                    .map(([name, metric]) => (
                      <div className={monitorClass.kvRow} key={name}>
                        <dt className={monitorClass.metricName} title={name}>
                          {name}
                        </dt>
                        <dd className={monitorClass.metricValue}>
                          {formatNumber(metric.value)}
                        </dd>
                      </div>
                    ))}
                </dl>
                {renderOverflowToggle(
                  "rolebox-monitor-counters",
                  counters.length,
                  isExpanded("rolebox-monitor-counters"),
                  toggleGroup,
                )}
              </div>
            )}
            {gauges.length > 0 && (
              <div className={monitorClass.metricGroup}>
                <h3 className={monitorClass.metricGroupTitle}>Gauges</h3>
                <dl className={monitorClass.kv} id="rolebox-monitor-gauges">
                  {gauges
                    .slice(
                      0,
                      isExpanded("rolebox-monitor-gauges")
                        ? gauges.length
                        : GROUP_ROW_LIMIT,
                    )
                    .map(([name, metric]) => (
                      <div className={monitorClass.kvRow} key={name}>
                        <dt className={monitorClass.metricName} title={name}>
                          {name}
                        </dt>
                        <dd className={monitorClass.metricValue}>
                          {formatNumber(metric.value)}
                        </dd>
                      </div>
                    ))}
                </dl>
                {renderOverflowToggle(
                  "rolebox-monitor-gauges",
                  gauges.length,
                  isExpanded("rolebox-monitor-gauges"),
                  toggleGroup,
                )}
              </div>
            )}
            {histograms.length > 0 && (
              <div className={monitorClass.metricGroup}>
                <h3 className={monitorClass.metricGroupTitle}>Histograms</h3>
                <dl className={monitorClass.kv} id="rolebox-monitor-histograms">
                  {histograms
                    .slice(
                      0,
                      isExpanded("rolebox-monitor-histograms")
                        ? histograms.length
                        : GROUP_ROW_LIMIT,
                    )
                    .map(([name, histogram]) => (
                      <div className={monitorClass.kvRow} key={name}>
                        <dt className={monitorClass.metricName} title={name}>
                          {name}
                        </dt>
                        <dd className={monitorClass.metricValue}>
                          {formatNumber(histogram.count)} samples ·{" "}
                          {formatNumber(histogram.sum)}ms
                        </dd>
                      </div>
                    ))}
                </dl>
                {renderOverflowToggle(
                  "rolebox-monitor-histograms",
                  histograms.length,
                  isExpanded("rolebox-monitor-histograms"),
                  toggleGroup,
                )}
              </div>
            )}
          </section>
        )}
        {(sessions.count ?? 0) > 0 && renderSessionsBlock(sessions)}
      </div>
    );
  }

  return (
    <div
      className="rolebox-monitor"
      data-rolebox-monitor
      aria-busy={loading || reloading}
    >
      <div className={monitorClass.panel}>
        <header className={monitorClass.header}>
          <h1 className={monitorClass.title}>Monitoring</h1>
          <button
            type="button"
            className={monitorClass.refresh}
            disabled={loading || reloading}
            onClick={refresh}
          >
            {loading && (
              <span className={monitorClass.spinner} aria-hidden="true" />
            )}
            Refresh
          </button>
          <button
            type="button"
            className={monitorClass.reload}
            disabled={loading || reloading}
            onClick={() => void reloadRoles()}
          >
            {reloading && (
              <span className={monitorClass.spinner} aria-hidden="true" />
            )}
            Reload roles
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
            {status.text}
          </span>
        </header>
        {body}
      </div>
    </div>
  );
}
