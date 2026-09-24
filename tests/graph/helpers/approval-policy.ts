import { createApprovalPolicy } from "../../../src/graph/policy/approval-policy.ts";

export function approvalPolicyFor(graphId: string, approver = "session.approver") {
  return createApprovalPolicy({
    id: "test.approval", revision: "1",
    rules: ["work", "review", "alpha", "beta"].map((nodeId) => ({ graphId, nodeId, approverSessions: [approver] })),
  });
}

export function approvalGrantFor(graphId: string, approver = "session.approver") {
  const grant = approvalPolicyFor(graphId, approver).authorize(graphId, "work", "session.requester", approver);
  if (!grant) throw new Error("fixture approval was not authorized");
  return grant;
}
