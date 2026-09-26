import { errorText } from "../../utils/error-text.ts";
import type {
  AcceptanceLedger,
  ApprovalRequestRecord,
  ControlDecisionRecord,
  RunControlRecord,
} from "../ledger/types.ts";
import { STOPPING_CONTROL_COMMANDS } from "../ledger/types.ts";
import type { SubmissionRefusal } from "./acceptance.ts";
import { OutcomeStateError, type OutcomeGraphState, describeOutcomeStop } from "./graph-state.ts";
import type { DownstreamInputRefusal } from "./inputs.ts";
import type { OutcomeRuntimeRefusal } from "./runtime-contract.ts";

export function readRuntimeClock(
  clock: () => number,
  override: number | undefined,
): number | OutcomeRuntimeRefusal {
  const at = override ?? clock();
  if (!Number.isSafeInteger(at)) {
    return {
      code: "invalid-timestamp",
      path: "$.now",
      message:
        "outcome-runtime: now is " +
        describeValue(at) +
        ", not epoch milliseconds — time is an explicit input and the receipt records " +
        "exactly the value this call was given",
    };
  }
  return at;
}

export function ledgerReadRefusal(graphId: string, error: unknown): OutcomeRuntimeRefusal {
  return {
    code: "unreadable-state",
    message:
      "outcome-runtime: the graph state of " +
      JSON.stringify(graphId) +
      " could not be read from the ledger (" +
      errorText(error) +
      ")",
  };
}

export function refused(refusals: readonly OutcomeRuntimeRefusal[]): {
  readonly kind: "refused";
  readonly refusals: readonly OutcomeRuntimeRefusal[];
} {
  return { kind: "refused", refusals };
}

export function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return typeof value;
}

/**
 * Map a state-reading failure onto the runtime's refusal vocabulary.
 *
 * A state the strict reader refuses for an IDENTITY disagreement (another
 * graph or another plan revision) is reported as exactly that — the message
 * names which one — while a body this build cannot read stays
 * `unreadable-state`. Collapsing both would hide the one recovery failure a
 * caller can actually act on (a state bound to a superseded plan revision).
 */
export function stateRefusal(
  graphId: string,
  error: unknown,
): OutcomeRuntimeRefusal {
  if (error instanceof OutcomeStateError) {
    if (error.problem === "state-plan-mismatch") {
      return { code: "plan-revision-mismatch", message: error.message };
    }
    if (error.problem === "unsupported-state-version") {
      return { code: "unsupported-state-version", message: error.message };
    }
    return { code: "unreadable-state", message: error.message };
  }
  return {
    code: "unreadable-state",
    message:
      "outcome-runtime: the persisted state of graph " +
      JSON.stringify(graphId) +
      " could not be read (" +
      errorText(error) +
      ")",
  };
}

/**
 * The TRUSTED CONTROL FACT of this graph's run, or `undefined` (P3 item 1).
 *
 * READ THROUGH THE PORT THIS RUNTIME ALREADY HOLDS. The control record lives
 * in the SAME store as the run state — one file, one schema, one transaction
 * boundary — so the run path can ask about it without a second authority, a
 * second connection or a second capability to keep in sync with the store it
 * commits through.
 *
 * A SUBSTRATE WITHOUT THE SURFACE REPORTS NO CONTROL, and that is correct
 * rather than lenient: a ledger that cannot hold a control decision cannot
 * have one, so there is no stop to report. The control ENTRY is the other
 * half of that rule — it refuses by name when it has no surface to record a
 * command in, because a command nobody can record must never look applied.
 *
 * A READ THAT THROWS IS NOT SWALLOWED as "no control": the closed store and
 * the malformed row throw, and the callers let the error answer rather than
 * run a graph whose stop could not be read.
 */
export function runControl(
  ledger: AcceptanceLedger,
  graphId: string,
): RunControlRecord | undefined {
  const runs = ledger.runs;
  if (runs === undefined) return undefined;
  return runs.readRunControl(graphId);
}

/**
 * The STOPPING control decision ONE attempt carries, or `undefined`.
 *
 * The attempt-level half of the control rule, read through the ledger's own
 * run-scoped port: `controlDecisions(graphId)` answers the decisions of the
 * CURRENT run (runId omitted), which is the run an attempt of this runtime
 * belongs to. One attempt carries at most one stopping decision and a
 * decision is never cleared, so a value read here cannot go stale into an
 * acceptance or a launch.
 *
 * `STOPPING_CONTROL_COMMANDS` is the single owner of the classification, and
 * it is membership-identical to the store's own SQL literal — a `retry`
 * decision recorded BESIDE a stop is deliberately not one of them.
 */
export function stoppingDecisionOf(
  ledger: AcceptanceLedger,
  graphId: string,
  attemptId: string,
): ControlDecisionRecord | undefined {
  const runs = ledger.runs;
  if (runs === undefined) return undefined;
  return runs
    .controlDecisions(graphId)
    .find(
      (decision) =>
        decision.attemptId === attemptId &&
        STOPPING_CONTROL_COMMANDS.includes(decision.command),
    );
}

/**
 * The structured refusal an ATTEMPT a stopping command ended answers with.
 *
 * ONE code, `attempt-stopped`, for all four stopping commands, and the
 * message carries the command, the attempt, the reason and the deciding
 * principal so the refusal says WHICH trusted command ended it — plus the fact
 * that matters most for a caller deciding what to do next: the RUN continues,
 * its siblings still settle, and this attempt is carried forward only by a
 * node-scoped `retry`. The code is never a business outcome and never a
 * settlement, and it is deliberately NOT `control-stopped`, which would claim
 * the run itself had ended.
 *
 * IT IS THE ATTEMPT-LEVEL WORDING, NOT THE CLASSIFICATION. A caller reaches it
 * only once the run fact has been read and found CLEAR as of the decision it
 * refuses — see {@link refusalForStoppingDecision}, which is the entry point
 * every refusal site uses. Emitting this text while a run-wide stop stands
 * would state something false about the run.
 */
export function attemptStopRefusal(
  graphId: string,
  decision: ControlDecisionRecord,
): OutcomeRuntimeRefusal {
  return {
    code: "attempt-stopped",
    path: "$.attemptId",
    message:
      "outcome-runtime: attempt " +
      JSON.stringify(decision.attemptId) +
      " of node " +
      JSON.stringify(decision.nodeId) +
      " in graph " +
      JSON.stringify(graphId) +
      " carries the STOPPING trusted control command " +
      JSON.stringify(decision.command) +
      " (reason: " +
      decision.reason +
      ", decided at " +
      String(decision.decidedAt) +
      (decision.decidedBy === undefined
        ? ""
        : ", decided by session " + JSON.stringify(decision.decidedBy.sessionId)) +
      ") — the ATTEMPT is stopped, so it accepts nothing and is never (re-)launched, " +
      "while the RUN itself is NOT stopped: its other attempts keep executing and still " +
      "settle. Only a node-scoped `retry` of the node carries this attempt forward, by " +
      "minting a successor attempt, and only a run-wide `cancel`/`budget-stop` closes it " +
      "for good; nothing was written for it",
  };
}

/**
 * The structured refusal every step of a CONTROLLED run answers with.
 *
 * ONE code, `control-stopped`, for every run-wide command: the caller's repair
 * is the same in all three cases (the run is over; a new run is a new
 * identity), and the command, the reason and the deciding principal are
 * carried in the message so the refusal says WHICH trusted command ended it.
 * The code is never a business outcome and never a settlement.
 */
export function controlStopRefusal(
  graphId: string,
  control: RunControlRecord,
): OutcomeRuntimeRefusal {
  return {
    code: "control-stopped",
    path: "$.graphId",
    message:
      "outcome-runtime: graph " +
      JSON.stringify(graphId) +
      " was STOPPED by the trusted control command " +
      JSON.stringify(control.command) +
      " (reason: " +
      control.reason +
      ", decided at " +
      String(control.decidedAt) +
      (control.decidedBy === undefined
        ? ""
        : ", decided by session " + JSON.stringify(control.decidedBy.sessionId)) +
      ") — a controlled run dispatches nothing, arms nothing and settles nothing, so " +
      "this operation is refused and no state is written; the attempts the stop left in " +
      "flight stay exactly as they are and are reported",
  };
}

/**
 * The refusal for ONE attempt a STOPPING control decision ended, CLASSIFIED
 * against the run fact as it stands NOW.
 *
 * WHY THE RUN FACT IS RE-READ HERE. The run's control fact and the attempt's
 * stopping decision are read through SEPARATE port calls, with the state read
 * and the identity resolution between them, and neither the runtime nor the
 * store reads them in one snapshot. A run-wide `cancel` or `budget-stop`
 * writes the decision AND the run fact it claims in ONE transaction
 * (`writeControlDecision`), so a caller that has already read "no run
 * control" can read a run-wide decision the instant that command commits.
 * Answering `attempt-stopped` there would report an attempt-scoped stop for a
 * run that IS stopped — and that refusal's text says the RUN itself is not
 * stopped and that its other attempts keep executing, which is false from the
 * moment the command committed. Reading the run fact AFTER the decision closes
 * the window: the fact read second decides the code, so a run-wide stop can
 * never be answered with the attempt-level wording.
 *
 * A NODE-SCOPED `failure`/`timeout` STILL ANSWERS `attempt-stopped`: it claims
 * no run fact, so the re-read finds none, the run keeps executing, its
 * siblings still settle, and the attempt is carried forward only by a
 * node-scoped `retry`. A read that throws is NOT swallowed (see
 * {@link runControl}), exactly like the checks that read the same fact first,
 * so a stop that could not be read never looks like a live run.
 *
 * Every refusal site that reports a stopping decision goes through here — the
 * submission fast path, the ledger verdict that refused the acceptance batch,
 * and the launch decision — so all three classify the same two facts the same
 * way.
 */
export function refusalForStoppingDecision(
  graphId: string,
  decision: ControlDecisionRecord,
  stopped: RunControlRecord | undefined,
): OutcomeRuntimeRefusal {
  if (stopped !== undefined) return controlStopRefusal(graphId, stopped);
  return attemptStopRefusal(graphId, decision);
}

/**
 * What a STOPPED run reports for the nodes still recorded in flight.
 *
 * Every one of them is a refusal, never an "armed" entry: `armed` promises that
 * a submission can settle the attempt, and on a stopped run no submission can —
 * the run path refuses it with the same `graph-stopped` code. The nodes are NOT
 * settled and NOT dropped: no outcome settled them, so fabricating a settlement
 * would invent a result, and the entries stay exactly as the stop left them.
 * Credential-free by construction, like every other report here.
 */
export function stoppedInFlightRefusals(
  state: OutcomeGraphState,
): readonly OutcomeRuntimeRefusal[] {
  const stop = state.stop;
  if (stop === undefined) return Object.freeze([]);
  const refusals: OutcomeRuntimeRefusal[] = [];
  state.nodes.forEach((node, index) => {
    if (node.status !== "dispatched") return;
    refusals.push(
      Object.freeze({
        code: "graph-stopped" as const,
        path: "$.nodes[" + index + "].status",
        message:
          "outcome-runtime: node " +
          JSON.stringify(node.nodeId) +
          " is still recorded in flight" +
          (node.attemptId === undefined ? "" : " on attempt " + JSON.stringify(node.attemptId)) +
          ", but graph " +
          JSON.stringify(state.graphId) +
          " STOPPED (" +
          stop.reason + ": " + describeOutcomeStop(stop) +
          ") — a stopped run dispatches nothing and no submission can settle this attempt, " +
          "so it is reported as refused rather than armed",
      }),
    );
  });
  return Object.freeze(refusals);
}

/**
 * What a CONTROL-STOPPED run reports for the nodes still recorded in flight.
 *
 * The mirror of {@link stoppedInFlightRefusals} for the trusted-control case:
 * every in-flight attempt is a refusal with the `control-stopped` code and the
 * command, reason and decision time that stopped the run — never an "armed"
 * entry (no submission can settle it) and never a silent drop (the attempt is
 * still recorded, and an external execution nobody confirmed must stay
 * visible). Credential-free by construction, like every other report here.
 */
export function controlledInFlightRefusals(
  state: OutcomeGraphState,
  control: RunControlRecord,
): readonly OutcomeRuntimeRefusal[] {
  const refusals: OutcomeRuntimeRefusal[] = [];
  state.nodes.forEach((node, index) => {
    if (node.status !== "dispatched") return;
    refusals.push(
      Object.freeze({
        code: "control-stopped" as const,
        path: "$.nodes[" + index + "].status",
        message:
          "outcome-runtime: node " +
          JSON.stringify(node.nodeId) +
          " is still recorded in flight" +
          (node.attemptId === undefined ? "" : " on attempt " + JSON.stringify(node.attemptId)) +
          ", but graph " +
          JSON.stringify(state.graphId) +
          " was STOPPED by the trusted control command " +
          JSON.stringify(control.command) +
          " (" +
          control.reason +
          ") — a controlled run dispatches nothing and no submission can settle this " +
          "attempt, so it is reported as refused rather than armed, and its execution (if " +
          "the host created one) is neither confirmed nor hidden by this report",
      }),
    );
  });
  return Object.freeze(refusals);
}

/**
 * The named refusal for one attempt paused on a trusted approval request (P3 item 3).
 *
 * ONE owner of the mapping from the request's own status onto the runtime's closed
 * refusal vocabulary, so the fast path and the ledger verdict answer in the same
 * words: `pending` → `approval-pending`, `rejected` → `approval-rejected`, and
 * anything else that is not `approved` → `approval-expired` (the status vocabulary
 * has exactly four members and `approved` never reaches here).
 *
 * The message names the ONLY session that can decide the request and says in so many
 * words that no submitted payload can: the gate reads the durable row, not the
 * submission, which is the whole point of separating control from outcome (§3.4).
 */
export function approvalBlockRefusal(request: ApprovalRequestRecord): OutcomeRuntimeRefusal {
  const code =
    request.status === "pending"
      ? ("approval-pending" as const)
      : request.status === "rejected"
        ? ("approval-rejected" as const)
        : ("approval-expired" as const);
  const state =
    code === "approval-pending"
      ? "is still PENDING"
      : code === "approval-rejected"
        ? "was REJECTED"
        : "EXPIRED";
  return {
    code,
    path: "$.attempt_id",
    message:
      "outcome-runtime: attempt " +
      JSON.stringify(request.attemptId) +
      " of node " +
      JSON.stringify(request.nodeId) +
      " in graph " +
      JSON.stringify(request.graphId) +
      " is PAUSED on a trusted approval request that " +
      state +
      " (raised at " +
      String(request.requestedAt) +
      ", deadline " +
      String(request.expiresAt) +
      ", reason " +
      JSON.stringify(request.reason) +
      "), so nothing was accepted: no receipt, no accepted event, no accepted result " +
      "and no state advance was written. Approval is CONTROL, not an outcome — no field " +
      "of a submission (an `approved` flag, a claim inside `data`, any other content) " +
      "can satisfy it — and only session " +
      JSON.stringify(request.approverSessionId) +
      " can decide it through the trusted control entry",
  };
}

/**
 * Map one UNRESOLVED declared input onto the runtime's refusal vocabulary (D6).
 *
 * The input's own code is NAMED inside the message rather than replacing the
 * runtime code: `dispatch-input-unbound` says what was not done (a dispatch
 * that would have started with a hole), and the nested code says exactly which
 * rule refused it, so a caller diagnoses from one value.
 */
export function inputRefusalOf(refusal: DownstreamInputRefusal): OutcomeRuntimeRefusal {
  return {
    code: "dispatch-input-unbound",
    path: "$.nodes." + refusal.from + ".inputs",
    message:
      "outcome-runtime: the dispatch of a node that consumes " +
      JSON.stringify(refusal.from) +
      "/" +
      JSON.stringify(refusal.outcome) +
      " was NOT created [" +
      refusal.code +
      "]: " +
      refusal.message,
  };
}

/** Map an acceptance-core refusal onto the runtime's vocabulary verbatim. */
export function toRuntimeRefusal(refusal: SubmissionRefusal): OutcomeRuntimeRefusal {
  return {
    code: refusal.code,
    message: refusal.message,
    ...(refusal.path === undefined ? {} : { path: refusal.path }),
  };
}
