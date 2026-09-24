import { describe, expect, it } from "bun:test";
import { installDshGraphWorkerBoundary, type DshGraphWorkerRegistry } from "../../../../src/platform/adapters/dsh/graph-worker.ts";

describe("DSH graph worker presentation", () => {
  it("selects native tools at creation before the first assembly, without affecting unrelated agents", async () => {
    const listeners = new Map<string, (...args: unknown[]) => unknown>();
    let guard: Parameters<NonNullable<DshGraphWorkerRegistry["guard"]>>[0] | undefined;
    let restored = 0;
    const boundary = installDshGraphWorkerBoundary({ workerPrincipalOf: () => undefined }, {
      guard: callback => { guard = callback; return () => { guard = undefined; }; },
    }, (event, listener) => {
      listeners.set(event, listener);
      return () => { listeners.delete(event); };
    });
    const agent = (id: string) => {
      const modes: string[] = [];
      return { id, session: { id, events: [] }, modes,
        ctx: { tools: { presentAs: (mode: "native") => {
          modes.push(mode);
          return () => { restored++; };
        } } } };
    };
    const unrelated = agent("unrelated");
    const worker = agent("worker");
    const started = boundary.start("attempt-label", async () => {
      await Promise.resolve();
      await listeners.get("agent/created")!({ agent: worker });
      expect(worker.modes).toEqual(["native"]);
      expect(guard!({ name: "run_code", agent: worker })).toContain("Graph workers may only");
      expect(guard!({ name: "graph_worker_exec", agent: worker })).toBeUndefined();
      expect(guard!({ name: "graph_submit_outcome", agent: worker })).toBeUndefined();
      await listeners.get("agent/pre-step")!({ agent: worker }, async () => ({ kind: "enter" }));
      expect(worker.modes).toEqual(["native"]);
    });
    await listeners.get("agent/created")!({ agent: unrelated });
    expect(unrelated.modes).toEqual([]);
    expect(guard!({ name: "run_code", agent: unrelated })).toBeUndefined();
    await started;
    boundary.dispose();
    expect(restored).toBe(1);
    expect(listeners.size).toBe(0);
    expect(guard).toBeUndefined();
  });

  it("refuses a start without an execution guard", async () => {
    const boundary = installDshGraphWorkerBoundary({ workerPrincipalOf: () => undefined }, {}, () => undefined);
    let started = false;
    await expect(boundary.start("attempt", async () => { started = true; })).rejects.toThrow("execution guard");
    expect(started).toBe(false);
    boundary.dispose();
  });
});
