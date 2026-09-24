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

