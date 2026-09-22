/**
 * Outcome-protocol run path (C3b).
 *
 * Covers a DECLARED (protocol 2) graph actually running against the scripted
 * dispatch seam: the entry node is dispatched from the compiled plan, an
 * outcome is submitted to the acceptance core, and the accepted outcome advances
 * the graph to its terminal state — with the state snapshot, the receipt, the
 * accepted event and the pending effects visible in the ledger afterwards. Also
 * covered: execution identity derived from the runtime's own context (a worker
 * cannot supply one), the attempt CREDENTIAL the runtime issues at dispatch and
 * resolves submissions against (a missing, tampered, superseded or other node's
 * credential is refused, and the credential never reaches a receipt, an effect
 * payload or a report), a duplicate submission replaying without a second
 * advance,
 * a rejected gate and a refused proposal leaving the graph where it was, a
 * distinct submission for a settled attempt never being committed, a forced
 * mid-transaction failure leaving nothing, loop continuation and its hard cap,
 * the missing-handler refusal, and the legacy v2 run path still working through
 * the file store.
 *
 * Every case runs in its own mkdtemp directory and removes it in a finally
 * block; nothing here writes outside a temp dir.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDatabase,
  type DatabaseDriver,
} from "../../src/memory/db-driver.ts";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import type { CompiledPlan } from "../../src/graph/compiler/plan.ts";
import { buildDeclaredOutcomeGraph } from "../../src/graph/tools/declare-graph.ts";
import {
  SqliteAcceptanceLedger,
  ledgerFilePath,
} from "../../src/graph/ledger/sqlite-ledger.ts";
import {
  OutcomeGraphRuntime,
  type OutcomeDispatchRequest,
} from "../../src/graph/outcome/runtime.ts";
import {
  CURRENT_OUTCOME_STATE_BODY,
  OutcomeStateError,
  type OutcomeGraphState,
} from "../../src/graph/outcome/graph-state.ts";
import type { AttemptCredentialSource } from "../../src/graph/outcome/attempt-credential.ts";
import type { GraphStateRecord } from "../../src/graph/ledger/types.ts";
import {
  createValidatorRegistry,
  type ValidationOutcome,
  type ValidatorRegistry,
} from "../../src/graph/outcome/validators.ts";
import {
  createExecutionProtocolRegistry,
  type ExecutionProtocolRegistry,
} from "../../src/graph/protocol/execution-protocol.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { engineStatePath } from "../../src/graph/engine/engine-persistence.ts";
import type { NodeDispatchPort } from "../../src/graph/engine/engine-advance.ts";
import type { NodeRuntimeState } from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { TaskTerminatedCallback } from "../../src/graph/engine/dispatch-bridge.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const EMPTY_VALIDATORS: ValidatorRegistry = createValidatorRegistry([]);

/** work -> ship: one successor edge, one terminal outcome. */
const LINEAR: GraphDeclarationV3 = {
  version: 3,
  name: "graph.linear",
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
      outcomes: [{ id: "delivered" }],
    },
  ],
  edges: [{ from: "work", to: "ship", outcome: "done" }],
};

/**
 * work -> review -> (revise) -> work, with review.approve as the exit. The
 * continuation edge points BACK at the entry node, which is exactly the shape a
 * naive "no inbound edge" entry rule would fail on.
 */
function loopDeclaration(maxTraversals: number): GraphDeclarationV3 {
  return {
    version: 3,
    name: "graph.loop",
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
  };
}


/**
 * A node that belongs to TWO declared loop groups, the earlier one (by id)
 * declaring a DIFFERENT continuation outcome.
 *
 * "review" emits the "revise" continuation of `b-inner`, but it is also a
 * member of `a-outer` — which the plan sorts first. Selecting "the first group
 * that contains review" therefore finds a group "revise" is not the
 * continuation of, and `b-inner`'s cap would never advance: the loop would run
 * unbounded. The compiler admits this shape (membership in two loop groups and
 * two distinct continuation outcomes are both legal).
 */
function overlappingLoopDeclaration(maxInnerTraversals: number): GraphDeclarationV3 {
  return {
    version: 3,
    name: "graph.overlap",
    nodes: [
      {
        id: "work",
        agent: "agent.work",
        prompt: "Do the work.",
        outcomes: [{ id: "done" }, { id: "redo" }],
      },
      {
        id: "review",
        agent: "agent.review",
        prompt: "Review the work.",
        outcomes: [{ id: "revise" }, { id: "approve" }],
      },
    ],
    edges: [
      { from: "work", to: "review", outcome: "done" },
      { from: "work", to: "review", outcome: "redo" },
      { from: "review", to: "work", outcome: "revise" },
    ],
    loop_groups: [
      {
        id: "a-outer",
        nodes: ["work", "review"],
        max_traversals: 3,
        continuation_outcome: "redo",
        exit_outcome: "approve",
      },
      {
        id: "b-inner",
        nodes: ["work", "review"],
        max_traversals: maxInnerTraversals,
        continuation_outcome: "revise",
        exit_outcome: "approve",
      },
    ],
  };
}

/**
 * TWO declared loop groups that BOTH take "revise" as their continuation over
 * the same nodes: one traversal of that edge re-enters both loops, so both
 * counters must advance and the tighter cap must bind.
 */
function sharedContinuationDeclaration(outerCap: number): GraphDeclarationV3 {
  return {
    version: 3,
    name: "graph.shared-continuation",
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
      },
    ],
    edges: [
      { from: "work", to: "review", outcome: "done" },
      { from: "review", to: "work", outcome: "revise" },
    ],
    loop_groups: [
      {
        id: "a-tight",
        nodes: ["work", "review"],
        max_traversals: outerCap,
        continuation_outcome: "revise",
        exit_outcome: "approve",
      },
      {
        id: "b-loose",
        nodes: ["work", "review"],
        max_traversals: 10,
        continuation_outcome: "revise",
        exit_outcome: "approve",
      },
    ],
  };
}

/** work's only outcome is gated by a validator the tests implement. */
const GATED: GraphDeclarationV3 = {
  version: 3,
  name: "graph.gated",
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
    },
    {
      id: "ship",
      agent: "agent.ship",
      prompt: "Ship it.",
      outcomes: [{ id: "delivered" }],
    },
  ],
  edges: [{ from: "work", to: "ship", outcome: "done" }],
};

const GATE_ID = "gate.check";
const GATE_VERSION = 1;

function gatedRegistry(outcome: ValidationOutcome): ValidatorRegistry {
  return createValidatorRegistry([
    { id: GATE_ID, version: GATE_VERSION, implementation: () => outcome },
  ]);
}

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

/**
 * A deterministic credential source for the harness: one credential per
 * attempt, derived from the BINDING the runtime hands the source (not read back
 * out of the state), so a test can name the attempt it is submitting for.
 */
const TEST_CREDENTIAL_SOURCE: AttemptCredentialSource = (binding) =>
  "test-credential:" + binding.nodeId + "#" + binding.attemptId;

async function withHarness<T>(
  declaration: GraphDeclarationV3,
  fn: (harness: Harness) => Promise<T> | T,
  options: {
    readonly validators?: ValidatorRegistry;
    readonly supportedValidators?: readonly {
      readonly validator: string;
      readonly version?: number;
    }[];
    readonly protocols?: ExecutionProtocolRegistry;
    readonly mintCredential?: AttemptCredentialSource;
  } = {},
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "outcome-runtime-"));
  let ledger: SqliteAcceptanceLedger | undefined;
  try {
    ledger = await SqliteAcceptanceLedger.create(dir);
    const declared = buildDeclaredOutcomeGraph({
      declaration,
      ...(options.supportedValidators === undefined
        ? {}
        : { supportedValidators: [...options.supportedValidators] }),
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
      mintCredential: options.mintCredential ?? TEST_CREDENTIAL_SOURCE,
      ...(options.protocols === undefined ? {} : { protocols: options.protocols }),
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
    if (ledger !== undefined) ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One node's progress in a state, failing the test when it is missing. */
function nodeOf(state: OutcomeGraphState, nodeId: string) {
  const found = state.nodes.find((node) => node.nodeId === nodeId);
  if (found === undefined) throw new Error("no state for node " + nodeId);
  return found;
}

/** Attempt ids in dispatch order, for compact assertions. */
function attemptIds(requests: readonly OutcomeDispatchRequest[]): string[] {
  return requests.map((request) => request.attemptId);
}

/**
 * A CREDENTIAL-FREE projection of one state, for the probes' self-check output:
 * status and attempt identity per node, whether a credential is recorded, and
 * nothing that would print the capability itself.
 */
function stateSummary(state: OutcomeGraphState | undefined): string {
  return JSON.stringify({
    phase: state?.phase,
    nodes: state?.nodes.map((node) => ({
      nodeId: node.nodeId,
      status: node.status,
      attemptId: node.attemptId,
      hasCredential: node.attemptCredential !== undefined,
    })),
  });
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
        attemptIds(requests).join(", ") +
        ")",
    );
  }
  return found.credential;
}

/** Read one field of an unknown record value, for payload assertions. */
function fieldOf(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[field];
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

/** Delete every acceptance row, leaving the graph state untouched. */
async function stripAcceptanceRows(dir: string): Promise<void> {
  const db: DatabaseDriver = await createDatabase(ledgerFilePath(dir));
  try {
    db.run("DELETE FROM ledger_accepted_events");
    db.run("DELETE FROM ledger_pending_effects");
  } finally {
    db.close();
  }
}

// ── The run path ────────────────────────────────────────────────────────────

describe("OutcomeGraphRuntime — a declared graph runs its plan", () => {
  it("dispatches the entry node, accepts an outcome and settles at the terminal", async () => {
    await withHarness(LINEAR, async ({ runtime, ledger, requests, graphId }) => {
      const started = runtime.start(NOW);
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      expect(started.dispatched.map((request) => request.nodeId)).toEqual(["work"]);
      expect(attemptIds(started.dispatched)).toEqual(["work#1"]);
      // Provenance comes from the plan, not from a caller.
      expect(started.dispatched[0]?.graphId).toBe(graphId);
      expect(started.dispatched[0]?.planRevision).toBe(runtime.planRevision);
      expect(started.dispatched[0]?.agent).toBe("agent.work");
      expect(started.dispatched[0]?.prompt).toBe("Do the work.");

      const first = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
        NOW + 1,
      );
      expect(first.kind).toBe("accepted");
      if (first.kind !== "accepted") return;
      expect(first.replayed).toBe(false);
      expect(first.decision.kind).toBe("accepted");
      expect(first.decision.planRevision).toBe(runtime.planRevision);
      expect(nodeOf(first.state, "work")).toMatchObject({
        status: "settled",
        outcomeId: "done",
        attemptId: "work#1",
      });
      expect(nodeOf(first.state, "ship")).toMatchObject({
        status: "dispatched",
        attemptId: "ship#2",
      });
      expect(first.state.phase).toBe("executing");
      // The successor is dispatched AFTER the commit, through the seam.
      expect(attemptIds(first.dispatched)).toEqual(["ship#2"]);
      expect(attemptIds(requests)).toEqual(["work#1", "ship#2"]);

      // The ledger holds the receipt, the event, the effect and the state.
      const receipt = ledger.lookupReceipt({
        graphId,
        attemptId: "work#1",
        submissionId: first.receipt.submissionId,
      });
      expect(receipt).toEqual(first.receipt);
      expect(receipt?.decision).toBe("accepted");
      const events = ledger.acceptedEvents(graphId);
      expect(events).toHaveLength(1);
      expect(events[0]?.outcomeId).toBe("done");
      expect(events[0]?.attemptId).toBe("work#1");
      const effects = ledger.pendingEffects(graphId);
      expect(effects).toHaveLength(1);
      expect(effects[0]?.effectId).toBe("dispatch:ship#2");
      expect(effects[0]?.kind).toBe("dispatch");
      // The effect row records the attempt that PRODUCED it (the trusted
      // context); the dispatch it carries names the successor's fresh attempt.
      expect(effects[0]?.attemptId).toBe("work#1");
      expect(fieldOf(effects[0]?.payload, "nodeId")).toBe("ship");
      expect(fieldOf(effects[0]?.payload, "attemptId")).toBe("ship#2");
      expect(runtime.state()).toEqual(first.state);
      expect(ledger.readGraphState(graphId)?.planRevision).toBe(
        runtime.planRevision,
      );

      // The terminal outcome settles the graph.
      const last = runtime.submit(
        { nodeId: "ship", outcomeId: "delivered", credential: credentialOf(requests, "ship#2") },
        NOW + 2,
      );
      expect(last.kind).toBe("accepted");
      if (last.kind !== "accepted") return;
      expect(last.state.phase).toBe("complete");
      expect(last.dispatched).toHaveLength(0);
      expect(nodeOf(last.state, "ship")).toMatchObject({
        status: "settled",
        outcomeId: "delivered",
      });
      expect(ledger.acceptedEvents(graphId)).toHaveLength(2);
      expect(ledger.pendingEffects(graphId)).toHaveLength(1);
      expect(runtime.state()?.phase).toBe("complete");
      // One dispatch per node attempt — nothing was re-dispatched.
      expect(attemptIds(requests)).toEqual(["work#1", "ship#2"]);
    });
  });

  it("start is idempotent: an already-started graph is never re-dispatched", async () => {
    await withHarness(LINEAR, async ({ runtime, requests }) => {
      const first = runtime.start(NOW);
      expect(first.kind).toBe("started");
      const second = runtime.start(NOW + 1);
      expect(second.kind).toBe("already-started");
      if (second.kind !== "already-started") return;
      expect(attemptIds(requests)).toEqual(["work#1"]);
      expect(nodeOf(second.state, "work")).toMatchObject({
        status: "dispatched",
        attemptId: "work#1",
      });
    });
  });

  it("derives the execution identity itself: a worker cannot supply one", async () => {
    await withHarness(LINEAR, async ({ runtime, ledger, graphId, dir }) => {
      runtime.start(NOW);
      const before = runtime.state();

      // graphId / attemptId / submissionId / planRevision are not proposal
      // fields, so naming them is an unknown key and nothing is written.
      const result = runtime.submit(
        {
          nodeId: "work",
          outcomeId: "done",
          graphId: "some-other-graph",
          attemptId: "attempt-forged",
          submissionId: "submission-forged",
        },
        NOW + 1,
      );
      expect(result.kind).toBe("refused");
      if (result.kind !== "refused") return;
      expect(result.refusals.map((refusal) => refusal.code)).toContain(
        "malformed-proposal",
      );
      expect(runtime.state()).toEqual(before);
      expect(ledger.acceptedEvents(graphId)).toHaveLength(0);
      expect(ledger.pendingEffects(graphId)).toHaveLength(0);
      expect(await countTable(dir, "ledger_receipts")).toBe(0);
    });
  });

  it("replays a duplicate submission without advancing the state twice", async () => {
    await withHarness(LINEAR, async ({ runtime, ledger, requests, graphId, dir }) => {
      runtime.start(NOW);
      const proposal = {
        nodeId: "work",
        outcomeId: "done",
        credential: credentialOf(requests, "work#1"),
      };
      const first = runtime.submit(proposal, NOW + 1);
      expect(first.kind).toBe("accepted");
      if (first.kind !== "accepted") return;
      expect(first.replayed).toBe(false);
      const stateAfterFirst = runtime.state();
      const dispatchesAfterFirst = attemptIds(requests);

      const second = runtime.submit(proposal, NOW + 2);
      expect(second.kind).toBe("accepted");
      if (second.kind !== "accepted") return;
      expect(second.replayed).toBe(true);
      // The PERSISTED receipt is returned, exactly as first committed.
      expect(second.receipt).toEqual(first.receipt);
      expect(second.state).toEqual(stateAfterFirst);
      expect(second.dispatched).toHaveLength(0);
      expect(attemptIds(requests)).toEqual(dispatchesAfterFirst);
      // No second row anywhere: one receipt, one event, one effect.
      expect(ledger.acceptedEvents(graphId)).toHaveLength(1);
      expect(ledger.pendingEffects(graphId)).toHaveLength(1);
      expect(await countTable(dir, "ledger_receipts")).toBe(1);
      expect(await countTable(dir, "ledger_graph_state")).toBe(1);
    });
  });

  it("settles at most once: a distinct submission for a settled attempt is not committed", async () => {
    await withHarness(LINEAR, async ({ runtime, ledger, requests, graphId, dir }) => {
      runtime.start(NOW);
      const first = runtime.submit(
        {
          nodeId: "work",
          outcomeId: "done",
          credential: credentialOf(requests, "work#1"),
          data: { round: 1 },
        },
        NOW + 1,
      );
      expect(first.kind).toBe("accepted");
      if (first.kind !== "accepted") return;
      const before = runtime.state();
      const dispatchesBefore = attemptIds(requests);

      const distinct = runtime.submit(
        {
          nodeId: "work",
          outcomeId: "done",
          credential: credentialOf(requests, "work#1"),
          data: { round: 2 },
        },
        NOW + 2,
      );
      expect(distinct.kind).toBe("not-committed");
      if (distinct.kind !== "not-committed") return;
      expect(distinct.verdict.kind).toBe("settled");
      // Nothing moved: the settled result is never overwritten.
      expect(runtime.state()).toEqual(before);
      expect(attemptIds(requests)).toEqual(dispatchesBefore);
      expect(ledger.acceptedEvents(graphId)).toHaveLength(1);
      expect(ledger.pendingEffects(graphId)).toHaveLength(1);
      expect(await countTable(dir, "ledger_receipts")).toBe(1);
    });
  });
});

// ── Refusals and rollback ───────────────────────────────────────────────────

describe("OutcomeGraphRuntime — refusals leave the graph exactly where it was", () => {
  it("refuses a credential aimed at a node with no attempt in flight", async () => {
    await withHarness(LINEAR, async ({ runtime, ledger, requests, graphId, dir }) => {
      runtime.start(NOW);
      // ship is declared by the plan but has never been dispatched, so the only
      // credential in hand belongs to work — and it is never re-aimed.
      const result = runtime.submit(
        {
          nodeId: "ship",
          outcomeId: "delivered",
          credential: credentialOf(requests, "work#1"),
        },
        NOW + 1,
      );
      expect(result.kind).toBe("refused");
      if (result.kind !== "refused") return;
      expect(result.refusals.map((refusal) => refusal.code)).toEqual([
        "credential-node-mismatch",
      ]);
      expect(result.refusals[0]?.path).toBe("$.credential");
      // A credential that names nothing is refused too — the node's current
      // attempt is never substituted for it.
      const forged = runtime.submit(
        { nodeId: "ship", outcomeId: "delivered", credential: "never-issued" },
        NOW + 2,
      );
      expect(forged.kind).toBe("refused");
      if (forged.kind !== "refused") return;
      expect(forged.refusals.map((refusal) => refusal.code)).toEqual([
        "credential-unknown",
      ]);
      expect(ledger.acceptedEvents(graphId)).toHaveLength(0);
      expect(await countTable(dir, "ledger_receipts")).toBe(0);
    });
  });

  it("refuses a submission before start, writing nothing", async () => {
    await withHarness(LINEAR, async ({ runtime, ledger, graphId, dir }) => {
      const result = runtime.submit(
        { nodeId: "work", outcomeId: "done" },
        NOW,
      );
      expect(result.kind).toBe("refused");
      if (result.kind !== "refused") return;
      expect(result.refusals.map((refusal) => refusal.code)).toContain(
        "graph-not-started",
      );
      expect(ledger.readGraphState(graphId)).toBeUndefined();
      expect(await countTable(dir, "ledger_receipts")).toBe(0);
    });
  });

  it("records a failed gate as a rejected receipt and moves no state", async () => {
    await withHarness(
      GATED,
      async ({ runtime, ledger, requests, graphId, dir }) => {
        runtime.start(NOW);
        const before = runtime.state();
        const result = runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
          NOW + 1,
        );
        expect(result.kind).toBe("rejected");
        if (result.kind !== "rejected") return;
        expect(result.decision.kind).toBe("rejected");
        expect(
          result.decision.requirements.map((entry) => entry.outcome.kind),
        ).toEqual(["fail"]);
        expect(result.receipt.decision).toBe("rejected");
        // The receipt records the rejection; the attempt stays open and the
        // graph does not move: no event, no effect, no state change, no
        // successor dispatched.
        expect(ledger.acceptedEvents(graphId)).toHaveLength(0);
        expect(ledger.pendingEffects(graphId)).toHaveLength(0);
        expect(runtime.state()).toEqual(before);
        expect(attemptIds(requests)).toEqual(["work#1"]);
        expect(await countTable(dir, "ledger_receipts")).toBe(1);
        // The same content submitted again replays the rejected receipt.
        const again = runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
          NOW + 2,
        );
        expect(again.kind).toBe("rejected");
        if (again.kind !== "rejected") return;
        expect(again.receipt).toEqual(result.receipt);
        expect(await countTable(dir, "ledger_receipts")).toBe(1);
      },
      {
        validators: gatedRegistry({ kind: "fail", reason: "gate says no" }),
        supportedValidators: [{ validator: GATE_ID, version: GATE_VERSION }],
      },
    );
  });

  it("accepts when the gate passes, so the rejection above is the gate's doing", async () => {
    await withHarness(
      GATED,
      async ({ runtime, ledger, requests, graphId }) => {
        runtime.start(NOW);
        const result = runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
          NOW + 1,
        );
        expect(result.kind).toBe("accepted");
        if (result.kind !== "accepted") return;
        expect(ledger.acceptedEvents(graphId)).toHaveLength(1);
        expect(nodeOf(result.state, "ship").status).toBe("dispatched");
      },
      {
        validators: gatedRegistry({ kind: "pass" }),
        supportedValidators: [{ validator: GATE_ID, version: GATE_VERSION }],
      },
    );
  });

  it("rolls the acceptance back when the state and the ledger disagree", async () => {
    await withHarness(LINEAR, async ({ runtime, ledger, requests, graphId, dir }) => {
      runtime.start(NOW);
      const first = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
        NOW + 1,
      );
      expect(first.kind).toBe("accepted");
      if (first.kind !== "accepted") return;
      const before = runtime.state();

      // FORCED MID-TRANSACTION FAILURE: the state says work settled, but the
      // ledger holds no accepted event to corroborate it. The join refuses
      // inside the acceptance transaction, so the transaction rolls back
      // completely — nothing from this submission survives.
      await stripAcceptanceRows(dir);
      const result = runtime.submit(
        {
          nodeId: "work",
          outcomeId: "done",
          credential: credentialOf(requests, "work#1"),
          data: { retry: true },
        },
        NOW + 2,
      );
      expect(result.kind).toBe("refused");
      if (result.kind !== "refused") return;
      expect(result.refusals.map((refusal) => refusal.code)).toContain(
        "state-ledger-disagreement",
      );
      expect(runtime.state()).toEqual(before);
      expect(ledger.acceptedEvents(graphId)).toHaveLength(0);
      expect(ledger.pendingEffects(graphId)).toHaveLength(0);
      // The only receipt is the one the FIRST submission committed.
      expect(await countTable(dir, "ledger_receipts")).toBe(1);
    });
  });

  it("refuses to run when no outcome-protocol handler is registered", async () => {
    await withHarness(
      LINEAR,
      async ({ runtime, ledger, graphId, dir }) => {
        const started = runtime.start(NOW);
        expect(started.kind).toBe("refused");
        if (started.kind !== "refused") return;
        expect(started.refusals.map((refusal) => refusal.code)).toContain(
          "protocol-unavailable",
        );
        const submitted = runtime.submit(
          { nodeId: "work", outcomeId: "done" },
          NOW + 1,
        );
        expect(submitted.kind).toBe("refused");
        expect(ledger.readGraphState(graphId)).toBeUndefined();
        expect(await countTable(dir, "ledger_receipts")).toBe(0);
      },
      { protocols: createExecutionProtocolRegistry({ handlers: [] }) },
    );
  });
});

// ── Loops ───────────────────────────────────────────────────────────────────

describe("OutcomeGraphRuntime — loop continuation and its hard cap", () => {
  it("re-enters the loop on the continuation outcome and exits on the terminal", async () => {
    await withHarness(loopDeclaration(2), async ({ runtime, requests }) => {
      runtime.start(NOW);
      expect(attemptIds(requests)).toEqual(["work#1"]);

      const worked = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
        NOW + 1,
      );
      expect(worked.kind).toBe("accepted");
      if (worked.kind !== "accepted") return;
      expect(attemptIds(worked.dispatched)).toEqual(["review#2"]);

      const revised = runtime.submit(
        { nodeId: "review", outcomeId: "revise", credential: credentialOf(requests, "review#2") },
        NOW + 2,
      );
      expect(revised.kind).toBe("accepted");
      if (revised.kind !== "accepted") return;
      // The continuation re-enters the loop at the settled entry node with a
      // FRESH attempt, and the traversal counter advanced.
      expect(attemptIds(revised.dispatched)).toEqual(["work#3"]);
      expect(nodeOf(revised.state, "work")).toMatchObject({
        status: "dispatched",
        attemptId: "work#3",
      });
      expect(revised.state.loopTraversals["revise-loop"]).toBe(1);

      const workedAgain = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#3") },
        NOW + 3,
      );
      expect(workedAgain.kind).toBe("accepted");
      if (workedAgain.kind !== "accepted") return;
      expect(attemptIds(workedAgain.dispatched)).toEqual(["review#4"]);

      const approved = runtime.submit(
        { nodeId: "review", outcomeId: "approve", credential: credentialOf(requests, "review#4") },
        NOW + 4,
      );
      expect(approved.kind).toBe("accepted");
      if (approved.kind !== "accepted") return;
      expect(approved.state.phase).toBe("complete");
      expect(approved.dispatched).toHaveLength(0);
      expect(approved.state.loopTraversals["revise-loop"]).toBe(1);
      expect(attemptIds(requests)).toEqual([
        "work#1",
        "review#2",
        "work#3",
        "review#4",
      ]);
    });
  });

  it("refuses the continuation that would exceed the hard cap, writing nothing", async () => {
    await withHarness(loopDeclaration(1), async ({ runtime, ledger, requests, graphId, dir }) => {
      runtime.start(NOW);
      runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
        NOW + 1,
      );
      const firstRevision = runtime.submit(
        { nodeId: "review", outcomeId: "revise", credential: credentialOf(requests, "review#2") },
        NOW + 2,
      );
      expect(firstRevision.kind).toBe("accepted");
      if (firstRevision.kind !== "accepted") return;
      expect(firstRevision.state.loopTraversals["revise-loop"]).toBe(1);
      runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#3") },
        NOW + 3,
      );
      const before = runtime.state();
      const receiptsBefore = await countTable(dir, "ledger_receipts");

      const overCap = runtime.submit(
        { nodeId: "review", outcomeId: "revise", credential: credentialOf(requests, "review#4") },
        NOW + 4,
      );
      expect(overCap.kind).toBe("refused");
      if (overCap.kind !== "refused") return;
      expect(overCap.refusals.map((refusal) => refusal.code)).toContain(
        "loop-limit-exceeded",
      );
      // The whole acceptance rolled back: the graph is still where it was and
      // no receipt was written for the refused round.
      expect(runtime.state()).toEqual(before);
      expect(await countTable(dir, "ledger_receipts")).toBe(receiptsBefore);
      expect(ledger.acceptedEvents(graphId)).toHaveLength(3);
    });
  });

  it("enforces the cap of a continuation whose node also belongs to an earlier-declared loop group", async () => {
    // The compiled plan sorts loop groups by id, so a positional "first group
    // containing the emitting node" rule selects `a-outer` for `review` — a
    // group whose continuation `revise` is NOT. b-inner's cap would then never
    // advance and the loop would be unbounded.
    const compiled = buildDeclaredOutcomeGraph({
      declaration: overlappingLoopDeclaration(1),
    });
    expect(compiled.plan.loopGroups.map((group) => group.id)).toEqual([
      "a-outer",
      "b-inner",
    ]);
    expect(compiled.plan.loopGroups[0]?.continuationOutcome).toBe("redo");

    await withHarness(
      overlappingLoopDeclaration(1),
      async ({ runtime, ledger, requests, graphId, dir }) => {
        runtime.start(NOW);
        runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
          NOW + 1,
        );

        const firstRevision = runtime.submit(
          { nodeId: "review", outcomeId: "revise", credential: credentialOf(requests, "review#2") },
          NOW + 2,
        );
        expect(firstRevision.kind).toBe("accepted");
        if (firstRevision.kind !== "accepted") return;
        // The counter that moved is b-inner's — the loop `revise` re-enters.
        expect(firstRevision.state.loopTraversals["b-inner"]).toBe(1);
        expect(firstRevision.state.loopTraversals["a-outer"]).toBeUndefined();
        expect(attemptIds(firstRevision.dispatched)).toEqual(["work#3"]);

        runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#3") },
          NOW + 3,
        );
        const before = runtime.state();
        const receiptsBefore = await countTable(dir, "ledger_receipts");
        const eventsBefore = ledger.acceptedEvents(graphId).length;
        const dispatchesBefore = attemptIds(requests);

        const overCap = runtime.submit(
          { nodeId: "review", outcomeId: "revise", credential: credentialOf(requests, "review#4") },
          NOW + 4,
        );
        expect(overCap.kind).toBe("refused");
        if (overCap.kind !== "refused") return;
        expect(overCap.refusals[0]?.code).toBe("loop-limit-exceeded");
        expect(overCap.refusals[0]?.message).toContain("b-inner");
        // The refusal rolled back with the whole acceptance: no state write, no
        // receipt, no event, no dispatch.
        expect(runtime.state()).toEqual(before);
        expect(await countTable(dir, "ledger_receipts")).toBe(receiptsBefore);
        expect(ledger.acceptedEvents(graphId)).toHaveLength(eventsBefore);
        expect(attemptIds(requests)).toEqual(dispatchesBefore);
      },
    );
  });

  it("advances every group that declares the continuation and binds the tightest cap", async () => {
    await withHarness(
      sharedContinuationDeclaration(1),
      async ({ runtime, ledger, requests, graphId, dir }) => {
        runtime.start(NOW);
        runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
          NOW + 1,
        );
        const firstRevision = runtime.submit(
          { nodeId: "review", outcomeId: "revise", credential: credentialOf(requests, "review#2") },
          NOW + 2,
        );
        expect(firstRevision.kind).toBe("accepted");
        if (firstRevision.kind !== "accepted") return;
        // One traversal re-enters BOTH declared loops, so both counters move.
        expect(firstRevision.state.loopTraversals).toEqual({
          "a-tight": 1,
          "b-loose": 1,
        });

        runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#3") },
          NOW + 3,
        );
        const before = runtime.state();
        const receiptsBefore = await countTable(dir, "ledger_receipts");
        const eventsBefore = ledger.acceptedEvents(graphId).length;
        const overCap = runtime.submit(
          { nodeId: "review", outcomeId: "revise", credential: credentialOf(requests, "review#4") },
          NOW + 4,
        );
        expect(overCap.kind).toBe("refused");
        if (overCap.kind !== "refused") return;
        // b-loose alone would still admit this round; a-tight's cap is what
        // binds, and it binds for the whole acceptance.
        expect(overCap.refusals[0]?.code).toBe("loop-limit-exceeded");
        expect(overCap.refusals[0]?.message).toContain("a-tight");
        expect(runtime.state()).toEqual(before);
        expect(await countTable(dir, "ledger_receipts")).toBe(receiptsBefore);
        expect(ledger.acceptedEvents(graphId)).toHaveLength(eventsBefore);
      },
    );
  });
});

// ── Attempt credentials ─────────────────────────────────────────────────────

describe("OutcomeGraphRuntime — an attempt is named by the credential it was issued", () => {
  it("persists the credential on the attempt entry and keeps it off every other record", async () => {
    await withHarness(LINEAR, async ({ runtime, ledger, requests, graphId }) => {
      const started = runtime.start(NOW);
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const request = requests[0];
      if (request === undefined) throw new Error("fixture: work was not dispatched");
      // Issued by the runtime: the dispatch request carries it, and the
      // attempt's own persisted entry records the same value.
      expect(request.credential).toBe(credentialOf(requests, "work#1"));
      expect(nodeOf(started.state, "work").attemptCredential).toBe(request.credential);

      const accepted = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: request.credential },
        NOW + 1,
      );
      expect(accepted.kind).toBe("accepted");
      if (accepted.kind !== "accepted") return;
      // The SETTLED entry keeps the settling attempt's credential, which is what
      // lets a repeat resolve to the same attempt and replay its receipt.
      expect(nodeOf(accepted.state, "work").attemptCredential).toBe(request.credential);
      expect(nodeOf(accepted.state, "ship").attemptCredential).toBe(
        credentialOf(requests, "ship#2"),
      );

      // The credential lives in the state row and travels over the dispatch
      // seam; it is in no receipt, no accepted event and no effect payload.
      const effects = ledger.pendingEffects(graphId);
      expect(effects).toHaveLength(1);
      expect(fieldOf(effects[0]?.payload, "credential")).toBeUndefined();
      expect(JSON.stringify(effects[0]?.payload)).not.toContain(request.credential);
      const receipt = ledger.lookupReceipt({
        graphId,
        attemptId: "work#1",
        submissionId: accepted.receipt.submissionId,
      });
      expect(JSON.stringify(receipt)).not.toContain(request.credential);
      expect(JSON.stringify(ledger.acceptedEvents(graphId))).not.toContain(
        request.credential,
      );
      expect(JSON.stringify(ledger.readGraphState(graphId)?.body)).toContain(
        request.credential,
      );

      // A recovery report names the armed attempt but never its capability.
      const resumed = runtime.resume(NOW + 2);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") return;
      expect(resumed.armed.map((node) => node.attemptId)).toEqual(["ship#2"]);
      expect(JSON.stringify(resumed.armed)).not.toContain(request.credential);
      expect(JSON.stringify(resumed.refusals)).not.toContain(request.credential);
    });
  });

  it("refuses a late submission for a superseded attempt instead of re-binding it", async () => {
    await withHarness(loopDeclaration(3), async ({ runtime, ledger, requests, graphId, dir }) => {
      runtime.start(NOW);
      const firstCredential = credentialOf(requests, "work#1");
      const accepted = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: firstCredential },
        NOW + 1,
      );
      expect(accepted.kind).toBe("accepted");
      if (accepted.kind !== "accepted") return;
      const revised = runtime.submit(
        { nodeId: "review", outcomeId: "revise", credential: credentialOf(requests, "review#2") },
        NOW + 2,
      );
      expect(revised.kind).toBe("accepted");
      if (revised.kind !== "accepted") return;
      // The loop re-armed work on a NEW attempt with a NEW credential.
      expect(nodeOf(revised.state, "work")).toMatchObject({
        status: "dispatched",
        attemptId: "work#3",
      });
      const current = nodeOf(revised.state, "work").attemptCredential;
      expect(current).toBeDefined();
      expect(current).not.toBe(firstCredential);

      const before = runtime.state();
      const receiptsBefore = await countTable(dir, "ledger_receipts");
      const eventsBefore = ledger.acceptedEvents(graphId).length;

      // THE DEFECT: the same late message that was accepted for work#1 (same
      // node, same outcome, same content) arrives after the loop re-armed work.
      const late = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: firstCredential },
        NOW + 3,
      );
      expect(late.kind).toBe("refused");
      if (late.kind !== "refused") return;
      expect(late.refusals.map((refusal) => refusal.code)).toEqual([
        "credential-unknown",
      ]);
      expect(late.refusals[0]?.path).toBe("$.credential");

      // Nothing moved: work#3 is still the attempt in flight and unsettled, no
      // new receipt exists, and work#1's own settlement was not rewound either.
      expect(runtime.state()).toEqual(before);
      const after = runtime.state();
      if (after === undefined) throw new Error("fixture: the state row is missing");
      expect(nodeOf(after, "work")).toMatchObject({
        status: "dispatched",
        attemptId: "work#3",
      });
      expect(await countTable(dir, "ledger_receipts")).toBe(receiptsBefore);
      expect(ledger.acceptedEvents(graphId)).toHaveLength(eventsBefore);
      expect(
        ledger
          .acceptedEvents(graphId)
          .map((event) => event.attemptId)
          .sort(),
      ).toEqual(["review#2", "work#1"]);

      // SELF-CHECK EVIDENCE: the final state and ledger rows the refusal left
      // behind (no credential value is printed).
      console.log(
        "[probe:late-credential] state=" +
          stateSummary(runtime.state()) +
          " receipts=" +
          (await countTable(dir, "ledger_receipts")) +
          " events=[" +
          ledger
            .acceptedEvents(graphId)
            .map((event) => event.attemptId)
            .sort()
            .join(", ") +
          "]",
      );
    });
  });

  it("refuses a missing, tampered or otherwise node's credential without writing", async () => {
    await withHarness(LINEAR, async ({ runtime, ledger, requests, graphId, dir }) => {
      runtime.start(NOW);
      const workCredential = credentialOf(requests, "work#1");
      const before = runtime.state();
      const receiptsBefore = await countTable(dir, "ledger_receipts");

      // (a) no credential at all: the refusal names the missing field, and the
      // runtime never derives one from the node id.
      const missing = runtime.submit({ nodeId: "work", outcomeId: "done" }, NOW + 1);
      expect(missing.kind).toBe("refused");
      if (missing.kind !== "refused") return;
      expect(missing.refusals.map((refusal) => refusal.code)).toEqual([
        "credential-missing",
      ]);
      expect(missing.refusals[0]?.path).toBe("$.credential");

      // (b) a tampered credential names no recorded attempt.
      const last = workCredential.slice(-1);
      const tampered =
        workCredential.slice(0, -1) + (last === "a" ? "b" : "a");
      const bad = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: tampered },
        NOW + 2,
      );
      expect(bad.kind).toBe("refused");
      if (bad.kind !== "refused") return;
      expect(bad.refusals.map((refusal) => refusal.code)).toEqual([
        "credential-unknown",
      ]);

      // (c) another node's credential is never re-aimed at this one.
      const crossNode = runtime.submit(
        { nodeId: "ship", outcomeId: "delivered", credential: workCredential },
        NOW + 3,
      );
      expect(crossNode.kind).toBe("refused");
      if (crossNode.kind !== "refused") return;
      expect(crossNode.refusals.map((refusal) => refusal.code)).toEqual([
        "credential-node-mismatch",
      ]);
      expect(crossNode.refusals[0]?.path).toBe("$.credential");

      expect(runtime.state()).toEqual(before);
      expect(ledger.acceptedEvents(graphId)).toHaveLength(0);
      expect(await countTable(dir, "ledger_receipts")).toBe(receiptsBefore);

      // SELF-CHECK EVIDENCE: all three probes above left the state and the
      // ledger exactly as they found them.
      console.log(
        "[probe:missing-tampered-cross-node] state=" +
          stateSummary(runtime.state()) +
          " receipts=" +
          (await countTable(dir, "ledger_receipts")) +
          " events=" +
          ledger.acceptedEvents(graphId).length,
      );
    });
  });

  it("still refuses an attempt id the caller supplies beside a valid credential", async () => {
    await withHarness(LINEAR, async ({ runtime, requests }) => {
      runtime.start(NOW);
      // The credential is accepted as a field; the attempt it belongs to is
      // still resolved by the runtime, so naming one is an unknown key.
      const named = runtime.submit(
        {
          nodeId: "work",
          outcomeId: "done",
          credential: credentialOf(requests, "work#1"),
          attemptId: "work#3",
        },
        NOW + 1,
      );
      expect(named.kind).toBe("refused");
      if (named.kind !== "refused") return;
      expect(named.refusals.map((refusal) => refusal.code)).toContain(
        "malformed-proposal",
      );
      expect(
        named.refusals.some((refusal) => refusal.path === "$.attemptId"),
      ).toBe(true);
    });
  });

  it("mints an opaque high-entropy credential per attempt with the default source", async () => {
    // NO injected source: this is the runtime's own platform-CSPRNG minting.
    const dir = mkdtempSync(join(tmpdir(), "outcome-runtime-credential-"));
    let ledger: SqliteAcceptanceLedger | undefined;
    try {
      ledger = await SqliteAcceptanceLedger.create(dir);
      const declared = buildDeclaredOutcomeGraph({ declaration: loopDeclaration(3) });
      const requests: OutcomeDispatchRequest[] = [];
      const runtime = new OutcomeGraphRuntime({
        plan: declared.plan,
        ledger,
        dispatch: (request) => {
          requests.push(request);
        },
        validators: EMPTY_VALIDATORS,
        artifactRoot: dir,
        clock: () => NOW,
      });
      runtime.start(NOW);
      const first = credentialOf(requests, "work#1");
      runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: first },
        NOW + 1,
      );
      runtime.submit(
        { nodeId: "review", outcomeId: "revise", credential: credentialOf(requests, "review#2") },
        NOW + 2,
      );
      const second = credentialOf(requests, "work#3");
      // 32 random bytes, hex-encoded: not derivable from the attempt id (the
      // value is opaque), and two attempts never share one.
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect(second).toMatch(/^[0-9a-f]{64}$/);
      expect(first).not.toBe(second);
    } finally {
      ledger?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replays a duplicate submission after a restart and never re-binds the credential", async () => {
    await withHarness(LINEAR, async ({ runtime, plan, ledger, requests, graphId, dir }) => {
      runtime.start(NOW);
      const credential = credentialOf(requests, "work#1");
      const accepted = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential },
        NOW + 1,
      );
      expect(accepted.kind).toBe("accepted");
      if (accepted.kind !== "accepted") return;

      // RESTART: a fresh runtime over the same durable rows — exactly what a
      // new process constructs. Nothing about the attempt is re-minted or
      // re-bound; the credential comes from the persisted state.
      const restarted = new OutcomeGraphRuntime({
        plan,
        ledger,
        dispatch: () => undefined,
        validators: EMPTY_VALIDATORS,
        artifactRoot: dir,
        clock: () => NOW,
      });
      const resumed = restarted.resume(NOW + 2);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") return;
      expect(resumed.armed.map((node) => node.attemptId)).toEqual(["ship#2"]);
      expect(JSON.stringify(resumed.armed)).not.toContain(credential);
      expect(nodeOf(resumed.state, "work")).toMatchObject({
        status: "settled",
        attemptId: "work#1",
      });

      const replay = restarted.submit(
        { nodeId: "work", outcomeId: "done", credential },
        NOW + 3,
      );
      expect(replay.kind).toBe("accepted");
      if (replay.kind !== "accepted") return;
      expect(replay.replayed).toBe(true);
      expect(replay.receipt).toEqual(accepted.receipt);
      // One settlement, on the original attempt: the duplicate wrote no second
      // receipt and settled no new attempt.
      expect(ledger.acceptedEvents(graphId)).toHaveLength(1);
      expect(ledger.acceptedEvents(graphId)[0]?.attemptId).toBe("work#1");

      // SELF-CHECK EVIDENCE: the restart path's final state and ledger rows.
      console.log(
        "[probe:restart-replay] state=" +
          stateSummary(restarted.state()) +
          " receipts=" +
          (await countTable(dir, "ledger_receipts")) +
          " events=[" +
          ledger
            .acceptedEvents(graphId)
            .map((event) => event.attemptId + ":" + event.outcomeId)
            .join(", ") +
          "]",
      );
    });
  });

  it("refuses a version-1 body's in-flight attempt on resume and on submit", async () => {
    await withHarness(LINEAR, async ({ runtime, ledger, requests, graphId }) => {
      runtime.start(NOW);
      const record = ledger.readGraphState(graphId);
      if (record === undefined) throw new Error("fixture: the state row is missing");
      const body = record.body;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new Error("fixture: the state body is not a record");
      }
      const rawNodes = (body as Record<string, unknown>).nodes;
      if (!Array.isArray(rawNodes)) throw new Error("fixture: the body carries no nodes");
      // A body exactly as the build BEFORE credentials wrote it: version 1, no
      // credential on any attempt.
      const v1Nodes = rawNodes.map((node) => {
        if (typeof node !== "object" || node === null) {
          throw new Error("fixture: a node entry is not a record");
        }
        const { attemptCredential: _dropped, ...rest } = node as Record<string, unknown>;
        return rest;
      });
      ledger.writeGraphState({
        ...record,
        body: { ...(body as Record<string, unknown>), bodyVersion: 1, nodes: v1Nodes },
        updatedAt: NOW + 1,
      });
      const before = ledger.readGraphState(graphId);

      // RECOVERY refuses the attempt: it is not armed and not launched, because
      // no submission could ever settle it and recovery never grants a
      // credential the attempt was not issued.
      const resumed = runtime.resume(NOW + 2);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") return;
      expect(resumed.armed).toEqual([]);
      expect(resumed.dispatched).toEqual([]);
      expect(resumed.refusals.map((refusal) => refusal.code)).toEqual([
        "credential-missing",
      ]);
      expect(resumed.refusals[0]?.path).toMatch(
        /^\$\.nodes\[\d+\]\.attemptCredential$/,
      );

      // SUBMISSION: the credential the worker holds names no recorded attempt,
      // and the credential-less attempt is never settled in its place.
      const submitted = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
        NOW + 3,
      );
      expect(submitted.kind).toBe("refused");
      if (submitted.kind !== "refused") return;
      expect(submitted.refusals.map((refusal) => refusal.code)).toEqual([
        "credential-unknown",
      ]);

      // The version-1 row was neither rewritten nor downgraded nor advanced.
      expect(ledger.readGraphState(graphId)).toEqual(before);
    });
  });
});

// ── The legacy v2 path is untouched ─────────────────────────────────────────

/** Dispatch seam that completes every node on the next tick (legacy runs). */
class CompletingDispatch implements NodeDispatchPort {
  private subs = new Map<string, TaskTerminatedCallback>();
  private tasks = new Map<string, DispatchTask>();
  private seq = 0;

  executeNode(node: NodeRuntimeState): Promise<DispatchTask> {
    const id = "task-" + node.nodeId + "-" + ++this.seq;
    const task: DispatchTask = {
      id,
      sessionId: "sess-" + id,
      parentSessionId: "g",
      depth: 1,
      status: "running",
      agent: node.agent,
      prompt: node.prompt,
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      priority: 0,
    };
    this.tasks.set(id, task);
    setTimeout(() => {
      task.status = "completed";
      this.subs.get(id)?.(id, "completed");
    }, 0);
    return Promise.resolve(task);
  }

  onTaskTerminated(
    taskId: string,
    cb: TaskTerminatedCallback,
  ): TaskTerminatedCallback {
    this.subs.set(taskId, cb);
    return cb;
  }

  getTask(taskId: string): DispatchTask | undefined {
    return this.tasks.get(taskId);
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

// ── A state body this build cannot read blocks the run ──────────────────────

describe("OutcomeGraphRuntime — the state body is gated by its declared version", () => {
  /** The stored record, as an outside writer left it. */
  function storedState(
    ledger: SqliteAcceptanceLedger,
    graphId: string,
  ): GraphStateRecord {
    const record = ledger.readGraphState(graphId);
    if (record === undefined) throw new Error("fixture: the state row is missing");
    return record;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function bodyOf(record: GraphStateRecord): Record<string, unknown> {
    if (!isRecord(record.body)) {
      throw new Error("fixture: the state body is not a record");
    }
    return record.body;
  }

  it("reports a newer body version as its own refusal and rewrites nothing", async () => {
    await withHarness(LINEAR, async ({ runtime, ledger, requests, graphId }) => {
      runtime.start(NOW);
      const started = storedState(ledger, graphId);

      // A different process writes a body in a LAYOUT this build has no reader
      // for — the same fields plus a strictly newer body version.
      const future = CURRENT_OUTCOME_STATE_BODY + 1;
      ledger.writeGraphState({
        ...started,
        body: { ...bodyOf(started), bodyVersion: future, progressBaselines: { work: 1 } },
        updatedAt: NOW + 1,
      });
      const before = storedState(ledger, graphId);

      // Every run-path entry point refuses, and the direct read reports the
      // capability gap rather than a generic malformed body.
      let direct: unknown;
      try {
        runtime.state();
      } catch (error) {
        direct = error;
      }
      expect(direct).toBeInstanceOf(OutcomeStateError);
      if (direct instanceof OutcomeStateError) {
        expect(direct.problem).toBe("unsupported-state-version");
      }

      const resumed = runtime.resume(NOW + 2);
      expect(resumed.kind).toBe("refused");
      if (resumed.kind === "refused") {
        expect(resumed.refusals.map((refusal) => refusal.code)).toEqual([
          "unsupported-state-version",
        ]);
        expect(resumed.refusals[0]?.message).toContain(String(future));
      }
      const restarted = runtime.start(NOW + 3);
      expect(restarted.kind).toBe("refused");
      if (restarted.kind === "refused") {
        expect(restarted.refusals.map((refusal) => refusal.code)).toContain(
          "unsupported-state-version",
        );
      }
      const submitted = runtime.submit(
        { nodeId: "work", outcomeId: "done" },
        NOW + 4,
      );
      expect(submitted.kind).toBe("refused");
      if (submitted.kind === "refused") {
        expect(submitted.refusals.map((refusal) => refusal.code)).toContain(
          "unsupported-state-version",
        );
      }

      // The row the refusing process was handed is UNCHANGED — no field was
      // trimmed, no version was downgraded — and nothing was dispatched.
      expect(storedState(ledger, graphId)).toEqual(before);
      expect(attemptIds(requests)).toEqual(["work#1"]);
    });
  });

  it("reports an unknown body field as unreadable and rewrites nothing", async () => {
    await withHarness(LINEAR, async ({ runtime, ledger, requests, graphId }) => {
      runtime.start(NOW);
      const started = storedState(ledger, graphId);
      ledger.writeGraphState({
        ...started,
        body: {
          ...bodyOf(started),
          progressBaselines: { work: { digest: "abc", round: 2 } },
        },
        updatedAt: NOW + 1,
      });
      const before = storedState(ledger, graphId);

      const resumed = runtime.resume(NOW + 2);
      expect(resumed.kind).toBe("refused");
      if (resumed.kind === "refused") {
        expect(resumed.refusals.map((refusal) => refusal.code)).toEqual([
          "unreadable-state",
        ]);
        expect(resumed.refusals[0]?.message).toContain("progressBaselines");
      }
      const after = storedState(ledger, graphId);
      expect(after).toEqual(before);
      expect("progressBaselines" in bodyOf(after)).toBe(true);
      expect(attemptIds(requests)).toEqual(["work#1"]);
    });
  });

  it("keeps a state bound to another revision a plan mismatch", async () => {
    await withHarness(LINEAR, async ({ runtime, ledger, graphId }) => {
      runtime.start(NOW);
      const started = storedState(ledger, graphId);
      ledger.writeGraphState({
        ...started,
        planRevision: "revision-from-elsewhere",
        updatedAt: NOW + 1,
      });

      const resumed = runtime.resume(NOW + 2);
      expect(resumed.kind).toBe("refused");
      if (resumed.kind === "refused") {
        expect(resumed.refusals.map((refusal) => refusal.code)).toEqual([
          "plan-revision-mismatch",
        ]);
      }
    });
  });
});

describe("legacy v2 graphs keep the file store and their run path", () => {
  it("runs a legacy graph through the state directory unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-file-store-"));
    try {
      const ts = createGraphToolSet({
        stateDir: dir,
        dispatch: new CompletingDispatch(),
      });
      const { graph_id } = ts.graph_create({ name: "legacy-graph" });
      ts.graph_add_node({
        graph_id,
        id: "A",
        agent: "a",
        prompt: "pA",
      });
      await ts.graph_run({ graph_id });
      await settle();

      const state = ts["getEntry"](graph_id).runtime.status();
      expect(state.phase).toBe("complete");
      expect(state.nodes.get("A")?.status).toBe("completed");
      // The legacy store is still the JSON file the legacy path owns.
      expect(existsSync(engineStatePath(dir, graph_id))).toBe(true);
      // No ledger was created by a legacy run.
      expect(existsSync(ledgerFilePath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
