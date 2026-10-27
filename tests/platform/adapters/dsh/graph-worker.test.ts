import { describe, expect, it } from "vitest";
import { installDshGraphWorkerBoundary, type DshGraphWorkerRegistry } from "../../../../src/platform/adapters/dsh/graph-worker.ts";
import type { DshSystemPromptSection } from "../../../../src/platform/adapters/dsh/system-prompt.ts";

function promptAgent(id: string) {
  const sections = new Map<string, DshSystemPromptSection>();
  const registrations: DshSystemPromptSection[] = [];
  const modes: string[] = [];
  let disposed = 0;
  return {
    id, session: { id, events: [] }, sections, registrations, modes,
    disposed: () => disposed,
    ctx: {
      systemPrompt: { section: (entry: DshSystemPromptSection) => {
        if (sections.has(entry.name)) throw new Error(`Duplicate section: ${entry.name}`);
        sections.set(entry.name, entry);
        registrations.push(entry);
        return () => { if (sections.delete(entry.name)) disposed++; };
      } },
      tools: { presentAs: (mode: "native") => { modes.push(mode); return () => {}; } },
    },
  };
}

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
      expect(guard!({ name: "run_code", agent: worker })).toBeUndefined();
      expect(guard!({ name: "bash", agent: worker })).toBeUndefined();
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

  it("admits a worker on a host without the per-scope presentation switch", async () => {
    // dsh's scoped tool-executor model dropped `ctx.tools.presentAs`; the
    // worker's scope inherits the nearest executor selection instead. Starting
    // a worker must therefore not require the switch — only the scoped tool
    // registry it hangs off.
    const listeners = new Map<string, (...args: unknown[]) => unknown>();
    let guard: Parameters<NonNullable<DshGraphWorkerRegistry["guard"]>>[0] | undefined;
    const boundary = installDshGraphWorkerBoundary({ workerPrincipalOf: () => undefined }, {
      guard: callback => {
        guard = callback;
        return () => { guard = undefined; };
      },
    }, (event, listener) => {
      listeners.set(event, listener);
      return () => { listeners.delete(event); };
    });
    const worker = { id: "worker", session: { id: "worker", events: [] }, ctx: { tools: {} } };
    await boundary.start("attempt-label", async () => {
      await listeners.get("agent/created")!({ agent: worker });
      expect(guard!({ name: "run_code", agent: worker })).toBeUndefined();
      expect(guard!({ name: "bash", agent: worker })).toBeUndefined();
    });
    expect(boundary.isWorker({ id: "worker" })).toBe(true);
    boundary.dispose();
  });

  it("still refuses a worker with no scoped tool registry at all", async () => {
    const listeners = new Map<string, (...args: unknown[]) => unknown>();
    const boundary = installDshGraphWorkerBoundary({ workerPrincipalOf: () => undefined }, {
      guard: () => () => {},
    }, (event, listener) => {
      listeners.set(event, listener);
      return () => { listeners.delete(event); };
    });
    const worker = { id: "worker", session: { id: "worker", events: [] } };
    await expect(boundary.start("attempt-label", async () => {
      await listeners.get("agent/created")!({ agent: worker });
    })).rejects.toThrow("scoped tool registry");
    boundary.dispose();
  });

  it("refuses a start without an execution guard", async () => {
    const boundary = installDshGraphWorkerBoundary({ workerPrincipalOf: () => undefined }, {}, () => undefined);
    let started = false;
    await expect(boundary.start("attempt", async () => { started = true; })).rejects.toThrow("execution guard");
    expect(started).toBe(false);
    boundary.dispose();
  });

  it("registers each concurrent worker's role once in its own scope and leaves the parent alone", async () => {
    const listeners = new Map<string, (...args: unknown[]) => unknown>();
    const boundary = installDshGraphWorkerBoundary({ workerPrincipalOf: () => undefined }, {
      guard: () => () => {},
    }, (event, listener) => {
      listeners.set(event, listener);
      return () => { listeners.delete(event); };
    }, undefined, (_agent, startup) => `Role ${startup.agent}: preserve {{literal}}`);
    const first = promptAgent("first-worker");
    const second = promptAgent("second-worker");
    const parent = promptAgent("parent");
    parent.ctx.systemPrompt.section({ name: "rolebox:role", order: 50, text: () => "Parent role" });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });

    const firstStart = boundary.start("first-label", async () => {
      await blocked;
      await listeners.get("agent/created")!({ agent: first });
    }, { agent: "first-role" });
    await boundary.start("second-label", async () => {
      await listeners.get("agent/created")!({ agent: second });
    }, { agent: "second-role" });
    release();
    await firstStart;

    expect(first.modes).toEqual(["native"]);
    expect(second.modes).toEqual(["native"]);
    expect(first.sections.get("rolebox:role")?.text({})).toBe("Role first-role: preserve {{literal}}");
    expect(second.sections.get("rolebox:role")?.text({})).toBe("Role second-role: preserve {{literal}}");
    for (const worker of [first, second]) {
      expect(worker.sections.get("rolebox:role")).toMatchObject({ order: 50, interpolate: false });
      await listeners.get("agent/pre-step")!({ agent: worker }, async () => ({ kind: "enter" }));
      await listeners.get("agent/pre-step")!({ agent: worker }, async () => ({ kind: "enter" }));
      boundary.prepare(worker);
      expect(worker.registrations).toHaveLength(1);
    }
    await listeners.get("agent/created")!({ agent: parent });
    expect(parent.modes).toEqual([]);
    expect(parent.sections.get("rolebox:role")?.text({})).toBe("Parent role");
    boundary.dispose();
    expect(first.sections.size).toBe(0);
    expect(second.sections.size).toBe(0);
    expect(first.disposed()).toBe(1);
    expect(second.disposed()).toBe(1);
    expect(parent.disposed()).toBe(0);
    expect(parent.sections.get("rolebox:role")?.text({})).toBe("Parent role");
  });

  it("recovers a delayed child's scoped role from its start descriptor", async () => {
    const listeners = new Map<string, (...args: unknown[]) => unknown>();
    const boundary = installDshGraphWorkerBoundary({ workerPrincipalOf: () => undefined }, {
      guard: () => () => {},
    }, (event, listener) => { listeners.set(event, listener); }, undefined,
    (_agent, startup) => `Delayed ${startup.agent}`);
    const worker = { ...promptAgent("delayed-worker"), session: {
      id: "delayed-worker", snapshotEvents: () => [
        { type: "subagent/descriptor", data: { label: "delayed-attempt", provider: "delayed-role" } },
      ],
    } };
    try {
      await boundary.start("delayed-attempt", async () => {}, { agent: "delayed-role" });
      await listeners.get("agent/created")!({ agent: worker });
      boundary.prepare(worker);
      expect(worker.registrations).toHaveLength(1);
      expect(worker.sections.get("rolebox:role")?.text({})).toBe("Delayed delayed-role");
    } finally { boundary.dispose(); }
  });

  it("prepares an authenticated restored worker without an in-memory start", () => {
    const worker = promptAgent("restored-worker");
    const boundary = installDshGraphWorkerBoundary({ workerPrincipalOf: sessionId => sessionId === worker.id
      ? { graphId: "graph", attemptId: "attempt", executionId: worker.id, workerSessionId: worker.id } : undefined,
    }, { guard: () => () => {} }, () => undefined, undefined, agent => {
      expect(agent).toBe(worker);
      return "Restored role";
    });
    try {
      boundary.prepare(worker);
      boundary.prepare(worker);
      expect(worker.registrations).toHaveLength(1);
      expect(worker.sections.get("rolebox:role")?.text({})).toBe("Restored role");
    } finally { boundary.dispose(); }
    expect(worker.sections.size).toBe(0);
  });

  it("refuses role injection without an agent-scoped system-prompt registry", async () => {
    let resolvedRole = false;
    const boundary = installDshGraphWorkerBoundary({ workerPrincipalOf: () => undefined }, {
      guard: () => () => {},
    }, () => undefined, undefined, () => { resolvedRole = true; return "Worker role"; });
    const worker = { id: "worker", ctx: { tools: {} } };
    try {
      await expect(boundary.start("attempt", async () => {
        boundary.prepare(worker, true);
      })).rejects.toThrow("agent-scoped system-prompt registry");
      expect(resolvedRole).toBe(false);
      expect(boundary.isWorker(worker)).toBe(false);
    } finally { boundary.dispose(); }
  });

  it("rolls back the scoped role when tool preparation fails and permits a clean retry", async () => {
    const boundary = installDshGraphWorkerBoundary({ workerPrincipalOf: () => undefined }, {
      guard: () => () => {},
    }, () => undefined, undefined, () => "Worker role");
    const worker = promptAgent("worker");
    let failTools = true;
    const presentAs = worker.ctx.tools.presentAs;
    worker.ctx.tools.presentAs = mode => {
      if (failTools) throw new Error("Tool setup failed");
      return presentAs(mode);
    };
    try {
      await expect(boundary.start("attempt", async () => {
        boundary.prepare(worker, true);
      })).rejects.toThrow("Tool setup failed");
      expect(worker.sections.size).toBe(0);
      expect(worker.disposed()).toBe(1);
      expect(boundary.isWorker(worker)).toBe(false);
      failTools = false;
      await boundary.start("retry-attempt", async () => { boundary.prepare(worker, true); });
      expect(worker.sections.get("rolebox:role")?.text({})).toBe("Worker role");
      expect(worker.registrations).toHaveLength(2);
    } finally { boundary.dispose(); }
    expect(worker.sections.size).toBe(0);
    expect(worker.disposed()).toBe(2);
  });
});
