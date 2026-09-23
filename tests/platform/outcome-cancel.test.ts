/**
 * P3 cancel — the two shipped platform cancel ports
 *
 * WHAT THIS FILE PROVES BY BEHAVIOUR, against the platform surfaces rolebox
 * actually consumes (the SDKs are not installed, so these are STRUCTURAL doubles
 * and NOT real-host evidence):
 *
 * - dsh: a run THIS process started is aborted through its run handle and
 *   confirmed ONLY when the run's own result reports `stopReason: "aborted"`.
 *   A run that never reports its end answers `requested`; a run another process
 *   started answers `requested` at best (through `interrupt()`, which returns
 *   void) and `unsupported` when the runtime exposes no interrupt, when the call
 *   throws, or when the probe names no execution. A run that ended as a
 *   COMPLETION is never reported as a cancellation.
 * - Pi: `cancelTask` is asked, then the manager's own task record is READ BACK.
 *   Only `cancelled` there is a confirmation; a reported transition with no
 *   record, a task that ended with another status, a manager with no
 *   `cancelTask`, a throwing manager and an unnamed execution are all
 *   unconfirmed.
 *
 * STRENGTH: adapter + unit doubles, one process. No real dsh/Pi SDK run happens
 * here, so none of this is real-host evidence.
 */

import { describe, expect, it } from "bun:test";

import type { DispatchTask } from "../../src/dispatch/types.ts";
import type {
  DshSubagentProvider,
  DshSubagentResult,
  DshSubagentRun,
  DshSubagentStartRequest,
} from "../../src/platform/adapters/dsh/agent-registrar.ts";
import {
  DshOutcomeDelivery,
  type DshOutcomeSubagentRuntime,
} from "../../src/platform/adapters/dsh/outcome-dispatch.ts";
import {
  PiOutcomeDelivery,
  type PiOutcomeDispatchPort,
} from "../../src/platform/adapters/pi/outcome-dispatch.ts";
import type { OutcomeExecutionCancelProbe } from "../../src/graph/outcome/cancel.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/dispatch-effects.ts";

/** One microtask-drain, so a delivery's asynchronous tail has run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function dispatchRequest(attemptId: string): OutcomeDispatchRequest {
  return {
    graphId: "platform.cancel",
    planRevision: "rev-1",
    nodeId: "work",
    attemptId,
    agent: "agent.work",
    prompt: "Do the work.",
    // A neutral placeholder, never a real capability value.
    credential: "placeholder-attempt-credential",
  };
}

function cancelProbe(attemptId: string, executionId?: string): OutcomeExecutionCancelProbe {
  return {
    effect: {
      graphId: "platform.cancel",
      effectId: "dispatch:" + attemptId,
      attemptId,
    },
    nodeId: "work",
    reason: "a trusted operator cancelled the graph",
    ...(executionId === undefined ? {} : { execution: { executionId } }),
  };
}

// ── dsh ─────────────────────────────────────────────────────────────────────

interface FakeDshRun {
  readonly run: DshSubagentRun;
  readonly id: string;
  /** How often the port disposed the run handle (the documented abort surface). */
  disposeCalls: number;
  /** The cancellation signal the start request carried. */
  readonly signal: AbortSignal;
  /** What the platform observes when the run handle is disposed. */
  onDispose: () => void;
  resolveResult(result: DshSubagentResult): void;
}

/**
 * A structural dsh `ctx.subagents` double: it starts runs the test drives and
 * exposes `interrupt` only when the scenario asks for it.
 */
function makeDshRuntime(options: { readonly interrupt?: "present" | "throwing" | "absent" }) {
  const starts: DshSubagentStartRequest[] = [];
  const runs: FakeDshRun[] = [];
  const interrupts: string[] = [];
  const provider: DshSubagentProvider = {
    name: "spawn",
    capabilities: {
      agentOptions: false,
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
    },
    inheritsParentContext: false,
    start: async () => {
      throw new Error("the provider start is never used by the delivery seam");
    },
  };
  const runtime: DshOutcomeSubagentRuntime = {
    registerProvider: () => () => {},
    getProvider: (name: string) => (name === "agent.work" ? provider : undefined),
    list: () => ["spawn"],
    start: async (_name: string, request: DshSubagentStartRequest) => {
      starts.push(request);
      let resolveResult!: (result: DshSubagentResult) => void;
      const result = new Promise<DshSubagentResult>((resolve) => {
        resolveResult = resolve;
      });
      const id = "dsh-run-" + String(starts.length);
      const entry: FakeDshRun = {
        id,
        disposeCalls: 0,
        signal: request.signal,
        onDispose: () => {},
        resolveResult,
        run: {
          id,
          result,
          dispose: async () => {
            entry.disposeCalls += 1;
            entry.onDispose();
          },
        },
      };
      runs.push(entry);
      return entry.run;
    },
    ...(options.interrupt === "present" || options.interrupt === "throwing"
      ? {
          interrupt: (targetSessionId: string) => {
            interrupts.push(targetSessionId);
            if (options.interrupt === "throwing") {
              throw new Error("this dsh build refused the interrupt");
            }
          },
        }
      : {}),
  };
  return { runtime, starts, runs, interrupts };
}

interface DshHarness {
  readonly delivery: DshOutcomeDelivery;
  readonly runtime: ReturnType<typeof makeDshRuntime>;
  readonly settled: readonly string[];
  readonly failures: readonly string[];
}

function makeDshHarness(
  options: { readonly interrupt?: "present" | "throwing" | "absent"; readonly confirmMs?: number } = {},
): DshHarness {
  const runtime = makeDshRuntime(options);
  const settled: string[] = [];
  const failures: string[] = [];
  const delivery = new DshOutcomeDelivery({
    subagents: runtime.runtime,
    parentResolver: () => ({}),
    onSettled: (settlement) => {
      settled.push(settlement.kind + ":" + (settlement.kind === "failed" ? settlement.reason : ""));
    },
    onStartFailed: (_request, _effect, reason) => {
      failures.push(reason);
    },
    cancelConfirmTimeoutMs: options.confirmMs ?? 25,
  });
  return { delivery, runtime, settled, failures };
}

describe("dsh cancel — dispose the run this process started, confirm only on 'aborted'", () => {
  it("confirms when the run's own result reports the abort", async () => {
    const harness = makeDshHarness();
    harness.delivery.deliver(dispatchRequest("work#1"), cancelProbe("work#1").effect, {
      sessionId: "parent-session",
      agent: "agent.work",
    });
    await tick();
    const run = harness.runtime.runs[0];
    if (run === undefined) throw new Error("fixture: the run was not started");
    // The port is what the trusted cancel command reaches: the run's handle is
    // disposed and its own result promise reports the abort.
    run.onDispose = () => {
      run.resolveResult({ output: [], stopReason: "aborted" });
    };

    const answer = await harness.delivery.cancelExecution.cancel(
      cancelProbe("work#1", run.id),
    );
    expect(answer.kind).toBe("confirmed");
    expect(answer.reason).toContain("aborted");
    // The documented dsh abort surface was called AND the caller-owned signal aborted.
    expect(run.disposeCalls).toBe(1);
    expect(run.signal.aborted).toBe(true);
    // A CANCELLED run is an END that is NOT a completion: the settlement report
    // says failed, never completed.
    await tick();
    expect(harness.settled).toHaveLength(1);
    expect(harness.settled[0]?.startsWith("failed:")).toBe(true);
  });

  it("answers requested when the run has not reported its end, and never fabricates a confirmation", async () => {
    const harness = makeDshHarness({ confirmMs: 20 });
    harness.delivery.deliver(dispatchRequest("work#1"), cancelProbe("work#1").effect, {
      sessionId: "parent-session",
      agent: "agent.work",
    });
    await tick();
    const run = harness.runtime.runs[0];
    if (run === undefined) throw new Error("fixture: the run was not started");

    const answer = await harness.delivery.cancelExecution.cancel(cancelProbe("work#1", run.id));
    expect(answer.kind).toBe("requested");
    expect(answer.reason).toContain("CONFIRMED NOTHING");
    expect(run.signal.aborted).toBe(true);
    expect(harness.settled).toEqual([]);
  });

  it("answers requested — never confirmed — when the run ended as a COMPLETION", async () => {
    const harness = makeDshHarness();
    harness.delivery.deliver(dispatchRequest("work#1"), cancelProbe("work#1").effect, {
      sessionId: "parent-session",
      agent: "agent.work",
    });
    await tick();
    const run = harness.runtime.runs[0];
    if (run === undefined) throw new Error("fixture: the run was not started");
    run.onDispose = () => {
      run.resolveResult({ output: [], stopReason: "completed" });
    };

    const answer = await harness.delivery.cancelExecution.cancel(cancelProbe("work#1", run.id));
    expect(answer.kind).toBe("requested");
    expect(answer.reason).toContain("CONFIRMED NOTHING");
  });
});

describe("dsh cancel — a run this process did not start", () => {
  it("issues interrupt() for the recorded child session and never claims a confirmation", async () => {
    const harness = makeDshHarness({ interrupt: "present" });
    const answer = await harness.delivery.cancelExecution.cancel(
      cancelProbe("work#9", "child-session:work#9"),
    );
    expect(answer.kind).toBe("requested");
    expect(answer.reason).toContain("returns void");
    expect(harness.runtime.interrupts).toEqual(["child-session:work#9"]);
  });

  it("answers unsupported when the runtime exposes no interrupt", async () => {
    const harness = makeDshHarness({ interrupt: "absent" });
    const answer = await harness.delivery.cancelExecution.cancel(
      cancelProbe("work#9", "child-session:work#9"),
    );
    expect(answer.kind).toBe("unsupported");
    expect(answer.reason).toContain("no SubagentRuntime.interrupt");
  });

  it("answers unsupported when interrupt() throws, never a cancellation", async () => {
    const harness = makeDshHarness({ interrupt: "throwing" });
    const answer = await harness.delivery.cancelExecution.cancel(
      cancelProbe("work#9", "child-session:work#9"),
    );
    expect(answer.kind).toBe("unsupported");
    expect(answer.reason).toContain("threw");
    expect(harness.runtime.interrupts).toEqual(["child-session:work#9"]);
  });

  it("answers unsupported when the host can name no execution at all", async () => {
    const harness = makeDshHarness({ interrupt: "present" });
    const answer = await harness.delivery.cancelExecution.cancel(cancelProbe("work#9"));
    expect(answer.kind).toBe("unsupported");
    expect(answer.reason).toContain("nothing to cancel");
    expect(harness.runtime.interrupts).toEqual([]);
  });
});

// ── Pi ──────────────────────────────────────────────────────────────────────

function makeTask(id: string, status: DispatchTask["status"]): DispatchTask {
  return {
    id,
    sessionId: "session-" + id,
    parentSessionId: "session.parent",
    depth: 1,
    status,
    agent: "agent.work",
    prompt: "Do the work.",
    description: "platform.cancel/dispatch:work#1",
    startedAt: new Date(0),
    progress: { toolCalls: 0, lastUpdate: new Date(0) },
  };
}

function makePiHarness(options: {
  readonly status?: DispatchTask["status"];
  readonly cancelTask?: (taskId: string) => Promise<boolean>;
  readonly exposeCancelTask?: boolean;
  readonly exposeGetTask?: boolean;
}): PiOutcomeDelivery {
  const task = makeTask("task-1", options.status ?? "running");
  const manager: PiOutcomeDispatchPort = {
    launch: async () => task,
    onTaskTerminated: () => undefined,
    ...(options.exposeGetTask === false ? {} : { getTask: () => task }),
    ...(options.exposeCancelTask === false
      ? {}
      : {
          cancelTask: options.cancelTask ?? (async () => true),
        }),
  };
  return new PiOutcomeDelivery({
    manager,
    directory: "/workspace",
    onSettled: () => {},
    onStartFailed: () => {},
  });
}

describe("Pi cancel — the manager's own task record decides", () => {
  it("confirms when the manager's task record reads cancelled", async () => {
    const delivery = makePiHarness({
      status: "cancelled",
      cancelTask: async () => true,
    });
    const answer = await delivery.cancelExecution.cancel(cancelProbe("work#1", "task-1"));
    expect(answer.kind).toBe("confirmed");
    expect(answer.reason).toContain("task-1");
  });

  it("confirms a task that was ALREADY cancelled without reporting a fresh transition", async () => {
    const delivery = makePiHarness({
      status: "cancelled",
      cancelTask: async () => false,
    });
    const answer = await delivery.cancelExecution.cancel(cancelProbe("work#1", "task-1"));
    expect(answer.kind).toBe("confirmed");
    expect(answer.reason).toContain("already was");
  });

  it("answers requested when the transition is reported but no record substantiates it", async () => {
    const delivery = makePiHarness({
      status: "running",
      cancelTask: async () => true,
      exposeGetTask: false,
    });
    const answer = await delivery.cancelExecution.cancel(cancelProbe("work#1", "task-1"));
    expect(answer.kind).toBe("requested");
    expect(answer.reason).toContain("does not substantiate");
  });

  it("answers unsupported for a task that ended with another status: it was not cancelled", async () => {
    const delivery = makePiHarness({
      status: "completed",
      cancelTask: async () => false,
    });
    const answer = await delivery.cancelExecution.cancel(cancelProbe("work#1", "task-1"));
    expect(answer.kind).toBe("unsupported");
    expect(answer.reason).toContain("already terminal");
  });

  it("answers unsupported when the manager reports no cancellation", async () => {
    const delivery = makePiHarness({
      status: "running",
      cancelTask: async () => false,
    });
    const answer = await delivery.cancelExecution.cancel(cancelProbe("work#1", "task-1"));
    expect(answer.kind).toBe("unsupported");
    expect(answer.reason).toContain("did not cancel");
  });

  it("answers unsupported when cancelTask is absent or throws", async () => {
    const absent = makePiHarness({ exposeCancelTask: false });
    expect((await absent.cancelExecution.cancel(cancelProbe("work#1", "task-1"))).kind).toBe(
      "unsupported",
    );

    const throwing = makePiHarness({
      cancelTask: async () => {
        throw new Error("the manager refused the call");
      },
    });
    const answer = await throwing.cancelExecution.cancel(cancelProbe("work#1", "task-1"));
    expect(answer.kind).toBe("unsupported");
    expect(answer.reason).toContain("threw");
  });

  it("answers unsupported when the host can name no task", async () => {
    const delivery = makePiHarness({});
    const answer = await delivery.cancelExecution.cancel(cancelProbe("work#1"));
    expect(answer.kind).toBe("unsupported");
    expect(answer.reason).toContain("nothing to cancel");
  });
});
