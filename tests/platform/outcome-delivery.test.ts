/**
 * Host delivery seams — the OUTCOME run path's platform half.
 *
 * These are the adapters the dsh and Pi entries inject as
 * `HostDispatchDelivery` (`src/graph/host/dispatch-host.ts`): the ONE channel
 * an attempt credential travels over, and the ONE place a platform's terminal
 * observation becomes a completion report the host bridge settles through.
 *
 * Pinned here:
 *   - a delivery handed NO invocation refuses SYNCHRONOUSLY (nothing started,
 *     so the host's execution-index record is dropped);
 *   - the invocation arrives WITH each delivery — the host's attribution of the
 *     graph's declaring invocation — so the adapter keeps no session state and
 *     a successor armed out of band is composed under the same parent as the
 *     entry attempt;
 *   - an unknown dsh provider and an unresolvable live parent refuse the same
 *     way, before any start request is composed;
 *   - a started run's prompt carries the plan prompt plus the attempt handoff
 *     (identity + credential) and never a second copy;
 *   - a terminal observation becomes `completed` only for the platform's own
 *     completion status; every other status is REPORTED as failed and settles
 *     nothing;
 *   - an asynchronous start rejection is reported with the stable effect key;
 *   - a TWO-NODE graph driven through the real Pi delivery and the real host
 *     layer reaches `complete`, with the successor launched under the invoking
 *     session the delivery was handed.
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
import { OutcomeHost } from "../../src/graph/host/outcome-host.ts";
import {
  buildDeclaredOutcomeGraph,
  persistDeclaredGraph,
} from "../../src/graph/tools/declare-graph.ts";
import { scanPersistedStates } from "../../src/graph/tools/persisted-state.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HostDispatchInvocation } from "../../src/graph/host/dispatch-host.ts";
import {
  AUTHORIZED,
  EMPTY_VALIDATORS,
  GRAPH_ID,
  makeTmpDir,
  naturalDeclaration,
} from "../graph/helpers/host-graph-fixture.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const CREDENTIAL = "attempt-credential-7f3a";
/** The invocation the host attributes to the graph's declaring call. */
const INVOCATION = { sessionId: "session-1", agent: "agent.orchestrator" } as const;

/**
 * Every byte of every file under `root`, as text — the credential-search
 * surface. A directory that does not exist is empty text: the assertion is
 * "nothing durable carries the value", and a missing directory carries nothing.
 */
function readTextUnder(root: string): string {
  let names: string[];
  try {
    names = readdirSync(root, { encoding: "utf-8" });
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const name of names) {
    const path = join(root, name);
    try {
      if (statSync(path).isDirectory()) parts.push(readTextUnder(path));
      else parts.push(readFileSync(path, "utf8"));
    } catch {
      // A path that cannot be read is not evidence either way; the assertion
      // below is about what IS readable.
    }
  }
  return parts.join("\n");
}

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
  readonly stopReason?: "completed" | "error";
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

/** A dispatch port double that launches one task per call and exposes listeners. */
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
  /** The parent context each launch was composed under, in launch order. */
  contexts: Array<{ sessionID: string; agent: string; directory: string }>;
  terminate: (taskId: string, status: string) => void;
} {
  const launches: DispatchInput[] = [];
  const contexts: Array<{ sessionID: string; agent: string; directory: string }> = [];
  const listeners = new Map<string, (taskId: string, status: string) => void>();
  let seq = 0;
  return {
    port: {
      launch: async (input, parentContext) => {
        launches.push(input);
        contexts.push(parentContext);
        const id = "task-" + String(++seq);
        const task: DispatchTask = {
          id,
          sessionId: parentContext.sessionID,
          parentSessionId: parentContext.sessionID,
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
    contexts,
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
  it("refuses synchronously when the delivery names no invoking session", () => {
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
    expect(() => delivery.deliver(request(), effect(), INVOCATION)).toThrow(
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
    let caught: unknown;
    try {
      delivery.deliver(request(), effect(), INVOCATION);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DshParentUnresolvedError);
  });

  it("composes the run under the invocation the delivery was handed", async () => {
    const { runtime, starts } = makeDshRuntime();
    const delivery = new DshOutcomeDelivery({
      subagents: runtime,
      parentResolver: (sid) => ({ id: "parent-" + sid }),
      onSettled: () => {},
      onStartFailed: () => {},
    });
    delivery.deliver(request(), effect(), INVOCATION);
    await flush();
    expect(starts).toHaveLength(1);
    // The session the run is composed under is the DELIVERY's invocation, not
    // any state the adapter kept from an earlier call.
    expect(starts[0].request.sessionId).toBe(INVOCATION.sessionId);
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
    delivery.deliver(request(), effect(), INVOCATION);
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
    delivery.deliver(request(), effect(), INVOCATION);
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
    delivery.deliver(request(), effect(), INVOCATION);
    await flush();
    expect(failed.map((key) => key.effectId)).toEqual(["dispatch:work#1"]);
  });
});

// ── Pi delivery ─────────────────────────────────────────────────────────────

describe("PiOutcomeDelivery", () => {
  it("refuses synchronously when the delivery names no invoking session", () => {
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

  it("launches the attempt under the delivered invocation and reports completion", async () => {
    const { port, launches, contexts, terminate } = makePiPort();
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
    delivery.deliver(request(), effect(), INVOCATION);
    await flush();

    expect(launches).toHaveLength(1);
    expect(launches[0].subagent).toBe("agent.work");
    expect(launches[0].prompt).toContain(CREDENTIAL);
    expect(launches[0].run_in_background).toBe(true);
    // The parent context is the delivery's invocation — the adapter holds no
    // session state of its own.
    expect(contexts[0]).toEqual({
      sessionID: INVOCATION.sessionId,
      agent: INVOCATION.agent,
      directory: "/tmp",
    });

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
    delivery.deliver(request(), effect(), INVOCATION);
    await flush();
    terminate("task-1", "error");
    expect(settled).toEqual(["failed"]);
  });
});

// ── A full two-node run through the real Pi delivery and the real host ──────
//
// THE REGRESSION THIS PINS. The completion of the first node is observed out of
// band, when no tool call is in effect, and the acceptance it triggers arms the
// SECOND node. An adapter that only knows the invocation named by the declaring
// call refuses that successor (no invoking session is in effect), the committed
// acceptance has no execution behind it, and the graph stops at `executing`
// forever. The invocation therefore travels with every delivery — recorded by
// the host per graph, not held by the adapter between calls.

describe("a declared graph runs to completion through the real Pi delivery", () => {
  it("arms the successor under the declaring invocation and reaches complete", async () => {
    const dir = makeTmpDir("pi-outcome-e2e-");
    const graph = buildDeclaredOutcomeGraph({
      declaration: naturalDeclaration(),
      completionPolicies: AUTHORIZED,
    });
    const storeRoot = join(dir, "host-store");
    persistDeclaredGraph(graph, storeRoot);

    const { port, launches, contexts, terminate } = makePiPort();
    let host: OutcomeHost | undefined;
    const completions: Array<Promise<unknown>> = [];
    const delivery = new PiOutcomeDelivery({
      manager: port,
      directory: dir,
      onSettled: (settlement) => {
        if (host === undefined || settlement.kind !== "completed") return;
        const settling = host;
        completions.push(
          settling.complete(settlement.request.graphId, settlement.request.attemptId),
        );
      },
      onStartFailed: () => {},
    });
    // The dispatch requests are the ONE channel an attempt credential travels
    // over; recording them here is what lets the assertions below say it reached
    // the worker prompts and nothing the operator can read.
    const attempts: OutcomeDispatchRequest[] = [];
    const recordingDelivery = (
      dispatched: OutcomeDispatchRequest,
      key: OutcomeDispatchEffectKey,
      invocation?: HostDispatchInvocation,
    ): void => {
      attempts.push(dispatched);
      delivery.deliver(dispatched, key, invocation);
    };
    host = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      deliver: recordingDelivery,
      validators: EMPTY_VALIDATORS,
      completionPolicies: AUTHORIZED,
      durability: "memory",
    });
    const settleCompletions = async (): Promise<void> => {
      const pending = completions.splice(0);
      await Promise.all(pending);
    };
    try {
      const started = await host.startDeclaredGraph(GRAPH_ID, INVOCATION);
      expect(started.kind).toBe("started");
      expect(launches.map((input) => input.description)).toEqual([
        GRAPH_ID + ":work#work#1",
      ]);
      await flush();

      // The platform observes the FIRST attempt finishing; the host settles it
      // and the settlement arms the successor.
      terminate("task-1", "completed");
      await settleCompletions();
      expect(launches.map((input) => input.description)).toEqual([
        GRAPH_ID + ":work#work#1",
        GRAPH_ID + ":ship#ship#2",
      ]);
      // The successor's parent is the DECLARING invocation the host recorded,
      // even though this delivery happened with no declaring call in effect.
      expect(contexts.map((context) => context.sessionID)).toEqual([
        INVOCATION.sessionId,
        INVOCATION.sessionId,
      ]);

      await flush();
      terminate("task-2", "completed");
      await settleCompletions();

      const state = scanPersistedStates(storeRoot).loaded.find(
        (candidate) => candidate.graphId === GRAPH_ID,
      );
      expect(state?.phase).toBe("complete");
      expect(state?.nodes.get("work")?.status).toBe("completed");
      expect(state?.nodes.get("ship")?.status).toBe("completed");

      // THE CREDENTIAL CROSSED THE DELIVERY CHANNEL ONLY. Each attempt was
      // issued its own credential, both reached their worker prompt, and
      // neither appears in the record the operator (or a worker with file
      // tools) can read.
      expect(attempts.map((attempt) => attempt.attemptId)).toEqual(["work#1", "ship#2"]);
      const credentials = attempts.map((attempt) => attempt.credential);
      expect(credentials[0]?.length ?? 0).toBeGreaterThan(0);
      expect(credentials[1]?.length ?? 0).toBeGreaterThan(0);
      expect(credentials[0]).not.toBe(credentials[1]);
      expect(launches[0]?.prompt ?? "").toContain(credentials[0] ?? "");
      expect(launches[1]?.prompt ?? "").toContain(credentials[1] ?? "");
      // THE STORE IS THE RECORD, and it carries no credential value either:
      // every durable byte of the workspace plus the host's store root is
      // searched for the delivered values.
      for (const credential of credentials) {
        expect(JSON.stringify(state)).not.toContain(credential);
        expect(readTextUnder(storeRoot)).not.toContain(credential);
      }
    } finally {
      host.close();
    }
  });
});
