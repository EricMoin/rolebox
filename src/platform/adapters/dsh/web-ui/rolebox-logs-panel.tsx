/**
 * RoleboxLogsPanel — the rolebox LIVE LOG VIEW as a dsh right-Sidebar page tab
 * (`sidebar.right.pane.tab`, keyed by the `rolebox-logs` tab type registered in
 * `./client.ts`).
 *
 * ── Why this panel reads HTTP and NOT the logging kernel ───────────────────
 *
 * This module is BROWSER code: it ships inside the dsh web client bundle
 * (`scripts/build-dsh-web-client.ts`, Bun `target: "browser"`), where the
 * platform kernel cannot be imported. `src/log/context.ts` pulls
 * `node:async_hooks`, which Bun's browser target stubs to an empty module, so
 * `new AsyncLocalStorage` throws WHILE THE BUNDLE IS EVALUATED — measured in
 * Stage 2 ("TypeError: undefined is not a constructor") and the reason
 * `web-ui/client.ts` is the one console exemption in
 * `scripts/check-logging-boundaries.ts`. A memory sink subscribed in the host
 * process would not help anyway: the browser is a different process, and the
 * records it must show were written by whichever process logged them.
 *
 * So the panel asks the SERVER: `GET /rolebox/logs` (see
 * `src/platform/adapters/dsh/web-rolebox-logs-route.ts`) answers one JSON page
 * of `{ records, cursor, source, truncated, skippedLines }`, and this component
 * holds exactly one string between requests — the cursor. Nothing in this file
 * imports `src/log/**`, a node builtin, or any new dependency.
 *
 * ── Refresh semantics (the contract this component owns) ───────────────────
 *
 *   - CURSOR POLLING. The first poll sends no cursor and paints the newest
 *     window. Every later poll sends the cursor the previous answer returned
 *     and APPENDS what came after it, so a record is painted once and there is
 *     no gap between two polls (that is the view layer's own cursor contract;
 *     this component only has to keep the string and hand it back).
 *   - CHANGE-DRIVEN, WITH A SAFETY NET. `GET /rolebox/events` is the PRIMARY
 *     trigger: ANY `changed` frame polls the route, so an append lands about one
 *     debounce later instead of up to {@link POLL_MS} later. `POLL_MS` stays as
 *     the fallback for a host where the channel cannot fire (no `EventSource`),
 *     and a trigger is never lost: one arriving while a poll is in flight
 *     records exactly ONE pending poll, run when that poll settles. The frame's
 *     `reason` is deliberately not filtered on — the channel coalesces a burst
 *     and keeps only the LAST reason, so a `"log"`-only filter would silently
 *     drop wake-ups.
 *   - VISIBLE ONLY. The channel AND the interval exist only while the document
 *     is visible; a `visibilitychange` to `hidden` tears both down, and
 *     returning to the tab starts a fresh channel, a fresh interval AND a poll.
 *     A host with no `document` (this component's tests, a non-DOM renderer)
 *     counts as visible.
 *   - PAUSABLE. The Pause control stops the stream while leaving the buffer on
 *     screen; Resume continues from the SAME cursor, so a pause never costs or
 *     repeats records. Manual Refresh polls once, immediately, without waiting
 *     for the next tick.
 *   - BOUNDED. The buffer keeps at most {@link BUFFER_LIMIT} records — the
 *     newest ones — and the count of what the cap dropped is reported rather
 *     than hidden, so an unbounded stream can never grow the page without
 *     bound. One poll is in flight at a time.
 *   - ONE FILTER, AND IT RESTARTS THE VIEW. The channel select (and the
 *     optional "this session" toggle) narrow the SERVER-side query; changing it
 *     starts a NEW view — the old cursor names a position in the old stream —
 *     so the buffer and the cursor are cleared together. That is the only
 *     operation that discards what is on screen, and it is the user's own.
 *
 * ── What the surface says about itself ─────────────────────────────────────
 *
 * `source` is the location the SERVER actually read (the route resolves it, the
 * panel only prints it), so a pane reading a temp directory never claims to
 * read the workspace. Empty and error states are explicit sentences with a way
 * back (Retry), never a blank pane: "no records yet" and "the read failed" are
 * different facts and the surface says which one it is.
 *
 * @module
 */

import { useEffect, useRef, useState } from "react";
import { logsClass } from "./rolebox-logs-panel.css.ts";

// ── Endpoint and cadence ───────────────────────────────────────────────────

/** The route this panel polls (registered by web-rolebox-logs-route.ts). */
export const LOGS_ENDPOINT = "/rolebox/logs";

/**
 * The shared change channel (`GET /rolebox/events`, registered by
 * web-rolebox-monitor-route.ts). A frame carries a SIGNAL, never a payload: a
 * `changed` frame says "what you are holding is stale", and this panel answers
 * by polling {@link LOGS_ENDPOINT}.
 */
export const EVENTS_ENDPOINT = "/rolebox/events";

/**
 * The FALLBACK cadence for hosts where the change channel cannot fire (no
 * `EventSource`, no `fs.watch`, a dropped connection), and a slow re-read for a
 * frame that was missed.
 *
 * The channel is the primary trigger — an append wakes the pane about one
 * debounce later — so this interval is deliberately slow: fifteen seconds is a
 * safety net, not a cadence. The cursor is what makes the number a presentation
 * choice instead of a correctness one: a slower tick shows the same records,
 * just later, and a tick with nothing new costs one incremental scan.
 */
export const POLL_MS = 15_000;

/** How many records one poll asks for. */
export const POLL_LIMIT = 200;

/**
 * The most records the panel keeps.
 *
 * A log view is watched for minutes, and nothing about the stream is bounded by
 * nature, so the buffer is: the newest {@link BUFFER_LIMIT} records stay and the
 * rest are dropped from the FRONT (oldest first). The pane reports how many the
 * cap dropped, because a silently shortened history reads as "that is all there
 * was".
 */
export const BUFFER_LIMIT = 500;

/**
 * How long one poll may hang before it fails into the error path. A bare
 * `fetch` has no deadline, and a request that never answers would leave the
 * pane frozen with no way to tell "nothing new" from "the server is gone".
 */
export const FETCH_TIMEOUT_MS = 15_000;

// ── Wire shapes (structural: the browser bundle never imports the kernel) ───

/** The five level words the kernel writes, in rank order. */
export type LogsPanelLevel = "debug" | "info" | "warn" | "error" | "fatal";

/** Every level, in rank order — this module's own copy of the vocabulary. */
export const LOGS_PANEL_LEVELS: readonly LogsPanelLevel[] = [
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
];

/** One record as the route serializes it, normalised for rendering. */
export interface LogsPanelRecord {
  /** Epoch milliseconds the record was written with. */
  time: number;
  /** One of {@link LOGS_PANEL_LEVELS}; an unknown word is read as `info`. */
  level: LogsPanelLevel;
  /** The channel that wrote it (`graph:host`, `web-ui`, …). */
  channel: string;
  message: string;
  /** The event code, when the record carries one. */
  code?: string;
  /** Field values, rendered as strings; arrays are joined with ", ". */
  fields: Record<string, string>;
  /** Scope identity entries that carry a string (graphId, sessionId, …). */
  scope: Record<string, string>;
}

/** Where a page was read from, as the route reported it. */
export interface LogsPanelSource {
  kind: "file" | "dir";
  path: string;
}

/** One successful poll, after normalisation. */
export interface LogsPanelPage {
  records: LogsPanelRecord[];
  cursor: string;
  source: LogsPanelSource | null;
  skippedLines: number;
  truncated: boolean;
}

/** The view filter the user controls. */
export interface LogsPanelFilter {
  /** Exact channel to ask the route for; `""` asks for every channel. */
  channel: string;
  /** Restrict the view to the session this tab is docked beside. */
  sessionOnly: boolean;
}

// ── Props ──────────────────────────────────────────────────────────────────

/**
 * Props of the docked tab body.
 *
 * The body is registered into the keyed `'sidebar.right.pane.tab'` seat with no
 * inject face, so the framework hands it the standard session-scope kit plus the
 * entry's empty business face. `sessionId` is the one standard prop this
 * component reads: it is what the optional "this session" filter narrows to.
 * Both props are optional so a host with a narrower seat still renders the pane.
 *
 * `t` is accepted for structural completeness only: the panel renders hardcoded
 * English text (this plugin registers no locale dictionaries, and unknown keys
 * must not be routed through `t`).
 */
export interface RoleboxLogsPanelProps {
  /** Session the tab is docked beside; enables the session filter. */
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

/** Render a value as a message string (browser-safe, no node builtins). */
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Structural record guard. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True for a `changed` frame of the change channel, false for anything else
 * (`hello`, a malformed body, a frame this build does not know). The frame's
 * REASON is not read here on purpose — see the module comment.
 */
function isChangedFrame(data: unknown): boolean {
  if (typeof data !== "string" || data.length === 0) return false;
  try {
    const parsed: unknown = JSON.parse(data);
    return isRecord(parsed) && parsed.type === "changed";
  } catch {
    return false;
  }
}

/** True when the document (when there is one) is visible. */
function documentVisible(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

/** The level modifier class for one level word. */
function levelModifier(level: LogsPanelLevel): string {
  if (level === "debug") return logsClass.levelDebug;
  if (level === "warn") return logsClass.levelWarn;
  if (level === "error") return logsClass.levelError;
  if (level === "fatal") return logsClass.levelFatal;
  return logsClass.levelInfo;
}

/** A level word from the wire, or `info` for anything this build does not know. */
function normaliseLevel(value: unknown): LogsPanelLevel {
  return typeof value === "string" && (LOGS_PANEL_LEVELS as readonly string[]).includes(value)
    ? (value as LogsPanelLevel)
    : "info";
}

/** One field value as text: arrays joined, primitives stringified, else dropped. */
function fieldText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .filter((entry) => typeof entry === "string" || typeof entry === "number")
      .map((entry) => String(entry));
    return parts.length > 0 ? parts.join(", ") : undefined;
  }
  return undefined;
}

/** A record's fields as renderable strings, dropping anything else. */
function normaliseFields(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const key of Object.keys(value)) {
    const text = fieldText(value[key]);
    if (text !== undefined) out[key] = text;
  }
  return out;
}

/** A record's scope as renderable strings, dropping anything else. */
function normaliseScope(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (typeof entry === "string" && entry.length > 0) out[key] = entry;
  }
  return out;
}

/** One record from the wire, or `undefined` when the value is not an object. */
function normaliseRecord(value: unknown): LogsPanelRecord | undefined {
  if (!isRecord(value)) return undefined;
  const time = typeof value.time === "number" && Number.isFinite(value.time) ? value.time : 0;
  const channel =
    typeof value.channel === "string" && value.channel.length > 0 ? value.channel : "unknown";
  const message = typeof value.message === "string" ? value.message : "";
  const code = typeof value.code === "string" && value.code.length > 0 ? value.code : undefined;
  return {
    time,
    level: normaliseLevel(value.level),
    channel,
    message,
    ...(code !== undefined ? { code } : {}),
    fields: normaliseFields(value.fields),
    scope: normaliseScope(value.scope),
  };
}

/** Where the page was read from, or `null` for a shape this build cannot read. */
function normaliseSource(value: unknown): LogsPanelSource | null {
  if (!isRecord(value)) return null;
  const kind = value.kind === "file" || value.kind === "dir" ? value.kind : null;
  const path = typeof value.path === "string" ? value.path : "";
  if (kind === null || path.length === 0) return null;
  return { kind, path };
}

/**
 * Read one poll's response body.
 *
 * A body that is not an object, or that carries no cursor, is a broken contract
 * rather than an empty reading: the panel says so instead of painting "nothing
 * happened". Everything else is normalised record by record, so one malformed
 * record costs one row and not the page.
 */
export function readLogsPage(body: unknown): LogsPanelPage | { error: string } {
  if (!isRecord(body)) return { error: "unexpected response body" };
  if (typeof body.cursor !== "string" || body.cursor.length === 0) {
    return { error: "unexpected response body (no cursor)" };
  }
  const rawRecords = Array.isArray(body.records) ? body.records : [];
  const records: LogsPanelRecord[] = [];
  for (const entry of rawRecords) {
    const record = normaliseRecord(entry);
    if (record !== undefined) records.push(record);
  }
  return {
    records,
    cursor: body.cursor,
    source: normaliseSource(body.source),
    skippedLines:
      typeof body.skippedLines === "number" && Number.isFinite(body.skippedLines)
        ? body.skippedLines
        : 0,
    truncated: body.truncated === true,
  };
}

/** Keep the newest `limit` records; returns the kept list and how many were dropped. */
export function capBuffer(
  records: readonly LogsPanelRecord[],
): { records: LogsPanelRecord[]; dropped: number } {
  if (records.length <= BUFFER_LIMIT) return { records: [...records], dropped: 0 };
  return { records: records.slice(records.length - BUFFER_LIMIT), dropped: records.length - BUFFER_LIMIT };
}

/**
 * The URL one poll fetches: the endpoint, the window size, the cursor in hand
 * and the active filter. Exported so the request shape is pinned by a test
 * rather than inferred from a fetch double.
 */
export function logsRequestUrl(cursor: string, filter: LogsPanelFilter, sessionId?: string): string {
  const params = new URLSearchParams();
  params.set("limit", String(POLL_LIMIT));
  if (cursor.length > 0) params.set("cursor", cursor);
  if (filter.channel.length > 0) params.set("channel", filter.channel);
  if (filter.sessionOnly && sessionId !== undefined && sessionId.length > 0) {
    params.set("session", sessionId);
  }
  return LOGS_ENDPOINT + "?" + params.toString();
}

/** Request options: a bounded signal where the platform provides one. */
function pollRequestInit(): RequestInit {
  const timeout = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal })?.timeout;
  return typeof AbortSignal !== "undefined" && typeof timeout === "function"
    ? { signal: timeout.call(AbortSignal, FETCH_TIMEOUT_MS) }
    : {};
}

/** `HH:MM:SS.mmm` in local time — fixed width, so rows stay aligned. */
export function clockTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  return (
    pad(date.getHours(), 2) +
    ":" +
    pad(date.getMinutes(), 2) +
    ":" +
    pad(date.getSeconds(), 2) +
    "." +
    pad(date.getMilliseconds(), 3)
  );
}

/** `key=value` entries joined for one row's metadata lane. */
function joinEntries(entries: Record<string, string>): string {
  return Object.keys(entries)
    .map((key) => key + "=" + entries[key])
    .join(" ");
}

// ── The panel ──────────────────────────────────────────────────────────────

/**
 * The live log view: polls `GET /rolebox/logs` while the document is visible and
 * the user has not paused it, appends each page after the cursor, and renders
 * the buffer with its source, its malformed-line count and its own freshness.
 *
 * @param props - docked tab-body props (see {@link RoleboxLogsPanelProps}).
 */
export function RoleboxLogsPanel(props: RoleboxLogsPanelProps) {
  /** The bounded buffer, oldest first (the order the route answers in). */
  const [records, setRecords] = useState<LogsPanelRecord[]>([]);
  /** How many records the buffer cap dropped since the view started. */
  const [dropped, setDropped] = useState(0);
  /** WHERE the last successful poll read from, as the server reported it. */
  const [source, setSource] = useState<LogsPanelSource | null>(null);
  /** Malformed lines the server counted at the source (exact, never capped). */
  const [skippedLines, setSkippedLines] = useState(0);
  /** True when the server said more matching records were waiting. */
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<PanelStatus>({
    text: "Starting the log view…",
    error: false,
  });
  const [loading, setLoading] = useState(true);
  /** User-paused: the interval is gone, the buffer stays. */
  const [paused, setPaused] = useState(false);
  /** Document visibility; a hidden tab polls nothing. */
  const [visible, setVisible] = useState(() => documentVisible());
  /** Exact channel filter; `""` is every channel. */
  const [channel, setChannel] = useState("");
  /** Restrict the view to this tab's session. */
  const [sessionOnly, setSessionOnly] = useState(false);
  /** Manual refresh trigger (a retry / a "poll now"). */
  const [refreshToken, setRefreshToken] = useState(0);
  /** The last poll's time, for the freshness stamp. */
  const [polledAt, setPolledAt] = useState(0);
  /** The cursor in hand — a ref, because it must not re-render on its own. */
  const cursorRef = useRef("");
  /**
   * The buffer as a REF as well as state: a page is merged into the ref and the
   * capped result is published with one `setRecords`, so no state updater ever
   * performs a side effect (React may invoke an updater more than once).
   */
  const bufferRef = useRef<LogsPanelRecord[]>([]);
  /** One poll in flight at a time. */
  const busyRef = useRef(false);
  /**
   * A wake-up that arrived while a request was in flight, waiting for that
   * request to settle.
   *
   * SHARED across runs of the refresh effect rather than local to one: the
   * effect re-runs on a manual refresh, a filter change, a pause and a
   * visibility change, so the request that drains this flag can belong to an
   * EARLIER run while the wake-up belongs to the current one.
   */
  const pendingPollRef = useRef(false);
  /**
   * The live run's poll, which an in-flight run drains a deferred wake-up into.
   *
   * `null` while the pane is paused or hidden — the runs that start no request
   * and open no channel — so a deferred wake-up can never restart polling on a
   * surface that was told to stop.
   */
  const pollRef = useRef<(() => Promise<void>) | null>(null);
  /** The filter the buffer belongs to; a change starts a new view. */
  const filterRef = useRef<string>("");

  const filter: LogsPanelFilter = { channel, sessionOnly };
  /**
   * What a view is a view OF: the channel, the session toggle, and the session
   * the seat names. The session id is part of the key because the framework can
   * hand the body a different one while it stays mounted (the user moves to
   * another session) — polling the new filter with the old cursor would merge
   * two sessions' records into one buffer.
   */
  const filterKey =
    channel + "\u0000" + String(sessionOnly) + "\u0000" + (props.sessionId ?? "");

  // Visibility: one listener for the panel's lifetime. A host without a
  // document is treated as visible (the poll loop is the panel's job there).
  useEffect(() => {
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") {
      return;
    }
    const onChange = (): void => setVisible(documentVisible());
    document.addEventListener("visibilitychange", onChange);
    return () => {
      if (typeof document.removeEventListener === "function") {
        document.removeEventListener("visibilitychange", onChange);
      }
    };
  }, []);

  /**
   * The refresh loop. One effect owns the whole lifecycle: it paints
   * immediately, then keeps the change channel AND the fallback interval only
   * while the pane is visible and unpaused. The effect re-runs on pause/resume,
   * on visibility, on a filter change and on a manual refresh; a filter change
   * additionally RESETS the view (the cursor names a position in the previous
   * filter's stream).
   */
  useEffect(() => {
    let cancelled = false;
    const isNewFilter = filterRef.current !== filterKey;
    filterRef.current = filterKey;
    if (isNewFilter) {
      cursorRef.current = "";
      bufferRef.current = [];
      setRecords([]);
      setDropped(0);
      setSkippedLines(0);
      setPending(false);
    }
    /** Replace the buffer on the first poll of a new filter, append afterwards. */
    let replacing = isNewFilter;

    const fail = (message: string): void => {
      setStatus({ text: "Failed to read the log view: " + message, error: true });
    };

    /** One poll. Never throws, never overlaps another, never sets state when stale. */
    const poll = async (): Promise<void> => {
      if (cancelled) return;
      if (busyRef.current) {
        // Not a second request and not a dropped wake-up: exactly ONE poll is
        // remembered, and whichever request is in flight runs it on settling.
        pendingPollRef.current = true;
        return;
      }
      busyRef.current = true;
      setLoading(true);
      try {
        const response = await fetch(
          logsRequestUrl(cursorRef.current, filter, props.sessionId),
          pollRequestInit(),
        );
        if (cancelled) return;
        if (!response.ok) {
          fail("HTTP " + response.status);
          return;
        }
        const body = (await response.json().catch(() => null)) as unknown;
        if (cancelled) return;
        const page = readLogsPage(body);
        if ("error" in page) {
          fail(page.error);
          return;
        }
        cursorRef.current = page.cursor;
        setSource(page.source);
        setSkippedLines(page.skippedLines);
        setPending(page.truncated);
        const merged = replacing ? page.records : [...bufferRef.current, ...page.records];
        replacing = false;
        const capped = capBuffer(merged);
        bufferRef.current = capped.records;
        setRecords(capped.records);
        if (capped.dropped > 0) setDropped((count) => count + capped.dropped);
        setPolledAt(Date.now());
        setStatus({ text: "Updated " + clockTime(Date.now()), error: false });
      } catch (err) {
        if (!cancelled) fail(toMessage(err));
      } finally {
        busyRef.current = false;
        if (!cancelled) setLoading(false);
        // The deferred wake-up runs HERE, after the request settled: one more
        // poll, never an overlapping one — and through the LIVE run's poll, not
        // this closure's. A run this request no longer belongs to (a manual
        // refresh, a filter change, a pause) is what recorded the wake-up, and
        // draining it into a cancelled closure would lose it until the fallback
        // interval. `pollRef` is null only while the pane is paused or hidden,
        // where no poll may run at all.
        if (pendingPollRef.current) {
          pendingPollRef.current = false;
          const next = pollRef.current;
          if (next !== null) void next();
        }
      }
    };

    // A PAUSED or HIDDEN pane does not poll at all — not even once — and opens
    // no channel. The check comes before the immediate poll on purpose:
    // otherwise pressing Pause would fire one more request, and a tab being
    // hidden would fetch on its way out, which is exactly what "the interval is
    // gone" is supposed to mean.
    if (paused || !visible) {
      pollRef.current = null;
      return () => {
        cancelled = true;
      };
    }
    pollRef.current = poll;
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);

    // The change channel: the host pushes "something moved" and this panel
    // answers with one poll. It is the PRIMARY trigger; the interval above is
    // the safety net, and it stays in charge when the platform has no
    // `EventSource` (this guard) or the connection drops.
    let channel: { close: () => void } | null = null;
    if (typeof EventSource !== "undefined") {
      const source = new EventSource(EVENTS_ENDPOINT);
      source.onmessage = (event: MessageEvent) => {
        // ANY `changed` frame polls, whatever `reason` it carries: the channel
        // coalesces a burst and keeps only the LAST reason, so filtering on one
        // would silently drop wake-ups. Malformed frames are ignored.
        if (isChangedFrame(event.data)) void poll();
      };
      // A dropped channel reconnects itself; there is nothing to retry and
      // nothing to report — the interval is in charge until it does, so an
      // error never throws and never stops the fallback.
      source.onerror = () => undefined;
      channel = source;
    }

    return () => {
      cancelled = true;
      clearInterval(timer);
      channel?.close();
    };
  }, [filterKey, paused, visible, refreshToken, props.sessionId]);

  // ── Derived readings ─────────────────────────────────────────────────────

  // The option list is what the BUFFER has actually seen: offering a channel the
  // current view never returned would be an empty select entry pretending to be
  // a reading. "All channels" is always first and always refetches.
  const channels = Array.from(new Set(records.map((record) => record.channel))).sort();
  const liveLabel = paused ? "Paused" : visible ? "Polling" : "Hidden";
  // The dot states the STREAM's health, not the moment of one request: off when
  // nothing is polling, amber while nothing has landed yet or the last read
  // failed, green once a page has arrived. (A per-poll flicker between amber and
  // green every two seconds would say nothing and be the only motion on screen.)
  const liveModifier =
    paused || !visible
      ? logsClass.liveDotOff
      : status.error || polledAt === 0
        ? logsClass.liveDotPending
        : logsClass.liveDotOn;
  const hasData = records.length > 0;

  const refresh = (): void => setRefreshToken((count) => count + 1);

  // Body posture: an error with nothing to fall back on replaces the pane; an
  // error with a buffer keeps the buffer and states the failure in a row above
  // it, so a transient failure never costs the user their history.
  let body: unknown;
  if (status.error && !hasData) {
    body = (
      <div className={logsClass.error} role="alert">
        <span className={logsClass.errorGlyph} aria-hidden="true">
          !
        </span>
        <span className={logsClass.errorText}>{status.text}</span>
        <button type="button" className={logsClass.retry} onClick={refresh}>
          Retry
        </button>
      </div>
    );
  } else if (!hasData) {
    body = (
      <div className={logsClass.empty} role="status">
        <span className={logsClass.emptyIcon} aria-hidden="true">
          ▤
        </span>
        <span className={logsClass.emptyTitle}>No records yet.</span>
        <span className={logsClass.emptyHint}>
          {source === null
            ? "Waiting for the first answer from the log view."
            : "Reading " +
              source.path +
              ". Records appear here as the platform logs them; a process that has not logged yet leaves this pane empty." +
              (skippedLines > 0
                ? " " + String(skippedLines) + " malformed line(s) were skipped at the source."
                : "")}
        </span>
      </div>
    );
  } else {
    body = (
      <ul className={logsClass.list}>
        {records.map((record, index) => renderRow(record, index))}
      </ul>
    );
  }

  return (
    <div className="rolebox-logs" data-rolebox-logs aria-busy={loading}>
      <div className={logsClass.panel}>
        <header className={logsClass.header}>
          <div className={logsClass.titleRow}>
            <h2 className={logsClass.title}>Logs</h2>
            {/* How updates arrive and how fresh they are. Outside the live
                region: it re-renders every poll and would re-announce itself. */}
            <span
              className={logsClass.live}
              title={
                paused
                  ? "Polling is paused — Resume continues from the same cursor."
                  : visible
                    ? "The view refreshes when the log source changes; while this tab is visible it also re-reads every " +
                      String(POLL_MS / 1000) +
                      "s as a fallback."
                    : "This tab is hidden — refreshing stops until it is visible again."
              }
            >
              <span className={logsClass.liveDot + " " + liveModifier} aria-hidden="true" />
              <span className={logsClass.liveLabel}>{liveLabel}</span>
              <span className={logsClass.liveTime}>
                {polledAt === 0 ? "—" : clockTime(polledAt)}
              </span>
            </span>
          </div>
          <div className={logsClass.controls}>
            <label className={logsClass.srOnly} htmlFor="rolebox-logs-channel">
              Channel filter
            </label>
            <select
              id="rolebox-logs-channel"
              className={logsClass.select}
              value={channel}
              onChange={(event: { target: { value: string } }) => setChannel(event.target.value)}
            >
              <option value="">All channels</option>
              {channels.map((name) => (
                <option value={name} key={name}>
                  {name}
                </option>
              ))}
            </select>
            {props.sessionId !== undefined && props.sessionId.length > 0 && (
              <button
                type="button"
                className={logsClass.button}
                aria-pressed={sessionOnly}
                onClick={() => setSessionOnly((value) => !value)}
                title={"Only records whose scope carries session " + props.sessionId}
              >
                This session
              </button>
            )}
            <button
              type="button"
              className={logsClass.button}
              aria-pressed={paused}
              onClick={() => setPaused((value) => !value)}
            >
              {paused ? "Resume" : "Pause"}
            </button>
            <button type="button" className={logsClass.button} disabled={loading} onClick={refresh}>
              {loading ? (
                <span className={logsClass.spinner} aria-hidden="true" />
              ) : (
                <span className={logsClass.buttonGlyph} aria-hidden="true">
                  ↻
                </span>
              )}
              Refresh
            </button>
          </div>
        </header>

        <div className={logsClass.source}>
          <span>Source</span>
          <span className={logsClass.sourcePath} title={source?.path ?? "not read yet"}>
            {source === null ? "not read yet" : source.kind + ": " + source.path}
          </span>
        </div>

        <div className={logsClass.facts}>
          <span className={logsClass.fact}>
            <span className={logsClass.factLabel}>records</span>
            <span className={logsClass.factValue}>{String(records.length)}</span>
          </span>
          <span className={logsClass.fact}>
            <span className={logsClass.factLabel}>skipped</span>
            <span className={logsClass.factValue}>{String(skippedLines)}</span>
          </span>
          {dropped > 0 && (
            <span className={logsClass.fact}>
              <span className={logsClass.factLabel}>dropped by buffer cap</span>
              <span className={logsClass.factValue}>{String(dropped)}</span>
            </span>
          )}
        </div>

        {pending && (
          <p className={logsClass.more}>
            More records are waiting at the cursor — the next poll continues from here.
          </p>
        )}

        {status.error && hasData && (
          <div className={logsClass.error}>
            <span className={logsClass.errorGlyph} aria-hidden="true">
              !
            </span>
            <span className={logsClass.errorText}>{status.text}</span>
            <button type="button" className={logsClass.retry} onClick={refresh}>
              Retry
            </button>
          </div>
        )}

        {body}

        <span
          role="status"
          title={status.text}
          className={
            status.error ? logsClass.status + " " + logsClass.statusError : logsClass.status
          }
        >
          {status.error ? "Read failed" : status.text}
        </span>
      </div>
    </div>
  );
}

/** One ledger row: time, level chip, then the message with its metadata lane. */
function renderRow(record: LogsPanelRecord, index: number) {
  const scope = joinEntries(record.scope);
  const fields = joinEntries(record.fields);
  const meta = [record.channel, record.code, scope, fields].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return (
    <li className={logsClass.row} key={String(record.time) + "-" + String(index)}>
      <span className={logsClass.time} title={new Date(record.time).toISOString()}>
        {clockTime(record.time)}
      </span>
      <span className={logsClass.level + " " + levelModifier(record.level)}>{record.level}</span>
      <span className={logsClass.body}>
        <span className={logsClass.message}>{record.message}</span>
        <span className={logsClass.meta}>
          {meta.map((part, partIndex) => (
            <span
              className={
                partIndex === 0
                  ? logsClass.channel
                  : part === record.code
                    ? logsClass.code
                    : part === scope
                      ? logsClass.scope
                      : logsClass.fields
              }
              key={partIndex}
            >
              {part}
            </span>
          ))}
        </span>
      </span>
    </li>
  );
}
