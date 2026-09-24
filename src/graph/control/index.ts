/**
 * Graph v3 — trusted control (P3 item 1)
 *
 * Version: 1.0
 * Date: 2026-09-24
 *
 * The ONE trusted control surface of the graph: the application service that
 * turns a lifecycle command into a durable fact, plus the record and refusal
 * vocabulary it answers with. Failure, cancel and timeout (P3 item 1) stop a run;
 * \`retry\` (P3 item 2) supersedes one attempt in place — or, run-scoped, orders a
 * terminal run re-executed as a NEW run; \`approval-request\` / \`approve\` /
 * \`reject\` (P3 item 3) raise and answer the durable pause on one attempt, with
 * the approval rules in `./approval.ts`. \`budget-stop\` is the one command whose
 * own work package has not landed, and it is refused by name.
 *
 * WHY IT IS NOT PART OF `outcome/`. §3.4 separates an explicit business result
 * from trusted control. The outcome package owns proposals, acceptance,
 * natural completion and accepted results; this package owns the commands that
 * are NOT results. Keeping them in different modules is what makes "control is
 * not an outcome" a structural boundary instead of a comment: nothing here can
 * build a receipt or an accepted event, and the outcome run path can only READ
 * the control state (through the ledger port) — it can never write one.
 *
 * The module also carries the RECORD SHAPES the durable store persists
 * (`src/graph/store/`) and the run path reads; the shapes themselves are
 * declared by the ledger port (`src/graph/ledger/types.ts`), which is the one
 * place a durable protocol record is defined.
 */

export {
  applyGraphControl,
  type GraphControlApproval,
  type GraphControlAttemptDecision,
  type GraphControlMintedAttempt,
  type GraphControlPrincipal,
  type GraphControlReexecution,
  type GraphControlRefusal,
  type GraphControlRefusalCode,
  type GraphControlRequest,
  type GraphControlResult,
  type GraphControlRetryCapability,
  type GraphControlSkippedAttempt,
  type GraphControlUnconfirmedExecution,
} from "./application.ts";
export {
  approvalSpecProblem,
  isApprovalCommand,
  type ApprovalCommandName,
  type ApprovalRequestSpec,
} from "./approval.ts";
