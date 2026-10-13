import { readRunBudget } from "../domain/budget.ts";
import { errorText } from "../../utils/error-text.ts";
import { contractDigest, contractRefsEqual, isContractRef, type ContractRef } from "../contracts/contract-definition.ts";
import {
  inspectCompiledTopology,
  NON_EXECUTABLE_PLAN_CODE,
  readPlanExecutability,
  type CompiledPlanBody,
  type PersistedCompiledPlan,
} from "./plan.ts";

/**
 * Compile-time completeness assertion: `Missing` is the set of keys the list it
 * is instantiated with omits, so anything but `never` fails to compile here.
 */
type MissingKeysAreNever<Missing extends never> = Missing;

/**
 * The compiled plan body's field list, restated by the verifier because the
 * digest input has to be rebuilt from the persisted record. `satisfies` refuses
 * a key the model does not declare; the assertion beside it refuses a model key
 * this list omits — so the restatement cannot drift from `CompiledPlanBody` in
 * silence. A field added to the model fails to compile HERE instead of making
 * every persisted plan fail its `planRevision` check.
 *
 * EXPORTED so `tests/graph/compiler-vocabulary-type-guards.test.ts` pins the
 * same link.
 */
export const BODY_KEYS = [
  "graphId",
  "declarationVersion",
  "budget",
  "nodes",
  "edges",
  "loopGroups",
  "contractSnapshots",
  "contractIdentities",
  "completionPolicySnapshots",
  "completionPolicyIdentities",
  "completionAuthorizations",
  "terminalOutcomes",
  "executability",
] as const satisfies readonly (keyof CompiledPlanBody)[];
type _BodyKeysComplete = MissingKeysAreNever<
  Exclude<keyof CompiledPlanBody, (typeof BODY_KEYS)[number]>
>;

/**
 * The digest input the verifier rebuilds from the persisted record: every key
 * {@link BODY_KEYS} names, values left `unknown` because they are persisted
 * data. `budget` is optional because the producer omits it when the declaration
 * declares no budget.
 */
type PersistedPlanBodyInput = Omit<
  { readonly [K in (typeof BODY_KEYS)[number]]: unknown },
  "budget"
> & { readonly budget?: unknown };

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
    // The FIRST issue, read once: the length check above and the read below are
    // one guard, so the element is total without relying on the effective
    // tsconfig omitting `noUncheckedIndexedAccess`.
    const firstIssue = topology.issues[0];
    if (firstIssue !== undefined) {
      return contractCorrupt(
        `compiled plan topology is inconsistent (${firstIssue.code}): ${firstIssue.message}`,
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
      const persistedBody: PersistedPlanBodyInput = {
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
      };
      bodyDigest = contractDigest(persistedBody);
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

/**
 * The whole persisted-plan gate: the record's integrity — topology,
 * executability, contract content/identity indexes and the recomputed content
 * address — AND the node fields its consumers read (see
 * {@link readConsumerNodeIssue}).
 *
 * The gate used to take a second `planBinding` parameter and then run a
 * 120-line agreement rule over the two. The store persists ONE plan record, its
 * only production caller passed that same record for both parameters, and every
 * comparison was therefore `x === x` — a rule that could never fire, with a
 * node-binding loop that only walked the binding side (A-11). The parameter and
 * the rule are gone: `planRevision`, the contract indexes and the node-binding
 * projection are each held to their own rule by
 * {@link verifyPersistedCompiledPlan}, which is where they belong.
 */
export function verifyPersistedPlan(
  compiledPlan: unknown,
  graphId: string,
  nodeIds: ReadonlySet<string>,
): PlanBindingVerdict {
  const plan = verifyPersistedCompiledPlan(compiledPlan, graphId, nodeIds);
  if (plan.kind !== "verified") return plan;
  const nodeIssue = readConsumerNodeIssue(compiledPlan);
  if (nodeIssue !== undefined) return contractCorrupt(nodeIssue);
  return { kind: "verified" };
}

/**
 * Read the node fields a CONSUMER reads — `agent` and `prompt` (copied into an
 * `OutcomeDispatchIntent` whose fields are `string`), the declared host-tool
 * grant `tools`, the consumed results `inputs`, the fan-in `join`, the node's
 * `outcomes` (each one's `data` contract and `acceptance` gates) and its
 * `completion` policy — and name the first one a persisted plan cannot
 * substantiate.
 *
 * WHY THIS EXISTS. The integrity rules deliberately read none of these fields:
 * a node's prompt, budget, contract ref or any extra key is covered by the
 * plan's content address, not by a plan-level rule (`inspectCompiledTopology`).
 * But a content address proves a body is the body the row is keyed by, not that
 * its nodes carry the shape its consumers hold. `outcome/graph-state.ts` copies
 * `targetNode.agent`/`.prompt` into a dispatch intent, so an absent `agent`
 * reaches dispatch as `undefined` while the compiler's type says it cannot —
 * the one place a stored row was read approximately instead of being refused by
 * name.
 *
 * IT IS THE COMPILER'S OWN SHAPE, NEVER A STRICTER ONE. The v3 grammar reads
 * `agent` and `prompt` as strings of ANY length (an empty agent is legal), so
 * this reader requires a string, not a non-empty one; `tools`, `inputs` and
 * `join` are read exactly as the compiler writes them. Every plan this build
 * compiles and persists passes, which is what keeps the reader from refusing a
 * record its own producer wrote.
 */
function readConsumerNodeIssue(plan: unknown): string | undefined {
  const rawNodes = isPlainObject(plan) ? plan.nodes : undefined;
  if (!Array.isArray(rawNodes)) {
    return "compiled plan nodes is not an array of compiled nodes";
  }
  // `Array.isArray` narrows `unknown` to `any[]`; re-typing the elements as
  // `unknown` keeps every later read checked instead of implicitly `any`.
  const nodes: readonly unknown[] = rawNodes;
  for (const raw of nodes) {
    if (!isPlainObject(raw)) {
      return "compiled plan carries a node that is not a record";
    }
    const id = raw.id;
    if (typeof id !== "string" || id.length === 0) {
      return "compiled plan carries a node with no non-empty id";
    }
    const agent = raw.agent;
    if (typeof agent !== "string") {
      return `compiled plan node ${JSON.stringify(id)} agent is ${describeBindingValue(agent)}, not the string its dispatch intent requires`;
    }
    const prompt = raw.prompt;
    if (typeof prompt !== "string") {
      return `compiled plan node ${JSON.stringify(id)} prompt is ${describeBindingValue(prompt)}, not the string its dispatch intent requires`;
    }
    const tools = raw.tools;
    if (tools !== undefined) {
      if (!Array.isArray(tools) || tools.length === 0) {
        return `compiled plan node ${JSON.stringify(id)} tools is not a non-empty array of host tool names`;
      }
      const toolNames: readonly unknown[] = tools;
      for (const tool of toolNames) {
        if (typeof tool !== "string" || tool.length === 0) {
          return `compiled plan node ${JSON.stringify(id)} tools carries ${describeBindingValue(tool)}, not a non-empty host tool name`;
        }
      }
    }
    const inputs = raw.inputs;
    if (inputs !== undefined) {
      if (!Array.isArray(inputs) || inputs.length === 0) {
        return `compiled plan node ${JSON.stringify(id)} inputs is not a non-empty array of { from, outcome }`;
      }
      const inputRefs: readonly unknown[] = inputs;
      for (const input of inputRefs) {
        if (!isPlainObject(input)) {
          return `compiled plan node ${JSON.stringify(id)} input is not a record of { from, outcome }`;
        }
        const from = input.from;
        const outcome = input.outcome;
        if (
          typeof from !== "string" || from.length === 0 ||
          typeof outcome !== "string" || outcome.length === 0
        ) {
          return `compiled plan node ${JSON.stringify(id)} input is not { from, outcome } with non-empty strings`;
        }
        if (input.when !== undefined && input.when !== "triggered") {
          return `compiled plan node ${JSON.stringify(id)} input when is ${describeBindingValue(input.when)}, not "triggered"`;
        }
      }
    }
    const join = raw.join;
    if (join !== undefined) {
      if (!isPlainObject(join)) {
        return `compiled plan node ${JSON.stringify(id)} join is not a JoinConfig`;
      }
      const strategy = join.strategy;
      if (strategy === "quorum") {
        const quorum = join.quorum;
        if (typeof quorum !== "number" || !Number.isSafeInteger(quorum) || quorum < 1) {
          return `compiled plan node ${JSON.stringify(id)} join quorum is ${describeBindingValue(quorum)}, not a positive integer`;
        }
      } else if (strategy !== "all" && strategy !== "any") {
        return `compiled plan node ${JSON.stringify(id)} join strategy is ${describeBindingValue(strategy)}, not "all", "any" or "quorum"`;
      }
    }
    const outcomes = raw.outcomes;
    if (!Array.isArray(outcomes) || outcomes.length === 0) {
      return `compiled plan node ${JSON.stringify(id)} outcomes is not a non-empty array of compiled outcomes`;
    }
    const outcomeList: readonly unknown[] = outcomes;
    for (const rawOutcome of outcomeList) {
      if (!isPlainObject(rawOutcome)) {
        return `compiled plan node ${JSON.stringify(id)} carries an outcome that is not a record`;
      }
      const outcomeId = rawOutcome.id;
      if (typeof outcomeId !== "string" || outcomeId.length === 0) {
        return `compiled plan node ${JSON.stringify(id)} carries an outcome with no non-empty id`;
      }
      const data = rawOutcome.data;
      if (data !== undefined) {
        if (!isPlainObject(data)) {
          return `compiled plan node ${JSON.stringify(id)} outcome ${JSON.stringify(outcomeId)} data is ${describeBindingValue(data)}, not a { schema, version? } contract`;
        }
        const schema = data.schema;
        if (typeof schema !== "string" || schema.length === 0) {
          return `compiled plan node ${JSON.stringify(id)} outcome ${JSON.stringify(outcomeId)} data schema is ${describeBindingValue(schema)}, not a non-empty string`;
        }
        const version = data.version;
        if (version !== undefined && (typeof version !== "number" || !Number.isFinite(version))) {
          return `compiled plan node ${JSON.stringify(id)} outcome ${JSON.stringify(outcomeId)} data version is ${describeBindingValue(version)}, not a finite number`;
        }
      }
      const acceptance = rawOutcome.acceptance;
      if (!Array.isArray(acceptance)) {
        return `compiled plan node ${JSON.stringify(id)} outcome ${JSON.stringify(outcomeId)} acceptance is not an array of { validator, version? } requirements`;
      }
      const requirements: readonly unknown[] = acceptance;
      for (const requirement of requirements) {
        if (!isPlainObject(requirement)) {
          return `compiled plan node ${JSON.stringify(id)} outcome ${JSON.stringify(outcomeId)} carries an acceptance requirement that is not a record`;
        }
        const validator = requirement.validator;
        if (typeof validator !== "string" || validator.length === 0) {
          return `compiled plan node ${JSON.stringify(id)} outcome ${JSON.stringify(outcomeId)} acceptance validator is ${describeBindingValue(validator)}, not a non-empty string`;
        }
        const version = requirement.version;
        if (version !== undefined && (typeof version !== "number" || !Number.isFinite(version))) {
          return `compiled plan node ${JSON.stringify(id)} outcome ${JSON.stringify(outcomeId)} acceptance version is ${describeBindingValue(version)}, not a finite number`;
        }
      }
    }
    const completion = raw.completion;
    if (completion !== undefined) {
      if (!isPlainObject(completion)) {
        return `compiled plan node ${JSON.stringify(id)} completion is ${describeBindingValue(completion)}, not a completion policy`;
      }
      const mode = completion.mode;
      if (mode === "natural") {
        const outcome = completion.outcome;
        if (typeof outcome !== "string" || outcome.length === 0) {
          return `compiled plan node ${JSON.stringify(id)} natural completion outcome is ${describeBindingValue(outcome)}, not a non-empty outcome id`;
        }
      } else if (mode !== "explicit") {
        return `compiled plan node ${JSON.stringify(id)} completion mode is ${describeBindingValue(mode)}, not "explicit" or "natural"`;
      }
    }
  }
  return undefined;
}

/**
 * Read a decoded `plan` column as the value its consumers hold.
 *
 * `verifyPersistedPlan` proves the topology, the executability marker, the
 * contract indexes, the node-binding projection, the consumer-visible node
 * fields and the record's own content address before this reader hands back the
 * SAME value, narrowed to {@link PersistedCompiledPlan}. A record that fails
 * any of those answers `undefined`, which `decodeStoredDefinition` turns into
 * its existing `unrunnable-plan` refusal — the row is refused by name instead
 * of being asserted into a type its bytes do not carry.
 *
 * The reader COPIES nothing: the returned record is the decoded column itself,
 * so a plan that verified before this change is still the same value with the
 * same reach. The expected graph id is not a parameter because the caller
 * addresses the plan by the row it already holds; `decodeStoredDefinition`
 * compares the returned record's `graphId` to the row's own.
 */
export function readPersistedCompiledPlan(
  value: unknown,
  nodeIds: ReadonlySet<string>,
): PersistedCompiledPlan | undefined {
  return isRunnablePersistedPlan(value, nodeIds) ? value : undefined;
}

/**
 * The predicate behind {@link readPersistedCompiledPlan}: the ONE place the
 * verdict "verified" is allowed to narrow a decoded row to the plan type, and
 * it narrows only what {@link verifyPersistedPlan} has read.
 */
function isRunnablePersistedPlan(
  value: unknown,
  nodeIds: ReadonlySet<string>,
): value is PersistedCompiledPlan {
  if (!isPlainObject(value)) return false;
  const graphId = value.graphId;
  if (typeof graphId !== "string" || graphId.length === 0) return false;
  return verifyPersistedPlan(value, graphId, nodeIds).kind === "verified";
}
