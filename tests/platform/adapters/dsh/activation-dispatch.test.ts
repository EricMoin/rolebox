import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshDispatchAdapter, type DshSubagentDispatchRuntime } from "../../../../src/platform/adapters/dsh/dispatch.ts";
import { DshOutcomeDelivery } from "../../../../src/platform/adapters/dsh/outcome-dispatch.ts";
import type { DshSubagentStartRequest } from "../../../../src/platform/adapters/dsh/agent-registrar.ts";
import type { OutcomeDispatchRequest } from "../../../../src/graph/outcome/dispatch-effects.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.each(["flat", "nested"] as const)("DSH %s activation task options", (layout) => {
  function fixture() {
    const parent = { id: "activation-parent" };
    const starts: DshSubagentStartRequest[] = [];
    const subagents: DshSubagentDispatchRuntime = {
      registerProvider: () => () => {},
      getProvider: () => ({
        name: "worker", inheritsParentContext: false,
        capabilities: { agentOptions: true, agentPreset: false, outputSchema: false, depthLimit: true },
        prepareContinuable: async () => ({}),
      }),
      list: () => ["worker"],
      async startActivation(spec) {
        const request = layout === "nested" ? spec.request : spec;
        expect(request.parent).toBe(parent);
        expect(request.prompt.length).toBeGreaterThan(0);
        expect(request.agentOptions).toEqual({ provider: "example-provider", model: "example-model" });
        expect(request.maxDepth).toBe(3);
        starts.push({ ...request, label: spec.label, signal: spec.signal });
        return {
          childId: "activation-child",
          result: Promise.resolve({
            stopReason: "completed" as const,
            output: [{ type: "text", text: "Worker completed." }],
          }),
          dispose: async () => {},
        };
      },
    };
    const composeRequest = (_agent: string, request: DshSubagentStartRequest): DshSubagentStartRequest => ({
      ...request,
      prompt: [{ type: "text", text: "Worker guidance." }, ...request.prompt],
      agentOptions: { provider: "example-provider", model: "example-model" },
      maxDepth: 3,
    });
    return { subagents, starts, composeRequest, parentResolver: () => parent };
  }

  it("starts a graph worker once and observes its completion", async () => {
    const host = fixture();
    const onStarted = vi.fn();
    const onStartFailed = vi.fn();
    const onSettled = vi.fn();
    const delivery = new DshOutcomeDelivery({ ...host, onStarted, onStartFailed, onSettled });
    const request: OutcomeDispatchRequest = {
      graphId: "activation-graph", planRevision: "1", nodeId: "work", attemptId: "work#1",
      agent: "worker", prompt: "Complete the assigned work.", credential: "fixture-credential",
      outcomes: [{ id: "done", acceptance: [] }],
    };
    const effect = { graphId: request.graphId, attemptId: request.attemptId, effectId: "dispatch:work#1" };
    try {
      delivery.deliver(request, effect, { sessionId: "activation-parent" });
      await vi.waitFor(() => expect(onSettled).toHaveBeenCalledWith({ kind: "completed", request }));
      expect(onStartFailed).not.toHaveBeenCalled();
      expect(onStarted).toHaveBeenCalledExactlyOnceWith(request, effect, { executionId: "activation-child" });
      expect(host.starts).toHaveLength(1);
      expect(host.starts[0]!.label).toBe("activation-graph/dispatch:work#1");
      expect(JSON.stringify(host.starts[0]!.prompt)).toContain("Complete the assigned work.");
    } finally {
      delivery.close();
    }
  });

  it("starts a loop round once and returns the worker output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rolebox-activation-"));
    directories.push(directory);
    const host = fixture();
    const dispatch = new DshDispatchAdapter({ ...host, directory });
    const task = await dispatch.dispatchRound({
      originSessionId: "activation-parent", agent: "worker", prompt: "Complete the round.", description: "Round 1",
    });
    expect(await dispatch.getRoundResult(task.workerTaskId)).toEqual({ text: "Worker completed.", hadError: false });
    expect(host.starts).toHaveLength(1);
    expect(host.starts[0]!.label).toBe("Round 1");
    expect(host.starts[0]!.prompt).toEqual([
      { type: "text", text: "Worker guidance." },
      { type: "text", text: "Complete the round." },
    ]);
  });
});
