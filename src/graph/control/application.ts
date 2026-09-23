/**
 * Graph v3 — the trusted control application service (P3 item 1)
 *
 * Version: 1.0
 * Date: 2026-09-24
 *
 * THE ONE WRITER OF TRUSTED CONTROL. Plan §3.4 separates an EXPLICIT RESULT from
 * TRUSTED CONTROL: a worker submits a claimed outcome through the submission
 * ingress, while a failure, a cancellation, a timeout, a retry and a budget stop
 * are lifecycle commands only a trusted principal may apply. This module is
 * where such a command becomes a DURABLE FACT — and it is the only writer of
 * that fact in the build, exactly as the domain model
 * (`src/graph/domain/model.ts`, P1) declared:
 *
 *   "Writers: the control application service (P3) and ONLY it. A worker's
 *    submission can never write one: control is not derived from a submitted
 *    payload."
 *
 * WHY A SEPARATE `control/` PACKAGE AND NOT `outcome/`. The outcome package is
 * the BUSINESS RESULT path: proposals, acceptance, natural completion, results.
 * Control is deliberately not outcome, and the module boundary says so: nothing
 * in the outcome run path reaches this writer by accident, and this module may
 * not construct an acceptance, a receipt or an accepted event. It reads the
 * store and the run-state reader to FIND the run and its in-flight attempts; it
 * writes control records and nothing else.
 *
 * WHAT A COMMAND DOES, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * - FAILURE / TIMEOUT: the host's fact that one attempt's execution ended
 *   without reaching its authorized outcome. The fact is recorded on the
 *   ATTEMPT (one control decision, keyed by the attempt) and on the RUN (the
 *   run's control fact, claimed once by a conditional update). NO accepted
 *   event, NO receipt and NO accepted result is written, so the run path's
 *   routing — which reads accepted events and join arrivals — cannot see the
 *   attempt as arrived. That is the mechanism that keeps a pending successor
 *   from being mis-started: a successor is armed only from an accepted event
 *   plus the feeder's current attempt, and a control decision is neither.
 * - CANCEL: the run is stopped (the same run fact) and every attempt still in
 *   flight is named by its own cancel decision — the durable cancel INTENT.
 *   The external executions themselves are NOT cancelled here: the platform
 *   cancel surface is a later work package's obligation, and pretending to have
 *   issued it would be the "declare convergence" the plan forbids. Every
 *   unconfirmed execution the store holds is REPORTED in the result instead.
 * - RETRY / BUDGET-STOP: refused by name (`command-unimplemented`) until their
 *   own work packages exist. The vocabulary is durable; the semantics are not
 *   invented here.
 *
 * PERMISSION: THE DECLARING PRINCIPAL, AND NOBODY ELSE. The subject that may
 * control a graph is the invocation the graph's declaration was attributed to —
 * the origin row the store already keeps (P1/P2) — and the caller's session is
 * the one the PLATFORM attributed to this call, never a value in the request.
 * §3.2 names the three subjects apart (declaring/controlling principal, actual
 * worker, host completion source); this is the first of them. A caller with no
 * attribution, a graph with no recorded declaration and a caller that is not
 * the declarer are three distinct refusals, each named. The host's own tool
 * boundary refuses a DISPATCHED WORKER before this code runs
 * (`OutcomeHost.bindTools` grants a bound worker the delivery channel only), so
 * a worker cannot present control authority even if it copies a request shape.
 *
 * IDEMPOTENCY AND RACES: DETERMINISTIC RULES, NOT AFTER-THOUGHTS.
 * 1. ONE ATTEMPT, ONE CONTROL FACT. The decision's primary key IS the attempt,
 *    so a repeat of the same command REPLAYS the persisted decision and a
 *    different command for the same attempt is a CONFLICT — nothing is written
 *    and the existing decision is returned. Both are structural (the store's
 *    conditional write), not a check-then-act in this module.
 * 2. ONE RUN, ONE STOPPING COMMAND — THE FIRST ONE. The run's control fact is
 *    claimed by a conditional update on the unclaimed row, so a second command
 *    never replaces the command that stopped the run first. Later commands are
 *    still recorded PER ATTEMPT (a sibling's failure, a cancel issued after a
 *    failure) because they are facts worth keeping — but the run keeps its
 *    first stop, and the answer always reports the fact that actually stands.
 * 3. AGAINST ACCEPTANCE. This service reads the attempt's accepted events and
 *    writes its decision in ONE store transaction, so an attempt that settled
 *    is refused (`attempt-already-settled`) and an attempt this service stops
 *    can no longer be settled: the run path refuses every settlement of a
 *    controlled run by name (`control-stopped`). Whichever transaction commits
 *    first wins; neither can leave an accepted event and a competing control
 *    fact for the same attempt.
 *
 * NEVER HIDE AN UNCONFIRMED EXTERNAL TASK. Every answer carries the run's
 * unsettled effects and every execution row of those attempts the host has NOT
 * confirmed (`pending` / `creating`), with the platform's own execution id when
 * the row carries one. Nothing in this module marks an effect terminal, deletes
 * a row or rewrites a binding: stopping a graph changes what the GRAPH does, not
 * what the host may already have created.
 *
 * Dependency leaf: the store, the compiled-definition reader and the run-state
 * reader.
 */

import type { CompiledPlan } from "../compiler/plan.ts";
import {
  decodeStoredDefinition,
} from "../persistence/declared-record.ts";
import type {
  ControlCommandName,
  ControlDecisionRecord,
  ControlPrincipalRecord,
  PendingEffectRecord,
  RunControlRecord,
} from "../ledger/types.ts";
import { dispatchEffectIdOf } from "../outcome/dispatch-effects.ts";
import {
  readOutcomeGraphState,
  type OutcomeGraphState,
} from "../outcome/graph-state.ts";
import type { GraphStore, GraphStoreTx } from "../store/graph-store.ts";
import type { GraphDefinitionRecord } from "../store/records.ts";

// ── The request ─────────────────────────────────────────────────────────────

/** The trusted invocation asking, as the platform attributed it. */
export interface GraphControlPrincipal {
  /** The session the platform attributed to this call. Never caller content. */
  readonly sessionId: string;
  /** The agent the platform attributed, when it attributes one. */
  readonly agentId?: string;
}

/** One control command a trusted principal asked for. */
export interface GraphControlRequest {
  readonly graphId: string;
  /** The command, from the durable closed vocabulary. */
  readonly command: ControlCommandName;
  /** The node the command names, for a node-scoped command. */
  readonly nodeId?: string;
  /** The attempt the command names, when the caller knows it. */
  readonly attemptId?: string;
  readonly reason: string;
  /** The trusted invocation. A request without one is refused, never guessed. */
  readonly principal: GraphControlPrincipal | undefined;
  /** Epoch milliseconds. Time is an explicit input, like every protocol write. */
  readonly at: number;
}

// ── The answer ──────────────────────────────────────────────────────────────

/**
 * Why a control command was refused before anything was written.
 *
 * A CLOSED vocabulary. Every member names one condition with one repair, and a
 * refusal is a VALUE (never a throw) so a tool can render it: only the store's
 * own failures propagate.
 */
export type GraphControlRefusalCode =
  /** The call carried no platform attribution, so no principal can be checked. */
  | "control-principal-absent"
  /** The graph has no recorded declaring invocation, so no one may control it. */
  | "control-declarant-unknown"
  /** The caller is not the declaring principal of this graph. */
  | "control-not-authorized"
  /** The command's own semantics are a later work package's; nothing is recorded. */
  | "command-unimplemented"
  /** The store holds no definition for this graph. */
  | "graph-unknown"
  /** The workspace store is absent, foreign, damaged, or a format this build cannot read. */
  | "store-unavailable"
  /** The stored definition of this graph is not one this build can run. */
  | "definition-unreadable"
  /** The graph has no run identity: it never began an execution. */
  | "run-not-started"
  /** The run's state snapshot is missing or is not this build's state for this plan. */
  | "run-state-unreadable"
  /** The named node is not one the compiled plan declares. */
  | "unknown-node"
  /** The node records no attempt in flight, so there is no attempt to control. */
  | "attempt-absent"
  /** The named attempt is not the node's current in-flight attempt. */
  | "attempt-not-current"
  /** The attempt already settled through the acceptance core. */
  | "attempt-already-settled"
  /** The attempt already carries a DIFFERENT control decision. */
  | "control-already-decided";

/** One structured control refusal. */
export interface GraphControlRefusal {
  readonly code: GraphControlRefusalCode;
  /** Where the condition lives, in the request's own path vocabulary. */
  readonly path: string;
  readonly message: string;
}

/** One decision this call recorded (or replayed) for one attempt. */
export interface GraphControlAttemptDecision {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly decision: ControlDecisionRecord;
  /** True when this exact command was already recorded: nothing new was written. */
  readonly replayed: boolean;
}

/** One in-flight attempt a run-wide command did NOT decide, and why. */
export interface GraphControlSkippedAttempt {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly code: GraphControlRefusalCode;
  readonly message: string;
}

/**
 * One execution row the host has NOT confirmed for an attempt of this run.
 *
 * `creating` is the one that matters: the request was handed to the platform and
 * the result is UNKNOWN, so an external task may exist. It is reported so a
 * control answer never reads as "nothing is running anywhere".
 */
export interface GraphControlUnconfirmedExecution {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly effectId: string;
  readonly state: "pending" | "creating";
  /** The platform's own id, when the row carries one (never invented). */
  readonly executionId?: string;
  readonly taskId?: string;
}

/** What one control command did. */
export type GraphControlResult =
  | {
      readonly kind: "applied";
      readonly graphId: string;
      readonly runId: string;
      readonly command: ControlCommandName;
      /** The decisions THIS call recorded or replayed, in plan node order. */
      readonly decided: readonly GraphControlAttemptDecision[];
      /**
       * The run's control fact AFTER this call. It is the FIRST command recorded
       * for the run, so a later command reports the one that actually stopped
       * it — never this call's candidate.
       */
      readonly runControl: RunControlRecord;
      /** In-flight attempts this call did not decide, because they had settled. */
      readonly skipped: readonly GraphControlSkippedAttempt[];
      /** Every effect of the run still pending or started. */
      readonly unsettledEffects: readonly PendingEffectRecord[];
      /** Every execution row of those attempts the host has not confirmed. */
      readonly unconfirmedExecutions: readonly GraphControlUnconfirmedExecution[];
    }
  | {
      readonly kind: "refused";
      readonly graphId: string;
      readonly refusals: readonly GraphControlRefusal[];
    };

// ── Internals ───────────────────────────────────────────────────────────────

/** One refusal, as a value. */
function refuse(
  graphId: string,
  code: GraphControlRefusalCode,
  path: string,
  message: string,
): GraphControlResult {
  return Object.freeze({
    kind: "refused" as const,
    graphId,
    refusals: Object.freeze([Object.freeze({ code, path, message })]),
  });
}

/** The principal to record, or `undefined` when the host named only a session. */
function principalOf(
  principal: GraphControlPrincipal,
): ControlPrincipalRecord | undefined {
  if (principal.agentId === undefined || principal.agentId.length === 0) {
    return Object.freeze({ sessionId: principal.sessionId });
  }
  return Object.freeze({ sessionId: principal.sessionId, agentId: principal.agentId });
}

/** The commands whose own semantics a later work package owns. */
const UNIMPLEMENTED_COMMANDS: ReadonlySet<ControlCommandName> = new Set([
  "retry",
  "budget-stop",
]);

/** The commands that apply to the whole run rather than to one named attempt. */
const RUN_WIDE_COMMANDS: ReadonlySet<ControlCommandName> = new Set(["cancel"]);

/**
 * The executions of this run the host has NOT confirmed.
 *
 * READ FROM THE STORE, NEVER FROM A GUESS: `created` rows ARE the host's
 * confirmation and are deliberately absent from this report, while `pending`
 * (a create right is held, nothing was handed over) and `creating` (handed
 * over, result unknown) are exactly the rows that may name an external task
 * nobody can see. A row is only reported when its attempt is still in flight in
 * the state this call read, so the report names work the run actually owes.
 */
function unconfirmedExecutionsOf(
  tx: GraphStoreTx,
  state: OutcomeGraphState,
): readonly GraphControlUnconfirmedExecution[] {
  const out: GraphControlUnconfirmedExecution[] = [];
  for (const node of state.nodes) {
    if (node.status !== "dispatched" || node.attemptId === undefined) continue;
    const effectId = dispatchEffectIdOf(node.attemptId);
    const row = tx.readExecution({
      graphId: state.graphId,
      effectId,
      attemptId: node.attemptId,
    });
    if (row === undefined || row.attemptId !== node.attemptId) continue;
    if (row.state === "created") continue;
    out.push(
      Object.freeze({
        nodeId: node.nodeId,
        attemptId: node.attemptId,
        effectId,
        state: row.state,
        ...(row.execution === undefined ? {} : { executionId: row.execution.executionId }),
        ...(row.execution?.taskId === undefined ? {} : { taskId: row.execution.taskId }),
      }),
    );
  }
  return Object.freeze(out);
}

// ── The service ─────────────────────────────────────────────────────────────

/**
 * Apply one trusted control command to one graph's run.
 *
 * SYNCHRONOUS and TOTAL: every expected condition is a refusal value, the whole
 * read-decide-write runs inside the store's ONE transaction, and the only
 * failures that propagate are the store's own (a closed store, a write that
 * could not commit) — which the caller must see rather than have dressed up as
 * a refusal.
 */
export function applyGraphControl(
  store: GraphStore,
  request: GraphControlRequest,
): GraphControlResult {
  const graphId = request.graphId;
  const principal = request.principal;
  if (principal === undefined || principal.sessionId.length === 0) {
    return refuse(
      graphId,
      "control-principal-absent",
      "$.principal",
      "graph-control refused [control-principal-absent]: the call carries no session " +
        "attribution, so there is no principal to check against the graph's declaring " +
        "invocation — control belongs to the trusted invocation the platform attributed to " +
        "the call, never to a value in the request, and nothing was written",
    );
  }
  if (UNIMPLEMENTED_COMMANDS.has(request.command)) {
    return refuse(
      graphId,
      "command-unimplemented",
      "$.command",
      "graph-control refused [command-unimplemented]: command " +
        JSON.stringify(request.command) +
        " is part of the durable control vocabulary but its semantics are not implemented " +
        "in this build (retry mints a new attempt with a new credential generation and new " +
        "effects; budget-stop reconciles reserved budget), so nothing was recorded — " +
        "recording an intent no path would honour is not a control capability",
    );
  }

  return store.transaction((tx): GraphControlResult => {
    // ── The write lock is taken FIRST, before any read ─────────────────────
    //
    // This command reads (the definition, the origin, the run, the state, the
    // accepted events) before it writes. SQLite refuses a shared-to-reserved
    // lock PROMOTION immediately — "database is locked", not a `busy_timeout`
    // wait — when another connection already holds the write lock, so without
    // this first write two commands racing for the same attempt would fail
    // with a driver error instead of resolving to `conflict`/`settled`
    // (reproduced cross-process, then fixed). The statement records nothing.
    tx.runs?.lockControlWrite(graphId);

    // ── The graph, its plan and its declaring principal ─────────────────────
    const row: GraphDefinitionRecord | undefined = tx.readDefinition(graphId);
    if (row === undefined) {
      return refuse(
        graphId,
        "graph-unknown",
        "$.graph_id",
        "graph-control refused [graph-unknown]: the workspace store holds no definition " +
          "for graph " +
          JSON.stringify(graphId) +
          " — a control command is never applied to a graph this store does not know",
      );
    }
    const decoded = decodeStoredDefinition(row);
    if (decoded.kind !== "ok") {
      return refuse(
        graphId,
        "definition-unreadable",
        "$.graph_id",
        "graph-control refused [definition-unreadable]: the stored definition of graph " +
          JSON.stringify(graphId) +
          " is not one this build can run: " +
          decoded.issues
            .map((issue) => "[" + issue.code + "] " + issue.path + ": " + issue.message)
            .join("; "),
      );
    }
    const plan: CompiledPlan = decoded.declared.plan;

    const origin = tx.readInvocationOrigin(graphId);
    if (origin === undefined) {
      return refuse(
        graphId,
        "control-declarant-unknown",
        "$.principal",
        "graph-control refused [control-declarant-unknown]: graph " +
          JSON.stringify(graphId) +
          " has no recorded declaring invocation, so there is no principal this store can " +
          "authorize to control it — an unattributed graph is not a graph anyone may stop",
      );
    }
    if (origin.sessionId !== principal.sessionId) {
      return refuse(
        graphId,
        "control-not-authorized",
        "$.principal",
        "graph-control refused [control-not-authorized]: the caller is session " +
          JSON.stringify(principal.sessionId) +
          " while graph " +
          JSON.stringify(graphId) +
          " was declared by session " +
          JSON.stringify(origin.sessionId) +
          " — control belongs to the DECLARING principal, never to a dispatched worker and " +
          "never to a caller that merely names the graph",
      );
    }

    // ── The run and its recorded position ───────────────────────────────────
    const runs = tx.runs;
    const run = runs?.readRun(graphId);
    if (runs === undefined || run === undefined) {
      return refuse(
        graphId,
        "run-not-started",
        "$.graph_id",
        "graph-control refused [run-not-started]: graph " +
          JSON.stringify(graphId) +
          " holds no run identity — it has never begun an execution, so there is no run to " +
          "control and nothing was written",
      );
    }
    const record = tx.readGraphState(graphId);
    if (record === undefined) {
      return refuse(
        graphId,
        "run-state-unreadable",
        "$.graph_id",
        "graph-control refused [run-state-unreadable]: run " +
          JSON.stringify(run.runId) +
          " of graph " +
          JSON.stringify(graphId) +
          " has no state snapshot — the run's position cannot be established, so no attempt " +
          "is controlled",
      );
    }
    let state: OutcomeGraphState;
    try {
      state = readOutcomeGraphState(record, plan);
    } catch (error) {
      return refuse(
        graphId,
        "run-state-unreadable",
        "$.graph_id",
        "graph-control refused [run-state-unreadable]: the run state of graph " +
          JSON.stringify(graphId) +
          " is not this build's state for its plan (" +
          (error instanceof Error ? error.message : String(error)) +
          ") — nothing was controlled",
      );
    }

    // ── The attempts this command decides ───────────────────────────────────
    const settled = new Set(tx.acceptedEvents(graphId).map((event) => event.attemptId));
    const targets: { readonly nodeId: string; readonly attemptId: string }[] = [];
    const skipped: GraphControlSkippedAttempt[] = [];

    if (RUN_WIDE_COMMANDS.has(request.command)) {
      if (request.nodeId !== undefined || request.attemptId !== undefined) {
        return refuse(
          graphId,
          "unknown-node",
          "$.node_id",
          "graph-control refused [unknown-node]: command " +
            JSON.stringify(request.command) +
            " applies to the whole run and names no node; pass neither node_id nor " +
            "attempt_id, or use a node-scoped command",
        );
      }
      for (const node of state.nodes) {
        if (node.status !== "dispatched" || node.attemptId === undefined) continue;
        if (settled.has(node.attemptId)) {
          skipped.push(
            Object.freeze({
              nodeId: node.nodeId,
              attemptId: node.attemptId,
              code: "attempt-already-settled" as const,
              message:
                "node " +
                node.nodeId +
                " attempt " +
                node.attemptId +
                " already settled through the acceptance core, so it is not cancelled — its " +
                "accepted result stands unchanged",
            }),
          );
          continue;
        }
        targets.push({ nodeId: node.nodeId, attemptId: node.attemptId });
      }
    } else {
      if (request.nodeId === undefined) {
        return refuse(
          graphId,
          "unknown-node",
          "$.node_id",
          "graph-control refused [unknown-node]: command " +
            JSON.stringify(request.command) +
            " names the attempt it applies to, so node_id is required and was not supplied",
        );
      }
      const node = state.nodes.find((entry) => entry.nodeId === request.nodeId);
      if (node === undefined) {
        return refuse(
          graphId,
          "unknown-node",
          "$.node_id",
          "graph-control refused [unknown-node]: graph " +
            JSON.stringify(graphId) +
            " declares no node " +
            JSON.stringify(request.nodeId),
        );
      }
      if (node.attemptId === undefined) {
        return refuse(
          graphId,
          "attempt-absent",
          "$.node_id",
          "graph-control refused [attempt-absent]: node " +
            JSON.stringify(node.nodeId) +
            " records no attempt at all (" +
            node.status +
            "), so there is no attempt for " +
            JSON.stringify(request.command) +
            " to record",
        );
      }
      if (request.attemptId !== undefined && request.attemptId !== node.attemptId) {
        return refuse(
          graphId,
          "attempt-not-current",
          "$.attempt_id",
          "graph-control refused [attempt-not-current]: node " +
            JSON.stringify(node.nodeId) +
            " is in flight on attempt " +
            JSON.stringify(node.attemptId) +
            " and the command names " +
            JSON.stringify(request.attemptId) +
            " — a control fact is never attached to an attempt the run no longer holds",
        );
      }
      if (settled.has(node.attemptId)) {
        return refuse(
          graphId,
          "attempt-already-settled",
          "$.node_id",
          "graph-control refused [attempt-already-settled]: node " +
            JSON.stringify(node.nodeId) +
            " attempt " +
            JSON.stringify(node.attemptId) +
            " already settled through the acceptance core, and a settled attempt is never " +
            "re-labelled as failed, timed out or cancelled",
        );
      }
      if (node.status !== "dispatched") {
        return refuse(
          graphId,
          "attempt-absent",
          "$.node_id",
          "graph-control refused [attempt-absent]: node " +
            JSON.stringify(node.nodeId) +
            " is " +
            node.status +
            ", not in flight, so there is nothing for " +
            JSON.stringify(request.command) +
            " to record",
        );
      }
      targets.push({ nodeId: node.nodeId, attemptId: node.attemptId });
    }

    // ── Write the decisions and the run's control fact ──────────────────────
    const decidedBy = principalOf(principal);
    const decided: GraphControlAttemptDecision[] = [];
    let runControl: RunControlRecord | undefined;
    for (const target of targets) {
      const written = runs.writeControlDecision({
        decision: Object.freeze({
          graphId,
          runId: run.runId,
          nodeId: target.nodeId,
          attemptId: target.attemptId,
          command: request.command,
          reason: request.reason,
          decidedAt: request.at,
          ...(decidedBy === undefined ? {} : { decidedBy }),
        }),
        runControl: Object.freeze({
          graphId,
          runId: run.runId,
          command: request.command,
          reason: request.reason,
          decidedAt: request.at,
          ...(decidedBy === undefined ? {} : { decidedBy }),
        }),
      });
      if (written.kind === "settled") {
        // THE DECISIVE WRITE FOUND AN ACCEPTED EVENT. The read above may not have
        // seen it — an acceptance committed while this transaction was open — so
        // this is the branch that makes the race deterministic: the attempt
        // settled FIRST, the whole command is refused and NOTHING is written
        // (the run fact is not claimed either), and re-issuing the command
        // applies it to the attempts still in flight.
        return refuse(
          graphId,
          "attempt-already-settled",
          "$.node_id",
          "graph-control refused [attempt-already-settled]: node " +
            JSON.stringify(target.nodeId) +
            " attempt " +
            JSON.stringify(target.attemptId) +
            " settled through the acceptance core while this command was being applied, so " +
            JSON.stringify(request.command) +
            " is not recorded for it and nothing was written — re-issue the command for the " +
            "attempts still in flight",
        );
      }
      if (written.kind === "conflict") {
        return refuse(
          graphId,
          "control-already-decided",
          "$.attempt_id",
          "graph-control refused [control-already-decided]: node " +
            JSON.stringify(target.nodeId) +
            " attempt " +
            JSON.stringify(target.attemptId) +
            " already carries the control command " +
            JSON.stringify(written.existing.command) +
            " (" +
            written.existing.reason +
            "), so " +
            JSON.stringify(request.command) +
            " is not recorded over it — one attempt carries at most one control fact",
        );
      }
      runControl = written.runControl ?? runControl;
      decided.push(
        Object.freeze({
          nodeId: target.nodeId,
          attemptId: target.attemptId,
          decision: written.decision,
          replayed: written.kind === "replayed",
        }),
      );
      // A COMMAND IS ATOMIC: every decision it records commits with the run
      // fact, or none of them does. A refusal below rolls the whole transaction
      // back, including the decisions already inserted for other attempts, so a
      // partially applied cancel is unrepresentable.
    }

    if (runControl === undefined) {
      // Reachable for a run-wide command with NOTHING in flight: the run fact IS
      // the decision (a graph whose entry dispatches were all refused still has
      // to be stoppable). It is claimed directly, under the same first-wins
      // rule, and the claim answers with the fact that stands.
      const claimed = runs.claimRunControl(
        Object.freeze({
          graphId,
          runId: run.runId,
          command: request.command,
          reason: request.reason,
          decidedAt: request.at,
          ...(decidedBy === undefined ? {} : { decidedBy }),
        }),
      );
      if (claimed === undefined) {
        return refuse(
          graphId,
          "run-state-unreadable",
          "$.graph_id",
          "graph-control refused [run-state-unreadable]: run " +
            JSON.stringify(run.runId) +
            " of graph " +
            JSON.stringify(graphId) +
            " disappeared between this call's read and its write, so the control fact was " +
            "not recorded",
        );
      }
      runControl = claimed;
    }

    return Object.freeze({
      kind: "applied" as const,
      graphId,
      runId: run.runId,
      command: request.command,
      decided: Object.freeze(decided),
      runControl,
      skipped: Object.freeze(skipped),
      unsettledEffects: Object.freeze(tx.pendingEffects(graphId)),
      unconfirmedExecutions: unconfirmedExecutionsOf(tx, state),
    });
  });
}
