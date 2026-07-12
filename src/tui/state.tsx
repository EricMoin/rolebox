/**
 * TUI sidebar state management.
 *
 * Creates the SolidJS-reactive sidebar renderer with signals,
 * refresh cycle, health memo, and JSX assembly.
 *
 * Also exposes module-level trigger functions (`triggerRefresh`,
 * `triggerToggleMetrics`, etc.) that the keybindings module uses
 * to drive user-initiated state changes.
 *
 * @module
 */

/** @jsxImportSource @opentui/solid */
import { createSignal, createMemo, createEffect, onCleanup, createRoot, Show, For, ErrorBoundary, type JSX } from "solid-js";
import { existsSync } from "node:fs";
import { stateDirFor } from "../utils/state-paths";
import { readMonitorSnapshot, readTaskDetail } from "../cli/commands/monitor/monitor-reader";
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
} from "./components/index";
import { SHORTCUTS } from "./keybindings";
import type { EventBridge } from "./events";
const PACKAGE_VERSION = readPackageVersion();

// ── Exposed action references for keybindings ───────────────────────────

/**
 * Module-level mutable references that the keybindings module triggers
 * via `triggerRefresh()`, `triggerToggleMetrics()`, etc.
 *
 * Set inside createRoot, cleared on cleanup.
 */
let _refreshRef: (() => void) | null = null;
let _toggleMetricsRef: (() => void) | null = null;
let _toggleFilterRef: (() => void) | null = null;
let _toggleHelpRef: (() => void) | null = null;
let _toggleStatusFilterRef: ((status: string) => void) | null = null;
let _toggleSessionFilterRef: ((sessionId: string | null) => void) | null = null;

// ── Task navigation references ─────────────────────────────────────────
let _selectUpRef: (() => boolean) | null = null;
let _selectDownRef: (() => boolean) | null = null;
let _selectEnterRef: (() => boolean) | null = null;
let _selectEscapeRef: (() => boolean) | null = null;
let _detailScrollDownRef: (() => boolean) | null = null;
let _detailScrollUpRef: (() => boolean) | null = null;
let _detailTopRef: (() => boolean) | null = null;
let _detailBottomRef: (() => boolean) | null = null;

/** Event bridge reference — set during plugin init, cleared on cleanup. */
let _eventBridgeRef: EventBridge | null = null;

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

/** Move task selection up. Returns true if the key was consumed. */
export function triggerSelectUp(): boolean { return _selectUpRef?.() ?? false; }

/** Move task selection down. Returns true if the key was consumed. */
export function triggerSelectDown(): boolean { return _selectDownRef?.() ?? false; }

/** Open detail panel for selected task. Returns true if the key was consumed. */
export function triggerSelectEnter(): boolean { return _selectEnterRef?.() ?? false; }

/** Close detail panel and return to activity list. Returns true if the key was consumed. */
export function triggerSelectEscape(): boolean { return _selectEscapeRef?.() ?? false; }

/** Scroll detail panel content down. Returns true if the key was consumed. */
export function triggerDetailScrollDown(): boolean { return _detailScrollDownRef?.() ?? false; }

/** Scroll detail panel content up. Returns true if the key was consumed. */
export function triggerDetailScrollUp(): boolean { return _detailScrollUpRef?.() ?? false; }

/** Jump detail panel to the top. Returns true if the key was consumed. */
export function triggerDetailTop(): boolean { return _detailTopRef?.() ?? false; }

/** Jump detail panel to the end. Returns true if the key was consumed. */
export function triggerDetailBottom(): boolean { return _detailBottomRef?.() ?? false; }

/** Set the module-level event bridge reference from the plugin entry. */
export function setEventBridgeRef(bridge: EventBridge | null): void {
  _eventBridgeRef = bridge;
}

// ── Detail panel constants ─────────────────────────────────────────────
const DETAIL_SCROLL_STEP = 500;

/**
 * Create the sidebar renderer closure.
 *
 * Returns a function suitable for use as a sidebar_content slot
 */
export function createSidebarRenderer(workspaceDir: string) {
  return (
    ctx: { theme: { current: ThemeColors } },
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

      // Task detail panel state
      const [selectedTaskIndex, setSelectedTaskIndex] = createSignal(0);
      const [detailView, setDetailView] = createSignal(false);
      const [detailOffset, setDetailOffset] = createSignal(0);
      const [detailData, setDetailData] = createSignal<TaskDetail | null>(null);

      // Current session ID — used to filter to only this session's activity
      const currentSessionId = props?.session_id ?? "";
      const [sessionScope, setSessionScope] = createSignal<Set<string>>(new Set([currentSessionId]));
      let lastGood: MonitorSnapshot | null = null;
      let canceled = false;

      const tc = () => ctx.theme.current;

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

          const snap = readMonitorSnapshot(workspaceDir);
          if (canceled) return;
          if (present) {
            lastGood = snap;
            setSessionScope(buildSessionScope(stateDirFor(workspaceDir), currentSessionId));
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

          setPhase("ready");
        } catch {
          if (canceled) return;
          setConsecutiveFailures((n) => n + 1);
          setPhase(lastGood ? "ready" : "error");
        }
      }
      refresh();
      const timer = setInterval(refresh, 1000);

      _refreshRef = refresh;
      _toggleMetricsRef = () => setShowMetrics((v) => !v);
      _toggleFilterRef = () => {
        const next = !filterMode();
        setFilterMode(next);
        if (!next) {
          setFilterText("");
          setFilterStatuses(new Set());
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

      // ── Navigation refs ──
      // Each returns `true` when the key was consumed, `false` to let it propagate.
      _selectUpRef = () => {
        const tasks = filteredActivityData().tasks;
        if (tasks.length === 0) return false;
        setSelectedTaskIndex((i) => Math.max(0, i - 1));
        return true;
      };
      _selectDownRef = () => {
        const tasks = filteredActivityData().tasks;
        if (tasks.length === 0) return false;
        setSelectedTaskIndex((i) => Math.min(tasks.length - 1, i + 1));
        return true;
      };
      _selectEnterRef = () => {
        const tasks = filteredActivityData().tasks;
        const idx = selectedTaskIndex();
        if (tasks.length > 0 && idx < tasks.length) {
          const task = tasks[idx];
          setDetailOffset(0);
          setDetailView(true);
          readDetail(task.id, 0);
          return true;
        }
        return false;
      };
      _selectEscapeRef = () => {
        if (!detailView()) return false;
        setDetailView(false);
        setDetailData(null);
        setDetailOffset(0);
        return true;
      };
      _detailScrollDownRef = () => {
        if (!detailView()) return false;
        setDetailOffset((offset) => {
          const newOffset = offset + DETAIL_SCROLL_STEP;
          const dd = detailData();
          if (dd && newOffset < dd.totalChars) {
            readDetail(dd.task.id, newOffset);
          }
          return newOffset < (dd?.totalChars ?? 0) ? newOffset : offset;
        });
        return true;
      };
      _detailScrollUpRef = () => {
        if (!detailView()) return false;
        setDetailOffset((offset) => {
          const newOffset = Math.max(0, offset - DETAIL_SCROLL_STEP);
          const dd = detailData();
          if (dd) {
            readDetail(dd.task.id, newOffset);
          }
          return newOffset;
        });
        return true;
      };
      _detailTopRef = () => {
        if (!detailView()) return false;
        setDetailOffset(0);
        const dd = detailData();
        if (dd) {
          readDetail(dd.task.id, 0);
        }
        return true;
      };
      _detailBottomRef = () => {
        if (!detailView()) return false;
        const dd = detailData();
        if (dd) {
          const lastOffset = Math.max(0, dd.totalChars - DETAIL_SCROLL_STEP);
          setDetailOffset(lastOffset);
          readDetail(dd.task.id, lastOffset);
        }
        return true;
      };

      onCleanup(() => {
        canceled = true;
        clearInterval(timer);
        _refreshRef = null;
        _toggleMetricsRef = null;
        _toggleFilterRef = null;
        _toggleHelpRef = null;
        _setFilterTextRef = null;
        _toggleStatusFilterRef = null;
        _toggleSessionFilterRef = null;
        _filterPersistRef = null;
        _selectUpRef = null;
        _selectDownRef = null;
        _selectEnterRef = null;
        _selectEscapeRef = null;
        _detailScrollDownRef = null;
        _detailScrollUpRef = null;
        _detailTopRef = null;
        _detailBottomRef = null;
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
        if (!snap || !stateDirPresent()) return { fns: [], tasks: [], graphs: [], loops: [] };
        const scope = sessionScope();
        return {
          fns: [...snap.activeFunctions].filter((fn) => scope.has(fn.sessionId)),
          tasks: activeTasks(),
          graphs: snap.graphSessions.filter((g) => scope.has(g.sessionId)),
          loops: snap.loops.filter((l) =>
            scope.has(l.originSessionId) || l.originSessionId === currentSessionId,
          ),
        };
      }

      function filteredActivityData() {
        const snap = snapshot();
        if (!snap || !stateDirPresent()) return { fns: [], tasks: [], graphs: [], loops: [] };

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
          return filterMatch(l.fnName);
        });

        return { fns, tasks, graphs, loops };
      }

      // ── Help overlay ──
      function renderShortcutHelp(): JSX.Element | null {
        if (!showHelp()) return null;
        const c = tc();
        const muted = rgbaToCSS(c.textMuted);
        const norm = rgbaToCSS(c.text);
        return (
          <box>
            <text>{" ──"}</text>
            <text attributes={BOLD} fg={norm}>{"Keyboard Shortcuts"}</text>
            <For each={SHORTCUTS}>
              {(shortcut) => (
                <text>
                  <span fg={rgbaToCSS(c.info)} attributes={BOLD}>{"  " + shortcut.key}</span>
                  <span fg={muted} attributes={DIM}>{"  " + shortcut.description}</span>
                </text>
              )}
            </For>
          </box>
        );
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
            <text><span fg={norm}>{"  errors: "}</span><span fg={err}>{String(dispatchSummary.errors)}</span></text>
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
        });
      }

      // ── Main panel ──
      return (
        <ErrorBoundary
          fallback={<text fg={rgbaToCSS(tc().error)} attributes={DIM_ITALIC}>{"Panel error"}</text>}
        >
          <box paddingX={1} paddingY={1}>
            {renderHeader({ c: tc(), version: PACKAGE_VERSION })}

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

              {/* Filter bar (toggled by `f`) — delegates to FilterBar component */}
              {renderFilterBarComponent()}

              {/* Keyboard shortcut help (toggled by `?`) */}
              {renderShortcutHelp()}

              {/* Dispatch metrics (toggled by `m`) */}
              {renderMetricsPanel()}

              <Show when={health() === "STALE"}>
                {renderStaleHint({ c: tc(), isStale: true })}
              </Show>
              <Show when={!stateDirPresent()}>
                {renderNoStateBody({ c: tc(), show: true })}
              </Show>

              {/* When in detail view, show the detail panel instead of activity list */}
              <Show when={detailView() && detailData() !== null} fallback={
                <Show when={snapshot() !== null}>
                  <text>{" "}</text>
                  {(() => {
                    const snap = snapshot();
                    const data = filteredActivityData();
                    return renderActivity({
                      c: tc(),
                      ...data,
                      snap,
                      sessionScope: sessionScope(),
                      currentSessionId,
                      selectedIndex: selectedTaskIndex(),
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
                  });
                })()}
              </Show>
            </Show>
          </box>
        </ErrorBoundary>
      );
    });
}
