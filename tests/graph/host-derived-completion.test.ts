/**
 * Host-derived completion settlement (defect 2).
 *
 * Covers the channel that settles an attempt from the outcome the WORKER'S OWN
 * LAST TURN declared, after the execution ended without presenting an outcome.
 * The fact is credential-free by construction and host-authenticated by the
 * host's own durable execution record; the PLAN still decides whether the named
 * outcome exists and whether it passes its declared gates. The cases below are
 * the rules the channel exists to enforce:
 *
 * 1. a declared outcome settles through the ONE acceptance transaction and the
 *    receipt persists a `host-derived:<digest>` submission id (read back through
 *    a SECOND connection), while the state advances through the ordinary
 *    reducer;
 * 2. the envelope is CLOSED — a `credential` (or any other unknown key) offered
 *    alongside the declaration is refused BY NAME before anything is read, and
 *    the module's own reader is total;
 * 3. the host must SUBSTANTIATE the fact: no authority, no confirmed execution,
 *    a throwing authority and a foreign execution id are all refused
 *    `host-completion-unauthenticated` (or `host-completion-unavailable`) with
 *    nothing written and no re-binding;
 * 4. the plan still decides: an outcome the node does not declare is refused
 *    (`undeclared-outcome`), a declared gate that fails REJECTS and leaves the
 *    attempt open for the worker's own submission, and a node whose plan pinned
 *    a NATURAL completion is refused `derived-completion-natural-node`;
 * 5. a repeated delivery REPLAYS the persisted receipt: one settlement, one
 *    accepted event, no second state advance and no second dispatch;
 * 6. the crossing invariants hold for this channel too — a STOPPED attempt and a
 *    retry-SUPERSEDED attempt accept nothing here either.
 *
 * Every case runs in its own mkdtemp directory and removes it in a finally block
 * (plus an afterEach sweep); nothing here writes outside a temp dir. No tool
 * binds `settleHostDerivedCompletion`: this file drives the host-facing method
 * directly, exactly as the host's derived-completion bridge does.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase, type DatabaseDriver } from "../../src/memory/db-driver.ts";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import {
  completionPolicyRefOf,
  createCompletionPolicyRegistry,
  type CompletionPolicyBody,
  type CompletionPolicyRegistry,
} from "../../src/graph/policy/completion-policy.ts";
import {
  SqliteAcceptanceLedger,
  ledgerFilePath,
} from "../../src/graph/ledger/sqlite-ledger.ts";
import {
  OutcomeGraphRuntime,
  type HostCompletionAuthority,
  type HostCompletionExecution,
  type OutcomeDispatchRequest,
} from "../../src/graph/outcome/runtime.ts";
import {
  HOST_DERIVED_SOURCE,
  hostDerivedProposalOf,
  hostDerivedSettlementOf,
  hostDerivedSubmissionId,
  isHostDerivedSubmissionId,
  readHostDerivedCompletionFact,
} from "../../src/graph/outcome/host-derived.ts";
import type { OutcomeGraphState } from "../../src/graph/outcome/graph-state.ts";
import type { AttemptCredentialSource } from "../../src/graph/outcome/attempt-credential.ts";
import {
  createValidatorRegistry,
  type ValidatorRegistry,
} from "../../src/graph/outcome/validators.ts";
import { buildDeclaredOutcomeGraph } from "../../src/graph/tools/declare-graph.ts";
import { GRAPH_STORE_TABLES } from "../../src/graph/store/schema.ts";
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const EMPTY_VALIDATORS: ValidatorRegistry = createValidatorRegistry([]);
const POLICY_PREFIX = "test.host-derived.";
const POLICY_REVISION = "1";

const EXPLICIT_GRAPH = "host-derived.explicit";
const GATED_GRAPH = "host-derived.gated";
const NATURAL_GRAPH = "host-derived.natural";

const WORK = "work";
const SHIP = "ship";

const GATE_ID = "gate.host-derived.payload";
const GATE_VERSION = 1;

/** The execution the host recorded for one attempt in the fixtures below. */
const WORK_EXECUTION = "execution.work.1";

/**
 * work --done--> ship, with no completion policy anywhere: the plain node whose
 * outcome the attempt itself declares.
 */
function explicitDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: EXPLICIT_GRAPH,
    nodes: [
      {
        id: WORK,
        agent: "agent.work",
        prompt: "Do the work.",
        outcomes: [{ id: "done" }],
      },
      {
        id: SHIP,
        agent: "agent.ship",
        prompt: "Ship it.",
        outcomes: [{ id: "shipped" }],
      },
    ],
    edges: [{ from: WORK, to: SHIP, outcome: "done" }],
  };
}

/** The same graph, with `work`'s `done` behind a DECLARED acceptance gate. */
function gatedDeclaration(): GraphDeclarationV3 {
  const base = explicitDeclaration();
  return {
    ...base,
    name: GATED_GRAPH,
    nodes: base.nodes.map((node) =>
      node.id === WORK
        ? {
            ...node,
            outcomes: [
              {
                id: "done",
                acceptance: [{ validator: GATE_ID, version: GATE_VERSION }],
              },
            ],
          }
        : node,
    ),
  };
}

/**
 * ONE node whose plan PINNED a natural completion: there is exactly one
 * authorized outcome for it, which is why this channel must refuse it.
 */
function naturalDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: NATURAL_GRAPH,
    nodes: [
      {
        id: WORK,
        agent: "agent.work",
        prompt: "Do the work.",
        outcomes: [{ id: "done" }],
        completion: { mode: "natural", outcome: "done" },
      },
    ],
    edges: [],
    completion_policy: {
      id: POLICY_PREFIX + NATURAL_GRAPH,
      revision: POLICY_REVISION,
    },
  };
}

/** The one rule granting `work -> done` in {@link NATURAL_GRAPH}. */
const NATURAL_GRANT: CompletionPolicyBody = {
  version: 1,
  default: "ungranted",
  rules: [
    { graphId: NATURAL_GRAPH, nodeId: WORK, outcome: "done", decision: "allow" },
  ],
};

/**
 * The installed completion-policy capability. The other fixtures pin no policy,
 * so installing one is neutral for them — it exists to let the NATURAL fixture
 * compile into an executable plan at all.
 */
const POLICY_REGISTRY: CompletionPolicyRegistry = createCompletionPolicyRegistry({
  policies: [
    {
      ref: completionPolicyRefOf({
        id: POLICY_PREFIX + NATURAL_GRAPH,
        revision: POLICY_REVISION,
        body: NATURAL_GRANT,
      }),
      body: NATURAL_GRANT,
    },
  ],
});

/** A gate that reads the DECLARATION's own payload: pass only on `verdict: pass`. */
function payloadGate(): ValidatorRegistry {
  return createValidatorRegistry([
    {
      id: GATE_ID,
      version: GATE_VERSION,
      implementation: (request) => {
        if (verdictOf(request.proposal.data) === "pass") return { kind: "pass" };
        return {
          kind: "fail",
          reason: "the worker's last turn did not report a passing verdict",
        };
      },
    },
  ]);
}

/** The `verdict` field of a payload, when there is one. */
function verdictOf(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  const verdict = (data as { readonly verdict?: unknown }).verdict;
  return typeof verdict === "string" ? verdict : undefined;
}

// ── Harness ─────────────────────────────────────────────────────────────────

interface Harness {
  readonly runtime: OutcomeGraphRuntime;
  readonly ledger: SqliteAcceptanceLedger;
  /** Every request the scripted dispatch seam received, in order. */
  readonly requests: OutcomeDispatchRequest[];
  readonly graphId: string;
  readonly dir: string;
  /** The host's OWN durable record of the executions it created. */
  readonly executions: Map<string, HostCompletionExecution>;
  /** When flipped, the authority THROWS instead of answering. */
  readonly authorityFault: { thrown: boolean };
  credentialOf(attemptId: string): string;
}

/** One credential per attempt, derived from the binding the runtime hands it. */
const TEST_CREDENTIAL_SOURCE: AttemptCredentialSource = (binding) =>
  "test-credential:" + binding.nodeId + "#" + binding.attemptId;

interface HarnessOptions {
  readonly validators?: ValidatorRegistry;
  readonly supportedValidators?: readonly {
    readonly validator: string;
    readonly version?: number;
  }[];
  /** `false` runs WITHOUT a host-completion authority at all. */
  readonly hostCompletions?: boolean;
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
  const dir = makeTmpDir("host-derived-");
  const ledger = await SqliteAcceptanceLedger.create(dir);
  try {
    const declared = buildDeclaredOutcomeGraph({
      declaration,
      ...(options.supportedValidators === undefined
        ? {}
        : { supportedValidators: [...options.supportedValidators] }),
      completionPolicies: POLICY_REGISTRY,
    });
    const requests: OutcomeDispatchRequest[] = [];
    const executions = new Map<string, HostCompletionExecution>();
    const authorityFault = { thrown: false };
    const authority: HostCompletionAuthority = {
      executionFor: (attempt) => {
        if (authorityFault.thrown) {
          throw new Error("the host's execution record is unreadable");
        }
        return executions.get(attempt.attemptId);
      },
    };
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
      credentialIsolation: testHostCredentialIsolation(dir),
      completionPolicies: POLICY_REGISTRY,
      ...(options.hostCompletions === false ? {} : { hostCompletions: authority }),
    });
    return await fn({
      runtime,
      ledger,
      requests,
      graphId: declared.graphId,
      dir,
      executions,
      authorityFault,
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

/** One node's state, failing the test when the node is missing. */
function nodeOf(state: OutcomeGraphState, nodeId: string) {
  const found = state.nodes.find((node) => node.nodeId === nodeId);
  if (found === undefined) throw new Error("no state for node " + nodeId);
  return found;
}

/**
 * Everything a refusal must leave untouched: the state row, the accepted-event
 * stream and the unsettled effects. Receipts are read separately (below),
 * because a rejection legitimately writes one.
 */
function snapshotOf(harness: Harness): string {
  return JSON.stringify({
    state: harness.ledger.readGraphState(harness.graphId),
    events: harness.ledger.acceptedEvents(harness.graphId),
    effects: harness.ledger.pendingEffects(harness.graphId),
  });
}

/**
 * One attempt's PERSISTED receipt ids, read through a second connection: the
 * store, not this process's memory, is the authority on what was written.
 */
async function persistedReceiptIds(
  dir: string,
  graphId: string,
  attemptId: string,
): Promise<readonly string[]> {
  const db: DatabaseDriver = await createDatabase(ledgerFilePath(dir));
  try {
    return db
      .query(
        "SELECT submission_id FROM " +
          GRAPH_STORE_TABLES.receipts +
          " WHERE graph_id = ? AND attempt_id = ? ORDER BY submission_id",
      )
      .all(graphId, attemptId)
      .map((row) => {
        if (typeof row === "object" && row !== null && "submission_id" in row) {
          const value = (row as { readonly submission_id: unknown }).submission_id;
          if (typeof value === "string") return value;
        }
        throw new Error("receipt row did not answer a submission id");
      });
  } finally {
    db.close();
  }
}

/** The fact one attempt's host delivers, with the fixture's execution id. */
function factOf(
  executions: Map<string, HostCompletionExecution>,
  attemptId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    nodeId: WORK,
    attemptId,
    executionId: executions.get(attemptId)?.executionId ?? WORK_EXECUTION,
    outcomeId: "done",
    ...overrides,
  };
}

// ── The module's own guarantees ─────────────────────────────────────────────

describe("host-derived envelope and provenance (the module's own guarantees)", () => {
  it("is TOTAL and CLOSED: an unknown key — a credential above all — is refused by name", () => {
    const base = {
      nodeId: WORK,
      attemptId: "work#1",
      executionId: WORK_EXECUTION,
      outcomeId: "done",
    };
    // TOTAL: no input shape escapes as a throw.
    expect(readHostDerivedCompletionFact(null).kind).toBe("malformed");
    expect(readHostDerivedCompletionFact([]).kind).toBe("malformed");
    expect(readHostDerivedCompletionFact("done").kind).toBe("malformed");
    const hostile = {};
    Object.defineProperty(hostile, "nodeId", {
      enumerable: true,
      get() {
        throw new Error("hostile accessor");
      },
    });
    expect(readHostDerivedCompletionFact(hostile).kind).toBe("malformed");

    // CLOSED: a credential is refused BY NAME, never dropped.
    const withCredential = readHostDerivedCompletionFact({
      ...base,
      credential: "bearer-value",
    });
    expect(withCredential.kind).toBe("malformed");
    if (withCredential.kind !== "malformed") return;
    expect(withCredential.issues.map((issue) => issue.path)).toEqual([
      "$.credential",
    ]);
    expect(withCredential.issues[0]?.code).toBe(
      "malformed-host-derived-completion",
    );
    expect(withCredential.issues[0]?.message).toContain("credential");

    // The field rules, one violation per case.
    const issuePaths = (value: unknown): readonly string[] => {
      const reading = readHostDerivedCompletionFact(value);
      return reading.kind === "malformed"
        ? reading.issues.map((issue) => issue.path)
        : [];
    };
    expect(issuePaths({ ...base, nodeId: "" })).toEqual(["$.nodeId"]);
    expect(issuePaths({ ...base, outcomeId: 7 })).toEqual(["$.outcomeId"]);
    expect(issuePaths({ ...base, evidenceRefs: ["ok", ""] })).toEqual([
      "$.evidenceRefs[1]",
    ]);
    expect(issuePaths({ ...base, derivation: { eventIndex: -1, turnIndex: 0 } })).toEqual([
      "$.derivation.eventIndex",
    ]);
    expect(issuePaths({ ...base, derivation: { eventIndex: 1 } })).toEqual([
      "$.derivation.turnIndex",
    ]);
    expect(
      issuePaths({ ...base, derivation: { eventIndex: 1, turnIndex: 0, extra: 2 } }),
    ).toEqual(["$.derivation.extra"]);
    // `data` is deliberately unconstrained — representability is the digest's
    // question, so this shape gate never judges it.
    expect(readHostDerivedCompletionFact({ ...base, data: { deep: [1, 2, 3] } }).kind).toBe(
      "ok",
    );
  });

  it("builds a credential-free proposal and derives the key from the digest", () => {
    const reading = readHostDerivedCompletionFact({
      nodeId: WORK,
      attemptId: "work#1",
      executionId: WORK_EXECUTION,
      outcomeId: "done",
      data: { summary: "the last turn declared done" },
      evidenceRefs: ["evidence/last-turn.json"],
      derivation: { eventIndex: 4, turnIndex: 0 },
    });
    expect(reading.kind).toBe("ok");
    if (reading.kind !== "ok") return;
    const proposal = hostDerivedProposalOf(reading.fact);
    expect(Object.keys(proposal).sort()).toEqual([
      "data",
      "evidenceRefs",
      "nodeId",
      "outcomeId",
    ]);
    expect("credential" in proposal).toBe(false);

    const settlement = hostDerivedSettlementOf({
      nodeId: reading.fact.nodeId,
      attemptId: reading.fact.attemptId,
      outcomeId: reading.fact.outcomeId,
      proposalDigest: "digest",
      derivation: reading.fact.derivation,
    });
    expect(settlement.source).toBe(HOST_DERIVED_SOURCE);
    expect(settlement.submissionId).toBe(hostDerivedSubmissionId("digest"));
    expect(settlement.submissionId).toBe("host-derived:digest");
    expect(isHostDerivedSubmissionId(settlement.submissionId)).toBe(true);
    // The read-back half never claims a bare or another channel's key.
    expect(isHostDerivedSubmissionId("host-derived:")).toBe(false);
    expect(isHostDerivedSubmissionId("submission:digest")).toBe(false);
    expect(isHostDerivedSubmissionId("natural-completion:digest")).toBe(false);
    expect(isHostDerivedSubmissionId(undefined)).toBe(false);
  });
});

// ── The settlement path ─────────────────────────────────────────────────────

describe("settleHostDerivedCompletion — the worker's own last turn, settled credential-free", () => {
  it("settles a declared outcome, records the host-derived source, and persists the key", async () => {
    await withHarness(explicitDeclaration(), async (harness) => {
      const { runtime, ledger, requests, graphId, executions, dir } = harness;
      expect(runtime.start(NOW).kind).toBe("started");
      expect(requests.map((request) => request.attemptId)).toEqual(["work#1"]);
      executions.set("work#1", { executionId: WORK_EXECUTION });

      const settled = runtime.settleHostDerivedCompletion(
        {
          nodeId: WORK,
          attemptId: "work#1",
          executionId: WORK_EXECUTION,
          outcomeId: "done",
          data: { summary: "the last turn declared done" },
          evidenceRefs: ["evidence/last-turn.json"],
          derivation: { eventIndex: 4, turnIndex: 0 },
        },
        NOW + 1,
      );
      expect(settled.kind).toBe("accepted");
      if (settled.kind !== "accepted") return;

      // The provenance record IS the persisted key: derived from the canonical
      // digest the decision was addressed by, in this channel's own namespace.
      expect(settled.completion.source).toBe(HOST_DERIVED_SOURCE);
      expect(settled.completion.submissionId).toBe(
        hostDerivedSubmissionId(settled.receipt.proposalDigest),
      );
      expect(settled.completion.submissionId).toBe(
        settled.decision.identity.submissionId,
      );
      expect(settled.completion.submissionId.startsWith("host-derived:")).toBe(true);
      expect(isHostDerivedSubmissionId(settled.completion.submissionId)).toBe(true);
      expect(settled.completion.nodeId).toBe(WORK);
      expect(settled.completion.attemptId).toBe("work#1");
      expect(settled.completion.outcomeId).toBe("done");
      expect(settled.completion.derivation).toEqual({ eventIndex: 4, turnIndex: 0 });

      // The receipt row carries it, and answers by it.
      expect(settled.receipt.submissionId).toBe(settled.completion.submissionId);
      expect(settled.receipt.decision).toBe("accepted");
      expect(
        ledger.lookupReceipt({
          graphId,
          attemptId: "work#1",
          submissionId: settled.completion.submissionId,
        }),
      ).toEqual(settled.receipt);
      expect(ledger.acceptedEvents(graphId).map((event) => event.submissionId)).toEqual([
        settled.completion.submissionId,
      ]);
      // ... and it is really IN THE STORE, read back over a second connection.
      expect(await persistedReceiptIds(dir, graphId, "work#1")).toEqual([
        settled.completion.submissionId,
      ]);

      // The settlement advanced the graph through the ordinary reducer: work is
      // settled on the declared outcome and its successor is armed.
      expect(nodeOf(settled.state, WORK)).toMatchObject({
        status: "settled",
        outcomeId: "done",
      });
      expect(requests.map((request) => request.attemptId)).toEqual([
        "work#1",
        "ship#2",
      ]);
    });
  });

  it("replays a repeated delivery without a second settlement", async () => {
    await withHarness(explicitDeclaration(), async (harness) => {
      const { runtime, ledger, requests, graphId, executions } = harness;
      runtime.start(NOW);
      executions.set("work#1", { executionId: WORK_EXECUTION });
      const fact = factOf(executions, "work#1", {
        data: { summary: "the last turn declared done" },
      });

      const first = runtime.settleHostDerivedCompletion(fact, NOW + 1);
      expect(first.kind).toBe("accepted");
      if (first.kind !== "accepted") return;
      const eventsAfterFirst = ledger.acceptedEvents(graphId).length;
      const stateAfterFirst = JSON.stringify(ledger.readGraphState(graphId));
      const dispatchedAfterFirst = requests.length;

      const replay = runtime.settleHostDerivedCompletion({ ...fact }, NOW + 2);
      expect(replay.kind).toBe("accepted");
      if (replay.kind !== "accepted") return;
      expect(replay.replayed).toBe(true);
      expect(replay.receipt).toEqual(first.receipt);
      expect(replay.completion).toEqual(first.completion);
      expect(replay.decision.identity.submissionId).toBe(
        first.decision.identity.submissionId,
      );
      expect(replay.dispatched).toEqual([]);
      expect(ledger.acceptedEvents(graphId)).toHaveLength(eventsAfterFirst);
      expect(JSON.stringify(ledger.readGraphState(graphId))).toBe(stateAfterFirst);
      expect(requests.length).toBe(dispatchedAfterFirst);
    });
  });
});

// ── The closed envelope ─────────────────────────────────────────────────────

describe("settleHostDerivedCompletion — the envelope is closed", () => {
  it("refuses a credential offered alongside the declaration and writes nothing", async () => {
    await withHarness(explicitDeclaration(), async (harness) => {
      const { runtime, requests, graphId, executions, dir } = harness;
      runtime.start(NOW);
      executions.set("work#1", { executionId: WORK_EXECUTION });
      const before = snapshotOf(harness);

      const refusedResult = runtime.settleHostDerivedCompletion(
        {
          nodeId: WORK,
          attemptId: "work#1",
          executionId: WORK_EXECUTION,
          outcomeId: "done",
          credential: credentialOf(requests, "work#1"),
        },
        NOW + 1,
      );
      expect(refusedResult.kind).toBe("refused");
      if (refusedResult.kind !== "refused") return;
      expect(refusedResult.refusals.map((refusal) => refusal.code)).toEqual([
        "malformed-host-derived-completion",
      ]);
      expect(refusedResult.refusals[0]?.path).toBe("$.credential");
      expect(refusedResult.refusals[0]?.message).toContain("credential");
      expect(snapshotOf(harness)).toBe(before);
      expect(await persistedReceiptIds(dir, graphId, "work#1")).toEqual([]);
      const state = runtime.state();
      expect(state === undefined ? undefined : nodeOf(state, WORK).status).toBe(
        "dispatched",
      );
    });
  });
});

// ── The host's own fact ─────────────────────────────────────────────────────

describe("settleHostDerivedCompletion — the host must substantiate the fact", () => {
  it("refuses without a host-completion authority and writes nothing", async () => {
    await withHarness(
      explicitDeclaration(),
      async (harness) => {
        const { runtime, graphId, executions, dir } = harness;
        runtime.start(NOW);
        executions.set("work#1", { executionId: WORK_EXECUTION });
        const before = snapshotOf(harness);

        const refusedResult = runtime.settleHostDerivedCompletion(
          factOf(executions, "work#1"),
          NOW + 1,
        );
        expect(refusedResult.kind).toBe("refused");
        if (refusedResult.kind !== "refused") return;
        expect(refusedResult.refusals.map((refusal) => refusal.code)).toEqual([
          "host-completion-unavailable",
        ]);
        expect(snapshotOf(harness)).toBe(before);
        expect(await persistedReceiptIds(dir, graphId, "work#1")).toEqual([]);
      },
      { hostCompletions: false },
    );
  });

  it("refuses an execution the host does not corroborate and never re-binds it", async () => {
    await withHarness(explicitDeclaration(), async (harness) => {
      const { runtime, graphId, executions } = harness;
      runtime.start(NOW);
      const before = snapshotOf(harness);

      // (a) the host holds NO confirmed execution for the attempt.
      const unknown = runtime.settleHostDerivedCompletion(
        {
          nodeId: WORK,
          attemptId: "work#1",
          executionId: WORK_EXECUTION,
          outcomeId: "done",
        },
        NOW + 1,
      );
      expect(unknown.kind).toBe("refused");
      if (unknown.kind !== "refused") return;
      expect(unknown.refusals.map((refusal) => refusal.code)).toEqual([
        "host-completion-unauthenticated",
      ]);

      // (b) the host names a DIFFERENT execution than the delivery reports.
      executions.set("work#1", { executionId: "execution.other" });
      const foreign = runtime.settleHostDerivedCompletion(
        factOf(executions, "work#1", { executionId: WORK_EXECUTION }),
        NOW + 2,
      );
      expect(foreign.kind).toBe("refused");
      if (foreign.kind !== "refused") return;
      expect(foreign.refusals.map((refusal) => refusal.code)).toEqual([
        "host-completion-unauthenticated",
      ]);
      expect(foreign.refusals[0]?.message).toContain("never re-bound");

      // (c) the authority THROWS: an unanswered question is not a fact.
      harness.authorityFault.thrown = true;
      const thrown = runtime.settleHostDerivedCompletion(
        factOf(executions, "work#1", { executionId: "execution.other" }),
        NOW + 3,
      );
      expect(thrown.kind).toBe("refused");
      if (thrown.kind !== "refused") return;
      expect(thrown.refusals.map((refusal) => refusal.code)).toEqual([
        "host-completion-unauthenticated",
      ]);

      // Every refusal left the durable facts exactly as they were.
      expect(snapshotOf(harness)).toBe(before);
      expect(graphId).toBe(EXPLICIT_GRAPH);
    });
  });
});

// ── The plan still decides ──────────────────────────────────────────────────

describe("settleHostDerivedCompletion — the plan still decides", () => {
  it("refuses an outcome the node does not declare, with nothing written", async () => {
    await withHarness(explicitDeclaration(), async (harness) => {
      const { runtime, graphId, executions, dir } = harness;
      runtime.start(NOW);
      executions.set("work#1", { executionId: WORK_EXECUTION });
      const before = snapshotOf(harness);

      const refusedResult = runtime.settleHostDerivedCompletion(
        factOf(executions, "work#1", { outcomeId: "shipped" }),
        NOW + 1,
      );
      expect(refusedResult.kind).toBe("refused");
      if (refusedResult.kind !== "refused") return;
      expect(refusedResult.refusals.map((refusal) => refusal.code)).toEqual([
        "undeclared-outcome",
      ]);
      expect(snapshotOf(harness)).toBe(before);
      expect(await persistedReceiptIds(dir, graphId, "work#1")).toEqual([]);
    });
  });

  it("REJECTS a declaration that fails a declared gate and leaves the attempt open", async () => {
    await withHarness(
      gatedDeclaration(),
      async (harness) => {
        const { runtime, ledger, requests, graphId, executions, dir } = harness;
        runtime.start(NOW);
        executions.set("work#1", { executionId: WORK_EXECUTION });
        const before = snapshotOf(harness);

        const rejected = runtime.settleHostDerivedCompletion(
          factOf(executions, "work#1", { data: { verdict: "fail" } }),
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
        // Even a rejection is recorded under the host-derived namespace, durably.
        expect(isHostDerivedSubmissionId(rejected.receipt.submissionId)).toBe(true);
        expect(rejected.receipt.decision).toBe("rejected");
        expect(
          ledger.lookupReceipt({
            graphId,
            attemptId: "work#1",
            submissionId: rejected.receipt.submissionId,
          }),
        ).toEqual(rejected.receipt);
        // NO settlement: no accepted event, no state advance, no new effect.
        expect(snapshotOf(harness)).toBe(before);
        expect(await persistedReceiptIds(dir, graphId, "work#1")).toEqual([
          rejected.receipt.submissionId,
        ]);
        const state = runtime.state();
        expect(state === undefined ? undefined : nodeOf(state, WORK).status).toBe(
          "dispatched",
        );

        // The attempt is OPEN: the worker's own declared outcome still settles it.
        const submitted = runtime.submit(
          {
            nodeId: WORK,
            outcomeId: "done",
            credential: credentialOf(requests, "work#1"),
            data: { verdict: "pass" },
          },
          NOW + 2,
        );
        expect(submitted.kind).toBe("accepted");
        if (submitted.kind === "accepted") {
          expect(submitted.receipt.submissionId.startsWith("submission:")).toBe(true);
          expect(nodeOf(submitted.state, WORK)).toMatchObject({
            status: "settled",
            outcomeId: "done",
          });
        }
        expect(ledger.acceptedEvents(graphId)).toHaveLength(1);
      },
      {
        validators: payloadGate(),
        supportedValidators: [{ validator: GATE_ID, version: GATE_VERSION }],
      },
    );
  });

  it("refuses a NATURAL-completion node by name, before anything is written", async () => {
    await withHarness(naturalDeclaration(), async (harness) => {
      const { runtime, graphId, executions, dir } = harness;
      expect(runtime.start(NOW).kind).toBe("started");
      executions.set("work#1", { executionId: WORK_EXECUTION });
      const before = snapshotOf(harness);

      const refusedResult = runtime.settleHostDerivedCompletion(
        factOf(executions, "work#1"),
        NOW + 1,
      );
      expect(refusedResult.kind).toBe("refused");
      if (refusedResult.kind !== "refused") return;
      expect(refusedResult.refusals.map((refusal) => refusal.code)).toEqual([
        "derived-completion-natural-node",
      ]);
      expect(refusedResult.refusals[0]?.path).toBe("$.nodeId");
      expect(refusedResult.refusals[0]?.message).toContain("NATURAL completion");
      expect(snapshotOf(harness)).toBe(before);
      expect(await persistedReceiptIds(dir, graphId, "work#1")).toEqual([]);
    });
  });
});

// ── The crossing invariants ─────────────────────────────────────────────────

describe("settleHostDerivedCompletion — the crossing invariants hold here too", () => {
  it("refuses a STOPPED attempt and writes nothing (the run keeps executing)", async () => {
    await withHarness(explicitDeclaration(), async (harness) => {
      const { runtime, ledger, graphId, executions, dir } = harness;
      runtime.start(NOW);
      executions.set("work#1", { executionId: WORK_EXECUTION });
      const run = ledger.runs.readRun(graphId);
      if (run === undefined) throw new Error("fixture: start minted no run identity");
      const written = ledger.runs.writeControlDecision({
        decision: Object.freeze({
          graphId,
          runId: run.runId,
          nodeId: WORK,
          attemptId: "work#1",
          command: "failure" as const,
          reason: "the worker's execution failed",
          decidedAt: NOW + 1,
        }),
      });
      expect(written.kind).toBe("recorded");
      const before = snapshotOf(harness);

      const refusedResult = runtime.settleHostDerivedCompletion(
        factOf(executions, "work#1"),
        NOW + 2,
      );
      expect(refusedResult.kind).toBe("refused");
      if (refusedResult.kind !== "refused") return;
      expect(refusedResult.refusals.map((refusal) => refusal.code)).toEqual([
        "attempt-stopped",
      ]);
      expect(snapshotOf(harness)).toBe(before);
      expect(await persistedReceiptIds(dir, graphId, "work#1")).toEqual([]);
    });
  });

  it("refuses a retry-SUPERSEDED attempt and writes nothing", async () => {
    await withHarness(explicitDeclaration(), async (harness) => {
      const { runtime, ledger, graphId, executions, dir } = harness;
      runtime.start(NOW);
      executions.set("work#1", { executionId: WORK_EXECUTION });
      const run = ledger.runs.readRun(graphId);
      if (run === undefined) throw new Error("fixture: start minted no run identity");
      const written = ledger.runs.writeControlDecision({
        decision: Object.freeze({
          graphId,
          runId: run.runId,
          nodeId: WORK,
          attemptId: "work#1",
          command: "retry" as const,
          reason: "a trusted retry replaced the attempt",
          decidedAt: NOW + 1,
          successorAttemptId: "work#9",
        }),
      });
      expect(written.kind).toBe("recorded");
      const before = snapshotOf(harness);

      const refusedResult = runtime.settleHostDerivedCompletion(
        factOf(executions, "work#1"),
        NOW + 2,
      );
      expect(refusedResult.kind).toBe("refused");
      if (refusedResult.kind !== "refused") return;
      expect(refusedResult.refusals.map((refusal) => refusal.code)).toEqual([
        "attempt-superseded",
      ]);
      expect(snapshotOf(harness)).toBe(before);
      expect(await persistedReceiptIds(dir, graphId, "work#1")).toEqual([]);
    });
  });
});
