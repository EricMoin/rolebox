/**
 * rolebox — TUI sidebar plugin (activity-first redesign)
 *
 * Cross-process state bridge: reads on-disk state (.rolebox/state/*.json,
 * role.yaml directories) via the synchronous `readMonitorSnapshot()` reader.
 *
 * Registers into the built-in `sidebar_content` host slot. The panel
 * auto-refreshes every 3s and shows a LIVE ACTIVITY VIEW of what the
 * rolebox agent system is doing right now:
 *
 *   - Which role has a function active (role | function turn N)
 *   - Which agents have been dispatched and their status (▸ running, ● queued, ✗ error)
 *   - Graph execution progress (nodes with ✓/▸/● status)
 *   - Loop round progress (N/M + bar)
 *
 * No section headers for absent things. No abstract counts. Just the
 * current activity, agent-centric, triage-sorted. When idle, the panel
 * collapses to the pulse.
 *
 * Visual vocabulary adapted from the CLI dashboard (monitor.ts).
 */

/** @jsxImportSource @opentui/solid */
import { createSignal, createMemo, onCleanup, createRoot, Show, For, ErrorBoundary } from "solid-js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { TextAttributes } from "@opentui/core";
import type { RGBA } from "@opentui/core";
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { readMonitorSnapshot } from "../cli/commands/monitor-reader.ts";
import { stateDirFor } from "../state-paths.ts";
import type {
  MonitorSnapshot,
  TaskSnapshot,
  ActiveFunction,
  LoopSnapshot,
  GraphSessionSnapshot,
} from "../cli/commands/monitor-reader.ts";

// ── Types ────────────────────────────────────────────────────────────────

type ThemeColors = Record<string, RGBA>;
type HealthState = "ACTIVE" | "IDLE" | "NO_STATE" | "STALE" | "ERROR";

// ── Constants ────────────────────────────────────────────────────────────

const REFRESH_MS = 1000;
const MAX_DISPATCH_ROWS = 6;
const MAX_GRAPH_ROWS = 2;
const MAX_LOOP_ROWS = 3;
const MAX_FN_ROWS = 4;
const BAR_WIDTH = 6;
const RULE_WIDTH = 36;
const STUCK_THRESHOLD_MS = 300_000;

const BOLD = TextAttributes.BOLD;
const DIM = TextAttributes.DIM;
const ITALIC = TextAttributes.ITALIC;
const DIM_ITALIC = DIM | ITALIC;

// ── Glyphs ───────────────────────────────────────────────────────────────

const G_RUNNING  = "\u25b8"; // ▸
const G_PENDING  = "\u25cf"; // ●
const G_ERROR    = "\u2717"; // ✗
const G_DONE     = "\u2713"; // ✓
const G_CANCEL   = "\u25cb"; // ○
const G_TIMEOUT  = "\u25c7"; // ◇
const G_FN       = "\u2192"; // →
const G_GATED    = "\u23f8"; // ⏸
const G_BAR_ON   = "\u25a0"; // ■
const G_BAR_OFF  = "\u25a1"; // □
const G_SUB      = "\u2514\u2500"; // └─
const G_RULE     = "\u2500"; // ─

// ── Truncation / wrapping ───────────────────────────────────────────────
//
// <text> in opentui does NOT auto-wrap. Rather than hard-truncating every
// field to a fixed width (which loses information), we take a hybrid
// approach:
//   - Short fields (agent name, function name, node name) are rarely long
//     enough to overflow — we don't truncate them at all.
//   - Long fields (error reason, description) are rendered on a SECOND line
//     with a └─ prefix, so the full text is visible without horizontal overflow.
//   - Session IDs use shortSessionId() which keeps them compact.

const LEN_VERSION  = 8;
const LEN_DUR      = 8;

/** Wrap a long string into lines of at most `width` chars. */
function wrapText(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > width) {
    // Try to break at a space near the width boundary
    let breakAt = remaining.lastIndexOf(" ", width);
    if (breakAt <= 0) breakAt = width;
    lines.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining.length > 0) lines.push(remaining);
  return lines;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function rgbaToCSS(c: RGBA): string {
  return `rgb(${c.r},${c.g},${c.b})`;
}

function readPackageVersion(): string {
  try {
    const dir = import.meta.dirname;
    if (dir) {
      const pkgPath = join(dir, "..", "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8") as string) as Record<string, unknown>;
        return (pkg.version as string) ?? "?";
      }
    }
  } catch { /* swallow */ }
  return "?";
}

const PACKAGE_VERSION = readPackageVersion();



/** Extract the leaf agent name from a "--"-scoped path. */
function agentLeaf(agent: string): string {
  const parts = agent.split(/--|\//);
  return parts[parts.length - 1] ?? agent;
}

/** Extract the ROOT agent name (first segment before --). */
function agentRoot(agent: string): string {
  const parts = agent.split(/--|\//);
  return parts[0] ?? agent;
}

function shortSessionId(id: string): string {
  if (id.length <= 12) return id;
  return "\u2026" + id.slice(-8);
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "\u2026" : s;
}

/**
 * Build a set of session IDs that belong to the given parent session.
 * Reads raw dispatch-*.json files (which contain parentSessionId, unlike
 * the MonitorSnapshot which strips it) and collects all childSessionIds
 * where parentSessionId === currentSessionId.
 *
 * Also includes the currentSessionId itself (for functions activated
 * directly in the primary session).
 */
function buildSessionScope(stateDir: string, currentSessionId: string): Set<string> {
  const scope = new Set<string>([currentSessionId]);
  try {
    for (const f of readdirSync(stateDir)) {
      if (!f.startsWith("dispatch-") || !f.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(readFileSync(join(stateDir, f), "utf-8") as string) as {
          tasks?: Array<{ parentSessionId?: string; sessionId?: string }>;
        };
        for (const t of raw.tasks ?? []) {
          if (t.parentSessionId === currentSessionId && t.sessionId) {
            scope.add(t.sessionId);
          }
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* dir missing */ }
  return scope;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function barSegments(current: number, total: number, width = BAR_WIDTH): { filled: number; empty: number } {
  if (total <= 0) return { filled: 0, empty: width };
  const filled = Math.max(0, Math.min(width, Math.round((current / total) * width)));
  return { filled, empty: width - filled };
}

/** Status glyph + color for a task. */
function statusVisual(status: string, c: ThemeColors): { glyph: string; color: RGBA } {
  switch (status) {
    case "running":   return { glyph: G_RUNNING, color: c.info };
    case "pending":   return { glyph: G_PENDING, color: c.warning };
    case "error":     return { glyph: G_ERROR,   color: c.error };
    case "completed": return { glyph: G_DONE,    color: c.success };
    case "cancelled": return { glyph: G_CANCEL,  color: c.textMuted };
    case "timeout":   return { glyph: G_TIMEOUT, color: c.secondary };
    default:          return { glyph: "?",       color: c.text };
  }
}

// ── Sidebar Content Renderer ────────────────────────────────────────────

function createSidebarRenderer(workspaceDir: string) {
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
          if (present) lastGood = snap;
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

      // ── Health display ──
      function healthDisplay():
        | { glyph: string; label: string; color: RGBA; glyphBold: boolean; labelBold: boolean }
        | null {
        const h = health();
        if (h === null) return null;
        const c = tc();
        switch (h) {
          case "ACTIVE":  return { glyph: G_RUNNING, label: "ACTIVE",  color: c.info,    glyphBold: true,  labelBold: true };
          case "IDLE":    return { glyph: G_PENDING, label: "IDLE",    color: c.warning, glyphBold: false, labelBold: true };
          case "ERROR":   return { glyph: G_ERROR,   label: "ERROR",   color: c.error,   glyphBold: true,  labelBold: true };
          case "NO_STATE":return { glyph: G_ERROR,   label: "NO STATE",color: c.error,   glyphBold: true,  labelBold: true };
          case "STALE":   return { glyph: G_ERROR,   label: "STALE",   color: c.error,   glyphBold: true,  labelBold: true };
        }
      }

      // ── Active tasks for this session (triage-sorted) ──
      function activeTasks(): TaskSnapshot[] {
        const snap = snapshot();
        if (!snap) return [];
        const scope = sessionScope();
        return snap.tasks
          .filter((t) => {
            if (t.status !== "running" && t.status !== "pending" && t.status !== "error" && t.status !== "timeout") {
              return false;
            }
            // Task belongs to this session if its sessionId is in scope
            // (child session dispatched by current session) or is the current session itself
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

      // ── Render: Header ──
      function renderHeader() {
        const c = tc();
        return (
          <text>
            <span fg={rgbaToCSS(c.primary)} attributes={BOLD}>{"Rolebox"}</span>
            <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{" v" + truncate(PACKAGE_VERSION, LEN_VERSION)}</span>
          </text>
        );
      }

      // ── Render: Rule ──
      function renderRule() {
        const c = tc();
        return <text fg={rgbaToCSS(c.borderSubtle)} attributes={DIM}>{G_RULE.repeat(RULE_WIDTH)}</text>;
      }

      // ── Render: Pulse ──
      function renderPulse() {
        const hd = healthDisplay();
        if (!hd) return null;
        const c = tc();
        const snap = snapshot();
        const conc = snap?.concurrency;
        const showConc = snap !== null && conc !== undefined &&
          !(conc.limit === 0 && conc.active === 0 && conc.queued === 0);

        return (
          <text>
            <span fg={rgbaToCSS(hd.color)} attributes={hd.glyphBold ? BOLD : 0}>{hd.glyph}</span>
            <span fg={rgbaToCSS(hd.color)} attributes={hd.labelBold ? BOLD : 0}>{" " + hd.label}</span>
            {showConc && conc && (
              <>
                <span fg={rgbaToCSS(c.text)}>{"  "}</span>
                <span fg={rgbaToCSS(c.info)}>{String(conc.active)}</span>
                <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"/"}</span>
                <span fg={rgbaToCSS(c.text)}>{String(conc.limit)}</span>
                {conc.queued > 0 && (
                  <>
                    <span fg={rgbaToCSS(c.text)}>{" "}</span>
                    <span fg={rgbaToCSS(c.warning)}>{String(conc.queued)}</span>
                    <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"q"}</span>
                  </>
                )}
              </>
            )}
          </text>
        );
      }

      function renderStaleHint() {
        if (health() !== "STALE") return null;
        const c = tc();
        return <text fg={rgbaToCSS(c.textMuted)} attributes={DIM_ITALIC}>{"data may be outdated"}</text>;
      }

      function renderNoStateBody() {
        if (stateDirPresent()) return null;
        const c = tc();
        return (
          <>
            <text fg={rgbaToCSS(c.textMuted)} attributes={DIM_ITALIC}>{"No .rolebox/state found"}</text>
            <text fg={rgbaToCSS(c.textMuted)} attributes={DIM_ITALIC}>{"Run rolebox to init"}</text>
          </>
        );
      }

      // ── Render: Activity (the core — agent-centric live view) ──

      function renderActivity() {
        const snap = snapshot();
        if (!snap || !stateDirPresent()) return null;

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

        // Nothing active → suppress entirely
        if (fns.length === 0 && tasks.length === 0 && graphs.length === 0 && loops.length === 0) {
          return null;
        }

        return (
          <box marginBottom={1}>
            {/* Active functions: "role | function turn N" or just "|function|" */}
            {fns.length > 0 && (
              <For each={fns.slice(0, MAX_FN_ROWS)}>{(fn) => renderFunctionLine(fn)}</For>
            )}

            {/* Active dispatches: "  ▸ agent duration  description" */}
            {tasks.length > 0 && (
              <>
                {fns.length > 0 && <text>{" "}</text>}
                <For each={tasks.slice(0, MAX_DISPATCH_ROWS)}>{(task) => renderDispatchRow(task)}</For>
                {tasks.length > MAX_DISPATCH_ROWS && (
                  <text fg={rgbaToCSS(tc().textMuted)} attributes={DIM}>{"  +" + (tasks.length - MAX_DISPATCH_ROWS) + " more"}</text>
                )}
              </>
            )}

            {/* Active graphs: "graph · orchestrator  iter N" + node status line */}
            {graphs.length > 0 && (
              <>
                {(fns.length > 0 || tasks.length > 0) && <text>{" "}</text>}
                <For each={graphs.slice(0, MAX_GRAPH_ROWS)}>{(graph) => renderGraphActivity(graph, snap)}</For>
              </>
            )}

            {/* Active loops: "loop · agent N/M ■■□□□□" */}
            {loops.length > 0 && (
              <>
                {(fns.length > 0 || tasks.length > 0 || graphs.length > 0) && <text>{" "}</text>}
                <For each={loops.slice(0, MAX_LOOP_ROWS)}>{(loop) => renderLoopActivity(loop)}</For>
              </>
            )}
          </box>
        );
      }

      // ── Function line: "role | function turn N" or "|function| turn N" ──
      function renderFunctionLine(fn: ActiveFunction) {
        const c = tc();
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

      // ── Dispatch row: "  ▸ agent duration  description" ──
      // Long descriptions/errors wrap to a └─ sub-line instead of truncating.
      function renderDispatchRow(task: TaskSnapshot) {
        const c = tc();
        const snap = snapshot();
        const sv = statusVisual(task.status, c);
        const agent = agentLeaf(task.agent ?? "");

        if (task.status === "running") {
          const snapTime = snap?.timestamp ? new Date(snap.timestamp).getTime() : Date.now();
          const elapsed = snapTime - new Date(task.startedAt ?? 0).getTime();
          const dur = formatDuration(elapsed);
          const stuck = elapsed > STUCK_THRESHOLD_MS;
          const desc = task.description ?? null;
          return (
            <>
              <text>
                <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"  "}</span>
                <span fg={rgbaToCSS(sv.color)}>{sv.glyph}</span>
                <span fg={rgbaToCSS(c.text)}>{" " + agent + " "}</span>
                <span fg={rgbaToCSS(stuck ? c.warning : c.textMuted)} attributes={stuck ? 0 : DIM}>{dur}</span>
                {desc && <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"  " + desc}</span>}
              </text>
            </>
          );
        }

        if (task.status === "pending") {
          return (
            <text>
              <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"  "}</span>
              <span fg={rgbaToCSS(sv.color)}>{sv.glyph}</span>
              <span fg={rgbaToCSS(c.text)}>{" " + agent + " "}</span>
              <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"queued"}</span>
            </text>
          );
        }

        if (task.status === "error") {
          const reason = (task.description ?? task.error ?? "").trim();
          return (
            <>
              <text>
                <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"  "}</span>
                <span fg={rgbaToCSS(sv.color)}>{sv.glyph}</span>
                <span fg={rgbaToCSS(c.text)}>{" " + agent}</span>
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
            <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"  "}</span>
            <span fg={rgbaToCSS(sv.color)}>{sv.glyph}</span>
            <span fg={rgbaToCSS(c.text)}>{" " + agent + " "}</span>
            <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{dur}</span>
          </text>
        );
      }

      // ── Graph activity: "graph · orchestrator  iter N" + node status ──
      function renderGraphActivity(graph: GraphSessionSnapshot, snap: MonitorSnapshot) {
        const c = tc();
        // agentId might be a session ID; if so, shorten it
        const rawAgent = graph.agentId ?? "(unknown)";
        const orch = rawAgent.startsWith("ses_") ? shortSessionId(rawAgent) : rawAgent;
        const iter = graph.iterationCount > 0 ? " iter " + graph.iterationCount : "";

        // Build node status: completed → ✓, frontier → ● (or ▸ if matching a running task)
        const allNodes = [...graph.completed, ...graph.frontier];
        const scope = sessionScope();
        const runningAgents = new Set(
          snap.tasks
            .filter((t) => t.status === "running" && t.sessionId && (scope.has(t.sessionId) || t.sessionId === currentSessionId))
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

      // ── Loop activity: "loop · agent N/M ■■□□□□" ──
      function renderLoopActivity(loop: LoopSnapshot) {
        const c = tc();
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



      // ── Main panel ──
      return (
        <ErrorBoundary
          fallback={<text fg={rgbaToCSS(tc().error)} attributes={DIM_ITALIC}>{"Panel error"}</text>}
        >
          <box paddingX={1} paddingY={1}>
            {renderHeader()}

            <Show when={phase() !== "loading"} fallback={
              <text fg={rgbaToCSS(tc().textMuted)} attributes={DIM_ITALIC}>{"Loading Rolebox\u2026"}</text>
            }>
              {renderRule()}
              {renderPulse()}
              <Show when={health() === "STALE"}>{renderStaleHint()}</Show>
              <Show when={!stateDirPresent()}>{renderNoStateBody()}</Show>

              {/* Live activity — agent-centric, no section headers */}
              <Show when={snapshot() !== null}>
                <text>{" "}</text>
                {renderActivity()}
              </Show>


            </Show>
          </box>
        </ErrorBoundary>
      );
    });
}

// ── TUI Plugin ──────────────────────────────────────────────────────────

const roleboxTuiPlugin: TuiPlugin = async (api, _options, _meta) => {
  const workspaceDir = api.state.path.directory;
  api.slots.register({
    slots: {
      sidebar_content: createSidebarRenderer(workspaceDir),
    },
  });
};

const tuiPluginModule: TuiPluginModule = {
  id: "rolebox-tui",
  tui: roleboxTuiPlugin,
};

export default tuiPluginModule;
