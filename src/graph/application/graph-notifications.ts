import { createHash, randomUUID } from "node:crypto";
import { createSubLogger } from "../../logger.ts";
import { errorText } from "../../utils/error-text.ts";
import { readGraphView, type GraphView } from "../query/graph-query.ts";
import { GraphStore } from "../store/graph-store.ts";
import { GRAPH_STORE_TABLES } from "../store/schema.ts";
import type { OutcomeGraphState } from "../outcome/state-model.ts";

const EFFECT_KIND = "graph-notification";
const EFFECTS = GRAPH_STORE_TABLES.pendingEffects;
const LEASE_MS = 60_000;
const log = createSubLogger("graph:notifications");

export interface GraphNotification {
  readonly id: string;
  readonly graphId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly agent?: string;
  readonly kind: "complete" | "stopped" | "attention";
  readonly reason: string;
  readonly nodeId?: string;
  readonly attemptId?: string;
  readonly approvalStatus?: string;
}

export interface GraphNotificationOptions {
  /** True means the target session accepted a waking message; null/no-op is failure. */
  readonly send: (notification: GraphNotification) => Promise<boolean>;
  readonly retryMs?: number;
  readonly clock?: () => number;
}

interface Delivery {
  readonly notification: GraphNotification;
  readonly attempts: number;
  readonly retryAt: number;
  readonly owner?: string;
  readonly leaseUntil?: number;
}

type Run = GraphView["runs"][number];
type Notice = Omit<GraphNotification, "id" | "graphId" | "runId" | "sessionId" | "agent"> & { key: string };

function notices(run: Run, phase: OutcomeGraphState["phase"] | undefined): Notice[] {
  // A retry annotates the previous run as stopped without undoing its terminal outcome.
  if (run.control !== undefined && run.control.command !== "retry") {
    return [{ key: "terminal", kind: "stopped", reason: `${run.control.command}: ${run.control.reason}` }];
  }
  if (run.stop !== undefined) return [{ key: "terminal", kind: "stopped", reason: run.stop.reason }];
  if (phase === "complete") {
    return [{ key: "terminal", kind: "complete", reason: "All activated graph work completed." }];
  }
  if (run.control?.command === "retry") return [];
  const pending: Notice[] = run.approvals.filter(approval => approval.status !== "approved" &&
    run.nodes.some(node => node.status === "dispatched" && node.attemptId === approval.attemptId)).map(approval => ({
    key: `approval:${approval.attemptId}:${approval.status}`,
    kind: "attention", nodeId: approval.nodeId, attemptId: approval.attemptId,
    approvalStatus: approval.status,
    reason: `Approval ${approval.status}: ${approval.decisionReason ?? approval.reason}`,
  }));
  for (const node of run.nodes) {
    if (!node.inputRefusals?.length) continue;
    const reason = JSON.stringify(node.inputRefusals);
    pending.push({ key: `inputs:${node.nodeId}:${createHash("sha256").update(reason).digest("hex")}`,
      kind: "attention", nodeId: node.nodeId, reason: `Required inputs are unavailable: ${reason}` });
  }
  for (const attempt of run.attempts) {
    if (!run.nodes.some(node => node.status === "dispatched" && node.attemptId === attempt.attemptId)) continue;
    const execution = attempt.execution;
    const failed = execution?.state === "creating" && execution.refused?.kind === "unproven-failure";
    const released = execution?.state === "pending" && execution.releasedAt !== undefined;
    if (!failed && !released) continue;
    pending.push({ key: `dispatch:${attempt.attemptId}:${execution!.generation}`,
      kind: "attention", nodeId: attempt.nodeId, attemptId: attempt.attemptId,
      reason: failed ? "Worker launch failed without proof that no execution exists; recovery needs attention." : "Worker launch was refused; the dispatch remains pending." });
  }
  return pending;
}

function notificationId(graphId: string, runId: string, key: string): string {
  return `notify:${createHash("sha256").update(JSON.stringify([graphId, runId, key])).digest("hex")}`;
}

export function graphNotificationText(notification: GraphNotification): string {
  const marker = notification.kind === "complete" ? "[GRAPH COMPLETE]" : "[GRAPH BLOCKED]";
  return `<system-reminder>\n${marker}\n${JSON.stringify({
    notification_id: notification.id, graph_id: notification.graphId, run_id: notification.runId,
    status: notification.kind, node_id: notification.nodeId, reason: notification.reason.slice(0, 1200),
  })}\nRead graph_status(${JSON.stringify({ graph_id: notification.graphId, run_id: notification.runId, format: "json" })}) ` +
    "for the committed result and any remaining external work. Continue the task or report the result to the user.\n</system-reminder>";
}

/** Durable notification effects share the state transaction, but never drive graph execution. */
export class GraphNotifications {
  private readonly store: GraphStore;
  private readonly owner = randomUUID();
  private readonly unreadableGraphs = new Set<string>();
  private readonly now: () => number;
  private readonly retryMs: number;
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  private active: Promise<void> | undefined;
  private queued = false;
  private writing = false;
  private captured = false;
  private closed = false;

  constructor(root: string, private readonly options: GraphNotificationOptions) {
    this.store = GraphStore.openFile(root);
    this.now = options.clock ?? Date.now;
    this.retryMs = options.retryMs ?? 5_000;
    this.unsubscribe = this.store.observeTransactions({
      beforeCommit: () => { this.captured = !this.writing && this.capture(); },
      afterCommit: () => { if (this.captured) this.schedule(); },
    });
    this.timer = setInterval(() => this.schedule(), this.retryMs);
    this.timer.unref();
    this.schedule();
  }

  private write<T>(work: () => T): T {
    this.writing = true;
    try { return this.store.transaction(work); }
    finally { this.writing = false; }
  }

  private capture(): boolean {
    let captured = false;
    for (const graphId of this.store.invocationOriginGraphIds()) {
      if (this.store.readDefinition(graphId) === undefined) continue;
      const origin = this.store.readInvocationOrigin(graphId)!;
      let graph: GraphView;
      try {
        graph = readGraphView(this.store, graphId);
        this.unreadableGraphs.delete(graphId);
      } catch (error) {
        if (!this.unreadableGraphs.has(graphId)) {
          log.warn("Graph notification source is unreadable", { graphId, error: errorText(error) });
          this.unreadableGraphs.add(graphId);
        }
        continue;
      }
      for (const run of graph.runs) {
        const state = this.store.readGraphStateOf(graphId, run.runId)?.body as OutcomeGraphState | undefined;
        for (const { key, ...notice } of notices(run, state?.phase)) {
          const id = notificationId(graphId, run.runId, key);
          const notification: GraphNotification = { id, graphId, runId: run.runId, ...origin, ...notice };
          const delivery: Delivery = { notification, attempts: 0, retryAt: 0 };
          this.store.run(`INSERT INTO ${EFFECTS}
            (graph_id, run_id, effect_id, attempt_id, kind, payload, created_at, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending') ON CONFLICT(graph_id, effect_id) DO NOTHING`,
          graphId, run.runId, id, notice.attemptId ?? id, EFFECT_KIND, JSON.stringify(delivery), this.now());
          captured = this.store.changes() > 0 || captured;
        }
      }
    }
    return captured;
  }

  private schedule(): void {
    if (this.closed) return;
    this.queued = true;
    queueMicrotask(() => {
      if (!this.closed) void this.flush().catch(error => log.warn("Graph notification delivery deferred", { error: errorText(error) }));
    });
  }

  /** Also used by lifecycle owners to await delivery without waiting for the retry timer. */
  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.active !== undefined) return this.active;
    this.active = this.drain().finally(() => {
      this.active = undefined;
      if (this.closed) this.store.close();
    });
    return this.active;
  }

  private async drain(): Promise<void> {
    do {
      this.queued = false;
      this.write(() => this.capture());
      const rows = this.store.all(`SELECT graph_id, effect_id, payload FROM ${EFFECTS}
        WHERE kind = ? AND status IN ('pending', 'started') ORDER BY created_at, rowid`, EFFECT_KIND);
      for (const row of rows) {
        if (this.closed) return;
        const previous = String(row.payload);
        const delivery = JSON.parse(previous) as Delivery;
        if (delivery.retryAt > this.now() || (delivery.leaseUntil ?? 0) > this.now()) continue;
        const claimed: Delivery = { ...delivery, owner: this.owner, leaseUntil: this.now() + LEASE_MS };
        let payload = JSON.stringify(claimed);
        const changed = this.write(() => {
          this.store.run(`UPDATE ${EFFECTS} SET status = 'started', payload = ?
            WHERE graph_id = ? AND effect_id = ? AND payload = ? AND status IN ('pending', 'started')`,
          payload, row.graph_id, row.effect_id, previous);
          return this.store.changes();
        });
        if (changed === 0) continue;
        const renew = setInterval(() => {
          const next = JSON.stringify({ ...claimed, leaseUntil: this.now() + LEASE_MS });
          try {
            this.write(() => this.store.run(`UPDATE ${EFFECTS} SET payload = ?
              WHERE graph_id = ? AND effect_id = ? AND payload = ? AND status = 'started'`,
            next, row.graph_id, row.effect_id, payload));
            payload = next;
          } catch (error) { log.warn("Graph notification lease renewal failed", { error: errorText(error) }); }
        }, LEASE_MS / 3);
        renew.unref();
        let delivered = false;
        try {
          delivered = this.obsolete(delivery.notification) || await this.options.send(delivery.notification);
        } catch (error) { log.warn("Graph notification delivery failed", { error: errorText(error) }); }
        finally { clearInterval(renew); }
        const attempts = delivery.attempts + 1;
        const next: Delivery = { notification: delivery.notification, attempts,
          retryAt: delivered ? 0 : this.now() + Math.min(this.retryMs * 2 ** Math.min(attempts - 1, 6), 300_000) };
        this.write(() => this.store.run(`UPDATE ${EFFECTS} SET status = ?, payload = ?
          WHERE graph_id = ? AND effect_id = ? AND payload = ? AND status = 'started'`,
        delivered ? "done" : "pending", JSON.stringify(next), row.graph_id, row.effect_id, payload));
      }
    } while (this.queued && !this.closed);
  }

  private obsolete(notification: GraphNotification): boolean {
    if (notification.kind !== "attention") return false;
    const graph = readGraphView(this.store, notification.graphId);
    const run = graph.current;
    if (run?.runId !== notification.runId || run.phase === "complete" || run.phase === "stopped") return true;
    const state = this.store.readGraphStateOf(notification.graphId, run.runId)?.body as OutcomeGraphState | undefined;
    return !notices(run, state?.phase).some(notice => notificationId(notification.graphId, run.runId, notice.key) === notification.id);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    clearInterval(this.timer);
    if (this.active === undefined) this.store.close();
  }
}
