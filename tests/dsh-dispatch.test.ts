/// <reference types="bun-types" />

/**
 * dsh dispatch path tests — the {@link DshDispatchAdapter} (`src/platform/
 * adapters/dsh/dispatch.ts`) driving the graph engine and loop mode through a
 * MOCKED dsh subagent service (no real dsh packages, no opencode SDK).
 *
 * Verifies (subtask 8 of the dsh adaptation strategy):
 *   - a single-node graph run through the dsh dispatch path dispatches to the
 *     dsh subagent seam (`SubagentRuntime.start`) with the per-role agent
 *     mapping (node.agent == provider name) and returns the node result
 *     (output materialized → graph_status include_output reads it)
 *   - a throwing `start()` escalates the node per engine semantics
 *     (dispatch failure → timeout + escalate ledger signal → escalate)
 *   - a run that settles with `stopReason: "error"` escalates the node
 *   - cancellation maps to the dsh abort surface (run.dispose) and settles
 *     the task as `cancelled`
 *   - the immediate-fire termination guard (listen-after-terminate)
 *   - the loop adapter surface (dispatchRound/getRoundResult/cancelRound/
 *     registerTerminatedListener/getTaskStatus) driven through dsh
 *   - the new dsh dispatch code stays free of @opencode-ai imports
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphToolSet } from "../src/graph/tools/graph-tools.ts";
import { DshDispatchAdapter } from "../src/platform/adapters/dsh/dispatch.ts";
import type { DshSubagentDispatchRuntime } from "../src/platform/adapters/dsh/dispatch.ts";
import type { DshSubagentResult } from "../src/platform/adapters/dsh/dispatch.ts";
import type {
  DshSubagentProvider,
  DshSubagentRun,
  DshSubagentStartRequest,
} from "../src/platform/adapters/dsh/agent-registrar.ts";

// ── Mocked dsh subagent service ─────────────────────────────────────────────

/** A controllable dsh run: the `result` promise settles via complete()/fail(). */
class FakeRun implements DshSubagentRun {
  readonly id: string;
  disposeCalls = 0;
  result: Promise<DshSubagentResult>;
  private resolveResult!: (value: DshSubagentResult) => void;
  private rejectResult!: (err: unknown) => void;

  constructor(id: string) {
    this.id = id;
    this.result = new Promise<DshSubagentResult>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
  }

  /** Settle the run like a real dsh provider finishing (never rejects). */
  complete(result: DshSubagentResult): void {
    this.resolveResult(result);
  }

  /** Reject the run's result promise (defensive path in the adapter). */
  fail(err: unknown): void {
    this.rejectResult(err);
  }

  async dispose(): Promise<void> {
    this.disposeCalls++;
  }
}

/**
 * Fake `SubagentRuntime` (`ctx.subagents`) recording start requests and
 * yielding controllable runs. Per-agent behavior:
 *   - `autoComplete.get(agent)` — start returns a run that completes on a
 *     microtask with the given result (normal graph flow).
 *   - `autoError.get(agent)` — start REJECTS with the message (dispatch
 *     failure → engine escalate).
 *   - otherwise — start returns a run that stays pending until the test calls
 *     `completeRun(runId, result)`.
 */
class FakeSubagentService implements DshSubagentDispatchRuntime {
  readonly providers = new Map<string, DshSubagentProvider>();
  readonly started: Array<{ name: string; request: DshSubagentStartRequest }> = [];
  readonly runs = new Map<string, FakeRun>();
  readonly autoComplete = new Map<string, DshSubagentResult>();
  readonly autoError = new Map<string, string>();
  private seq = 0;

  registerProvider(provider: DshSubagentProvider): () => void {
    this.providers.set(provider.name, provider);
    return () => {
      this.providers.delete(provider.name);
    };
  }

  getProvider(name: string): DshSubagentProvider | undefined {
    return this.providers.get(name);
  }

  list(): string[] {
    return [...this.providers.keys()];
  }

  async start(name: string, request: DshSubagentStartRequest): Promise<DshSubagentRun> {
    this.started.push({ name, request });
    const rejectMsg = this.autoError.get(name);
    if (rejectMsg) throw new Error(rejectMsg);
    const id = `dsh-run-${++this.seq}`;
    const run = new FakeRun(id);
    this.runs.set(id, run);
    const auto = this.autoComplete.get(name);
    if (auto) {
      setTimeout(() => run.complete(auto), 0);
    }
    return run;
  }

  /** Manually settle a specific run (for controllable tests). */
  completeRun(runId: string, result: DshSubagentResult): void {
    this.runs.get(runId)?.complete(result);
  }

  /** Register a provider for an agent so the adapter's mapping guard passes. */
  seedProvider(name: string): void {
    this.providers.set(name, {
      name,
      capabilities: {},
      inheritsParentContext: false,
      start: async () => {
        throw new Error("fake provider.start not used — SubagentRuntime.start is mocked");
      },
    });
  }
}

/** Settle the engine's microtask/timer-driven advancement. */
const settle = () => new Promise((r) => setTimeout(r, 30));

const outputBlock = (text: string) => [{ type: "text", text }];

/** Parse a graph_status JSON render into a typed record. */
function statusJson<T>(ts: GraphToolSet, args: Record<string, unknown>): T {
  return JSON.parse(ts.graph_status(args as never)) as T;
}

interface NodeSummary {
  node_id: string;
  status: string;
  /** `error` mirrors `NodeRuntimeState.errorReason` in the JSON render. */
  error?: string;
  output?: string;
}

interface GraphJson {
  phase: string;
  nodes: NodeSummary[];
}

// ── Shared setup ────────────────────────────────────────────────────────────

let tmpDir: string;
let service: FakeSubagentService;
let dispatch: DshDispatchAdapter;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "rolebox-dsh-dispatch-"));
  service = new FakeSubagentService();
  dispatch = new DshDispatchAdapter({
    subagents: service,
    directory: tmpDir,
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function toolset(): GraphToolSet {
  return new GraphToolSet({ dispatch, directory: tmpDir });
}

/** Run a single-node graph to completion and return its status JSON. */
async function runSingleNode(
  agent: string,
  opts?: { id?: string; prompt?: string },
): Promise<GraphJson> {
  const ts = toolset();
  const g = ts.graph_create({ name: "dsh-graph" });
  ts.graph_add_node({
    graph_id: g.graph_id,
    id: opts?.id ?? "N1",
    agent,
    prompt: opts?.prompt ?? "execute this node",
  });
  await ts.graph_run({ graph_id: g.graph_id });
  await settle();
  return statusJson<GraphJson>(ts, { graph_id: g.graph_id, format: "json" });
}

// ── Graph engine through the dsh dispatch path ──────────────────────────────

describe("graph engine dispatch through the dsh subagent seam", () => {
  it("dispatches a single node to the registered provider and returns its result", async () => {
    service.seedProvider("emperor--jinyiwei--backend");
    service.autoComplete.set("emperor--jinyiwei--backend", {
      stopReason: "completed",
      output: outputBlock("dsh worker finished the node"),
    });

    const ts = toolset();
    const g = ts.graph_create({ name: "dsh-graph" });
    ts.graph_add_node({
      graph_id: g.graph_id,
      id: "N1",
      agent: "emperor--jinyiwei--backend",
      prompt: "execute this node",
    });
    await ts.graph_run({ graph_id: g.graph_id });
    await settle();

    // The dsh subagent seam was hit exactly once, with the per-role mapping
    // (node.agent === provider name) and the node's prompt as text content.
    expect(service.started).toHaveLength(1);
    expect(service.started[0].name).toBe("emperor--jinyiwei--backend");
    expect(service.started[0].request.prompt).toEqual([
      { type: "text", text: "execute this node" },
    ]);
    expect(service.started[0].request.signal).toBeInstanceOf(AbortSignal);

    // The node completed and its output is readable through graph_status.
    const graph = statusJson<GraphJson>(ts, { graph_id: g.graph_id, format: "json" });
    const node = graph.nodes.find((n) => n.node_id === "N1");
    expect(node?.status).toBe("completed");
    expect(graph.phase).toBe("complete");

    const withOutput = statusJson<Record<string, unknown>>(ts, {
      graph_id: g.graph_id,
      node_id: "N1",
      format: "json",
      include_output: true,
    });
    expect(String(withOutput.output ?? "")).toContain("dsh worker finished the node");
  });

  it("does not dispatch when the agent has no registered provider (fails fast)", async () => {
    // No seedProvider("ghost") — the mapping guard must reject.
    const graph = await runSingleNode("ghost");
    // A dispatch failure is contained by the engine: the node is timed out
    // with an escalate ledger signal, and the graph reaches a terminal phase
    // (never hangs). No run was ever started on the dsh seam.
    expect(graph.nodes.find((n) => n.node_id === "N1")?.status).toBe("timeout");
    expect(graph.phase).toBe("complete");
    expect(service.started).toHaveLength(0);
  });

  it("escalates the node when the subagent start throws (dispatch failure)", async () => {
    service.seedProvider("thrower");
    service.autoError.set("thrower", "provider refused to spawn");
    const graph = await runSingleNode("thrower");
    // Engine semantics for a throwing execute (engine-advance.ts
    // `_dispatchNode` catch): mark the node `timeout` + record an `escalate`
    // ledger signal so downstream joins fail fast. The node is terminal and
    // the graph reaches `complete` (never hangs).
    const node = graph.nodes.find((n) => n.node_id === "N1");
    expect(node?.status).toBe("timeout");
    expect(node?.error).toContain("provider refused to spawn");
    expect(graph.phase).toBe("complete");
  });

  it("escalates the node when the run settles with stopReason 'error'", async () => {
    service.seedProvider("err-run");
    service.autoComplete.set("err-run", {
      stopReason: "error",
      output: outputBlock("child agent exploded"),
    });
    const graph = await runSingleNode("err-run");
    const node = graph.nodes.find((n) => n.node_id === "N1");
    expect(node?.status).toBe("escalate");
    expect(node?.error).toContain("child agent exploded");
  });

  it("maps a run that settles with stopReason 'max-tokens' to an escalated node", async () => {
    service.seedProvider("long-run");
    service.autoComplete.set("long-run", { stopReason: "max-tokens", output: [] });
    const graph = await runSingleNode("long-run");
    expect(graph.nodes.find((n) => n.node_id === "N1")?.status).toBe("escalate");
  });

  it("maps cancellation to the dsh abort surface (run.dispose) and settles cancelled", async () => {
    service.seedProvider("slow");
    const graph = await runSingleNode("slow");
    // The run never settles on its own (no autoComplete) — still running.
    expect(graph.nodes.find((n) => n.node_id === "N1")?.status).toBe("running");

    expect(service.runs.size).toBe(1);
    const runId = [...service.runs.keys()][0];
    const cancelled = await dispatch.cancelTask(runId);
    expect(cancelled).toBe(true);
    await settle();

    // The dsh run's dispose() (the abort surface) was called.
    expect(service.runs.get(runId)?.disposeCalls).toBeGreaterThanOrEqual(1);
    expect(await dispatch.getTaskStatus(runId)).toBe("cancelled");
  });

  it("fires an already-terminal task's listener via microtask (immediate-fire guard)", async () => {
    service.seedProvider("fast");
    service.autoComplete.set("fast", {
      stopReason: "completed",
      output: outputBlock("done early"),
    });
    const { workerTaskId } = await dispatch.dispatchRound({
      originSessionId: "origin-1",
      agent: "fast",
      prompt: "round",
    });
    await settle();

    // Task already completed — a listener registered now must still fire.
    let fired: string | undefined;
    dispatch.registerTerminatedListener(workerTaskId, (tid, status) => {
      fired = `${tid}:${status}`;
    });
    await settle();
    expect(fired).toBe(`${workerTaskId}:completed`);
  });
});

// ── Loop mode through the dsh dispatch path ─────────────────────────────────

describe("loop mode dispatch through the dsh subagent seam", () => {
  it("dispatchRound starts a dsh run and getRoundResult returns its output", async () => {
    service.seedProvider("worker-agent");
    const { workerTaskId, workerSessionId } = await dispatch.dispatchRound({
      originSessionId: "origin-123",
      agent: "worker-agent",
      prompt: "do the round",
      description: "round 1",
    });

    expect(workerTaskId).toMatch(/^dsh-run-/);
    expect(workerSessionId).toBe(workerTaskId);
    expect(service.started).toHaveLength(1);
    expect(service.started[0].name).toBe("worker-agent");
    expect(service.started[0].request.prompt).toEqual([
      { type: "text", text: "do the round" },
    ]);

    service.completeRun(workerTaskId, {
      stopReason: "completed",
      output: outputBlock("round output text"),
    });
    const result = await dispatch.getRoundResult(workerTaskId);
    expect(result.hadError).toBe(false);
    expect(result.text).toBe("round output text");
  });

  it("getRoundResult reports the error reason for an errored round", async () => {
    service.seedProvider("worker-agent");
    const { workerTaskId } = await dispatch.dispatchRound({
      originSessionId: "origin-1",
      agent: "worker-agent",
      prompt: "p",
    });
    service.completeRun(workerTaskId, {
      stopReason: "error",
      output: outputBlock("round failed hard"),
    });
    const result = await dispatch.getRoundResult(workerTaskId);
    expect(result.hadError).toBe(true);
    expect(result.errorReason).toBe("round failed hard");
  });

  it("registerTerminatedListener fires when the round's run settles", async () => {
    service.seedProvider("worker-agent");
    const { workerTaskId } = await dispatch.dispatchRound({
      originSessionId: "origin-1",
      agent: "worker-agent",
      prompt: "p",
    });
    let fired: string | undefined;
    dispatch.registerTerminatedListener(workerTaskId, (tid, status) => {
      fired = `${tid}:${status}`;
    });
    service.completeRun(workerTaskId, {
      stopReason: "completed",
      output: outputBlock("ok"),
    });
    await settle();
    expect(fired).toBe(`${workerTaskId}:completed`);
    expect(await dispatch.getTaskStatus(workerTaskId)).toBe("completed");
  });

  it("cancelRound cancels a running round via the dsh abort surface", async () => {
    service.seedProvider("worker-agent");
    const { workerTaskId } = await dispatch.dispatchRound({
      originSessionId: "origin-1",
      agent: "worker-agent",
      prompt: "p",
    });
    await dispatch.cancelRound(workerTaskId);
    expect(service.runs.get(workerTaskId)?.disposeCalls).toBeGreaterThanOrEqual(1);
    expect(await dispatch.getTaskStatus(workerTaskId)).toBe("cancelled");
    const result = await dispatch.getRoundResult(workerTaskId);
    expect(result.hadError).toBe(true);
  });

  it("readOriginSummary / getLastMessageId degrade when no session client is wired", async () => {
    expect(await dispatch.readOriginSummary("origin-1")).toBe("");
    expect(await dispatch.getLastMessageId("origin-1")).toBeUndefined();
    await dispatch.injectNote("origin-1", "silent note"); // no-op, must not throw
  });

  it("enforces a per-run timeout via the abort timer (dsh has no native timeout)", async () => {
    service.seedProvider("stall");
    const { workerTaskId } = await dispatch.dispatchRound({
      originSessionId: "origin-1",
      agent: "stall",
      prompt: "p",
      timeoutMs: 20,
    });
    // The run never settles on its own — the adapter's timer must force it.
    await new Promise((r) => setTimeout(r, 60));
    expect(await dispatch.getTaskStatus(workerTaskId)).toBe("timeout");
  });
});

// ── Import hygiene ──────────────────────────────────────────────────────────

describe("dsh dispatch code import hygiene", () => {
  it("contains no @opencode-ai or @deepseek-ai imports", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/platform/adapters/dsh/dispatch.ts"),
      "utf-8",
    );
    expect(source.includes("@opencode-ai")).toBe(false);
    expect(source.includes("@deepseek-ai/")).toBe(false);
  });
});
