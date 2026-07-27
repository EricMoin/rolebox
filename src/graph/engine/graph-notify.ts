/**
 * Graph Engine — Node-Completion Notifier (subtask 2)
 *
 * A notifier factory that plugs into the engine's `onNodeCompletion` DI seam
 * (see {@link AdvanceEngineOptions.onNodeCompletion} in `engine-advance.ts`).
 * When a graph node reaches a terminating / notable transition, the notifier
 * injects a `<system-reminder>` into the emperor's session so the orchestrator
 * can perceive node completion.
 *
 * Background — why not `notifyParent`: a graph node's dispatch carries no
 * emperor-scoped {@link DispatchTask}. `graphParentContext`
 * (`dispatch-bridge.ts`) deliberately places `sessionID = graphId` to scope
 * request-budget tracking per graph, so `notifyParent` would try to inject into
 * a nonexistent graph-ID session. This notifier therefore sends directly via
 * `ISessionClient.prompt(emperorSessionId, …)` and reuses the dispatch
 * notification *discipline* (markers + per-session send queue + dedupe) rather
 * than `notifyParent`.
 *
 * The reminder uses {@link GRAPH_COMPLETION_MARKER}, which is a member of
 * {@link DISPATCH_NOTIFICATION_MARKERS}, so the chat.message hook classifies the
 * injected text as a non-user turn — it must NOT reset the auto-continue counter.
 *
 * Dedupe: per notifier-run epoch, keyed by `graphId::nodeId::signalType`, with
 * the node's `startedAt` folded in so a genuine loop re-entry (fresh `startedAt`)
 * legally re-notifies while an idempotent replay of the same transition is
 * dropped. The per-run scope means a freshly created notifier starts a clean
 * epoch.
 *
 * Notification logic never lives in the engine — this is a pure consumer of the
 * role-agnostic completion seam, exactly like {@link NodeDispatchPort}.
 */

import type { ISessionClient } from "../../platform/ports/session-client.ts";
import { createSubLogger } from "../../logger.ts";
import { metrics } from "../../dispatch/persistence/metrics.ts";
import {
  enqueueNotify,
  GRAPH_COMPLETION_MARKER,
  GRAPH_COMPLETE_MARKER,
  GRAPH_BLOCKED_MARKER,
} from "../../dispatch/notification.ts";
import type {
  NodeCompletionEvent,
  GraphTerminalEvent,
} from "./engine-advance.ts";

const log = createSubLogger("graph:notify");

// ── Options ─────────────────────────────────────────────────────────────────

export interface GraphNotifierOptions {
  /**
   * Master switch. Default `true`. When `false`, the notifier is a strict
   * no-op (opt-out without rewiring the engine seam).
   */
  enabled?: boolean;
  /**
   * Emperor session id to inject reminders into. When absent, the notifier is
   * a no-op (safe default when no orchestrator session is available).
   */
  emperorSessionId?: string;
  /** Optional agent tag for the injected prompts (forwarded to prompt). */
  agent?: string;
}

/**
 * The completion handler the factory returns. It satisfies the engine seam
 * `(event: NodeCompletionEvent) => void` structurally (a return value is
 * ignored by the seam); the resolved boolean tells the caller whether a
 * notification was dispatched (`true`) or suppressed by opt-out / dedupe /
 * missing session (`false`), which makes it awaitable in tests.
 */
export type GraphCompletionHandler = (event: NodeCompletionEvent) => Promise<boolean>;

// ── Dedupe key ──────────────────────────────────────────────────────────────

/**
 * Per-run dedupe key. Base is `graphId::nodeId::signalType` (per the subtask
 * contract); the node's `startedAt` is folded in so a loop re-entry — a fresh
 * execution with a new `startedAt` — is treated as a distinct key and legally
 * re-notifies, while an idempotent replay of the same transition is dropped.
 */
function dedupeKey(event: NodeCompletionEvent): string {
  return `${event.graphId}::${event.nodeId}::${event.signalType}::${event.startedAt ?? ""}`;
}

// ── Reminder text ───────────────────────────────────────────────────────────

/** Format an epoch-ms duration as a compact human-readable string. */
export function formatGraphDuration(startedAt?: number, completedAt?: number): string {
  if (startedAt === undefined || completedAt === undefined) return "?";
  const ms = completedAt - startedAt;
  if (ms < 0) return "0s";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/**
 * Build the `<system-reminder>` text for a completed graph node, following the
 * same XML style as the dispatch notifications. Contains the graph id, node id,
 * agent, status, signal, and duration.
 */
export function buildGraphCompletionText(event: NodeCompletionEvent): string {
  const duration = formatGraphDuration(event.startedAt, event.completedAt);
  return [
    "<system-reminder>",
    GRAPH_COMPLETION_MARKER,
    `**Graph:** ${event.graphId}`,
    `**Node:** ${event.nodeId}`,
    `**Agent:** ${event.nodeAgent || "N/A"}`,
    `**Status:** ${event.nodeStatus}`,
    `**Signal:** ${event.signalType}`,
    `**Duration:** ${duration}`,
    "",
    `Use graph_status(graph_id="${event.graphId}", node_id="${event.nodeId}", include_output=true) to inspect the node result.`,
    "</system-reminder>",
  ].join("\n");
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a graph node-completion notifier wired to the `onNodeCompletion` seam.
 *
 * ```
 * const engine = createEngine(decl, graphId, {
 *   ...opts,
 *   onNodeCompletion: createGraphNotifier(sessionClient, {
 *     emperorSessionId: "emperor-session-id",
 *   }),
 * });
 * ```
 *
 * @returns a handler that is a no-op (resolves `false`) when disabled or when
 *   no emperor session is configured, drops idempotent replays (resolves
 *   `false`), and otherwise enqueues the reminder to the emperor session via
 *   the per-session serialized send queue (resolves the queue's result).
 */
export function createGraphNotifier(
  client: ISessionClient,
  opts: GraphNotifierOptions = {},
): GraphCompletionHandler {
  const enabled = opts.enabled !== false;
  const emperorSessionId = opts.emperorSessionId;
  // Per-run epoch: a fresh notifier starts a clean dedupe epoch.
  const notified = new Set<string>();

  return async (event: NodeCompletionEvent): Promise<boolean> => {
    if (!enabled) return false;
    if (!emperorSessionId) return false;

    const key = dedupeKey(event);
    if (notified.has(key)) return false;
    notified.add(key);

    const text = buildGraphCompletionText(event);
    return enqueueNotify(emperorSessionId, async () => {
      try {
        await client.prompt(emperorSessionId, {
          ...(opts.agent ? { agent: opts.agent } : {}),
          parts: [{ type: "text", text }],
          noReply: true,
        });
        metrics.counter("graph_notify_sent_total").inc();
        return true;
      } catch (err) {
        metrics.counter("graph_notify_failed_total").inc();
        log.warn(
          `Failed to notify emperor session ${emperorSessionId} about graph node ${event.graphId}::${event.nodeId}`,
          err instanceof Error ? err.message : String(err),
        );
        return false;
      }
    });
  };
}

// ── Graph-Terminal Notifier ──────────────────────────────────────────────────

/**
 * The graph-terminal handler the factory returns. Satisfies the engine seam
 * `(event: GraphTerminalEvent) => void` structurally; the resolved boolean tells
 * the caller whether a notification was dispatched (`true`) or suppressed.
 */
export type GraphTerminalHandler = (event: GraphTerminalEvent) => Promise<boolean>;

/** Per-run dedupe key: `graphId::terminalType` (complete / blocked). */
function terminalDedupeKey(event: GraphTerminalEvent): string {
  return `${event.graphId}::${event.isBlocked ? "blocked" : "complete"}`;
}

/**
 * Build the `<system-reminder>` text for a graph-terminal event.
 *
 * Uses {@link GRAPH_COMPLETE_MARKER} when the graph reached COMPLETE phase, and
 * {@link GRAPH_BLOCKED_MARKER} when the graph is quiescent-blocked. Both markers
 * are members of {@link DISPATCH_NOTIFICATION_MARKERS} so the chat.message hook
 * classifies them as non-user turns.
 *
 * Content: graph_id, phase, node status summary counts, and an instruction
 * to read results via `graph_status`. BLOCKED adds an approval instruction.
 */
export function buildGraphTerminalText(event: GraphTerminalEvent): string {
  const marker = event.isBlocked ? GRAPH_BLOCKED_MARKER : GRAPH_COMPLETE_MARKER;
  const { completed, escalate, timeout, blocked, running } = event.nodeStatusSummaries;

  const lines = [
    "<system-reminder>",
    marker,
    `**Graph:** ${event.graphId}`,
    `**Phase:** ${event.phase}`,
    `**Node Status Summary:**`,
    `  - Completed: ${completed}`,
    `  - Escalated: ${escalate}`,
    `  - Timed Out: ${timeout}`,
    `  - Blocked: ${blocked}`,
    `  - Running: ${running}`,
    "",
  ];

  if (event.isBlocked) {
    lines.push(
      `The graph is quiescent-blocked — no active nodes remain but one or more nodes await approval.`,
      `Inspect blocked node(s) via graph_status(graph_id="${event.graphId}", status="blocked", include_output=true)`,
      `and use graph_approve(graph_id="${event.graphId}", node_id="<blocked_node_id>", action="approve")`,
      `to resume, or action="reject" with a reason to re-enter the node for revision.`,
      "",
      `Read all results via graph_status(graph_id="${event.graphId}", include_output=true).`,
    );
  } else {
    lines.push(
      `Read all results via graph_status(graph_id="${event.graphId}", include_output=true).`,
    );
  }

  lines.push("</system-reminder>");
  return lines.join("\n");
}

/**
 * Create a graph-terminal notifier wired to the engine's `onGraphTerminal` seam.
 *
 * Follows the same session-client injection + dedupe + failure-logging pattern
 * as {@link createGraphNotifier}, EXCEPT it injects with `noReply: false` so the
 * terminal reminder wakes the orchestrator (per-node completions stay silent).
 * Dedupe is per terminal type (complete / blocked)
 * per graph, per notifier run epoch — a blocked-then-resumed-then-completed graph
 * fires two distinct messages, but a second idempotent fire of the same type is
 * dropped. Per-loop-graph re-entry (separate `graph_run`) creates a fresh
 * notifier with a clean dedupe epoch.
 *
 * @returns a handler that is a no-op when disabled or when no emperor session is
 *   configured, drops idempotent replays, and otherwise enqueues the reminder.
 */
export function createGraphTerminalNotifier(
  client: ISessionClient,
  opts: GraphNotifierOptions = {},
): GraphTerminalHandler {
  const enabled = opts.enabled !== false;
  const emperorSessionId = opts.emperorSessionId;
  // Per-run epoch: a fresh notifier starts a clean dedupe epoch.
  const notified = new Set<string>();

  return async (event: GraphTerminalEvent): Promise<boolean> => {
    if (!enabled) return false;
    if (!emperorSessionId) return false;

    const key = terminalDedupeKey(event);
    if (notified.has(key)) return false;
    notified.add(key);

    const text = buildGraphTerminalText(event);
    return enqueueNotify(emperorSessionId, async () => {
      try {
        await client.prompt(emperorSessionId, {
          ...(opts.agent ? { agent: opts.agent } : {}),
          parts: [{ type: "text", text }],
          // Terminal events (GRAPH COMPLETE / BLOCKED) MUST wake the
          // orchestrator so it collects node results and advances (or handles
          // the approval gate). This mirrors the FINAL dispatch notification in
          // `notifyParent` (noReply:false when remaining===0). Without this the
          // reminder lands in the session but never triggers a turn, so the
          // graph appears "stuck" until the user manually prompts. The marker is
          // still a member of DISPATCH_NOTIFICATION_MARKERS, so the re-entering
          // chat.message hook does NOT reset the auto-continue counter.
          noReply: false,
        });
        metrics.counter("graph_notify_sent_total").inc();
        return true;
      } catch (err) {
        metrics.counter("graph_notify_failed_total").inc();
        log.warn(
          `Failed to notify emperor session ${emperorSessionId} about graph terminal ${event.graphId}`,
          err instanceof Error ? err.message : String(err),
        );
        return false;
      }
    });
  };
}
