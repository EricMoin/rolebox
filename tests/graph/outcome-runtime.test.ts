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
 * mid-transaction failure leaving nothing, loop continuation and the durable STOP
 * its hard cap ends the run with (the outcome stays accepted, the refused round is
 * not taken, an in-flight branch is refused rather than settled, the stop
 * fabricates no accepted event, and a stop whose state write fails rolls the
 * whole acceptance back with it),
 * the missing-handler refusal, and the legacy v2 run path still working through
 * the file store over an existing record (a NEW durable legacy record is
 * refused by the E gate — see tests/graph/legacy-creation-gate.test.ts).
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
  type OutcomeSubmissionResult,
} from "../../src/graph/outcome/runtime.ts";
import type {
  OutcomeLoopProgress,
  ProgressReport,
} from "../../src/graph/outcome/progress.ts";
import {
  CURRENT_OUTCOME_STATE_BODY,
  OUTCOME_STATE_BODY_V5,
  OutcomeStateError,
  type OutcomeGraphState,
} from "../../src/graph/outcome/graph-state.ts";
import {
  attemptCredentialDigest,
  type AttemptCredentialSource,
} from "../../src/graph/outcome/attempt-credential.ts";
import type {
  AcceptanceLedger,
  AcceptanceLedgerTx,
  GraphStateRecord,
} from "../../src/graph/ledger/types.ts";
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
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";
import {
  EnginePersistence,
  engineStatePath,
} from "../../src/graph/engine/engine-persistence.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
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

/**
 * The loop of {@link loopDeclaration} plus an INDEPENDENT branch: "work" also
 * routes to "side", so the run arms a second branch beside the loop.
 *
 * The branch is what makes the stop's SCOPE observable. When the loop hits its
 * cap while "side" is still in flight, the run must decide whether it stops only
 * the loop or the whole run; this build stops the run (see the decision stated
 * in graph-state.ts), so the branch is left in flight rather than settled and no
 * successor of the capped outcome is armed.
 */
function sideBranchLoopDeclaration(maxTraversals: number): GraphDeclarationV3 {
  const loop = loopDeclaration(maxTraversals);
  return {
    ...loop,
    name: "graph.loop-side",
    nodes: [
      ...loop.nodes,
      { id: "side", agent: "agent.side", prompt: "Side work.", outcomes: [{ id: "finish" }] },
    ],
    edges: [...loop.edges, { from: "work", to: "side", outcome: "done" }],
  };
}

/**
 * arb splits into brc and crb, which both converge on djoin. The convergence
 * node declares join:all, so its attempt may be minted ONLY once both branches
 * have arrived — the reproduced defect was djoin being armed twice, on #4 and
 * then #5, with the attempt in flight overwritten by the second arm.
 */
const DIAMOND_ALL: GraphDeclarationV3 = {
  version: 3,
  name: "graph.diamond-all",
  nodes: [
    { id: "arb", agent: "agent.arb", prompt: "Split.", outcomes: [{ id: "split" }] },
    { id: "brc", agent: "agent.brc", prompt: "Branch B.", outcomes: [{ id: "done" }] },
    { id: "crb", agent: "agent.crb", prompt: "Branch C.", outcomes: [{ id: "done" }] },
    {
      id: "djoin",
      agent: "agent.djoin",
      prompt: "Join.",
      outcomes: [{ id: "merged" }],
      join: { strategy: "all" },
    },
  ],
  edges: [
    { from: "arb", to: "brc", outcome: "split" },
    { from: "arb", to: "crb", outcome: "split" },
    { from: "brc", to: "djoin", outcome: "done" },
    { from: "crb", to: "djoin", outcome: "done" },
  ],
};

/**
 * The same diamond with join:any: the FIRST branch arms djoin, and the second
 * branch then arrives while djoin is already in flight — the exact shape in
 * which the old reducer overwrote the running attempt with a new one.
 */
const DIAMOND_ANY: GraphDeclarationV3 = {
  ...DIAMOND_ALL,
  name: "graph.diamond-any",
  nodes: DIAMOND_ALL.nodes.map((node) =>
    node.id === "djoin"
      ? { ...node, join: { strategy: "any" as const } }
      : node,
  ),
};

/**
 * A loop whose convergence node is a real join: the splitter s fans out to a
 * and b, which converge on j with join:all, and j's continuation re-enters the
 * loop at s. Every round therefore has to wait for BOTH a and b again — a
 * previous round's arrival must not satisfy the new round's join.
 */
function loopJoinDeclaration(maxTraversals: number): GraphDeclarationV3 {
  return {
    version: 3,
    name: "graph.loop-join",
    nodes: [
      { id: "s", agent: "agent.s", prompt: "Open a round.", outcomes: [{ id: "next" }] },
      { id: "a", agent: "agent.a", prompt: "Branch A.", outcomes: [{ id: "done" }] },
      { id: "b", agent: "agent.b", prompt: "Branch B.", outcomes: [{ id: "done" }] },
      {
        id: "j",
        agent: "agent.j",
        prompt: "Join.",
        outcomes: [{ id: "again" }, { id: "exit" }],
        join: { strategy: "all" },
      },
    ],
    edges: [
      { from: "s", to: "a", outcome: "next" },
      { from: "s", to: "b", outcome: "next" },
      { from: "a", to: "j", outcome: "done" },
      { from: "b", to: "j", outcome: "done" },
      { from: "j", to: "s", outcome: "again" },
    ],
    loop_groups: [
      {
        id: "rounds",
        nodes: ["s", "a", "b", "j"],
        max_traversals: maxTraversals,
        continuation_outcome: "again",
        exit_outcome: "exit",
      },
    ],
  };
}

/**
 * A loop whose convergence nodes depend on EACH OTHER: c1's quorum needs two of
 * {z, e, c3}, c2's join needs e and c1, and c3's needs e and c2 — so c1 depends
 * on c3, c3 on c2 and c2 on c1, a cycle of candidates. `z` is the outside
 * satisfier that lets the cycle bootstrap (c1 is armed by e + z) and `w`
 * withdraws it again, so a later `e` advance finds all three settled with every
 * one of them depending on another member being re-armed in the same breath.
 */
function joinCycleDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: "graph.join-cycle",
    nodes: [
      { id: "a0", agent: "agent.a0", prompt: "Seed.", outcomes: [{ id: "clear" }] },
      { id: "u", agent: "agent.u", prompt: "Reset.", outcomes: [{ id: "reset" }] },
      { id: "v", agent: "agent.v", prompt: "Boot.", outcomes: [{ id: "boot" }] },
      { id: "w", agent: "agent.w", prompt: "Second seed.", outcomes: [{ id: "clear" }] },
      {
        id: "z",
        agent: "agent.z",
        prompt: "Relay.",
        outcomes: [{ id: "seed" }],
        join: { strategy: "any" },
      },
      {
        id: "e",
        agent: "agent.e",
        prompt: "Split.",
        outcomes: [{ id: "go" }],
        join: { strategy: "any" },
      },
      {
        id: "c1",
        agent: "agent.c1",
        prompt: "C1.",
        outcomes: [{ id: "done" }],
        join: { strategy: "quorum", quorum: 2 },
      },
      {
        id: "c2",
        agent: "agent.c2",
        prompt: "C2.",
        outcomes: [{ id: "done" }],
        join: { strategy: "all" },
      },
      {
        id: "c3",
        agent: "agent.c3",
        prompt: "C3.",
        outcomes: [{ id: "done" }, { id: "again" }, { id: "exit" }],
        join: { strategy: "all" },
      },
    ],
    edges: [
      { from: "a0", to: "z", outcome: "clear" },
      { from: "w", to: "z", outcome: "clear" },
      { from: "z", to: "c1", outcome: "seed" },
      { from: "u", to: "e", outcome: "reset" },
      { from: "v", to: "e", outcome: "boot" },
      { from: "e", to: "c1", outcome: "go" },
      { from: "e", to: "c2", outcome: "go" },
      { from: "e", to: "c3", outcome: "go" },
      { from: "c1", to: "c2", outcome: "done" },
      { from: "c2", to: "c3", outcome: "done" },
      { from: "c3", to: "c1", outcome: "done" },
      { from: "c3", to: "e", outcome: "again" },
    ],
    loop_groups: [
      {
        id: "rounds",
        nodes: ["a0", "u", "v", "w", "z", "e", "c1", "c2", "c3"],
        max_traversals: 20,
        continuation_outcome: "again",
        exit_outcome: "exit",
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
      credentialIsolation: testHostCredentialIsolation(dir),
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
      hasCredentialDigest: node.attemptCredentialDigest !== undefined,
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

/**
 * The SAME ledger, with `writeGraphState` refused for the state bodies a
 * predicate names. Every other call — including `runInTransaction`, whose
 * callback receives this wrapper — is the real store's, so a caller's
 * acceptance batch really writes its receipt, accepted event and effects before
 * the refused state write throws and the real transaction rolls the whole batch
 * back. This aims a storage failure at ONE state write (the stop) instead of
 * failing every transaction.
 */
function ledgerRefusingStateWrites(
  inner: SqliteAcceptanceLedger,
  refuse: (record: GraphStateRecord) => boolean,
): AcceptanceLedger {
  const refuseWrite = (record: GraphStateRecord): void => {
    if (refuse(record)) {
      throw new Error("fixture: the graph-state write was refused (storage failure)");
    }
  };
  const wrapTx = (tx: AcceptanceLedgerTx): AcceptanceLedgerTx => ({
    commitAccepted: (batch) => tx.commitAccepted(batch),
    readGraphState: (graphId) => tx.readGraphState(graphId),
    writeGraphState: (record) => {
      refuseWrite(record);
      tx.writeGraphState(record);
    },
    writeEffect: (record) => tx.writeEffect(record),
    lookupReceipt: (key) => tx.lookupReceipt(key),
    acceptedEvents: (graphId) => tx.acceptedEvents(graphId),
    pendingEffects: (graphId) => tx.pendingEffects(graphId),
    markEffectStarted: (graphId, effectId) => tx.markEffectStarted(graphId, effectId),
    markEffectDone: (graphId, effectId) => tx.markEffectDone(graphId, effectId),
    markEffectFailed: (graphId, effectId) => tx.markEffectFailed(graphId, effectId),
  });
  return {
    ledgerFormatVersion: inner.ledgerFormatVersion,
    commitAccepted: (batch) => inner.commitAccepted(batch),
    readGraphState: (graphId) => inner.readGraphState(graphId),
    writeGraphState: (record) => {
      refuseWrite(record);
      inner.writeGraphState(record);
    },
    writeEffect: (record) => inner.writeEffect(record),
    lookupReceipt: (key) => inner.lookupReceipt(key),
    acceptedEvents: (graphId) => inner.acceptedEvents(graphId),
    pendingEffects: (graphId) => inner.pendingEffects(graphId),
    markEffectStarted: (graphId, effectId) => inner.markEffectStarted(graphId, effectId),
    markEffectDone: (graphId, effectId) => inner.markEffectDone(graphId, effectId),
    markEffectFailed: (graphId, effectId) => inner.markEffectFailed(graphId, effectId),
    runInTransaction: <R>(fn: (tx: AcceptanceLedgerTx) => R): R =>
      inner.runInTransaction((tx) => fn(wrapTx(tx))),
    close: () => inner.close(),
  };
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
      // ONE unsettled effect: `start()` committed the entry attempt's intent
      // and this acceptance settled that attempt (its effect is DONE) while
      // committing the successor's. The successor's row is the D8 intent.
      const effects = ledger.pendingEffects(graphId);
      expect(effects).toHaveLength(1);
      expect(effects[0]?.effectId).toBe("dispatch:ship#2");
      const successorEffect = effects[0];
      expect(successorEffect?.kind).toBe("dispatch");
      // The effect row records the attempt that PRODUCED it (the trusted
      // context); the dispatch it carries names the successor's fresh attempt.
      expect(successorEffect?.attemptId).toBe("work#1");
      expect(fieldOf(successorEffect?.payload, "nodeId")).toBe("ship");
      expect(fieldOf(successorEffect?.payload, "attemptId")).toBe("ship#2");
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
      // EVERY dispatch effect is settled once its attempt settled (D8): a
      // terminal graph holds no unsettled row for a recovery to act on.
      expect(ledger.pendingEffects(graphId)).toEqual([]);
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
      // The refusal wrote nothing: the only unsettled effect is the one
      // `start()` committed with the starting snapshot, not a successor's.
      expect(ledger.pendingEffects(graphId).map((effect) => effect.effectId)).toEqual([
        "dispatch:work#1",
      ]);
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
      if (stateAfterFirst === undefined) {
        throw new Error("fixture: graph " + graphId + " wrote no state");
      }
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
        // graph does not move: no event, no successor effect, no state change,
        // no successor dispatched. The only unsettled row is the entry attempt's
        // own dispatch, committed by `start()`.
        expect(ledger.acceptedEvents(graphId)).toHaveLength(0);
        expect(ledger.pendingEffects(graphId).map((effect) => effect.effectId)).toEqual([
          "dispatch:work#1",
        ]);
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

  it("answers a repeated submission with the persisted rejection when the gate passes later", async () => {
    // Two runtimes over ONE ledger: the gate's answer changes between two
    // submissions of the SAME content, which is the only way to reach a replay
    // whose re-evaluation disagrees with the receipt the ledger already holds.
    const dir = mkdtempSync(join(tmpdir(), "outcome-runtime-replay-decision-"));
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const declared = buildDeclaredOutcomeGraph({
        declaration: GATED,
        supportedValidators: [{ validator: GATE_ID, version: GATE_VERSION }],
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
        });
      const proposal = () => ({
        nodeId: "work",
        outcomeId: "done",
        credential: credentialOf(requests, "work#1"),
      });

      const failing = build(gatedRegistry({ kind: "fail", reason: "not yet" }));
      expect(failing.start(NOW).kind).toBe("started");
      const first = failing.submit(proposal(), NOW + 1);
      expect(first.kind).toBe("rejected");
      if (first.kind !== "rejected") return;
      const stateAfterRejection = JSON.stringify(
        ledger.readGraphState(declared.graphId),
      );

      // The gate passes now, but the submission key was already decided: the
      // SAME persisted rejection is the answer, not a fresh acceptance.
      const passing = build(gatedRegistry({ kind: "pass" }));
      const second = passing.submit(proposal(), NOW + 2);
      expect(second.kind).toBe("rejected");
      if (second.kind !== "rejected") return;
      expect(second.decision.kind).toBe("rejected");
      expect(second.receipt).toEqual(first.receipt);
      expect(second.receipt.decision).toBe("rejected");
      expect(JSON.stringify(ledger.readGraphState(declared.graphId))).toBe(
        stateAfterRejection,
      );
      expect(ledger.acceptedEvents(declared.graphId)).toHaveLength(0);

      // A DIFFERENT submission — the worker repaired the input, so its content
      // address is new — settles the attempt the rejection left open.
      const repaired = passing.submit({ ...proposal(), data: { attempt: 2 } }, NOW + 3);
      expect(repaired.kind).toBe("accepted");
      if (repaired.kind === "accepted") {
        expect(nodeOf(repaired.state, "work").status).toBe("settled");
      }
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("stops the run at the hard cap: the outcome is accepted, the stop is durable and no round past the limit runs", async () => {
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
      const eventsBefore = ledger.acceptedEvents(graphId).length;
      const dispatchesBefore = attemptIds(requests);

      const overCap = runtime.submit(
        { nodeId: "review", outcomeId: "revise", credential: credentialOf(requests, "review#4") },
        NOW + 4,
      );
      // CHANGED (defect 3): this used to be `refused` with the whole acceptance
      // rolled back, which left the graph executing forever with no durable
      // record of why. The outcome that asks for an over-cap round is a real,
      // ACCEPTED result; what the cap refuses is the CONTINUATION.
      expect(overCap.kind).toBe("accepted");
      if (overCap.kind !== "accepted") return;
      expect(overCap.replayed).toBe(false);
      expect(overCap.decision.kind).toBe("accepted");
      expect(overCap.receipt.decision).toBe("accepted");
      // The refused round is NOT taken: the counter stays on the cap and no
      // attempt is minted, so nothing runs one round past the limit.
      expect(overCap.state.loopTraversals["revise-loop"]).toBe(1);
      expect(overCap.dispatched).toEqual([]);
      expect(attemptIds(requests)).toEqual(dispatchesBefore);
      // CHANGED: the durable stop replaces "the graph is still where it was".
      // The reason is from the closed vocabulary, the round and cap are the
      // declared numbers, and the trigger is the attempt that asked to continue.
      expect(overCap.state.phase).toBe("stopped");
      expect(overCap.stop).toEqual({
        reason: "loop-exhausted",
        loopGroupId: "revise-loop",
        nodeId: "review",
        outcomeId: "revise",
        attemptId: "review#4",
        traversals: 1,
        maxTraversals: 1,
        stoppedAt: NOW + 4,
      });
      // The accepted outcome settled its own node — that is the acceptance, and
      // the stop fabricates nothing beyond it.
      expect(nodeOf(overCap.state, "review")).toMatchObject({
        status: "settled",
        outcomeId: "revise",
        attemptId: "review#4",
      });
      // CHANGED: one receipt and one accepted event ARE committed now, in the
      // SAME transaction as the state that carries the stop — the crash window
      // cannot separate "the continuation was refused" from "the stop is
      // recorded". The counts used to be asserted unchanged.
      expect(await countTable(dir, "ledger_receipts")).toBe(receiptsBefore + 1);
      const events = ledger.acceptedEvents(graphId);
      expect(events).toHaveLength(eventsBefore + 1);
      expect(events[events.length - 1]?.attemptId).toBe("review#4");
      expect(events[events.length - 1]?.outcomeId).toBe("revise");
      // The committed state IS the state a reader gets back: the stop survives
      // the store, and the graph no longer reports executing.
      const reread = runtime.state();
      expect(reread).toEqual(overCap.state);
      expect(reread?.phase).toBe("stopped");
      expect(before?.phase).toBe("executing");
    });
  });

  it("commits the stop and the acceptance in ONE transaction: a state write that fails takes both sides with it", async () => {
    await withHarness(
      loopDeclaration(1),
      async ({ runtime, plan, ledger, graphId, dir, credentialOf }) => {
        runtime.start(NOW);
        runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf("work#1") },
          NOW + 1,
        );
        runtime.submit(
          { nodeId: "review", outcomeId: "revise", credential: credentialOf("review#2") },
          NOW + 2,
        );
        runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf("work#3") },
          NOW + 3,
        );
        const before = runtime.state();
        expect(before?.phase).toBe("executing");
        const receiptsBefore = await countTable(dir, "ledger_receipts");
        const eventsBefore = ledger.acceptedEvents(graphId).length;
        const effectsBefore = ledger.pendingEffects(graphId).length;

        // THE STOP'S CRASH WINDOW. The stopping submission goes through a ledger
        // whose graph-state write is refused for the stop body. The acceptance
        // batch — receipt, accepted event and effects — has ALREADY been written
        // inside the same transaction when that write throws, so only one shared
        // atomic boundary keeps the window from leaving "the continuation was
        // refused but no stop was recorded", or a stop whose state never moved.
        // `refusedWrites` proves the failure landed ON that write, after the
        // batch: a batch that failed first would never reach it.
        const refusedWrites: string[] = [];
        const guarded = new OutcomeGraphRuntime({
          plan,
          ledger: ledgerRefusingStateWrites(ledger, (record) => {
            const phase = fieldOf(record.body, "phase");
            if (phase === "stopped") {
              refusedWrites.push(String(phase));
              return true;
            }
            return false;
          }),
          dispatch: () => {},
          validators: EMPTY_VALIDATORS,
          artifactRoot: dir,
          credentialIsolation: testHostCredentialIsolation(dir),
          clock: () => NOW,
          mintCredential: TEST_CREDENTIAL_SOURCE,
        });
        expect(() =>
          guarded.submit(
            { nodeId: "review", outcomeId: "revise", credential: credentialOf("review#4") },
            NOW + 4,
          ),
        ).toThrow("the graph-state write was refused");
        expect(refusedWrites).toEqual(["stopped"]);

        // Nothing from the refused transaction survives — no stop, no moved
        // phase, no receipt, no accepted event, no effect. The store is exactly
        // the state it held before the submission.
        expect(runtime.state()).toEqual(before);
        expect(runtime.state()?.stop).toBeUndefined();
        expect(ledger.acceptedEvents(graphId)).toHaveLength(eventsBefore);
        expect(ledger.pendingEffects(graphId)).toHaveLength(effectsBefore);
        expect(await countTable(dir, "ledger_receipts")).toBe(receiptsBefore);

        // ...and the rollback left no poisoned replay key: the SAME submission
        // over the real store commits both halves together.
        const stopped = runtime.submit(
          { nodeId: "review", outcomeId: "revise", credential: credentialOf("review#4") },
          NOW + 5,
        );
        expect(stopped.kind).toBe("accepted");
        if (stopped.kind !== "accepted") return;
        expect(stopped.state.phase).toBe("stopped");
        expect(stopped.stop?.reason).toBe("loop-exhausted");
        expect(await countTable(dir, "ledger_receipts")).toBe(receiptsBefore + 1);
      },
    );
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
        // CHANGED (defect 3): accepted, not refused — and the stop NAMES the
        // group whose cap actually binds (`b-inner`), which is the assertion the
        // old refusal message carried. `a-outer` is declared FIRST but does not
        // take `revise` as its continuation, so its counter must not move.
        expect(overCap.kind).toBe("accepted");
        if (overCap.kind !== "accepted") return;
        expect(overCap.stop?.loopGroupId).toBe("b-inner");
        expect(overCap.stop?.reason).toBe("loop-exhausted");
        // The stop union is discriminated by reason: narrow before reading the
        // fields a hard-cap stop alone defines.
        if (overCap.stop?.reason !== "loop-exhausted") {
          throw new Error("fixture: expected a loop-exhausted stop");
        }
        expect(overCap.stop.traversals).toBe(1);
        expect(overCap.stop.maxTraversals).toBe(1);
        expect(overCap.state.loopTraversals["b-inner"]).toBe(1);
        expect(overCap.state.loopTraversals["a-outer"]).toBeUndefined();
        // CHANGED: the state DID move — it now carries the stop and the settled
        // trigger — while the counters, the receipts before this submission and
        // the dispatches are what stays put. One receipt and one accepted event
        // commit with the stop; no successor is armed.
        expect(before?.phase).toBe("executing");
        expect(overCap.state.phase).toBe("stopped");
        expect(overCap.dispatched).toEqual([]);
        expect(await countTable(dir, "ledger_receipts")).toBe(receiptsBefore + 1);
        expect(ledger.acceptedEvents(graphId)).toHaveLength(eventsBefore + 1);
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
        const receiptsBefore = await countTable(dir, "ledger_receipts");
        const eventsBefore = ledger.acceptedEvents(graphId).length;
        const dispatchesBefore = attemptIds(requests);
        const overCap = runtime.submit(
          { nodeId: "review", outcomeId: "revise", credential: credentialOf(requests, "review#4") },
          NOW + 4,
        );
        // CHANGED (defect 3): accepted with a stop, not a refusal. b-loose alone
        // would still admit this round; a-tight's cap is what binds, and it binds
        // for the WHOLE continuation — the stop names a-tight and NEITHER counter
        // advances, which is what "the round was not taken" means for a
        // continuation that re-enters two groups at once.
        expect(overCap.kind).toBe("accepted");
        if (overCap.kind !== "accepted") return;
        expect(overCap.stop?.loopGroupId).toBe("a-tight");
        if (overCap.stop?.reason !== "loop-exhausted") {
          throw new Error("fixture: expected a loop-exhausted stop");
        }
        expect(overCap.stop.maxTraversals).toBe(1);
        expect(overCap.state.loopTraversals).toEqual({
          "a-tight": 1,
          "b-loose": 1,
        });
        expect(overCap.dispatched).toEqual([]);
        expect(attemptIds(requests)).toEqual(dispatchesBefore);
        expect(await countTable(dir, "ledger_receipts")).toBe(receiptsBefore + 1);
        expect(ledger.acceptedEvents(graphId)).toHaveLength(eventsBefore + 1);
      },
    );
  });

  it("stops the WHOLE run: a branch still in flight is refused, never settled", async () => {
    await withHarness(
      sideBranchLoopDeclaration(1),
      async ({ runtime, ledger, requests, graphId, dir }) => {
        runtime.start(NOW);
        // work -> {review, side}: the side branch is in flight from here on.
        const worked = runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
          NOW + 1,
        );
        expect(worked.kind).toBe("accepted");
        if (worked.kind !== "accepted") return;
        expect(attemptIds(worked.dispatched)).toEqual(["review#2", "side#3"]);

        const revised = runtime.submit(
          { nodeId: "review", outcomeId: "revise", credential: credentialOf(requests, "review#2") },
          NOW + 2,
        );
        expect(revised.kind).toBe("accepted");
        if (revised.kind !== "accepted") return;
        expect(attemptIds(revised.dispatched)).toEqual(["work#4"]);

        const workedAgain = runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#4") },
          NOW + 3,
        );
        expect(workedAgain.kind).toBe("accepted");
        if (workedAgain.kind !== "accepted") return;
        // The loop re-enters review on a fresh attempt; side stays in flight.
        expect(attemptIds(workedAgain.dispatched)).toEqual(["review#5"]);

        const receiptsBefore = await countTable(dir, "ledger_receipts");
        const eventsBefore = ledger.acceptedEvents(graphId).length;
        const dispatchesBefore = attemptIds(requests);

        const stopped = runtime.submit(
          { nodeId: "review", outcomeId: "revise", credential: credentialOf(requests, "review#5") },
          NOW + 4,
        );
        expect(stopped.kind).toBe("accepted");
        if (stopped.kind !== "accepted") return;
        expect(stopped.state.phase).toBe("stopped");
        expect(stopped.stop?.loopGroupId).toBe("revise-loop");
        expect(stopped.stop?.attemptId).toBe("review#5");
        // THE CHOICE, OBSERVED: the independent branch is exactly where it was —
        // in flight on the attempt it was dispatched with, NOT settled by an
        // outcome nobody submitted, and NOT re-armed.
        expect(nodeOf(stopped.state, "side")).toMatchObject({
          status: "dispatched",
          attemptId: "side#3",
        });
        expect(stopped.dispatched).toEqual([]);
        expect(attemptIds(requests)).toEqual(dispatchesBefore);

        // Its worker's outcome is refused BY NAME — the run has ended, so the
        // outcome is not accepted into a graph that cannot carry it.
        const late = runtime.submit(
          { nodeId: "side", outcomeId: "finish", credential: credentialOf(requests, "side#3") },
          NOW + 5,
        );
        expect(late.kind).toBe("refused");
        if (late.kind !== "refused") return;
        expect(late.refusals.map((refusal) => refusal.code)).toEqual(["graph-stopped"]);
        expect(late.refusals[0]?.message).toContain("loop-exhausted");
        // Nothing was written: the branch is still in flight, the stop is intact,
        // and only the stopping submission added a receipt and an event.
        expect(runtime.state()).toEqual(stopped.state);
        expect(await countTable(dir, "ledger_receipts")).toBe(receiptsBefore + 1);
        expect(ledger.acceptedEvents(graphId)).toHaveLength(eventsBefore + 1);
        expect(attemptIds(requests)).toEqual(dispatchesBefore);
      },
    );
  });

  it("replays the stopping submission and clears nothing", async () => {
    await withHarness(loopDeclaration(1), async ({ runtime, ledger, requests, graphId, dir }) => {
      runtime.start(NOW);
      runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
        NOW + 1,
      );
      runtime.submit(
        { nodeId: "review", outcomeId: "revise", credential: credentialOf(requests, "review#2") },
        NOW + 2,
      );
      runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#3") },
        NOW + 3,
      );
      const proposal = {
        nodeId: "review",
        outcomeId: "revise",
        credential: credentialOf(requests, "review#4"),
      };
      const stopping = runtime.submit(proposal, NOW + 4);
      expect(stopping.kind).toBe("accepted");
      if (stopping.kind !== "accepted") return;
      const receiptsAfter = await countTable(dir, "ledger_receipts");
      const eventsAfter = ledger.acceptedEvents(graphId).length;

      // The SAME logical submission again: the ledger replays the persisted
      // receipt, the state does not move and the stop is not cleared or
      // re-decided — a stopped run is not resumed by repeating its last message.
      const replay = runtime.submit(proposal, NOW + 5);
      expect(replay.kind).toBe("accepted");
      if (replay.kind !== "accepted") return;
      expect(replay.replayed).toBe(true);
      expect(replay.decision.identity.submissionId).toBe(
        stopping.decision.identity.submissionId,
      );
      expect(replay.dispatched).toEqual([]);
      expect(replay.state).toEqual(stopping.state);
      expect(replay.stop).toEqual(stopping.stop);
      expect(await countTable(dir, "ledger_receipts")).toBe(receiptsAfter);
      expect(ledger.acceptedEvents(graphId)).toHaveLength(eventsAfter);
      expect(attemptIds(requests)).toEqual(["work#1", "review#2", "work#3", "review#4"]);
    });
  });

  it("fabricates no accepted event: every settlement is one a worker submitted", async () => {
    await withHarness(loopDeclaration(1), async ({ runtime, ledger, requests, graphId }) => {
      runtime.start(NOW);
      runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
        NOW + 1,
      );
      runtime.submit(
        { nodeId: "review", outcomeId: "revise", credential: credentialOf(requests, "review#2") },
        NOW + 2,
      );
      runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#3") },
        NOW + 3,
      );
      const stopping = runtime.submit(
        { nodeId: "review", outcomeId: "revise", credential: credentialOf(requests, "review#4") },
        NOW + 4,
      );
      expect(stopping.kind).toBe("accepted");
      if (stopping.kind !== "accepted") return;
      expect(stopping.state.phase).toBe("stopped");

      // The accepted-event stream is the WORKERS' answers, in order, and nothing
      // else: the stop substitutes no outcome (the loop's exit "approve" is never
      // written), invents no attempt, and settles no node that did not answer.
      const events = ledger.acceptedEvents(graphId);
      expect(events.map((event) => event.attemptId + ":" + event.outcomeId)).toEqual([
        "work#1:done",
        "review#2:revise",
        "work#3:done",
        "review#4:revise",
      ]);
      expect(events.some((event) => event.outcomeId === "approve")).toBe(false);

      // Every settled node is corroborated by EXACTLY its own event, with the
      // outcome and attempt the state records — the state cannot settle anything
      // the event stream does not account for.
      const settled = stopping.state.nodes.filter((node) => node.status === "settled");
      expect(settled.map((node) => node.nodeId).sort()).toEqual(["review", "work"]);
      expect(
        settled.map((node) => {
          const own = events.filter((event) => event.attemptId === node.attemptId);
          expect(own).toHaveLength(1);
          return {
            node: node.nodeId,
            recorded: node.outcomeId,
            accepted: own[0]?.outcomeId,
            attempt: node.attemptId,
          };
        }),
      ).toEqual([
        { node: "review", recorded: "revise", accepted: "revise", attempt: "review#4" },
        { node: "work", recorded: "done", accepted: "done", attempt: "work#3" },
      ]);
      // The loop never advanced past its cap either.
      expect(stopping.state.loopTraversals["revise-loop"]).toBe(1);
    });
  });
});

// ── The join gate ───────────────────────────────────────────────────────────

// ── Loop progress: the declared comparison and its stopping policy (D5) ─────

/**
 * work -> review -> (revise) -> work with a DECLARED PROGRESS POLICY: the
 * continuation must carry the declared `revision` token (the comparison
 * object), and `max_unchanged` consecutive unchanged tokens stop the run.
 */
function progressLoopDeclaration(options: {
  readonly maxTraversals: number;
  readonly maxUnchanged: number;
  readonly version?: number;
  readonly evaluator?: string;
}): GraphDeclarationV3 {
  return {
    version: 3,
    name: "graph.progress",
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
        max_traversals: options.maxTraversals,
        continuation_outcome: "revise",
        exit_outcome: "approve",
        progress: {
          evaluator: options.evaluator ?? "revision-token",
          version: options.version ?? 1,
          subject: "revision",
          max_unchanged: options.maxUnchanged,
        },
      },
    ],
  };
}

/**
 * The same loop declared as TWO groups that BOTH take "revise" as their
 * continuation and BOTH declare a progress policy: one comparison is a fact
 * about the accepted outcome for every governing group, so both counters
 * advance, and the first group in plan order that reaches its threshold stops
 * the run. The other may stand ON its own threshold in the same committed body,
 * which the reader accepts because the body IS stopped by the progress policy.
 */
function twoPolicyProgressDeclaration(
  maxUnchangedFirst: number,
  maxUnchangedSecond: number,
): GraphDeclarationV3 {
  return {
    version: 3,
    name: "graph.progress-two-policies",
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
        id: "a-first",
        nodes: ["work", "review"],
        max_traversals: 20,
        continuation_outcome: "revise",
        exit_outcome: "approve",
        progress: {
          evaluator: "revision-token",
          version: 1,
          subject: "revision",
          max_unchanged: maxUnchangedFirst,
        },
      },
      {
        id: "b-second",
        nodes: ["work", "review"],
        max_traversals: 20,
        continuation_outcome: "revise",
        exit_outcome: "approve",
        progress: {
          evaluator: "revision-token",
          version: 1,
          subject: "revision",
          max_unchanged: maxUnchangedSecond,
        },
      },
    ],
  };
}

/** The same loop with a side branch, so the stop scope is observable. */
function progressSideBranchDeclaration(maxUnchanged: number): GraphDeclarationV3 {
  const base = sideBranchLoopDeclaration(20);
  const group = (base.loop_groups ?? [])[0];
  if (group === undefined) throw new Error("fixture: the loop declares no group");
  return {
    ...base,
    name: "graph.progress-side",
    loop_groups: [
      {
        ...group,
        progress: {
          evaluator: "revision-token",
          version: 1,
          subject: "revision",
          max_unchanged: maxUnchanged,
        },
      },
    ],
  };
}

/** Drive the loop's work half: work answers done, arming the review attempt. */
function workStep(
  runtime: OutcomeGraphRuntime,
  requests: readonly OutcomeDispatchRequest[],
  workAttempt: string,
  at: number,
): OutcomeSubmissionResult {
  const worked = runtime.submit(
    { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, workAttempt) },
    at,
  );
  expect(worked.kind).toBe("accepted");
  return worked;
}

/** Drive one loop round: work answers done, review answers revise with a token. */
function reviseRound(
  runtime: OutcomeGraphRuntime,
  requests: readonly OutcomeDispatchRequest[],
  workAttempt: string,
  reviewAttempt: string,
  revision: unknown,
  at: number,
): OutcomeSubmissionResult {
  const worked = runtime.submit(
    { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, workAttempt) },
    at,
  );
  expect(worked.kind).toBe("accepted");
  return runtime.submit(
    {
      nodeId: "review",
      outcomeId: "revise",
      credential: credentialOf(requests, reviewAttempt),
      data: { revision },
    },
    at + 1,
  );
}

/** The ONE progress report of an accepted continuation. */
function onlyProgress(reports: readonly ProgressReport[] | undefined): ProgressReport {
  expect(reports).toHaveLength(1);
  const report = (reports ?? [])[0];
  if (report === undefined) throw new Error("fixture: no progress report");
  return report;
}

/** One loop group persisted progress, failing when the state carries none. */
function progressEntry(state: OutcomeGraphState, groupId: string): OutcomeLoopProgress {
  const entry = state.loopProgress?.[groupId];
  if (entry === undefined) throw new Error("fixture: no progress entry for " + groupId);
  return entry;
}

/** Read one field of an unknown value as a record, or fail the fixture. */
function recordOf(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("fixture: " + what + " is not a record");
  }
  return value as Record<string, unknown>;
}

describe("OutcomeGraphRuntime — loop progress is compared across rounds", () => {
  it("answers progressed, unchanged and unknown for the declared comparison object", async () => {
    await withHarness(
      progressLoopDeclaration({ maxTraversals: 20, maxUnchanged: 3 }),
      async ({ runtime, requests }) => {
        runtime.start(NOW);

        // A FIRST comparable token establishes the baseline: there was no
        // earlier value to stand still against, so the run has not been
        // observed to repeat itself.
        const first = reviseRound(runtime, requests, "work#1", "review#2", "r1", NOW + 1);
        expect(first.kind).toBe("accepted");
        if (first.kind !== "accepted") return;
        expect(onlyProgress(first.progress)).toEqual({
          loopGroupId: "revise-loop",
          verdict: "progressed",
          evaluator: "revision-token",
          version: 1,
          subject: "revision",
          unchanged: 0,
          baseline: "r1",
          stalled: false,
        });
        // The baseline is PERSISTED in the same acceptance that produced it.
        expect(progressEntry(first.state, "revise-loop")).toEqual({
          loopGroupId: "revise-loop",
          evaluator: "revision-token",
          version: 1,
          subject: "revision",
          unchanged: 0,
          baseline: "r1",
        });

        const same = reviseRound(runtime, requests, "work#3", "review#4", "r1", NOW + 3);
        expect(same.kind).toBe("accepted");
        if (same.kind !== "accepted") return;
        expect(onlyProgress(same.progress)).toMatchObject({
          verdict: "unchanged",
          unchanged: 1,
          baseline: "r1",
          stalled: false,
        });

        const moved = reviseRound(runtime, requests, "work#5", "review#6", "r2", NOW + 5);
        expect(moved.kind).toBe("accepted");
        if (moved.kind !== "accepted") return;
        expect(onlyProgress(moved.progress)).toMatchObject({
          verdict: "progressed",
          unchanged: 0,
          baseline: "r2",
        });

        // A value longer than the bound is TRUNCATED and never compared by
        // prefix: this one starts with the baseline it would otherwise match.
        const truncated = reviseRound(
          runtime,
          requests,
          "work#7",
          "review#8",
          "r2" + "x".repeat(300),
          NOW + 7,
        );
        expect(truncated.kind).toBe("accepted");
        if (truncated.kind !== "accepted") return;
        expect(onlyProgress(truncated.progress)).toEqual({
          loopGroupId: "revise-loop",
          verdict: "unknown",
          unknownReason: "truncated-value",
          evaluator: "revision-token",
          version: 1,
          subject: "revision",
          unchanged: 0,
          baseline: "r2",
          stalled: false,
        });
        expect(progressEntry(truncated.state, "revise-loop").baseline).toBe("r2");

        // A present but non-token value is legal payload this evaluator cannot
        // compare: unknown, never an invented "unchanged".
        const incomparable = reviseRound(
          runtime,
          requests,
          "work#9",
          "review#10",
          { nested: true },
          NOW + 9,
        );
        expect(incomparable.kind).toBe("accepted");
        if (incomparable.kind !== "accepted") return;
        expect(onlyProgress(incomparable.progress)).toMatchObject({
          verdict: "unknown",
          unknownReason: "incomparable-value",
          unchanged: 0,
          baseline: "r2",
        });
        expect(progressEntry(incomparable.state, "revise-loop").unchanged).toBe(0);
        // The run is still executing: an unknown never reaches the threshold.
        expect(incomparable.state.phase).toBe("executing");
      },
    );
  });

  it("clears the streak on an unknown, and never stops on it", async () => {
    await withHarness(
      progressLoopDeclaration({ maxTraversals: 20, maxUnchanged: 2 }),
      async ({ runtime, ledger, requests, graphId, dir }) => {
        runtime.start(NOW);
        const first = reviseRound(runtime, requests, "work#1", "review#2", "r1", NOW + 1);
        expect(first.kind).toBe("accepted");
        const same = reviseRound(runtime, requests, "work#3", "review#4", "r1", NOW + 3);
        expect(same.kind).toBe("accepted");
        if (same.kind !== "accepted") return;
        expect(onlyProgress(same.progress)).toMatchObject({ verdict: "unchanged", unchanged: 1 });

        // UNKNOWN: the streak is CLEARED. The round could not be compared, so it
        // is not a round in which the run was observed to stand still, and the
        // streak must not span it. The baseline is kept for the next comparison.
        const unknown = reviseRound(
          runtime,
          requests,
          "work#5",
          "review#6",
          ["not", "a", "token"],
          NOW + 5,
        );
        expect(unknown.kind).toBe("accepted");
        if (unknown.kind !== "accepted") return;
        expect(onlyProgress(unknown.progress)).toMatchObject({
          verdict: "unknown",
          unknownReason: "incomparable-value",
          unchanged: 0,
          baseline: "r1",
          stalled: false,
        });
        expect(unknown.state.phase).toBe("executing");
        expect(unknown.stop).toBeUndefined();
        expect(progressEntry(unknown.state, "revise-loop")).toEqual({
          loopGroupId: "revise-loop",
          evaluator: "revision-token",
          version: 1,
          subject: "revision",
          unchanged: 0,
          baseline: "r1",
        });

        // The next COMPARABLE unchanged token counts ONE, not two: it does not
        // reach the declared threshold, so the run continues. A counter that had
        // carried the interrupted streak would have stopped the run here, on a
        // repetition nobody observed twice.
        const restarted = reviseRound(runtime, requests, "work#7", "review#8", "r1", NOW + 7);
        expect(restarted.kind).toBe("accepted");
        if (restarted.kind !== "accepted") return;
        expect(onlyProgress(restarted.progress)).toMatchObject({
          verdict: "unchanged",
          unchanged: 1,
          baseline: "r1",
          stalled: false,
        });
        expect(restarted.state.phase).toBe("executing");
        expect(restarted.stop).toBeUndefined();

        // Only the SECOND consecutive comparable unchanged token reaches the
        // declared threshold: the outcome is still accepted, the refused round
        // is not taken, and the run ends on the closed stop vocabulary.
        const workedAgain = workStep(runtime, requests, "work#9", NOW + 9);
        expect(workedAgain.kind).toBe("accepted");
        const receiptsBefore = await countTable(dir, "ledger_receipts");
        const eventsBefore = ledger.acceptedEvents(graphId).length;
        // The ONE submission below commits exactly one receipt, one accepted
        // event and the stopped state, in the same transaction.
        const stalled = runtime.submit(
          {
            nodeId: "review",
            outcomeId: "revise",
            credential: credentialOf(requests, "review#10"),
            data: { revision: "r1" },
          },
          NOW + 10,
        );
        expect(stalled.kind).toBe("accepted");
        if (stalled.kind !== "accepted") return;
        expect(onlyProgress(stalled.progress)).toMatchObject({
          verdict: "unchanged",
          unchanged: 2,
          baseline: "r1",
          stalled: true,
        });
        expect(stalled.state.phase).toBe("stopped");
        expect(stalled.dispatched).toEqual([]);
        expect(stalled.stop).toEqual({
          reason: "progress-stalled",
          loopGroupId: "revise-loop",
          nodeId: "review",
          outcomeId: "revise",
          attemptId: "review#10",
          unchanged: 2,
          maxUnchanged: 2,
          evaluator: "revision-token",
          evaluatorVersion: 1,
          subject: "revision",
          baseline: "r1",
          stoppedAt: NOW + 10,
        });
        // The accepted outcome settled its own node and nothing else, and the
        // receipt/event/state committed together as for any other acceptance.
        expect(nodeOf(stalled.state, "review")).toMatchObject({
          status: "settled",
          outcomeId: "revise",
          attemptId: "review#10",
        });
        expect(await countTable(dir, "ledger_receipts")).toBe(receiptsBefore + 1);
        expect(ledger.acceptedEvents(graphId)).toHaveLength(eventsBefore + 1);
        // The committed state IS the state a reader gets back.
        const reread = runtime.state();
        expect(reread).toEqual(stalled.state);
        expect(reread?.stop?.reason).toBe("progress-stalled");

        // A restart REPORTS the stop and continues nothing.
        const resumed = runtime.resume(NOW + 100);
        expect(resumed.kind).toBe("resumed");
        if (resumed.kind !== "resumed") return;
        expect(resumed.stop).toEqual(stalled.stop);
        expect(resumed.dispatched).toEqual([]);
        expect(resumed.armed).toEqual([]);
      },
    );
  });

  it("stops the whole run in the persisted path and refuses a branch still in flight", async () => {
    await withHarness(
      progressSideBranchDeclaration(1),
      async ({ runtime, requests }) => {
        runtime.start(NOW);
        const worked = runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
          NOW + 1,
        );
        expect(worked.kind).toBe("accepted");
        if (worked.kind !== "accepted") return;
        expect(attemptIds(worked.dispatched)).toEqual(["review#2", "side#3"]);
        const first = runtime.submit(
          {
            nodeId: "review",
            outcomeId: "revise",
            credential: credentialOf(requests, "review#2"),
            data: { revision: "r1" },
          },
          NOW + 2,
        );
        expect(first.kind).toBe("accepted");
        if (first.kind !== "accepted") return;
        expect(onlyProgress(first.progress).verdict).toBe("progressed");
        const workedAgain = runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#4") },
          NOW + 3,
        );
        expect(workedAgain.kind).toBe("accepted");
        if (workedAgain.kind !== "accepted") return;
        expect(attemptIds(workedAgain.dispatched)).toEqual(["review#5"]);

        const stopped = runtime.submit(
          {
            nodeId: "review",
            outcomeId: "revise",
            credential: credentialOf(requests, "review#5"),
            data: { revision: "r1" },
          },
          NOW + 4,
        );
        expect(stopped.kind).toBe("accepted");
        if (stopped.kind !== "accepted") return;
        expect(stopped.state.phase).toBe("stopped");
        expect(stopped.stop?.reason).toBe("progress-stalled");
        expect(stopped.stop?.attemptId).toBe("review#5");
        // The independent branch is exactly where it was: in flight on the
        // attempt it was dispatched with, never settled by an outcome nobody
        // submitted.
        expect(nodeOf(stopped.state, "side")).toMatchObject({
          status: "dispatched",
          attemptId: "side#3",
        });
        expect(stopped.dispatched).toEqual([]);

        // Its worker outcome is refused BY NAME: a stopped run takes no further
        // step, and the refusal names the reason the run ended.
        const late = runtime.submit(
          { nodeId: "side", outcomeId: "finish", credential: credentialOf(requests, "side#3") },
          NOW + 5,
        );
        expect(late.kind).toBe("refused");
        if (late.kind !== "refused") return;
        expect(late.refusals.map((refusal) => refusal.code)).toEqual(["graph-stopped"]);
        expect(late.refusals[0]?.message).toContain("progress-stalled");
        expect(runtime.state()).toEqual(stopped.state);
      },
    );
  });

  it("refuses a continuation that omits the declared comparison object, writing nothing", async () => {
    await withHarness(
      progressLoopDeclaration({ maxTraversals: 20, maxUnchanged: 2 }),
      async ({ runtime, ledger, requests, graphId, dir }) => {
        runtime.start(NOW);
        const first = reviseRound(runtime, requests, "work#1", "review#2", "r1", NOW + 1);
        expect(first.kind).toBe("accepted");
        // The next round has to be armed before its continuation can be claimed.
        const worked = workStep(runtime, requests, "work#3", NOW + 3);
        expect(worked.kind).toBe("accepted");
        const before = runtime.state();
        const receiptsBefore = await countTable(dir, "ledger_receipts");
        const eventsBefore = ledger.acceptedEvents(graphId).length;

        // The declared subject is REQUIRED: a submission without it is refused
        // for repair, with nothing written and the attempt left open.
        const missing = runtime.submit(
          {
            nodeId: "review",
            outcomeId: "revise",
            credential: credentialOf(requests, "review#4"),
          },
          NOW + 4,
        );
        expect(missing.kind).toBe("refused");
        if (missing.kind !== "refused") return;
        expect(missing.refusals.map((refusal) => refusal.code)).toEqual([
          "progress-subject-missing",
        ]);
        expect(missing.refusals[0]?.path).toBe("$.data.revision");
        expect(await countTable(dir, "ledger_receipts")).toBe(receiptsBefore);
        expect(ledger.acceptedEvents(graphId)).toHaveLength(eventsBefore);
        expect(runtime.state()).toEqual(before);

        // The same attempt then settles on a repaired submission.
        const repaired = runtime.submit(
          {
            nodeId: "review",
            outcomeId: "revise",
            credential: credentialOf(requests, "review#4"),
            data: { revision: "r1" },
          },
          NOW + 5,
        );
        expect(repaired.kind).toBe("accepted");
      },
    );
  });

  it("refuses a plan whose declared comparison semantics this build does not implement", async () => {
    await withHarness(
      progressLoopDeclaration({ maxTraversals: 20, maxUnchanged: 2, evaluator: "cosine-similarity" }),
      async ({ runtime, requests }) => {
        runtime.start(NOW);
        const worked = runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#1") },
          NOW + 1,
        );
        expect(worked.kind).toBe("accepted");
        const claimed = runtime.submit(
          {
            nodeId: "review",
            outcomeId: "revise",
            credential: credentialOf(requests, "review#2"),
            data: { revision: "r1" },
          },
          NOW + 2,
        );
        expect(claimed.kind).toBe("refused");
        if (claimed.kind !== "refused") return;
        expect(claimed.refusals.map((refusal) => refusal.code)).toEqual([
          "progress-evaluator-unavailable",
        ]);
        expect(claimed.refusals[0]?.message).toContain("cosine-similarity");
      },
    );
  });

  it("answers unknown when the persisted baseline was recorded under another evaluator version", async () => {
    await withHarness(
      progressLoopDeclaration({ maxTraversals: 20, maxUnchanged: 2 }),
      async ({ runtime, ledger, requests, graphId }) => {
        runtime.start(NOW);
        const first = reviseRound(runtime, requests, "work#1", "review#2", "r1", NOW + 1);
        expect(first.kind).toBe("accepted");
        const same = reviseRound(runtime, requests, "work#3", "review#4", "r1", NOW + 3);
        expect(same.kind).toBe("accepted");
        if (same.kind !== "accepted") return;
        expect(onlyProgress(same.progress).unchanged).toBe(1);

        // ANOTHER BUILD recorded the baseline under evaluator version 2. The
        // reader accepts the record — a version is the compatibility FACT the
        // comparison judges, not a shape it can refuse — so the comparison is
        // what answers.
        const stored = ledger.readGraphState(graphId);
        if (stored === undefined) throw new Error("fixture: the state row is missing");
        const body = recordOf(stored.body, "the state body");
        const entries = recordOf(body.loopProgress, "loopProgress");
        const entry = recordOf(entries["revise-loop"], "the progress entry");
        ledger.writeGraphState({
          ...stored,
          body: {
            ...body,
            loopProgress: {
              ...entries,
              "revise-loop": { ...entry, version: 2 },
            },
          },
          updatedAt: NOW + 10,
        });
        const seeded = runtime.state();
        expect(progressEntry(seeded ?? same.state, "revise-loop").version).toBe(2);

        // The same revision as the baseline, under different comparison
        // semantics: unknown, never "unchanged" (nor "progressed"). The recorded
        // identity and the baseline are kept, so a restart still compares against
        // the same token, while the count is CLEARED — the streak cannot span a
        // round this comparison could not judge.
        const changed = reviseRound(runtime, requests, "work#5", "review#6", "r1", NOW + 11);
        expect(changed.kind).toBe("accepted");
        if (changed.kind !== "accepted") return;
        expect(onlyProgress(changed.progress)).toMatchObject({
          verdict: "unknown",
          unknownReason: "evaluator-identity-mismatch",
          version: 2,
          unchanged: 0,
          baseline: "r1",
          stalled: false,
        });
        expect(progressEntry(changed.state, "revise-loop")).toEqual({
          loopGroupId: "revise-loop",
          evaluator: "revision-token",
          version: 2,
          subject: "revision",
          unchanged: 0,
          baseline: "r1",
        });
        expect(changed.state.phase).toBe("executing");
      },
    );
  });

  it("refuses a version-5 body instead of advancing it, leaving the counter it cannot trust", async () => {
    await withHarness(
      progressLoopDeclaration({ maxTraversals: 20, maxUnchanged: 2 }),
      async ({ runtime, ledger, requests, graphId }) => {
        runtime.start(NOW);
        const first = reviseRound(runtime, requests, "work#1", "review#2", "r1", NOW + 1);
        expect(first.kind).toBe("accepted");
        const same = reviseRound(runtime, requests, "work#3", "review#4", "r1", NOW + 3);
        expect(same.kind).toBe("accepted");
        if (same.kind !== "accepted") return;
        expect(progressEntry(same.state, "revise-loop").unchanged).toBe(1);

        // An OLDER BUILD wrote this body: body version 5, whose counter did NOT
        // clear on an unknown, so "unchanged: 1" may stand for a streak an
        // unjudged round interrupted. It cannot be told apart from a trustworthy
        // one, so this build never advances it: recomputing the count would be
        // fabricating a comparison the run never made, and carrying it forward
        // would let a declared stopping policy fire on repetitions nobody
        // observed back to back.
        const stored = ledger.readGraphState(graphId);
        if (stored === undefined) throw new Error("fixture: the state row is missing");
        const body = recordOf(stored.body, "the state body");
        expect(body.bodyVersion).toBe(CURRENT_OUTCOME_STATE_BODY);
        const rawNodes = body.nodes;
        if (!Array.isArray(rawNodes)) throw new Error("fixture: the body carries no nodes");
        // Version 5 persisted the credential itself, never its digest, so the
        // entries are re-spelled in that layout: a body handed to the reader is
        // exactly what that version's writer would have written.
        const v5Nodes = rawNodes.map((node) => {
          const entry = recordOf(node, "a node entry");
          const { attemptCredentialDigest: _digest, ...rest } = entry;
          return { ...rest, attemptCredential: "fixture-credential:" + String(entry.nodeId) };
        });
        ledger.writeGraphState({
          ...stored,
          body: { ...body, bodyVersion: OUTCOME_STATE_BODY_V5, nodes: v5Nodes },
          updatedAt: NOW + 10,
        });
        const seeded = runtime.state();
        expect(seeded?.bodyVersion).toBe(OUTCOME_STATE_BODY_V5);
        expect(progressEntry(seeded ?? same.state, "revise-loop").unchanged).toBe(1);

        const before = ledger.readGraphState(graphId);
        const workedAgain = runtime.submit(
          {
            nodeId: "work",
            outcomeId: "done",
            credential: credentialOf(requests, "work#5"),
          },
          NOW + 11,
        );
        // The attempt CANNOT BE SETTLED AT ALL: a version-5 entry carries the
        // credential itself, and this build verifies against a digest, so the
        // presented credential resolves to no attempt. Nothing is advanced and
        // nothing is granted in the body's place.
        expect(workedAgain.kind).toBe("refused");
        if (workedAgain.kind !== "refused") return;
        expect(workedAgain.refusals.map((refusal) => refusal.code)).toEqual([
          "credential-unknown",
        ]);

        // NOTHING was written: the older body keeps the counter it recorded, so
        // an operator can still read what the run actually measured.
        expect(ledger.readGraphState(graphId)).toEqual(before);
      },
    );
  });
  it("replays a continuation without counting it twice", async () => {
    await withHarness(
      progressLoopDeclaration({ maxTraversals: 20, maxUnchanged: 3 }),
      async ({ runtime, requests }) => {
        runtime.start(NOW);
        const first = reviseRound(runtime, requests, "work#1", "review#2", "r1", NOW + 1);
        expect(first.kind).toBe("accepted");
        const same = reviseRound(runtime, requests, "work#3", "review#4", "r1", NOW + 3);
        expect(same.kind).toBe("accepted");
        if (same.kind !== "accepted") return;
        expect(progressEntry(same.state, "revise-loop").unchanged).toBe(1);

        // The SAME logical submission again: the ledger replays its receipt, the
        // join contributes no state write, and the counter does not move.
        const replay = runtime.submit(
          {
            nodeId: "review",
            outcomeId: "revise",
            credential: credentialOf(requests, "review#4"),
            data: { revision: "r1" },
          },
          NOW + 5,
        );
        expect(replay.kind).toBe("accepted");
        if (replay.kind !== "accepted") return;
        expect(replay.replayed).toBe(true);
        expect(replay.progress).toBeUndefined();
        expect(progressEntry(replay.state, "revise-loop").unchanged).toBe(1);

        // One more comparable unchanged round counts ONCE: with the threshold at
        // three, a double-counted replay would have stopped the run here.
        const next = reviseRound(runtime, requests, "work#5", "review#6", "r1", NOW + 6);
        expect(next.kind).toBe("accepted");
        if (next.kind !== "accepted") return;
        expect(onlyProgress(next.progress)).toMatchObject({
          verdict: "unchanged",
          unchanged: 2,
          stalled: false,
        });
        expect(next.state.phase).toBe("executing");
        expect(next.stop).toBeUndefined();
      },
    );
  });

  it("keeps the hard cap binding while every comparison is unknown", async () => {
    await withHarness(
      progressLoopDeclaration({ maxTraversals: 1, maxUnchanged: 3 }),
      async ({ runtime, requests }) => {
        runtime.start(NOW);
        // The first continuation is INCOMPARABLE: unknown, so it neither
        // establishes a baseline nor reaches a threshold — and the round is
        // still taken, because the soft stop is the only answer unknown can
        // never produce.
        const unknown = reviseRound(runtime, requests, "work#1", "review#2", [], NOW + 1);
        expect(unknown.kind).toBe("accepted");
        if (unknown.kind !== "accepted") return;
        expect(onlyProgress(unknown.progress)).toMatchObject({
          verdict: "unknown",
          unknownReason: "incomparable-value",
        });
        expect(unknown.state.loopTraversals["revise-loop"]).toBe(1);
        expect(progressEntry(unknown.state, "revise-loop").baseline).toBeUndefined();
        expect(progressEntry(unknown.state, "revise-loop").unchanged).toBe(0);

        // The next one exceeds the declared HARD cap: unknown progress remains
        // subject to hard limits, and the hard limit is the outer bound — the
        // run stops with loop-exhausted, and no comparison is recorded for a
        // round that is not taken.
        const capped = reviseRound(runtime, requests, "work#3", "review#4", [], NOW + 3);
        expect(capped.kind).toBe("accepted");
        if (capped.kind !== "accepted") return;
        expect(capped.state.phase).toBe("stopped");
        expect(capped.stop?.reason).toBe("loop-exhausted");
        expect(capped.progress).toBeUndefined();
        expect(progressEntry(capped.state, "revise-loop")).toEqual({
          loopGroupId: "revise-loop",
          evaluator: "revision-token",
          version: 1,
          subject: "revision",
          unchanged: 0,
        });
      },
    );
  });

  it("never measures the outcome that leaves the loop", async () => {
    await withHarness(
      progressLoopDeclaration({ maxTraversals: 20, maxUnchanged: 1 }),
      async ({ runtime, requests }) => {
        runtime.start(NOW);
        const first = reviseRound(runtime, requests, "work#1", "review#2", "r1", NOW + 1);
        expect(first.kind).toBe("accepted");
        if (first.kind !== "accepted") return;
        const worked = runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: credentialOf(requests, "work#3") },
          NOW + 3,
        );
        expect(worked.kind).toBe("accepted");

        // The EXIT outcome carries NO data at all. It is not a continuation, so
        // no comparison is made and no declared subject is required: a run that
        // finishes does not enter the revision-staleness path.
        const approved = runtime.submit(
          { nodeId: "review", outcomeId: "approve", credential: credentialOf(requests, "review#4") },
          NOW + 4,
        );
        expect(approved.kind).toBe("accepted");
        if (approved.kind !== "accepted") return;
        expect(approved.progress).toBeUndefined();
        expect(approved.state.phase).toBe("complete");
        // The loop progress it does not compare is left exactly as it was.
        expect(progressEntry(approved.state, "revise-loop")).toEqual({
          loopGroupId: "revise-loop",
          evaluator: "revision-token",
          version: 1,
          subject: "revision",
          unchanged: 0,
          baseline: "r1",
        });
      },
    );
  });

  it("continues the same comparison after a restart: same baseline, same version", async () => {
    await withHarness(
      progressLoopDeclaration({ maxTraversals: 20, maxUnchanged: 2 }),
      async ({ runtime, plan, ledger, requests, dir }) => {
        runtime.start(NOW);
        const first = reviseRound(runtime, requests, "work#1", "review#2", "r1", NOW + 1);
        expect(first.kind).toBe("accepted");
        const same = reviseRound(runtime, requests, "work#3", "review#4", "r1", NOW + 3);
        expect(same.kind).toBe("accepted");
        if (same.kind !== "accepted") return;
        expect(progressEntry(same.state, "revise-loop")).toEqual({
          loopGroupId: "revise-loop",
          evaluator: "revision-token",
          version: 1,
          subject: "revision",
          unchanged: 1,
          baseline: "r1",
        });

        // A NEW runtime over the SAME ledger: the baseline exists only in the
        // store, so recovery has to continue the comparison from it rather than
        // restart the counters.
        const restarted = new OutcomeGraphRuntime({
          plan,
          ledger,
          dispatch: (request) => {
            requests.push(request);
          },
          validators: EMPTY_VALIDATORS,
          artifactRoot: dir,
          credentialIsolation: testHostCredentialIsolation(dir),
          clock: () => NOW,
          mintCredential: TEST_CREDENTIAL_SOURCE,
        });
        const resumed = restarted.resume(NOW + 5);
        expect(resumed.kind).toBe("resumed");
        if (resumed.kind !== "resumed") return;
        expect(resumed.armed.map((node) => node.nodeId)).toEqual(["work"]);
        expect(progressEntry(resumed.state, "revise-loop")).toEqual({
          loopGroupId: "revise-loop",
          evaluator: "revision-token",
          version: 1,
          subject: "revision",
          unchanged: 1,
          baseline: "r1",
        });

        // The next round compares against that same baseline under that same
        // evaluator version, so the declared threshold is reached exactly once.
        const workedAgain = workStep(restarted, requests, "work#5", NOW + 6);
        expect(workedAgain.kind).toBe("accepted");
        const stalled = restarted.submit(
          {
            nodeId: "review",
            outcomeId: "revise",
            credential: credentialOf(requests, "review#6"),
            data: { revision: "r1" },
          },
          NOW + 7,
        );
        expect(stalled.kind).toBe("accepted");
        if (stalled.kind !== "accepted") return;
        expect(onlyProgress(stalled.progress)).toMatchObject({
          verdict: "unchanged",
          unchanged: 2,
          baseline: "r1",
          stalled: true,
        });
        expect(stalled.stop).toMatchObject({
          reason: "progress-stalled",
          attemptId: "review#6",
          unchanged: 2,
          maxUnchanged: 2,
          evaluatorVersion: 1,
          baseline: "r1",
        });
      },
    );
  });

  it("compares every policy group that governs one continuation, and stops on the first", async () => {
    await withHarness(
      twoPolicyProgressDeclaration(1, 1),
      async ({ runtime, plan, ledger, requests, dir }) => {
        runtime.start(NOW);
        const first = reviseRound(runtime, requests, "work#1", "review#2", "r1", NOW + 1);
        expect(first.kind).toBe("accepted");
        if (first.kind !== "accepted") return;
        // ONE comparison is a fact about the accepted outcome for EVERY group
        // that declares it as its continuation: both baselines are established
        // and persisted by the same commit.
        expect(
          first.progress?.map((report) => [report.loopGroupId, report.verdict, report.baseline]),
        ).toEqual([
          ["a-first", "progressed", "r1"],
          ["b-second", "progressed", "r1"],
        ]);
        expect(progressEntry(first.state, "a-first").unchanged).toBe(0);
        expect(progressEntry(first.state, "b-second").unchanged).toBe(0);

        const stopping = reviseRound(runtime, requests, "work#3", "review#4", "r1", NOW + 3);
        expect(stopping.kind).toBe("accepted");
        if (stopping.kind !== "accepted") return;
        // Both groups stand ON their own threshold; the stop names the FIRST in
        // plan order, and the second counter is persisted beside it.
        expect(
          stopping.progress?.map((report) => [
            report.loopGroupId,
            report.verdict,
            report.unchanged,
            report.stalled,
          ]),
        ).toEqual([
          ["a-first", "unchanged", 1, true],
          ["b-second", "unchanged", 1, true],
        ]);
        expect(stopping.stop).toMatchObject({
          reason: "progress-stalled",
          loopGroupId: "a-first",
          unchanged: 1,
          maxUnchanged: 1,
        });

        // A NEW runtime over the SAME ledger must READ that body back: a second
        // group standing on its threshold is legal precisely because the body IS
        // stopped by the policy. The stop is reported, nothing is armed, and the
        // stopping submission's own credential still replays its receipt.
        const stoppingCredential = credentialOf(requests, "review#4");
        const restarted = new OutcomeGraphRuntime({
          plan,
          ledger,
          dispatch: (request) => {
            requests.push(request);
          },
          validators: EMPTY_VALIDATORS,
          artifactRoot: dir,
          credentialIsolation: testHostCredentialIsolation(dir),
          clock: () => NOW,
          mintCredential: TEST_CREDENTIAL_SOURCE,
        });
        const resumed = restarted.resume(NOW + 5);
        expect(resumed.kind).toBe("resumed");
        if (resumed.kind !== "resumed") return;
        expect(resumed.stop).toMatchObject({
          reason: "progress-stalled",
          loopGroupId: "a-first",
        });
        expect(progressEntry(resumed.state, "b-second")).toEqual({
          loopGroupId: "b-second",
          evaluator: "revision-token",
          version: 1,
          subject: "revision",
          unchanged: 1,
          baseline: "r1",
        });
        expect(resumed.armed).toEqual([]);

        const replay = restarted.submit(
          {
            nodeId: "review",
            outcomeId: "revise",
            credential: stoppingCredential,
            data: { revision: "r1" },
          },
          NOW + 6,
        );
        expect(replay.kind).toBe("accepted");
        if (replay.kind !== "accepted") return;
        expect(replay.replayed).toBe(true);
        // The replay is not counted a second time.
        expect(progressEntry(replay.state, "a-first").unchanged).toBe(1);
        expect(restarted.resume(NOW + 7)).toMatchObject({ kind: "resumed" });
      },
    );
  });

  it("stops on the only group that reached its threshold when the two policies differ", async () => {
    await withHarness(
      twoPolicyProgressDeclaration(2, 1),
      async ({ runtime, requests }) => {
        runtime.start(NOW);
        reviseRound(runtime, requests, "work#1", "review#2", "r1", NOW + 1);
        const stopping = reviseRound(runtime, requests, "work#3", "review#4", "r1", NOW + 3);
        expect(stopping.kind).toBe("accepted");
        if (stopping.kind !== "accepted") return;
        expect(
          stopping.progress?.map((report) => [
            report.loopGroupId,
            report.unchanged,
            report.stalled,
          ]),
        ).toEqual([
          ["a-first", 1, false],
          ["b-second", 1, true],
        ]);
        expect(stopping.stop).toMatchObject({
          reason: "progress-stalled",
          loopGroupId: "b-second",
          maxUnchanged: 1,
        });
        // The group below its threshold keeps its own counter.
        expect(progressEntry(stopping.state, "a-first").unchanged).toBe(1);
      },
    );
  });
});

describe("OutcomeGraphRuntime — a convergence node is armed by its join", () => {
  it("arms a join:all node exactly once, when the LAST feeder arrives", async () => {
    await withHarness(DIAMOND_ALL, async ({ runtime, requests, ledger, graphId }) => {
      runtime.start(NOW);
      const split = runtime.submit(
        { nodeId: "arb", outcomeId: "split", credential: credentialOf(requests, "arb#1") },
        NOW + 1,
      );
      expect(split.kind).toBe("accepted");
      if (split.kind !== "accepted") return;
      expect(attemptIds(split.dispatched)).toEqual(["brc#2", "crb#3"]);

      // THE DEFECT: the first branch completing used to arm djoin on its own.
      const first = runtime.submit(
        { nodeId: "brc", outcomeId: "done", credential: credentialOf(requests, "brc#2") },
        NOW + 2,
      );
      expect(first.kind).toBe("accepted");
      if (first.kind !== "accepted") return;
      expect(first.dispatched).toEqual([]);
      // Waiting writes NO attempt state: no attempt id, no credential, no
      // effect — only the durable arrival record of the branch that did answer.
      expect(nodeOf(first.state, "djoin")).toMatchObject({ status: "pending" });
      expect(nodeOf(first.state, "djoin").attemptId).toBeUndefined();
      expect(nodeOf(first.state, "djoin").attemptCredential).toBeUndefined();
      expect(nodeOf(first.state, "djoin").arrivals).toEqual([
        { from: "brc", outcome: "done", attemptId: "brc#2" },
      ]);

      const second = runtime.submit(
        { nodeId: "crb", outcomeId: "done", credential: credentialOf(requests, "crb#3") },
        NOW + 3,
      );
      expect(second.kind).toBe("accepted");
      if (second.kind !== "accepted") return;
      // Exactly ONE arm, on a fresh attempt, and the in-flight attempt can no
      // longer be overwritten by a later arrival.
      expect(attemptIds(second.dispatched)).toEqual(["djoin#4"]);
      expect(nodeOf(second.state, "djoin")).toMatchObject({
        status: "dispatched",
        attemptId: "djoin#4",
      });
      expect(nodeOf(second.state, "djoin").arrivals).toEqual([
        { from: "brc", outcome: "done", attemptId: "brc#2" },
        { from: "crb", outcome: "done", attemptId: "crb#3" },
      ]);

      // SELF-CHECK EVIDENCE: the deterministic dispatch sequence and the final
      // node state (no credential value is printed).
      expect(attemptIds(requests)).toEqual(["arb#1", "brc#2", "crb#3", "djoin#4"]);
      expect(second.state.attemptSeq).toBe(4);
      console.log(
        "[probe:diamond-join] dispatches=" +
          JSON.stringify(attemptIds(requests)) +
          " state=" +
          stateSummary(runtime.state()),
      );
      expect(
        ledger.acceptedEvents(graphId).map((event) => event.attemptId),
      ).toEqual(["arb#1", "brc#2", "crb#3"]);
    });
  });

  it("never overwrites an attempt in flight: a second arrival at join:any leaves it alone", async () => {
    await withHarness(DIAMOND_ANY, async ({ runtime, requests }) => {
      runtime.start(NOW);
      runtime.submit(
        { nodeId: "arb", outcomeId: "split", credential: credentialOf(requests, "arb#1") },
        NOW + 1,
      );
      const armed = runtime.submit(
        { nodeId: "brc", outcomeId: "done", credential: credentialOf(requests, "brc#2") },
        NOW + 2,
      );
      expect(armed.kind).toBe("accepted");
      if (armed.kind !== "accepted") return;
      // join:any — the first branch arms the convergence node.
      expect(attemptIds(armed.dispatched)).toEqual(["djoin#4"]);

      const late = runtime.submit(
        { nodeId: "crb", outcomeId: "done", credential: credentialOf(requests, "crb#3") },
        NOW + 3,
      );
      expect(late.kind).toBe("accepted");
      if (late.kind !== "accepted") return;
      // The arrival is accepted and recorded, but djoin is already running:
      // no second dispatch, and its attempt id is UNCHANGED (the old reducer
      // minted djoin#5 here and overwrote djoin#4).
      expect(late.dispatched).toEqual([]);
      expect(nodeOf(late.state, "djoin")).toMatchObject({
        status: "dispatched",
        attemptId: "djoin#4",
      });
      expect(late.state.attemptSeq).toBe(4);
      expect(nodeOf(late.state, "djoin").arrivals).toEqual([
        { from: "brc", outcome: "done", attemptId: "brc#2" },
        { from: "crb", outcome: "done", attemptId: "crb#3" },
      ]);
      expect(attemptIds(requests)).toEqual(["arb#1", "brc#2", "crb#3", "djoin#4"]);
    });
  });

  it("decides the join from the persisted arrivals after a restart", async () => {
    await withHarness(
      DIAMOND_ALL,
      async ({ runtime, plan, ledger, requests, dir }) => {
        runtime.start(NOW);
        runtime.submit(
          { nodeId: "arb", outcomeId: "split", credential: credentialOf(requests, "arb#1") },
          NOW + 1,
        );
        const first = runtime.submit(
          { nodeId: "brc", outcomeId: "done", credential: credentialOf(requests, "brc#2") },
          NOW + 2,
        );
        expect(first.kind).toBe("accepted");
        if (first.kind !== "accepted") return;

        // A NEW runtime over the SAME ledger: the arrival is not in memory,
        // only in the persisted state the acceptance transaction wrote.
        const restarted = new OutcomeGraphRuntime({
          plan,
          ledger,
          dispatch: (request) => {
            requests.push(request);
          },
          validators: EMPTY_VALIDATORS,
          artifactRoot: dir,
          credentialIsolation: testHostCredentialIsolation(dir),
          clock: () => NOW,
          mintCredential: TEST_CREDENTIAL_SOURCE,
        });
        const resumed = restarted.resume(NOW + 3);
        expect(resumed.kind).toBe("resumed");
        if (resumed.kind !== "resumed") return;
        // The half-arrived join is NOT armed (only the branch that is still
        // running is), and the arrival it is waiting on is still there.
        expect(resumed.armed.map((node) => node.nodeId)).toEqual(["crb"]);
        expect(nodeOf(resumed.state, "djoin")).toMatchObject({ status: "pending" });
        expect(nodeOf(resumed.state, "djoin").arrivals).toEqual([
          { from: "brc", outcome: "done", attemptId: "brc#2" },
        ]);

        const second = restarted.submit(
          { nodeId: "crb", outcomeId: "done", credential: credentialOf(requests, "crb#3") },
          NOW + 4,
        );
        expect(second.kind).toBe("accepted");
        if (second.kind !== "accepted") return;
        expect(attemptIds(second.dispatched)).toEqual(["djoin#4"]);
      },
    );
  });
});

describe("OutcomeGraphRuntime — a loop join is decided per round", () => {
  it("does not satisfy a new round's join with the previous round's arrival", async () => {
    await withHarness(loopJoinDeclaration(3), async ({ runtime, requests }) => {
      runtime.start(NOW);
      runtime.submit(
        { nodeId: "s", outcomeId: "next", credential: credentialOf(requests, "s#1") },
        NOW + 1,
      );
      // ROUND 1 — the join waits for both branches.
      const a1 = runtime.submit(
        { nodeId: "a", outcomeId: "done", credential: credentialOf(requests, "a#2") },
        NOW + 2,
      );
      expect(a1.kind).toBe("accepted");
      if (a1.kind !== "accepted") return;
      expect(a1.dispatched).toEqual([]);
      const b1 = runtime.submit(
        { nodeId: "b", outcomeId: "done", credential: credentialOf(requests, "b#3") },
        NOW + 3,
      );
      expect(b1.kind).toBe("accepted");
      if (b1.kind !== "accepted") return;
      expect(attemptIds(b1.dispatched)).toEqual(["j#4"]);

      // The continuation re-enters the loop at s, which re-runs BOTH branches.
      const again = runtime.submit(
        { nodeId: "j", outcomeId: "again", credential: credentialOf(requests, "j#4") },
        NOW + 4,
      );
      expect(again.kind).toBe("accepted");
      if (again.kind !== "accepted") return;
      expect(attemptIds(again.dispatched)).toEqual(["s#5"]);
      expect(again.state.loopTraversals["rounds"]).toBe(1);
      const round2 = runtime.submit(
        { nodeId: "s", outcomeId: "next", credential: credentialOf(requests, "s#5") },
        NOW + 5,
      );
      expect(round2.kind).toBe("accepted");
      if (round2.kind !== "accepted") return;
      expect(attemptIds(round2.dispatched)).toEqual(["a#6", "b#7"]);

      // ROUND 2 — a#6 settling alone must NOT satisfy the join: the branch's
      // round-1 arrival is superseded by its new attempt, so j keeps waiting on
      // the attempt that settled it instead of being re-armed.
      const a2 = runtime.submit(
        { nodeId: "a", outcomeId: "done", credential: credentialOf(requests, "a#6") },
        NOW + 6,
      );
      expect(a2.kind).toBe("accepted");
      if (a2.kind !== "accepted") return;
      expect(a2.dispatched).toEqual([]);
      expect(nodeOf(a2.state, "j")).toMatchObject({
        status: "settled",
        attemptId: "j#4",
      });
      expect(nodeOf(a2.state, "j").arrivals).toEqual([
        { from: "a", outcome: "done", attemptId: "a#6" },
      ]);

      // Both round-2 arrivals are in: exactly ONE re-arm.
      const b2 = runtime.submit(
        { nodeId: "b", outcomeId: "done", credential: credentialOf(requests, "b#7") },
        NOW + 7,
      );
      expect(b2.kind).toBe("accepted");
      if (b2.kind !== "accepted") return;
      expect(attemptIds(b2.dispatched)).toEqual(["j#8"]);
      expect(nodeOf(b2.state, "j")).toMatchObject({
        status: "dispatched",
        attemptId: "j#8",
      });
      expect(b2.state.loopTraversals["rounds"]).toBe(1);
      // One arm per round, and no arm between them.
      expect(attemptIds(requests)).toEqual([
        "s#1",
        "a#2",
        "b#3",
        "j#4",
        "s#5",
        "a#6",
        "b#7",
        "j#8",
      ]);
      console.log(
        "[probe:loop-join] dispatches=" +
          JSON.stringify(attemptIds(requests)) +
          " state=" +
          stateSummary(runtime.state()),
      );
    });
  });
});

describe("OutcomeGraphRuntime — a cyclic candidate dependency does not arm itself", () => {
  it("waits when every candidate's arrival would be superseded by another candidate", async () => {
    await withHarness(joinCycleDeclaration(), async ({ runtime, requests, credentialOf }) => {
      runtime.start(NOW);
      const accept = (nodeId: string, outcomeId: string, attemptId: string, at: number) => {
        const result = runtime.submit(
          { nodeId, outcomeId, credential: credentialOf(attemptId) },
          at,
        );
        expect(result.kind).toBe("accepted");
        if (result.kind !== "accepted") throw new Error("fixture: " + attemptId + " was refused");
        return result;
      };

      // ROUND 1 — the outside satisfier z bootstraps c1 (e + z meets the
      // quorum); c2 and c3 then follow one at a time in dependency order.
      accept("a0", "clear", "a0#1", NOW + 1);
      expect(accept("z", "seed", "z#5", NOW + 2).dispatched).toEqual([]);
      accept("v", "boot", "v#3", NOW + 3);
      expect(attemptIds(accept("e", "go", "e#6", NOW + 4).dispatched)).toEqual(["c1#7"]);
      expect(attemptIds(accept("c1", "done", "c1#7", NOW + 5).dispatched)).toEqual(["c2#8"]);
      expect(attemptIds(accept("c2", "done", "c2#8", NOW + 6).dispatched)).toEqual(["c3#9"]);

      // The satisfier is withdrawn and the splitter re-armed, so every settled
      // candidate now depends on ANOTHER candidate still being settled.
      accept("u", "reset", "u#2", NOW + 7);
      accept("w", "clear", "w#4", NOW + 8);
      expect(accept("c3", "done", "c3#9", NOW + 9).dispatched).toEqual([]);

      // THE DEFECT: this advance used to mint c1#12, c2#13 and c3#14 together
      // (an odd number of candidates; an even one armed none), each on a
      // member's attempt that the same advance supersedes — the cross-round
      // mixing the join gate exists to prevent.
      const critical = accept("e", "go", "e#10", NOW + 10);
      expect(critical.dispatched).toEqual([]);
      for (const [nodeId, attemptId] of [
        ["c1", "c1#7"],
        ["c2", "c2#8"],
        ["c3", "c3#9"],
      ] as const) {
        // Waiting is not an arm and not a failure: each candidate keeps the
        // attempt it settled on, and its arrival record is the evidence.
        expect(nodeOf(critical.state, nodeId)).toMatchObject({
          status: "settled",
          attemptId,
        });
      }

      // Waiting is also not a stall: an arrival that is NOT superseded arms the
      // cycle one member at a time, in dependency order.
      expect(attemptIds(accept("z", "seed", "z#11", NOW + 11).dispatched)).toEqual(["c1#12"]);
      expect(attemptIds(accept("c1", "done", "c1#12", NOW + 12).dispatched)).toEqual(["c2#13"]);
      expect(attemptIds(accept("c2", "done", "c2#13", NOW + 13).dispatched)).toEqual(["c3#14"]);

      console.log(
        "[probe:join-cycle] dispatches=" +
          JSON.stringify(attemptIds(requests)) +
          " state=" +
          stateSummary(runtime.state()),
      );
    });
  });
});

// ── Attempt credentials ─────────────────────────────────────────────────────

describe("OutcomeGraphRuntime — an attempt is named by the credential it was issued", () => {
  it("persists only the credential DIGEST on the attempt entry, and the value itself nowhere", async () => {
    await withHarness(LINEAR, async ({ runtime, ledger, requests, graphId }) => {
      const started = runtime.start(NOW);
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const request = requests[0];
      if (request === undefined) throw new Error("fixture: work was not dispatched");
      // Issued by the runtime and DELIVERED over the dispatch channel: the
      // request carries the credential, while the attempt's own persisted entry
      // records only its digest.
      expect(request.credential).toBe(credentialOf(requests, "work#1"));
      expect(nodeOf(started.state, "work").attemptCredentialDigest).toBe(
        attemptCredentialDigest(request.credential),
      );
      expect(nodeOf(started.state, "work").attemptCredential).toBeUndefined();

      const accepted = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: request.credential },
        NOW + 1,
      );
      expect(accepted.kind).toBe("accepted");
      if (accepted.kind !== "accepted") return;
      const shipCredential = credentialOf(requests, "ship#2");
      // The SETTLED entry keeps the settling attempt's DIGEST, which is what
      // lets a repeat resolve to the same attempt and replay its receipt.
      expect(nodeOf(accepted.state, "work").attemptCredentialDigest).toBe(
        attemptCredentialDigest(request.credential),
      );
      expect(nodeOf(accepted.state, "ship").attemptCredentialDigest).toBe(
        attemptCredentialDigest(shipCredential),
      );

      // The credential VALUE travels over the dispatch seam and is in no durable
      // record at all: not the state row, not an effect payload, not a receipt
      // and not an accepted event. A read-only reader of the store therefore
      // holds nothing it could present.
      const effects = ledger.pendingEffects(graphId);
      expect(effects).toHaveLength(1);
      expect(fieldOf(effects[0]?.payload, "credential")).toBeUndefined();
      const receipt = ledger.lookupReceipt({
        graphId,
        attemptId: "work#1",
        submissionId: accepted.receipt.submissionId,
      });
      for (const record of [
        JSON.stringify(effects[0]?.payload),
        JSON.stringify(receipt),
        JSON.stringify(ledger.acceptedEvents(graphId)),
        JSON.stringify(ledger.readGraphState(graphId)?.body),
      ]) {
        expect(record).not.toContain(request.credential);
        expect(record).not.toContain(shipCredential);
        expect(record).not.toContain(credentialOf(requests, "work#1"));
      }
      // The VERIFIER is there, though: the digest is what a submission is
      // checked against, and it is not the credential.
      expect(JSON.stringify(ledger.readGraphState(graphId)?.body)).toContain(
        attemptCredentialDigest(request.credential),
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
      const current = nodeOf(revised.state, "work").attemptCredentialDigest;
      expect(current).toBeDefined();
      expect(current).not.toBe(attemptCredentialDigest(firstCredential));
      expect(nodeOf(revised.state, "work").attemptCredential).toBeUndefined();

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
        credentialIsolation: testHostCredentialIsolation(dir),
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
        credentialIsolation: testHostCredentialIsolation(dir),
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
      // credential on any attempt and no arrival list (version 1 defines
      // neither).
      const v1Nodes = rawNodes.map((node) => {
        if (typeof node !== "object" || node === null) {
          throw new Error("fixture: a node entry is not a record");
        }
        const {
          attemptCredentialDigest: _digest,
          attemptCredential: _credential,
          arrivals: _arrivals,
          ...rest
        } = node as Record<string, unknown>;
        return rest;
      });
      // Version 1 defines neither the credential, the arrival list NOR the
      // progress record, so all three are stripped: a body carrying a field its
      // version does not define is a shape this writer never produced.
      const { loopProgress: _progress, ...v1Body } = body as Record<string, unknown>;
      ledger.writeGraphState({
        ...record,
        body: { ...v1Body, bodyVersion: 1, nodes: v1Nodes },
        updatedAt: NOW + 1,
      });
      const before = ledger.readGraphState(graphId);

      // RECOVERY refuses the attempt: it is not armed and not launched, because
      // no submission could ever settle it and recovery never grants a
      // credential the attempt was not issued. TWO records name the missing
      // credential — the node entry (unarmed) and the dispatch effect committed
      // for that attempt (unresolvable) — and each is reported, because each is
      // a durable object a reader has to be able to find.
      const resumed = runtime.resume(NOW + 2);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") return;
      expect(resumed.armed).toEqual([]);
      expect(resumed.dispatched).toEqual([]);
      expect(resumed.refusals.map((refusal) => refusal.code)).toEqual([
        "credential-missing",
        "credential-missing",
      ]);
      const paths = resumed.refusals.map((refusal) => refusal.path);
      expect(paths).toContain("$.attemptCredentialDigest");
      expect(paths.some((path) => path?.startsWith("$.nodes[") === true)).toBe(true);

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
  it("runs a legacy graph over an existing record through the state directory unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-file-store-"));
    try {
      // The record already exists, so this run is a resume/rebuild of a legacy
      // graph — NOT the creation of one. Creating a NEW durable legacy record
      // through the tool ingress is refused by the E gate
      // (`tests/graph/legacy-creation-gate.test.ts`); what this case pins is
      // that the legacy path itself is not retired: it still executes and still
      // owns the JSON file store.
      const seeded = createEngineState(
        {
          version: 2,
          name: "legacy-graph",
          nodes: [{ id: "A", agent: "a", prompt: "pA" }],
          edges: [],
        },
        "legacy-graph",
      );
      provision(seeded);
      seeded.phase = EnginePhase.Executing;
      const seededNode = seeded.nodes.get("A");
      if (seededNode === undefined) throw new Error("fixture: node A was not registered");
      seededNode.status = NodeStatus.Running;
      seeded.frontier = [];
      new EnginePersistence(dir).save(seeded);
      expect(existsSync(engineStatePath(dir, "legacy-graph"))).toBe(true);

      const ts = createGraphToolSet({
        stateDir: dir,
        dispatch: new CompletingDispatch(),
      });
      const { graph_id } = ts.graph_create({ name: "legacy-graph" });
      expect(graph_id).toBe("legacy-graph");
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
