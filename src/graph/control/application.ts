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
 *   flight is named by its own cancel decision — the durable cancel INTENT. An
 *   attempt that ALREADY carries another control command keeps that fact and is
 *   reported as SKIPPED; every other in-flight attempt still gets the intent.
 *   The external executions themselves are NOT cancelled HERE: this module
 *   writes control records and nothing else. The intent is handed to the
 *   platform by the host's cancel delivery (`src/graph/outcome/cancel.ts`,
 *   driven by `OutcomeHost.deliverCancelIntents` and the boot sweep), which is
 *   why the intent must be durable BEFORE any platform call; pretending here to
 *   have issued a cancel would be the "declare convergence" the plan forbids.
 *   Every unconfirmed execution the store holds is REPORTED in the result — the
 *   answer never reads as "nothing is running anywhere".
 * - RETRY (P3 item 2): a SUCCESSOR command, not a stopping one, and it has TWO
 *   SCOPES decided by its target. Node-scoped, it supersedes that node's current
 *   in-flight attempt with a NEW attempt ON THE SAME RUN — a new attempt id and
 *   sequence, a new credential adopted by the host's store inside this
 *   transaction, and a new dispatch effect — while the superseded attempt's own
 *   decision, effect and execution binding stay exactly as they were, and a
 *   SETTLED attempt is refused outright because its result is immutable. Run-scoped,
 *   it records the trusted ORDER to re-execute a terminal run as a NEW RUN; the
 *   runtime mints that run (the host's follow-up, or the boot sweep), so the order
 *   outlives the process that decided it. NEITHER scope writes an accepted event, a
 *   receipt or an accepted result, and neither arms a successor node: a retry
 *   invalidates exactly the attempt it supersedes, which is why a downstream node
 *   whose external side effect already completed is never re-run.
 * - BUDGET-STOP: refused by name (`command-unimplemented`) until its own work
 *   package exists. The vocabulary is durable; the semantics are not invented here.
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
 * 2. ONE RUN, ONE STOPPING COMMAND — THE FIRST ONE; ONE ATTEMPT, ONE SUCCESSOR. The run's control fact is
 *    claimed by a conditional update on the unclaimed row, so a second command
 *    never replaces the command that stopped the run first. Later commands are
 *    still recorded PER ATTEMPT for every in-flight attempt that carries none:
 *    a sibling's failure, and a cancel issued after a failure, record their own
 *    decision on each attempt still owed one, because those are facts worth
 *    keeping. An attempt that ALREADY carries a different command is never
 *    re-labelled — a node-scoped command naming it is refused
 *    `control-already-decided`, while a RUN-WIDE command (a cancel) reports it
 *    as a SKIPPED target and carries on with the rest of the run, so one failed
 *    attempt can never block the cancellation of every other in-flight
 *    execution. The run keeps its first stop, and the answer reports the fact
 *    that actually stands.
 * 3. AGAINST ACCEPTANCE, IN BOTH DIRECTIONS. This service reads the attempt's
 *    accepted events and writes its decision in ONE store transaction, so an
 *    attempt that settled is refused (`attempt-already-settled`). The inverse
 *    rule is enforced on the acceptance side in the SAME shape and does NOT rest
 *    on a value read before it: the FIRST statement of `commitAccepted`'s batch
 *    write is a receipt INSERT conditioned on the run having no control fact
 *    (`WHERE NOT EXISTS`), so a batch whose run carries one is refused
 *    (verdict `controlled`, nothing written) against the committed store — the
 *    run path additionally refuses the same fact by name (`control-stopped`)
 *    both before it validates a submission and again INSIDE its acceptance
 *    transaction, so a command that commits while a submission is between those
 *    two checks still wins. Whichever COMMITS first is therefore the fact that
 *    stands and the loser writes NOTHING: one attempt can never carry both an
 *    accepted event and a control decision — at the store API, not only on the
 *    shipped run path.
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
  RunReexecutionRecord,
  StoredRunIdentity,
} from "../ledger/types.ts";
import {
  attemptCredentialBinding,
  attemptCredentialDigest,
  mintAttemptCredential,
  RUNTIME_ATTEMPT_CREDENTIAL_SOURCE,
  type AttemptCredentialSource,
} from "../outcome/attempt-credential.ts";
import {
  readCredentialIsolationStore,
  type CredentialIsolationCapability,
} from "../outcome/credential-isolation.ts";
import {
  blockingReexecutionEffectsOf,
  dispatchEffectIdOf,
  type OutcomeDispatchTarget,
} from "../outcome/dispatch-effects.ts";
import {
  readOutcomeGraphState,
  stateRecordOf,
  type OutcomeGraphState,
  type OutcomeNodeState,
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

/**
 * What a `retry` needs to mint its successor attempt's CREDENTIAL (P3 item 2).
 *
 * WHY THE CONTROL PATH NEEDS A HOST CAPABILITY AT ALL. A retry mints a new
 * attempt, and an attempt is only usable with the bearer credential its worker
 * will present. This build persists only the credential's DIGEST, so the VALUE
 * has to be adopted by the host's protected store INSIDE the same transaction
 * that records the digest — exactly as the run path's own dispatch does — or the
 * attempt could never be delivered after a restart. A process without a readable
 * version-3 store refuses the command by name rather than writing an attempt
 * nobody can settle.
 *
 * THE SOURCE IS INJECTABLE for the same reason the run path's is: a test pins
 * the credential value deterministically, while production uses the platform
 * CSPRNG. Omitting it is NOT "no credential" — it is the shipped source.
 */
export interface GraphControlRetryCapability {
  /** The protected store the value is adopted by, inside the caller's transaction. */
  readonly credentialIsolation: CredentialIsolationCapability;
  /** The minting source; defaults to the platform CSPRNG. */
  readonly mintCredential?: AttemptCredentialSource;
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
  /**
   * What a `retry` needs to mint its successor attempt's credential. Absent
   * means this process cannot mint one, and a retry is refused
   * `credential-isolation-unavailable` — never applied without a usable
   * credential.
   */
  readonly retry?: GraphControlRetryCapability;
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
  /**
   * A NODE-SCOPED retry names a run a trusted control command already STOPPED
   * (or a declared stop ended). Re-attempting a node inside a stopped run would
   * mint an attempt no settlement path can ever accept, so the command is
   * refused and the repair is the RUN-scoped retry: re-execute the graph as a
   * new run.
   */
  | "run-stopped"
  /**
   * A RUN-SCOPED retry names a run that is still executing (or has never
   * started). A new run exists to REPLACE a finished one; a run with work in
   * flight is retried with the node-scoped form, which supersedes one attempt.
   */
  | "run-not-terminal"
  /**
   * A RUN-SCOPED retry names a terminal run whose external work is NOT accounted
   * for: at least one unsettled dispatch effect whose attempt the run never
   * superseded and which no platform-confirmed cancellation covers. Re-executing
   * the graph could re-run a side effect that is still live, which §4 forbids
   * outright; the effects are named, stay visible, and the caller resolves them
   * (or waits for the platform) before ordering the re-execution.
   */
  | "run-has-unsettled-effects"
  /**
   * A retry cannot mint the successor attempt's credential: this process holds
   * no readable version-3 credential-isolation capability, so the value could
   * not be adopted by the host's store inside the transaction that records its
   * digest — and an attempt whose credential the host never held could never be
   * delivered or settled. Nothing was written.
   */
  | "credential-isolation-unavailable"
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

/**
 * One attempt a `retry` MINTED, in the answer's own words.
 *
 * CREDENTIAL-FREE, like every other report: the successor attempt's credential
 * value was handed to the dispatch that will carry it and to nowhere else — this
 * answer names the attempt, its sequence and the effect a host launches it by.
 */
export interface GraphControlMintedAttempt {
  readonly nodeId: string;
  readonly attemptId: string;
  /** The graph-wide attempt sequence the successor minted. */
  readonly attemptSeq: number;
  /** The dispatch effect id a launch resolves it by. */
  readonly effectId: string;
}

/**
 * The re-execution a RUN-SCOPED `retry` recorded (P3 item 2).
 *
 * The order is durable whether or not the successor exists yet: a process that
 * dies between the order and the mint leaves it for the next window (the tool
 * call's own host follow-up, the boot sweep) to honour, exactly as a dispatch
 * intent outlives the create it authorizes.
 */
export interface GraphControlReexecution {
  /** The terminal run this order supersedes. */
  readonly fromRunId: string;
  readonly order: RunReexecutionRecord;
  /** The successor run, present exactly when the re-execution has committed. */
  readonly successorRunId?: string;
  /** The successor's graph-local sequence, with {@link successorRunId}. */
  readonly successorRunSeq?: number;
}

/** What one control command did. */
export type GraphControlResult =
  | {
      readonly kind: "applied";
      readonly graphId: string;
      readonly runId: string;
      readonly command: ControlCommandName;
      /**
       * What the command acted on: `attempt` for a node-scoped command (it names
       * attempts of one node — including a `retry`, which supersedes one), `run`
       * for a command that acts on the run itself (a cancel, and a run-scoped
       * `retry`, which orders a new run).
       */
      readonly scope: "attempt" | "run";
      /**
       * The attempts a `retry` MINTED, in node order; empty for every other
       * command. A replay of an earlier retry reports the successor THAT decision
       * recorded — the same attempt, never a second one.
       */
      readonly minted: readonly GraphControlMintedAttempt[];
      /**
       * The run-level re-execution a RUN-SCOPED `retry` recorded, present exactly
       * for that command.
       */
      readonly reexecution?: GraphControlReexecution;
      /** The decisions THIS call recorded or replayed, in plan node order. */
      readonly decided: readonly GraphControlAttemptDecision[];
      /**
       * The run's control fact AFTER this call. It is the FIRST command recorded
       * for the run, so a later command reports the one that actually stopped
       * it — never this call's candidate. ABSENT when the run carries none and
       * this command did not claim one (a retry supersedes an attempt; it does
       * not stop the run).
       */
      readonly runControl?: RunControlRecord;
      /**
       * In-flight attempts this call did not decide, because they had already
       * settled through the acceptance core, or — for a run-wide command — because
       * they already carry another control command and are never re-labelled.
       */
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
        "in this build (budget-stop reconciles reserved budget against real usage), so " +
        "nothing was recorded — recording an intent no path would honour is not a control " +
        "capability",
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

    // ── RETRY IS ITS OWN COMMAND (P3 item 2) ────────────────────────────────
    //
    // It shares every read above (the definition, the declaring principal, the
    // run, the state, the accepted events) and the write lock, so it is the SAME
    // entry and the SAME permission model — but what it writes is different in
    // kind from a stopping command: a successor ATTEMPT on the run (a node-scoped
    // retry) or a trusted ORDER to execute a NEW run (a run-scoped retry). Both
    // are implemented in one place below, against this one context.
    if (request.command === "retry") {
      return applyRetryCommand({
        tx,
        graphId,
        plan,
        run,
        state,
        settled: new Set(tx.acceptedEvents(graphId).map((event) => event.attemptId)),
        request,
        principal,
      });
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
        // A RUN-WIDE COMMAND SKIPS A TARGET THAT ALREADY CARRIES ANOTHER
        // CONTROL FACT instead of refusing the whole command. The store wrote
        // NOTHING for this attempt (the conditional INSERT did not land and the
        // conflict verdict returns the existing row), so the other in-flight
        // attempts still get their cancel decision, the run keeps its first
        // stop, and "one attempt, one control fact" is preserved. Refusing here
        // instead would let one already-failed attempt block the cancellation of
        // every other execution the run still owes (the fan-out case).
        if (RUN_WIDE_COMMANDS.has(request.command)) {
          skipped.push(
            Object.freeze({
              nodeId: target.nodeId,
              attemptId: target.attemptId,
              code: "control-already-decided" as const,
              message:
                "node " +
                target.nodeId +
                " attempt " +
                target.attemptId +
                " already carries the control command " +
                JSON.stringify(written.existing.command) +
                " (" +
                written.existing.reason +
                "), so " +
                JSON.stringify(request.command) +
                " is not recorded over it — the attempt keeps its own fact and is " +
                "reported as skipped while the command applies to the rest of the run",
            }),
          );
          continue;
        }
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
      // A COMMAND IS ATOMIC: every decision it ACTUALLY RECORDS commits with the
      // run fact, or none of them does. A `settled` refusal below rolls the whole
      // transaction back, including the decisions already inserted for other
      // attempts, so a partially applied cancel is unrepresentable. A `conflict`
      // on a run-wide command is not a refusal (see above): the attempt keeps its
      // own fact and is reported as skipped, and the decisions taken for the
      // remaining attempts still commit together.
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
      // A stopping command names the attempts it decided; only a cancel acts on
      // the run itself, and it is the one run-wide member of this set.
      scope: RUN_WIDE_COMMANDS.has(request.command) ? ("run" as const) : ("attempt" as const),
      minted: Object.freeze([]),
      decided: Object.freeze(decided),
      runControl,
      skipped: Object.freeze(skipped),
      unsettledEffects: Object.freeze(tx.pendingEffects(graphId, run.runId)),
      unconfirmedExecutions: unconfirmedExecutionsOf(tx, state),
    });
  });
}

// ── Retry (P3 item 2) ───────────────────────────────────────────────────────

/**
 * Everything a retry decides from, read ONCE inside the control transaction.
 *
 * The same reads the stopping commands use, handed over rather than repeated:
 * the retry is a different COMMAND, not a different entry, and a second read
 * would be a second chance to disagree with the transaction the command commits
 * in.
 */
interface RetryCommandContext {
  readonly tx: GraphStoreTx;
  readonly graphId: string;
  readonly plan: CompiledPlan;
  readonly run: StoredRunIdentity;
  readonly state: OutcomeGraphState;
  /** The attempts that already settled through the acceptance core. */
  readonly settled: ReadonlySet<string>;
  readonly request: GraphControlRequest;
  readonly principal: GraphControlPrincipal;
}

/**
 * Apply ONE `retry` command, in the transaction the caller already opened.
 *
 * TWO SCOPES, ONE COMMAND, AND THE TARGET DECIDES WHICH:
 *
 * - NODE-SCOPED (`node_id` given): supersede that node's current in-flight
 *   attempt with a NEW attempt ON THE SAME RUN — a new attempt id and sequence, a
 *   new credential (adopted by the host's store inside this transaction) and a
 *   new dispatch effect. The superseded attempt's facts are NOT rewritten: its
 *   control decision (the failure that prompted this), its effect row and its
 *   execution binding stay exactly as they were, and its receipt/accepted event
 *   can only exist if it settled — in which case the retry is REFUSED, because a
 *   settled attempt's result is immutable and re-running it in place would
 *   rewrite the semantics of an attempt that already meant something.
 * - RUN-SCOPED (`node_id` absent): the graph's TERMINAL run is ordered
 *   re-executed as a NEW RUN (§3.2: "终态图重新运行创建新 Run"). The order is a
 *   durable trusted record; the new run is minted by the runtime that honours it
 *   (the host's follow-up, or the boot sweep), so a process that dies in between
 *   leaves an order the next window finishes.
 *
 * WHAT A RETRY NEVER DOES, IN EITHER SCOPE:
 * - it writes no accepted event, no receipt and no accepted result: control is
 *   not outcome (§3.4), so no retry is ever a business success;
 * - it arms NO successor node: only the retried node's own attempt is replaced.
 *   The invalidation scope of a retry is exactly the superseded attempt, and the
 *   boundary is the arrival rule — a downstream node is armed only from an
 *   ACCEPTED EVENT of a settled feeder, and a superseded attempt produced none
 *   (it cannot: a settled feeder is refused above). Downstream nodes therefore
 *   keep their attempts, receipts and effects untouched, and a downstream
 *   external side effect that already completed is never re-run;
 * - it cancels nothing automatically: the superseded attempt's external
 *   execution is left visible as an unsettled effect (its fate is the host's
 *   fact, not something this command may claim), so an operator can see that an
 *   execution may still be live;
 * - it does not stop the run: the successor attempt must be settleable, so the
 *   run's control fact is deliberately not claimed.
 */
function applyRetryCommand(ctx: RetryCommandContext): GraphControlResult {
  const { tx, graphId, plan, run, state, settled, request, principal } = ctx;
  const runs = tx.runs;
  if (runs === undefined) {
    // Unreachable: the run was read through this surface above.
    return refuse(
      graphId,
      "run-not-started",
      "$.graph_id",
      "graph-control refused [run-not-started]: this substrate holds no run/control " +
        "surface, so a retry has no run to supersede",
    );
  }
  const decidedBy = principalOf(principal);
  if (request.nodeId === undefined) {
    if (request.attemptId !== undefined) {
      return refuse(
        graphId,
        "unknown-node",
        "$.node_id",
        "graph-control refused [unknown-node]: a RUN-SCOPED retry names the run to " +
          "re-execute and no attempt; pass neither node_id nor attempt_id, or name the node " +
          "whose attempt is superseded",
      );
    }
    return orderReexecution(ctx, runs, decidedBy);
  }

  // ── NODE-SCOPED: supersede one attempt ────────────────────────────────────
  const stopping = runs.readRunControlOf(graphId, run.runId);
  if (stopping !== undefined) {
    return refuse(
      graphId,
      "run-stopped",
      "$.node_id",
      "graph-control refused [run-stopped]: run " +
        JSON.stringify(run.runId) +
        " of graph " +
        JSON.stringify(graphId) +
        " was STOPPED by the trusted control command " +
        JSON.stringify(stopping.command) +
        " (" +
        stopping.reason +
        "), so no submission can settle an attempt of it — retrying the node in place " +
        "would mint an attempt nothing can accept; re-execute the graph as a NEW run " +
        "(a run-scoped retry), and nothing was written",
    );
  }
  if (state.stop !== undefined || state.phase === "stopped") {
    return refuse(
      graphId,
      "run-stopped",
      "$.node_id",
      "graph-control refused [run-stopped]: run " +
        JSON.stringify(run.runId) +
        " of graph " +
        JSON.stringify(graphId) +
        " ended on a declared stop (" +
        (state.stop === undefined ? state.phase : state.stop.reason) +
        "), so it takes no further step — retrying the node in place would mint an " +
        "attempt nothing can accept; re-execute the graph as a NEW run (a run-scoped " +
        "retry), and nothing was written",
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
  // IDEMPOTENCY COMES FIRST, AND IT IS WHY AN EXPLICIT REPEAT STILL REPLAYS.
  // The retry's durable identity is the attempt it SUPERSEDES, so a repeated
  // retry of that attempt replays the decision that minted its successor instead
  // of minting a second one — even though the named attempt is no longer the
  // node's CURRENT one (the first retry replaced it). And a retry that names NO
  // attempt — the common call, "retry this node" — replays the retry that
  // produced the node's current attempt: superseding a retry's own successor
  // takes naming it explicitly, which is the only way to say "this successor is
  // wrong too" without an accidental second attempt.
  const namedAttemptId = request.attemptId;
  if (namedAttemptId !== undefined) {
    const repeated = runs.readControlCommandDecision(
      graphId,
      run.runId,
      node.nodeId,
      namedAttemptId,
      "retry",
    );
    if (repeated !== undefined) return replayedRetry(ctx, repeated);
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
        "), so there is no attempt for a retry to supersede",
    );
  }
  if (namedAttemptId !== undefined && namedAttemptId !== node.attemptId) {
    return refuse(
      graphId,
      "attempt-not-current",
      "$.attempt_id",
      "graph-control refused [attempt-not-current]: node " +
        JSON.stringify(node.nodeId) +
        " is in flight on attempt " +
        JSON.stringify(node.attemptId) +
        " and the command names " +
        JSON.stringify(namedAttemptId) +
        " — a retry supersedes the attempt the run actually holds, never one it has " +
        "already replaced; an attempt this run ALREADY retried replays that decision " +
        "instead",
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
        " already settled through the acceptance core, and a settled attempt's result is " +
        "IMMUTABLE — it is never re-labelled, never re-run in place and never rewritten; " +
        "re-executing the graph as a new run (a run-scoped retry) is the way to run the " +
        "node again, and nothing was written",
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
        ", not in flight, so there is no attempt for a retry to supersede",
    );
  }

  const supersededAttemptId = node.attemptId;
  // THE IMPLICIT REPEAT: a retry that names NO attempt replays the retry that
  // produced the node's CURRENT attempt, so "retry this node" twice is ONE
  // successor. Superseding the successor takes naming it, and that check ran
  // before the currency checks for exactly this reason.
  if (namedAttemptId === undefined) {
    const implicit = runs
      .controlDecisions(graphId, run.runId)
      .find(
        (decision) =>
          decision.command === "retry" &&
          decision.nodeId === node.nodeId &&
          decision.successorAttemptId === supersededAttemptId,
      );
    if (implicit !== undefined) return replayedRetry(ctx, implicit);
  }

  const capability = request.retry;
  const credentialStore =
    capability === undefined
      ? undefined
      : readCredentialIsolationStore(capability.credentialIsolation);
  if (credentialStore === undefined) {
    return refuse(
      graphId,
      "credential-isolation-unavailable",
      "$.retry",
      "graph-control refused [credential-isolation-unavailable]: a retry mints a NEW " +
        "attempt, and this process holds no readable version-3 credential-isolation " +
        "capability to adopt the attempt's credential into the host's protected store — an " +
        "attempt whose credential the host never held could never be delivered or " +
        "settled, so nothing was written",
    );
  }
  const planNode = plan.nodes.find((entry) => entry.id === node.nodeId);
  if (planNode === undefined) {
    return refuse(
      graphId,
      "unknown-node",
      "$.node_id",
      "graph-control refused [unknown-node]: the stored plan of graph " +
        JSON.stringify(graphId) +
        " declares no node " +
        JSON.stringify(node.nodeId) +
        ", so the successor attempt has no dispatch target — nothing was written",
    );
  }

  const attemptSeq = state.attemptSeq + 1;
  const successorAttemptId = node.nodeId + "#" + attemptSeq;
  const payload: OutcomeDispatchTarget = Object.freeze({
    graphId,
    planRevision: plan.planRevision,
    nodeId: node.nodeId,
    attemptId: successorAttemptId,
    agent: planNode.agent,
    prompt: planNode.prompt,
  });
  // THE DECISIVE WRITE IS FIRST (the same rule the stopping commands follow):
  // the decision lands only when no accepted event exists for the superseded
  // attempt AT THIS MOMENT, so a retry racing an acceptance resolves by who
  // commits first — and it takes the RESERVED lock before the credential is
  // minted, so nothing is minted for a command that is about to be refused.
  const written = runs.writeControlDecision({
    decision: Object.freeze({
      graphId,
      runId: run.runId,
      nodeId: node.nodeId,
      attemptId: supersededAttemptId,
      command: "retry" as const,
      reason: request.reason,
      decidedAt: request.at,
      ...(decidedBy === undefined ? {} : { decidedBy }),
      successorAttemptId,
    }),
    // NO runControl: a retry supersedes an attempt, it does not stop the run.
  });
  if (written.kind === "settled") {
    return refuse(
      graphId,
      "attempt-already-settled",
      "$.node_id",
      "graph-control refused [attempt-already-settled]: node " +
        JSON.stringify(node.nodeId) +
        " attempt " +
        JSON.stringify(supersededAttemptId) +
        " settled through the acceptance core while this retry was being applied, so the " +
        "retry is refused and NOTHING was written — a settled attempt's result is " +
        "immutable, and re-executing the graph as a new run is the way to run the node " +
        "again",
    );
  }
  if (written.kind === "conflict") {
    return refuse(
      graphId,
      "control-already-decided",
      "$.attempt_id",
      "graph-control refused [control-already-decided]: node " +
        JSON.stringify(node.nodeId) +
        " attempt " +
        JSON.stringify(supersededAttemptId) +
        " already carries the control command " +
        JSON.stringify(written.existing.command) +
        " (" +
        written.existing.reason +
        "), which the retry could not be recorded beside — nothing was written",
    );
  }
  if (written.kind === "replayed") {
    // A racing retry recorded the same decision first. Nothing is minted: the
    // successor the winner's decision names is the one that stands.
    return replayedRetry(ctx, written.decision);
  }

  // ── Mint the successor attempt, its credential and its effect ─────────────
  const credential = mintAttemptCredential(
    capability?.mintCredential ?? RUNTIME_ATTEMPT_CREDENTIAL_SOURCE,
    attemptCredentialBinding({
      graphId,
      nodeId: node.nodeId,
      attemptId: successorAttemptId,
      planRevision: plan.planRevision,
    }),
  );
  // The host's store adopts the value INSIDE this transaction, so the state that
  // records its digest and the store that holds the value commit together.
  credentialStore.remember(
    Object.freeze({ graphId, nodeId: node.nodeId, attemptId: successorAttemptId }),
    credential,
  );
  const nodes: OutcomeNodeState[] = state.nodes.map((entry) =>
    entry.nodeId !== node.nodeId
      ? entry
      : Object.freeze({
          nodeId: node.nodeId,
          status: "dispatched" as const,
          attemptId: successorAttemptId,
          attemptSeq,
          attemptCredentialDigest: attemptCredentialDigest(credential),
          // NO dispatch identity is recorded for the successor: the retry is
          // decided by the DECLARING principal, not by the invocation the new
          // worker will submit from, and writing the declarer's identity onto the
          // attempt would make the very submission the retry exists to accept
          // fail its own check. Absence is the honest record (D9: a host that
          // recorded none back-fills none), and the credential still binds the
          // attempt to whoever receives it.
          dispatchedAt: request.at,
          // The arrival record is not this command's to change: it is the
          // canonical list of settled feeders, and a retry settles nothing.
          arrivals: entry.arrivals ?? Object.freeze([]),
        }),
  );
  const nextState: OutcomeGraphState = Object.freeze({
    ...state,
    nodes: Object.freeze(nodes),
    attemptSeq,
  });
  // THE STATE AND THE EFFECT COMMIT WITH THE DECISION: the run records the
  // successor attempt, the effect is the durable intent to start it, and the
  // credential the host's store now holds is the one its worker presents. A
  // throw here rolls the whole command back — decision, credential record, state
  // and effect — so a retry is never half-applied.
  tx.writeGraphState(stateRecordOf(nextState, request.at));
  tx.writeEffect(
    Object.freeze({
      graphId,
      effectId: dispatchEffectIdOf(successorAttemptId),
      attemptId: successorAttemptId,
      kind: "dispatch",
      payload,
      createdAt: request.at,
      status: "pending" as const,
    }),
  );
  return Object.freeze({
    kind: "applied" as const,
    graphId,
    runId: run.runId,
    command: request.command,
    scope: "attempt" as const,
    minted: Object.freeze([
      Object.freeze({
        nodeId: node.nodeId,
        attemptId: successorAttemptId,
        attemptSeq,
        effectId: dispatchEffectIdOf(successorAttemptId),
      }),
    ]),
    decided: Object.freeze([
      Object.freeze({
        nodeId: node.nodeId,
        attemptId: supersededAttemptId,
        decision: written.decision,
        replayed: false,
      }),
    ]),
    runControl: written.runControl,
    skipped: Object.freeze([]),
    // THE SUPERSEDED ATTEMPT'S WORK STAYS VISIBLE. The report is computed over
    // the state this command read, so the attempt it just replaced is still named
    // with its unsettled effect and any unconfirmed execution: a retry never
    // hides an external task whose fate is unknown, and it never marks the
    // superseded effect terminal (its execution is the host's fact).
    unsettledEffects: Object.freeze(tx.pendingEffects(graphId, run.runId)),
    unconfirmedExecutions: unconfirmedExecutionsOf(tx, state),
  });
}

/**
 * The answer to a retry whose decision is ALREADY recorded.
 *
 * Nothing is written and nothing is minted: the persisted decision names the
 * successor attempt it created, and that attempt is the node's current one. A
 * MISSING successor link is an inconsistency this store cannot produce (the
 * DDL's CHECK requires one for a retry), so it is refused rather than reported
 * as a successor nobody can address.
 */
function replayedRetry(
  ctx: RetryCommandContext,
  decision: ControlDecisionRecord,
): GraphControlResult {
  const { tx, graphId, run, state, request } = ctx;
  const successorAttemptId = decision.successorAttemptId;
  if (successorAttemptId === undefined) {
    return refuse(
      graphId,
      "run-state-unreadable",
      "$.node_id",
      "graph-control refused [run-state-unreadable]: the recorded retry of node " +
        JSON.stringify(decision.nodeId) +
        " attempt " +
        JSON.stringify(decision.attemptId) +
        " carries no successor attempt, so the attempt that stands cannot be established " +
        "and nothing was written",
    );
  }
  return Object.freeze({
    kind: "applied" as const,
    graphId,
    runId: run.runId,
    command: request.command,
    scope: "attempt" as const,
    minted: Object.freeze([
      Object.freeze({
        nodeId: decision.nodeId,
        attemptId: successorAttemptId,
        // The sequence is derived from the successor id the decision recorded,
        // and only when the id carries this node's own prefix — a successor id
        // from another node could not be this decision's attempt.
        attemptSeq: attemptSeqOf(successorAttemptId, decision.nodeId),
        effectId: dispatchEffectIdOf(successorAttemptId),
      }),
    ]),
    decided: Object.freeze([
      Object.freeze({
        nodeId: decision.nodeId,
        attemptId: decision.attemptId,
        decision,
        replayed: true,
      }),
    ]),
    runControl: tx.runs?.readRunControlOf(graphId, run.runId),
    skipped: Object.freeze([]),
    unsettledEffects: Object.freeze(tx.pendingEffects(graphId, run.runId)),
    unconfirmedExecutions: unconfirmedExecutionsOf(tx, state),
  });
}

/** The attempt sequence one successor id carries, or 0 when it names another node. */
function attemptSeqOf(successorAttemptId: string, nodeId: string): number {
  const prefix = nodeId + "#";
  if (!successorAttemptId.startsWith(prefix)) return 0;
  const parsed = Number(successorAttemptId.slice(prefix.length));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Record the trusted ORDER to re-execute one terminal run as a new run.
 *
 * WHAT THIS WRITES, AND WHAT IT DELIBERATELY DOES NOT. It writes the order —
 * durable, attributed, idempotent on `(graph, run)` — and CLOSES the run it
 * supersedes by claiming its control fact with the command `retry` when no
 * other command stopped it first (a cancel's fact is never replaced). It does
 * NOT mint the new run: that is the run path's own operation
 * (`OutcomeGraphRuntime.reexecute`), reached by the host's follow-up to this
 * command or by the next boot sweep, so the order outlives the process that
 * decided it exactly as a dispatch intent outlives its create.
 */
function orderReexecution(
  ctx: RetryCommandContext,
  runs: NonNullable<GraphStoreTx["runs"]>,
  decidedBy: ControlPrincipalRecord | undefined,
): GraphControlResult {
  const { tx, graphId, run, state, request } = ctx;
  const stopping = runs.readRunControlOf(graphId, run.runId);
  const terminal =
    stopping !== undefined || state.phase === "complete" || state.phase === "stopped";
  if (!terminal) {
    return refuse(
      graphId,
      "run-not-terminal",
      "$.graph_id",
      "graph-control refused [run-not-terminal]: run " +
        JSON.stringify(run.runId) +
        " of graph " +
        JSON.stringify(graphId) +
        " is " +
        state.phase +
        " and carries no control fact, so it is still executing — a new run replaces a " +
        "FINISHED one; supersede one attempt with a node-scoped retry, and nothing was " +
        "written",
    );
  }
  const inFlight = new Set<string>();
  const settledAttempts = new Set<string>();
  for (const node of state.nodes) {
    if (node.attemptId === undefined) continue;
    if (node.status === "dispatched") inFlight.add(node.attemptId);
    if (node.status === "settled") settledAttempts.add(node.attemptId);
  }
  const blocking = blockingReexecutionEffectsOf(tx.pendingEffects(graphId, run.runId), {
    // A platform-CONFIRMED cancellation is the fact that accounts for an
    // abandoned execution, and it is a TERMINAL cancel effect — so it is read
    // separately from the unsettled set the loop above walks.
    cancelled: new Set(tx.confirmedCancelAttempts(graphId, run.runId)),
    inFlight,
    settled: settledAttempts,
  });
  if (blocking.length > 0) {
    return refuse(
      graphId,
      "run-has-unsettled-effects",
      "$.effect_id",
      "graph-control refused [run-has-unsettled-effects]: run " +
        JSON.stringify(run.runId) +
        " of graph " +
        JSON.stringify(graphId) +
        " still owes external work whose fate is unknown — " +
        blocking
          .map(
            (effect) =>
              effect.effectId + " (attempt " + effect.attemptId + ", " + effect.status + ")",
          )
          .join(", ") +
        " — so re-executing the graph could re-run a side effect that is still live; a " +
        "platform-confirmed cancellation of those attempts clears them, and nothing was " +
        "written",
    );
  }

  const recorded = runs.recordReexecution(
    Object.freeze({
      graphId,
      runId: run.runId,
      reason: request.reason,
      decidedAt: request.at,
      ...(decidedBy === undefined ? {} : { decidedBy }),
    }),
  );
  // THE RUN IS CLOSED BY THE ORDER. Claiming its control fact (first-wins) makes
  // "this run is over; its successor is a new run" a fact every reader already
  // knows how to read — the status/audit faces report it — while a run a
  // TRUSTED COMMAND ALREADY STOPPED keeps the command that stopped it. Late work
  // against the superseded run is refused AT THE STORE, not only by the run
  // path's credential resolution: once the successor is current, an acceptance
  // batch for one of the closed run's attempts is answered `run-superseded` (the
  // third guard clause of the batch write joins the attempt to its own dispatch
  // effect, filed under a run the graph has replaced) and an effect transition
  // against one of its effects is refused by the SAME conditional statement that
  // would rewrite the row — the run fence is part of the UPDATE's WHERE clause,
  // not a prior read — so neither a receipt nor an effect row of a closed run is
  // ever rewritten.
  runs.claimRunControl(
    Object.freeze({
      graphId,
      runId: run.runId,
      command: "retry" as const,
      reason: request.reason,
      decidedAt: request.at,
      ...(decidedBy === undefined ? {} : { decidedBy }),
    }),
  );
  const order = recorded.reexecution;
  return Object.freeze({
    kind: "applied" as const,
    graphId,
    runId: run.runId,
    command: request.command,
    scope: "run" as const,
    minted: Object.freeze([]),
    decided: Object.freeze([]),
    runControl: runs.readRunControlOf(graphId, run.runId),
    skipped: Object.freeze([]),
    reexecution: Object.freeze({
      fromRunId: run.runId,
      order,
      ...(order.successorRunId === undefined
        ? {}
        : {
            successorRunId: order.successorRunId,
            successorRunSeq: runs.readRunOf(graphId, order.successorRunId)?.runSeq ?? 0,
          }),
    }),
    unsettledEffects: Object.freeze(tx.pendingEffects(graphId, run.runId)),
    unconfirmedExecutions: unconfirmedExecutionsOf(tx, state),
  });
}
