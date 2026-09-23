/**
 * P2 part 2 — the shipped platform QUERY, OBSERVATION and WATCH ports.
 *
 * The host layer asks three platform questions after a create whose outcome it
 * never saw (plan §4 P2 items 5/6, gaps F2–F4):
 *
 *   1. the EXECUTION QUERY — does an execution already exist for this stable
 *      effect id, and WHICH one? (the same key the create carried);
 *   2. the TERMINAL READ — has the confirmed execution already ended, and did it
 *      reach the outcome its plan authorized?
 *   3. the WATCH — can this process be told when it ends?
 *
 * This file pins what each shipped adapter actually answers, against fakes that
 * mirror the platform surfaces rolebox consumes:
 *
 *   - dsh: the run's DURABLE LABEL is the stable idempotency key, and
 *     `ctx.subagents.listChildren` correlates a parent's child with it. The
 *     listing is asynchronous, so the port is PRIMED before the synchronous run
 *     path asks. dsh has no durable outcome read and no post-restart
 *     announcement, so the terminal read answers `unknown` and the watch
 *     answers "unsupported" — never a guess;
 *   - Pi: the task's `description` is the stable key and the dispatch manager's
 *     own records answer both the query and the terminal read, with
 *     `onTaskTerminated` as the durable re-subscription (it fires immediately
 *     for a task that is already terminal).
 *
 * THE HARD RULE PINNED HERE (plan §8.3 O2): neither port may answer `absent`
 * for an execution it merely cannot find. A false `absent` licenses releasing a
 * stranded create right and running the attempt twice. Every "not found" case
 * below asserts `unknown` explicitly.
 *
 * PRIVACY: the fixtures mint ids; no credential value, private path or session
 * transcript appears in this file.
 */

import { describe, expect, it } from "bun:test";

import { DshOutcomeDelivery } from "../../src/platform/adapters/dsh/outcome-dispatch.ts";
import { PiOutcomeDelivery } from "../../src/platform/adapters/pi/outcome-dispatch.ts";
import type { DshOutcomeSubagentRuntime } from "../../src/platform/adapters/dsh/outcome-dispatch.ts";
import type {
  DshSubagentRun,
  DshSubagentStartRequest,
} from "../../src/platform/adapters/dsh/agent-registrar.ts";
import type { DispatchInput, DispatchTask } from "../../src/dispatch/types.ts";
import {
  dispatchEffectKeyOf,
  dispatchIdempotencyKeyOf,
  type OutcomeDispatchRequest,
  type OutcomeExecutionProbe,
} from "../../src/graph/outcome/dispatch-effects.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const GRAPH_ID = "graph.observation";
const ATTEMPT_ID = "work#1";
const EFFECT = dispatchEffectKeyOf(GRAPH_ID, ATTEMPT_ID);
/** The stable key the create call must carry on both platforms. */
const STABLE_KEY = dispatchIdempotencyKeyOf(EFFECT);
const INVOCATION = { sessionId: "session.declarer", agent: "agent.orchestrator" } as const;
const EXECUTION_ID = "platform-execution-1";

function request(): OutcomeDispatchRequest {
  return {
    graphId: GRAPH_ID,
    planRevision: "rev-1",
    nodeId: "work",
    attemptId: ATTEMPT_ID,
    agent: "agent.work",
    prompt: "Do the work.",
    credential: "credential-fixture-1",
  };
}

function probe(invocation: OutcomeExecutionProbe["invocation"] = INVOCATION): OutcomeExecutionProbe {
  return { effect: EFFECT, ...(invocation === undefined ? {} : { invocation }) };
}

// ── dsh ─────────────────────────────────────────────────────────────────────

interface DshChild {
  readonly kind: string;
  readonly id: string;
  readonly label?: string;
  readonly activity?: string;
  readonly mode?: string;
}

/** A dsh subagent runtime double that starts runs and lists children. */
function makeDshRuntime(options: {
  readonly children?: readonly DshChild[];
  readonly listingThrows?: boolean;
  readonly noListing?: boolean;
} = {}): {
  runtime: DshOutcomeSubagentRuntime;
  starts: Array<{ agent: string; request: DshSubagentStartRequest }>;
  listings: string[];
} {
  const starts: Array<{ agent: string; request: DshSubagentStartRequest }> = [];
  const listings: string[] = [];
  const runtime: DshOutcomeSubagentRuntime = {
    getProvider: () => ({}),
    list: () => ["agent.work"],
    start: async (agent: string, startRequest: DshSubagentStartRequest) => {
      starts.push({ agent, request: startRequest });
      const run: DshSubagentRun = {
        id: "run-1",
        result: new Promise(() => {}),
        dispose: async () => {},
      };
      return run;
    },
    ...(options.noListing === true
      ? {}
      : {
          listChildren: async (parentSessionId: string) => {
            listings.push(parentSessionId);
            if (options.listingThrows === true) {
              throw new Error("the session projection service is not mounted");
            }
            return options.children ?? [];
          },
        }),
  };
  return { runtime, starts, listings };
}

function dshDelivery(runtime: DshOutcomeSubagentRuntime): DshOutcomeDelivery {
  return new DshOutcomeDelivery({
    subagents: runtime,
    // dsh requires a live parent Agent on every start; the double resolves one.
    parentResolver: () => ({}),
    onSettled: () => {},
    onStartFailed: () => {},
  });
}

describe("the dsh execution query port", () => {
  it("names the execution whose durable label is the stable idempotency key", async () => {
    const { runtime, listings } = makeDshRuntime({
      children: [
        { kind: "child", id: EXECUTION_ID, label: STABLE_KEY, activity: "running", mode: "one-shot" },
        { kind: "child", id: "child-other", label: "graph.other/dispatch:work#1", mode: "one-shot" },
      ],
    });
    const delivery = dshDelivery(runtime);

    // THE PRIMING PHASE reads the parent's listing; the synchronous lookup then
    // answers from it (the run path cannot await).
    await delivery.executionQuery.prime?.([probe()]);
    expect(listings).toEqual([INVOCATION.sessionId]);

    expect(delivery.executionQuery.lookup(probe())).toEqual({
      kind: "created",
      execution: { executionId: EXECUTION_ID },
    });
  });

  it("answers unknown — NEVER absent — when no child carries the label", async () => {
    const { runtime } = makeDshRuntime({
      children: [{ kind: "child", id: "child-other", label: "graph.other/dispatch:work#1" }],
    });
    const delivery = dshDelivery(runtime);
    await delivery.executionQuery.prime?.([probe()]);

    const answer = delivery.executionQuery.lookup(probe());
    expect(answer.kind).toBe("unknown");
    if (answer.kind !== "unknown") throw new Error("expected unknown");
    // The reason states why the absence is not a proof: a live-preferred listing
    // cannot establish that an execution never existed.
    expect(answer.reason).toContain("live-preferred");
    expect(answer.reason).toContain("NOT a proof");
  });

  it("answers unknown for an unprimed question, a parentless probe, a failed listing and no listing at all", async () => {
    const unprimed = dshDelivery(makeDshRuntime({ children: [] }).runtime);
    expect(unprimed.executionQuery.lookup(probe()).kind).toBe("unknown");
    expect(unprimed.executionQuery.lookup(probe(undefined)).kind).toBe("unknown");

    const failing = dshDelivery(makeDshRuntime({ listingThrows: true }).runtime);
    await failing.executionQuery.prime?.([probe()]);
    expect(failing.executionQuery.lookup(probe()).kind).toBe("unknown");

    // A runtime without the listing capability cannot correlate at all: the
    // answer is unknown, and the reason names the missing capability.
    const bare = dshDelivery(makeDshRuntime({ noListing: true }).runtime);
    await bare.executionQuery.prime?.([probe()]);
    const answer = bare.executionQuery.lookup(probe());
    expect(answer.kind).toBe("unknown");
    if (answer.kind !== "unknown") throw new Error("expected unknown");
    expect(answer.reason).toContain("listChildren");
  });

  it("refuses an ambiguous correlation rather than picking one of two children", async () => {
    const { runtime } = makeDshRuntime({
      children: [
        { kind: "child", id: "child-a", label: STABLE_KEY },
        { kind: "child", id: "child-b", label: STABLE_KEY },
      ],
    });
    const delivery = dshDelivery(runtime);
    await delivery.executionQuery.prime?.([probe()]);

    const answer = delivery.executionQuery.lookup(probe());
    expect(answer.kind).toBe("unknown");
    if (answer.kind !== "unknown") throw new Error("expected unknown");
    expect(answer.reason).toContain("more than one child");
  });

  it("carries the stable idempotency key as the run's durable label", () => {
    const { runtime, starts } = makeDshRuntime();
    dshDelivery(runtime).deliver(request(), EFFECT, INVOCATION);

    return Promise.resolve().then(() => {
      expect(starts).toHaveLength(1);
      expect(starts[0]?.request.label).toBe(STABLE_KEY);
      // The label is the CREATE's key and the QUERY's key, spelled once.
      expect(starts[0]?.request.label).toBe(dispatchIdempotencyKeyOf(EFFECT));
    });
  });

  it("answers unknown for a terminal read and unsupported for a watch (dsh's honest gap)", () => {
    const delivery = dshDelivery(makeDshRuntime().runtime);
    const observation = delivery.observeExecution({ executionId: EXECUTION_ID });
    expect(observation.kind).toBe("unknown");
    if (observation.kind !== "unknown") throw new Error("expected unknown");
    expect(observation.reason).toContain("no durable outcome read");
    expect(
      delivery.watchCompletion(
        {
          graphId: GRAPH_ID,
          nodeId: "work",
          attemptId: ATTEMPT_ID,
          executionId: EXECUTION_ID,
          status: "running",
          reason: "still running",
        },
        () => {},
      ),
    ).toBe("unsupported");
  });
});

// ── Pi ──────────────────────────────────────────────────────────────────────

function task(id: string, status: DispatchTask["status"], description?: string): DispatchTask {
  return {
    id,
    sessionId: "session." + id,
    parentSessionId: INVOCATION.sessionId,
    depth: 1,
    status,
    agent: "agent.work",
    prompt: "Do the work.",
    ...(description === undefined ? {} : { description }),
    startedAt: new Date(0),
    progress: { lastUpdate: new Date(0), toolCalls: 0 },
    priority: 0,
  };
}

/** A Pi dispatch port double with the manager's own read surface. */
function makePiManager(tasks: DispatchTask[]): {
  manager: {
    launch(
      input: DispatchInput,
      parentContext: { sessionID: string; agent: string; directory: string },
    ): Promise<DispatchTask>;
    onTaskTerminated(
      taskId: string,
      callback: (taskId: string, status: string) => void,
    ): unknown;
    getTask(taskId: string): DispatchTask | undefined;
    getAllTasks(): DispatchTask[];
  };
  launches: DispatchInput[];
  listeners: Map<string, (taskId: string, status: string) => void>;
  terminate: (taskId: string, status: string) => void;
} {
  const launches: DispatchInput[] = [];
  const listeners = new Map<string, (taskId: string, status: string) => void>();
  let seq = 0;
  return {
    manager: {
      launch: async (input, parentContext) => {
        launches.push(input);
        const created = task(
          "task-" + String(++seq),
          "running",
          input.description,
        );
        void parentContext;
        return created;
      },
      onTaskTerminated: (taskId, callback) => {
        listeners.set(taskId, callback);
        return callback;
      },
      getTask: (taskId) => tasks.find((candidate) => candidate.id === taskId),
      getAllTasks: () => [...tasks],
    },
    launches,
    listeners,
    terminate: (taskId, status) => {
      listeners.get(taskId)?.(taskId, status);
    },
  };
}

function piDelivery(manager: ReturnType<typeof makePiManager>["manager"]): PiOutcomeDelivery {
  return new PiOutcomeDelivery({
    manager,
    directory: "/workspace/fixture",
    onSettled: () => {},
    onStartFailed: () => {},
  });
}

describe("the Pi execution query port", () => {
  it("names the execution by the stable key the create carried as the description", () => {
    const { manager } = makePiManager([
      task(EXECUTION_ID, "running", STABLE_KEY),
      task("task-other", "running", "graph.other/dispatch:work#1"),
      task("task-undescribed", "running"),
    ]);
    expect(piDelivery(manager).executionQuery.lookup(probe())).toEqual({
      kind: "created",
      execution: { executionId: EXECUTION_ID, taskId: EXECUTION_ID },
    });
  });

  it("answers unknown — NEVER absent — for a task the manager does not hold", () => {
    const { manager } = makePiManager([task("task-other", "running", "another-key")]);
    const answer = piDelivery(manager).executionQuery.lookup(probe());
    expect(answer.kind).toBe("unknown");
    if (answer.kind !== "unknown") throw new Error("expected unknown");
    expect(answer.reason).toContain("not evidence of absence");
  });

  it("answers unknown for an ambiguous match, a failed listing and a port with no listing", () => {
    const ambiguous = makePiManager([
      task("task-a", "running", STABLE_KEY),
      task("task-b", "running", STABLE_KEY),
    ]);
    expect(piDelivery(ambiguous.manager).executionQuery.lookup(probe()).kind).toBe("unknown");

    const noListing = piDelivery({
      launch: async () => task("task-1", "running", STABLE_KEY),
      onTaskTerminated: () => undefined,
    });
    expect(noListing.executionQuery.lookup(probe()).kind).toBe("unknown");
  });

  it("reads the task's status: completed is a completion, error/cancelled/timeout are NOT", () => {
    const statuses: ReadonlyArray<readonly [DispatchTask["status"], string]> = [
      ["completed", "completed"],
      ["error", "failed"],
      ["cancelled", "failed"],
      ["timeout", "failed"],
      ["running", "running"],
      ["pending", "running"],
      ["awaiting_approval", "running"],
    ];
    for (const [status, expected] of statuses) {
      const { manager } = makePiManager([task(EXECUTION_ID, status, STABLE_KEY)]);
      const observation = piDelivery(manager).observeExecution({
        executionId: EXECUTION_ID,
        taskId: EXECUTION_ID,
      });
      expect(observation.kind).toBe(expected);
      if (observation.kind === "failed") {
        expect(observation.reason).toContain(status);
      }
    }
  });

  it("answers unknown for a task it cannot read (cleaned up, lost by recovery, or no read surface)", () => {
    const { manager } = makePiManager([]);
    const missing = piDelivery(manager).observeExecution({ executionId: "task-gone" });
    expect(missing.kind).toBe("unknown");
    if (missing.kind !== "unknown") throw new Error("expected unknown");
    expect(missing.reason).toContain("no record");

    const noRead = piDelivery({
      launch: async () => task("task-1", "running"),
      onTaskTerminated: () => undefined,
    });
    expect(noRead.observeExecution({ executionId: "task-1" }).kind).toBe("unknown");
  });

  it("re-subscribes through the manager's own terminator for a task it holds, and refuses an unknown one", () => {
    const { manager, listeners, terminate } = makePiManager([
      task(EXECUTION_ID, "running", STABLE_KEY),
    ]);
    const delivery = piDelivery(manager);
    const entry = {
      graphId: GRAPH_ID,
      nodeId: "work",
      attemptId: ATTEMPT_ID,
      executionId: EXECUTION_ID,
      taskId: EXECUTION_ID,
      status: "running" as const,
      reason: "still running",
    };
    let ended = 0;
    expect(delivery.watchCompletion(entry, () => { ended += 1; })).toBe("watching");
    expect(listeners.has(EXECUTION_ID)).toBe(true);
    terminate(EXECUTION_ID, "completed");
    expect(ended).toBe(1);

    const unknown = { ...entry, executionId: "task-never-seen", taskId: "task-never-seen" };
    expect(delivery.watchCompletion(unknown, () => { ended += 1; })).toBe("unsupported");
    expect(ended).toBe(1);
  });

  it("carries the stable idempotency key as the task description", async () => {
    const { manager, launches } = makePiManager([]);
    piDelivery(manager).deliver(request(), EFFECT, INVOCATION);
    await Promise.resolve();
    expect(launches).toHaveLength(1);
    expect(launches[0]?.description).toBe(STABLE_KEY);
  });
});
