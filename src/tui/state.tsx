/**
 * TUI sidebar state management.
 *
 * Creates the SolidJS-reactive sidebar renderer with signals,
 * refresh cycle, health memo, and JSX assembly.
 *
 * Also exposes module-level trigger functions (`triggerRefresh`,
 * `triggerToggleMetrics`, etc.) that were previously consumed by
 * the (now-deleted) keybindings module, retained to support calls
 *
 * @module
 */

/** @jsxImportSource @opentui/solid */
import { createSignal, createMemo, createEffect, onCleanup, createRoot, Show, For, ErrorBoundary, type JSX } from "solid-js";
import type { TuiSlotContext } from "@opencode-ai/plugin/tui";
import { existsSync } from "node:fs";
import { stateDirFor } from "../utils/state-paths";
import { readMonitorSnapshot, readTaskDetail } from "../cli/commands/monitor/monitor-reader";
import {
  readLiveEngineGraphs,
  mergeLiveEngineGraphs,
} from "../cli/commands/monitor/monitor-reader-engine";
import type {
  MonitorSnapshot,
  TaskSnapshot,
  TaskDetail,
  ActiveFunction,
} from "../cli/commands/monitor/monitor-reader";
import {
  type ThemeColors, type HealthState,
  rgbaToCSS, BOLD, DIM, DIM_ITALIC,
  readPackageVersion, buildSessionScope, agentLeaf, agentRoot,
} from "./helpers";
import {
  renderHeader, renderRule,
  renderPulse, healthDisplay, renderStaleHint, renderNoStateBody,
  renderActivity, renderTaskDetailPanel,
  renderFilterBar, countTotalItems, collectSessionIds,
  renderLogs,
} from "./components/index";
import {
  collectLogChannels,
  cycleLogsChannel,
  createLogsStore,
  logsDropCounts,
  pollLogsStore,
  setLogsChannel,
  setLogsPaused,
  stepLogsLevel,
  type LogsDropCounts,
  type LogsStore,
} from "./logs";
import type { LogRecord } from "../log/types";
import { watchLogSource } from "../log/watch.ts";
import { isLogsViewLive, nextView, type TuiView } from "./logic";

import { foldGraphSignals } from "./events";
import type { EventBridge } from "./events";
const PACKAGE_VERSION = readPackageVersion();

// ── Exposed action references (prev. keybindings) ────────────────

/**
 * Module-level mutable references that the (deleted) keybindings module would
 * trigger via `triggerRefresh()`, `triggerToggleMetrics()`, etc.
 *
 * Set inside createRoot, cleared on cleanup.
 */
let _refreshRef: (() => void) | null = null;
let _toggleMetricsRef: (() => void) | null = null;
let _toggleFilterRef: (() => void) | null = null;
let _toggleHelpRef: (() => void) | null = null;
let _toggleStatusFilterRef: ((status: string) => void) | null = null;
let _toggleSessionFilterRef: ((sessionId: string | null) => void) | null = null;



/** Event bridge reference — set during plugin init, cleared on cleanup. */
let _eventBridgeRef: EventBridge | null = null;

/**
 * Logs-view control references, set inside createRoot and cleared on cleanup.
 *
 * The keymap layer in `index.tsx` calls the `trigger*` functions below instead
 * of reaching into the renderer's closure: same one-way shape the refresh /
 * metrics / filter triggers already use, so a key binding can never hold a
 * disposed signal.
 */
let _logsToggleRef: (() => void) | null = null;
let _logsPauseRef: (() => void) | null = null;
let _logsLevelRef: ((direction: number) => void) | null = null;
let _logsChannelRef: (() => void) | null = null;
let _logsFollowRef: (() => void) | null = null;

/** Open or leave the Logs tab. */
export function triggerLogsToggle(): void { _logsToggleRef?.(); }

/** Freeze or resume the log stream (a no-op while the Logs tab is hidden). */
export function triggerLogsPause(): void { _logsPauseRef?.(); }

/** Raise (+1) or lower (-1) the log level threshold. */
export function triggerLogsLevel(direction: number): void { _logsLevelRef?.(direction); }

/** Advance the channel filter to the next channel, then back to all. */
export function triggerLogsChannel(): void { _logsChannelRef?.(); }

/** Follow the newest records (clear the free-text filter and scroll home). */
export function triggerLogsFollow(): void { _logsFollowRef?.(); }

/** Filter persistence callback — called when filter state changes. */
let _filterPersistRef: ((filterText: string, activeStatuses: string[], sessionFilterId: string | null) => void) | null = null;

/** Force a data refresh from disk. */
export function triggerRefresh(): void { _refreshRef?.(); }

/** Toggle the dispatch metrics panel. */
export function triggerToggleMetrics(): void { _toggleMetricsRef?.(); }

/** Toggle the filter / search mode. */
export function triggerToggleFilter(): void { _toggleFilterRef?.(); }

/** Toggle the keyboard-shortcut help overlay. */
export function triggerToggleHelp(): void { _toggleHelpRef?.(); }

/** Toggle a status filter (running/pending/error/timeout). */
export function triggerToggleStatusFilter(status: string): void { _toggleStatusFilterRef?.(status); }

/** Toggle session filter to a specific session ID or back to all. */
export function triggerToggleSessionFilter(sessionId: string | null): void { _toggleSessionFilterRef?.(sessionId); }

/** Set the filter text value (used when restoring persisted filter on startup). */
let _setFilterTextRef: ((text: string) => void) | null = null;
export function setFilterTextExternally(text: string): void { _setFilterTextRef?.(text); }

/** Register the filter persistence callback (called from index.tsx where api.kv is available). */
export function setFilterPersistCallback(
  fn: (filterText: string, activeStatuses: string[], sessionFilterId: string | null) => void,
): void {
  _filterPersistRef = fn;
}

/** Clear the filter persistence callback. */
export function clearFilterPersistCallback(): void { _filterPersistRef = null; }

/** Set the module-level event bridge reference from the plugin entry. */
export function setEventBridgeRef(bridge: EventBridge | null): void {
  _eventBridgeRef = bridge;
}

// ── Detail panel constants ─────────────────────────────────────────────
const DETAIL_SCROLL_STEP = 500;

/**
 * How many log records the pane paints.
 *
 * The BUFFER holds up to 500 and the pane paints its newest slice: a sidebar is
 * a few dozen rows tall, so painting the whole buffer would spend the frame on
 * records no reader can see. The buffer keeps them, the counters report them,
 * and this is a presentation choice — not a second cap.
 */
const LOGS_PANE_ROWS = 200;

/**
 * Create the sidebar renderer closure.
 *
 * Returns a function suitable for use as a sidebar_content slot
 */
export function createSidebarRenderer(workspaceDir: string) {
  return (
    ctx: TuiSlotContext,
    props: { session_id: string },
  ) =>
    createRoot((dispose) => {
      const [phase, setPhase] = createSignal<"loading" | "ready" | "error">("loading");
      const [snapshot, setSnapshot] = createSignal<MonitorSnapshot | null>(null);
      const [stateDirPresent, setStateDirPresent] = createSignal(false);
      const [consecutiveFailures, setConsecutiveFailures] = createSignal(0);

      // UI state signals for keybinding-toggled overlays
      const [showHelp, setShowHelp] = createSignal(false);
      const [showMetrics, setShowMetrics] = createSignal(false);
      const [filterMode, setFilterMode] = createSignal(false);
      const [filterText, setFilterText] = createSignal("");
      const [filterStatuses, setFilterStatuses] = createSignal<Set<string>>(new Set());
      const [filterSessionId, setFilterSessionId] = createSignal<string | null>(null);

      // Current session ID — used to filter to only this session's activity.
      // Declared BEFORE the Logs store, which takes it as the view's session
      // identity at construction: a store built from a `const` that is still in
      // its temporal dead zone throws `Cannot access 'currentSessionId' before
      // initialization` while the renderer mounts (measured through the headless
      // renderer, which is how this ordering was found).
      const currentSessionId = props?.session_id ?? "";
      const [sessionScope, setSessionScope] = createSignal<Set<string>>(new Set([currentSessionId]));

      // ── View tabs and the Logs pane ──────────────────────────────────
      // The Logs view is the second live surface over the platform's own log
      // files. It shares THIS renderer's 1s refresh instead of starting a timer
      // of its own, and it holds only a cursor between polls.
      //
      // NO SESSION NARROWING BY DEFAULT. The host slot hands this renderer a
      // session id, and the Activity view narrows by it — but the records on
      // disk carry no session: no producer in `src/` writes `scope.sessionId`,
      // so a store built with `sessionId: <host session>` filters every record
      // away and paints an empty pane over a full log directory (measured: 6
      // records in the file, 0 in the pane). The Logs view therefore starts on
      // EVERY session. {@link setLogsSession} stays in the data layer for a
      // caller whose source really carries the field.
      const [view, setView] = createSignal<TuiView>("activity");
      const [logPaused, setLogPaused] = createSignal(false);
      const [logFilterText, setLogFilterText] = createSignal("");
      const [logChannels, setLogChannels] = createSignal<readonly string[]>([]);
      const [logRecords, setLogRecords] = createSignal<readonly LogRecord[]>([]);
      const [logSource, setLogSource] = createSignal<string | null>(null);
      const [logSkipped, setLogSkipped] = createSignal(0);
      const [logDropped, setLogDropped] = createSignal<LogsDropCounts>({ dropped: 0, earlierDropped: 0 });
      const [logPending, setLogPending] = createSignal(false);
      const [logError, setLogError] = createSignal<string | null>(null);
      let logsStore: LogsStore = createLogsStore();

      /**
       * Publish a store's state to the signals the pane renders from.
       *
       * The STORE is the pause state (it owns the frozen cursor), and the
       * `logPaused` signal is a mirror of it kept for the places that only need
       * the flag. Both are set here, from the store, so they cannot disagree: a
       * paused pane that does not say it is paused is the one failure mode a
       * live stream must not have.
       */
      function publishLogs(next: LogsStore): void {
        logsStore = next;
        setLogPaused(next.paused);
        setLogSource(next.source === null ? null : next.source.path);
        setLogSkipped(next.skippedLines);
        // ONE mapping for the two counters (logsDropCounts): they are disjoint,
        // so the pane's status line can add them without doubling a loss.
        setLogDropped(logsDropCounts(next.buffer));
        setLogPending(next.pending);
        setLogError(next.error === null ? null : next.error.message);
        setLogChannels(next.filters.channels);
        setLogRecords(next.buffer.records);
      }

      /**
       * One log poll, from the sidebar's own 1s refresh.
       *
       * The store READS only while the Logs tab is open and unpaused; a hidden
       * or paused pane passes `hostPaused`, which freezes the stream at the
       * position it stopped at instead of advancing behind the reader's back —
       * and a frozen poll performs no disk read at all, so the Activity view
       * (where the Logs pane is not painted) costs zero log I/O per tick.
       */
      function pollLogs(): void {
        // `view()` is the reactive read: the poll belongs to the panel's 1s
        // cycle, which runs whether or not the Logs tab is showing, and the
        // freeze is what a hidden tab costs.
        const live = isLogsViewLive(view(), logsStore.paused);
        // ONE store update per tick: a frozen poll answers the very store it was
        // given, so a tab nobody is looking at publishes nothing.
        const polled = pollLogsStore(logsStore, { hostPaused: !live });
        if (polled.store !== logsStore) publishLogs(polled.store);
      }

      _logsToggleRef = () => {
        const next = nextView(view());
        setView(next);
        // OPENING THE PANE READS NOW. A hidden pane does not poll — a frozen
        // poll performs no read at all — so without this the Logs tab would
        // paint `no records yet` for up to a full second over a log directory
        // full of records: the pane telling the reader something it has not
        // checked. This is the same read the 1s cycle makes, not a second
        // cadence, and it resumes from the frozen cursor, so nothing is
        // repeated and nothing is skipped.
        if (next === "logs") pollLogs();
      };
      _logsPauseRef = () => {
        if (view() !== "logs") return;
        publishLogs(setLogsPaused(logsStore, !logsStore.paused));
      };
      _logsLevelRef = (direction: number) => publishLogs(stepLogsLevel(logsStore, direction));
      _logsChannelRef = () => {
        const available = collectLogChannels(logRecords());
        publishLogs(available.length === 0 ? setLogsChannel(logsStore, "") : cycleLogsChannel(logsStore, available));
      };
      _logsFollowRef = () => {
        // "Follow" is the free-text filter's opposite number: it clears the
        // pane's own narrowing and its pause, so the next poll lands on the
        // newest records — a cursor has nothing to scroll, so this is the whole
        // of "auto-follow" for a tail-style pane.
        setLogFilterText("");
        publishLogs(setLogsPaused(logsStore, false));
      };

      // Task detail panel state
      const [selectedTaskIndex, setSelectedTaskIndex] = createSignal(0);
      const [detailView, setDetailView] = createSignal(false);
      const [detailOffset, setDetailOffset] = createSignal(0);
      const [detailData, setDetailData] = createSignal<TaskDetail | null>(null);

      // Live graph signals, fed from drained graph events for sub-250ms
      // engine-graph signal display:
      //   graphSignals — graphId → most recent ENGINE PHASE (graph_signal only)
      //   nodeSignals  — `${graphId}::${nodeId}` → most recent node status
      const [graphSignals, setGraphSignals] = createSignal<ReadonlyMap<string, string>>(new Map());
      const [nodeSignals, setNodeSignals] = createSignal<ReadonlyMap<string, string>>(new Map());
      let lastGood: MonitorSnapshot | null = null;
      let canceled = false;

      const tc = () => ctx.theme.current as unknown as ThemeColors;

      // ── Helper: read task detail with workspaceDir ──
      function readDetail(taskId: string, offset = 0): void {
        try {
          const result = readTaskDetail(workspaceDir, taskId, offset, DETAIL_SCROLL_STEP);
          setDetailData(result);
        } catch {
          setDetailData(null);
        }
      }

      // ── Health memo (session-scoped) ──
      const health = createMemo<HealthState | null>(() => {
        if (phase() === "loading") return null;
        if (!stateDirPresent()) return "NO_STATE";
        if (phase() === "error" || consecutiveFailures() > 0) return "STALE";
        const snap = snapshot();
        if (!snap) return "IDLE";
        const scope = sessionScope();
        // Filter to current session scope
        const myTasks = snap.tasks.filter((t) => t.sessionId && (scope.has(t.sessionId) || t.sessionId === currentSessionId));
        const myFns = snap.activeFunctions.filter((fn) => scope.has(fn.sessionId));
        const myLoops = snap.loops.filter((l) => scope.has(l.originSessionId) || l.originSessionId === currentSessionId);
        const myGraphs = snap.graphSessions.filter((g) => scope.has(g.sessionId));
        if (
          myTasks.some((t) => t.status === "error" || t.status === "timeout") ||
          myLoops.some((l) => l.errorReason)
        ) {
          return "ERROR";
        }
        if (
          snap.concurrency.active > 0 ||
          snap.dispatchSummary.pending > 0 ||
          snap.dispatchSummary.running > 0 ||
          myLoops.length > 0 ||
          myFns.length > 0 ||
          myGraphs.some((g) => g.status === "active")
        ) {
          return "ACTIVE";
        }
        return "IDLE";
      });

      // ── Sync refresh (1s) — drains live events for sub-250ms updates ──
      function refresh(): void {
        try {
          const present = existsSync(stateDirFor(workspaceDir));
          setStateDirPresent(present);

          // Drain the live event buffer — the 250ms poll in events.ts may have
          // detected new activity before the 1s disk snapshot confirms it.
          const bridge = _eventBridgeRef;
          const liveEvents = bridge ? bridge.buffer.drain() : [];

          const hasErrorEvent = liveEvents.some(
            (e) => e.type === "dispatch_error"
          );

          // Fold graph events into the live-signal maps for engine-graph
          // display: graphSignals carries engine phase only (graph_signal),
          // nodeSignals carries per-node status (`${graphId}::${nodeId}`) from
          // graph_node_start (running) / graph_node_end (terminal status).
          if (liveEvents.some((e) =>
            e.type === "graph_signal" || e.type === "graph_node_start" || e.type === "graph_node_end"
          )) {
            const folded = foldGraphSignals(liveEvents, graphSignals(), nodeSignals());
            setGraphSignals(folded.graphSignals);
            setNodeSignals(folded.nodeSignals);
          }

          const snap = readMonitorSnapshot(workspaceDir);
          if (canceled) return;

          // Live-source merge (monitor S10): overlay the in-memory graph
          // registry over the disk snapshot — live wins by graphId, and the
          // disk-only remainder keeps the stale-terminal gate (so a dead
          // persisted complete graph is never resurrected). On platforms
          // where the engine never persists (opencode), this is what surfaces
          // a running graph at all; on disk platforms it merges the same
          // scan idempotently (live == disk, empty remainder).
          snap.engineGraphs = mergeLiveEngineGraphs(
            snap.engineGraphs,
            readLiveEngineGraphs(stateDirFor(workspaceDir)),
          );
        if (present) {
          lastGood = snap;
          const scope = buildSessionScope(stateDirFor(workspaceDir), currentSessionId);

          // ── Engine-graph dispatch session IDs ──────────────────────────
          // Graph-dispatched tasks get parentSessionId = graphId (via
          // graphParentContext()), so buildSessionScope() can never match
          // them by walking dispatch parent/child sessionId chains.  Engine-
          // graph nodes carry dispatchSessionId on each node that was
          // dispatched; adding those here gives the scope enough precision
          // that the size === 1 fallback (below) becomes a genuine last-
          // resort safety net.
          if (snap.engineGraphs) {
            for (const eg of snap.engineGraphs) {
              if (eg.nodes) {
                for (const node of eg.nodes) {
                  if (node.dispatchSessionId) {
                    scope.add(node.dispatchSessionId);
                  }
                }
              }
            }
          }

          // When no child sessions were discovered (only the current session
          // in scope), widen by collecting every runtime session ID present in
          // the snapshot.  The TUI may be loaded in a session that is not a
          // dispatch parent; without this fallback the scope collapses to
          // {currentSessionId} and every downstream filter drops ALL activity.
          if (scope.size === 1) {
            for (const t of snap.tasks ?? []) {
              if (t.sessionId) scope.add(t.sessionId);
            }
            for (const fn of snap.activeFunctions ?? []) {
              scope.add(fn.sessionId);
            }
            for (const g of snap.graphSessions ?? []) {
              scope.add(g.sessionId);
            }
            for (const l of snap.loops ?? []) {
              scope.add(l.originSessionId);
            }
          }
          setSessionScope(scope);
        }
          setSnapshot(present ? snap : (lastGood ?? snap));

          // If live events flagged an error, force health signal immediately.
          if (hasErrorEvent && consecutiveFailures() === 0) {
            setConsecutiveFailures(1);
            queueMicrotask(() => {
              if (!canceled) setConsecutiveFailures(0);
            });
          } else {
            setConsecutiveFailures(0);
          }

          // The Logs pane rides this same 1s cycle — no second timer. It is
          // polled AFTER the activity snapshot is assembled so the two reads
          // stay in the order the pane's own comments describe, and it never
          // touches the state signals the activity view renders from.
          if (!canceled) pollLogs();

          setPhase("ready");
        } catch {
          if (canceled) return;
          setConsecutiveFailures((n) => n + 1);
          setPhase(lastGood ? "ready" : "error");
        }
      }
      refresh();
      const timer = setInterval(refresh, 1000);

      // ── The Logs pane's change edge ──────────────────────────────────────
      // An append to the log source wakes the pane directly, so a record lands
      // in about the watcher's debounce instead of up to a full second later.
      // The 1s tick above STAYS: pollLogs() is cursor-based, so a tick with
      // nothing new costs one incremental scan and no publication, and it is
      // the only safety net on a platform without fs.watch (where
      // watchLogSource degrades to a no-op disposer).
      //
      // NO EXPLICIT SOURCE, deliberately: readLogView resolves the location
      // through resolveLogSource, and the store's filters.logDir is empty
      // in-tree (no UI path sets it), so the watcher observes exactly what the
      // store reads. The bound is that a programmatically overridden
      // logsStore.filters.logDir is NOT watched — that view falls back to the
      // 1s tick.
      const disposeLogWatch = watchLogSource(undefined, () => pollLogs());

      _refreshRef = refresh;
      _toggleMetricsRef = () => setShowMetrics((v) => !v);
      _toggleFilterRef = () => {
        const next = !filterMode();
        setFilterMode(next);
        if (!next) {
          setFilterText("");
          setFilterStatuses(new Set<string>());
          setFilterSessionId(null);
        }
      };
      _toggleHelpRef = () => setShowHelp((v) => !v);
      _setFilterTextRef = (text: string) => setFilterText(text);

      _toggleStatusFilterRef = (status: string) => {
        setFilterStatuses((prev) => {
          const next = new Set(prev);
          if (next.has(status)) {
            next.delete(status);
          } else {
            next.add(status);
          }
          return next;
        });
      };

      _toggleSessionFilterRef = (sessionId: string | null) => {
        if (filterSessionId() === sessionId) {
          setFilterSessionId(null);
        } else {
          setFilterSessionId(sessionId);
        }
      };

      // ── Persist filter state on change ──
      createEffect(() => {
        const ft = filterText();
        const fss = [...filterStatuses()];
        const fsid = filterSessionId();
        _filterPersistRef?.(ft, fss, fsid);
      });



      onCleanup(() => {
        canceled = true;
        clearInterval(timer);
        disposeLogWatch();
        _refreshRef = null;
        _toggleMetricsRef = null;
        _toggleFilterRef = null;
        _toggleHelpRef = null;
        _setFilterTextRef = null;
        _toggleStatusFilterRef = null;
        _toggleSessionFilterRef = null;
        _logsToggleRef = null;
        _logsPauseRef = null;
        _logsLevelRef = null;
        _logsChannelRef = null;
        _logsFollowRef = null;
        _filterPersistRef = null;
        _eventBridgeRef = null;
        dispose();
      });

      // ── Derived data for Activity component ──
      function activeTasks(): TaskSnapshot[] {
        const snap = snapshot();
        if (!snap) return [];
        const scope = sessionScope();
        return snap.tasks
          .filter((t) => {
            if (t.status !== "running" && t.status !== "pending" && t.status !== "error" && t.status !== "timeout") {
              return false;
            }
            const sid = t.sessionId;
            return sid && (scope.has(sid) || sid === currentSessionId);
          })
          .sort((a, b) => {
            const rank: Record<string, number> = { error: 0, timeout: 0, running: 1, pending: 2 };
            const ra = rank[a.status] ?? 3;
            const rb = rank[b.status] ?? 3;
            if (ra !== rb) return ra - rb;
            if (a.status === "error" || a.status === "timeout") {
              return b.startedAt.localeCompare(a.startedAt);
            }
            return a.startedAt.localeCompare(b.startedAt);
          });
      }

      // ── Compute unfiltered activity data (for total counts in filter bar) ──
      function unfilteredActivityData() {
        const snap = snapshot();
        if (!snap || !stateDirPresent()) return { fns: [], tasks: [], graphs: [], loops: [], engineGraphs: [] };
        const scope = sessionScope();
        return {
          fns: [...snap.activeFunctions].filter((fn) => scope.has(fn.sessionId)),
          tasks: activeTasks(),
          graphs: snap.graphSessions.filter((g) => scope.has(g.sessionId)),
          loops: snap.loops.filter((l) =>
            scope.has(l.originSessionId) || l.originSessionId === currentSessionId,
          ),
          // Engine graphs carry no sessionId — surfaced unfiltered for this session's view.
          engineGraphs: [...snap.engineGraphs],
        };
      }

      function filteredActivityData() {
        const snap = snapshot();
        if (!snap || !stateDirPresent()) return { fns: [], tasks: [], graphs: [], loops: [], engineGraphs: [] };

        const scope = sessionScope();
        const ft = filterText().toLowerCase();
        const filterMatch = (name: string | null | undefined): boolean =>
          ft === "" || (name?.toLowerCase().includes(ft) ?? false);

        // Active functions — text + session filter
        const fns = [...snap.activeFunctions]
          .filter((fn) => {
            if (!scope.has(fn.sessionId)) return false;
            if (filterSessionId() !== null && fn.sessionId !== filterSessionId()) return false;
            return filterMatch(fn.name ?? fn.agentId ?? fn.sessionId);
          })
          .sort((a, b) => {
            const aAgent = a.agentId !== null && a.agentId !== undefined;
            const bAgent = b.agentId !== null && b.agentId !== undefined;
            if (aAgent !== bAgent) return aAgent ? -1 : 1;
            const aGated = a.phase !== "active" && a.phase !== "complete";
            const bGated = b.phase !== "active" && b.phase !== "complete";
            if (aGated !== bGated) return aGated ? -1 : 1;
            if (b.continuationCount !== a.continuationCount) return b.continuationCount - a.continuationCount;
            return (a.name ?? "").localeCompare(b.name ?? "");
          });

        // Tasks — text + status + session filter
        let tasks = activeTasks();
        if (filterSessionId() !== null) {
          tasks = tasks.filter((t) => t.sessionId === filterSessionId());
        }
        const activeStatuses = filterStatuses();
        if (activeStatuses.size > 0) {
          tasks = tasks.filter((t) => activeStatuses.has(t.status));
        }
        tasks = tasks.filter((t) => filterMatch(t.agent));

        // Graphs — text + session filter
        const graphs = snap.graphSessions.filter((g) => {
          if (!scope.has(g.sessionId)) return false;
          if (filterSessionId() !== null && g.sessionId !== filterSessionId()) return false;
          return filterMatch(g.sessionId);
        });

        // Loops — text + session filter
        const loops = snap.loops.filter((l) => {
          if (!(scope.has(l.originSessionId) || l.originSessionId === currentSessionId)) return false;
          if (filterSessionId() !== null && l.originSessionId !== filterSessionId()) return false;
          return filterMatch((l as { fnName?: string }).fnName);
        });

        // Engine graphs — no sessionId to match, so only the text filter applies
        // (scoped to this session's view by the snapshot projection).
        const engineGraphs = snap.engineGraphs.filter((g) => filterMatch(g.graphId));

        return { fns, tasks, graphs, loops, engineGraphs };
      }



      // ── View tab bar ──
      //
      // One short line, always painted, naming the active view. The sidebar
      // shows ONE view at a time and the reader has to be able to tell which
      // one without guessing: a pane that swaps its whole body silently reads
      // as a bug the first time the Logs tab is opened by mistake.
      function renderViewTabs(): JSX.Element {
        const c = tc();
        const active = view();
        return (
          <text>
            <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"view "}</span>
            <span
              fg={rgbaToCSS(active === "activity" ? c.text : c.textMuted)}
              attributes={active === "activity" ? BOLD : DIM}
            >{"activity"}</span>
            <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{" \u00b7 "}</span>
            <span
              fg={rgbaToCSS(active === "logs" ? c.text : c.textMuted)}
              attributes={active === "logs" ? BOLD : DIM}
            >{"logs"}</span>
            {active === "logs" && (
              <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>
                {(logPaused() ? "  paused" : "  live") + "  " + logsStore.filters.minLevel}
              </span>
            )}
          </text>
        );
      }

      // ── Logs pane (view tab `logs`, toggled by the host keymap) ──
      function renderLogsView(): JSX.Element {
        const text = logFilterText().trim().toLowerCase();
        const records = text === ""
          ? logRecords()
          : logRecords().filter((record) => {
              const haystack = [
                record.level,
                record.channel,
                record.message,
                record.code ?? "",
                ...Object.keys(record.scope).map((key) => record.scope[key as keyof typeof record.scope] ?? ""),
              ].join(" ").toLowerCase();
              return haystack.includes(text);
            });
        return renderLogs({
          c: tc(),
          wide: true,
          open: isLogsViewLive(view(), false),
          paused: logPaused(),
          minLevel: logsStore.filters.minLevel,
          channels: logChannels(),
          availableChannels: collectLogChannels(logRecords()),
          source: logSource(),
          records: records.slice(-LOGS_PANE_ROWS),
          skippedLines: logSkipped(),
          shown: records.length,
          total: logRecords().length,
          dropped: logDropped().dropped,
          earlierDropped: logDropped().earlierDropped,
          pending: logPending(),
          error: logError(),
          filterText: logFilterText(),
        });
      }

      // ── Metrics panel ──
      function renderMetricsPanel(): JSX.Element | null {
        if (!showMetrics()) return null;
        const c = tc();
        const snap = snapshot();
        if (!snap) return null;
        const { concurrency, dispatchSummary } = snap;
        const muted = rgbaToCSS(c.textMuted);
        const norm = rgbaToCSS(c.text);
        const info = rgbaToCSS(c.info);
        const warn = rgbaToCSS(c.warning);
        const err = rgbaToCSS(c.error);
        return (
          <box>
            <text>{" ──"}</text>
            <text attributes={BOLD} fg={norm}>{"Dispatch Metrics"}</text>
            <text>
              <span fg={norm}>{"  active: "}</span>
              <span fg={info} attributes={BOLD}>{String(concurrency.active)}</span>
              <span fg={muted}>{"/"}</span>
              <span fg={norm}>{String(concurrency.limit)}</span>
            </text>
            <text><span fg={norm}>{"  queued: "}</span><span fg={warn}>{String(concurrency.queued)}</span></text>
            <text><span fg={norm}>{"  running: "}</span><span fg={info}>{String(dispatchSummary.running)}</span></text>
            <text><span fg={norm}>{"  pending: "}</span><span fg={warn}>{String(dispatchSummary.pending)}</span></text>
            <text><span fg={norm}>{"  completed: "}</span><span fg={rgbaToCSS(c.success)}>{String(dispatchSummary.completed)}</span></text>
            <text><span fg={norm}>{"  errors: "}</span><span fg={err}>{String(dispatchSummary.error)}</span></text>
          </box>
        );
      }

      // ── Filter bar — delegates to FilterBar component ──
      function renderFilterBarComponent(): JSX.Element | null {
        if (!filterMode()) return null;

        const unfiltered = unfilteredActivityData();
        const filtered = filteredActivityData();
        const total = countTotalItems(unfiltered);
        const filteredCount = countTotalItems(filtered);

        const snap = snapshot();
        const allSessions = snap
          ? collectSessionIds(snap.tasks, snap.activeFunctions, snap.graphSessions, snap.loops)
          : [];

        const ft = filterText();
        const fss = filterStatuses();
        const fsid = filterSessionId();

        return renderFilterBar({
          c: tc(),
          filterText: ft,
          activeStatuses: fss,
          sessionFilterId: fsid,
          totalItems: total,
          filteredItems: filteredCount,
          availableSessions: allSessions,
          currentSessionId,
          onToggleStatus: (status) => _toggleStatusFilterRef?.(status),
          onClose: () => _toggleFilterRef?.(),
        });
      }

      // ── Main panel ──
      return (
        <ErrorBoundary
          fallback={<text fg={rgbaToCSS(tc().error)} attributes={DIM_ITALIC}>{"Panel error"}</text>}
        >
          <box paddingX={0} paddingY={0}>
            {renderHeader({
              c: tc(),
              version: PACKAGE_VERSION,
              onRefresh: () => _refreshRef?.(),
              onToggleMetrics: () => _toggleMetricsRef?.(),
              onToggleFilter: () => _toggleFilterRef?.(),
              onToggleHelp: () => _toggleHelpRef?.(),
            })}

            <Show when={phase() !== "loading"} fallback={
              <text fg={rgbaToCSS(tc().textMuted)} attributes={DIM_ITALIC}>{"Loading Rolebox\u2026"}</text>
            }>
              {renderRule({ c: tc() })}
              {(() => {
                const h = health();
                const hd = healthDisplay(h, tc());
                const snap = snapshot();
                const conc = snap?.concurrency;
                const showConc = snap !== null && conc !== undefined &&
                  !(conc.limit === 0 && conc.active === 0 && conc.queued === 0);
                return renderPulse({
                  c: tc(),
                  hd,
                  active: conc?.active ?? 0,
                  limit: conc?.limit ?? 0,
                  queued: conc?.queued ?? 0,
                  showConcurrency: showConc,
                });
              })()}

              {renderViewTabs()}

              {view() === "logs" && renderLogsView()}

              {/* Filter bar (toggled by `f`) — delegates to FilterBar component */}
              {view() === "activity" && renderFilterBarComponent()}
              {/* Dispatch metrics (toggled by `m`) */}
              {view() === "activity" && renderMetricsPanel()}

              {view() === "activity" && health() === "STALE" && renderStaleHint({ c: tc(), isStale: true })}
              {view() === "activity" && !stateDirPresent() && renderNoStateBody({ c: tc(), show: true })}

              {/* When in detail view, show the detail panel instead of activity list */}
              {view() === "activity" && (
              <Show when={detailView() && detailData() !== null} fallback={
                <Show when={snapshot() !== null}>
                  {(() => {
                    const snap = snapshot();
                    const data = filteredActivityData();
                    return renderActivity({
                      c: tc(),
                      ...data,
                      snap,
                      sessionScope: sessionScope(),
                      currentSessionId,
                      graphSignals: graphSignals(),
                      nodeSignals: nodeSignals(),
                      selectedIndex: selectedTaskIndex(),
                      onSelectTask: (index) => setSelectedTaskIndex(index),
                      onOpenDetail: (index) => {
                        const tasks = filteredActivityData().tasks;
                        if (index < tasks.length) {
                          setSelectedTaskIndex(index);
                          setDetailOffset(0);
                          setDetailView(true);
                          readDetail(tasks[index].id, 0);
                        }
                      },
                    });
                  })()}
                </Show>
              }>
                {(() => {
                  const dd = detailData();
                  const idx = selectedTaskIndex();
                  const tasks = filteredActivityData().tasks;
                  return renderTaskDetailPanel({
                    c: tc(),
                    detail: dd!,
                    selectedTask: idx < tasks.length ? tasks[idx] : null,
                    offset: detailOffset(),
                    totalChars: dd?.totalChars ?? 0,
                    onClose: () => { setDetailView(false); setDetailData(null); setDetailOffset(0); },
                    onScrollUp: () => { const newOffset = Math.max(0, detailOffset() - DETAIL_SCROLL_STEP); const dd = detailData(); if (dd) { setDetailOffset(newOffset); readDetail(dd.task.id, newOffset); } },
                    onScrollDown: () => { const newOffset = detailOffset() + DETAIL_SCROLL_STEP; const dd = detailData(); if (dd && newOffset < dd.totalChars) { setDetailOffset(newOffset); readDetail(dd.task.id, newOffset); } },
                  });
                })()}
              </Show>
              )}
            </Show>
          </box>
        </ErrorBoundary>
      );
    });
}
