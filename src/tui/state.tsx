/**
 * TUI sidebar state management.
 *
 * Creates the SolidJS-reactive sidebar renderer with signals,
 * refresh cycle, health memo, and JSX assembly.
 *
 * @module
 */

/** @jsxImportSource @opentui/solid */
import { createSignal, createMemo, onCleanup, createRoot, Show, ErrorBoundary } from "solid-js";
import { existsSync } from "node:fs";
import { stateDirFor } from "../utils/state-paths";
import { readMonitorSnapshot } from "../cli/commands/monitor/monitor-reader";
import type {
  MonitorSnapshot,
  TaskSnapshot,
  ActiveFunction,
} from "../cli/commands/monitor/monitor-reader";
import {
  type ThemeColors, type HealthState,
  rgbaToCSS, BOLD, DIM, DIM_ITALIC, REFRESH_MS,
  readPackageVersion, buildSessionScope, agentLeaf, agentRoot,
} from "./helpers";
import {
  renderHeader, renderRule,
  renderPulse, healthDisplay, renderStaleHint, renderNoStateBody,
  renderActivity,
} from "./components/index";

const PACKAGE_VERSION = readPackageVersion();

/**
 * Create the sidebar renderer closure.
 *
 * Returns a function suitable for use as a sidebar_content slot
 * renderer. The closure holds all reactive state (signals, timers,
 * computed health) and produces JSX output.
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
      // Current session ID — used to filter to only this session's activity
      const currentSessionId = props?.session_id ?? "";
      const [sessionScope, setSessionScope] = createSignal<Set<string>>(new Set([currentSessionId]));
      let lastGood: MonitorSnapshot | null = null;
      let canceled = false;

      const tc = () => ctx.theme.current;

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

      // ── Sync refresh ──
      function refresh(): void {
        try {
          const present = existsSync(stateDirFor(workspaceDir));
          setStateDirPresent(present);
          const snap = readMonitorSnapshot(workspaceDir);
          if (canceled) return;
          if (present) {
            lastGood = snap;
            setSessionScope(buildSessionScope(stateDirFor(workspaceDir), currentSessionId));
          }
          setSnapshot(present ? snap : (lastGood ?? snap));
          setConsecutiveFailures(0);
          setPhase("ready");
        } catch {
          if (canceled) return;
          setConsecutiveFailures((n) => n + 1);
          setPhase(lastGood ? "ready" : "error");
        }
      }

      refresh();
      const timer = setInterval(refresh, REFRESH_MS);

      onCleanup(() => {
        canceled = true;
        clearInterval(timer);
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

      function filteredActivityData() {
        const snap = snapshot();
        if (!snap || !stateDirPresent()) return { fns: [], tasks: [], graphs: [], loops: [] };

        const scope = sessionScope();
        const fns = [...snap.activeFunctions]
          .filter((fn) => scope.has(fn.sessionId))
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
        const tasks = activeTasks();
        const graphs = snap.graphSessions.filter((g) => scope.has(g.sessionId));
        const loops = snap.loops.filter((l) => scope.has(l.originSessionId) || l.originSessionId === currentSessionId);

        return { fns, tasks, graphs, loops };
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
              <Show when={health() === "STALE"}>
                {renderStaleHint({ c: tc(), isStale: true })}
              </Show>
              <Show when={!stateDirPresent()}>
                {renderNoStateBody({ c: tc(), show: true })}
              </Show>

              {/* Live activity — agent-centric, no section headers */}
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
                  });
                })()}
              </Show>
            </Show>
          </box>
        </ErrorBoundary>
      );
    });
}
