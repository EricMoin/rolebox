import { errorText } from "../../utils/error-text.ts";


import type { PlanBinding } from "../compiler/plan.ts";
import type { GraphDeclarationV3 } from "../compiler/declaration-v3.ts";
import { parseGraphDeclarationV3 } from "../compiler/parse-declaration-v3.ts";
import { contractDigest } from "../contracts/contract-definition.ts";
import type { CompiledPlan, PersistedCompiledPlan } from "../compiler/plan.ts";
import { verifyPersistedPlan } from "../compiler/verify-plan.ts";

import {
  readOutcomeGraphState, type OutcomeGraphState
} from "../outcome/graph-state.ts";
import type { GraphStateRecord } from "../ledger/types.ts";
import type { GraphDefinitionRecord } from "../store/records.ts";
import { loadGraphStoreSync, type GraphStoreLoadResult } from "../store/load.ts";
import type { GraphStore } from "../store/graph-store.ts";
// ── The stored definition ───────────────────────────────────────────────────
export interface StoredDeclaredGraph {
  readonly graphId: string;
  readonly declaration: GraphDeclarationV3;
  readonly declarationDigest: string;
  readonly plan: CompiledPlan;
  readonly record: PersistedCompiledPlan;
  readonly binding: PlanBinding;
  readonly recordedAt: number;
}
export interface StoredDefinitionIssue {
  readonly code:
  | "malformed-definition"
  | "unaddressable-declaration"
  | "declaration-changed"
  | "unrunnable-plan";
  readonly path: string;
  readonly message: string;
}
export type StoredDefinitionReading =
  | { readonly kind: "ok"; readonly declared: StoredDeclaredGraph }
  | { readonly kind: "refused"; readonly issues: readonly StoredDefinitionIssue[] };
function refuse(
  code: StoredDefinitionIssue["code"],
  path: string,
  message: string,
): StoredDefinitionReading {
  return { kind: "refused", issues: Object.freeze([{ code, path, message }]) };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function planNodeIds(plan: unknown): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!isRecord(plan) || !Array.isArray(plan.nodes)) return ids;
  for (const node of plan.nodes) {
    if (isRecord(node) && typeof node.id === "string" && node.id.length > 0) {
      ids.add(node.id);
    }
  }
  return ids;
}
export function decodeStoredDefinition(
  row: GraphDefinitionRecord,
): StoredDefinitionReading {
  if (row.graphId.length === 0) {
    return refuse(
      "malformed-definition",
      "$.graph_id",
      "stored graph definition carries an empty graph id",
    );
  }
  if (row.declarationDigest.length === 0) {
    return refuse(
      "malformed-definition",
      "$.declaration_digest",
      `stored definition of graph ${JSON.stringify(row.graphId)} carries an empty declaration digest`,
    );
  }
  if (row.planRevision.length === 0) {
    return refuse(
      "malformed-definition",
      "$.plan_revision",
      `stored definition of graph ${JSON.stringify(row.graphId)} carries an empty plan revision`,
    );
  }
  const parsed = parseGraphDeclarationV3(row.declaration);
  if (!parsed.ok) {
    return refuse(
      "malformed-definition",
      "$.declaration",
      `stored declaration of graph ${JSON.stringify(row.graphId)} is not a strict v3 declaration: ` +
      parsed.errors
        .map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`)
        .join("; "),
    );
  }
  const declaration = parsed.declaration;
  if (declaration.name !== row.graphId) {
    return refuse(
      "malformed-definition",
      "$.declaration.name",
      `stored definition is keyed by graph ${JSON.stringify(row.graphId)} but its declaration names ` +
      `${JSON.stringify(declaration.name)} — the v3 grammar carries no separate graph identifier`,
    );
  }
  let digest: string;
  try {
    digest = contractDigest(declaration);
  } catch (error) {
    return refuse(
      "unaddressable-declaration",
      "$.declaration_digest",
      `stored declaration of graph ${JSON.stringify(row.graphId)} cannot be content-addressed: ${errorText(error)}`,
    );
  }
  if (digest !== row.declarationDigest) {
    return refuse(
      "declaration-changed",
      "$.declaration_digest",
      `stored definition of graph ${JSON.stringify(row.graphId)} claims declaration digest ` +
      `${JSON.stringify(row.declarationDigest)}, but its declaration hashes to ${JSON.stringify(digest)} — ` +
      "the stored content is not the content the row is keyed by",
    );
  }
  const plan = row.plan;
  const nodeIds = planNodeIds(plan);
  const verdict = verifyPersistedPlan(plan, plan, row.graphId, nodeIds);
  if (verdict.kind !== "verified") {
    return refuse(
      "unrunnable-plan",
      "$.plan",
      `stored plan of graph ${JSON.stringify(row.graphId)} is not a runnable compiled plan: ` +
      (verdict.kind === "absent"
        ? "the row carries no plan at all"
        : verdict.reason),
    );
  }
  const record = plan as PersistedCompiledPlan;
  const binding: PlanBinding = {
    planRevision: record.planRevision,
    contractSnapshots: record.contractSnapshots,
    contractIdentities: record.contractIdentities,
    nodeBindings: record.nodeBindings,
  };
  if (binding.planRevision !== row.planRevision) {
    return refuse(
      "declaration-changed",
      "$.plan_revision",
      `stored definition of graph ${JSON.stringify(row.graphId)} is keyed by plan revision ` +
      `${JSON.stringify(row.planRevision)}, but its plan is ${JSON.stringify(binding.planRevision)}`,
    );
  }
  return {
    kind: "ok",
    declared: Object.freeze({
      graphId: row.graphId,
      declaration,
      declarationDigest: row.declarationDigest,
      plan: record,
      record,
      binding,
      recordedAt: row.recordedAt,
    }),
  };
}
export type DeclaredGraphStoreReading =
  | { readonly kind: "ok"; readonly declared: StoredDeclaredGraph }
  | { readonly kind: "absent" }
  | { readonly kind: "blocked"; readonly verdict: GraphStoreLoadResult }
  | { readonly kind: "refused"; readonly issues: readonly StoredDefinitionIssue[] };
export function readStoredDefinition(
  storeDirectory: string,
  graphId: string,
): DeclaredGraphStoreReading {
  const loaded = loadGraphStoreSync(storeDirectory);
  if (loaded.kind !== "valid") return { kind: "blocked", verdict: loaded };
  const store: GraphStore = loaded.value;
  try {
    const row = store.readDefinition(graphId);
    if (row === undefined) return { kind: "absent" };
    const decoded = decodeStoredDefinition(row);
    return decoded.kind === "ok"
      ? { kind: "ok", declared: decoded.declared }
      : { kind: "refused", issues: decoded.issues };
  } finally {
    store.close();
  }
}
export type StoredRunStateReading =
  | { readonly kind: "recorded"; readonly state: OutcomeGraphState; readonly updatedAt: number }
  | { readonly kind: "unstarted" }
  | { readonly kind: "unreadable"; readonly reason: string };
export function readStoredRunStateOf(
  store: GraphStore,
  declared: StoredDeclaredGraph,
): StoredRunStateReading {
  let row: GraphStateRecord | undefined;
  try {
    row = store.readGraphState(declared.graphId);
  } catch (error) {
    return { kind: "unreadable", reason: errorText(error) };
  }
  if (row === undefined) return { kind: "unstarted" };
  try {
    return {
      kind: "recorded",
      state: readOutcomeGraphState(row, declared.plan),
      updatedAt: row.updatedAt,
    };
  } catch (error) {
    return { kind: "unreadable", reason: errorText(error) };
  }
}
// ── Naming a verdict ────────────────────────────────────────────────────────
export function describeStoreVerdict(verdict: GraphStoreLoadResult): string {
  switch (verdict.kind) {
    case "absent":
      return "no store exists";
    case "valid":
      return "the store is readable";
    case "unsupported":
      return `unsupported ${verdict.dimension}: ${verdict.detail}`;
    case "corrupt":
      return `corrupt ${verdict.dimension}: ${verdict.reason}`;
    case "migration-required":
      return `migration-required ${verdict.dimension} from ${String(verdict.from)} to ${String(verdict.to)}`;
  }
}
export function describeStoredReading(
  reading: Exclude<DeclaredGraphStoreReading, { kind: "ok" }>,
): string {
  switch (reading.kind) {
    case "absent":
      return "the store holds no definition for it";
    case "blocked":
      return describeStoreVerdict(reading.verdict);
    case "refused":
      return reading.issues
        .map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`)
        .join("; ");
  }
}
