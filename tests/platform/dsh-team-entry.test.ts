import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, type DshPluginContext, type DshPluginDisposer } from "../../src/entries/dsh.ts";
import type { DshSubagentProvider } from "../../src/platform/adapters/dsh/agent-registrar.ts";
import type { DshTeamAgent, DshTeamAgents, DshTeamAgentHandle } from "../../src/platform/adapters/dsh/team-session.ts";
import type { DshSessionEventLike, DshSessionLike } from "../../src/platform/adapters/dsh/session.ts";
import type { DshSystemPromptSection } from "../../src/platform/adapters/dsh/system-prompt.ts";
import type { DshToolDefinition } from "../../src/platform/adapters/dsh/tool-factory.ts";
import type { TeamState } from "../../src/team/types.ts";

let root: string;
let cwd: string;
let dataDir: string | undefined;
const plugins = new Set<DshPluginDisposer>();
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "rolebox-dsh-team-entry-")));
  cwd = process.cwd();
  dataDir = process.env.ROLEBOX_DATA_DIR;
  process.env.ROLEBOX_DATA_DIR = join(root, "data");
  process.chdir(root);
  for (const role of ["developer", "designer"]) {
    mkdirSync(join(root, "roles", role), { recursive: true });
    writeFileSync(join(root, "roles", role, "role.yaml"), `name: ${role}\ndescription: ${role} specialty\nprompt: You are the ${role} specialist.\nmodel: example-provider/${role}-model\n`);
  }
  mkdirSync(join(root, "workspace-a"));
  mkdirSync(join(root, "workspace-b"));
});
afterEach(async () => {
  for (const plugin of plugins) { plugin(); await plugin.whenDisposed(); }
  plugins.clear();
  process.chdir(cwd);
  if (dataDir === undefined) delete process.env.ROLEBOX_DATA_DIR;
  else process.env.ROLEBOX_DATA_DIR = dataDir;
  rmSync(root, { recursive: true, force: true });
});

async function eventually(check: () => boolean | Promise<boolean>) {
  for (let index = 0; index < 200; index++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Expected DSH team progress did not occur");
}

function host(options: { persistence?: boolean; prompt?: boolean; loop?: boolean; flush?: boolean; guard?: boolean; collision?: boolean;
  agentDefaultModel?: { provider: string; model: string; reasoningEffort?: string } } = {}) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const tools = new Map<string, DshToolDefinition>();
  const providers = new Map<string, DshSubagentProvider>();
  const sections: DshSystemPromptSection[] = [];
  const sessions = new Map<string, DshSessionLike>();
  const persisted = new Map<string, { cwd: string; events: DshSessionEventLike[] }>();
  const live = new Map<string, DshTeamAgent>();
  const guards: Array<Parameters<NonNullable<DshPluginContext["tools"]["guard"]>>[0]> = [];
  const created: Array<{ id: string; provider?: string; model?: string; prompt: unknown }> = [];
  const resumed: string[] = [];
  const sent: Array<{ id: string; text: string }> = [];
  const disposed: string[] = [];
  const spawnToolAvailability: boolean[] = [];
  let disposalBarrier: Promise<void> | undefined;
  const emit = (event: string, ...args: unknown[]) => { for (const listener of listeners.get(event) ?? []) listener(...args); };
  const makeSession = (id: string, directory: string, initial: DshSessionEventLike[] = []): DshSessionLike => {
    const events = [...initial];
    const session: DshSessionLike = { id, header: { cwd: directory }, get seq() { return events.length; }, events,
      append(type, data) {
        const event = { type, data, seq: events.length + 1, time: Date.now() };
        events.push(event);
        emit("session/event", session, event);
        return event;
      }, deriveMessages: () => [] };
    return session;
  };
  const makeAgent = (session: DshSessionLike): DshTeamAgent => {
    let status: "idle" | "running" = "idle";
    return { id: session.id, session, ctx: { tools: { presentAs() { return () => {}; } } }, get status() { return status; }, inbox: { nextTurn: [], nextStep: [], remove: () => false },
      followup(message) {
        sent.push({ id: session.id, text: message.content[0]!.text });
        session.append("user/message", message);
        status = "running";
        session.append("turn/start", {});
      }, inject(message) { session.append("user/message", message); },
      cancel() { status = "idle"; session.append("turn/end", { reason: { kind: "aborted" } }); },
      whenIdle: async () => {},
      finish(text: string) {
        session.append("assistant/message", { message: { id: `${session.id}-answer-${session.seq}`, content: [{ type: "text", text }] } });
        status = "idle";
        session.append("turn/end", { reason: { kind: "completed" } });
      },
      fail(text: string) {
        session.append("assistant/message", { message: { id: `${session.id}-answer-${session.seq}`, content: [{ type: "text", text }] } });
        status = "idle";
        session.append("turn/end", { reason: { kind: "error", error: { message: text, code: "MODEL_ERROR" } } });
      },
    } as DshTeamAgent;
  };
  const publish = (agent: DshTeamAgent): DshTeamAgentHandle => {
    sessions.set(agent.id, agent.session);
    live.set(agent.id, agent);
    emit("session/created", agent.session);
    emit("agent/created", { agent });
    return { agent, async dispose() {
      await disposalBarrier;
      if (agent.status === "running") agent.cancel({ kind: "hook", reason: "disposed" });
      persisted.set(agent.id, { cwd: agent.session.header!.cwd!, events: [...agent.session.events] });
      disposed.push(agent.id);
      sessions.delete(agent.id);
      live.delete(agent.id);
      emit("session/disposed", agent.session);
    } };
  };
  const agents: DshTeamAgents = {
    get: id => live.get(id),
    async create(input) {
      spawnToolAvailability.push(tools.has("team_create") || tools.has("rb_team_create"));
      const agent = makeAgent(makeSession(input.sessionId, input.meta.cwd));
      input.setup({}, agent);
      created.push({ id: agent.id, provider: input.agentOptions?.provider, model: input.agentOptions?.model,
        prompt: sections.find(section => section.name === "rolebox:role")?.text({ agent }) });
      return publish(agent);
    },
    async resume(input) {
      spawnToolAvailability.push(tools.has("team_create") || tools.has("rb_team_create"));
      const saved = persisted.get(input.resumeSessionId);
      if (!saved) throw new Error("Missing persisted session");
      const agent = makeAgent(makeSession(input.resumeSessionId, saved.cwd, saved.events));
      input.setup({}, agent);
      resumed.push(agent.id);
      return publish(agent);
    },
  };
  const systemPrompt = {
    section(section: DshSystemPromptSection) { sections.push(section); return () => { sections.splice(sections.indexOf(section), 1); }; },
    context() { return () => {}; },
  };
  const ctx: DshPluginContext = {
    tools: {
      ...(options.guard === false ? {} : { guard(callback: typeof guards[number]) { guards.push(callback); return () => { guards.splice(guards.indexOf(callback), 1); }; } }),
      get: name => tools.get(name) ?? (options.collision && name.startsWith("team_") ? {} : undefined),
      schemas: () => [...tools.values()],
      register(tool) { tools.set(tool.name, tool); return () => { tools.delete(tool.name); }; },
    },
    sessions: { get: id => sessions.get(id), list: () => [...sessions.values()],
      create: id => makeSession(id ?? "session", root), fork: source => source,
      ...(options.flush === false ? {} : { async flush(session: DshSessionLike) {
        persisted.set(session.id, { cwd: session.header!.cwd!, events: [...session.events] }); return true;
      } }),
    },
    subagents: {
      registerProvider(provider) { providers.set(provider.name, provider); return () => { providers.delete(provider.name); }; },
      getProvider: name => providers.get(name), list: () => [...providers.keys()],
      async startActivation(spec) {
        const agent = makeAgent(makeSession("graph-worker", (spec.request.parent as DshTeamAgent).session.header!.cwd!));
        agent.session.append("subagent/descriptor", { provider: spec.provider, label: spec.label });
        publish(agent);
        return { childId: agent.id, result: new Promise<never>(() => {}), dispose: async () => {} };
      },
    },
    agents,
    ...(options.prompt === false ? {} : { systemPrompt }),
    get(name) {
      if (name === "agents") return agents;
      if (name === "systemPrompt") return options.prompt === false ? undefined : systemPrompt;
      if (name === "agentLoop") return options.loop === false ? undefined : { createAgent() {}, resume() {} };
      if (name === "agentDefaultModel") {
        const selection = options.agentDefaultModel;
        return selection ? { currentSelection: () => ({ ...selection }) } : undefined;
      }
      if (name === "sessionPersistence" && options.persistence !== false) return { async inspect(id: string) { return { events: persisted.get(id)?.events ?? [] }; } };
      return undefined;
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set);
      return () => { set.delete(listener); };
    }, emit,
  };
  const owner = (id: string, workspace = "workspace-a") => {
    const agent = makeAgent(makeSession(id, join(root, workspace)));
    publish(agent);
    return agent;
  };
  const call = async (name: string, args: Record<string, unknown>, agent: DshTeamAgent, checkGuard = true): Promise<any> => {
    const actual = tools.has(name) ? name : `rb_${name}`;
    if (checkGuard) for (const guard of guards) { const denied = guard({ name: actual, agent }); if (denied) throw new Error(denied); }
    const value = await tools.get(actual)!.execute(args, { agent, signal: new AbortController().signal,
      callId: "team-call", deferContext() {}, concludeTurn() {} });
    return typeof value === "string" && value.startsWith("[") ? JSON.parse(value) : value;
  };
  const finish = (agent: DshTeamAgent, text = "Turn completed") => (agent as DshTeamAgent & { finish(text: string): void }).finish(text);
  const fail = (agent: DshTeamAgent, text: string) => (agent as DshTeamAgent & { fail(text: string): void }).fail(text);
  return { ctx, tools, live, owner, call, finish, fail, created, resumed, sent, disposed, persisted, listeners, spawnToolAvailability,
    delayDisposal: (barrier: Promise<void>) => { disposalBarrier = barrier; } };
}

async function boot(fixture: ReturnType<typeof host>) {
  const plugin = await apply(fixture.ctx, { roleboxDir: join(root, "roles") });
  plugins.add(plugin);
  return plugin;
}
async function stop(plugin: DshPluginDisposer) {
  plugin(); await plugin.whenDisposed(); plugins.delete(plugin);
}

describe("DSH team entry", () => {
  it("binds session tools to the host caller rather than session IDs supplied in arguments", async () => {
    const fixture = host();
    const owner = fixture.owner("owner");
    const peer = fixture.owner("peer");
    await boot(fixture);
    const listed = String(await fixture.call("session_list", {}, peer));
    expect(listed).toContain("peer");
    expect(listed).not.toContain("owner");
    await expect(fixture.call("session_read", { session_id: owner.id, sessionID: owner.id, agent: "developer" }, peer))
      .rejects.toThrow("may only access the calling session");
    await expect(fixture.call("session_fork", { session_id: owner.id }, peer))
      .rejects.toThrow("may only access the calling session");
    expect(String(await fixture.call("session_read", { session_id: peer.id }, peer))).toContain("has no messages");
  });

  it("gates team tools on a complete host without creating workspace team state", async () => {
    for (const options of [{ persistence: false }, { prompt: false }, { loop: false }, { flush: false }, { guard: false }]) {
      const fixture = host(options);
      const plugin = await boot(fixture);
      expect(plugin.stats.teamWired).toBe(false);
      expect([...fixture.tools.keys()].some(name => name.startsWith("team_"))).toBe(false);
      await stop(plugin);
    }
    expect(existsSync(join(root, ".rolebox", "team"))).toBe(false);
  });

  it("uses the trusted session role and workspace and creates a correctly configured peer", async () => {
    const fixture = host();
    const owner = fixture.owner("owner");
    const other = fixture.owner("other", "workspace-b");
    const plugin = await boot(fixture);
    expect(plugin.stats.teamWired).toBe(true);
    await plugin.activateRole("developer", owner.id);
    await plugin.activateRole("designer", other.id);
    const roles = await fixture.call("team_list_roles", {}, owner);
    expect(roles.map((role: { id: string }) => role.id).sort()).toEqual(["designer", "developer"]);
    const team = await fixture.call("team_create", { name: "Polish", goal: "Design and build a page", agent: "designer", directory: join(root, "workspace-b") }, owner) as TeamState;
    expect(team.ownerRoleId).toBe("developer");
    expect(existsSync(join(root, "workspace-a", ".rolebox", "team", team.id))).toBe(true);
    expect(await fixture.call("team_status", {}, other)).toEqual([]);
    await expect(fixture.call("team_status", { team_id: team.id }, other)).rejects.toThrow("not found");
    await fixture.call("team_add", { team_id: team.id, role_id: "designer" }, owner);
    // Adding records membership only; the first woken event starts the peer.
    expect(fixture.created).toHaveLength(0);
    await fixture.call("team_send_event", { team_id: team.id, kind: "message", content: "Prepare the first design" }, owner);
    fixture.finish(owner);
    await eventually(() => fixture.created.length === 1 && fixture.sent.some(message => message.id === fixture.created[0]!.id));
    expect(fixture.created[0]!.model).toBe("designer-model");
    expect(fixture.created[0]!.prompt).toContain("designer specialist");
    expect(fixture.sent.find(message => message.id === fixture.created[0]!.id)!.text).toContain("Design and build a page");
    const peer = fixture.live.get(fixture.created[0]!.id)!;
    expect(plugin.getActiveRole(peer.id)).toBe("designer");
    fixture.finish(peer, "Use the design system spacing");
    await eventually(async () => {
      const status = await fixture.call("team_status", { team_id: team.id }, owner) as TeamState;
      const memberId = status.members.find(member => member.sessionId === peer.id)?.id;
      return status.events.some(event => event.type === "turn_completed" && event.sender === memberId);
    });
    const status = await fixture.call("team_status", { team_id: team.id }, owner) as TeamState;
    expect(status.events.some(event => event.type === "turn_completed" && event.content.includes("spacing"))).toBe(false);
  });

  it("restores the existing peer after plugin restart and disposes its handles", async () => {
    const fixture = host();
    const owner = fixture.owner("owner");
    const first = await boot(fixture);
    await first.activateRole("developer", owner.id);
    const team = await fixture.call("team_create", { name: "Build", goal: "Work together" }, owner) as TeamState;
    await fixture.call("team_add", { team_id: team.id, role_id: "designer" }, owner);
    await fixture.call("team_send_event", { team_id: team.id, kind: "message", content: "Prepare the first design" }, owner);
    fixture.finish(owner);
    await eventually(() => fixture.created.length === 1 && fixture.sent.some(message => message.id === fixture.created[0]!.id));
    const peerId = fixture.created[0]!.id;
    fixture.finish(fixture.live.get(peerId)!);
    await eventually(async () => !(await fixture.call("team_status", { team_id: team.id }, owner) as TeamState).members.find(member => member.sessionId === peerId)!.delivery);
    await fixture.call("team_send_event", { team_id: team.id, kind: "message", content: "Review the next iteration" }, owner);
    await stop(first);
    expect(fixture.disposed).toContain(peerId);
    const second = await boot(fixture);
    await eventually(() => fixture.resumed.includes(peerId) && fixture.sent.some(message => message.id === peerId && message.text.includes("next iteration")));
    expect(fixture.created).toHaveLength(1);
    expect(fixture.spawnToolAvailability).toEqual([true, true]);
    await stop(second);
    expect(fixture.disposed.filter(id => id === peerId)).toHaveLength(2);
    expect([...fixture.tools.keys()].some(name => name.startsWith("team_"))).toBe(false);
  });

  it("rejects unselected roles and graph workers even through collision aliases and direct execution", async () => {
    const fixture = host({ collision: true });
    const owner = fixture.owner("owner");
    const plugin = await boot(fixture);
    expect(fixture.tools.has("rb_team_create")).toBe(true);
    await expect(fixture.call("team_create", { name: "x", goal: "x" }, owner)).rejects.toThrow("active top-level role");
    await plugin.activateRole("developer", owner.id);
    await fixture.call("graph_declare", { declaration: { version: 3, name: "worker-boundary", nodes: [
      { id: "work", agent: "designer", prompt: "Work", tools: ["team_", "rb_team_"], outcomes: [{ id: "done" }] },
    ], edges: [] } }, owner);
    await eventually(() => fixture.live.has("graph-worker"));
    const worker = fixture.live.get("graph-worker")!;
    await plugin.activateRole("developer", worker.id);
    await expect(fixture.call("team_list_roles", {}, worker)).rejects.toThrow();
    await expect(fixture.call("team_create", { name: "escape", goal: "escape" }, worker, false)).rejects.toThrow("Graph workers cannot use team tools");
    expect(fixture.created).toHaveLength(0);
  });

  it("lists team roles before any session has an active role", async () => {
    const fixture = host();
    const owner = fixture.owner("owner");
    await boot(fixture);

    const roles = await fixture.call("team_list_roles", {}, owner) as Array<{ id: string }>;
    expect(roles.map(role => role.id).sort()).toEqual(["designer", "developer"]);
    // The rest of the team surface still needs a selected top-level role.
    await expect(fixture.call("team_create", { name: "Build", goal: "Work together" }, owner))
      .rejects.toThrow("active top-level role");
    expect(fixture.created).toHaveLength(0);
  });

  it("rejects a role with no model unless the host supplies a default", async () => {
    mkdirSync(join(root, "roles", "writer"), { recursive: true });
    writeFileSync(join(root, "roles", "writer", "role.yaml"), "name: writer\ndescription: writer specialty\nprompt: You are the writer.\n");
    const fixture = host();
    const owner = fixture.owner("owner");
    const plugin = await boot(fixture);
    await plugin.activateRole("developer", owner.id);
    const team = await fixture.call("team_create", { name: "Draft", goal: "Write the release notes" }, owner) as TeamState;

    await expect(fixture.call("team_add", { team_id: team.id, role_id: "writer" }, owner))
      .rejects.toThrow('Role "writer" has no usable provider/model');
    expect((await fixture.call("team_status", { team_id: team.id }, owner) as TeamState).members).toHaveLength(1);

    // The same role is a valid member when the host exposes a default model.
    const withDefault = host({ agentDefaultModel: { provider: "host-provider", model: "host-model", reasoningEffort: "high" } });
    const other = withDefault.owner("default-owner", "workspace-b");
    const second = await boot(withDefault);
    await second.activateRole("developer", other.id);
    const defaulted = await withDefault.call("team_create", { name: "Draft", goal: "Write the release notes" }, other) as TeamState;
    await expect(withDefault.call("team_add", { team_id: defaulted.id, role_id: "writer" }, other)).resolves.toBeDefined();
    await withDefault.call("team_send_event", { team_id: defaulted.id, kind: "message", content: "Draft the notes" }, other);
    await eventually(() => withDefault.created.some(peer => peer.model === "host-model"));
    expect(withDefault.created.find(peer => peer.model === "host-model")).toMatchObject({ provider: "host-provider" });
  });

  it("activates the configured default role for a session created after boot", async () => {
    const fixture = host();
    const beforeBoot = fixture.owner("before-boot");
    const plugin = await apply(fixture.ctx, { roleboxDir: join(root, "roles"), activeRole: "developer" });
    plugins.add(plugin);

    // A session that already existed when the plugin booted has no created event.
    expect(plugin.getActiveRole(beforeBoot.id)).toBeNull();
    const afterBoot = fixture.owner("after-boot");
    expect(plugin.getActiveRole(afterBoot.id)).toBe("developer");
    // An explicit switch still wins over the configured default.
    await plugin.activateRole("designer", afterBoot.id);
    expect(plugin.getActiveRole(afterBoot.id)).toBe("designer");
  });

  it("reports a peer turn's real failure and resumes it", async () => {
    const fixture = host();
    const owner = fixture.owner("owner");
    const plugin = await boot(fixture);
    await plugin.activateRole("developer", owner.id);
    const team = await fixture.call("team_create", { name: "Build", goal: "Work together" }, owner) as TeamState;
    await fixture.call("team_add", { team_id: team.id, role_id: "designer" }, owner);
    await fixture.call("team_send_event", { team_id: team.id, kind: "message", content: "Prepare the design" }, owner);
    await eventually(() => fixture.created.length === 1 && fixture.sent.some(message => message.id === fixture.created[0]!.id));
    const peer = fixture.live.get(fixture.created[0]!.id)!;

    fixture.fail(peer, "provider returned 500");
    await eventually(async () => {
      const status = await fixture.call("team_status", { team_id: team.id }, owner) as TeamState;
      return status.status === "paused" && (status.members.find(member => member.sessionId === peer.id)?.error ?? "").includes("provider returned 500");
    });
    const failed = await fixture.call("team_status", { team_id: team.id }, owner) as TeamState;
    expect(failed.events.find(event => event.type === "member_failed")?.content).toContain("provider returned 500");
    expect(failed.turns).toBe(0);

    const resumed = String(await fixture.call("team_resume", { team_id: team.id }, owner));
    expect(resumed).toContain("provider returned 500");
    await eventually(() => fixture.sent.filter(message => message.id === peer.id).length >= 2);
    fixture.finish(peer, "Design is ready");
    await eventually(async () => {
      const status = await fixture.call("team_status", { team_id: team.id }, owner) as TeamState;
      return status.status === "active" && status.events.some(event => event.type === "turn_completed");
    });
  });

  it("closes a team, releases the member descriptor, and hides it from the default list", async () => {
    const fixture = host();
    const owner = fixture.owner("owner");
    const plugin = await boot(fixture);
    await plugin.activateRole("developer", owner.id);
    const team = await fixture.call("team_create", { name: "Build", goal: "Work together" }, owner) as TeamState;
    await fixture.call("team_add", { team_id: team.id, role_id: "designer" }, owner);
    await fixture.call("team_send_event", { team_id: team.id, kind: "message", content: "Prepare the design" }, owner);
    await eventually(() => fixture.created.length === 1);
    const peerId = fixture.created[0]!.id;
    const descriptor = join(root, "workspace-a", ".rolebox", "team-sessions", `${peerId}.json`);
    expect(existsSync(descriptor)).toBe(true);

    await fixture.call("team_delete", { team_id: team.id }, owner);
    await eventually(() => !existsSync(descriptor));
    expect(await fixture.call("team_status", {}, owner)).toEqual([]);
    const closed = await fixture.call("team_status", { include_deleted: true }, owner) as Array<{ id: string; name: string; status: string }>;
    expect(closed.map(entry => ({ id: entry.id, name: entry.name, status: entry.status })))
      .toEqual([{ id: team.id, name: "Build", status: "deleted" }]);
    expect((await fixture.call("team_status", { team_id: team.id }, owner) as TeamState).status).toBe("deleted");
  });

  it("stops new tool calls immediately and waits for peer disposal", async () => {
    const fixture = host();
    const owner = fixture.owner("owner");
    const plugin = await boot(fixture);
    await plugin.activateRole("developer", owner.id);
    const team = await fixture.call("team_create", { name: "Build", goal: "Work together" }, owner) as TeamState;
    await fixture.call("team_add", { team_id: team.id, role_id: "designer" }, owner);
    await fixture.call("team_send_event", { team_id: team.id, kind: "message", content: "Prepare the first design" }, owner);
    fixture.finish(owner);
    await eventually(() => fixture.created.length === 1 && fixture.sent.some(message => message.id === fixture.created[0]!.id));
    const tool = fixture.tools.get("team_list_roles")!;
    let release!: () => void;
    fixture.delayDisposal(new Promise<void>(resolve => { release = resolve; }));
    const shutdown = plugin();
    let closed = false;
    void plugin.whenDisposed().then(() => { closed = true; });
    try {
      await expect(tool.execute({}, { agent: owner, signal: new AbortController().signal,
        callId: "late-call", deferContext() {}, concludeTurn() {} })).rejects.toThrow("shutting down");
      expect(closed).toBe(false);
      expect(fixture.tools.has("team_create")).toBe(false);
    } finally { release(); }
    await shutdown;
    expect(closed).toBe(true);
    plugins.delete(plugin);
  });
});
