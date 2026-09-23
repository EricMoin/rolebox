/**
 * Natural-completion settlement x the existing run semantics.
 *
 * The first natural-completion slice proved the settlement run path itself: the
 * closed delivery envelope, the pinned authorization, and the ONE acceptance
 * transaction it shares with a worker's submission. THIS file proves the
 * combination that path must have with the mechanisms already in the reducer —
 * and it is the combination, not the settlement, that is the subject:
 *
 * 1. LOOPS — a natural continuation advances the SAME \`loopTraversals\` counter
 *    an explicit submission advances (there is no per-channel counter) and stops
 *    on the SAME hard cap, through the same \`loop-exhausted\` stop, inside the
 *    same transaction.
 * 2. JOINS — a natural completion is a predecessor arrival: it is materialized
 *    into the durable \`arrivals\` list, it arms the convergence node only when
 *    the declared join is satisfied, it arms it EXACTLY ONCE, and a feeder that
 *    has been re-armed stops counting immediately (its earlier arrival is gone).
 * 3. PROGRESS — a natural continuation is governed by the SAME declared progress
 *    policy and is refused \`progress-subject-missing\` because the payload-free
 *    envelope carries no comparison object. A refused round enters \`loopProgress\`
 *    not at all: it neither grows the unchanged streak nor clears it, which the
 *    case below pins by making the NEXT comparable round reach the declared
 *    threshold. A natural EXIT outcome is measured by nothing, exactly as an
 *    explicit exit is, and can never produce a \`progress-stalled\` stop.
 * 4. RESTART — the settled state reads back field by field, recovery never
 *    fabricates a settlement for a completion fact that was never delivered, a
 *    second resume is idempotent, and a completion fact delivered to a NEW
 *    process still settles the attempt it was issued for (the binding lives in
 *    the state) and replays rather than settling twice.
 * 5. THE INVARIANT — every field the natural channel persists is compared
 *    leaf-by-leaf across write -> restart -> read -> write again, for the state
 *    record, the parsed state, the accepted-event stream, the effect rows and
 *    every receipt.
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
  type CompletionPolicyRegistry,
  type CompletionPolicyRule,
} from "../../src/graph/policy/completion-policy.ts";
import {
  SqliteAcceptanceLedger,
  ledgerFilePath,
} from "../../src/graph/ledger/sqlite-ledger.ts";
import {
  OutcomeGraphRuntime,
  type OutcomeDispatchRequest,
  type OutcomeNaturalSettlementResult,
  type OutcomeSubmissionResult,
} from "../../src/graph/outcome/runtime.ts";
import type { OutcomeGraphState } from "../../src/graph/outcome/graph-state.ts";
import type { AttemptCredentialSource } from "../../src/graph/outcome/attempt-credential.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { buildDeclaredOutcomeGraph } from "../../src/graph/tools/declare-graph.ts";
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const EMPTY_VALIDATORS = createValidatorRegistry([]);
const POLICY_PREFIX = "test.natural-combination.";
const POLICY_REVISION = "1";

const LOOP_GRAPH = "natural.combination.loop";
const STOP_GRAPH = "natural.combination.stop";
const JOIN_GRAPH = "natural.combination.join";
const JOIN_LOOP_GRAPH = "natural.combination.join-loop";
const PROGRESS_GRAPH = "natural.combination.progress";
const PROGRESS_EXIT_GRAPH = "natural.combination.progress-exit";

/**
 * work -> review -> (revise) -> work, where REVIEW completes NATURALLY into the
 * loop's continuation outcome. The cap is the only stop this graph can reach.
 */
function loopDeclaration(maxTraversals: number): GraphDeclarationV3 {
  return {
    version: 3,
    name: LOOP_GRAPH,
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
    completion_policy: { id: POLICY_PREFIX + LOOP_GRAPH, revision: POLICY_REVISION },
  };
}

/**
 * The same cap-1 loop plus an INDEPENDENT natural-authorized branch (\`side\`)
 * that is still in flight when the cap stops the run. It exists so a completion
 * fact can arrive after the stop for an attempt the state still records.
 */
function stopDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: STOP_GRAPH,
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
      {
        id: "side",
        agent: "agent.side",
        prompt: "Do the side work.",
        outcomes: [{ id: "side-done" }],
        completion: { mode: "natural", outcome: "side-done" },
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
        max_traversals: 1,
        continuation_outcome: "revise",
        exit_outcome: "approve",
      },
    ],
    completion_policy: { id: POLICY_PREFIX + STOP_GRAPH, revision: POLICY_REVISION },
  };
}

/**
 * root forks into a NATURAL feeder (\`left\`) and an explicit one (\`right\`);
 * both converge on \`merge\`, whose default join is \`all\`.
 */
function joinDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: JOIN_GRAPH,
    nodes: [
      { id: "root", agent: "agent.root", prompt: "Start.", outcomes: [{ id: "go" }] },
      {
        id: "left",
        agent: "agent.left",
        prompt: "Left branch.",
        outcomes: [{ id: "finish-left" }],
        completion: { mode: "natural", outcome: "finish-left" },
      },
      {
        id: "right",
        agent: "agent.right",
        prompt: "Right branch.",
        outcomes: [{ id: "finish-right" }],
      },
      { id: "merge", agent: "agent.merge", prompt: "Merge.", outcomes: [{ id: "merged" }] },
    ],
    edges: [
      { from: "root", to: "left", outcome: "go" },
      { from: "root", to: "right", outcome: "go" },
      { from: "left", to: "merge", outcome: "finish-left" },
      { from: "right", to: "merge", outcome: "finish-right" },
    ],
    completion_policy: { id: POLICY_PREFIX + JOIN_GRAPH, revision: POLICY_REVISION },
  };
}

/**
 * A loop whose natural completion is the join arrival AND whose continuation
 * RE-ARMS the same feeder: `feed` completes naturally into "again", which
 * leaves the loop for `merge` and puts an arrival there, while `driver` can
 * still emit the loop's continuation "go" and re-arm `feed` on a fresh
 * attempt. At that moment the earlier arrival must stop counting.
 */
function joinLoopDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: JOIN_LOOP_GRAPH,
    nodes: [
      {
        id: "driver",
        agent: "agent.driver",
        prompt: "Drive the loop.",
        outcomes: [{ id: "go" }],
      },
      {
        id: "feed",
        agent: "agent.feed",
        prompt: "Feed the join.",
        outcomes: [{ id: "again" }],
        completion: { mode: "natural", outcome: "again" },
      },
      { id: "other", agent: "agent.other", prompt: "Other feeder.", outcomes: [{ id: "done" }] },
      { id: "merge", agent: "agent.merge", prompt: "Merge.", outcomes: [{ id: "merged" }] },
    ],
    edges: [
      { from: "driver", to: "feed", outcome: "go" },
      { from: "feed", to: "merge", outcome: "again" },
      { from: "other", to: "merge", outcome: "done" },
    ],
    loop_groups: [
      {
        id: "feed-loop",
        nodes: ["driver", "feed"],
        max_traversals: 3,
        continuation_outcome: "go",
        exit_outcome: "again",
      },
    ],
    completion_policy: { id: POLICY_PREFIX + JOIN_LOOP_GRAPH, revision: POLICY_REVISION },
  };
}

/** A progress-governed loop whose natural mapping IS the continuation. */
function progressDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: PROGRESS_GRAPH,
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
        max_traversals: 8,
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
    completion_policy: { id: POLICY_PREFIX + PROGRESS_GRAPH, revision: POLICY_REVISION },
  };
}

/** The same progress loop, but the natural mapping is the EXIT outcome. */
function progressExitDeclaration(): GraphDeclarationV3 {
  return {
    ...progressDeclaration(),
    name: PROGRESS_EXIT_GRAPH,
    nodes: progressDeclaration().nodes.map((node) =>
      node.id === "review"
        ? { ...node, completion: { mode: "natural" as const, outcome: "approve" } }
        : node,
    ),
    completion_policy: {
      id: POLICY_PREFIX + PROGRESS_EXIT_GRAPH,
      revision: POLICY_REVISION,
    },
  };
}

// ── Harness ─────────────────────────────────────────────────────────────────

/** One credential per attempt, derived from the binding the runtime hands it. */
const TEST_CREDENTIAL_SOURCE: AttemptCredentialSource = (binding) =>
  "test-credential:" + binding.nodeId + "#" + binding.attemptId;

/**
 * One graph's durable store plus the runtime process reading it. A RESTART
 * replaces \`ledger\` and \`runtime\` (a new process) while \`requests\` and
 * \`settlements\` survive, because the credentials and the receipts a restart is
 * about are the ones the earlier process handed out.
 */
interface Store {
  readonly dir: string;
  readonly declaration: GraphDeclarationV3;
  readonly plan: CompiledPlan;
  readonly graphId: string;
  readonly requests: OutcomeDispatchRequest[];
  readonly settlements: { readonly attemptId: string; readonly submissionId: string }[];
  ledger: SqliteAcceptanceLedger;
  runtime: OutcomeGraphRuntime;
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

/**
 * One installed policy per fixture: the repository-style declaration the plan
 * REQUESTS is installed by content, exactly the mapping each natural node
 * declares. No other mapping is granted.
 */
function policiesFor(declaration: GraphDeclarationV3): CompletionPolicyRegistry {
  const graphId = declaration.name;
  const rules: CompletionPolicyRule[] = [];
  for (const node of declaration.nodes) {
    const completion = node.completion;
    if (completion === undefined || completion.mode !== "natural") continue;
    rules.push({
      graphId,
      nodeId: node.id,
      outcome: completion.outcome,
      decision: "allow",
    });
  }
  const body: CompletionPolicyBody = {
    version: 1,
    default: "ungranted",
    rules,
  };
  const ref = completionPolicyRefOf({
    id: POLICY_PREFIX + graphId,
    revision: POLICY_REVISION,
    body,
  });
  return createCompletionPolicyRegistry({ policies: [{ ref, body }] });
}

/** Build the plan and the first process on a fresh store. */
async function openStore(
  declaration: GraphDeclarationV3,
  prefix: string,
): Promise<Store> {
  const dir = makeTmpDir(prefix);
  const policies = policiesFor(declaration);
  const declared = buildDeclaredOutcomeGraph({
    declaration,
    completionPolicies: policies,
  });
  const ledger = await SqliteAcceptanceLedger.create(dir);
  const requests: OutcomeDispatchRequest[] = [];
  const store: Store = {
    dir,
    declaration,
    plan: declared.plan,
    graphId: declared.graphId,
    requests,
    settlements: [],
    ledger,
    runtime: undefined as never,
  };
  store.runtime = buildRuntime(store, ledger, policies);
  return store;
}

/** The runtime one process runs: same plan, same store, fresh object. */
function buildRuntime(
  store: Store,
  ledger: SqliteAcceptanceLedger,
  policies: CompletionPolicyRegistry,
): OutcomeGraphRuntime {
  return new OutcomeGraphRuntime({
    plan: store.plan,
    ledger,
    dispatch: (request) => {
      store.requests.push(request);
    },
    validators: EMPTY_VALIDATORS,
    artifactRoot: store.dir,
    clock: () => NOW,
    mintCredential: TEST_CREDENTIAL_SOURCE,
    credentialIsolation: testHostCredentialIsolation(store.dir),
    completionPolicies: policies,
  });
}

/** A RESTART: close the old process's ledger, open a new one on the same store. */
async function restart(store: Store): Promise<Store> {
  store.ledger.close();
  const ledger = await SqliteAcceptanceLedger.create(store.dir);
  store.ledger = ledger;
  store.runtime = buildRuntime(store, ledger, policiesFor(store.declaration));
  return store;
}

/** The dispatch request one attempt was handed, failing when it never ran. */
function requestOf(store: Store, attemptId: string): OutcomeDispatchRequest {
  const found = store.requests.find((request) => request.attemptId === attemptId);
  if (found === undefined) {
    throw new Error(
      "fixture: no dispatch request for attempt " +
        attemptId +
        " (dispatched: " +
        store.requests.map((request) => request.attemptId).join(", ") +
        ")",
    );
  }
  return found;
}

/** The CURRENT attempt of one node, from the last dispatch it was handed. */
function currentAttempt(store: Store, nodeId: string): OutcomeDispatchRequest {
  for (let index = store.requests.length - 1; index >= 0; index -= 1) {
    const request = store.requests[index];
    if (request !== undefined && request.nodeId === nodeId) return request;
  }
  throw new Error("fixture: node " + nodeId + " was never dispatched");
}

/** Submit the node's current attempt through the worker-claimed channel. */
function submitCurrent(
  store: Store,
  nodeId: string,
  outcomeId: string,
  now: number,
  data?: unknown,
): OutcomeSubmissionResult {
  const attempt = currentAttempt(store, nodeId);
  const result = store.runtime.submit(
    {
      nodeId,
      outcomeId,
      credential: attempt.credential,
      ...(data === undefined ? {} : { data }),
    },
    now,
  );
  if (result.kind === "accepted") {
    store.settlements.push({
      attemptId: result.receipt.attemptId,
      submissionId: result.receipt.submissionId,
    });
  }
  return result;
}

/** Deliver the node's current attempt's completion fact. */
function deliverCurrent(
  store: Store,
  nodeId: string,
  now: number,
): OutcomeNaturalSettlementResult {
  const attempt = currentAttempt(store, nodeId);
  const result = store.runtime.settleNatural(
    { nodeId, attemptId: attempt.attemptId, credential: attempt.credential },
    now,
  );
  if (result.kind === "accepted") {
    store.settlements.push({
      attemptId: result.receipt.attemptId,
      submissionId: result.receipt.submissionId,
    });
  }
  return result;
}

/** One node's state entry, failing the test when it is missing. */
function nodeOf(state: OutcomeGraphState, nodeId: string) {
  const found = state.nodes.find((node) => node.nodeId === nodeId);
  if (found === undefined) throw new Error("no state for node " + nodeId);
  return found;
}

/** Everything a restart must read back: the raw record, the parsed state, the streams. */
interface Snapshot {
  readonly stateRecord: unknown;
  readonly state: OutcomeGraphState | undefined;
  readonly events: unknown;
  readonly effects: unknown;
  readonly receipts: unknown;
}

function snapshot(store: Store): Snapshot {
  return {
    stateRecord: store.ledger.readGraphState(store.graphId),
    state: store.runtime.state(),
    events: store.ledger.acceptedEvents(store.graphId),
    effects: store.ledger.pendingEffects(store.graphId),
    receipts: store.settlements.map((settlement) =>
      store.ledger.lookupReceipt({
        graphId: store.graphId,
        attemptId: settlement.attemptId,
        submissionId: settlement.submissionId,
      }),
    ),
  };
}

/**
 * Every leaf two snapshots disagree on, by path. This is the field-by-field
 * read-back: an object that lost a key, gained one, reordered an array or
 * re-typed a value is reported by its own path instead of by one big string
 * comparison.
 */
function differences(left: unknown, right: unknown, path = "$"): string[] {
  if (Object.is(left, right)) return [];
  if (Array.isArray(left) && Array.isArray(right)) {
    const out: string[] = [];
    if (left.length !== right.length) {
      out.push(path + ".length: " + left.length + " !== " + right.length);
    }
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      out.push(...differences(left[index], right[index], path + "[" + index + "]"));
    }
    return out;
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    const out: string[] = [];
    for (const key of keys) {
      out.push(...differences(left[key], right[key], path + "." + key));
    }
    return out;
  }
  return [path + ": " + JSON.stringify(left) + " !== " + JSON.stringify(right)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Assert two snapshots agree on EVERY leaf, reporting the offending paths. */
function expectSameSnapshot(before: Snapshot, after: Snapshot): void {
  expect(differences(before, after)).toEqual([]);
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

// ── 1. Loops ────────────────────────────────────────────────────────────────

describe("settleNatural — loops: one counter, one cap, one durable stop", () => {
  it("counts natural and explicit rounds on ONE counter and stops on the declared cap", async () => {
    const store = await openStore(loopDeclaration(2), "natural-combination-loop-");
    try {
      expect(store.runtime.start(NOW).kind).toBe("started");

      // Round 1: the worker claims work's outcome; the review completes NATURALLY.
      expect(
        submitCurrent(store, "work", "done", NOW + 1).kind,
      ).toBe("accepted");
      const first = deliverCurrent(store, "review", NOW + 2);
      expect(first.kind).toBe("accepted");
      if (first.kind !== "accepted") return;
      expect(first.completion.outcomeId).toBe("revise");
      expect(first.state.loopTraversals["revise-loop"]).toBe(1);
      expect(first.dispatched.map((request) => request.attemptId)).toEqual(["work#3"]);

      // Round 2: the SAME counter, advanced by an EXPLICIT submission.
      expect(submitCurrent(store, "work", "done", NOW + 3).kind).toBe("accepted");
      const second = submitCurrent(store, "review", "revise", NOW + 4);
      expect(second.kind).toBe("accepted");
      if (second.kind !== "accepted") return;
      expect(second.state.loopTraversals["revise-loop"]).toBe(2);
      // One state field, not one per channel: the counter the natural round
      // advanced is the counter the explicit round advanced.
      expect(Object.keys(second.state.loopTraversals)).toEqual(["revise-loop"]);
      expect(second.dispatched.map((request) => request.attemptId)).toEqual(["work#5"]);

      // Round 3: the natural continuation reaches the cap.
      expect(submitCurrent(store, "work", "done", NOW + 5).kind).toBe("accepted");
      const capped = deliverCurrent(store, "review", NOW + 6);
      expect(capped.kind).toBe("accepted");
      if (capped.kind !== "accepted") return;
      expect(capped.stop?.reason).toBe("loop-exhausted");
      expect(capped.state.phase).toBe("stopped");
      expect(capped.state.loopTraversals["revise-loop"]).toBe(2);
      expect(capped.dispatched).toEqual([]);
      expect(nodeOf(capped.state, "review")).toMatchObject({
        status: "settled",
        outcomeId: "revise",
      });
    } finally {
      store.ledger.close();
    }
  });

  it("keeps the stop across a restart, resumes idempotently, and refuses a completion fact for an attempt still in flight", async () => {
    const store = await openStore(stopDeclaration(), "natural-combination-stop-");
    try {
      expect(store.runtime.start(NOW).kind).toBe("started");
      expect(submitCurrent(store, "work", "done", NOW + 1).kind).toBe("accepted");
      expect(deliverCurrent(store, "review", NOW + 2).kind).toBe("accepted");
      expect(submitCurrent(store, "work", "done", NOW + 3).kind).toBe("accepted");
      const stop = deliverCurrent(store, "review", NOW + 4);
      expect(stop.kind).toBe("accepted");
      if (stop.kind !== "accepted") return;
      expect(stop.stop?.reason).toBe("loop-exhausted");

      // \`side\` is STILL IN FLIGHT when the cap ends the run.
      const sideAttempt = currentAttempt(store, "side");
      expect(nodeOf(stop.state, "side").status).toBe("dispatched");

      const before = snapshot(store);
      const receiptsBefore = await countTable(store.dir, "ledger_receipts");
      const late = store.runtime.settleNatural(
        {
          nodeId: "side",
          attemptId: sideAttempt.attemptId,
          credential: sideAttempt.credential,
        },
        NOW + 5,
      );
      expect(late.kind).toBe("refused");
      if (late.kind === "refused") {
        expect(late.refusals.map((refusal) => refusal.code)).toEqual(["graph-stopped"]);
      }
      // NOTHING was written: no receipt, no event, no state advance.
      expectSameSnapshot(before, snapshot(store));
      expect(await countTable(store.dir, "ledger_receipts")).toBe(receiptsBefore);

      // A restart reports the same stop, writes nothing, and is idempotent.
      const restarted = await restart(store);
      const firstResume = restarted.runtime.resume(NOW + 6);
      expect(firstResume.kind).toBe("resumed");
      if (firstResume.kind !== "resumed") return;
      expect(firstResume.stop?.reason).toBe("loop-exhausted");
      expect(firstResume.dispatched).toEqual([]);
      const afterFirst = snapshot(restarted);
      expectSameSnapshot(before, afterFirst);
      const secondResume = restarted.runtime.resume(NOW + 7);
      expect(secondResume.kind).toBe("resumed");
      if (secondResume.kind !== "resumed") return;
      expect(secondResume.stop?.reason).toBe("loop-exhausted");
      expectSameSnapshot(afterFirst, snapshot(restarted));

      // The late completion fact is still refused in the new process.
      const lateAfterRestart = restarted.runtime.settleNatural(
        {
          nodeId: "side",
          attemptId: sideAttempt.attemptId,
          credential: sideAttempt.credential,
        },
        NOW + 8,
      );
      expect(lateAfterRestart.kind).toBe("refused");
      if (lateAfterRestart.kind === "refused") {
        expect(lateAfterRestart.refusals.map((refusal) => refusal.code)).toEqual([
          "graph-stopped",
        ]);
      }
      expectSameSnapshot(afterFirst, snapshot(restarted));

      // The delivery that STOPPED the run repeats as its own receipt.
      const stopping = currentAttempt(store, "review");
      const replay = restarted.runtime.settleNatural(
        {
          nodeId: "review",
          attemptId: stopping.attemptId,
          credential: stopping.credential,
        },
        NOW + 9,
      );
      expect(replay.kind).toBe("accepted");
      if (replay.kind !== "accepted") return;
      expect(replay.replayed).toBe(true);
      expectSameSnapshot(afterFirst, snapshot(restarted));
    } finally {
      store.ledger.close();
    }
  });
});

/** The nth (1-based) dispatch request for a node, for a superseded attempt. */
function currentAttemptBefore(
  store: Store,
  nodeId: string,
  ordinal: number,
): OutcomeDispatchRequest {
  const matching = store.requests.filter((request) => request.nodeId === nodeId);
  const found = matching[ordinal - 1];
  if (found === undefined) {
    throw new Error(
      "fixture: node " + nodeId + " has no dispatch request #" + ordinal,
    );
  }
  return found;
}

// ── 2. Joins ────────────────────────────────────────────────────────────────

describe("settleNatural — joins: a natural arrival is durable evidence, consumed once", () => {
  it("records the arrival, waits for the other feeder, and arms the merge exactly once", async () => {
    const store = await openStore(joinDeclaration(), "natural-combination-join-");
    try {
      expect(store.runtime.start(NOW).kind).toBe("started");
      expect(submitCurrent(store, "root", "go", NOW + 1).kind).toBe("accepted");

      const settled = deliverCurrent(store, "left", NOW + 2);
      expect(settled.kind).toBe("accepted");
      if (settled.kind !== "accepted") return;
      // The natural completion is a PREDECESSOR ARRIVAL, materialized into the
      // durable inbox — and the unsatisfied join arms NOTHING.
      expect(nodeOf(settled.state, "merge")).toMatchObject({ status: "pending" });
      expect(nodeOf(settled.state, "merge").arrivals).toEqual([
        { from: "left", outcome: "finish-left", attemptId: "left#2" },
      ]);
      expect(settled.dispatched).toEqual([]);
      expect(settled.state.phase).toBe("executing");

      // Even a repeated delivery cannot arm the merge on one feeder.
      const replay = deliverCurrent(store, "left", NOW + 3);
      expect(replay.kind).toBe("accepted");
      if (replay.kind !== "accepted") return;
      expect(replay.replayed).toBe(true);
      expect(nodeOf(replay.state, "merge").status).toBe("pending");
      expect(nodeOf(replay.state, "merge").arrivals).toHaveLength(1);

      // The second feeder satisfies the join; the merge is armed ONCE.
      const merged = submitCurrent(store, "right", "finish-right", NOW + 4);
      expect(merged.kind).toBe("accepted");
      if (merged.kind !== "accepted") return;
      expect(merged.dispatched.map((request) => request.attemptId)).toEqual(["merge#4"]);
      expect(nodeOf(merged.state, "merge")).toMatchObject({
        status: "dispatched",
        attemptId: "merge#4",
      });
      expect(nodeOf(merged.state, "merge").arrivals).toEqual([
        { from: "left", outcome: "finish-left", attemptId: "left#2" },
        { from: "right", outcome: "finish-right", attemptId: "right#3" },
      ]);

      // A late repeat of the natural fact lands on the SAME attempt in flight.
      const afterArm = deliverCurrent(store, "left", NOW + 5);
      expect(afterArm.kind).toBe("accepted");
      if (afterArm.kind !== "accepted") return;
      expect(afterArm.replayed).toBe(true);
      expect(nodeOf(afterArm.state, "merge").attemptId).toBe("merge#4");
      expect(afterArm.dispatched).toEqual([]);
    } finally {
      store.ledger.close();
    }
  });

  it("keeps the arrival across a restart and drops it when the feeder is re-armed", async () => {
    const store = await openStore(
      joinLoopDeclaration(),
      "natural-combination-join-loop-",
    );
    try {
      expect(store.runtime.start(NOW).kind).toBe("started");

      // The natural completion leaves the loop for the merge: the arrival is
      // recorded, the unsatisfied join arms nothing.
      const exited = deliverCurrent(store, "feed", NOW + 1);
      expect(exited.kind).toBe("accepted");
      if (exited.kind !== "accepted") return;
      expect(nodeOf(exited.state, "merge")).toMatchObject({ status: "pending" });
      expect(nodeOf(exited.state, "merge").arrivals).toEqual([
        { from: "feed", outcome: "again", attemptId: "feed#2" },
      ]);

      // The loop's continuation re-arms the SAME feeder on a fresh attempt; the
      // earlier arrival stops counting the moment that attempt starts.
      const rearmed = submitCurrent(store, "driver", "go", NOW + 2);
      expect(rearmed.kind).toBe("accepted");
      if (rearmed.kind !== "accepted") return;
      expect(rearmed.state.loopTraversals["feed-loop"]).toBe(1);
      expect(rearmed.dispatched.map((request) => request.attemptId)).toEqual(["feed#4"]);
      expect(nodeOf(rearmed.state, "feed")).toMatchObject({
        status: "dispatched",
        attemptId: "feed#4",
      });
      expect(nodeOf(rearmed.state, "merge").arrivals).toEqual([]);

      // The other feeder alone cannot satisfy the merge: the stale natural
      // answer no longer counts.
      const other = submitCurrent(store, "other", "done", NOW + 3);
      expect(other.kind).toBe("accepted");
      if (other.kind !== "accepted") return;
      expect(nodeOf(other.state, "merge")).toMatchObject({ status: "pending" });
      expect(nodeOf(other.state, "merge").arrivals).toEqual([
        { from: "other", outcome: "done", attemptId: "other#3" },
      ]);

      // The re-armed feeder's OWN natural completion satisfies the join, once.
      const again = deliverCurrent(store, "feed", NOW + 4);
      expect(again.kind).toBe("accepted");
      if (again.kind !== "accepted") return;
      expect(again.completion.attemptId).toBe("feed#4");
      expect(again.state.loopTraversals["feed-loop"]).toBe(1);
      expect(nodeOf(again.state, "merge").arrivals).toEqual([
        { from: "feed", outcome: "again", attemptId: "feed#4" },
        { from: "other", outcome: "done", attemptId: "other#3" },
      ]);
      const mergeAttempt = currentAttempt(store, "merge");
      expect(again.dispatched.map((request) => request.attemptId)).toEqual([
        mergeAttempt.attemptId,
      ]);

      // A restart reads the same arrivals back, and the superseded credential
      // cannot re-aim an old answer at the re-armed feeder.
      const before = snapshot(store);
      const restarted = await restart(store);
      expectSameSnapshot(before, snapshot(restarted));
      const oldCredential = currentAttemptBefore(store, "feed", 1).credential;
      const stale = restarted.runtime.settleNatural(
        { nodeId: "feed", attemptId: "feed#2", credential: oldCredential },
        NOW + 6,
      );
      expect(stale.kind).toBe("refused");
      if (stale.kind === "refused") {
        expect(stale.refusals.map((refusal) => refusal.code)).toEqual([
          "credential-unknown",
        ]);
      }
      expectSameSnapshot(before, snapshot(restarted));

      // The live delivery replays without re-arming the merge.
      const replay = restarted.runtime.settleNatural(
        {
          nodeId: "feed",
          attemptId: again.completion.attemptId,
          credential: requestOf(store, again.completion.attemptId).credential,
        },
        NOW + 7,
      );
      expect(replay.kind).toBe("accepted");
      if (replay.kind !== "accepted") return;
      expect(replay.replayed).toBe(true);
      expect(nodeOf(replay.state, "merge").attemptId).toBe(mergeAttempt.attemptId);
      expect(replay.dispatched).toEqual([]);
    } finally {
      store.ledger.close();
    }
  });
});

// ── 3. Progress ─────────────────────────────────────────────────────────────

describe("settleNatural — progress: no comparison object, so no bypass", () => {
  it("refuses a progress-governed continuation and leaves the unchanged streak untouched", async () => {
    const store = await openStore(progressDeclaration(), "natural-combination-progress-");
    try {
      expect(store.runtime.start(NOW).kind).toBe("started");

      expect(submitCurrent(store, "work", "done", NOW + 1).kind).toBe("accepted");
      const first = submitCurrent(store, "review", "revise", NOW + 2, {
        revision: "r1",
      });
      expect(first.kind).toBe("accepted");
      if (first.kind !== "accepted") return;
      expect(first.progress?.[0]).toMatchObject({
        loopGroupId: "revise-loop",
        verdict: "progressed",
        unchanged: 0,
        baseline: "r1",
        stalled: false,
      });
      expect(first.state.loopTraversals["revise-loop"]).toBe(1);

      // A second round with the SAME revision: comparable, unchanged, streak 1.
      expect(submitCurrent(store, "work", "done", NOW + 3).kind).toBe("accepted");
      const second = submitCurrent(store, "review", "revise", NOW + 4, {
        revision: "r1",
      });
      expect(second.kind).toBe("accepted");
      if (second.kind !== "accepted") return;
      expect(second.progress?.[0]).toMatchObject({ verdict: "unchanged", unchanged: 1 });

      // The natural continuation carries no comparison object, so the declared
      // comparison is REFUSED rather than skipped.
      expect(submitCurrent(store, "work", "done", NOW + 5).kind).toBe("accepted");
      const before = snapshot(store);
      const receiptsBefore = await countTable(store.dir, "ledger_receipts");
      const refused = deliverCurrent(store, "review", NOW + 6);
      expect(refused.kind).toBe("refused");
      if (refused.kind === "refused") {
        expect(refused.refusals.map((refusal) => refusal.code)).toEqual([
          "progress-subject-missing",
        ]);
        expect(refused.refusals[0]?.path).toBe("$.data.revision");
      }
      expectSameSnapshot(before, snapshot(store));
      expect(await countTable(store.dir, "ledger_receipts")).toBe(receiptsBefore);
      const untouched = store.runtime.state();
      expect(untouched === undefined ? undefined : untouched.loopTraversals["revise-loop"]).toBe(2);
      expect(
        untouched === undefined ? undefined : untouched.loopProgress?.["revise-loop"]?.unchanged,
      ).toBe(1);
      // The attempt stays open for the repair the refusal asks for.
      expect(
        untouched === undefined ? undefined : nodeOf(untouched, "review").status,
      ).toBe("dispatched");

      // THE STREAK SURVIVED THE REFUSED ROUND. Had the natural round entered the
      // comparison (as unchanged OR as unknown), this next comparable round
      // could not reach the declared threshold of 2.
      const third = submitCurrent(store, "review", "revise", NOW + 7, {
        revision: "r1",
      });
      expect(third.kind).toBe("accepted");
      if (third.kind !== "accepted") return;
      expect(third.progress?.[0]).toMatchObject({ verdict: "unchanged", unchanged: 2, stalled: true });
      expect(third.stop?.reason).toBe("progress-stalled");
      expect(third.state.phase).toBe("stopped");
      // A natural completion can reach the cap (loop-exhausted) but never this
      // stop: no natural round was ever compared. The refused round took no
      // counter step, so the repair round is the loop's third traversal.
      expect(third.state.loopTraversals["revise-loop"]).toBe(3);
    } finally {
      store.ledger.close();
    }
  });

  it("accepts a natural EXIT outcome as an unmeasured round and compares nothing", async () => {
    const store = await openStore(
      progressExitDeclaration(),
      "natural-combination-progress-exit-",
    );
    try {
      expect(store.runtime.start(NOW).kind).toBe("started");
      expect(submitCurrent(store, "work", "done", NOW + 1).kind).toBe("accepted");
      const explicit = submitCurrent(store, "review", "revise", NOW + 2, {
        revision: "r1",
      });
      expect(explicit.kind).toBe("accepted");
      if (explicit.kind !== "accepted") return;
      expect(explicit.state.loopProgress?.["revise-loop"]).toMatchObject({
        baseline: "r1",
        unchanged: 0,
      });

      // The natural mapping is the loop's EXIT: the outcome is not governed by
      // the progress policy, so it needs no subject and compares nothing —
      // precisely the rule an explicit exit outcome obeys.
      expect(submitCurrent(store, "work", "done", NOW + 3).kind).toBe("accepted");
      const exited = deliverCurrent(store, "review", NOW + 4);
      expect(exited.kind).toBe("accepted");
      if (exited.kind !== "accepted") return;
      expect(exited.completion.outcomeId).toBe("approve");
      expect(exited.progress).toBeUndefined();
      expect(exited.stop).toBeUndefined();
      expect(exited.state.phase).toBe("complete");
      expect(exited.state.loopTraversals["revise-loop"]).toBe(1);
      expect(exited.state.loopProgress?.["revise-loop"]).toMatchObject({
        baseline: "r1",
        unchanged: 0,
      });

      // The exit state reads back across a restart without a comparison.
      const before = snapshot(store);
      const restarted = await restart(store);
      expectSameSnapshot(before, snapshot(restarted));
      const resumed = restarted.runtime.resume(NOW + 5);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") return;
      expect(resumed.state.phase).toBe("complete");
      expect(resumed.dispatched).toEqual([]);
    } finally {
      store.ledger.close();
    }
  });
});

// ── 4. Restart recovery ─────────────────────────────────────────────────────

describe("settleNatural — restart: read back, fabricate nothing, resume twice", () => {
  it("reads the settled state back field by field and replays the same receipt", async () => {
    const store = await openStore(joinDeclaration(), "natural-combination-restart-");
    try {
      expect(store.runtime.start(NOW).kind).toBe("started");
      expect(submitCurrent(store, "root", "go", NOW + 1).kind).toBe("accepted");
      const settled = deliverCurrent(store, "left", NOW + 2);
      expect(settled.kind).toBe("accepted");
      if (settled.kind !== "accepted") return;

      const before = snapshot(store);
      const restarted = await restart(store);
      // Every leaf — raw state record, parsed state, events, effects, receipts.
      expectSameSnapshot(before, snapshot(restarted));

      // The natural provenance is READ BACK from the durable record.
      const events = restarted.ledger.acceptedEvents(restarted.graphId);
      const leftEvent = events.find((event) => event.attemptId === "left#2");
      expect(leftEvent?.submissionId).toBe(settled.completion.submissionId);
      expect(settled.completion.submissionId.startsWith("natural-completion:")).toBe(true);

      // A repeated delivery replays the FIRST receipt, across the process boundary.
      const replay = restarted.runtime.settleNatural(
        {
          nodeId: "left",
          attemptId: "left#2",
          credential: requestOf(store, "left#2").credential,
        },
        NOW + 3,
      );
      expect(replay.kind).toBe("accepted");
      if (replay.kind !== "accepted") return;
      expect(replay.replayed).toBe(true);
      expect(replay.receipt).toEqual(settled.receipt);
      expect(replay.decision.identity.submissionId).toBe(settled.receipt.submissionId);
      expectSameSnapshot(before, snapshot(restarted));
    } finally {
      store.ledger.close();
    }
  });

  it("never fabricates a settlement for an undelivered completion fact and resumes twice identically", async () => {
    const store = await openStore(loopDeclaration(2), "natural-combination-nofab-");
    try {
      expect(store.runtime.start(NOW).kind).toBe("started");
      expect(submitCurrent(store, "work", "done", NOW + 1).kind).toBe("accepted");
      // review#2 is in flight and natural-authorized, and its completion fact was
      // NEVER delivered when the process died.
      const before = snapshot(store);
      const eventsBefore = store.ledger.acceptedEvents(store.graphId).length;

      const restarted = await restart(store);
      const first = restarted.runtime.resume(NOW + 2);
      expect(first.kind).toBe("resumed");
      if (first.kind !== "resumed") return;
      expect(first.dispatched).toEqual([]);
      const afterFirst = snapshot(restarted);
      expectSameSnapshot(before, afterFirst);

      // Resume is idempotent, and recovery wrote no acceptance of its own.
      const second = restarted.runtime.resume(NOW + 3);
      expect(second.kind).toBe("resumed");
      if (second.kind !== "resumed") return;
      expect(second.dispatched).toEqual([]);
      expectSameSnapshot(afterFirst, snapshot(restarted));
      expect(restarted.ledger.acceptedEvents(restarted.graphId)).toHaveLength(eventsBefore);
      // The attempt is still exactly where the delivery left it: in flight.
      const state = restarted.runtime.state();
      expect(state === undefined ? undefined : nodeOf(state, "review").status).toBe(
        "dispatched",
      );

      // The fact delivered to the NEW process settles that same attempt.
      const delivered = deliverCurrent(restarted, "review", NOW + 4);
      expect(delivered.kind).toBe("accepted");
      if (delivered.kind !== "accepted") return;
      expect(delivered.completion.attemptId).toBe("review#2");
      expect(restarted.ledger.acceptedEvents(restarted.graphId)).toHaveLength(
        eventsBefore + 1,
      );
    } finally {
      store.ledger.close();
    }
  });
});

// ── 5. The persisted invariant ──────────────────────────────────────────────

describe("settleNatural — the persisted invariant closes over a restart", () => {
  it("compares every persisted field across write -> restart -> read -> write again", async () => {
    const store = await openStore(joinDeclaration(), "natural-combination-invariant-");
    try {
      expect(store.runtime.start(NOW).kind).toBe("started");
      expect(submitCurrent(store, "root", "go", NOW + 1).kind).toBe("accepted");

      // WRITE 1 — a natural settlement: node entries, attempt counter, arrivals,
      // the receipt and the accepted event.
      const settled = deliverCurrent(store, "left", NOW + 2);
      expect(settled.kind).toBe("accepted");
      if (settled.kind !== "accepted") return;
      const afterNatural = snapshot(store);

      // RESTART -> READ.
      const firstRestart = await restart(store);
      expectSameSnapshot(afterNatural, snapshot(firstRestart));

      // WRITE 2 after the read — a replay, then a real explicit write.
      const replay = firstRestart.runtime.settleNatural(
        {
          nodeId: "left",
          attemptId: "left#2",
          credential: requestOf(store, "left#2").credential,
        },
        NOW + 3,
      );
      expect(replay.kind).toBe("accepted");
      expectSameSnapshot(afterNatural, snapshot(firstRestart));

      const right = submitCurrent(firstRestart, "right", "finish-right", NOW + 4);
      expect(right.kind).toBe("accepted");
      if (right.kind !== "accepted") return;
      // The write after the restart advanced the SAME fields the natural write
      // had already written: the arrival inbox and the attempt counter.
      expect(nodeOf(right.state, "merge").attemptId).toBe("merge#4");
      expect(nodeOf(right.state, "merge").arrivals).toHaveLength(2);
      const afterExplicit = snapshot(firstRestart);

      // RESTART -> READ again: identical leaf for leaf.
      const secondRestart = await restart(firstRestart);
      expectSameSnapshot(afterExplicit, snapshot(secondRestart));

      // A third write closes the run; its state reads back too.
      const merged = submitCurrent(secondRestart, "merge", "merged", NOW + 5);
      expect(merged.kind).toBe("accepted");
      if (merged.kind !== "accepted") return;
      expect(merged.state.phase).toBe("complete");
      const afterMerge = snapshot(secondRestart);
      const thirdRestart = await restart(secondRestart);
      expectSameSnapshot(afterMerge, snapshot(thirdRestart));

      // Every receipt compares equal across every restart, by submission id.
      expect(thirdRestart.settlements).toHaveLength(4);
      for (const settlement of thirdRestart.settlements) {
        const receipt = thirdRestart.ledger.lookupReceipt({
          graphId: thirdRestart.graphId,
          attemptId: settlement.attemptId,
          submissionId: settlement.submissionId,
        });
        expect(receipt?.submissionId).toBe(settlement.submissionId);
      }
    } finally {
      store.ledger.close();
    }
  });
});