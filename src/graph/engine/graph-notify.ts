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
  GRAPH_STALL_MARKER,
} from "../../dispatch/notification.ts";
import { buildReminder, type ReminderField } from "../../prompt/reminder.ts";
import type {
  NodeCompletionEvent,
  GraphTerminalEvent,
} from "./engine-advance.ts";
import type { NodeStallEvent } from "./engine-recovery.ts";

// Exported so tests can spy on the notifier's own logger (F6).
export const log = createSubLogger("graph:notify");

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
  /**
   * Max total `client.prompt` attempts before the failure path is taken.
   * Default `GRAPH_NOTIFY_MAX_ATTEMPTS` (3 = 1 initial + up to 2 retries).
   * Mirrors `notifyParent`'s bounded-retry discipline — inject a small value
   * in tests to avoid real backoff sleeps.
   */
  maxAttempts?: number;
  /** Backoff base delay in ms (delay = `min(baseDelayMs * 2^attempt, maxDelayMs)`). Default 500. */
  baseDelayMs?: number;
  /** Backoff cap in ms. Default 5000. */
  maxDelayMs?: number;
}

// ── Retry / backoff constants ─────────────────────────────────────────────────
//
// Mirrors `notifyParent`'s retry discipline (`src/dispatch/notification.ts`):
// bounded exponential backoff `min(baseDelayMs * 2^attempt, maxDelayMs)`, a
// per-retry metric, and the failure path only after every attempt is exhausted.
// The graph notifier defaults to 3 total attempts (1 initial + up to 2 retries).
export const GRAPH_NOTIFY_MAX_ATTEMPTS = 3;
export const GRAPH_NOTIFY_BASE_DELAY_MS = 500;
export const GRAPH_NOTIFY_MAX_DELAY_MS = 5000;

// ── Shared retry / enqueue helper ────────────────────────────────────────────

/** Parameters for {@link enqueueWithRetry}. */
interface EnqueueWithRetryParams {
  client: ISessionClient;
  sessionId: string;
  /** Reminder text injected as the single text part. */
  text: string;
  /** Optional agent tag forwarded to the prompt. */
  agent?: string;
  /** Max total `client.prompt` attempts (1 initial + up to N-1 retries). */
  maxAttempts: number;
  /** Backoff base delay in ms (`delay = min(baseDelayMs * 2^attempt, maxDelayMs)`). */
  baseDelayMs: number;
  /** Backoff cap in ms. */
  maxDelayMs: number;
  /** `noReply` flag forwarded to the prompt (true = silent inject). */
  noReply: boolean;
  /** Message for the exhaustion warn log (built by the caller with event context). */
  failMessage: string;
}

/**
 * Enqueue a notification send through the per-session serialized send queue,
 * retrying `client.prompt` failures with bounded exponential backoff.
 *
 * Shared skeleton behind all three notifier factories
 * ({@link createGraphNotifier}, {@link createGraphTerminalNotifier},
 * {@link createGraphStallNotifier}) — they differ only in the reminder text,
 * the `noReply` flag, and the failure log message. Mirrors `notifyParent`'s
 * retry discipline (`src/dispatch/notification.ts`): each failed attempt retries
 * with `min(baseDelayMs * 2^attempt, maxDelayMs)` backoff up to `maxAttempts`
 * total attempts; only exhaustion falls through to the failure path (metric +
 * warn log, resolves `false`).
 */
function enqueueWithRetry(params: EnqueueWithRetryParams): Promise<boolean> {
  const {
    client,
    sessionId,
    text,
    agent,
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    noReply,
    failMessage,
  } = params;
  return enqueueNotify(sessionId, async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await client.prompt(sessionId, {
          ...(agent ? { agent } : {}),
          parts: [{ type: "text", text }],
          noReply,
        });
        metrics.counter("graph_notify_sent_total").inc();
        return true;
      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts - 1) {
          metrics.counter("graph_notify_retry_total").inc();
          const delay = Math.min(
            baseDelayMs * Math.pow(2, attempt),
            maxDelayMs,
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    metrics.counter("graph_notify_failed_total").inc();
    log.warn(
      failMessage,
      lastError instanceof Error ? lastError.message : String(lastError),
    );
    return false;
  });
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
 * Build the `<system-reminder>` text for a completed graph node via
 * {@link buildReminder}. Contains graph id, node id, agent, status, signal,
 * and duration.
 */
export function buildGraphCompletionText(event: NodeCompletionEvent): string {
  const dur = formatGraphDuration(event.startedAt, event.completedAt);
  return buildReminder({
    marker: GRAPH_COMPLETION_MARKER,
    fields: [
      { label: "graph", value: event.graphId },
      { label: "node", value: event.nodeId },
      { label: "agent", value: event.nodeAgent || "N/A" },
      { label: "status", value: event.nodeStatus },
      { label: "signal", value: event.signalType },
      { label: "dur", value: dur },
    ],
    action: `Use graph_status(graph_id="${event.graphId}", node_id="${event.nodeId}", include_output=true) to inspect the node result.`,
  });
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
 *   `client.prompt` failures are retried with bounded exponential backoff
 *   (max `maxAttempts` total attempts); only exhaustion resolves `false`.
 */
export function createGraphNotifier(
  client: ISessionClient,
  opts: GraphNotifierOptions = {},
): GraphCompletionHandler {
  const enabled = opts.enabled !== false;
  const emperorSessionId = opts.emperorSessionId;
  const maxAttempts = opts.maxAttempts ?? GRAPH_NOTIFY_MAX_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? GRAPH_NOTIFY_BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? GRAPH_NOTIFY_MAX_DELAY_MS;
  // Per-run epoch: a fresh notifier starts a clean dedupe epoch.
  const notified = new Set<string>();

  return async (event: NodeCompletionEvent): Promise<boolean> => {
    if (!enabled) return false;
    if (!emperorSessionId) return false;

    // The dedupe key is claimed BEFORE the first attempt: retries of the same
    // event are one logical notification, so they must not re-enter the dedupe
    // epoch nor allow a concurrent duplicate send.
    const key = dedupeKey(event);
    if (notified.has(key)) return false;
    notified.add(key);

    const text = buildGraphCompletionText(event);
    return enqueueWithRetry({
      client,
      sessionId: emperorSessionId,
      text,
      agent: opts.agent,
      maxAttempts,
      baseDelayMs,
      maxDelayMs,
      // Per-node completion is informational — inject silently (noReply: true).
      noReply: true,
      failMessage: `Failed to notify emperor session ${emperorSessionId} about graph node ${event.graphId}::${event.nodeId}`,
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
 * Build the `<system-reminder>` text for a graph-terminal event via
 * {@link buildReminder}.
 *
 * Uses {@link GRAPH_COMPLETE_MARKER} when the graph reached COMPLETE phase, and
 * {@link GRAPH_BLOCKED_MARKER} when the graph is quiescent-blocked. Both markers
 * are members of {@link DISPATCH_NOTIFICATION_MARKERS} so the chat.message hook
 * classifies them as non-user turns.
 *
 * Content: graph id, phase, compact node-status summary (zero counts omitted
 * except completed always present), and next-step actions.
 * BLOCKED adds full approval instruction set as multi-line action.
 */
export function buildGraphTerminalText(event: GraphTerminalEvent): string {
  const marker = event.isBlocked ? GRAPH_BLOCKED_MARKER : GRAPH_COMPLETE_MARKER;
  const { completed, done, cancelled, escalate, timeout, blocked, running } = event.nodeStatusSummaries;

  // Compact node-status summary: completed always shown; zero counts omitted.
  const summaryParts: string[] = [`completed=${completed}`];
  if (done > 0) summaryParts.push(`done=${done}`);
  if (cancelled > 0) summaryParts.push(`cancelled=${cancelled}`);
  if (escalate > 0) summaryParts.push(`escalated=${escalate}`);
  if (timeout > 0) summaryParts.push(`timeout=${timeout}`);
  if (blocked > 0) summaryParts.push(`blocked=${blocked}`);
  if (running > 0) summaryParts.push(`running=${running}`);

  const fields: ReminderField[] = [
    { label: "graph", value: event.graphId },
    { label: "phase", value: event.phase },
    { label: "nodes", value: summaryParts.join(" ") },
  ];

  if (event.isBlocked) {
    return buildReminder({
      marker,
      fields,
      action: [
        `Graph quiescent-blocked — nodes await approval.`,
        `Inspect blocked nodes: graph_status(graph_id="${event.graphId}", status="blocked", include_output=true)`,
        `Approve: graph_approve(graph_id="${event.graphId}", node_id="<blocked_node_id>", action="approve")`,
        `Reject: graph_approve(graph_id="${event.graphId}", node_id="<blocked_node_id>", action="reject") with reason`,
        `Read all results: graph_status(graph_id="${event.graphId}", include_output=true)`,
      ].join("\n"),
    });
  }

  return buildReminder({
    marker,
    fields,
    action: `Read all results: graph_status(graph_id="${event.graphId}", include_output=true)`,
  });
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
 * @returns a handler that is a no-op when disabled (silent), a no-op that logs
 *   an explicit warning when no emperor session is configured (F6), drops
 *   idempotent replays, and otherwise enqueues the reminder (`client.prompt`
 *   failures retried with bounded exponential backoff, max `maxAttempts` total
 *   attempts).
 */
export function createGraphTerminalNotifier(
  client: ISessionClient,
  opts: GraphNotifierOptions = {},
): GraphTerminalHandler {
  const enabled = opts.enabled !== false;
  const emperorSessionId = opts.emperorSessionId;
  const maxAttempts = opts.maxAttempts ?? GRAPH_NOTIFY_MAX_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? GRAPH_NOTIFY_BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? GRAPH_NOTIFY_MAX_DELAY_MS;
  // Per-run epoch: a fresh notifier starts a clean dedupe epoch.
  const notified = new Set<string>();

  return async (event: GraphTerminalEvent): Promise<boolean> => {
    if (!enabled) return false;
    if (!emperorSessionId) {
      // F6: surface the silent-drop. The engine still runs its default no-op
      // terminal seam, but an operator must see WHY the orchestrator was never
      // woken. The `!enabled` path above stays silent (deliberate opt-out).
      log.warn(
        `graph-notify: ${event.isBlocked ? "blocked" : "complete"} notification skipped — no emperor session resolved for graph ${event.graphId}`,
      );
      return false;
    }

    // Dedupe key claimed BEFORE the first attempt — retries of the same
    // terminal event are one logical notification (see createGraphNotifier).
    const key = terminalDedupeKey(event);
    if (notified.has(key)) return false;
    notified.add(key);

    const text = buildGraphTerminalText(event);
    return enqueueWithRetry({
      client,
      sessionId: emperorSessionId,
      text,
      agent: opts.agent,
      maxAttempts,
      baseDelayMs,
      maxDelayMs,
      // Terminal events (GRAPH COMPLETE / BLOCKED) MUST wake the orchestrator
      // so it collects node results and advances (or handles the approval
      // gate) — noReply:false mirrors the FINAL dispatch notification in
      // `notifyParent`. Without this the reminder lands in the session but
      // never triggers a turn, so the graph appears "stuck" until the user
      // manually prompts. The marker is still a member of
      // DISPATCH_NOTIFICATION_MARKERS, so the re-entering chat.message hook
      // does NOT reset the auto-continue counter.
      noReply: false,
      failMessage: `Failed to notify emperor session ${emperorSessionId} about graph terminal ${event.graphId}`,
    });
  };
}

// ── Graph-Stall Notifier ─────────────────────────────────────────────────────

/**
 * The stall handler the factory returns. Satisfies the engine seam
 * `(event: NodeStallEvent) => void` structurally; the resolved boolean tells
 * the caller whether a notification was dispatched (`true`) or suppressed by
 * opt-out / dedupe / missing session (`false`), which makes it awaitable in
 * tests.
 */
export type GraphStallHandler = (event: NodeStallEvent) => Promise<boolean>;

/**
 * Per-run dedupe key for stall episodes: `graphId::nodeId::stallWarnedAt`.
 * `stallWarnedAt` identifies the stall episode (it is stamped once per
 * episode by the liveness monitor), so a recovery (fresh heartbeat) followed
 * by a re-stall — a NEW `stallWarnedAt` — legally re-notifies, while an
 * idempotent replay of the same episode is dropped.
 */
function stallDedupeKey(event: NodeStallEvent): string {
  return `${event.graphId}::${event.nodeId}::${event.stallWarnedAt}`;
}

/**
 * Format an idle duration (ms) as a compact human-readable string — the same
 * style as {@link formatGraphDuration}: `<60s → "X.Xs"`, else `"Xm Ys"`;
 * a negative value (clock skew) renders `"?"`.
 */
export function formatStallIdle(idleMs: number): string {
  if (idleMs < 0) return "?";
  if (idleMs < 60_000) return `${(idleMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(idleMs / 60_000);
  const seconds = Math.floor((idleMs % 60_000) / 1000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/**
 * Build the `<system-reminder>` text for a stalling graph node via
 * {@link buildReminder}. Contains graph id, node id, agent, idle duration, and
 * the warn threshold. Uses {@link GRAPH_STALL_MARKER}, a member of
 * {@link DISPATCH_NOTIFICATION_MARKERS}, so the chat.message hook classifies
 * the injected text as a non-user turn.
 */
export function buildGraphStallText(event: NodeStallEvent): string {
  return buildReminder({
    marker: GRAPH_STALL_MARKER,
    fields: [
      { label: "graph", value: event.graphId },
      { label: "node", value: event.nodeId },
      { label: "agent", value: event.agent || "N/A" },
      { label: "idle", value: formatStallIdle(event.idleMs) },
      { label: "stallWarnMs", value: String(event.stallWarnMs) },
    ],
    action: `Use graph_status(graph_id="${event.graphId}", node_id="${event.nodeId}", include_output=true) to inspect the stalling node.`,
  });
}

/**
 * Create a graph node-stall notifier wired to the engine's `onNodeStall` seam.
 *
 * Follows the same session-client injection + dedupe + bounded-retry pattern as
 * {@link createGraphNotifier}: the dedupe key is claimed BEFORE the first
 * attempt, failures retry with bounded exponential backoff (max `maxAttempts`
 * total attempts, `GRAPH_NOTIFY_MAX_ATTEMPTS` / `GRAPH_NOTIFY_BASE_DELAY_MS` /
 * `GRAPH_NOTIFY_MAX_DELAY_MS`), and only exhaustion resolves `false` after a
 * warn log naming the graph::node. Unlike the terminal notifier it injects
 * with `noReply: true` — a stall is informational and silent (the orchestrator
 * observes it without being woken), exactly like per-node completion.
 *
 * @returns a handler that is a no-op (resolves `false`) when disabled or when
 *   no emperor session is configured, drops idempotent replays of the same
 *   stall episode (resolves `false`), and otherwise enqueues the reminder to
 *   the emperor session via the per-session serialized send queue.
 */
export function createGraphStallNotifier(
  client: ISessionClient,
  opts: GraphNotifierOptions = {},
): GraphStallHandler {
  const enabled = opts.enabled !== false;
  const emperorSessionId = opts.emperorSessionId;
  const maxAttempts = opts.maxAttempts ?? GRAPH_NOTIFY_MAX_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? GRAPH_NOTIFY_BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? GRAPH_NOTIFY_MAX_DELAY_MS;
  // Per-run epoch: a fresh notifier starts a clean dedupe epoch.
  const notified = new Set<string>();

  return async (event: NodeStallEvent): Promise<boolean> => {
    if (!enabled) return false;
    if (!emperorSessionId) return false;

    // The dedupe key is claimed BEFORE the first attempt: retries of the same
    // stall episode are one logical notification, so they must not re-enter
    // the dedupe epoch nor allow a concurrent duplicate send.
    const key = stallDedupeKey(event);
    if (notified.has(key)) return false;
    notified.add(key);

    const text = buildGraphStallText(event);
    return enqueueWithRetry({
      client,
      sessionId: emperorSessionId,
      text,
      agent: opts.agent,
      maxAttempts,
      baseDelayMs,
      maxDelayMs,
      // Stall is informational — inject silently (noReply: true, same as
      // per-node completion). The marker is still a member of
      // DISPATCH_NOTIFICATION_MARKERS, so the re-entering chat.message hook
      // does NOT reset the auto-continue counter.
      noReply: true,
      failMessage: `Failed to notify emperor session ${emperorSessionId} about graph node stall ${event.graphId}::${event.nodeId}`,
    });
  };
}
