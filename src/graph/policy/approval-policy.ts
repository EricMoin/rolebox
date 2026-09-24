import { contractDigest } from "../contracts/contract-definition.ts";

export const APPROVAL_POLICY_ENV = "ROLEBOX_GRAPH_APPROVAL_POLICY";
export type ApprovalMode = "independent-review" | "operator-confirmation";
export interface ApprovalGrant {
  readonly policyId: string;
  readonly revision: string;
  readonly digest: string;
  readonly mode: ApprovalMode;
}
export interface ApprovalPolicy {
  readonly mappings: readonly { readonly graphId: string; readonly nodeId: string }[];
  authorize(graphId: string, nodeId: string, requester: string, approver: string): ApprovalGrant | undefined;
}

/** Installed by the host. Tool requests can nominate a session, never a policy. */
export function createApprovalPolicy(value: unknown): ApprovalPolicy {
  const config = record(value);
  const id = identifier(config.id);
  const revision = identifier(config.revision);
  exactKeys(config, ["id", "revision", "rules"]);
  if (!Array.isArray(config.rules)) throw new Error("approval policy rules must be an array");
  const rules = config.rules.map((raw) => {
    const rule = record(raw);
    exactKeys(rule, ["graphId", "nodeId", "approverSessions", "mode"]);
    const graphId = identifier(rule.graphId);
    const nodeId = identifier(rule.nodeId);
    if (!Array.isArray(rule.approverSessions) || rule.approverSessions.length === 0) {
      throw new Error("approval policy must authorize at least one session per rule");
    }
    const approverSessions = Object.freeze([...new Set(rule.approverSessions.map(identifier))].sort());
    const mode = rule.mode ?? "independent-review";
    if (mode !== "independent-review" && mode !== "operator-confirmation") throw new Error("unknown approval mode");
    return Object.freeze({ graphId, nodeId, approverSessions, mode });
  }).sort((a, b) => compareText(a.graphId, b.graphId) || compareText(a.nodeId, b.nodeId));
  const identities = new Set(rules.map((rule) => JSON.stringify([rule.graphId, rule.nodeId])));
  if (identities.size !== rules.length) throw new Error("ambiguous approval policy rules");
  const digest = contractDigest({ id, revision, rules });
  return Object.freeze({
    mappings: Object.freeze(rules.map(({ graphId, nodeId }) => Object.freeze({ graphId, nodeId }))),
    authorize(graphId: string, nodeId: string, requester: string, approver: string): ApprovalGrant | undefined {
      const rule = rules.find((entry) => entry.graphId === graphId && entry.nodeId === nodeId);
      if (!rule || !rule.approverSessions.includes(approver)) return undefined;
      if (rule.mode === "independent-review" && requester === approver) return undefined;
      return Object.freeze({ policyId: id, revision, digest, mode: rule.mode });
    },
  });
}

export function readApprovalGrant(value: unknown): ApprovalGrant {
  const grant = record(value);
  exactKeys(grant, ["policyId", "revision", "digest", "mode"]);
  if (grant.mode !== "independent-review" && grant.mode !== "operator-confirmation") throw new Error("unknown approval mode");
  return Object.freeze({ policyId: identifier(grant.policyId), revision: identifier(grant.revision), digest: identifier(grant.digest), mode: grant.mode });
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("approval policy identifier must be non-empty");
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("approval policy must be an object");
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("unknown approval policy field");
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
