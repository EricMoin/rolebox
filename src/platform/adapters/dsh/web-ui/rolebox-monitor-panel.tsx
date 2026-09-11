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
 *   - a failed initial load renders an explicit error state (`role="alert"`)
 *     with the server message and a Retry control; an empty snapshot (no
 *     graphs, no loops, no metrics, zero sessions) renders an explicit
 *     empty state; a refresh failure with previously rendered data keeps
 *     the data visible and reports the error on the status seat;
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
        <span className={monitorClass.phase}>{graph.phase ?? "unknown"}</span>
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
      <span className={monitorClass.loopAgent}>{loop.agent ?? "—"}</span>
      <span className={monitorClass.loopPhase}>{loop.phase ?? "—"}</span>
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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setStatus({ text: "Loading monitoring data…", error: false });

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
        setStatusBody(isRecord(statusData) ? (statusData as MonitorStatusBody) : null);
        setMetricsBody(isRecord(metricsData) ? (metricsData as MonitorMetricsBody) : null);
        setStatus({
          text: "Updated at " + new Date().toLocaleTimeString(),
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

  const refresh = (): void => setRefreshToken((count) => count + 1);

  // Body posture: a full loading state only while nothing has rendered yet
  // (a refresh with data keeps the data visible); the error state only when
  // there is no data to fall back on (a refresh failure with data reports on
  // the status seat instead); otherwise the data body or the empty state.
  let body: unknown;
  if (loading && statusBody === null && metricsBody === null) {
    body = (
      <div className={monitorClass.state} role="status">
        Loading monitoring data…
      </div>
    );
  } else if (status.error && !hasData) {
    body = (
      <div
        className={monitorClass.state + " " + monitorClass.stateError}
        role="alert"
      >
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
            </h2>
            {counters.length > 0 && (
              <div className={monitorClass.metricGroup}>
                <h3 className={monitorClass.metricGroupTitle}>Counters</h3>
                <dl className={monitorClass.kv}>
                  {counters.map(([name, metric]) => (
                    <div className={monitorClass.kvRow} key={name}>
                      <dt className={monitorClass.metricName}>{name}</dt>
                      <dd className={monitorClass.metricValue}>
                        {formatNumber(metric.value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
            {gauges.length > 0 && (
              <div className={monitorClass.metricGroup}>
                <h3 className={monitorClass.metricGroupTitle}>Gauges</h3>
                <dl className={monitorClass.kv}>
                  {gauges.map(([name, metric]) => (
                    <div className={monitorClass.kvRow} key={name}>
                      <dt className={monitorClass.metricName}>{name}</dt>
                      <dd className={monitorClass.metricValue}>
                        {formatNumber(metric.value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
            {histograms.length > 0 && (
              <div className={monitorClass.metricGroup}>
                <h3 className={monitorClass.metricGroupTitle}>Histograms</h3>
                <dl className={monitorClass.kv}>
                  {histograms.map(([name, histogram]) => (
                    <div className={monitorClass.kvRow} key={name}>
                      <dt className={monitorClass.metricName}>{name}</dt>
                      <dd className={monitorClass.metricValue}>
                        {formatNumber(histogram.count)} samples ·{" "}
                        {formatNumber(histogram.sum)}ms
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </section>
        )}
        {(sessions.count ?? 0) > 0 && renderSessionsBlock(sessions)}
      </div>
    );
  }

  return (
    <div className="rolebox-monitor" data-rolebox-monitor aria-busy={loading}>
      <div className={monitorClass.panel}>
        <header className={monitorClass.header}>
          <span className={monitorClass.title}>Monitoring</span>
          <button
            type="button"
            className={monitorClass.refresh}
            disabled={loading}
            onClick={refresh}
          >
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
            {status.text}
          </span>
        </header>
        {body}
      </div>
    </div>
  );
}
