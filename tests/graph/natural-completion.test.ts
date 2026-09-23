/**
 * Natural-completion settlement.
 *
 * Covers the run path's completion-fact channel end to end: a delivery names
 * the attempt and presents its bearer credential, the OUTCOME is resolved from
 * the plan's pinned natural-completion authorization, and the settlement runs
 * through the SAME acceptance core, the same declared gates and the same atomic
 * receipt/event/state/effects transaction as an ordinary submission.
 *
 * The cases below are the rules the channel exists to enforce:
 *
 * 1. the happy path settles the AUTHORIZED outcome and records the natural
 *    source in the persisted submission key;
 * 2. a missing, tampered, cross-node or cross-attempt credential is refused by
 *    a stable code and a field path, and writes nothing at all;
 * 3. a node with no pinned authorization — and a node the plan does not declare
 *    — is refused rather than downgraded to the explicit path;
 * 4. a declared acceptance gate that fails does NOT settle the attempt, and the
 *    attempt stays open for the ordinary submission path;
 * 5. a repeated delivery REPLAYS the first receipt: one settlement, one
 *    accepted event, no second state advance, and a delivery for an attempt
 *    already settled by a worker's own submission is reported not-committed;
 * 6. the envelope is CLOSED — an outcome, a payload or an evidence list offered
 *    alongside the completion fact is refused by name, so no result can be
 *    routed through completion metadata;
 * 7. a natural continuation advances the same loop counters through the same
 *    reducer and stops through the same durable stop (loop-exhausted), while a
 *    progress-governed continuation is refused exactly as a payload-less
 *    submission is (a declared comparison is never skipped);
 * 8. the enablement conditions (credential isolation, completion-policy
 *    capability) and the ordinary explicit path are unchanged.
 *
 * Every case runs in its own mkdtemp directory and removes it in a finally
 * block (plus an afterEach sweep); nothing here writes outside a temp dir.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase, type DatabaseDriver } from "../../src/memory/db-driver.ts";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import type { CompiledPlan } from "../../src/graph/compiler/plan.ts";
import {
  completionPolicyRefOf,
  createCompletionPolicyRegistry,
  type CompletionPolicyBody,
  type CompletionPolicyRef,
  type CompletionPolicyRegistry,
} from "../../src/graph/policy/completion-policy.ts";
import {
  SqliteAcceptanceLedger,
  ledgerFilePath,
} from "../../src/graph/ledger/sqlite-ledger.ts";
import {
  OutcomeGraphRuntime,
  type OutcomeDispatchRequest,
} from "../../src/graph/outcome/runtime.ts";
import { isNaturalCompletionSubmissionId } from "../../src/graph/outcome/natural-completion.ts";
import type { OutcomeGraphState } from "../../src/graph/outcome/graph-state.ts";
import type { AttemptCredentialSource } from "../../src/graph/outcome/attempt-credential.ts";
import {
  createValidatorRegistry,
  type ValidationOutcome,
  type ValidatorRegistry,
} from "../../src/graph/outcome/validators.ts";
import { buildDeclaredOutcomeGraph } from "../../src/graph/tools/declare-graph.ts";
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const EMPTY_VALIDATORS: ValidatorRegistry = createValidatorRegistry([]);
const POLICY_PREFIX = "test.natural-settlement.";
const POLICY_REVISION = "1";
const GRAPH_ID = "graph.natural-settlement";
const LOOP_GRAPH_ID = "graph.natural-loop";
const PROGRESS_GRAPH_ID = "graph.natural-progress";
const GATED_GRAPH_ID = "graph.natural-gated";

/**
 * The policy revision one graph requests. Each fixture's graph id names its own
 * policy id, so ONE installed registry can authorize every fixture here — which
 * is what the harness installs by default.
 */
function policyRequest(graphId: string): {
  readonly id: string;
  readonly revision: string;
} {
  return { id: POLICY_PREFIX + graphId, revision: POLICY_REVISION };
}

/**
 * work --done--> ship, where ship completes NATURALLY into "shipped" and the
 * graph requests the policy the host installs in the harness.
 */
function naturalDeclaration(
  overrides: Partial<GraphDeclarationV3> = {},
): GraphDeclarationV3 {
  return {
    version: 3,
    name: GRAPH_ID,
    nodes: [
      {
        id: "work",
        agent: "agent.work",
        prompt: "Do the work.",
        outcomes: [{ id: "done" }],
      },
      {
        id: "ship",
        agent: "agent.ship",
        prompt: "Ship it.",
        outcomes: [{ id: "shipped" }],
        completion: { mode: "natural", outcome: "shipped" },
      },
    ],
    edges: [{ from: "work", to: "ship", outcome: "done" }],
    completion_policy: policyRequest(GRAPH_ID),
    ...overrides,
  };
}

/**
 * The same graph, but ship declares TWO outcomes: the natural policy maps it to
 * "shipped" and "cancelled" stays an ordinary declared outcome. A completion
 * fact that tried to pick the other one is therefore observable.
 */
function twoOutcomeNaturalDeclaration(): GraphDeclarationV3 {
  const base = naturalDeclaration();
  return {
    ...base,
    nodes: base.nodes.map((node) =>
      node.id === "ship"
        ? {
            ...node,
            outcomes: [{ id: "cancelled" }, { id: "shipped" }],
          }
        : node,
    ),
  };
}

/**
 * A declared graph with NO natural completion anywhere: the control case for
 * "an unauthorized node is refused, never silently reinterpreted".
 */
const EXPLICIT_ONLY: GraphDeclarationV3 = {
  version: 3,
  name: "graph.explicit-only",
  nodes: [
    {
      id: "work",
      agent: "agent.work",
      prompt: "Do the work.",
      outcomes: [{ id: "done" }],
    },
    {
      id: "ship",
      agent: "agent.ship",
      prompt: "Ship it.",
      outcomes: [{ id: "shipped" }],
    },
  ],
  edges: [{ from: "work", to: "ship", outcome: "done" }],
};

/**
 * work -> review -> (revise) -> work, where REVIEW completes naturally into the
 * loop's continuation outcome — a natural completion that must advance the same
 * traversal counter and hit the same hard cap as any other outcome.
 */
function naturalLoopDeclaration(maxTraversals: number): GraphDeclarationV3 {
  return {
    version: 3,
    name: LOOP_GRAPH_ID,
    nodes: [
      {
        id: "work",
        agent: "agent.work",
        prompt: "Do the work.",
        outcomes: [{ id: "done" }],
      },
      {
        id: "review",
        agent: "agent.review",
        prompt: "Review the work.",
        outcomes: [{ id: "revise" }, { id: "approve" }],
        completion: { mode: "natural", outcome: "revise" },
      },
    ],
    edges: [
      { from: "work", to: "review", outcome: "done" },
      { from: "review", to: "work", outcome: "revise" },
    ],
    loop_groups: [
      {
        id: "revise-loop",
        nodes: ["work", "review"],
        max_traversals: maxTraversals,
        continuation_outcome: "revise",
        exit_outcome: "approve",
      },
    ],
    completion_policy: policyRequest(LOOP_GRAPH_ID),
  };
}

/** The same loop with a DECLARED progress policy on its continuation. */
function naturalProgressLoopDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: PROGRESS_GRAPH_ID,
    nodes: [
      {
        id: "work",
        agent: "agent.work",
        prompt: "Do the work.",
        outcomes: [{ id: "done" }],
      },
      {
        id: "review",
        agent: "agent.review",
        prompt: "Review the work.",
        outcomes: [{ id: "revise" }, { id: "approve" }],
        completion: { mode: "natural", outcome: "revise" },
      },
    ],
    edges: [
      { from: "work", to: "review", outcome: "done" },
      { from: "review", to: "work", outcome: "revise" },
    ],
    loop_groups: [
      {
        id: "revise-loop",
        nodes: ["work", "review"],
        max_traversals: 20,
        continuation_outcome: "revise",
        exit_outcome: "approve",
        progress: {
          evaluator: "revision-token",
          version: 1,
          subject: "revision",
          max_unchanged: 2,
        },
      },
    ],
    completion_policy: policyRequest(PROGRESS_GRAPH_ID),
  };
}

/** The natural graph whose "work" outcome is gated by a test validator. */
function gatedNaturalDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: GATED_GRAPH_ID,
    nodes: [
      {
        id: "work",
        agent: "agent.work",
        prompt: "Do the work.",
        outcomes: [
          {
            id: "done",
            acceptance: [{ validator: "gate.check", version: 1 }],
          },
        ],
        completion: { mode: "natural", outcome: "done" },
      },
      {
        id: "ship",
        agent: "agent.ship",
        prompt: "Ship it.",
        outcomes: [{ id: "delivered" }],
      },
    ],
    edges: [{ from: "work", to: "ship", outcome: "done" }],
    completion_policy: policyRequest(GATED_GRAPH_ID),
  };
}

const GATE_ID = "gate.check";
const GATE_VERSION = 1;

function gatedRegistry(outcome: ValidationOutcome): ValidatorRegistry {
  return createValidatorRegistry([
    { id: GATE_ID, version: GATE_VERSION, implementation: () => outcome },
  ]);
}

// ── Policies ────────────────────────────────────────────────────────────────

/** One rule granting exactly one (graph, node, outcome) mapping. */
function grantingBody(
  graphId: string,
  nodeId: string,
  outcome: string,
): CompletionPolicyBody {
  return {
    version: 1,
    default: "ungranted",
    rules: [{ graphId, nodeId, outcome, decision: "allow" }],
  };
}

/** ship -> shipped in {@link GRAPH_ID}. */
const GRANT: CompletionPolicyBody = grantingBody(GRAPH_ID, "ship", "shipped");

/** review -> revise in the cap-only loop graph. */
const LOOP_GRANT: CompletionPolicyBody = grantingBody(
  LOOP_GRAPH_ID,
  "review",
  "revise",
);

/** review -> revise in the progress-governed loop graph. */
const PROGRESS_GRANT: CompletionPolicyBody = grantingBody(
  PROGRESS_GRAPH_ID,
  "review",
  "revise",
);

/** work -> done in the gated graph. */
const GATED_GRANT: CompletionPolicyBody = grantingBody(
  GATED_GRAPH_ID,
  "work",
  "done",
);

/** The ref one granting body is installed under: its own rule's graph id. */
function refOf(body: CompletionPolicyBody): CompletionPolicyRef {
  const rule = body.rules[0];
  if (rule === undefined) {
    throw new Error("fixture: a granting body lists exactly one rule");
  }
  return completionPolicyRefOf({
    id: POLICY_PREFIX + rule.graphId,
    revision: POLICY_REVISION,
    body,
  });
}

function registryOf(...bodies: readonly CompletionPolicyBody[]): CompletionPolicyRegistry {
  return createCompletionPolicyRegistry({
    policies: bodies.map((body) => ({ ref: refOf(body), body })),
  });
}

/** Every fixture's policy, installed together — the harness default. */
const ALL_AUTHORIZED = registryOf(GRANT, LOOP_GRANT, PROGRESS_GRANT, GATED_GRANT);

// ── Harness ─────────────────────────────────────────────────────────────────

interface Harness {
  readonly runtime: OutcomeGraphRuntime;
  readonly plan: CompiledPlan;
  readonly ledger: SqliteAcceptanceLedger;
  /** Every request the scripted dispatch seam received, in order. */
  readonly requests: OutcomeDispatchRequest[];
  readonly graphId: string;
  readonly dir: string;
  /** The credential the given attempt was dispatched with. */
  credentialOf(attemptId: string): string;
}

/** One credential per attempt, derived from the binding the runtime hands it. */
const TEST_CREDENTIAL_SOURCE: AttemptCredentialSource = (binding) =>
  "test-credential:" + binding.nodeId + "#" + binding.attemptId;

/** Options a case may vary without rebuilding the whole harness. */
interface HarnessOptions {
  readonly validators?: ValidatorRegistry;
  readonly supportedValidators?: readonly {
    readonly validator: string;
    readonly version?: number;
  }[];
  /**
   * `false` builds the plan with NO host completion-policy capability — a
   * natural mapping then compiles to a draft and the plan cannot be built at
   * all, which is why every natural fixture defaults to `true`.
   */
  readonly planPolicies?: boolean;
  /** `false` runs WITHOUT the completion-policy capability. */
  readonly runtimePolicies?: boolean;
  /** `false` runs WITHOUT a credential-isolation adapter. */
  readonly credentialIsolation?: boolean;
}

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

async function withHarness<T>(
  declaration: GraphDeclarationV3,
  fn: (harness: Harness) => Promise<T> | T,
  options: HarnessOptions = {},
): Promise<T> {
  const dir = makeTmpDir("natural-settlement-");
  const ledger = await SqliteAcceptanceLedger.create(dir);
  try {
    const declared = buildDeclaredOutcomeGraph({
      declaration,
      ...(options.supportedValidators === undefined
        ? {}
        : { supportedValidators: [...options.supportedValidators] }),
      ...(options.planPolicies === false
        ? {}
        : { completionPolicies: ALL_AUTHORIZED }),
    });
    const requests: OutcomeDispatchRequest[] = [];
    const runtime = new OutcomeGraphRuntime({
      plan: declared.plan,
      ledger,
      dispatch: (request) => {
        requests.push(request);
      },
      validators: options.validators ?? EMPTY_VALIDATORS,
      artifactRoot: dir,
      clock: () => NOW,
      mintCredential: TEST_CREDENTIAL_SOURCE,
      ...(options.credentialIsolation === false
        ? {}
        : { credentialIsolation: testHostCredentialIsolation(dir) }),
      ...(options.runtimePolicies === false
        ? {}
        : { completionPolicies: ALL_AUTHORIZED }),
    });
    return await fn({
      runtime,
      plan: declared.plan,
      ledger,
      requests,
      graphId: declared.graphId,
      dir,
      credentialOf: (attemptId) => credentialOf(requests, attemptId),
    });
  } finally {
    ledger.close();
  }
}

/** The credential one dispatched attempt carried, failing when it never ran. */
function credentialOf(
  requests: readonly OutcomeDispatchRequest[],
  attemptId: string,
): string {
  const found = requests.find((request) => request.attemptId === attemptId);
  if (found === undefined) {
    throw new Error(
      "fixture: no dispatch request for attempt " +
        attemptId +
        " (dispatched: " +
        requests.map((request) => request.attemptId).join(", ") +
        ")",
    );
  }
  return found.credential;
}

/** One node's progress in a state, failing the test when it is missing. */
function nodeOf(state: OutcomeGraphState, nodeId: string) {
  const found = state.nodes.find((node) => node.nodeId === nodeId);
  if (found === undefined) throw new Error("no state for node " + nodeId);
  return found;
}

/**
 * Everything a refusal must leave untouched: the state row, the accepted-event
 * stream and the unsettled effects. A receipt is counted separately because a
 * refusal must not write one either.
 */
function snapshotOf(harness: Harness): string {
  return JSON.stringify({
    state: harness.ledger.readGraphState(harness.graphId),
    events: harness.ledger.acceptedEvents(harness.graphId),
    effects: harness.ledger.pendingEffects(harness.graphId),
  });
}

/** Count one table through a second connection (the store is the authority). */
async function countTable(dir: string, table: string): Promise<number> {
  const db: DatabaseDriver = await createDatabase(ledgerFilePath(dir));
  try {
    const row = db.query("SELECT COUNT(*) AS n FROM " + table).get();
    if (typeof row === "object" && row !== null && "n" in row) {
      const value = row.n;
      if (typeof value === "number") return value;
    }
    throw new Error("count query did not answer a number: " + table);
  } finally {
    db.close();
  }
}

// ── The settlement path ─────────────────────────────────────────────────────

describe("OutcomeGraphRuntime.settleNatural — one attempt, one authorized outcome, one transaction", () => {
  it("settles the authorized outcome from the attempt's completion fact and records the natural source", async () => {
    await withHarness(naturalDeclaration(), ({ runtime, ledger, requests, graphId }) => {
      const started = runtime.start(NOW);
      expect(started.kind).toBe("started");

      const worked = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
        NOW + 1,
      );
      expect(worked.kind).toBe("accepted");
      if (worked.kind !== "accepted") return;
      // The ordinary ingress keeps its own namespace ...
      expect(worked.receipt.submissionId.startsWith("submission:")).toBe(true);
      expect(isNaturalCompletionSubmissionId(worked.receipt.submissionId)).toBe(false);

      const settled = runtime.settleNatural(
        { nodeId: "ship", attemptId: "ship#2", credential: credentialOf(requests, "ship#2") },
        NOW + 2,
      );
      expect(settled.kind).toBe("accepted");
      if (settled.kind !== "accepted") return;
      expect(settled.replayed).toBe(false);
      expect(settled.decision.kind).toBe("accepted");
      expect(settled.completion).toMatchObject({
        source: "natural-completion",
        nodeId: "ship",
        attemptId: "ship#2",
        // The outcome comes from the PINNED authorization, never a caller.
        outcomeId: "shipped",
      });
      expect(settled.completion.policy).toEqual(refOf(GRANT));
      // THE SOURCE IS THE PERSISTED KEY: the record, the receipt and the
      // decision all name the natural namespace, content-addressed by the
      // canonical proposal digest.
      expect(settled.completion.submissionId).toBe(settled.receipt.submissionId);
      expect(settled.completion.submissionId).toBe(
        settled.decision.identity.submissionId,
      );
      expect(isNaturalCompletionSubmissionId(settled.receipt.submissionId)).toBe(true);
      expect(settled.receipt.submissionId).toBe(
        "natural-completion:" + settled.receipt.proposalDigest,
      );

      // The run is complete, on the authorized outcome.
      expect(settled.state.phase).toBe("complete");
      expect(nodeOf(settled.state, "ship")).toMatchObject({
        status: "settled",
        outcomeId: "shipped",
        attemptId: "ship#2",
      });

      // The ledger is the authority: one receipt, one accepted event for the
      // attempt, and every dispatch effect terminal.
      const receipt = ledger.lookupReceipt({
        graphId,
        attemptId: "ship#2",
        submissionId: settled.receipt.submissionId,
      });
      expect(receipt).toEqual(settled.receipt);
      expect(receipt?.decision).toBe("accepted");
      const events = ledger.acceptedEvents(graphId);
      expect(events.map((event) => event.attemptId + ":" + event.outcomeId)).toEqual([
        "work#1:done",
        "ship#2:shipped",
      ]);
      expect(events[1]?.submissionId).toBe(settled.receipt.submissionId);
      expect(ledger.pendingEffects(graphId)).toEqual([]);
    });
  });

  it("refuses a delivery with no credential and writes nothing", async () => {
    await withHarness(naturalDeclaration(), async (harness) => {
      const { runtime, requests } = harness;
      runtime.start(NOW);
      const submitted = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
        NOW + 1,
      );
      expect(submitted.kind).toBe("accepted");
      const before = snapshotOf(harness);
      const receiptsBefore = await countTable(harness.dir, "ledger_receipts");

      const refused = runtime.settleNatural(
        { nodeId: "ship", attemptId: "ship#2" },
        NOW + 2,
      );
      expect(refused.kind).toBe("refused");
      if (refused.kind === "refused") {
        expect(refused.refusals.map((refusal) => refusal.code)).toEqual([
          "credential-missing",
        ]);
        expect(refused.refusals[0]?.path).toBe("$.credential");
      }
      expect(snapshotOf(harness)).toBe(before);
      expect(await countTable(harness.dir, "ledger_receipts")).toBe(receiptsBefore);
    });
  });

  it("refuses a tampered credential and writes nothing", async () => {
    await withHarness(naturalDeclaration(), async (harness) => {
      const { runtime, requests } = harness;
      runtime.start(NOW);
      expect(
        runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
          NOW + 1,
        ).kind,
      ).toBe("accepted");
      const before = snapshotOf(harness);

      const refused = runtime.settleNatural(
        { nodeId: "ship", attemptId: "ship#2", credential: "guessed-nonce" },
        NOW + 2,
      );
      expect(refused.kind).toBe("refused");
      if (refused.kind === "refused") {
        expect(refused.refusals.map((refusal) => refusal.code)).toEqual([
          "credential-unknown",
        ]);
        expect(refused.refusals[0]?.path).toBe("$.credential");
      }
      expect(snapshotOf(harness)).toBe(before);
      // The attempt is still in flight and still settleable by its own credential.
      const state = runtime.state();
      expect(state === undefined ? undefined : nodeOf(state, "ship").status).toBe(
        "dispatched",
      );
    });
  });

  it("refuses a credential issued for another NODE", async () => {
    await withHarness(naturalDeclaration(), async (harness) => {
      const { runtime, requests } = harness;
      runtime.start(NOW);
      const before = snapshotOf(harness);

      const refused = runtime.settleNatural(
        // work#1's real credential, aimed at ship's attempt name.
        { nodeId: "ship", attemptId: "ship#2", credential: credentialOf(requests, "work#1") },
        NOW + 1,
      );
      expect(refused.kind).toBe("refused");
      if (refused.kind === "refused") {
        expect(refused.refusals.map((refusal) => refusal.code)).toEqual([
          "credential-node-mismatch",
        ]);
        expect(refused.refusals[0]?.path).toBe("$.credential");
      }
      expect(snapshotOf(harness)).toBe(before);
    });
  });

  it("refuses a credential issued for another ATTEMPT of the same node", async () => {
    await withHarness(naturalDeclaration(), async (harness) => {
      const { runtime, requests } = harness;
      runtime.start(NOW);
      expect(
        runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
          NOW + 1,
        ).kind,
      ).toBe("accepted");
      const before = snapshotOf(harness);

      const refused = runtime.settleNatural(
        // ship#2's real credential, but the delivery names another attempt.
        { nodeId: "ship", attemptId: "ship#9", credential: credentialOf(requests, "ship#2") },
        NOW + 2,
      );
      expect(refused.kind).toBe("refused");
      if (refused.kind === "refused") {
        expect(refused.refusals.map((refusal) => refusal.code)).toEqual([
          "attempt-mismatch",
        ]);
        expect(refused.refusals[0]?.path).toBe("$.attemptId");
      }
      expect(snapshotOf(harness)).toBe(before);
    });
  });

  it("refuses a node the plan did not authorize, a node it does not declare, and never falls back to explicit", async () => {
    await withHarness(naturalDeclaration(), async (harness) => {
      const { runtime, requests } = harness;
      runtime.start(NOW);
      const before = snapshotOf(harness);

      // work has NO natural completion policy at all.
      const unauthorized = runtime.settleNatural(
        { nodeId: "work", attemptId: "work#1", credential: credentialOf(requests, "work#1") },
        NOW + 1,
      );
      expect(unauthorized.kind).toBe("refused");
      if (unauthorized.kind === "refused") {
        expect(unauthorized.refusals.map((refusal) => refusal.code)).toEqual([
          "natural-completion-unauthorized",
        ]);
        expect(unauthorized.refusals[0]?.path).toBe("$.nodeId");
      }

      // A node the plan does not declare is a different, nameable refusal.
      const unknown = runtime.settleNatural(
        { nodeId: "nope", attemptId: "nope#1", credential: credentialOf(requests, "work#1") },
        NOW + 1,
      );
      expect(unknown.kind).toBe("refused");
      if (unknown.kind === "refused") {
        expect(unknown.refusals.map((refusal) => refusal.code)).toEqual(["unknown-node"]);
        expect(unknown.refusals[0]?.path).toBe("$.nodeId");
      }

      expect(snapshotOf(harness)).toBe(before);
      // NOT downgraded: the node is still in flight and the ordinary path works.
      const state = runtime.state();
      expect(state === undefined ? undefined : nodeOf(state, "work").status).toBe(
        "dispatched",
      );
      expect(
        runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
          NOW + 2,
        ).kind,
      ).toBe("accepted");
    });
  });

  it("refuses a completion fact for a plan that pins NO authorization at all", async () => {
    await withHarness(EXPLICIT_ONLY, async (harness) => {
      const { runtime, requests } = harness;
      runtime.start(NOW);
      expect(
        runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
          NOW + 1,
        ).kind,
      ).toBe("accepted");
      const before = snapshotOf(harness);

      const refused = runtime.settleNatural(
        // A perfectly valid credential — and still refused, because ship has no
        // pinned natural-completion mapping.
        { nodeId: "ship", attemptId: "ship#2", credential: credentialOf(requests, "ship#2") },
        NOW + 2,
      );
      expect(refused.kind).toBe("refused");
      if (refused.kind === "refused") {
        expect(refused.refusals.map((refusal) => refusal.code)).toEqual([
          "natural-completion-unauthorized",
        ]);
      }
      expect(snapshotOf(harness)).toBe(before);
      // The explicit path settles the same attempt exactly as before.
      expect(
        runtime.submit(
          { nodeId: "ship", outcomeId: "shipped", credential: credentialOf(requests, "ship#2") },
          NOW + 3,
        ).kind,
      ).toBe("accepted");
    });
  });

  it("does not settle when a declared acceptance gate fails, and leaves the attempt open", async () => {
    const declaration = gatedNaturalDeclaration();
    await withHarness(
      declaration,
      async (harness) => {
        const { runtime, ledger, requests, graphId } = harness;
        runtime.start(NOW);
        const stateBefore = JSON.stringify(ledger.readGraphState(graphId));
        const eventsBefore = JSON.stringify(ledger.acceptedEvents(graphId));

        const rejected = runtime.settleNatural(
          { nodeId: "work", attemptId: "work#1", credential: credentialOf(requests, "work#1") },
          NOW + 1,
        );
        expect(rejected.kind).toBe("rejected");
        if (rejected.kind !== "rejected") return;
        expect(rejected.decision.kind).toBe("rejected");
        // The DECLARED gate really ran, through the same registry.
        expect(rejected.decision.requirements).toMatchObject([
          {
            requirement: { id: GATE_ID, version: GATE_VERSION },
            outcome: { kind: "fail" },
          },
        ]);
        // Even a rejection is recorded under the natural namespace, and the
        // receipt is durable.
        expect(isNaturalCompletionSubmissionId(rejected.receipt.submissionId)).toBe(true);
        expect(rejected.receipt.decision).toBe("rejected");
        expect(
          ledger.lookupReceipt({
            graphId,
            attemptId: "work#1",
            submissionId: rejected.receipt.submissionId,
          }),
        ).toEqual(rejected.receipt);
        // NO settlement: no accepted event, no state advance, the node stays
        // dispatched and settleable.
        expect(JSON.stringify(ledger.acceptedEvents(graphId))).toBe(eventsBefore);
        expect(JSON.stringify(ledger.readGraphState(graphId))).toBe(stateBefore);
        const state = runtime.state();
        expect(state === undefined ? undefined : nodeOf(state, "work").status).toBe(
          "dispatched",
        );
      },
      {
        validators: gatedRegistry({ kind: "fail", reason: "the gate said no" }),
        supportedValidators: [{ validator: GATE_ID, version: GATE_VERSION }],
      },
    );
  });

  it("leaves a gate-rejected attempt open for the ordinary submission path", async () => {
    const declaration = gatedNaturalDeclaration();
    const dir = makeTmpDir("natural-settlement-open-");
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const declared = buildDeclaredOutcomeGraph({
        declaration,
        supportedValidators: [{ validator: GATE_ID, version: GATE_VERSION }],
        completionPolicies: ALL_AUTHORIZED,
      });
      const requests: OutcomeDispatchRequest[] = [];
      const build = (validators: ValidatorRegistry): OutcomeGraphRuntime =>
        new OutcomeGraphRuntime({
          plan: declared.plan,
          ledger,
          dispatch: (request) => {
            requests.push(request);
          },
          validators,
          artifactRoot: dir,
          credentialIsolation: testHostCredentialIsolation(dir),
          clock: () => NOW,
          mintCredential: TEST_CREDENTIAL_SOURCE,
          completionPolicies: ALL_AUTHORIZED,
        });
      const failing = build(gatedRegistry({ kind: "fail", reason: "the gate said no" }));
      expect(failing.start(NOW).kind).toBe("started");
      const rejected = failing.settleNatural(
        { nodeId: "work", attemptId: "work#1", credential: credentialOf(requests, "work#1") },
        NOW + 1,
      );
      expect(rejected.kind).toBe("rejected");

      // The SAME attempt, settled through the worker's own submission once the
      // gate passes: a rejected natural delivery never closes the attempt.
      const passing = build(gatedRegistry({ kind: "pass" }));
      const submitted = passing.submit(
        { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
        NOW + 2,
      );
      expect(submitted.kind).toBe("accepted");
      if (submitted.kind === "accepted") {
        expect(submitted.receipt.submissionId.startsWith("submission:")).toBe(true);
        expect(nodeOf(submitted.state, "work")).toMatchObject({
          status: "settled",
          outcomeId: "done",
        });
      }
      expect(ledger.acceptedEvents(declared.graphId)).toHaveLength(1);
    } finally {
      ledger.close();
    }
  });

  it("replays a repeated delivery without a second settlement", async () => {
    await withHarness(naturalDeclaration(), async (harness) => {
      const { runtime, ledger, requests, graphId } = harness;
      runtime.start(NOW);
      expect(
        runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
          NOW + 1,
        ).kind,
      ).toBe("accepted");
      const delivery = {
        nodeId: "ship",
        attemptId: "ship#2",
        credential: credentialOf(requests, "ship#2"),
      };

      const first = runtime.settleNatural(delivery, NOW + 2);
      expect(first.kind).toBe("accepted");
      if (first.kind !== "accepted") return;
      const eventsAfterFirst = ledger.acceptedEvents(graphId).length;
      const stateAfterFirst = JSON.stringify(harness.ledger.readGraphState(graphId));

      const replay = runtime.settleNatural(delivery, NOW + 3);
      expect(replay.kind).toBe("accepted");
      if (replay.kind !== "accepted") return;
      expect(replay.replayed).toBe(true);
      expect(replay.receipt).toEqual(first.receipt);
      expect(replay.decision.identity.submissionId).toBe(
        first.decision.identity.submissionId,
      );
      expect(replay.dispatched).toEqual([]);
      expect(ledger.acceptedEvents(graphId)).toHaveLength(eventsAfterFirst);
      expect(JSON.stringify(harness.ledger.readGraphState(graphId))).toBe(
        stateAfterFirst,
      );
      expect(replay.state.phase).toBe("complete");
    });
  });

  it("reports not-committed when a worker's own submission already settled the attempt", async () => {
    await withHarness(naturalDeclaration(), async (harness) => {
      const { runtime, ledger, requests, graphId } = harness;
      runtime.start(NOW);
      expect(
        runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
          NOW + 1,
        ).kind,
      ).toBe("accepted");
      // The worker claims the natural outcome explicitly, first.
      const explicit = runtime.submit(
        { nodeId: "ship", outcomeId: "shipped", credential: credentialOf(requests, "ship#2") },
        NOW + 2,
      );
      expect(explicit.kind).toBe("accepted");
      if (explicit.kind !== "accepted") return;
      expect(isNaturalCompletionSubmissionId(explicit.receipt.submissionId)).toBe(false);
      const stateAfterExplicit = JSON.stringify(harness.ledger.readGraphState(graphId));

      const late = runtime.settleNatural(
        { nodeId: "ship", attemptId: "ship#2", credential: credentialOf(requests, "ship#2") },
        NOW + 3,
      );
      expect(late.kind).toBe("not-committed");
      if (late.kind !== "not-committed") return;
      expect(late.verdict.kind).toBe("settled");
      // The delivery's provenance is still recorded on the answer it produced.
      expect(isNaturalCompletionSubmissionId(late.completion.submissionId)).toBe(true);
      expect(JSON.stringify(harness.ledger.readGraphState(graphId))).toBe(
        stateAfterExplicit,
      );
      expect(ledger.acceptedEvents(graphId)).toHaveLength(2);
    });
  });
});

// ── Replay answers ──────────────────────────────────────────────────────────

/**
 * One gated natural graph on its own ledger, with the runtime rebuilt per
 * validator registry. Rebuilding is how a case changes a gate's answer between
 * two deliveries of the SAME content — the only way to reach a replay whose
 * re-evaluation disagrees with the receipt the ledger already holds.
 */
async function withGatedLedger<T>(
  prefix: string,
  fn: (setup: {
    readonly declared: ReturnType<typeof buildDeclaredOutcomeGraph>;
    readonly ledger: SqliteAcceptanceLedger;
    readonly requests: OutcomeDispatchRequest[];
    build(validators: ValidatorRegistry): OutcomeGraphRuntime;
  }) => Promise<T> | T,
): Promise<T> {
  const dir = makeTmpDir(prefix);
  const ledger = await SqliteAcceptanceLedger.create(dir);
  try {
    const declared = buildDeclaredOutcomeGraph({
      declaration: gatedNaturalDeclaration(),
      supportedValidators: [{ validator: GATE_ID, version: GATE_VERSION }],
      completionPolicies: ALL_AUTHORIZED,
    });
    const requests: OutcomeDispatchRequest[] = [];
    const build = (validators: ValidatorRegistry): OutcomeGraphRuntime =>
      new OutcomeGraphRuntime({
        plan: declared.plan,
        ledger,
        dispatch: (request) => {
          requests.push(request);
        },
        validators,
        artifactRoot: dir,
        credentialIsolation: testHostCredentialIsolation(dir),
        clock: () => NOW,
        mintCredential: TEST_CREDENTIAL_SOURCE,
        completionPolicies: ALL_AUTHORIZED,
      });
    return await fn({ declared, ledger, requests, build });
  } finally {
    ledger.close();
  }
}

/**
 * The acceptance core promises that a repeated identical submission answers
 * with the SAME PERSISTED decision. A completion fact is re-validated outside
 * the transaction like any submission, so its gates get a second answer — and
 * that answer must never overturn the receipt: a persisted rejection cannot
 * become an acceptance (no event, no advance, and the content-addressed key can
 * never be re-decided) and a persisted acceptance cannot become a rejection.
 */
describe("settleNatural — a replay answers with the persisted decision", () => {
  it("keeps answering the persisted rejection when the gate passes only later", async () => {
    await withGatedLedger(
      "natural-replay-rejected-",
      async ({ declared, ledger, requests, build }) => {
        const delivery = () => ({
          nodeId: "work",
          attemptId: "work#1",
          credential: credentialOf(requests, "work#1"),
        });
        const failing = build(gatedRegistry({ kind: "fail", reason: "not yet" }));
        expect(failing.start(NOW).kind).toBe("started");
        const first = failing.settleNatural(delivery(), NOW + 1);
        expect(first.kind).toBe("rejected");
        if (first.kind !== "rejected") return;
        const stateAfterRejection = JSON.stringify(
          ledger.readGraphState(declared.graphId),
        );
        expect(ledger.acceptedEvents(declared.graphId)).toHaveLength(0);

        // The gate passes now, but the receipt already decided this
        // content-addressed key: the persisted rejection governs every repeat.
        const passing = build(gatedRegistry({ kind: "pass" }));
        const second = passing.settleNatural(delivery(), NOW + 2);
        expect(second.kind).toBe("rejected");
        if (second.kind !== "rejected") return;
        expect(second.decision.kind).toBe("rejected");
        expect(second.receipt).toEqual(first.receipt);
        expect(second.receipt.decision).toBe("rejected");
        // The gate DID answer pass this time; the requirements are this
        // delivery's re-evaluation evidence, and the receipt is the answer.
        expect(second.decision.requirements).toMatchObject([
          {
            requirement: { id: GATE_ID, version: GATE_VERSION },
            outcome: { kind: "pass" },
          },
        ]);

        const third = passing.settleNatural(delivery(), NOW + 3);
        expect(third.kind).toBe("rejected");
        expect(JSON.stringify(ledger.readGraphState(declared.graphId))).toBe(
          stateAfterRejection,
        );
        expect(ledger.acceptedEvents(declared.graphId)).toHaveLength(0);
        const state = passing.state();
        expect(state === undefined ? undefined : nodeOf(state, "work").status).toBe(
          "dispatched",
        );

        // A DIFFERENT logical submission (the worker's own claim) has its own
        // key, so the persisted rejection never wedges the attempt.
        expect(
          passing.submit(
            { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
            NOW + 4,
          ).kind,
        ).toBe("accepted");
      },
    );
  });

  it("keeps answering the persisted acceptance when the gate fails only later", async () => {
    await withGatedLedger(
      "natural-replay-accepted-",
      async ({ declared, ledger, requests, build }) => {
        const delivery = () => ({
          nodeId: "work",
          attemptId: "work#1",
          credential: credentialOf(requests, "work#1"),
        });
        const passing = build(gatedRegistry({ kind: "pass" }));
        expect(passing.start(NOW).kind).toBe("started");
        const first = passing.settleNatural(delivery(), NOW + 1);
        expect(first.kind).toBe("accepted");
        if (first.kind !== "accepted") return;
        const stateAfterSettlement = JSON.stringify(
          ledger.readGraphState(declared.graphId),
        );
        const eventsAfterSettlement = ledger.acceptedEvents(declared.graphId).length;

        const failing = build(gatedRegistry({ kind: "fail", reason: "flaked" }));
        const replay = failing.settleNatural(delivery(), NOW + 2);
        // The settlement HAPPENED; a later failing evaluation does not undo it.
        expect(replay.kind).toBe("accepted");
        if (replay.kind !== "accepted") return;
        expect(replay.replayed).toBe(true);
        expect(replay.decision.kind).toBe("accepted");
        expect(replay.receipt).toEqual(first.receipt);
        expect(replay.receipt.decision).toBe("accepted");
        expect(replay.dispatched).toEqual([]);
        // The state is the persisted one — never an advance the replay's join
        // computed and the transaction did not write.
        const persisted = failing.state();
        if (persisted === undefined) {
          throw new Error("fixture: the settlement wrote no state");
        }
        expect(replay.state).toEqual(persisted);
        expect(nodeOf(replay.state, "work")).toMatchObject({
          status: "settled",
          outcomeId: "done",
        });
        expect(JSON.stringify(ledger.readGraphState(declared.graphId))).toBe(
          stateAfterSettlement,
        );
        expect(ledger.acceptedEvents(declared.graphId)).toHaveLength(
          eventsAfterSettlement,
        );
      },
    );
  });
});

// ── No data channel ─────────────────────────────────────────────────────────

describe("settleNatural — the completion envelope carries no result channel", () => {
  it("refuses an outcome, a payload or evidence offered alongside the completion fact", async () => {
    await withHarness(twoOutcomeNaturalDeclaration(), async (harness) => {
      const { runtime, requests } = harness;
      runtime.start(NOW);
      expect(
        runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
          NOW + 1,
        ).kind,
      ).toBe("accepted");
      const before = snapshotOf(harness);

      const refused = runtime.settleNatural(
        {
          nodeId: "ship",
          attemptId: "ship#2",
          credential: credentialOf(requests, "ship#2"),
          // Every one of these is an attempt to route a result through the
          // completion fact, and every one is refused BY NAME.
          outcomeId: "cancelled",
          data: { shipped: true },
          evidenceRefs: ["artifact.txt"],
        },
        NOW + 2,
      );
      expect(refused.kind).toBe("refused");
      if (refused.kind === "refused") {
        expect(refused.refusals.map((refusal) => refusal.code)).toEqual([
          "malformed-natural-delivery",
          "malformed-natural-delivery",
          "malformed-natural-delivery",
        ]);
        expect(refused.refusals.map((refusal) => refusal.path)).toEqual([
          "$.outcomeId",
          "$.data",
          "$.evidenceRefs",
        ]);
      }
      expect(snapshotOf(harness)).toBe(before);
    });
  });

  it("maps the attempt to the AUTHORIZED outcome even when the node declares another", async () => {
    await withHarness(twoOutcomeNaturalDeclaration(), ({ runtime, requests }) => {
      runtime.start(NOW);
      expect(
        runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
          NOW + 1,
        ).kind,
      ).toBe("accepted");

      const settled = runtime.settleNatural(
        { nodeId: "ship", attemptId: "ship#2", credential: credentialOf(requests, "ship#2") },
        NOW + 2,
      );
      expect(settled.kind).toBe("accepted");
      if (settled.kind !== "accepted") return;
      // The plan's authorization names "shipped"; the delivery had no way to
      // name "cancelled" and the settlement could not have picked it.
      expect(settled.completion.outcomeId).toBe("shipped");
      expect(nodeOf(settled.state, "ship").outcomeId).toBe("shipped");
    });
  });
});

// ── Loops and stops ─────────────────────────────────────────────────────────

describe("settleNatural — loops and stops reuse the one reducer", () => {
  it("advances the declared loop counter and stops on the hard cap", async () => {
    await withHarness(
      naturalLoopDeclaration(1),
      ({ runtime, requests }) => {
        const started = runtime.start(NOW);
        expect(started.kind).toBe("started");
        expect(
          runtime.submit(
            { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
            NOW + 1,
          ).kind,
        ).toBe("accepted");

        const first = runtime.settleNatural(
          { nodeId: "review", attemptId: "review#2", credential: credentialOf(requests, "review#2") },
          NOW + 2,
        );
        expect(first.kind).toBe("accepted");
        if (first.kind !== "accepted") return;
        expect(first.completion.outcomeId).toBe("revise");
        // The SAME counter a submission advances.
        expect(first.state.loopTraversals["revise-loop"]).toBe(1);
        expect(first.state.phase).toBe("executing");
        expect(first.dispatched.map((request) => request.attemptId)).toEqual(["work#3"]);

        expect(
          runtime.submit(
            { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#3") },
            NOW + 3,
          ).kind,
        ).toBe("accepted");

        const capped = runtime.settleNatural(
          { nodeId: "review", attemptId: "review#4", credential: credentialOf(requests, "review#4") },
          NOW + 4,
        );
        expect(capped.kind).toBe("accepted");
        if (capped.kind !== "accepted") return;
        // The SAME durable stop: the outcome is accepted, the round is not
        // taken, no successor is armed, and the reason is the declared cap.
        expect(capped.stop?.reason).toBe("loop-exhausted");
        expect(capped.state.phase).toBe("stopped");
        expect(capped.state.loopTraversals["revise-loop"]).toBe(1);
        expect(capped.dispatched).toEqual([]);
        expect(nodeOf(capped.state, "review")).toMatchObject({
          status: "settled",
          outcomeId: "revise",
        });
      },
    );
  });

  it("refuses a progress-governed continuation exactly as a payload-less submission is", async () => {
    await withHarness(
      naturalProgressLoopDeclaration(),
      (harness) => {
        const { runtime, requests } = harness;
        runtime.start(NOW);
        expect(
          runtime.submit(
            { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
            NOW + 1,
          ).kind,
        ).toBe("accepted");
        const before = snapshotOf(harness);

        const refused = runtime.settleNatural(
          { nodeId: "review", attemptId: "review#2", credential: credentialOf(requests, "review#2") },
          NOW + 2,
        );
        expect(refused.kind).toBe("refused");
        if (refused.kind === "refused") {
          // A declared comparison is NEVER skipped, so the payload-free fact is
          // refused for repair exactly like a submission without the subject.
          expect(refused.refusals.map((refusal) => refusal.code)).toEqual([
            "progress-subject-missing",
          ]);
          expect(refused.refusals[0]?.path).toBe("$.data.revision");
        }
        expect(snapshotOf(harness)).toBe(before);
        // Nothing advanced: no traversal, no successor, no accepted event.
        const state = runtime.state();
        expect(state === undefined ? undefined : state.loopTraversals["revise-loop"]).toBe(
          undefined,
        );
        expect(harness.ledger.acceptedEvents(harness.graphId)).toHaveLength(1);
      },
    );
  });
});

// ── Enablement conditions ───────────────────────────────────────────────────

describe("settleNatural — the run path's enablement conditions still apply", () => {
  it("refuses without the completion-policy capability and writes nothing", async () => {
    await withHarness(
      naturalDeclaration(),
      async (harness) => {
        const { runtime } = harness;
        const before = snapshotOf(harness);
        const refused = runtime.settleNatural(
          { nodeId: "ship", attemptId: "ship#1", credential: "any" },
          NOW,
        );
        expect(refused.kind).toBe("refused");
        if (refused.kind === "refused") {
          expect(refused.refusals.map((refusal) => refusal.code)).toEqual([
            "completion-policy-unavailable",
          ]);
        }
        expect(snapshotOf(harness)).toBe(before);
      },
      { runtimePolicies: false },
    );
  });

  it("refuses without a credential-isolation capability and writes nothing", async () => {
    await withHarness(
      naturalDeclaration(),
      async (harness) => {
        const { runtime } = harness;
        const before = snapshotOf(harness);
        const refused = runtime.settleNatural(
          { nodeId: "ship", attemptId: "ship#1", credential: "any" },
          NOW,
        );
        expect(refused.kind).toBe("refused");
        if (refused.kind === "refused") {
          expect(refused.refusals.map((refusal) => refusal.code)).toEqual([
            "credential-isolation-unavailable",
          ]);
        }
        expect(snapshotOf(harness)).toBe(before);
      },
      { credentialIsolation: false },
    );
  });
});
