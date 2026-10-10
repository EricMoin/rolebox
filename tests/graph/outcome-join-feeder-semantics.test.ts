/**
 * THE JOIN-FEEDER FIX, END TO END OVER THE REAL COMPILER, RUNTIME AND NOTICES.
 *
 * The defect: `feederSourcesOf` counted EVERY in-edge of a join node as a
 * feeder, including the back-edge of the node's own declared loop group, while
 * `entryNodesOf` in the same module deliberately excludes exactly that edge
 * class. A join node that also carried its group's continuation edge therefore
 * waited for an arrival from the node it had to run BEFORE: it was never
 * dispatched, the loop was unreachable by construction, and the phase formula
 * then announced "All activated graph work completed." over a pending node.
 *
 * 1. FEEDER SEMANTICS — a loop continuation edge between two members of its own
 *    declared group is a ROUTING edge, not a feeder, so the r2-shaped
 *    declaration (a join node that is ALSO the target of its group's
 *    continuation) arms and dispatches, and the loop still traverses.
 * 2. HONEST PHASE — a run that still holds a node it can never dispatch records
 *    the named stop `unreachable-pending-node` (naming the node and the feeder
 *    that can never arrive) instead of reporting completion, and the
 *    user-visible notice names the abandoned node. A run whose nodes have ALL
 *    settled still completes, and reaching a declared terminal outcome no
 *    longer papers over nodes the exit never routed to.
 * 3. DECLARE-TIME SATISFIABILITY — the compiler refuses a declaration whose
 *    node waits for a feeder that can only run AFTER it (`unsatisfiable-join`,
 *    naming the node and the feeder) while a satisfiable declaration compiles.
 *    A FEASIBILITY INVARIANT below pins the property on real compiled plans: a
 *    node that compiles is neither reachable only through its own feeder nor
 *    dependent on a node it must precede.
 *
 * Every case runs in its own mkdtemp directory and closes the application it
 * opened before the afterEach pass removes that directory; nothing here writes
 * outside a temp dir.
 *
 * @module
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphApplication } from "../../src/graph/application/graph-application.ts";
import type { GraphNotification } from "../../src/graph/application/graph-notifications.ts";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { compileGraph, unsatisfiableJoinsOf } from "../../src/graph/compiler/compile.ts";
import { createCompiledPlan } from "../../src/graph/compiler/plan.ts";
import type {
  CompiledNode,
  CompiledPlan,
  CompiledPlanBody,
} from "../../src/graph/compiler/plan.ts";
import {
  entryNodesOf,
  feederSourcesOf,
  joinSatisfiedBy,
  unsatisfiablePendingNodes,
} from "../../src/graph/outcome/join-state.ts";
import { buildDeclaredOutcomeGraph } from "../../src/graph/tools/declare-graph.ts";
import type { CanonicalToolContext } from "../../src/platform/types.ts";
import { POLICY_BODY, POLICY_ID } from "./helpers/host-graph-fixture.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const roots: string[] = [];
const apps: GraphApplication[] = [];
afterEach(() => {
  // The host is the last long-lived borrower of the store's connection, so the
  // close comes first: Windows refuses to remove a directory whose database is open.
  for (const app of apps.splice(0)) app.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The stable code the declare-time feasibility refusal carries. */
const REFUSAL_CODE = "unsatisfiable-join";

const R2_GRAPH_ID = "feeder.r2-shape";
const ABANDONED_GRAPH_ID = "feeder.abandoned-terminal";

/**
 * R2'S SHAPE IN MINIATURE, now satisfiable. Two producers converge on `review`,
 * which declares `join: all` over exactly those two — and `review` is ALSO the
 * target of the declared loop's continuation edge `repair --done--> review`.
 * `repair` is therefore a ROUTING edge into `review`, not a feeder: the join
 * waits for its two producers and the declared loop stays traversable.
 */
function r2ShapeDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: R2_GRAPH_ID,
    nodes: [
      { id: "core", agent: "agent.core", prompt: "Core.", outcomes: [{ id: "done" }] },
      {
        id: "tools", agent: "agent.tools", prompt: "Tools.", outcomes: [{ id: "report" }],
        inputs: [{ from: "core", outcome: "done" }],
      },
      {
        id: "policy", agent: "agent.policy", prompt: "Policy.", outcomes: [{ id: "report" }],
        inputs: [{ from: "core", outcome: "done" }],
      },
      {
        id: "review",
        agent: "agent.review",
        prompt: "Review.",
        outcomes: [{ id: "revise" }, { id: "pass" }],
        join: { strategy: "all" },
        inputs: [
          { from: "tools", outcome: "report" },
          { from: "policy", outcome: "report" },
        ],
      },
      {
        id: "repair", agent: "agent.repair", prompt: "Repair.", outcomes: [{ id: "done" }],
        inputs: [{ from: "review", outcome: "revise" }],
      },
    ],
    edges: [
      { from: "core", to: "tools", outcome: "done" },
      { from: "core", to: "policy", outcome: "done" },
      { from: "tools", to: "review", outcome: "report" },
      { from: "policy", to: "review", outcome: "report" },
      { from: "review", to: "repair", outcome: "revise" },
      { from: "repair", to: "review", outcome: "done" },
    ],
    loop_groups: [
      {
        id: "repair-loop",
        nodes: ["review", "repair"],
        max_traversals: 3,
        continuation_outcome: "done",
        exit_outcome: "pass",
      },
    ],
  };
}

/**
 * THE LANDING RUN'S SHAPE. `entry` carries a DECLARED TERMINAL outcome and no
 * successor for it: when it settles `failed`, `verify` and `ship` stand pending
 * with nothing that can ever reach them.
 */
function abandonedByTerminalDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: ABANDONED_GRAPH_ID,
    nodes: [
      {
        id: "entry",
        agent: "agent.entry",
        prompt: "Open the batch.",
        outcomes: [{ id: "done" }, { id: "failed" }],
        completion: { mode: "explicit" },
      },
      {
        id: "verify", agent: "agent.verify", prompt: "Verify.", outcomes: [{ id: "pass" }],
        completion: { mode: "explicit" },
        inputs: [{ from: "entry", outcome: "done" }],
      },
      {
        id: "ship", agent: "agent.ship", prompt: "Ship.", outcomes: [{ id: "shipped" }],
        completion: { mode: "explicit" },
        inputs: [{ from: "verify", outcome: "pass" }],
      },
    ],
    edges: [
      { from: "entry", to: "verify", outcome: "done" },
      { from: "verify", to: "ship", outcome: "pass" },
    ],
  };
}

/**
 * THE SHAPE THE FEASIBILITY CHECK EXISTS FOR, written so that the declaration
 * itself is legal: `x` joins ALL of `p` and `w`, and `w`'s only in-edge is
 * `x --next--> w`. As written it IS dispatchable (every node is reachable from
 * the entry nodes), which is exactly why it compiles — the test below removes
 * `p --go--> x`, the producer edge that makes `x` dispatchable, to exhibit the
 * body the checker refuses.
 */
function unsatisfiableShapedDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: "feeder.unsatisfiable-shaped",
    nodes: [
      { id: "p", agent: "agent.p", prompt: "Produce.", outcomes: [{ id: "go" }], completion: { mode: "explicit" } },
      {
        id: "x", agent: "agent.x", prompt: "Converge.", outcomes: [{ id: "next" }],
        completion: { mode: "explicit" },
        join: { strategy: "all" },
        inputs: [{ from: "p", outcome: "go" }, { from: "z", outcome: "ready" }],
      },
      {
        id: "y", agent: "agent.y", prompt: "Relay.", outcomes: [{ id: "done" }, { id: "stop" }],
        completion: { mode: "explicit" },
        inputs: [{ from: "x", outcome: "next" }],
      },
      {
        id: "z", agent: "agent.z", prompt: "Repair.", outcomes: [{ id: "ready" }, { id: "stop" }],
        completion: { mode: "explicit" },
        inputs: [{ from: "y", outcome: "done" }],
      },
    ],
    edges: [
      { from: "p", to: "x", outcome: "go" },
      { from: "x", to: "y", outcome: "next" },
      { from: "y", to: "z", outcome: "done" },
      { from: "z", to: "x", outcome: "ready" },
    ],
    loop_groups: [
      {
        id: "rounds",
        nodes: ["x", "y", "z"],
        max_traversals: 3,
        continuation_outcome: "ready",
        exit_outcome: "stop",
      },
    ],
  };
}

/** A diamond that MUST keep compiling: `c` joins ALL of its two producers. */
function diamondDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: "feeder.diamond",
    nodes: [
      { id: "split", agent: "agent.split", prompt: "Split.", outcomes: [{ id: "go" }] },
      {
        id: "a", agent: "agent.a", prompt: "A.", outcomes: [{ id: "done" }],
        inputs: [{ from: "split", outcome: "go" }],
      },
      {
        id: "b", agent: "agent.b", prompt: "B.", outcomes: [{ id: "done" }],
        inputs: [{ from: "split", outcome: "go" }],
      },
      {
        id: "c", agent: "agent.c", prompt: "Converge.", outcomes: [{ id: "merged" }],
        join: { strategy: "all" },
        inputs: [{ from: "a", outcome: "done" }, { from: "b", outcome: "done" }],
      },
    ],
    edges: [
      { from: "split", to: "a", outcome: "go" },
      { from: "split", to: "b", outcome: "go" },
      { from: "a", to: "c", outcome: "done" },
      { from: "b", to: "c", outcome: "done" },
    ],
  };
}

/**
 * THE GRAMMAR-LEGAL DECLARATION THAT REACHES THE REFUSAL — the witness the
 * claim above used to deny. Every structural rule is satisfied: the `x -> y`
 * cycle is contained in the declared group `rounds`, whose continuation outcome
 * `again` is carried by the edge `x --again--> y` between two of its members.
 * The join is unsatisfiable all the same: `x` joins ALL of `p` and `y`, while
 * `y`'s ONLY in-edge is the non-continuation edge `y --done--> x` — so every
 * path to `y` runs through the node that waits for it.
 */
function deadlockingJoinDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: "feeder.deadlocking-join",
    nodes: [
      { id: "p", agent: "agent.p", prompt: "Produce.", outcomes: [{ id: "go" }], completion: { mode: "explicit" } },
      {
        id: "x", agent: "agent.x", prompt: "Converge.",
        outcomes: [{ id: "next" }, { id: "again" }],
        completion: { mode: "explicit" },
        join: { strategy: "all" },
        inputs: [{ from: "p", outcome: "go" }, { from: "y", outcome: "done" }],
      },
      {
        id: "y", agent: "agent.y", prompt: "Relay.",
        outcomes: [{ id: "done" }, { id: "stop" }],
        completion: { mode: "explicit" },
        inputs: [{ from: "x", outcome: "next" }],
      },
    ],
    edges: [
      { from: "p", to: "x", outcome: "go" },
      { from: "x", to: "y", outcome: "next" },
      { from: "x", to: "y", outcome: "again" },
      { from: "y", to: "x", outcome: "done" },
    ],
    loop_groups: [
      {
        id: "rounds",
        nodes: ["x", "y"],
        max_traversals: 3,
        continuation_outcome: "again",
        exit_outcome: "stop",
      },
    ],
  };
}

/**
 * The deadlocking declaration's satisfiable twin: the SAME group and the same
 * two nodes, with the continuation outcome moved onto the back-edge
 * (`y --again--> x`), which makes `y` a routing edge into `x` rather than a
 * feeder of it. It must keep compiling.
 */
function satisfiableJoinTwinDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: "feeder.satisfiable-join-twin",
    nodes: [
      { id: "p", agent: "agent.p", prompt: "Produce.", outcomes: [{ id: "go" }], completion: { mode: "explicit" } },
      {
        id: "x", agent: "agent.x", prompt: "Converge.",
        outcomes: [{ id: "next" }],
        completion: { mode: "explicit" },
        join: { strategy: "all" },
        inputs: [{ from: "p", outcome: "go" }, { from: "y", outcome: "again" }],
      },
      {
        id: "y", agent: "agent.y", prompt: "Relay.",
        outcomes: [{ id: "again" }, { id: "stop" }],
        completion: { mode: "explicit" },
        inputs: [{ from: "x", outcome: "next" }],
      },
    ],
    edges: [
      { from: "p", to: "x", outcome: "go" },
      { from: "x", to: "y", outcome: "next" },
      { from: "y", to: "x", outcome: "again" },
    ],
    loop_groups: [
      {
        id: "rounds",
        nodes: ["x", "y"],
        max_traversals: 3,
        continuation_outcome: "again",
        exit_outcome: "stop",
      },
    ],
  };
}

/**
 * One minimal compiled node for the synthetic refusal body below: the checker
 * reads a node's id, join and declared inputs, and nothing else.
 */
function minimalNodeOf(
  id: string,
  outcome: string,
  options: { join?: boolean; inputs?: readonly string[]; continuation?: string } = {},
): CompiledNode {
  const outcomes =
    options.continuation === undefined
      ? [{ id: outcome, acceptance: [] }]
      : [{ id: outcome, acceptance: [] }, { id: options.continuation, acceptance: [] }];
  return {
    id,
    agent: "agent." + id,
    prompt: id,
    outcomes,
    ...(options.join === true ? { join: { strategy: "all" as const } } : {}),
    ...(options.inputs === undefined
      ? {}
      : { inputs: options.inputs.map((from) => ({ from, outcome: "out" })) }),
  } as CompiledNode;
}

/**
 * The minimal compiled BODY the synthetic refusal below is read from: the plan
 * contract's pinned fields plus the three the join readers actually consult
 * (`unsatisfiableJoinsOf`, `entryNodesOf` and `feederSourcesOf`), which is why
 * the parameter states exactly that contract.
 *
 * The contract and policy indexes are the canonical EMPTY values because this
 * fixture binds no contract to snapshot or identify. `terminalOutcomes` is
 * empty, and TRULY so: every (node, outcome) pair of the body carries an
 * outbound edge, which is exactly why the declaration deadlocks. `executability`
 * is the only honest value for a body nothing unresolved was found in, and no
 * consumer reads it.
 */
function minimalBody(
  body: Pick<CompiledPlanBody, "nodes" | "edges" | "loopGroups">,
): CompiledPlanBody {
  return {
    graphId: "severed-join",
    declarationVersion: 3,
    contractSnapshots: {},
    contractIdentities: {},
    completionPolicySnapshots: {},
    completionPolicyIdentities: {},
    completionAuthorizations: [],
    terminalOutcomes: [],
    executability: { kind: "executable" },
    ...body,
  };
}

// ── Harness ─────────────────────────────────────────────────────────────────

interface Harness {
  readonly app: GraphApplication;
  readonly received: GraphNotification[];
  readonly requests: {
    request: { nodeId: string; attemptId: string; credential: string };
    effect: unknown;
  }[];
  readonly call: (name: string, args: Record<string, unknown>, sessionID?: string) => Promise<any>;
}

/**
 * The shipped host assembly over a temp store, capturing every notification the
 * engine DECIDES to send — the user-visible surface this fix has to correct.
 */
function fixture(): Harness {
  const root = mkdtempSync(join(tmpdir(), "outcome-join-feeder-"));
  roots.push(root);
  const received: GraphNotification[] = [];
  const requests: Harness["requests"] = [];
  const app = GraphApplication.open({
    workspaceDir: root,
    storeRoot: join(root, "store"),
    env: {
      ROLEBOX_GRAPH_COMPLETION_POLICIES: JSON.stringify({
        declare: [{ id: POLICY_ID, revision: "1", body: POLICY_BODY }],
        authorize: [POLICY_ID + "@1"],
      }),
    },
    declareInvocationIdentity: false,
    workerSessionOf: (execution) => execution.executionId,
    observeExecution: () => ({ kind: "completed" }),
    deliver: (request, effect) => {
      requests.push({ request, effect });
    },
    notifications: {
      clock: () => Date.now(),
      send: async (notification) => {
        received.push(notification);
        return true;
      },
    },
  });
  apps.push(app);
  const tools = app.createTools();
  const call = async (name: string, args: Record<string, unknown>, sessionID = "parent") => {
    const context: CanonicalToolContext = {
      sessionID,
      messageID: "message",
      agent: "orchestrator",
      directory: root,
      worktree: root,
      abort: new AbortController().signal,
      metadata() {},
      async ask() {},
    };
    const raw = await tools[name]!.execute(args, context);
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  };
  return { app, received, requests, call };
}

/** The attempt ids the harness has been asked to launch, in dispatch order. */
function attemptIds(harness: Harness): string[] {
  return harness.requests.map((entry) => entry.request.attemptId);
}

/**
 * Settle one dispatched attempt through the tool surface, confirming its
 * execution first. Fails the case when the submission was not accepted.
 */
async function submit(
  harness: Harness,
  graphId: string,
  attemptId: string,
  nodeId: string,
  outcomeId: string,
): Promise<any> {
  const found = harness.requests.find((entry) => entry.request.attemptId === attemptId);
  if (found === undefined) {
    throw new Error(
      "fixture: no dispatch for attempt " + attemptId + " (dispatched: " +
      attemptIds(harness).join(", ") + ")",
    );
  }
  const child = "worker-" + attemptId;
  harness.app.host.confirmExecution(found.effect as never, { executionId: child });
  const result = await harness.call("graph_submit_outcome", {
    graph_id: graphId,
    node_id: nodeId,
    outcome_id: outcomeId,
    credential: found.request.credential,
  }, child);
  expect(result.decision).toBe("accepted");
  await harness.app.notifications?.flush();
  return result;
}

// ── 1. Feeder semantics ─────────────────────────────────────────────────────

describe("join feeders — a loop continuation edge is a routing edge, not a feeder", () => {
  it("arms and dispatches the r2-shaped join node, and the declared loop still traverses", async () => {
    const harness = fixture();
    const declared = await harness.call("graph_declare", { declaration: r2ShapeDeclaration() });
    expect(declared.graph_id).toBe(R2_GRAPH_ID);
    expect(declared.start?.kind).toBe("started");

    // The plan's own readers agree with the runtime: `repair` is not a feeder of
    // `review`, and the continuation edge does not make `repair` an entry node.
    const plan = buildDeclaredOutcomeGraph({ declaration: r2ShapeDeclaration() }).plan;
    expect(feederSourcesOf(plan, "review")).toEqual(["policy", "tools"]);
    expect(entryNodesOf(plan).map((node) => node.id)).toEqual(["core"]);

    expect(attemptIds(harness)).toEqual(["core#1"]);
    await submit(harness, R2_GRAPH_ID, "core#1", "core", "done");
    expect(attemptIds(harness)).toEqual(["core#1", "policy#2", "tools#3"]);

    // Both producers settle. The THIRD in-edge of `review` is the loop-back
    // edge, which the new feeder semantics does not count — so `review` arms.
    await submit(harness, R2_GRAPH_ID, "tools#3", "tools", "report");
    await submit(harness, R2_GRAPH_ID, "policy#2", "policy", "report");
    expect(attemptIds(harness)).toEqual(["core#1", "policy#2", "tools#3", "review#4"]);

    // The loop traverses: review revises, repair runs, and repair's `done`
    // re-enters review for round 2 — which must arrive twice again.
    const revised = await submit(harness, R2_GRAPH_ID, "review#4", "review", "revise");
    expect(revised.phase).toBe("executing");
    expect(attemptIds(harness)).toEqual([
      "core#1", "policy#2", "tools#3", "review#4", "repair#5",
    ]);
    const repaired = await submit(harness, R2_GRAPH_ID, "repair#5", "repair", "done");
    // Round 2 re-arms `review` (its continuous input is the loop), and the run
    // is NOT complete while the round is open.
    expect(repaired.phase).toBe("executing");
    expect(attemptIds(harness)).toEqual([
      "core#1", "policy#2", "tools#3", "review#4", "repair#5", "review#6",
    ]);

    // …and the round really is traversable: settling `review` again routes the
    // loop back through `repair`.
    await submit(harness, R2_GRAPH_ID, "review#6", "review", "revise");
    expect(attemptIds(harness)).toContain("repair#7");
  });

  it("refuses no satisfiable declaration, and guarantees every compiled join is dispatchable", () => {
    // THE DECLARE-TIME RULE, in the two directions that are observable here.
    //
    // REFUSAL: `unsatisfiable-join` refuses a body whose node waits for a
    // feeder that can only run AFTER it, and the grammar CAN write one: the
    // deadlocking declaration below satisfies every structural rule — the
    // `x -> y` cycle sits inside the declared group `rounds`, and the group's
    // continuation outcome `again` is carried by the edge `x --again--> y`,
    // which stays inside the group — yet `x` joins ALL of `p` and `y` while
    // `y`'s only in-edge is the NON-continuation edge `y --done--> x`, so every
    // path to `y` runs through `x`. `compileGraph` refuses THAT declaration with
    // two `unsatisfiable-join` issues (the case below pins it); loop containment
    // and the continuation-edge rule do not make every join satisfiable. The
    // invariant computed here is therefore a property of the declarations that
    // DID compile, not a guarantee about the grammar, and the runtime's own
    // `unreachable-pending-node` stop (part 2) remains what reports a shape the
    // grammar can express and the checker accepts but no order can dispatch.
    //
    // ACCEPTANCE: every declaration written to be satisfiable still compiles —
    // including the one whose join node is also its group's continuation
    // target, which the OLD feeder reader refused to arm at run time.
    for (const declaration of [r2ShapeDeclaration(), diamondDeclaration()]) {
      const compiled = compileGraph(declaration);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) throw new Error("the satisfiable declaration was refused");
      expect(compiled.kind).toBe("executable");
    }

    // THE INVARIANT, computed the way the checker computes it: from the entry
    // nodes (dispatched at start, join and all), a node is dispatchable once a
    // predecessor has settled and its join is satisfied by what already ran. If
    // a declaration compiled, EVERY node is in that closure — so no node waits
    // for a feeder that can only run after it.
    for (const declaration of [r2ShapeDeclaration(), diamondDeclaration(), unsatisfiableShapedDeclaration()]) {
      const plan: CompiledPlan = buildDeclaredOutcomeGraph({ declaration }).plan;
      expect(unsatisfiableJoinsOf(plan)).toEqual([]);
      const runnable = new Set(entryNodesOf(plan).map((node) => node.id));
      for (let round = 0; round < plan.nodes.length; round += 1) {
        for (const node of plan.nodes) {
          if (runnable.has(node.id)) continue;
          const reachedBy = plan.edges.some(
            (edge) => edge.to === node.id && runnable.has(edge.from),
          );
          if (!reachedBy) continue;
          if (joinSatisfiedBy(node, runnable, feederSourcesOf(plan, node.id))) {
            runnable.add(node.id);
          }
        }
      }
      expect([...runnable].sort()).toEqual(plan.nodes.map((node) => node.id).sort());
    }

    // THE REFUSAL ITSELF, on the minimal body that exhibits it. `x` joins ALL of
    // `p` and `y`; the declared loop is `[p, x]` with continuation `next`, so
    // `y --next--> x` is NOT a continuation edge and stays a feeder of `x`.
    // `y` is reachable only through `x` (`x --done--> y` is its only in-edge),
    // so `x` waits for a node that can only run after it — the declaration
    // defect `unsatisfiable-join` names.
    const body = minimalBody({
      nodes: [
        minimalNodeOf("p", "go"),
        minimalNodeOf("x", "done", { join: true, inputs: ["p", "y"] }),
        minimalNodeOf("y", "next", { inputs: ["x"] }),
      ],
      edges: [
        { from: "p", to: "x", outcome: "go" },
        { from: "x", to: "y", outcome: "done" },
        { from: "y", to: "x", outcome: "next" },
      ],
      loopGroups: [
        {
          id: "rounds",
          nodes: ["p", "x"],
          maxTraversals: 3,
          continuationOutcome: "next",
          exitOutcome: "stop",
        },
      ],
    });
    // The two readers below are declared over `CompiledPlan`, and production's
    // own builder is what names a body with the revision it carries — so the
    // fixture body is handed over without a cast.
    const severed = createCompiledPlan(body);
    expect(entryNodesOf(severed).map((node) => node.id)).toEqual(["p"]);
    expect(feederSourcesOf(severed, "x")).toEqual(["p", "y"]);
    const issues = unsatisfiableJoinsOf(severed);
    expect(issues.map((entry) => entry.code)).toEqual([
      "unsatisfiable-join",
      "unsatisfiable-join",
    ]);
    expect(issues[0]?.path).toBe("nodes.x.inputs");
    expect(issues[0]?.message).toContain('"x"');
    expect(issues[0]?.message).toContain('"y"');
    expect(issues[0]?.message).toContain("can never be satisfied");
    expect(REFUSAL_CODE).toBe(issues[0]?.code);
  });

  it("refuses a GRAMMAR-LEGAL declaration whose join can never be satisfied", () => {
    // THE REFUSAL IS REACHABLE, through `compileGraph` itself and on a body the
    // grammar accepts: a loop group covers the cycle, the group's continuation
    // edge stays inside it, and the join still waits for a node that can only
    // run afterwards. Both the node that waits and the feeder it can never
    // receive are named.
    const refused = compileGraph(deadlockingJoinDeclaration());
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("the deadlocking declaration compiled");
    expect(refused.errors.map((entry) => entry.code)).toEqual([
      "unsatisfiable-join",
      "unsatisfiable-join",
    ]);
    expect(refused.errors.map((entry) => entry.path)).toEqual([
      "nodes.x.inputs",
      "nodes.y.inputs",
    ]);
    expect(refused.errors[0]?.message).toContain('"x"');
    expect(refused.errors[0]?.message).toContain('"y"');
    expect(refused.errors[0]?.message).toContain("can never be satisfied");
    expect(REFUSAL_CODE).toBe(refused.errors[0]?.code);

    // The refusal is about SATISFIABILITY, not about the shape: moving the
    // continuation outcome onto the back-edge makes `y` a routing edge into
    // `x` instead of a feeder of it, and the declaration compiles.
    const twin = compileGraph(satisfiableJoinTwinDeclaration());
    expect(twin.ok).toBe(true);
    if (!twin.ok) throw new Error("the satisfiable twin was refused");
    expect(twin.kind).toBe("executable");
  });
});

// ── 2. Honest phase ─────────────────────────────────────────────────────────

describe("a run that still holds an undispatchable node does not report complete", () => {
  it("stops with unreachable-pending-node naming the abandoned node instead of announcing completion", async () => {
    const harness = fixture();
    await harness.call("graph_declare", { declaration: abandonedByTerminalDeclaration() });
    expect(attemptIds(harness)).toEqual(["entry#1"]);

    // The entry settles its declared TERMINAL `failed`, which binds no edge:
    // `verify` and `ship` are pending with nothing that can ever reach them.
    const settled = await submit(harness, ABANDONED_GRAPH_ID, "entry#1", "entry", "failed");
    expect(settled.phase).toBe("stopped");
    expect(settled.stop?.reason).toBe("unreachable-pending-node");
    expect(settled.stop?.blocked_nodes).toEqual([
      { node_id: "ship", blocked_feeders: ["verify"] },
      { node_id: "verify", blocked_feeders: ["entry"] },
    ]);

    // THE USER-VISIBLE SURFACE: no completion notice, and the abandoned nodes
    // are named in the notice that IS delivered.
    expect(harness.received.filter((notification) => notification.kind === "complete")).toEqual([]);
    const terminal = harness.received.find((notification) => notification.kind === "stopped");
    expect(terminal).toBeDefined();
    expect(terminal?.reason).toContain("unreachable-pending-node");
    expect(terminal?.reason).toContain("verify");
    expect(terminal?.reason).toContain("ship");
  });

  it("does not report completion for a loop that exited while a member stood pending", async () => {
    const harness = fixture();
    await harness.call("graph_declare", { declaration: r2ShapeDeclaration() });
    await submit(harness, R2_GRAPH_ID, "core#1", "core", "done");
    await submit(harness, R2_GRAPH_ID, "tools#3", "tools", "report");
    await submit(harness, R2_GRAPH_ID, "policy#2", "policy", "report");
    const passed = await submit(harness, R2_GRAPH_ID, "review#4", "review", "pass");
    // `pass` is the loop's declared EXIT and a terminal outcome, but `repair` is
    // still pending and the exit never routes to it: the run reports the
    // abandonment rather than "all activated graph work completed.".
    expect(passed.phase).toBe("stopped");
    expect(passed.stop?.reason).toBe("unreachable-pending-node");
    expect(passed.stop?.blocked_nodes).toEqual([
      { node_id: "repair", blocked_feeders: ["review"] },
    ]);
    expect(harness.received.filter((notification) => notification.kind === "complete")).toEqual([]);
  });

  it("still completes a run whose declared nodes have all settled", async () => {
    const harness = fixture();
    const graphId = "feeder.all-settled";
    await harness.call("graph_declare", {
      declaration: {
        version: 3,
        name: graphId,
        nodes: [
          { id: "work", agent: "worker", prompt: "Work", outcomes: [{ id: "done" }], completion: { mode: "explicit" } },
          { id: "ship", agent: "shipper", prompt: "Ship", outcomes: [{ id: "shipped" }], completion: { mode: "explicit" } },
        ],
        edges: [{ from: "work", to: "ship", outcome: "done" }],
      } satisfies GraphDeclarationV3,
    });
    await submit(harness, graphId, "work#1", "work", "done");
    const shipped = await submit(harness, graphId, "ship#2", "ship", "shipped");
    expect(shipped.phase).toBe("complete");
    expect(shipped.stop).toBeUndefined();
    expect(harness.received.map((notification) => notification.kind)).toContain("complete");
  });

  it("reports a stranded node before a stale phase can hide it", () => {
    // The state-level reading the phase rule uses: a pending node whose feeder
    // settled WITHOUT routing to it and that no loop can re-enter.
    const plan = buildDeclaredOutcomeGraph({ declaration: abandonedByTerminalDeclaration() }).plan;
    const blocked = unsatisfiablePendingNodes(plan, [
      { nodeId: "entry", status: "settled", attemptId: "entry#1", outcomeId: "failed" },
      { nodeId: "verify", status: "pending", arrivals: [] },
      { nodeId: "ship", status: "pending", arrivals: [] },
    ]);
    expect(blocked).toEqual({ ship: ["verify"], verify: ["entry"] });
    // A live run — an attempt in flight — strands nothing.
    expect(
      unsatisfiablePendingNodes(plan, [
        { nodeId: "entry", status: "settled", attemptId: "entry#1", outcomeId: "done" },
        { nodeId: "verify", status: "dispatched", attemptId: "verify#2" },
        { nodeId: "ship", status: "pending", arrivals: [] },
      ]),
    ).toEqual({});
  });
});
