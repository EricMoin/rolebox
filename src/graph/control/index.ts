/**
 * Graph v3 — trusted control (P3 item 1)
 *
 * Version: 1.0
 * Date: 2026-09-24
 *
 * The ONE trusted control surface of the graph: the application service that
 * turns a lifecycle command (failure / cancel / timeout, and the two commands
 * whose own work packages have not landed yet) into a durable fact, plus the
 * record and refusal vocabulary it answers with.
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
  type GraphControlAttemptDecision,
  type GraphControlPrincipal,
  type GraphControlRefusal,
  type GraphControlRefusalCode,
  type GraphControlRequest,
  type GraphControlResult,
  type GraphControlSkippedAttempt,
  type GraphControlUnconfirmedExecution,
} from "./application.ts";
