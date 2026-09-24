import { expect, it } from "bun:test";
import { createApprovalPolicy, APPROVAL_POLICY_ENV } from "../../src/graph/policy/approval-policy.ts";
import { assembleHostCapabilities } from "../../src/graph/policy/acceptance-primitives.ts";
import { compileGraph } from "../../src/graph/compiler/compile.ts";

const config = {
  id: "trusted.approval", revision: "1",
  rules: [{ graphId: "graph", nodeId: "work", approverSessions: ["reviewer", "requester"] }],
};

it("defaults to independent review and refuses unqualified or self nominated sessions", () => {
  const policy = createApprovalPolicy(config);
  expect(policy.authorize("graph", "work", "requester", "requester")).toBeUndefined();
  expect(policy.authorize("graph", "work", "requester", "worker")).toBeUndefined();
  expect(policy.authorize("other", "work", "requester", "reviewer")).toBeUndefined();
  expect(policy.authorize("graph", "other", "requester", "reviewer")).toBeUndefined();
  expect(policy.authorize("graph", "work", "requester", "reviewer")).toMatchObject({
    policyId: config.id, revision: "1", mode: "independent-review",
  });
});

it("allows self confirmation only when the host explicitly chooses that mode", () => {
  const policy = createApprovalPolicy({ ...config, rules: [{ ...config.rules[0], mode: "operator-confirmation" }] });
  expect(policy.authorize("graph", "work", "requester", "requester")?.mode).toBe("operator-confirmation");
});

it("pins policy contents and detaches configuration from the caller", () => {
  const mutable = structuredClone(config);
  const policy = createApprovalPolicy(mutable);
  const grant = policy.authorize("graph", "work", "requester", "reviewer");
  mutable.rules[0]!.approverSessions.push("worker");
  expect(policy.authorize("graph", "work", "requester", "worker")).toBeUndefined();
  const changed = createApprovalPolicy(mutable).authorize("graph", "work", "requester", "reviewer");
  expect(changed?.digest).not.toBe(grant?.digest);
  expect(() => createApprovalPolicy({ ...config, rules: [...config.rules, ...config.rules] })).toThrow("ambiguous");
});

it("the shipped assembly blocks approval contracts at compilation until the policy is installed", () => {
  const declaration = { version: 3, name: "graph", nodes: [{ id: "work", agent: "worker", prompt: "Work", outcomes: [{ id: "done", acceptance: [{ validator: "principal-approval", version: 1 }] }] }], edges: [] };
  const compile = (env: Record<string, string>) => {
    const assembly = assembleHostCapabilities({ artifactRoot: "/unused", storeRoot: "/unused", env });
    return { assembly, result: compileGraph(declaration, { supportedValidators: assembly.capabilities.validators.map(({ id, version }) => ({ validator: id, version })), acceptanceCapabilities: assembly.capabilities }) };
  };
  const missing = compile({});
  expect(missing.result.ok).toBe(true);
  if (!missing.result.ok) throw new Error("expected draft");
  expect(missing.result.plan.executability.kind).toBe("draft");
  const malformed = compile({ [APPROVAL_POLICY_ENV]: "{}" });
  expect(malformed.assembly.approvalPolicy).toBeUndefined();
  expect(malformed.assembly.approvalPolicyIssues).toHaveLength(1);
  const installed = compile({ [APPROVAL_POLICY_ENV]: JSON.stringify(config) });
  expect(installed.result.ok).toBe(true);
  if (!installed.result.ok) throw new Error("expected executable");
  expect(installed.result.plan.executability.kind).toBe("executable");
});
