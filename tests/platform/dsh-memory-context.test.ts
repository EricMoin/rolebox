import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/memory/store.ts";
import { MEMORY_TOOL_NAMES } from "../../src/memory/tool-policy.ts";
import { createContextAssembleTool } from "../../src/dispatch/query/context-assemble.ts";
import type { DispatchManager } from "../../src/dispatch/core/manager.ts";
import type { ISessionClient } from "../../src/platform/ports/session-client.ts";
import {
  createMemoryListTool, createMemoryReadTool, createMemoryRecallTool,
  createMemoryUpdateTool, createMemoryWriteTool,
} from "../../src/memory/tools.ts";
import { createDshMemoryContext, type DshMemoryAgent, type DshMemoryOptions } from "../../src/platform/adapters/dsh/memory-context.ts";
import { DshToolFactory, type DshToolDefinition } from "../../src/platform/adapters/dsh/tool-factory.ts";
import { DshSystemPromptAdapter, type DshSystemPromptContextEntry } from "../../src/platform/adapters/dsh/system-prompt.ts";
import { DshAgentRegistrar } from "../../src/platform/adapters/dsh/agent-registrar.ts";
import { createActiveRoleRef } from "../../src/platform/adapters/dsh/role-switcher.ts";
import { installDshGraphWorkerBoundary, type DshWorkerStartupTools } from "../../src/platform/adapters/dsh/graph-worker.ts";
import type { ResolvedRole, ResolvedSubAgent } from "../../src/types.ts";

function role(id: string): ResolvedRole {
  return { id, config: { name: id, description: id, prompt: id }, prompt: id,
    skills: [], functions: [], references: [], subagents: [] };
}

function output(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "output" in value) return String(value.output);
  throw new Error("Expected a compiled tool text result");
}

describe("DSH memory prompt and execution integration", () => {
  let root: string;
  const dispose: Array<() => void> = [];

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "rolebox-dsh-memory-")); });
  afterEach(() => {
    for (const cleanup of dispose.splice(0).reverse()) cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  function fixture(prefix = "", workspace?: DshMemoryOptions["workspace"]) {
    const first = role("role-a");
    const second = role("role-b");
    const parent = role("parent");
    const worker: ResolvedSubAgent = { ...role("parent--worker"), parentId: "parent", inheritedFrom: {} };
    parent.subagents.push(worker);
    const roles = [first, second, parent];
    const active = createActiveRoleRef();
    const sessions = new Map<string, NonNullable<DshMemoryAgent["session"]>>();
    const names = new Map<string, string>(MEMORY_TOOL_NAMES.map(name => [name, `${prefix}${name}`]));
    const registered: Record<string, DshToolDefinition> = {};
    const listeners = new Map<string, (...args: unknown[]) => unknown>();
    let boundary: ReturnType<typeof installDshGraphWorkerBoundary>;
    const memory = createDshMemoryContext({
      roles: () => roles, activeRole: sessionId => active.get(sessionId), session: id => sessions.get(id),
      workspace,
      tools: () => Object.keys(registered), names: () => names,
      worker: agent => boundary?.isWorker(agent)
        ? { ...boundary.toolGrantOf(agent), agent: boundary.roleOf(agent) } : undefined,
    });
    const factory = new DshToolFactory({ memoryContext: (exec, name) => memory.forTool(exec.agent ?? {}, name) });
    const compiled = factory.compileAll({
      memory_write: createMemoryWriteTool(), memory_recall: createMemoryRecallTool(), memory_read: createMemoryReadTool(),
      memory_list: createMemoryListTool(), memory_update: createMemoryUpdateTool(),
      context_assemble: createContextAssembleTool({ dispatchManager: {} as DispatchManager,
        sessionClient: {} as ISessionClient, resolvedRoles: roles, directory: root }),
    }) as Record<string, DshToolDefinition>;
    for (const [name, definition] of Object.entries(compiled)) {
      registered[`${prefix}${name}`] = { ...definition, name: `${prefix}${name}` };
    }
    boundary = installDshGraphWorkerBoundary({ workerPrincipalOf: () => undefined }, {
      guard: () => () => {}, schemas: () => Object.values(registered),
      get: name => registered[name],
      execute: async execution => {
        const value = await registered[execution.name].execute(execution.arguments, {
          agent: execution.agent, signal: new AbortController().signal, callId: "gateway-call",
          deferContext: () => {}, concludeTurn: () => {},
        });
        return { value };
      },
    }, (event, listener) => {
      listeners.set(event, listener);
      return () => { listeners.delete(event); };
    });
    dispose.push(() => boundary.dispose());

    function agent(id = "session-a", directory: string | undefined = root) {
      const session = { id, header: { cwd: directory }, events: [] as Array<{ type: string; data?: unknown }>, inheritedEventCount: 0 };
      sessions.set(id, session);
      return { id, session, ctx: { tools: {
        presentAs: () => () => {},
        register: (_definition: DshToolDefinition) => () => {},
      } } };
    }
    async function call(name: string, args: Record<string, unknown>, caller: DshMemoryAgent) {
      return output(await registered[`${prefix}${name}`].execute(args, {
        agent: caller, signal: new AbortController().signal, callId: "memory-call",
        deferContext: () => {}, concludeTurn: () => {},
      }));
    }
    async function start(caller: ReturnType<typeof agent>, grant: DshWorkerStartupTools) {
      await boundary.start("worker-label", async () => {
        await listeners.get("agent/created")?.({ agent: caller });
      }, grant);
    }
    return { first, second, parent, worker, active, sessions, memory, registered, names, agent, call, start };
  }

  it("renders workflow in an empty store and refreshes the registry provider immediately after writing", async () => {
    const f = fixture();
    const agent = f.agent();
    f.active.set(agent.id, "role-a");
    const contexts = new Map<string, DshSystemPromptContextEntry>();
    const adapter = new DshSystemPromptAdapter({
      registrar: new DshAgentRegistrar({ subagents: { registerProvider: () => () => {}, getProvider: () => undefined, list: () => [] } }),
      activeRole: f.active, roleFunctionsMap: new Map(), directory: root,
      memoryContext: context => f.memory.render(context.agent ?? {}),
    });
    adapter.register({ section: () => () => {}, context: entry => {
      contexts.set(entry.name, entry); return () => { contexts.delete(entry.name); };
    } });
    dispose.push(() => adapter.dispose());
    const provider = contexts.get("rolebox:memory")!;
    expect(provider.interpolate).toBe(false);
    expect(provider.text({ agent })).toContain("## Memory workflow");
    expect(provider.text({ agent })).not.toContain("Durable finding");
    expect(await f.call("memory_write", { title: "Durable finding", content: "Verified decision" }, agent)).toContain("Memory written");
    expect(provider.text({ agent })).toContain("Durable finding");
    const rows = JSON.parse(await f.call("memory_list", { format: "json" }, agent));
    expect(rows[0]).toMatchObject({ role_id: "role-a", source_sessions: ["session-a"] });
  });

  it("applies role switches consistently to tools and rendered summaries", async () => {
    const f = fixture();
    const agent = f.agent();
    f.active.set(agent.id, "role-a");
    const first = await f.call("memory_write", { title: "Private A", content: "Decision A" }, agent);
    await f.call("memory_write", { title: "Shared decision", content: "Project fact", scope: "workspace" }, agent);
    f.active.set(agent.id, "role-b");
    await f.call("memory_write", { title: "Private B", content: "Decision B" }, agent);
    expect(f.memory.render(agent)).toContain("Private B");
    expect(f.memory.render(agent)).toContain("Shared decision");
    expect(f.memory.render(agent)).not.toContain("Private A");
    const id = first.split("ID: ")[1];
    expect(await f.call("memory_read", { id, format: "json" }, agent)).toBe("null");
    expect(await f.call("memory_update", { id, content: "Overwrite" }, agent)).toContain("not found");
    f.active.set(agent.id, "role-a");
    expect(await f.call("memory_read", { id }, agent)).toContain("Decision A");
    expect(f.memory.render(agent)).not.toContain("Private B");
  });

  it("resolves the current session workspace for each prompt and tool call", async () => {
    const f = fixture();
    const agent = f.agent("workspace-session", join(root, "first"));
    Object.freeze(agent.session.header);
    f.active.set(agent.id, "role-a");
    await f.call("memory_write", { title: "First workspace", content: "First evidence" }, agent);
    agent.session.events.push({ type: "working-directory/change", data: { cwd: join(root, "second") } });
    expect(f.memory.render(agent)).not.toContain("First workspace");
    expect(await f.call("memory_list", { format: "json" }, agent)).toBe("[]");
    await f.call("memory_write", { title: "Second workspace", content: "Second evidence" }, agent);
    expect(f.memory.render(agent)).toContain("Second workspace");
    agent.session.events.push({ type: "working-directory/change", data: { cwd: join(root, "first") } });
    expect(f.memory.render(agent)).toContain("First workspace");
    expect(f.memory.render(agent)).not.toContain("Second workspace");
  });

  it("uses the synchronous host workspace provider before creation metadata or event fallbacks", async () => {
    let current = join(root, "current");
    const f = fixture("", session => {
      expect(session.id).toBe("workspace-provider");
      return current;
    });
    const agent = f.agent("workspace-provider", join(root, "creation"));
    Object.freeze(agent.session.header);
    agent.session.events.push({ type: "working-directory/change", data: { cwd: join(root, "fallback") } });
    f.active.set(agent.id, "role-a");
    await f.call("memory_write", { title: "Current workspace", content: "Current evidence" }, agent);
    expect(f.memory.render(agent)).toContain("Current workspace");
    current = join(root, "next");
    expect(f.memory.render(agent)).not.toContain("Current workspace");
    expect(await f.call("memory_list", { format: "json" }, agent)).toBe("[]");
    expect(f.memory.forTool(agent, "memory_read").directory).toBe(current);
  });

  it("uses the child's own descriptor rather than a forked ancestor's role", async () => {
    const f = fixture();
    const agent = f.agent("forked-child");
    agent.session.events.push({ type: "subagent/descriptor", data: { provider: "parent" } });
    agent.session.inheritedEventCount = 1;
    expect(f.memory.forTool(agent, "memory_read").agent).toBe("");
    agent.session.events.push({ type: "subagent/descriptor", data: { provider: "parent--worker" } });
    expect(f.memory.forTool(agent, "memory_write").agent).toBe("parent--worker");
    await f.call("memory_write", { title: "Child descriptor memory", content: "Child evidence" }, agent);
    const store = MemoryStore.open(root);
    try {
      expect(store.list({ roleId: "parent", scope: "role" })).toEqual([]);
      expect(store.list({ roleId: "parent--worker", scope: "role" })[0].title).toBe("Child descriptor memory");
    } finally { store.close(); }
  });

  it("applies the same role identity to context_assemble memory searches", async () => {
    const f = fixture();
    const agent = f.agent();
    f.active.set(agent.id, "role-a");
    await f.call("memory_write", { title: "Cache decision", content: "Private A evidence" }, agent);
    f.active.set(agent.id, "role-b");
    await f.call("memory_write", { title: "Cache decision", content: "Private B evidence" }, agent);
    const result = await f.call("context_assemble", { topic: "Cache", sources: ["memory"] }, agent);
    expect(result).toContain("Private B evidence");
    expect(result).not.toContain("Private A evidence");
  });

  it("offers explicit consolidation only with both authorized session capabilities, using collision aliases", async () => {
    const f = fixture("rolebox_");
    const agent = f.agent();
    f.active.set(agent.id, "role-a");
    for (const name of ["session_list", "session_read"]) {
      f.names.set(name, `rolebox_${name}`);
      f.registered[`rolebox_${name}`] = { ...f.registered.rolebox_memory_list, name: `rolebox_${name}` };
    }
    expect(f.memory.render(agent)).toContain("explicitly requests session consolidation");
    expect(f.memory.render(agent)).toContain("rolebox_session_list");
    expect(f.memory.render(agent)).toContain("rolebox_session_read");
    f.first.config.tools = { session_read: false };
    expect(f.memory.render(agent)).not.toContain("session consolidation");
    await f.start(agent, { agent: "parent--worker", declaredTools: ["rolebox_memory_read", "rolebox_memory_write", "rolebox_session_list"] });
    expect(f.memory.render(agent)).not.toContain("session consolidation");
  });

  it("uses graph startup role and grants instead of a restored parent role", async () => {
    const f = fixture();
    const agent = f.agent("worker-session");
    f.active.set(agent.id, "parent");
    await f.call("memory_write", { title: "Parent memory", content: "Coordinator fact" }, agent);
    await f.start(agent, { agent: "parent--worker", declaredTools: ["memory_read", "memory_write"] });
    const rendered = f.memory.render(agent);
    expect(rendered).toContain("memory_read");
    expect(rendered).toContain("memory_write");
    expect(rendered).not.toContain("memory_recall");
    expect(rendered).not.toContain("memory_update");
    expect(rendered).not.toContain("Parent memory");
    await f.call("memory_write", { title: "Worker memory", content: "Worker fact" }, agent);
    const store = MemoryStore.open(root);
    try {
      expect(store.list({ roleId: "parent--worker", scope: "role" })[0]).toMatchObject({ title: "Worker memory", role_id: "parent--worker" });
    } finally { store.close(); }
    expect(f.memory.render(agent)).toContain("Worker memory");
  });

  it("does not expose memory workflow or summaries when the worker has no grants", async () => {
    const f = fixture();
    const agent = f.agent();
    f.active.set(agent.id, "role-a");
    await f.call("memory_write", { title: "Project memory", content: "Project fact", scope: "workspace" }, agent);
    await f.start(agent, { agent: "parent--worker" });
    expect(f.memory.render(agent)).toBe("");
  });

  it.each(["discover", "code"] as const)("routes memory guidance through %s presentation", async mode => {
    const f = fixture();
    const agent = f.agent();
    await f.start(agent, { agent: "parent--worker", declaredTools: ["memory_recall"], toolPresentation: { mode } });
    const rendered = f.memory.render(agent);
    expect(rendered).toContain("memory_recall");
    expect(rendered).toContain("graph_worker_tools");
    expect(rendered).toContain(mode === "discover" ? 'action="call"' : "graph_worker_code");
    expect(rendered).not.toContain("memory_write");
  });

  it("honors disabled injection while keeping authorized workflow and direct memory access", async () => {
    const f = fixture();
    const agent = f.agent();
    f.active.set(agent.id, "role-a");
    f.first.config.memory = { inject: false };
    await f.call("memory_write", { title: "Hidden summary", content: "Full evidence" }, agent);
    const rendered = f.memory.render(agent);
    expect(rendered).toContain("## Memory workflow");
    expect(rendered).not.toContain("Hidden summary");
    expect(await f.call("memory_recall", { query: "Hidden", format: "json" }, agent)).toContain("Full evidence");
  });

  it("uses collision-renamed tools in guidance while compiled execution retains the canonical role mapping", async () => {
    const f = fixture("rolebox_");
    const agent = f.agent();
    f.active.set(agent.id, "role-a");
    await f.call("memory_write", { title: "Prefixed tool result", content: "Verified evidence" }, agent);
    await f.call("memory_write", { title: "memory_write naming decision", content: "Verified naming evidence" }, agent);
    const rendered = f.memory.render(agent);
    expect(rendered).toContain("rolebox_memory_write");
    expect(rendered.split("## Available memory")[0]).not.toMatch(/\bmemory_write\b/);
    expect(rendered).toContain("Prefixed tool result");
    expect(rendered).toContain("memory_write naming decision");
    expect(rendered).not.toContain("rolebox_memory_write naming decision");
    await f.start(agent, { agent: "parent--worker", declaredTools: ["rolebox_memory_read"] });
    expect(f.memory.render(agent)).toContain("rolebox_memory_read");
    expect(f.memory.render(agent)).not.toContain("rolebox_memory_write");
  });

  it("never treats a session ID matching a role ID as the active memory role", async () => {
    const f = fixture();
    const agent = f.agent("role-a");
    expect(f.memory.render(agent)).toContain('scope="workspace"');
    expect(await f.call("memory_write", { title: "Private", content: "Private evidence" }, agent)).toContain("without an active role");
    await f.call("memory_write", { title: "Shared", content: "Shared evidence", scope: "workspace" }, agent);
    const rows = JSON.parse(await f.call("memory_list", { format: "json" }, agent));
    expect(rows).toHaveLength(1);
    expect(rows[0].role_id).toBe("shared");
  });

  it("enforces role tool policy in rendering and execution", async () => {
    const f = fixture();
    const agent = f.agent();
    f.active.set(agent.id, "role-a");
    f.first.config.tools = { "memory_*": false, memory_read: true };
    expect(f.memory.render(agent)).toContain("memory_read");
    expect(f.memory.render(agent)).not.toContain("memory_write");
    await expect(f.call("memory_write", { title: "Denied", content: "Denied content" }, agent)).rejects.toThrow("disabled");
  });

  it("rejects missing or relative workspaces before any store can fall back to process cwd", async () => {
    const f = fixture();
    const open = spyOn(MemoryStore, "create");
    try {
      for (const cwd of [undefined, "relative-workspace"]) {
        const agent = f.agent();
        agent.session.header.cwd = cwd;
        f.active.set(agent.id, "role-a");
        await expect(f.call("memory_write", { title: "Refused", content: "Refused content" }, agent)).rejects.toThrow("absolute workspace");
      }
      expect(open).not.toHaveBeenCalled();
    } finally { open.mockRestore(); }
  });
});
