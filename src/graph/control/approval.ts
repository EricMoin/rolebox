/**
 * Graph v3 — the TRUSTED APPROVAL rules (P3 item 3)
 *
 * Version: 1.0
 * Date: 2026-09-24
 *
 * THE PURE HALF OF THE APPROVAL CAPABILITY. The durable record lives in the
 * ledger port and the store (`src/graph/ledger/types.ts`,
 * `graph_approval_requests`), the transaction lives in the control application
 * service (`./application.ts`), and the RULES that both obey live here: which
 * commands are approval commands, which of them RESOLVES a request, and what a
 * raise must carry to be recordable. Nothing here reads a store, a clock or a
 * payload — every input is an explicit value — so the rules are testable on
 * their own and cannot drift between the raise path and the decision path. The
 * refusal CODES a blocked attempt is answered with belong to the run path's own
 * closed vocabulary (`src/graph/outcome/runtime.ts`), which maps them from the
 * request's status where it answers; the gate itself reads only the row.
 *
 * WHY APPROVAL IS A CONTROL COMMAND AND NOT A SECOND AUTHORITY (§3.1, §3.4).
 * An approval is a LIFECYCLE fact: it pauses one node's attempt and answers the
 * pause. The alternative — a separate approval table with its own permission
 * check, its own idempotency rule and its own writer — is exactly the second
 * authority the plan forbids. Extending the closed command vocabulary instead
 * keeps ONE permission model (the graph's declaring principal), ONE decision
 * stream (the control decisions) and ONE transaction (the store's), and it is
 * why `approval-request` / `approve` / `reject` are members of
 * `ControlCommandName`.
 *
 * WHAT A WORKER CAN NEVER DO. A worker's submission reaches the acceptance core,
 * which reads the REQUEST ROW — written only by this control path — and nothing
 * else. There is no field of a submission that resolves a request, and no code
 * here or in the gate inspects one; the `approved` field, a claim in `data` and
 * every other submitted byte are structurally irrelevant (§3.4).
 *
 * Dependency leaf: this module imports types only.
 */

import type { ControlCommandName } from "../ledger/types.ts";

/** The three commands this capability adds to the closed vocabulary. */
export type ApprovalCommandName = "approval-request" | "approve" | "reject";

/** Whether one command belongs to the approval capability. */
export function isApprovalCommand(
  command: ControlCommandName,
): command is ApprovalCommandName {
  return command === "approval-request" || command === "approve" || command === "reject";
}

/**
 * Whether one approval command RESOLVES a pending request.
 *
 * The distinction is a PERMISSION one: a raise is issued under the graph's
 * declaring authority (it pauses the graph's own work), while a decision is
 * issued by the session the request NAMES — so the control entry must not apply
 * the declaring-principal rule to the two decision commands.
 */
export function isApprovalDecision(
  command: ControlCommandName,
): command is "approve" | "reject" {
  return command === "approve" || command === "reject";
}

/**
 * What a raise must carry: the ONLY session that may decide, and the deadline.
 *
 * Both are REQUIRED. A request with no named approver would be decidable by
 * whoever happens to hold control authority — the declaring principal's
 * authority implying approver authority, which this design refuses to assume —
 * and a request with no deadline would be a pause nothing can ever end without
 * a human. The control entry reads these from its arguments; they are never
 * inferred from a worker's submission or from the graph's declaring principal.
 */
export interface ApprovalRequestSpec {
  readonly approverSessionId: string;
  readonly expiresAt: number;
}

/**
 * Check one raise's spec, or answer why it is not recordable.
 *
 * A malformed spec is REFUSED BEFORE anything is written: raising a request with
 * a blank approver or a deadline that has already passed would create a row no
 * decision can ever legitimately resolve, and recording it would be recording an
 * intent nothing will honour.
 */
export function approvalSpecProblem(
  spec: ApprovalRequestSpec,
  at: number,
): string | undefined {
  if (typeof spec.approverSessionId !== "string" || spec.approverSessionId.length === 0) {
    return (
      "the request names no approver: `approver_session_id` must be the non-empty session " +
      "whose decision resolves it, because the declaring principal's control authority does " +
      "NOT imply approval authority"
    );
  }
  if (
    typeof spec.expiresAt !== "number" ||
    !Number.isSafeInteger(spec.expiresAt) ||
    spec.expiresAt <= 0
  ) {
    return (
      "the request names no usable deadline: `expires_at` must be a positive epoch-" +
      "millisecond instant, because a pause with no deadline is a strand"
    );
  }
  if (spec.expiresAt <= at) {
    return (
      "the request's deadline (" +
      String(spec.expiresAt) +
      ") is not in the future of this call (" +
      String(at) +
      "), so the request would be expired the moment it was raised — pass a later deadline"
    );
  }
  return undefined;
}

