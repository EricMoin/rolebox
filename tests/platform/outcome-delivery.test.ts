/**
 * Host delivery seams — the OUTCOME run path's platform half.
 *
 * These are the adapters the dsh and Pi entries inject as
 * `HostDispatchDelivery` (`src/graph/host/dispatch-host.ts`): the ONE channel
 * an attempt credential travels over, and the ONE place a platform's terminal
 * observation becomes a completion report the host bridge settles through.
 *
 * Pinned here:
 *   - a delivery with no invocation in effect refuses SYNCHRONOUSLY (nothing
 *     started, so the host's execution-index record is dropped);
 *   - an unknown dsh provider and an unresolvable live parent refuse the same
 *     way, before any start request is composed;
 *   - a started run's prompt carries the plan prompt plus the attempt handoff
 *     (identity + credential) and never a second copy;
 *   - a terminal observation becomes `completed` only for the platform's own
 *     completion status; every other status is REPORTED as failed and settles
 *     nothing;
 *   - an asynchronous start rejection is reported with the stable effect key.
 */

import { describe, it, expect } from "bun:test";

import { DshOutcomeDelivery } from "../../src/platform/adapters/dsh/outcome-dispatch.ts";
import { PiOutcomeDelivery } from "../../src/platform/adapters/pi/outcome-dispatch.ts";
import { DshParentUnresolvedError } from "../../src/platform/adapters/dsh/dispatch.ts";
import type { DshSubagentDispatchRuntime } from "../../src/platform/adapters/dsh/dispatch.ts";
import type {
  DshSubagentRun,
  DshSubagentStartRequest,
} from "../../src/platform/adapters/dsh/agent-registrar.ts";
import type {
  OutcomeDispatchEffectKey,
  OutcomeDispatchRequest,
} from "../../src/graph/outcome/dispatch-effects.ts";
import type { DispatchInput, DispatchTask } from "../../src/dispatch/types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const CREDENTIAL = "attempt-credential-7f3a";

function request(): OutcomeDispatchRequest {
  return {
    graphId: "graph.delivery",
    planRevision: "rev-1",
    nodeId: "work",
    attemptId: "work#1",
    agent: "agent.work",
    prompt: "Do the work.",
    credential: CREDENTIAL,
  };
}

function effect(): OutcomeDispatchEffectKey {
  return { graphId: "graph.delivery", effectId: "dispatch:work#1", attemptId: "work#1" };
}

/** A dsh subagent runtime double that starts one run and resolves it. */
function makeDshRuntime(options: {
  readonly stopReason?: DshSubagentStartRequest extends never ? never : "completed" | "error";
  readonly rejectStart?: boolean;
  readonly providerMissing?: boolean;
} = {}): {
  runtime: DshSubagentDispatchRuntime;
  starts: Array<{ agent: string; request: DshSubagentStartRequest }>;
} {
  const starts: Array<{ agent: string; request: DshSubagentStartRequest }> = [];
  const runtime: DshSubagentDispatchRuntime = {
    getProvider: (agent: string) =>
      options.providerMissing === true || agent !== "agent.work" ? undefined : {},
    list: () => ["agent.work"],
    start: async (agent: string, startRequest: DshSubagentStartRequest) => {
      starts.push({ agent, request: startRequest });
      if (options.rejectStart === true) {
        throw new Error("provider refused to start");
      }
      const run: DshSubagentRun = {
        id: "run-1",
        result: Promise.resolve({
          output: [],
          stopReason: options.stopReason ?? "completed",
        }),
        dispose: async () => {},
      };
      return run;
    },
  };
  return { runtime, starts };
}

/** A dispatch port double that launches one task and exposes its listener. */
function makePiPort(): {
  port: {
    launch(
      input: DispatchInput,
      parentContext: { sessionID: string; agent: string; directory: string },
    ): Promise<DispatchTask>;
    onTaskTerminated(
      taskId: string,
      callback: (taskId: string, status: string) => void,
    ): unknown;
  };
  launches: DispatchInput[];
  terminate: (taskId: string, status: string) => void;
} {
  const launches: DispatchInput[] = [];
  const listeners = new Map<string, (taskId: string, status: string) => void>();
  return {
    port: {
      launch: async (input) => {
        launches.push(input);
        const task: DispatchTask = {
          id: "task-1",
          sessionId: "session-1",
          parentSessionId: "session-1",
          depth: 1,
          status: "running",
          agent: input.subagent,
          prompt: input.prompt,
          startedAt: new Date(NOW),
          progress: { lastUpdate: new Date(NOW), toolCalls: 0 },
          priority: 0,
        };
        return task;
      },
      onTaskTerminated: (taskId, callback) => {
        listeners.set(taskId, callback);
        return callback;
      },
    },
    launches,
    terminate: (taskId, status) => {
      listeners.get(taskId)?.(taskId, status);
    },
  };
}

/** Let the adapters' promise tails run. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ── dsh delivery ────────────────────────────────────────────────────────────

describe("DshOutcomeDelivery", () => {
  it("refuses synchronously with no invoking session in effect", () => {
    const { runtime } = makeDshRuntime();
    const delivery = new DshOutcomeDelivery({
      subagents: runtime,
      parentResolver: () => ({ id: "parent" }),
      onSettled: () => {},
      onStartFailed: () => {},
    });
    expect(() => delivery.deliver(request(), effect())).toThrow(
      /no invoking session is in effect/,
    );
  });

  it("refuses synchronously when the agent has no registered provider", () => {
    const { runtime } = makeDshRuntime({ providerMissing: true });
    const delivery = new DshOutcomeDelivery({
      subagents: runtime,
      parentResolver: () => ({ id: "parent" }),
      onSettled: () => {},
      onStartFailed: () => {},
    });
    delivery.setParentSession("session-1");
    expect(() => delivery.deliver(request(), effect())).toThrow(
      /no subagent provider registered/,
    );
  });

  it("refuses synchronously when the live parent cannot be resolved", () => {
    const { runtime } = makeDshRuntime();
    const delivery = new DshOutcomeDelivery({
      subagents: runtime,
      parentResolver: () => undefined,
      onSettled: () => {},
      onStartFailed: () => {},
    });
    delivery.setParentSession("session-1");
    let caught: unknown;
    try {
      delivery.deliver(request(), effect());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DshParentUnresolvedError);
  });

  it("delivers the plan prompt plus the attempt handoff and reports completion", async () => {
    const { runtime, starts } = makeDshRuntime();
    const settled: string[] = [];
    const delivery = new DshOutcomeDelivery({
      subagents: runtime,
      parentResolver: (sid) => ({ id: "parent-" + sid }),
      onSettled: (settlement) => {
        settled.push(settlement.kind);
      },
      onStartFailed: () => {
        settled.push("start-failed");
      },
    });
    delivery.setParentSession("session-1");
    delivery.deliver(request(), effect());
    await flush();

    expect(starts).toHaveLength(1);
    expect(starts[0].agent).toBe("agent.work");
    const text = starts[0].request.prompt.map((b) => b.text).join("\n");
    expect(text).toContain("Do the work.");
    expect(text).toContain(CREDENTIAL);
    expect(text).toContain("work#1");
    expect(settled).toEqual(["completed"]);
  });

  it("reports a non-completion stopReason as failed (no settlement)", async () => {
    const { runtime } = makeDshRuntime({ stopReason: "error" });
    const settled: string[] = [];
    const delivery = new DshOutcomeDelivery({
      subagents: runtime,
      parentResolver: () => ({ id: "parent" }),
      onSettled: (settlement) => {
        settled.push(settlement.kind);
      },
      onStartFailed: () => {
        settled.push("start-failed");
      },
    });
    delivery.setParentSession("session-1");
    delivery.deliver(request(), effect());
    await flush();
    expect(settled).toEqual(["failed"]);
  });

  it("reports an asynchronous start rejection with the stable effect key", async () => {
    const { runtime } = makeDshRuntime({ rejectStart: true });
    const failed: OutcomeDispatchEffectKey[] = [];
    const delivery = new DshOutcomeDelivery({
      subagents: runtime,
      parentResolver: () => ({ id: "parent" }),
      onSettled: () => {},
      onStartFailed: (_request, key) => {
        failed.push(key);
      },
    });
    delivery.setParentSession("session-1");
    delivery.deliver(request(), effect());
    await flush();
    expect(failed.map((key) => key.effectId)).toEqual(["dispatch:work#1"]);
  });
});

// ── Pi delivery ─────────────────────────────────────────────────────────────

describe("PiOutcomeDelivery", () => {
  it("refuses synchronously with no invocation in effect", () => {
    const { port } = makePiPort();
    const delivery = new PiOutcomeDelivery({
      manager: port,
      directory: "/tmp",
      onSettled: () => {},
      onStartFailed: () => {},
    });
    expect(() => delivery.deliver(request(), effect())).toThrow(
      /no invoking session is in effect/,
    );
  });

  it("launches the attempt with the credential and reports completion", async () => {
    const { port, launches, terminate } = makePiPort();
    const settled: string[] = [];
    const delivery = new PiOutcomeDelivery({
      manager: port,
      directory: "/tmp",
      onSettled: (settlement) => {
        settled.push(settlement.kind);
      },
      onStartFailed: () => {
        settled.push("start-failed");
      },
    });
    delivery.setInvocation("session-1", "agent.orchestrator");
    delivery.deliver(request(), effect());
    await flush();

    expect(launches).toHaveLength(1);
    expect(launches[0].subagent).toBe("agent.work");
    expect(launches[0].prompt).toContain(CREDENTIAL);
    expect(launches[0].run_in_background).toBe(true);

    terminate("task-1", "completed");
    expect(settled).toEqual(["completed"]);
  });

  it("reports an error status as failed (no settlement)", async () => {
    const { port, terminate } = makePiPort();
    const settled: string[] = [];
    const delivery = new PiOutcomeDelivery({
      manager: port,
      directory: "/tmp",
      onSettled: (settlement) => {
        settled.push(settlement.kind);
      },
      onStartFailed: () => {
        settled.push("start-failed");
      },
    });
    delivery.setInvocation("session-1", "agent.orchestrator");
    delivery.deliver(request(), effect());
    await flush();
    terminate("task-1", "error");
    expect(settled).toEqual(["failed"]);
  });
});
