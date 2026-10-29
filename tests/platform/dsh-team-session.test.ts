import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import { MessageId } from "@deepseek-ai/dsh-llm";
import { DshTeamSessionAdapter, type DshTeamAgent, type DshTeamAgentOptions, type DshTeamAgents } from "../../src/platform/adapters/dsh/team-session.ts";
import type { DshSessionEventLike, DshSessionLike, DshSessionStoreLike } from "../../src/platform/adapters/dsh/session.ts";
import { DshTeamSessionLease } from "../../src/platform/adapters/dsh/team-session-lease.ts";
import { TeamRuntime } from "../../src/team/runtime.ts";
import type { ResolvedRole } from "../../src/types.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type PendingPrompt = Omit<Parameters<DshTeamAgent["followup"]>[0], "source"> & { source: { kind: string; form?: string; summary?: string } };
type RequestHook = Parameters<NonNullable<NonNullable<DshTeamAgent["ctx"]>["on"]>>[1];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "rolebox-dsh-team-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const stored = new Map<string, DshSessionEventLike[]>();
  const sessions = new Map<string, DshSessionLike>();
  const agents = new Map<string, DshTeamAgent>();
  const roles = new Map<string, string>();
  const pending = new Map<string, PendingPrompt[]>();
  const requestHooks = new Map<string, RequestHook[]>();
  const created: Array<Parameters<DshTeamAgents["create"]>[0]> = [];
  const resumed: Array<Parameters<DshTeamAgents["resume"]>[0]> = [];
  const cleared: string[] = [];
  let flushAccepted = true;
  let cancellationAccepted = true;
  let disposalAccepted = true;
  let designerOptions: { provider?: string; model?: string } | undefined = { provider: "example-provider", model: "design-model" };

  function makeSession(id: string, initial: readonly DshSessionEventLike[] = []): DshSessionLike {
    const events = structuredClone(initial) as DshSessionEventLike[];
    return { id, get seq() { return events.length; }, events, header: { cwd: directory }, deriveMessages: () => [],
      append(type, data) { const event = { type, data, seq: events.length, time: 100 + events.length }; events.push(event); return event; } };
  }
  function makeAgent(session: DshSessionLike) {
    let status: "idle" | "running" = "idle";
    pending.set(session.id, []);
    requestHooks.set(session.id, []);
    const agent: DshTeamAgent = { id: session.id, session, get status() { return status; },
      ctx: { on(_event, listener) {
        const hooks = requestHooks.get(session.id)!;
        hooks.push(listener);
        return () => { hooks.splice(hooks.indexOf(listener), 1); };
      } },
      inbox: { get nextTurn() { return pending.get(session.id)!; }, nextStep: [],
        remove(messageId) { const messages = pending.get(session.id)!; const index = messages.findIndex(message => message.id === messageId);
          if (index < 0) return false; messages.splice(index, 1); cleared.push(session.id); return true; } },
      followup(message) { pending.get(session.id)!.push(message); status = "running"; },
      inject(message) { pending.get(session.id)!.push(message); },
      cancel(_cause, options) { if (cancellationAccepted) { if (!options?.keepInbox) pending.set(session.id, []); status = "idle"; } },
      async whenIdle() {},
    };
    return { agent, setIdle() { status = "idle"; } };
  }
  const idle = new Map<string, () => void>();
  async function dispose(id: string) {
    if (!disposalAccepted) throw new Error("Peer disposal failed");
    agents.delete(id);
    sessions.delete(id);
    requestHooks.delete(id);
  }
  const registry: DshTeamAgents = {
    get: id => agents.get(id),
    async create(options) {
      created.push(options);
      const session = makeSession(options.sessionId);
      const made = makeAgent(session);
      options.setup({}, made.agent);
      expect(roles.get(session.id)).toBe("designer");
      sessions.set(session.id, session);
      agents.set(session.id, made.agent);
      idle.set(session.id, made.setIdle);
      return { agent: made.agent, dispose: () => dispose(session.id) };
    },
    async resume(options) {
      resumed.push(options);
      const saved = stored.get(options.resumeSessionId);
      if (!saved) throw new Error("No persisted session");
      const session = makeSession(options.resumeSessionId, saved);
      let open = false;
      for (const event of saved) { if (event.type === "turn/start") open = true; if (event.type === "turn/end") open = false; }
      if (open) session.append("turn/end", { turn: 1, reason: { kind: "interrupted" } });
      const made = makeAgent(session);
      pending.get(session.id)!.push({ id: "stale", role: "user", content: [{ type: "text", text: "[rolebox-team stale] old queued turn" }],
        source: { kind: "rolebox", form: "notice", summary: "old" } });
      options.setup({}, made.agent);
      sessions.set(session.id, session);
      agents.set(session.id, made.agent);
      idle.set(session.id, made.setIdle);
      return { agent: made.agent, dispose: () => dispose(session.id) };
    },
  };
  const store: DshSessionStoreLike = {
    get: id => sessions.get(id), list: () => [...sessions.values()],
    create() { throw new Error("SessionStore.create must never execute team work"); },
    fork() { throw new Error("unused"); },
    async flush(session) { if (!flushAccepted) return false; stored.set(session.id, structuredClone(session.events) as DshSessionEventLike[]); return true; },
  };
  const options = { directory, sessions: store, agents: registry,
    bindRole(id: string, role: string) { roles.set(id, role); },
    roleOf(id: string) { return roles.get(id); },
    resolveRole(role: string) { return role === "designer" ? { agentOptions: designerOptions } : undefined; },
    async readExecutionEvents(id: string) { return stored.get(id); },
  };
  const makeAdapter = () => { const adapter = new DshTeamSessionAdapter(options); cleanups.push(() => adapter.dispose()); return adapter; };
  function complete(id: string, reason = "completed") {
    const session = sessions.get(id)!;
    session.append("turn/start", { turn: 1 });
    for (const message of pending.get(id)!.splice(0)) session.append("user/message", message);
    session.append("assistant/message", { turn: 1, step: 1, stream: [], message: { id: `answer-${session.seq}`, role: "assistant",
      content: [{ type: "text", text: "Design ready" }], source: { kind: "model", provider: "example-provider", model: "design-model" } } });
    session.append("turn/end", { turn: 1, reason: { kind: reason } });
    idle.get(id)!();
  }
  async function requestOptions(id: string): Promise<DshTeamAgentOptions> {
    const selected = [...created, ...resumed].reverse().find(input => ("sessionId" in input ? input.sessionId : input.resumeSessionId) === id)?.agentOptions;
    const seed = async () => ({ ...selected });
    return requestHooks.get(id)!.reduceRight<() => Promise<DshTeamAgentOptions>>((next, listener) => () => listener({}, next), seed)();
  }
  return { directory, sessions, store, agents, registry, roles, pending, created, resumed, cleared, stored, makeAdapter, complete, requestOptions,
    setFlush(value: boolean) { flushAccepted = value; }, setCancellation(value: boolean) { cancellationAccepted = value; },
    setDisposal(value: boolean) { disposalAccepted = value; },
    setRoleOptions(value: { provider?: string; model?: string } | undefined) { designerOptions = value; } };
}

describe("DSH team execution sessions", () => {
  it("creates a live peer with role/model configured before publication and durable acknowledgement", async () => {
    const f = fixture(); const adapter = f.makeAdapter();
    expect(await adapter.create({ directory: f.directory, agent: "designer--private" })).toBeNull();
    const session = await adapter.create({ directory: f.directory, agent: "designer" });
    expect(session).not.toBeNull();
    expect(f.created[0].agentOptions).toEqual({ provider: "example-provider", model: "design-model" });
    expect(f.created[0].meta).toEqual({ cwd: f.directory });
    expect(f.stored.has(session!.id)).toBe(true);
    expect(await adapter.status(session!.id)).toEqual({ type: "idle" });
  });

  it("queues separate waking turns and preserves only actually claimed delivery markers", async () => {
    const f = fixture(); const adapter = f.makeAdapter();
    const id = (await adapter.create({ directory: f.directory, agent: "designer" }))!.id;
    const text = "[rolebox-team delivery-1]\nPrepare a design";
    const receipt = await adapter.prompt(id, { agent: "designer", noReply: false, parts: [{ type: "text", text }] });
    expect(receipt?.id).toBe(f.pending.get(id)![0].id);
    expect(await adapter.status(id)).toEqual({ type: "busy" });
    expect(await adapter.messages(id)).toEqual([]);
    f.complete(id);
    const messages = await adapter.messages(id);
    expect(messages.find(message => message.info.id === receipt!.id)?.parts[0]).toMatchObject({ type: "text", text });
    expect(messages.at(-1)?.info).toMatchObject({ role: "idle", finish: "succeeded" });
    expect(messages.at(-2)?.parts[0]).toMatchObject({ type: "text", text: "Design ready" });
    await adapter.prompt(id, { noReply: true, parts: [{ type: "text", text: "context only" }] });
    expect(await adapter.status(id)).toEqual({ type: "idle" });
  });

  it("reads cold history without execution, then restores the same peer and configured model", async () => {
    const f = fixture(); const first = f.makeAdapter();
    const id = (await first.create({ directory: f.directory, agent: "designer" }))!.id;
    await first.prompt(id, { parts: [{ type: "text", text: "[rolebox-team first]" }] });
    f.complete(id); await first.messages(id); await first.dispose();
    const restored = f.makeAdapter();
    expect(await restored.status(id)).toEqual({ type: "idle" });
    expect((await restored.get(id))?.id).toBe(id);
    expect((await restored.messages(id)).at(-1)?.info.finish).toBe("succeeded");
    expect(f.resumed).toHaveLength(0);
    await restored.prompt(id, { agent: "designer", parts: [{ type: "text", text: "[rolebox-team second]" }] });
    expect(f.resumed).toHaveLength(1);
    expect(f.resumed[0].resumeSessionId).toBe(id);
    expect(f.resumed[0].agentOptions).toEqual(f.created[0].agentOptions);
    expect(f.pending.get(id)).toHaveLength(1);
    expect(f.pending.get(id)![0].content[0].text).toBe("[rolebox-team second]");
    expect(f.created).toHaveLength(1);
    expect(await restored.status("user-session-not-restored")).toBeNull();
    expect(await restored.prompt("user-session-not-restored", { parts: [{ type: "text", text: "wake" }] })).toBeNull();
    expect(await restored.abort("user-session-not-restored")).toBe(false);
    expect(f.resumed).toHaveLength(1);
  });

  it("repairs a crash-interrupted peer only under explicit cancellation, preserving a failed outcome", async () => {
    const f = fixture(); const first = f.makeAdapter();
    const id = (await first.create({ directory: f.directory, agent: "designer" }))!.id;
    f.sessions.get(id)!.append("turn/start", { turn: 1 });
    await first.messages(id); await first.dispose();
    const restored = f.makeAdapter();
    expect(await restored.status(id)).toEqual({ type: "busy" });
    expect(f.resumed).toHaveLength(0);
    expect(await restored.abort(id)).toBe(true);
    expect(f.resumed).toHaveLength(1);
    expect((await restored.messages(id)).at(-1)?.info).toMatchObject({ role: "idle", finish: "interrupted" });
    expect(f.pending.get(id)).toEqual([]);
  });

  it("does not acknowledge unconfirmed cancellation or durability", async () => {
    const f = fixture(); const adapter = f.makeAdapter();
    const id = (await adapter.create({ directory: f.directory, agent: "designer" }))!.id;
    await adapter.prompt(id, { parts: [{ type: "text", text: "start" }] });
    f.setCancellation(false);
    expect(await adapter.abort(id)).toBe(false);
    f.setCancellation(true); f.setFlush(false);
    expect(await adapter.abort(id)).toBe(false);
    await expect(adapter.messages(id)).rejects.toThrow("durable team session storage");
    await expect(adapter.prompt(id, { parts: [{ type: "text", text: "again" }] })).rejects.toThrow("durable team session storage");
  });

  it("preserves non-team input while cancelling the managed peer", async () => {
    const f = fixture(); const adapter = f.makeAdapter();
    const id = (await adapter.create({ directory: f.directory, agent: "designer" }))!.id;
    await adapter.prompt(id, { parts: [{ type: "text", text: "[rolebox-team pending]" }] });
    const userMessage = { id: "user-pending", role: "user", content: [{ type: "text", text: "Please also review this" }], source: { kind: "user" } } satisfies PendingPrompt;
    f.pending.get(id)!.push(userMessage);
    expect(await adapter.abort(id)).toBe(true);
    expect(f.pending.get(id)).toEqual([userMessage]);
  });

  it("holds residency across idle turns so another host cannot recreate the same peer", async () => {
    const f = fixture(); const first = f.makeAdapter(); const second = f.makeAdapter();
    const id = (await first.create({ directory: f.directory, agent: "designer" }))!.id;
    expect(await second.status(id)).toEqual({ type: "busy" });
    await expect(second.prompt(id, { parts: [{ type: "text", text: "race" }] })).rejects.toThrow("another running host");
    expect(await second.abort(id)).toBe(false);
    await first.dispose();
    await second.prompt(id, { parts: [{ type: "text", text: "accepted after release" }] });
    expect(f.resumed).toHaveLength(1);
  });

  it("refuses delivery after the peer's effective working directory changes", async () => {
    const f = fixture(); const adapter = f.makeAdapter();
    const id = (await adapter.create({ directory: f.directory, agent: "designer" }))!.id;
    f.sessions.get(id)!.append("working-directory/change", { cwd: join(f.directory, "another-project") });
    expect(await adapter.prompt(id, { parts: [{ type: "text", text: "[rolebox-team workspace-change]" }] })).toBeNull();
    expect(f.pending.get(id)).toEqual([]);
  });

  it("refuses a resident peer after a user role change without replacing the user's selection", async () => {
    const f = fixture(); const adapter = f.makeAdapter();
    const id = (await adapter.create({ directory: f.directory, agent: "designer" }))!.id;
    f.roles.set(id, "developer");
    await expect(adapter.prompt(id, { agent: "designer", parts: [{ type: "text", text: "[rolebox-team role-change]" }] }))
      .rejects.toThrow("active role changed");
    expect(f.roles.get(id)).toBe("developer");
    expect(f.pending.get(id)).toEqual([]);
    expect(await adapter.abort(id)).toBe(true);
  });

  it("repairs an existing peer with the role's current options on the next resume", async () => {
    const f = fixture(); const first = f.makeAdapter();
    const id = (await first.create({ directory: f.directory, agent: "designer" }))!.id;
    await first.prompt(id, { parts: [{ type: "text", text: "[rolebox-team first]" }] });
    f.complete(id); await first.messages(id); await first.dispose();
    const descriptorPath = join(f.directory, ".rolebox", "team-sessions", `${id}.json`);
    expect(JSON.parse(readFileSync(descriptorPath, "utf8")).agentOptions).toEqual({ provider: "example-provider", model: "design-model" });

    f.setRoleOptions({ provider: "example-provider", model: "repaired-model" });
    const restored = f.makeAdapter();
    await restored.prompt(id, { agent: "designer", parts: [{ type: "text", text: "[rolebox-team second]" }] });

    expect(f.resumed[0].agentOptions).toEqual({ provider: "example-provider", model: "repaired-model" });
    expect(JSON.parse(readFileSync(descriptorPath, "utf8")).agentOptions).toEqual({ provider: "example-provider", model: "repaired-model" });
  });

  it("updates idle resident requests with the current model and preserves history", async () => {
    const f = fixture(); const adapter = f.makeAdapter();
    const id = (await adapter.create({ directory: f.directory, agent: "designer" }))!.id;
    await adapter.prompt(id, { parts: [{ type: "text", text: "[rolebox-team first]" }] });
    f.complete(id);
    const history = await adapter.messages(id);
    const original = f.agents.get(id);
    f.setRoleOptions({ provider: "example-provider", model: "repaired-model" });

    await Promise.all(["second", "third"].map(delivery => adapter.prompt(id, {
      agent: "designer", parts: [{ type: "text", text: `[rolebox-team ${delivery}]` }],
    })));

    expect(f.created).toHaveLength(1);
    expect(f.resumed).toHaveLength(0);
    expect(await f.requestOptions(id)).toMatchObject({ provider: "example-provider", model: "repaired-model" });
    expect(f.agents.get(id)).toBe(original);
    expect((await adapter.messages(id)).slice(0, history.length)).toEqual(history);
    expect(f.pending.get(id)!.map(message => message.content[0].text)).toEqual(["[rolebox-team second]", "[rolebox-team third]"]);
  });

  it("defers resident model changes until idle without interrupting its running turn", async () => {
    const f = fixture(); const adapter = f.makeAdapter();
    const id = (await adapter.create({ directory: f.directory, agent: "designer" }))!.id;
    await adapter.prompt(id, { parts: [{ type: "text", text: "[rolebox-team first]" }] });
    const original = f.agents.get(id);
    const path = join(f.directory, ".rolebox", "team-sessions", `${id}.json`);
    f.setRoleOptions({ provider: "example-provider", model: "repaired-model" });
    const input = { agent: "designer", parts: [{ type: "text" as const, text: "[rolebox-team retry]" }] };

    await expect(adapter.prompt(id, input)).rejects.toThrow("idle");
    expect(f.agents.get(id)).toBe(original);
    expect(await adapter.status(id)).toEqual({ type: "busy" });
    expect(JSON.parse(readFileSync(path, "utf8")).agentOptions.model).toBe("design-model");
    f.complete(id);
    await adapter.prompt(id, input);
    expect(f.resumed).toHaveLength(0);
    expect(f.agents.get(id)).toBe(original);
    expect(await f.requestOptions(id)).toMatchObject({ model: "repaired-model" });
  });

  it("does not rewrite another host's descriptor when a model change is rejected", async () => {
    const f = fixture(); const owner = f.makeAdapter(); const other = f.makeAdapter();
    const id = (await owner.create({ directory: f.directory, agent: "designer" }))!.id;
    const path = join(f.directory, ".rolebox", "team-sessions", `${id}.json`);
    f.setRoleOptions({ provider: "example-provider", model: "repaired-model" });

    await expect(other.prompt(id, { parts: [{ type: "text", text: "[rolebox-team rejected]" }] }))
      .rejects.toThrow("another running host");
    expect(JSON.parse(readFileSync(path, "utf8")).agentOptions.model).toBe("design-model");
    await owner.prompt(id, { parts: [{ type: "text", text: "[rolebox-team accepted]" }] });
    expect(f.resumed).toHaveLength(0);
    expect(await f.requestOptions(id)).toMatchObject({ model: "repaired-model" });
  });

  it("refuses a peer whose role lost its usable provider/model", async () => {
    const f = fixture(); const first = f.makeAdapter();
    const id = (await first.create({ directory: f.directory, agent: "designer" }))!.id;
    await first.prompt(id, { parts: [{ type: "text", text: "[rolebox-team first]" }] });
    f.complete(id); await first.messages(id); await first.dispose();

    f.setRoleOptions(undefined);
    const restored = f.makeAdapter();
    await expect(restored.prompt(id, { agent: "designer", parts: [{ type: "text", text: "[rolebox-team second]" }] }))
      .rejects.toThrow('role "designer" has no usable provider/model');
    expect(f.resumed).toHaveLength(0);
  });

  it("forgets a removed peer's descriptor, handle and lease but never a user session", async () => {
    const f = fixture(); const adapter = f.makeAdapter();
    const id = (await adapter.create({ directory: f.directory, agent: "designer" }))!.id;
    const descriptorPath = join(f.directory, ".rolebox", "team-sessions", `${id}.json`);
    expect(existsSync(descriptorPath)).toBe(true);

    await adapter.forget(id);

    expect(existsSync(descriptorPath)).toBe(false);
    expect(f.agents.has(id)).toBe(false);
    // The role can join a team again as a fresh peer.
    expect(await adapter.create({ directory: f.directory, agent: "designer" })).not.toBeNull();
    await expect(adapter.forget("user-session-not-restored")).resolves.toBeUndefined();
  });

  it("preserves a foreign peer's descriptor and lease until its owner releases it", async () => {
    const f = fixture(); const owner = f.makeAdapter(); const other = f.makeAdapter();
    const id = (await owner.create({ directory: f.directory, agent: "designer" }))!.id;
    const path = join(f.directory, ".rolebox", "team-sessions", `${id}.json`);

    await other.forget(id);
    expect(existsSync(path)).toBe(true);
    expect(f.agents.has(id)).toBe(true);
    expect(await other.status(id)).toEqual({ type: "busy" });
    await owner.forget(id);
    expect(existsSync(path)).toBe(false);
    expect(f.agents.has(id)).toBe(false);
  });

  it("retries host-owned peer cleanup after a failed flush and releases its lease only when durable", async () => {
    const f = fixture(); const first = f.makeAdapter();
    const id = (await first.create({ directory: f.directory, agent: "designer" }))!.id;
    await first.dispose();
    const handle = await f.registry.resume({ resumeSessionId: id, setup() {}, signal: new AbortController().signal });
    cleanups.push(() => handle.dispose());
    const adapter = f.makeAdapter();
    const lease = new DshTeamSessionLease(f.directory);
    cleanups.push(() => lease.dispose());
    const path = join(f.directory, ".rolebox", "team-sessions", `${id}.json`);
    f.setFlush(false);

    await expect(adapter.forget(id)).rejects.toThrow("durable team session storage");
    expect(existsSync(path)).toBe(true);
    expect(f.agents.get(id)).toBe(handle.agent);
    expect(lease.acquire(id)).toBe(false);
    f.setFlush(true);
    await adapter.forget(id);

    expect(existsSync(path)).toBe(false);
    expect(f.agents.get(id)).toBe(handle.agent);
    expect(f.pending.get(id)).toEqual([]);
    expect(lease.acquire(id)).toBe(true);
  });

  it("keeps the descriptor, handle and lease when disposal fails so cleanup can retry", async () => {
    const f = fixture(); const owner = f.makeAdapter(); const other = f.makeAdapter();
    const id = (await owner.create({ directory: f.directory, agent: "designer" }))!.id;
    const path = join(f.directory, ".rolebox", "team-sessions", `${id}.json`);
    f.setDisposal(false);
    try {
      await expect(owner.forget(id)).rejects.toThrow("Peer disposal failed");
      expect(existsSync(path)).toBe(true);
      expect(f.agents.has(id)).toBe(true);
      expect(await other.status(id)).toEqual({ type: "busy" });
    } finally { f.setDisposal(true); }

    await owner.forget(id);
    expect(existsSync(path)).toBe(false);
    expect(f.agents.has(id)).toBe(false);
  });

  for (const operation of ["remove", "delete"] as const) {
    for (const releaseOwner of [false, true]) {
      it(`retries ${operation} cleanup ${releaseOwner ? "after the owning host exits" : "on the owning host"}`, async () => {
        const f = fixture(); const owner = f.makeAdapter(); const other = f.makeAdapter();
        const roles: ResolvedRole[] = ["developer", "designer"].map(id => ({ id, config: { name: id, description: id, prompt: "" },
          prompt: "", skills: [], functions: [], references: [], subagents: [] }));
        const creator = { sessionID: "owner", agent: "developer" };
        const makeRuntime = (session: DshTeamSessionAdapter) => {
          const runtime = new TeamRuntime({ directory: f.directory, platformId: "dsh", session, roles: () => roles, canPollStatus: true });
          cleanups.push(() => runtime.dispose());
          return runtime;
        };
        const origin = makeRuntime(owner); const observer = makeRuntime(other);
        const team = origin.create(creator, "Build", "Prepare the design");
        const member = origin.add(creator, team.id, "designer");
        origin.send(creator, team.id, { kind: "message", content: "Prepare the first design" });
        await origin.tick();
        const id = origin.status(creator, team.id).members.find(item => item.id === member.id)!.sessionId!;
        f.complete(id); await origin.tick();
        const path = join(f.directory, ".rolebox", "team-sessions", `${id}.json`);

        if (operation === "remove") await observer.remove(creator, team.id, member.id);
        else await observer.delete(creator, team.id);
        await observer.tick();
        expect(existsSync(path)).toBe(true);
        expect(f.agents.has(id)).toBe(true);

        if (releaseOwner) { await owner.dispose(); await observer.tick(); }
        else await origin.tick();
        expect(existsSync(path)).toBe(false);
        expect(f.agents.has(id)).toBe(false);
        expect(f.created).toHaveLength(1);
        expect(f.resumed).toHaveLength(0);
        expect(origin.status(creator, team.id).status).toBe(operation === "delete" ? "deleted" : "paused");
      });
    }
  }

  it("maps the installed DSH SessionStore's actual user, assistant and terminal envelopes", async () => {
    const f = fixture(); const adapter = f.makeAdapter();
    const ctx = new Context();
    const fiber = await ctx.plugin(SessionStore as never, {} as never);
    cleanups.push(() => fiber.dispose());
    const session = ctx.sessions.create(SessionId("actual-session"), { meta: { cwd: f.directory } });
    session.append("turn/start", { turn: 1 });
    session.append("user/message", { id: MessageId("actual-prompt"), role: "user", source: { kind: "user" },
      content: [{ type: "text", text: "[rolebox-team actual-delivery]" }] }, { surfaceOp: "append" });
    session.append("assistant/message", { turn: 1, step: 1, stream: [], message: { id: MessageId("actual-answer"), role: "assistant",
      source: { kind: "model", provider: "example-provider", model: "example-model" }, content: [{ type: "text", text: "Actual output" }] } }, { surfaceOp: "append" });
    session.append("turn/end", { turn: 1, reason: { kind: "error", error: { message: "model failed", code: "UNKNOWN" } } });
    f.stored.set(session.id, [...session.snapshotEvents()]);
    const messages = await adapter.messages(session.id);
    expect(messages.find(message => message.info.id === "actual-prompt")?.parts[0]).toMatchObject({ text: "[rolebox-team actual-delivery]" });
    expect(messages.find(message => message.info.id === "actual-answer")?.parts[0]).toMatchObject({ text: "Actual output" });
    expect(messages.at(-1)?.info).toMatchObject({ role: "idle", finish: "failed", error: { message: "model failed" } });
  });
});
