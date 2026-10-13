import { createHash, randomUUID } from "node:crypto";
import { createSubLogger } from "../../logger.ts";
import { logEvent, withLogScope } from "../../log/index.ts";
import { errorText } from "../../utils/error-text.ts";
import { STOPPING_CONTROL_COMMANDS } from "../ledger/types.ts";
import { readGraphView, type GraphView } from "../query/graph-query.ts";
import { GraphStore, type PendingNotificationEffect, type TerminalExecutionObservation } from "../store/graph-store.ts";
import { GRAPH_STORE_TABLES } from "../store/schema.ts";
import { describeOutcomeStop } from "../outcome/state-codec.ts";
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

/** Whether `value` is the non-empty text an identifier field of the envelope carries. */
function deliveryIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Whether `value` is a non-negative safe integer, as the envelope stores counts and instants. */
function deliveryNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * One JSON object's fields, or `undefined` when the value is not a JSON object.
 *
 * The cast is to an UNTYPED bag, never to a domain type: every field the
 * envelope reader below consumes is then read from `unknown` and checked by
 * name, which is exactly what `JSON.parse(...) as Delivery` skipped.
 */
function jsonFields(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * The DELIVERY ENVELOPE of one durable effect, decoded TOTALLY — or `undefined`.
 *
 * The payload is the ONLY durable record of a delivery's attempts and lease,
 * and `JSON.parse` answers an untyped value: reading it `as Delivery` let a
 * foreign or corrupt row throw a raw `TypeError` out of the drain, or compute
 * `now + NaN` backoff from `delivery.attempts + 1`, and handed the transport a
 * notice nobody had validated. Every field is therefore read from `unknown`,
 * refused by name, and the returned envelope is REBUILT from the checked
 * values — never spread from the parsed object — so no value a foreign row
 * carries can reach `send`. `undefined` means "not this build's envelope": the
 * caller completes the row and reports it instead of delivering it.
 */
function readDelivery(payload: string): Delivery | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const fields = jsonFields(parsed);
  if (fields === undefined) return undefined;
  const notice = jsonFields(fields["notification"]);
  if (notice === undefined) return undefined;
  const id = notice["id"];
  const graphId = notice["graphId"];
  const runId = notice["runId"];
  const sessionId = notice["sessionId"];
  const kind = notice["kind"];
  const reason = notice["reason"];
  if (!deliveryIdentifier(id) || !deliveryIdentifier(graphId) || !deliveryIdentifier(runId) || !deliveryIdentifier(sessionId)) {
    return undefined;
  }
  if (kind !== "complete" && kind !== "stopped" && kind !== "attention") return undefined;
  if (typeof reason !== "string") return undefined;
  const agent = notice["agent"];
  const nodeId = notice["nodeId"];
  const attemptId = notice["attemptId"];
  const approvalStatus = notice["approvalStatus"];
  if (agent !== undefined && typeof agent !== "string") return undefined;
  if (nodeId !== undefined && typeof nodeId !== "string") return undefined;
  if (attemptId !== undefined && typeof attemptId !== "string") return undefined;
  if (approvalStatus !== undefined && typeof approvalStatus !== "string") return undefined;
  const attempts = fields["attempts"];
  const retryAt = fields["retryAt"];
  if (!deliveryNumber(attempts) || !deliveryNumber(retryAt)) return undefined;
  const owner = fields["owner"];
  const leaseUntil = fields["leaseUntil"];
  if (owner !== undefined && typeof owner !== "string") return undefined;
  if (leaseUntil !== undefined && !deliveryNumber(leaseUntil)) return undefined;
  return {
    notification: {
      id, graphId, runId, sessionId, kind, reason,
      ...(agent === undefined ? {} : { agent }),
      ...(nodeId === undefined ? {} : { nodeId }),
      ...(attemptId === undefined ? {} : { attemptId }),
      ...(approvalStatus === undefined ? {} : { approvalStatus }),
    },
    attempts,
    retryAt,
    ...(owner === undefined ? {} : { owner }),
    ...(leaseUntil === undefined ? {} : { leaseUntil }),
  };
}

type Run = GraphView["runs"][number];
type Notice = Omit<GraphNotification, "id" | "graphId" | "runId" | "sessionId" | "agent"> & { key: string };

/** Whether one attempt is still the CURRENT attempt of a DISPATCHED node. */
function currentDispatchedAttempt(run: Run, attemptId: string | undefined): boolean {
  return attemptId !== undefined &&
    run.nodes.some(node => node.status === "dispatched" && node.attemptId === attemptId);
}

/**
 * The PENDING nodes of a run: the work still standing, named even when the stop
 * record itself is not the thing being read.
 *
 * A terminal stop notice says only WHY the run ended, and the reason is the one
 * thing an operator needs to act on — an abandoned node the report does not
 * name is an abandoned node nobody can find. The nodes are read from the
 * current state, so the notice agrees with `graph_status`. The same reader names
 * them for a body that says `complete` over work it never finished: a
 * `complete` claim is honest only when this returns nothing.
 */
function strandedNodeNames(run: Run): readonly string[] {
  const names: string[] = [];
  for (const node of run.nodes) {
    if (node.status === "pending") names.push(node.nodeId);
  }
  return names;
}

function terminalStopReason(run: Run): string {
  const stop = run.stop;
  if (stop === undefined) return "stopped";
  if (stop.reason !== "unreachable-pending-node") return stop.reason;
  const pending = strandedNodeNames(run);
  const detail = pending.length === 0
    ? "no node is pending in the current state"
    : `pending and unreachable: ${pending.join(", ")}`;
  return `${stop.reason}: ${describeOutcomeStop(stop)} — ${detail}`;
}

function notices(
  run: Run,
  phase: OutcomeGraphState["phase"] | undefined,
  readObservation: (executionId: string) => TerminalExecutionObservation | undefined,
): Notice[] {
  // The PHASE read here is the whole vocabulary, not this build's: a body an
  // OLDER build wrote is still readable, and one of those can say `complete`
  // while holding pending nodes (the very shape this file now reports instead
  // of hiding). Narrowing to the current build's written set would make that
  // case unreachable in the type system and invisible in the store.
  const recordedPhase: string | undefined = phase;
  // A retry annotates the previous run as stopped without undoing its terminal outcome.
  if (run.control !== undefined && run.control.command !== "retry") {
    return [{ key: "terminal", kind: "stopped", reason: `${run.control.command}: ${run.control.reason}` }];
  }
  if (run.stop !== undefined) {
    return [{ key: "terminal", kind: "stopped", reason: terminalStopReason(run) }];
  }
  // ── A BODY THAT SAYS COMPLETE OVER PENDING NODES IS NOT A COMPLETION ────
  //
  // The phase read here is the whole vocabulary, not this build's: a body an
  // OLDER build wrote can say `complete` while still holding PENDING nodes —
  // the exact shape that used to be announced as finished work. The condition
  // is therefore decided BEFORE the completion return, and what is announced is
  // a `stopped` notice naming the nodes, because the run did not finish them.
  //
  // Two properties of that notice are load-bearing. Its key is its own
  // (`pending:<nodes>`, not `terminal`), so it is a NEW durable effect that a
  // store which already recorded (and sent) the old build's `terminal`
  // completion still produces. And its kind is deliberately NOT `attention`:
  // `obsolete()` discards an attention notice for a run the view already calls
  // `complete`, and a completion the run never earned must survive exactly that
  // filter. The genuine `complete` notice is returned only when nothing is
  // pending, so a run that really finished is still announced once.
  if (recordedPhase === "complete") {
    const stranded = strandedNodeNames(run);
    if (stranded.length === 0) {
      return [{ key: "terminal", kind: "complete", reason: "All activated graph work completed." }];
    }
    return [{
      key: `pending:${stranded.join(",")}`,
      kind: "stopped",
      reason:
        `This run is recorded as complete, but ${stranded.length} node(s) are still ` +
        `pending: ${stranded.join(", ")} — the run did not finish that work.`,
    }];
  }
  if (run.control?.command === "retry") return [];
  // ── A RUN THAT STILL HOLDS WORK SAYS SO ─────────────────────────────────
  //
  // `complete` is the only terminal state a RUN reaches by itself, and the
  // reducer refuses it while a node is pending — so reaching this line means the
  // run is executing an attempt, and its remaining work is reported by the
  // attempt-scoped notices below. A body that says `complete` over pending nodes
  // never reaches here: it was decided above, as the stopped run it is.
  const pending: Notice[] = [];
  for (const approval of run.approvals) {
    if (approval.status === "approved") continue;
    if (!run.nodes.some(node => node.status === "dispatched" && node.attemptId === approval.attemptId)) continue;
    pending.push({
      key: `approval:${approval.attemptId}:${approval.status}`,
      kind: "attention", nodeId: approval.nodeId, attemptId: approval.attemptId,
      approvalStatus: approval.status,
      reason: `Approval ${approval.status}: ${approval.decisionReason ?? approval.reason}`,
    });
  }
  for (const node of run.nodes) {
    if (!node.inputRefusals?.length) continue;
    const reason = JSON.stringify(node.inputRefusals);
    pending.push({ key: `inputs:${node.nodeId}:${createHash("sha256").update(reason).digest("hex")}`,
      kind: "attention", nodeId: node.nodeId, reason: `Required inputs are unavailable: ${reason}` });
  }
  for (const attempt of run.attempts) {
    if (!currentDispatchedAttempt(run, attempt.attemptId)) continue;
    const execution = attempt.execution;
    if (execution === undefined) continue;
    const failed = execution.state === "creating" && execution.refused?.kind === "unproven-failure";
    const released = execution.state === "pending" && execution.releasedAt !== undefined;
    if (!failed && !released) continue;
    pending.push({ key: `dispatch:${attempt.attemptId}:${execution.generation}`,
      kind: "attention", nodeId: attempt.nodeId, attemptId: attempt.attemptId,
      reason: failed ? "Worker launch failed without proof that no execution exists; recovery needs attention." : "Worker launch was refused; the dispatch remains pending." });
  }
  // ── AN ATTEMPT-SCOPED STOP IS NOT A SILENT ONE ──────────────────────────
  //
  // The terminal `stopped` notice above is keyed on the RUN's own control fact,
  // and a node-scoped stop deliberately claims none: `failure` and `timeout`
  // end ONE attempt while the run keeps executing and its siblings still
  // settle. Without the notice below a node-scoped stop would surface nowhere:
  // the run reads as merely `executing`, the stopped attempt is still the
  // node's current one, it accepted nothing, and the node's dependents stay
  // unreleased until a `retry` mints a successor or a run-wide stop closes the
  // run. ONE notice per stopping decision, keyed by the attempt and the
  // command, so reflushing and reopening cannot duplicate it.
  const stoppedAttempts = new Set<string>();
  for (const decision of run.decisions) {
    if (!STOPPING_CONTROL_COMMANDS.includes(decision.command)) continue;
    if (!currentDispatchedAttempt(run, decision.attemptId)) continue;
    const attempt = run.attempts.find(item => item.attemptId === decision.attemptId);
    if (attempt === undefined || attempt.accepted !== undefined) continue;
    stoppedAttempts.add(decision.attemptId);
    pending.push({
      key: `stopped:${decision.attemptId}:${decision.command}`,
      kind: "attention", nodeId: decision.nodeId, attemptId: decision.attemptId,
      reason: `The trusted command ${decision.command} stopped attempt ${decision.attemptId} of node ${decision.nodeId} (${decision.reason}). The run continues and this node's dependents stay unreleased — retry the node to mint a successor attempt, or cancel the run.`,
    });
  }
  // ── A COMPLETED EXECUTION IS NOT A SETTLED ATTEMPT ──────────────────────
  //
  // The worker's execution is durably OVER (the host's own terminal
  // observation, never an announcement) and yet no outcome was settled for the
  // attempt: no submission arrived and the host derived none, so nothing will
  // settle it by itself. It is reported while it is still the current attempt
  // of a dispatched node and carries no stopping decision — a stopped attempt
  // is reported by the notice above instead.
  for (const attempt of run.attempts) {
    if (attempt.accepted !== undefined || stoppedAttempts.has(attempt.attemptId)) continue;
    if (!currentDispatchedAttempt(run, attempt.attemptId)) continue;
    const executionId = attempt.execution?.execution?.executionId;
    if (executionId === undefined || readObservation(executionId)?.kind !== "completed") continue;
    pending.push({
      key: `unsettled-completion:${attempt.attemptId}`,
      kind: "attention", nodeId: attempt.nodeId, attemptId: attempt.attemptId,
      reason: "The worker execution ended and reported completion, but no outcome was settled (no submission arrived and the host derived none) — the attempt stays open.",
    });
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
      const origin = this.store.readInvocationOrigin(graphId);
      if (origin === undefined) {
        // BOTH READS RUN ON ONE SYNCHRONOUS CONNECTION, so a listed graph id with
        // no origin row means the store answered inconsistently. `{ ...origin }`
        // would spread `undefined` — legal JavaScript — and persist a durable
        // notification whose required `sessionId` is absent, with no throw and no
        // diagnostic; the capture skips the graph and reports it instead. The
        // once-per-unreadable-stretch memory is shared with the view failure
        // below, so an inconsistent graph is named when it appears, not on every
        // pass.
        if (!this.unreadableGraphs.has(graphId)) {
          withLogScope({ graphId }, () =>
            logEvent("notifications.source-unreadable", {
              error: "the store lists this graph's invocation origin but answered no origin record",
            }));
          this.unreadableGraphs.add(graphId);
        }
        continue;
      }
      let graph: GraphView;
      try {
        graph = readGraphView(this.store, graphId);
        this.unreadableGraphs.delete(graphId);
      } catch (error) {
        if (!this.unreadableGraphs.has(graphId)) {
          withLogScope({ graphId }, () =>
            logEvent("notifications.source-unreadable", { error: errorText(error) }));
          this.unreadableGraphs.add(graphId);
        }
        continue;
      }
      for (const run of graph.runs) {
        // The phase is the run view's OWN decode of the persisted body — the
        // versioned reader already ran inside `readGraphView` — so this loop
        // never re-reads the row and asserts `GraphStateRecord.body` (F-03).
        for (const { key, ...notice } of notices(
          run,
          run.recordedPhase,
          executionId => this.store.readExecutionObservation(executionId),
        )) {
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
      for (const effect of this.store.readPendingNotificationEffects(EFFECT_KIND)) {
        if (this.closed) return;
        const previous = effect.payload;
        if (previous === undefined) {
          this.refuseEffect(effect, "the payload column is not the TEXT this format writes");
          continue;
        }
        const delivery = readDelivery(previous);
        if (delivery === undefined) {
          this.refuseEffect(effect, "the payload is not the delivery envelope this build writes");
          continue;
        }
        if (delivery.retryAt > this.now() || (delivery.leaseUntil ?? 0) > this.now()) continue;
        const claimed: Delivery = { ...delivery, owner: this.owner, leaseUntil: this.now() + LEASE_MS };
        let payload = JSON.stringify(claimed);
        const changed = this.write(() => {
          this.store.run(`UPDATE ${EFFECTS} SET status = 'started', payload = ?
            WHERE graph_id = ? AND effect_id = ? AND payload = ? AND status IN ('pending', 'started')`,
          payload, effect.graphId, effect.effectId, previous);
          return this.store.changes();
        });
        if (changed === 0) continue;
        const renew = setInterval(() => {
          const next = JSON.stringify({ ...claimed, leaseUntil: this.now() + LEASE_MS });
          try {
            this.write(() => this.store.run(`UPDATE ${EFFECTS} SET payload = ?
              WHERE graph_id = ? AND effect_id = ? AND payload = ? AND status = 'started'`,
            next, effect.graphId, effect.effectId, payload));
            payload = next;
          } catch (error) {
            withLogScope({ graphId: effect.graphId, effectId: effect.effectId }, () =>
              logEvent("notifications.lease-renewal-failed", { error: errorText(error) }));
          }
        }, LEASE_MS / 3);
        renew.unref();
        let delivered = false;
        try {
          delivered = this.obsolete(delivery.notification) || await this.options.send(delivery.notification);
        } catch (error) {
          withLogScope({ graphId: delivery.notification.graphId, runId: delivery.notification.runId }, () =>
            logEvent("notifications.delivery-failed", { error: errorText(error) }));
        }
        finally { clearInterval(renew); }
        const attempts = delivery.attempts + 1;
        const next: Delivery = { notification: delivery.notification, attempts,
          retryAt: delivered ? 0 : this.now() + Math.min(this.retryMs * 2 ** Math.min(attempts - 1, 6), 300_000) };
        this.write(() => this.store.run(`UPDATE ${EFFECTS} SET status = ?, payload = ?
          WHERE graph_id = ? AND effect_id = ? AND payload = ? AND status = 'started'`,
        delivered ? "done" : "pending", JSON.stringify(next), effect.graphId, effect.effectId, payload));
      }
    } while (this.queued && !this.closed);
  }

  /**
   * COMPLETE one effect whose durable payload this build cannot read, REPORTING it.
   *
   * The payload is the ONLY durable record of a delivery's attempts and lease,
   * so a refused row can never be retried honestly: a retry would invent an
   * attempt count and a backoff from a shape nobody checked (that is the
   * `NaN` this replaced). Completing it keeps the drain TOTAL — a row left
   * `pending` would be re-read, and re-refused, on every pass forever — and the
   * report names it, so the loss is visible instead of silent. The row is
   * addressed by its own `rowid`, because the payload it is refused FOR is
   * exactly what cannot be used as a key. The event code is the existing
   * unreadable-source diagnostic: no code for a refused payload is registered,
   * and the registry is outside this node's ownership.
   */
  private refuseEffect(effect: PendingNotificationEffect, reason: string): void {
    const changed = this.write(() => {
      this.store.run(`UPDATE ${EFFECTS} SET status = 'done'
        WHERE rowid = ? AND status IN ('pending', 'started')`, effect.rowId);
      return this.store.changes();
    });
    withLogScope({ graphId: effect.graphId, effectId: effect.effectId }, () =>
      logEvent("notifications.source-unreadable", {
        error: `the durable ${EFFECT_KIND} payload could not be read — ${reason}` +
          (changed === 0 ? "; the effect was already settled by another owner" : "; the effect was completed instead of delivered"),
      }));
  }

  private obsolete(notification: GraphNotification): boolean {
    if (notification.kind !== "attention") return false;
    const graph = readGraphView(this.store, notification.graphId);
    const run = graph.current;
    if (run?.runId !== notification.runId || run.phase === "complete" || run.phase === "stopped") return true;
    return !notices(
      run,
      run.recordedPhase,
      executionId => this.store.readExecutionObservation(executionId),
    ).some(notice => notificationId(notification.graphId, run.runId, notice.key) === notification.id);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    clearInterval(this.timer);
    if (this.active === undefined) this.store.close();
  }
}
