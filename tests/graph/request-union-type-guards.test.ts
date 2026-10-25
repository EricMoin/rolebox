
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphApplication } from "../../src/graph/application/graph-application.ts";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import type {
  GraphControlAppliedResult,
  GraphControlApproval,
  GraphControlApprovalApplied,
  GraphControlApprovalRequestCommand,
  GraphControlBudgetStopApplied,
  GraphControlCancelRequest,
  GraphControlNodeRetryRequest,
  GraphControlPrincipal,
  GraphControlRequest,
  GraphControlRetryApplied,
  GraphControlRetryCapability,
  GraphControlReexecution,
  GraphControlResult,
  GraphControlRunRetryRequest,
  GraphControlStopApplied,
} from "../../src/graph/control/contracts.ts";
import type { BudgetReport } from "../../src/graph/domain/budget.ts";
import type { ControlCommandName } from "../../src/graph/ledger/types.ts";
import type { OutcomeGraphState } from "../../src/graph/outcome/state-model.ts";
import type { OutcomeLoopProgress } from "../../src/graph/outcome/progress.ts";
import type {
  OutcomeDispatchEffectKey,
  OutcomeDispatchRequest,
} from "../../src/graph/outcome/dispatch-effects.ts";
import type { OutcomeRuntimeRefusal } from "../../src/graph/outcome/runtime.ts";
import type { GraphDeclareResult } from "../../src/graph/tools/declare-graph.ts";
import type {
  GraphSubmitOutcomeResult,
  SubmitOutcomeLoopExhaustedStop,
  SubmitOutcomeStop,
  SubmitOutcomeUnreachablePendingNodeStop,
} from "../../src/graph/tools/submit-outcome.ts";
import type { CanonicalToolContext, CanonicalToolDef } from "../../src/platform/types.ts";
import { removeTempTrees } from "./helpers/temp-dirs.ts";

const roots: string[] = [];
const apps: GraphApplication[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.close();
  removeTempTrees(roots);
});

/** The closing half of every request below: fields the runtime never invents. */
interface RequestBase {
  readonly graphId: string;
  readonly reason: string;
  readonly principal: GraphControlPrincipal | undefined;
  readonly at: number;
}

// ── 1. The control request ──────────────────────────────────────────────────

describe("F-17 — the control request is discriminated on `command`", () => {
  it("yields each command's own arm through Extract", () => {
    expectTypeOf<Extract<GraphControlRequest, { readonly command: "cancel" }>>()
      .toEqualTypeOf<GraphControlCancelRequest>();
    expectTypeOf<Extract<GraphControlRequest, { readonly command: "retry" }>>()
      .toEqualTypeOf<GraphControlRunRetryRequest | GraphControlNodeRetryRequest>();
    expectTypeOf<Extract<GraphControlRequest, { readonly command: "approval-request" }>>()
      .toEqualTypeOf<GraphControlApprovalRequestCommand>();
    expectTypeOf<GraphControlRequest["command"]>().toEqualTypeOf<
      "failure" | "cancel" | "timeout" | "retry" | "budget-stop" | "approval-request" | "approve" | "reject"
    >();
  });

  it("refuses a run-wide command that names a node or an attempt", () => {
    expectTypeOf<RequestBase & { readonly command: "cancel"; readonly nodeId: string }>()
      .not.toExtend<GraphControlRequest>();
    expectTypeOf<RequestBase & { readonly command: "cancel"; readonly attemptId: string }>()
      .not.toExtend<GraphControlRequest>();
    expectTypeOf<RequestBase & { readonly command: "budget-stop"; readonly nodeId: string }>()
      .not.toExtend<GraphControlRequest>();
  });

  it("refuses a raise with no approval and a node-scoped retry with no capability", () => {
    expectTypeOf<RequestBase & { readonly command: "approval-request"; readonly nodeId: string }>()
      .not.toExtend<GraphControlRequest>();
    expectTypeOf<RequestBase & { readonly command: "retry"; readonly nodeId: string }>()
      .not.toExtend<GraphControlRequest>();
    expectTypeOf<null>().not.toExtend<GraphControlRequest["approval"]>();
  });

  it("refuses a node-scoped stop that names no node", () => {
    expectTypeOf<RequestBase & { readonly command: "failure" }>().not.toExtend<GraphControlRequest>();
    expectTypeOf<RequestBase & { readonly command: "timeout" }>().not.toExtend<GraphControlRequest>();
    expectTypeOf<RequestBase & { readonly command: "approve" }>().not.toExtend<GraphControlRequest>();
    expectTypeOf<RequestBase & { readonly command: "reject" }>().not.toExtend<GraphControlRequest>();
    expectTypeOf<RequestBase & { readonly command: "approval-request"; readonly nodeId: string }>()
      .not.toExtend<GraphControlRequest>();
  });

  it("refuses a host failure carried by any command but `failure`", () => {
    expectTypeOf<RequestBase & { readonly command: "timeout"; readonly nodeId: string;
      readonly hostFailure: { readonly executionId: string } }>().not.toExtend<GraphControlRequest>();
    expectTypeOf<RequestBase & { readonly command: "cancel";
      readonly hostFailure: { readonly executionId: string } }>().not.toExtend<GraphControlRequest>();
  });

  it("still accepts every real shape the handlers apply", () => {
    expectTypeOf<RequestBase & { readonly command: "cancel" }>().toExtend<GraphControlRequest>();
    expectTypeOf<RequestBase & { readonly command: "budget-stop" }>().toExtend<GraphControlRequest>();
    expectTypeOf<RequestBase & { readonly command: "failure"; readonly nodeId: string;
      readonly attemptId?: string }>().toExtend<GraphControlRequest>();
    expectTypeOf<RequestBase & { readonly command: "failure"; readonly nodeId: string;
      readonly attemptId: string;
      readonly hostFailure: { readonly executionId: string; readonly taskId?: string } }>()
      .toExtend<GraphControlRequest>();
    // A RUN-SCOPED retry names no node and needs no credential capability: the
    // handler orders the re-execution before it reads one.
    expectTypeOf<RequestBase & { readonly command: "retry" }>().toExtend<GraphControlRequest>();
    expectTypeOf<RequestBase & { readonly command: "retry"; readonly nodeId: string;
      readonly retry: GraphControlRetryCapability }>().toExtend<GraphControlRequest>();
    expectTypeOf<RequestBase & { readonly command: "approval-request"; readonly nodeId: string;
      readonly approval: { readonly approverSessionId: string; readonly expiresAt: number } }>()
      .toExtend<GraphControlRequest>();
    expectTypeOf<RequestBase & { readonly command: "approve"; readonly nodeId: string }>()
      .toExtend<GraphControlRequest>();
  });
});

// ── 2. The stop projection ──────────────────────────────────────────────────

type LoopStop = SubmitOutcomeLoopExhaustedStop;
type UnreachableStop = SubmitOutcomeUnreachablePendingNodeStop;

describe("F-17 — the stop projection mirrors the persisted OutcomeStop union", () => {
  it("pins the reason vocabulary and each reason's arm", () => {
    expectTypeOf<SubmitOutcomeStop["reason"]>().toEqualTypeOf<
      "loop-exhausted" | "progress-stalled" | "unreachable-pending-node"
    >();
    expectTypeOf<Extract<SubmitOutcomeStop, { readonly reason: "loop-exhausted" }>>()
      .toEqualTypeOf<LoopStop>();
    expectTypeOf<Extract<SubmitOutcomeStop, { readonly reason: "unreachable-pending-node" }>>()
      .toEqualTypeOf<UnreachableStop>();
  });

  it("refuses a reason without its payload, and a reason it does not define", () => {
    expectTypeOf<{ readonly reason: "loop-exhausted"; readonly stopped_at: number }>()
      .not.toExtend<SubmitOutcomeStop>();
    expectTypeOf<{ readonly reason: "not-a-stop-reason"; readonly stopped_at: number }>()
      .not.toExtend<SubmitOutcomeStop>();
    expectTypeOf<{
      readonly reason: "progress-stalled";
      readonly stopped_at: number;
      readonly unchanged: number;
      readonly max_unchanged: number;
      readonly evaluator: string;
      readonly evaluator_version: number;
      readonly subject: string;
      readonly baseline: string;
      readonly traversals: number;
    }>().not.toExtend<SubmitOutcomeStop>();
  });

  it("still accepts each real stop", () => {
    expectTypeOf<{
      readonly reason: "loop-exhausted";
      readonly loop_group_id: string;
      readonly node_id: string;
      readonly outcome_id: string;
      readonly attempt_id: string;
      readonly traversals: number;
      readonly max_traversals: number;
      readonly stopped_at: number;
    }>().toExtend<SubmitOutcomeStop>();
    expectTypeOf<{
      readonly reason: "progress-stalled";
      readonly loop_group_id: string;
      readonly node_id: string;
      readonly outcome_id: string;
      readonly attempt_id: string;
      readonly unchanged: number;
      readonly max_unchanged: number;
      readonly evaluator: string;
      readonly evaluator_version: number;
      readonly subject: string;
      readonly baseline: string;
      readonly stopped_at: number;
    }>().toExtend<SubmitOutcomeStop>();
    expectTypeOf<{
      readonly reason: "unreachable-pending-node";
      readonly blocked_nodes: readonly { readonly node_id: string; readonly blocked_feeders: readonly string[] }[];
      readonly stopped_at: number;
    }>().toExtend<SubmitOutcomeStop>();
  });
});

// ── 3. The declare start ────────────────────────────────────────────────────

type DeclareStart = NonNullable<GraphDeclareResult["start"]>;

describe("F-17 — the declare start is discriminated on `kind`", () => {
  it("pins the kind vocabulary and the arms' required fields", () => {
    expectTypeOf<DeclareStart["kind"]>().toEqualTypeOf<
      "saved" | "started" | "resumed" | "refused" | "blocked"
    >();
    expectTypeOf<Extract<DeclareStart, { readonly kind: "refused" }>["refusals"]>()
      .toEqualTypeOf<readonly OutcomeRuntimeRefusal[]>();
    expectTypeOf<Extract<DeclareStart, { readonly kind: "blocked" }>["reason"]>()
      .toEqualTypeOf<string>();
  });

  it("refuses a refused start with no refusals", () => {
    expectTypeOf<{ readonly kind: "refused" }>().not.toExtend<DeclareStart>();
    expectTypeOf<{ readonly kind: "blocked" }>().not.toExtend<DeclareStart>();
    expectTypeOf<{
      readonly kind: "refused";
      readonly refusals: readonly OutcomeRuntimeRefusal[];
      readonly reason: string;
    }>().not.toExtend<DeclareStart>();
    expectTypeOf<{
      readonly kind: "started";
      readonly phase: string;
      readonly dispatched: readonly { readonly nodeId: string; readonly attemptId: string }[];
    }>().not.toExtend<DeclareStart>();
  });

  it("still accepts each real start result", () => {
    expectTypeOf<{ readonly kind: "saved" }>().toExtend<DeclareStart>();
    expectTypeOf<{ readonly kind: "blocked"; readonly reason: string }>().toExtend<DeclareStart>();
    expectTypeOf<{ readonly kind: "refused"; readonly refusals: readonly OutcomeRuntimeRefusal[] }>()
      .toExtend<DeclareStart>();
    expectTypeOf<{
      readonly kind: "started";
      readonly phase: string;
      readonly dispatched: readonly { readonly nodeId: string; readonly attemptId: string }[];
      readonly refusals: readonly OutcomeRuntimeRefusal[];
      readonly divergences: readonly never[];
    }>().toExtend<DeclareStart>();
    expectTypeOf<{ readonly kind: "resumed" } & Omit<Extract<DeclareStart, { readonly kind: "started" | "resumed" }>, "kind">>()
      .toExtend<DeclareStart>();
  });
});

// ── 4. The applied answer ───────────────────────────────────────────────────

type AppliedResult = Extract<GraphControlResult, { readonly kind: "applied" }>;
type BudgetStopArm = Extract<GraphControlAppliedResult, { readonly command: "budget-stop" }>;
type StopArm = Extract<GraphControlAppliedResult, { readonly command: "failure" | "timeout" | "cancel" }>;
type RetryArm = Extract<GraphControlAppliedResult, { readonly command: "retry" }>;
type ApprovalArm = Extract<GraphControlAppliedResult, { readonly command: "approval-request" | "approve" | "reject" }>;

describe("F-17 — an applied answer is discriminated on the command it names", () => {
  it("yields one arm per command group, and the arms cover the vocabulary", () => {
    expectTypeOf<AppliedResult>().toEqualTypeOf<GraphControlAppliedResult>();
    expectTypeOf<BudgetStopArm>().toEqualTypeOf<GraphControlBudgetStopApplied>();
    expectTypeOf<StopArm>().toEqualTypeOf<GraphControlStopApplied>();
    expectTypeOf<RetryArm>().toEqualTypeOf<GraphControlRetryApplied>();
    expectTypeOf<ApprovalArm>().toEqualTypeOf<GraphControlApprovalApplied>();
    // Every command the runtime can apply has an arm to narrow to, and no arm
    // names a command it cannot.
    expectTypeOf<AppliedResult["command"]>().toEqualTypeOf<ControlCommandName>();
  });

  it("lets a consumer holding an arm read only that command's own payload", () => {
    // A `budget-stop` reports the run's budget — ABSENT only when the plan's
    // ceilings or the rows could not be read. On THIS arm that absence is the
    // only thing an absent `budget` can mean (E-03).
    expectTypeOf<BudgetStopArm["budget"]>().toEqualTypeOf<BudgetReport | undefined>();
    expectTypeOf<BudgetStopArm["reexecution"]>().toEqualTypeOf<undefined>();
    expectTypeOf<BudgetStopArm["approval"]>().toEqualTypeOf<undefined>();
    // A RUN-SCOPED retry records a re-execution; nothing else does.
    expectTypeOf<RetryArm["reexecution"]>().toEqualTypeOf<GraphControlReexecution | undefined>();
    expectTypeOf<RetryArm["budget"]>().toEqualTypeOf<undefined>();
    // An applied approval command ALWAYS names the request it raised/decided.
    expectTypeOf<ApprovalArm["approval"]>().toEqualTypeOf<GraphControlApproval>();
    // A plain stop reports neither of the three.
    expectTypeOf<StopArm["budget"]>().toEqualTypeOf<undefined>();
    expectTypeOf<StopArm["approval"]>().toEqualTypeOf<undefined>();
    expectTypeOf<StopArm["reexecution"]>().toEqualTypeOf<undefined>();
  });

  it("refuses an applied answer carrying a payload its command never reports", () => {
    expectTypeOf<Omit<StopArm, "budget"> & { readonly budget: NonNullable<BudgetStopArm["budget"]> }>()
      .not.toExtend<AppliedResult>();
    expectTypeOf<Omit<RetryArm, "approval"> & { readonly approval: GraphControlApproval }>()
      .not.toExtend<AppliedResult>();
    expectTypeOf<Omit<ApprovalArm, "reexecution"> & { readonly reexecution: GraphControlReexecution }>()
      .not.toExtend<AppliedResult>();
  });
});

// ── 5. The real paths, unchanged ────────────────────────────────────────────

/** work -> ship on `done`; `failed` is terminal and binds no edge. */
function stoppingDeclaration(name: string): GraphDeclarationV3 {
  return {
    version: 3,
    name,
    nodes: [
      {
        id: "work",
        agent: "agent.work",
        prompt: "Do the work.",
        outcomes: [{ id: "done" }, { id: "failed" }],
      },
      {
        id: "ship",
        agent: "agent.ship",
        prompt: "Ship it.",
        outcomes: [{ id: "shipped" }],
        inputs: [{ from: "work", outcome: "done" }],
      },
    ],
    edges: [{ from: "work", to: "ship", outcome: "done" }],
  };
}

/**
 * The shipped assembly over one temp tree, driven through its REGISTERED tools
 * — the same `GraphApplication` + `createTools` pair `application.test.ts` uses,
 * because the host binds the platform's per-call session into the tools and a
 * submission is only authentic through that binding.
 */
function assemble() {
  const root = mkdtempSync(join(tmpdir(), "request-union-"));
  roots.push(root);
  const dispatched: { request: OutcomeDispatchRequest; effect: OutcomeDispatchEffectKey }[] = [];
  const app = GraphApplication.open({
    workspaceDir: root,
    storeRoot: join(root, "store"),
    env: {},
    observeExecution: () => ({ kind: "running" }),
    declareInvocationIdentity: false,
    workerSessionOf: (execution) => execution.executionId,
    deliver: (request, effect) => { dispatched.push({ request, effect }); },
  });
  apps.push(app);
  const tools = app.createTools();
  const call = async (name: string, args: Record<string, unknown>, sessionID: string) => {
    const tool: CanonicalToolDef | undefined = tools[name];
    if (tool === undefined) throw new Error("fixture: no tool " + name);
    const context: CanonicalToolContext = {
      sessionID, messageID: "message", agent: "agent", directory: root, worktree: root,
      abort: new AbortController().signal, metadata() {}, async ask() {},
    };
    return JSON.parse(String(await tool.execute(args, context)));
  };
  return { app, dispatched, call };
}

describe("F-17 — the real paths are unchanged", () => {
  it("declares a graph and answers a real graph_control call as before", async () => {
    const { app, dispatched, call } = assemble();
    const declared: GraphDeclareResult = await call(
      "graph_declare",
      { declaration: stoppingDeclaration("control.union") },
      "declarer",
    );
    expect(declared.persisted).toBe(true);
    expect(declared.start?.kind).toBe("started");
    expect(dispatched).toHaveLength(1);

    // THE SHAPE THE UNION MAKES UNWRITABLE, answered with the handler's own
    // refusal because the entry cannot name a run-wide arm carrying a node.
    const named = await call(
      "graph_control",
      { graph_id: "control.union", command: "cancel", node_id: "work", reason: "name a node on a run-wide command" },
      "declarer",
    );
    expect(named.kind).toBe("refused");
    expect(named.refusals?.[0]?.code).toBe("unknown-node");

    // …and the real run-wide form still stops the run.
    const applied = await call(
      "graph_control",
      { graph_id: "control.union", command: "cancel", reason: "operator stop" },
      "declarer",
    );
    expect(applied.kind).toBe("applied");
    expect(applied.scope).toBe("run");
    expect(applied.runControl?.command).toBe("cancel");
    expect(applied.decided?.length).toBe(1);
    app.close();
  });

  it("projects a real stop and a real submission result as before", async () => {
    const { app, dispatched, call } = assemble();
    await call("graph_declare", { declaration: stoppingDeclaration("stop.union") }, "declarer");
    const first = dispatched[0];
    if (first === undefined) throw new Error("fixture: the entry node was not dispatched");
    app.host.confirmExecution(first.effect, { executionId: "worker.work" });

    const submitted: GraphSubmitOutcomeResult = await call(
      "graph_submit_outcome",
      {
        graph_id: "stop.union",
        node_id: "work",
        outcome_id: "failed",
        credential: first.request.credential,
      },
      "worker.work",
    );
    expect(submitted.decision).toBe("accepted");
    expect(submitted.phase).toBe("stopped");
    // The projection is the snake_case arm of the PERSISTED stop, field for
    // field: the stranded node and the feeder that can never arrive.
    const stop: SubmitOutcomeStop | undefined = submitted.stop;
    expect(stop?.reason).toBe("unreachable-pending-node");
    expect(stop?.blocked_nodes).toEqual([{ node_id: "ship", blocked_feeders: ["work"] }]);
    expect(stop?.stopped_at).toBeGreaterThan(0);
    // The fields this reason does not define stay ABSENT.
    expect(stop?.loop_group_id).toBeUndefined();
    expect(stop?.traversals).toBeUndefined();
    expect(stop?.baseline).toBeUndefined();
    app.close();
  });

  it("applies a real cancel and a real budget-stop with the wire shape they always had", async () => {
    const { app, call } = assemble();
    await call("graph_declare", { declaration: stoppingDeclaration("applied.union") }, "declarer");

    const cancelled = await call(
      "graph_control",
      { graph_id: "applied.union", command: "cancel", reason: "operator stop" },
      "declarer",
    );
    expect(cancelled.kind).toBe("applied");
    // The answer's fields, in the order the tool renders them: the applied
    // union is a compile-time discrimination, not a change to the JSON.
    const appliedKeys = [
      "kind", "graphId", "runId", "command", "scope", "minted", "decided",
      "runControl", "expiredApprovals", "skipped", "unsettledEffects", "unconfirmedExecutions",
    ];
    expect(Object.keys(cancelled)).toEqual(appliedKeys);
    expect(cancelled.budget).toBeUndefined();
    expect(cancelled.approval).toBeUndefined();
    expect(cancelled.reexecution).toBeUndefined();

    await call("graph_declare", { declaration: stoppingDeclaration("budget.union") }, "declarer");
    const stopped = await call(
      "graph_control",
      { graph_id: "budget.union", command: "budget-stop", reason: "ceiling reached" },
      "declarer",
    );
    expect(stopped.kind).toBe("applied");
    const stoppedKeys = Object.keys(stopped);
    expect(stoppedKeys.slice(0, appliedKeys.length)).toEqual(appliedKeys);
    // The budget stays the LAST field a budget-stop answer has always been able
    // to carry, and only a budget-stop can carry it at all.
    expect(stoppedKeys.length).toBe(appliedKeys.length + (stopped.budget === undefined ? 0 : 1));
    if (stoppedKeys.length > appliedKeys.length) {
      expect(stoppedKeys[stoppedKeys.length - 1]).toBe("budget");
    }
    app.close();
  });
});

// ── 6. The persisted body's loop progress (F-17: required) ──────────────────

describe("F-17 — the state body always carries its loop progress", () => {
  it("requires loopProgress, which the codec and the state writer both refuse without", () => {
    // `readLoopProgress` (state-codec.ts) throws `loopProgress is undefined,
    // not a record of per-loop-group progress`, and graph-state.ts refuses a
    // CURRENT body without it — so a hand-built body missing it was a state
    // the next read refuses (the rolebox-graph-state input's item 2).
    expectTypeOf<Omit<OutcomeGraphState, "loopProgress">>().not.toExtend<OutcomeGraphState>();
    expectTypeOf<OutcomeGraphState["loopProgress"]>()
      .toEqualTypeOf<Readonly<Record<string, OutcomeLoopProgress>>>();
  });
});
