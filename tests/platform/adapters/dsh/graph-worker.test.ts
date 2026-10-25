import { describe, expect, it } from "vitest";
import { installDshGraphWorkerBoundary, type DshGraphWorkerRegistry } from "../../../../src/platform/adapters/dsh/graph-worker.ts";

describe("DSH graph worker presentation", () => {
  it("recognizes restored worker descriptors from SDK session snapshots", async () => {
    let guard: Parameters<NonNullable<DshGraphWorkerRegistry["guard"]>>[0] | undefined;
    const boundary = installDshGraphWorkerBoundary({ workerPrincipalOf: () => undefined }, {
      guard: callback => { guard = callback; return () => {}; },
    }, () => undefined);
    try {
      await boundary.start("restored-attempt", async () => {});
      const agent = { session: { id: "restored-worker", snapshotEvents: () => [
        { type: "subagent/descriptor", data: { label: "restored-attempt" } },
      ] } };
      expect(boundary.isWorker(agent)).toBe(true);
      expect(guard!({ name: "team_create", agent })).toContain("Graph workers may only");
    } finally { boundary.dispose(); }
  });

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
      expect(boundary.isWorker({ id: "worker" })).toBe(true);
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

  // The start scope no longer carries a prepared prompt (the worker's complete
  // prompt is composed at the call site by
  // `DshAgentRegistrar.composeSpawnRequest`, because dsh 0.2.x runs a provider
  // with `prepareContinuable` on the LOCAL activation path and never calls its
  // `start()`). Its remaining job is ADMISSION: an `agent/created` observed
  // inside a start scope is marked as a worker before its first assembly, and
  // concurrent starts stay independent.
  it("admits each concurrent start's own child and leaves agents created outside every start alone", async () => {
    const listeners = new Map<string, (...args: unknown[]) => unknown>();
    const boundary = installDshGraphWorkerBoundary({ workerPrincipalOf: () => undefined }, {
      guard: () => () => {},
    }, (event, listener) => {
      listeners.set(event, listener);
      return () => { listeners.delete(event); };
    });
    const agent = (id: string) => {
      const modes: string[] = [];
      return { id, session: { id, events: [] }, modes,
        ctx: { tools: { presentAs: (mode: "native") => { modes.push(mode); return () => {}; } } } };
    };
    const first = agent("first-worker");
    const second = agent("second-worker");
    const outside = agent("outside");
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });

    const firstStart = boundary.start("first-label", async () => {
      await blocked;
      await listeners.get("agent/created")!({ agent: first });
    });
    await boundary.start("second-label", async () => {
      await listeners.get("agent/created")!({ agent: second });
    });
    release();
    await firstStart;

    expect(first.modes).toEqual(["native"]);
    expect(second.modes).toEqual(["native"]);
    // No start scope is active here, and this agent has no worker descriptor or
    // principal, so admission must not leak onto it.
    await listeners.get("agent/created")!({ agent: outside });
    expect(outside.modes).toEqual([]);
    boundary.dispose();
  });
});
