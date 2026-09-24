import { readRunBudget } from "../domain/budget.ts";
import { errorText } from "../../utils/error-text.ts";
import { contractDigest, contractRefsEqual, isContractRef, type ContractRef } from "../contracts/contract-definition.ts";
import { inspectCompiledTopology, NON_EXECUTABLE_PLAN_CODE, readPlanExecutability } from "./plan.ts";
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export type PlanBindingVerdict =
  | { readonly kind: "absent" }
  | { readonly kind: "verified" }
  | {
    readonly kind: "corrupt";
    readonly dimension: "contract";
    readonly reason: string;
  };
function contractCorrupt(reason: string): PlanBindingVerdict {
  return { kind: "corrupt", dimension: "contract", reason };
}
function describeBindingValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  try {
    return String(value);
  } catch {
    return `a ${typeof value}`;
  }
}
function describeContractRef(ref: ContractRef): string {
  return `${JSON.stringify(ref.id)}@${JSON.stringify(ref.revision)} (digest ${JSON.stringify(ref.digest)})`;
}
function verifyContractRecord(
  value: Record<string, unknown>,
  nodeIds: ReadonlySet<string>,
  label: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const contractSnapshots = value.contractSnapshots;
  if (!isPlainObject(contractSnapshots)) {
    return {
      ok: false,
      reason: `${label} contractSnapshots is not a record keyed by contract digest`,
    };
  }
  const contractIdentities = value.contractIdentities;
  if (!isPlainObject(contractIdentities)) {
    return {
      ok: false,
      reason: `${label} contractIdentities is not a record keyed by contract id`,
    };
  }
  const nodeBindings = value.nodeBindings;
  if (!isPlainObject(nodeBindings)) {
    return {
      ok: false,
      reason: `${label} nodeBindings is not a record keyed by node id`,
    };
  }
  // (a) — content, digest-first, in key order, so a diagnostic is stable. The
  // set holds the digests whose body has PROVEN to hash to its own key.
  const provenDigests = new Set<string>();
  for (const digest of Object.keys(contractSnapshots).sort()) {
    try {
      const entry = contractSnapshots[digest];
      if (!isPlainObject(entry)) {
        return {
          ok: false,
          reason: `${label} contract snapshot ${JSON.stringify(digest)} is not a { body } record`,
        };
      }
      // Read the body ONCE: the digest and the stored body must come from the
      // same read, or a getter could pass one and answer another.
      const body = entry.body;
      const actual = contractDigest(body);
      if (actual !== digest) {
        return {
          ok: false,
          reason: `${label} contract snapshot ${JSON.stringify(digest)} body hashes to ${actual}, not its own key`,
        };
      }
      provenDigests.add(digest);
    } catch (err) {
      return {
        ok: false,
        reason: `${label} contract snapshot ${JSON.stringify(digest)} was rejected: ${errorText(err)}`,
      };
    }
  }
  // (b) — identity, id order then revision order. One identity has exactly one
  // digest by construction, and every digest it names must be proven content.
  for (const id of Object.keys(contractIdentities).sort()) {
    try {
      const revisions = contractIdentities[id];
      if (!isPlainObject(revisions)) {
        return {
          ok: false,
          reason: `${label} contract identity ${JSON.stringify(id)} is not a record keyed by revision`,
        };
      }
      for (const revision of Object.keys(revisions).sort()) {
        const digest = revisions[revision];
        if (typeof digest !== "string" || digest.length === 0) {
          return {
            ok: false,
            reason: `${label} contract identity ${JSON.stringify(id)}@${JSON.stringify(revision)} maps to ${describeBindingValue(digest)}, not a content digest`,
          };
        }
        if (!provenDigests.has(digest)) {
          return {
            ok: false,
            reason: `${label} contract identity ${JSON.stringify(id)}@${JSON.stringify(revision)} maps to digest ${JSON.stringify(digest)}, which contractSnapshots does not contain`,
          };
        }
      }
    } catch (err) {
      return {
        ok: false,
        reason: `${label} contract identity ${JSON.stringify(id)} was rejected: ${errorText(err)}`,
      };
    }
  }
  // (c) + (d) — one pass over the bound nodes, in node-id order.
  for (const nodeId of Object.keys(nodeBindings).sort()) {
    try {
      const boundRef = nodeBindings[nodeId];
      if (!isContractRef(boundRef)) {
        return {
          ok: false,
          reason: `${label} node binding ${JSON.stringify(nodeId)} is not a contract ref { id, revision, digest } of non-empty strings`,
        };
      }
      const revisions = contractIdentities[boundRef.id];
      const indexed =
        isPlainObject(revisions) && typeof revisions[boundRef.revision] === "string"
          ? revisions[boundRef.revision]
          : undefined;
      if (indexed === undefined) {
        return {
          ok: false,
          reason: `${label} node binding ${JSON.stringify(nodeId)} names contract ${describeContractRef(boundRef)}, which the contract identity index does not carry`,
        };
      }
      if (indexed !== boundRef.digest) {
        return {
          ok: false,
          reason: `${label} node binding ${JSON.stringify(nodeId)} declares digest ${JSON.stringify(boundRef.digest)}, but the contract identity index maps ${JSON.stringify(boundRef.id)}@${JSON.stringify(boundRef.revision)} to ${JSON.stringify(indexed)}`,
        };
      }
      if (!nodeIds.has(nodeId)) {
        return {
          ok: false,
          reason: `${label} node binding references node id ${JSON.stringify(nodeId)}, which the persisted state does not declare`,
        };
      }
    } catch (err) {
      return {
        ok: false,
        reason: `${label} node binding ${JSON.stringify(nodeId)} was rejected: ${errorText(err)}`,
      };
    }
  }
  return { ok: true };
}
export function verifyPersistedPlanBinding(
  value: unknown,
  nodeIds: ReadonlySet<string>,
): PlanBindingVerdict {
  if (value === undefined) return { kind: "absent" };
  try {
    if (!isPlainObject(value)) {
      return contractCorrupt(
        "plan binding is not a record of { planRevision, contractSnapshots, nodeBindings }",
      );
    }
    const planRevision = value.planRevision;
    if (typeof planRevision !== "string" || planRevision.length === 0) {
      return contractCorrupt(
        `plan binding planRevision is ${describeBindingValue(planRevision)}, not a non-empty string`,
      );
    }
    const record = verifyContractRecord(value, nodeIds, "plan binding");
    if (!record.ok) return contractCorrupt(record.reason);
    return { kind: "verified" };
  } catch (err) {
    // Totality backstop: a hostile container (a Proxy trap, a throwing getter
    // on the binding record itself) is corrupt contract data, never a loader
    // failure.
    return contractCorrupt(`plan binding verification failed: ${errorText(err)}`);
  }
}
const COMPILED_DECLARATION_VERSION = 3;
export function verifyPersistedCompiledPlan(
  value: unknown,
  graphId: string,
  nodeIds: ReadonlySet<string>,
): PlanBindingVerdict {
  if (value === undefined) return { kind: "absent" };
  try {
    if (!isPlainObject(value)) {
      return contractCorrupt(
        "compiled plan record is not a record of { graphId, declarationVersion, planRevision, nodes, edges, loopGroups, contractSnapshots, nodeBindings }",
      );
    }
    const planRevision = value.planRevision;
    if (typeof planRevision !== "string" || planRevision.length === 0) {
      return contractCorrupt(
        `compiled plan planRevision is ${describeBindingValue(planRevision)}, not a non-empty string`,
      );
    }
    const recordGraphId = value.graphId;
    if (typeof recordGraphId !== "string" || recordGraphId.length === 0) {
      return contractCorrupt(
        `compiled plan graphId is ${describeBindingValue(recordGraphId)}, not a non-empty string`,
      );
    }
    if (recordGraphId !== graphId) {
      return contractCorrupt(
        `compiled plan graphId ${JSON.stringify(recordGraphId)} is not the persisted graphId ${JSON.stringify(graphId)}`,
      );
    }
    if (value.declarationVersion !== COMPILED_DECLARATION_VERSION) {
      return contractCorrupt(
        `compiled plan declarationVersion is ${describeBindingValue(value.declarationVersion)}, not the compiled grammar ${COMPILED_DECLARATION_VERSION}`,
      );
    }
    const nodes = value.nodes;
    const edges = value.edges;
    const loopGroups = value.loopGroups;
    if (!Array.isArray(nodes)) {
      return contractCorrupt("compiled plan nodes is not an array of compiled nodes");
    }
    if (!Array.isArray(edges)) {
      return contractCorrupt("compiled plan edges is not an array of compiled edges");
    }
    if (!Array.isArray(loopGroups)) {
      return contractCorrupt("compiled plan loopGroups is not an array of compiled loop groups");
    }
    // (a2) EXECUTABILITY — a persisted `compiledPlan` means "the plan this
    // state may run". A DRAFT never had its acceptance requirements resolved,
    // so it is refused BY NAME here instead of being loaded as executable; a
    // malformed value is refused as a malformed record. The reading is the plan
    // module's own, so the compiler's marker and this gate cannot drift.
    const executability = readPlanExecutability(value.executability);
    if (executability.kind !== "executable") {
      if (executability.kind === "draft") {
        // Name what the draft left open: acceptance gates, natural-completion
        // authorizations, or both. The reading already proved both lists are
        // present and at least one is non-empty; the counts are read
        // defensively so this diagnostic can never throw on its own input.
        const draft = value.executability;
        const unresolvedCount =
          isPlainObject(draft) && Array.isArray(draft.unresolved)
            ? draft.unresolved.length
            : 0;
        const completionCount =
          isPlainObject(draft) && Array.isArray(draft.unauthorizedCompletions)
            ? draft.unauthorizedCompletions.length
            : 0;
        return contractCorrupt(
          `compiled plan is not executable (${NON_EXECUTABLE_PLAN_CODE}): it is a DRAFT that leaves ${unresolvedCount} acceptance requirement(s) and ${completionCount} natural-completion mapping(s) unresolved — a draft must not be loaded as an executable plan`,
        );
      }
      return contractCorrupt(
        `compiled plan executability is ${describeBindingValue(value.executability)}, not { kind: "executable" }`,
      );
    }
    // (b) TOPOLOGY — every plan-level rule, owned next to the plan shape. The
    // completion-authorization bundle is passed explicitly: a persisted plan
    // whose executable marker claims a natural mapping must PROVE the
    // authorization from its own content/identity indexes (D6).
    const topology = inspectCompiledTopology(
      nodes,
      edges,
      loopGroups,
      value.terminalOutcomes,
      value.executability,
      {
        authorizations: value.completionAuthorizations,
        snapshots: value.completionPolicySnapshots,
        identities: value.completionPolicyIdentities,
      },
    );
    if (topology.issues.length > 0) {
      const issue = topology.issues[0];
      return contractCorrupt(
        `compiled plan topology is inconsistent (${issue.code}): ${issue.message}`,
      );
    }
    const topologyNodeIds = new Set(topology.nodeIds);
    for (const nodeId of topology.nodeIds) {
      if (!nodeIds.has(nodeId)) {
        return contractCorrupt(
          `compiled plan topology declares node id ${JSON.stringify(nodeId)}, which the persisted state does not declare`,
        );
      }
    }
    // (b2) INDEX — `nodeBindings` is the ONE record field the plan revision
    // does not cover, so it is checked as what the type says it is: the
    // projection of the plan nodes (`createPersistedCompiledPlan` builds it
    // with `nodeBindingsOf`). Every node that declares a `contractRef` must
    // appear with the SAME ref, a node that declares none must not appear, and
    // every key must be a topology node id — otherwise a rebinding could hide
    // behind an otherwise valid snapshot.
    const rawNodeBindings = value.nodeBindings;
    if (isPlainObject(rawNodeBindings)) {
      const indexKeys = Object.keys(rawNodeBindings);
      for (const raw of nodes) {
        if (!isPlainObject(raw) || typeof raw.id !== "string") continue;
        const nodeRef = raw.contractRef;
        if (nodeRef === undefined) {
          if (indexKeys.includes(raw.id)) {
            return contractCorrupt(
              `compiled plan node binding ${JSON.stringify(raw.id)} binds a node that declares no contractRef`,
            );
          }
          continue;
        }
        if (!isContractRef(nodeRef)) {
          return contractCorrupt(
            `compiled plan node ${JSON.stringify(raw.id)} contractRef is not a contract ref { id, revision, digest } of non-empty strings`,
          );
        }
        const boundRef = rawNodeBindings[raw.id];
        if (!isContractRef(boundRef)) {
          return contractCorrupt(
            `compiled plan node ${JSON.stringify(raw.id)} declares a contractRef the nodeBindings index does not carry`,
          );
        }
        if (!contractRefsEqual(boundRef, nodeRef)) {
          return contractCorrupt(
            `compiled plan node binding ${JSON.stringify(raw.id)} is ${describeContractRef(boundRef)}, but the node declares ${describeContractRef(nodeRef)}`,
          );
        }
      }
      for (const nodeId of [...indexKeys].sort()) {
        if (!topologyNodeIds.has(nodeId)) {
          return contractCorrupt(
            `compiled plan node binding references node id ${JSON.stringify(nodeId)}, which its topology does not declare`,
          );
        }
      }
    }
    // (c) CONTRACTS — the same rules the persisted binding is held to.
    const contracts = verifyContractRecord(value, nodeIds, "compiled plan");
    if (!contracts.ok) return contractCorrupt(contracts.reason);
    // (d) IDENTITY — the compiler's own content address, recomputed over the
    // record's plan body. `contractDigest` is reused, never re-implemented.
    let bodyDigest: string;
    try {
      readRunBudget(value.budget);
      bodyDigest = contractDigest({
        graphId: recordGraphId,
        declarationVersion: value.declarationVersion,
        ...(value.budget === undefined ? {} : { budget: value.budget }),
        nodes,
        edges,
        loopGroups,
        contractSnapshots: value.contractSnapshots,
        contractIdentities: value.contractIdentities,
        completionPolicySnapshots: value.completionPolicySnapshots,
        completionPolicyIdentities: value.completionPolicyIdentities,
        completionAuthorizations: value.completionAuthorizations,
        terminalOutcomes: value.terminalOutcomes,
        executability: value.executability,
      });
    } catch (err) {
      return contractCorrupt(
        `compiled plan body was rejected by contractDigest: ${errorText(err)}`,
      );
    }
    if (bodyDigest !== planRevision) {
      return contractCorrupt(
        `compiled plan planRevision ${JSON.stringify(planRevision)} is not the digest (${bodyDigest}) of its plan body`,
      );
    }
    return { kind: "verified" };
  } catch (err) {
    return contractCorrupt(
      `compiled plan verification failed: ${errorText(err)}`,
    );
  }
}
export function verifyPersistedPlan(
  compiledPlan: unknown,
  planBinding: unknown,
  graphId: string,
  nodeIds: ReadonlySet<string>,
): PlanBindingVerdict {
  const binding = verifyPersistedPlanBinding(planBinding, nodeIds);
  if (binding.kind === "corrupt") return binding;
  const plan = verifyPersistedCompiledPlan(compiledPlan, graphId, nodeIds);
  if (plan.kind === "corrupt") return plan;
  if (plan.kind === "absent" || binding.kind === "absent") {
    return plan.kind === "absent" ? binding : plan;
  }
  return verifyPersistedPlanAgreement(compiledPlan, planBinding);
}
function verifyPersistedPlanAgreement(
  compiledPlan: unknown,
  planBinding: unknown,
): PlanBindingVerdict {
  try {
    if (!isPlainObject(compiledPlan) || !isPlainObject(planBinding)) {
      return contractCorrupt(
        "compiled plan and plan binding are both present but not comparable records",
      );
    }
    const planRevision = compiledPlan.planRevision;
    const bindingRevision = planBinding.planRevision;
    if (bindingRevision !== planRevision) {
      return contractCorrupt(
        `plan binding planRevision ${JSON.stringify(bindingRevision)} does not equal the compiled plan planRevision ${JSON.stringify(planRevision)}`,
      );
    }
    const planSnapshots = compiledPlan.contractSnapshots;
    const bindingSnapshots = planBinding.contractSnapshots;
    const planIdentities = compiledPlan.contractIdentities;
    const bindingIdentities = planBinding.contractIdentities;
    const planBindings = compiledPlan.nodeBindings;
    const bindingBindings = planBinding.nodeBindings;
    if (
      !isPlainObject(planSnapshots) ||
      !isPlainObject(bindingSnapshots) ||
      !isPlainObject(planIdentities) ||
      !isPlainObject(bindingIdentities) ||
      !isPlainObject(planBindings) ||
      !isPlainObject(bindingBindings)
    ) {
      return contractCorrupt(
        "compiled plan and plan binding carry records the agreement check cannot compare",
      );
    }
    // (b) Every digest the binding references, read from EVERY kind of
    // reference — content keys, identity-index values and node binding refs: a
    // binding that keeps content or an identity the plan does not pin is a
    // projection that disagrees with its plan, whether or not a node still
    // binds it.
    const referenced = new Set<string>(Object.keys(bindingSnapshots));
    for (const revisions of Object.values(bindingIdentities)) {
      if (!isPlainObject(revisions)) continue;
      for (const digest of Object.values(revisions)) {
        if (typeof digest === "string" && digest.length > 0) {
          referenced.add(digest);
        }
      }
    }
    for (const boundRef of Object.values(bindingBindings)) {
      if (isContractRef(boundRef)) referenced.add(boundRef.digest);
    }
    for (const digest of [...referenced].sort()) {
      if (!Object.prototype.hasOwnProperty.call(planSnapshots, digest)) {
        return contractCorrupt(
          `plan binding references contract digest ${JSON.stringify(digest)}, which the compiled plan contractSnapshots does not contain`,
        );
      }
    }
    // (b2) The two identity indexes must agree EXACTLY. The binding is a
    // projection of the plan, so an identity only one of them maps is a
    // disagreement (a stale or tampered projection), not a legal difference —
    // and two identities sharing one digest still compare equal here.
    for (const id of Object.keys(bindingIdentities).sort()) {
      const bindingRevisions = bindingIdentities[id];
      const planRevisions = planIdentities[id];
      if (!isPlainObject(bindingRevisions) || !isPlainObject(planRevisions)) {
        return contractCorrupt(
          `plan binding contract identity ${JSON.stringify(id)} does not match the compiled plan identity index`,
        );
      }
      for (const revision of Object.keys(bindingRevisions).sort()) {
        const bindingDigest = bindingRevisions[revision];
        if (planRevisions[revision] !== bindingDigest) {
          return contractCorrupt(
            `plan binding maps contract ${JSON.stringify(id)}@${JSON.stringify(revision)} to ${describeBindingValue(bindingDigest)}, but the compiled plan maps it to ${describeBindingValue(planRevisions[revision])}`,
          );
        }
      }
      for (const revision of Object.keys(planRevisions).sort()) {
        if (!Object.prototype.hasOwnProperty.call(bindingRevisions, revision)) {
          return contractCorrupt(
            `compiled plan maps contract ${JSON.stringify(id)}@${JSON.stringify(revision)}, which the plan binding identity index does not carry`,
          );
        }
      }
    }
    for (const id of Object.keys(planIdentities).sort()) {
      if (!Object.prototype.hasOwnProperty.call(bindingIdentities, id)) {
        return contractCorrupt(
          `compiled plan carries contract identity ${JSON.stringify(id)}, which the plan binding identity index does not carry`,
        );
      }
    }
    // (c) The plan and the binding must bind each node to the same identity.
    for (const nodeId of Object.keys(bindingBindings).sort()) {
      const boundRef = bindingBindings[nodeId];
      if (!isContractRef(boundRef)) {
        return contractCorrupt(
          `plan binding node binding ${JSON.stringify(nodeId)} is not a contract ref`,
        );
      }
      const planRef = planBindings[nodeId];
      if (planRef === undefined) {
        return contractCorrupt(
          `plan binding binds node ${JSON.stringify(nodeId)}, which the compiled plan does not bind`,
        );
      }
      if (!isContractRef(planRef)) {
        return contractCorrupt(
          `compiled plan node binding ${JSON.stringify(nodeId)} is not a contract ref`,
        );
      }
      if (!contractRefsEqual(planRef, boundRef)) {
        return contractCorrupt(
          `plan binding binds node ${JSON.stringify(nodeId)} to ${describeContractRef(boundRef)}, but the compiled plan binds it to ${describeContractRef(planRef)}`,
        );
      }
    }
    return { kind: "verified" };
  } catch (err) {
    return contractCorrupt(
      `compiled plan / plan binding agreement check failed: ${errorText(err)}`,
    );
  }
}
