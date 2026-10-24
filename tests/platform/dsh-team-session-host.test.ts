import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import LlmRuntime, { LlmAdapter, type StreamChunk } from "@deepseek-ai/dsh-llm";
import SessionStore, { type SessionEvent, type SessionHeader } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { DshTeamSessionAdapter, type DshTeamAgentOptions, type DshTeamAgents } from "../../src/platform/adapters/dsh/team-session.ts";
import type { DshSessionStoreLike } from "../../src/platform/adapters/dsh/session.ts";

interface StoredSession {
  header: SessionHeader;
  events: SessionEvent[];
  owned: boolean;
}

class MemoryPersistence extends Service {
  readonly records = new Map<string, StoredSession>();

  constructor(ctx: Context) {
    super(ctx, "sessionPersistence");
    ctx.on("session/event", (session, event) => {
      const stored = this.records.get(session.id);
      if (stored && stored.events.length === event.seq) stored.events.push(structuredClone(event));
    });
    ctx.on("session/flush", async session => {
      const stored = this.records.get(session.id);
      if (!stored) throw new Error("Session is not persisted");
      stored.events = structuredClone([...session.snapshotEvents()]);
    });
  }

  async create(header: SessionHeader) {
    if (this.records.has(header.id)) throw new Error("Session already exists");
    this.records.set(header.id, { header: structuredClone(header), events: [], owned: false });
    return this.open(header.id, "write");
  }

  async open(id: string, access: "read" | "write") {
    const stored = this.records.get(id);
    if (!stored) throw new Error("Session does not exist");
    if (access === "write" && stored.owned) throw new Error("Session already owned");
    if (access === "write") stored.owned = true;
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      if (access === "write") stored.owned = false;
    };
    return {
      id, access, header: stored.header, inheritedEventCount: 0,
      async read(offset = 0, length?: number) {
        return { eventState: "detached", events: structuredClone(stored.events.slice(offset, length === undefined ? undefined : offset + length)) };
      },
      async append(events: readonly SessionEvent[]) {
        if (closed || access !== "write") throw new Error("Session handle is not writable");
        for (const event of events) {
          if (event.seq !== stored.events.length) throw new Error("Non-contiguous append");
          stored.events.push(structuredClone(event));
        }
      },
      async flush() {},
      close,
      [Symbol.asyncDispose]: close,
    };
  }
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "dsh-team-host-test-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const ctx = new Context();
  const persistence = new MemoryPersistence(ctx);
  for (const plugin of [SessionStore, SessionProjectionRegistry, AgentRegistry, LlmRuntime, SystemPrompt, ToolRuntime, AgentLoop]) {
    const fiber = await ctx.plugin(plugin as never, {} as never);
    cleanups.push(() => fiber.dispose());
  }
  const bound = new Map<string, string>();
  const published: string[] = [];
  let agentOptions: DshTeamAgentOptions = { provider: "example-provider", model: "example-model" };
  ctx.on("agent/created", ({ agent }) => {
    expect(bound.get(agent.id)).toBe("designer");
    published.push(agent.id);
    return undefined;
  });
  const adapter = () => {
    const instance = new DshTeamSessionAdapter({
      directory,
      sessions: ctx.sessions as unknown as DshSessionStoreLike,
      agents: ctx.agents as unknown as DshTeamAgents,
      bindRole(id, role) { bound.set(id, role); },
      resolveRole(role) { return role === "designer" ? { agentOptions: { ...agentOptions } } : undefined; },
      async readExecutionEvents(id) { return persistence.records.get(id)?.events; },
    });
    cleanups.push(() => instance.dispose());
    return instance;
  };
  return { directory, ctx, persistence, adapter, published,
    setRoleOptions(options: DshTeamAgentOptions) { agentOptions = options; } };
}

describe("DSH team adapter with the installed agent host", () => {
  it("delivers a successful model turn through the real driver and terminal log", async () => {
    const f = await fixture();
    class ScriptedAdapter extends LlmAdapter {
      async *stream(): AsyncIterable<StreamChunk> {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "block-end", index: 0, block: { type: "text", text: "Design ready" } };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
    f.ctx.llm.registerAdapter(["example-provider"], new ScriptedAdapter());
    const adapter = f.adapter();
    const id = (await adapter.create({ directory: f.directory, agent: "designer" }))!.id;
    await adapter.prompt(id, { agent: "designer", parts: [{ type: "text", text: "[rolebox-team actual-success]\nPrepare a design" }] });
    await f.ctx.agents.get(id as never)!.whenIdle();
    const messages = await adapter.messages(id);
    expect(messages.at(-1)?.info).toMatchObject({ role: "idle", finish: "succeeded" });
    expect(messages.at(-2)?.parts[0]).toMatchObject({ type: "text", text: "Design ready" });
  });

  it("repairs a resident driver's actual model without losing queued user input", async () => {
    const f = await fixture();
    const calls: Array<{ provider: string; model: string; maxTokens?: number }> = [];
    class ScriptedAdapter extends LlmAdapter {
      async *stream(options: Parameters<LlmAdapter["stream"]>[0]): AsyncIterable<StreamChunk> {
        calls.push({ provider: options.provider, model: options.model, maxTokens: options.maxTokens });
        if (options.model === "example-model") throw new Error("Model is no longer available");
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "block-end", index: 0, block: { type: "text", text: options.model } };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
    f.ctx.llm.registerAdapter(["example-provider", "repaired-provider"], new ScriptedAdapter());
    f.setRoleOptions({ provider: "example-provider", model: "example-model", maxTokens: 1024 });
    const adapter = f.adapter();
    const id = (await adapter.create({ directory: f.directory, agent: "designer" }))!.id;
    await adapter.prompt(id, { agent: "designer", parts: [{ type: "text", text: "[rolebox-team original]" }] });
    const original = f.ctx.agents.get(id as never)!;
    await original.whenIdle();
    expect((await adapter.messages(id)).at(-1)?.info.finish).toBe("failed");
    original.inject({ id: "user-pending" as never, role: "user", source: { kind: "user" },
      content: [{ type: "text", text: "Keep this user request" }] });
    f.setRoleOptions({ provider: "repaired-provider", model: "repaired-model" });

    for (const delivery of ["repaired", "following"]) {
      await adapter.prompt(id, { agent: "designer", parts: [{ type: "text", text: `[rolebox-team ${delivery}]` }] });
      await f.ctx.agents.get(id as never)!.whenIdle();
      expect((await adapter.messages(id)).at(-1)?.info).toMatchObject({ finish: "succeeded" });
    }

    expect(calls).toEqual([
      { provider: "example-provider", model: "example-model", maxTokens: 1024 },
      { provider: "repaired-provider", model: "repaired-model", maxTokens: undefined },
      { provider: "repaired-provider", model: "repaired-model", maxTokens: undefined },
    ]);
    expect(f.ctx.agents.get(id as never)).toBe(original);
    expect(f.published).toEqual([id]);
    const messages = await adapter.messages(id);
    expect(messages.at(-1)?.info.finish).toBe("succeeded");
    expect(messages.flatMap(message => message.parts).some(part => part.type === "text" && part.text === "Keep this user request")).toBe(true);

    f.setRoleOptions({ provider: "example-provider", model: "other-model" });
    const other = (await adapter.create({ directory: f.directory, agent: "designer" }))!.id;
    await adapter.prompt(other, { parts: [{ type: "text", text: "[rolebox-team other-member]" }] });
    await f.ctx.agents.get(other as never)!.whenIdle();
    expect(calls.at(-1)).toEqual({ provider: "example-provider", model: "other-model", maxTokens: undefined });
  });

  it("creates and restores the same real agent, binds before publication, and reports the actual failed model turn", async () => {
    const f = await fixture();
    const first = f.adapter();
    const created = await first.create({ directory: f.directory, agent: "designer" });
    expect(created).not.toBeNull();
    const id = created!.id;
    expect(f.published).toEqual([id]);
    expect(f.ctx.agents.get(id as never)?.status).toBe("idle");
    expect(f.persistence.records.has(id)).toBe(true);

    const marker = "[rolebox-team actual-host-first]\nPrepare a design";
    await first.prompt(id, { agent: "designer", parts: [{ type: "text", text: marker }] });
    await f.ctx.agents.get(id as never)!.whenIdle();
    const messages = await first.messages(id);
    expect(messages.at(-1)?.info).toMatchObject({ role: "idle", finish: "failed" });
    expect(messages.some(message => message.parts.some(part => part.type === "text" && part.text === marker))).toBe(true);

    await first.dispose();
    expect(f.ctx.agents.get(id as never)).toBeUndefined();
    const restored = f.adapter();
    expect((await restored.messages(id)).at(-1)?.info.finish).toBe("failed");
    expect(f.published).toEqual([id]);
    await restored.prompt(id, { agent: "designer", parts: [{ type: "text", text: "[rolebox-team actual-host-second]\nContinue the design" }] });
    await f.ctx.agents.get(id as never)!.whenIdle();
    expect(f.published).toEqual([id, id]);
    expect((await restored.messages(id)).filter(message => message.info.role === "idle")).toHaveLength(2);
    expect(await restored.abort(id)).toBe(true);
  });

  it("cold-reads a crash snapshot without waking it and replaces only stale team inbox messages on resume", async () => {
    const f = await fixture();
    const first = f.adapter();
    const id = (await first.create({ directory: f.directory, agent: "designer" }))!.id;
    const stale = "[rolebox-team abandoned-delivery]\nOld team work";
    await first.prompt(id, { agent: "designer", noReply: true, parts: [{ type: "text", text: stale }] });
    f.ctx.agents.get(id as never)!.inject({ id: "user-pending" as never, role: "user", source: { kind: "user" },
      content: [{ type: "text", text: "Keep this user request" }] });
    await first.messages(id);
    const crashSnapshot = structuredClone(f.persistence.records.get(id)!.events);
    await first.dispose();
    f.persistence.records.get(id)!.events = crashSnapshot;

    const restored = f.adapter();
    expect(await restored.status(id)).toEqual({ type: "idle" });
    expect(await restored.messages(id)).toEqual([]);
    expect(f.ctx.agents.get(id as never)).toBeUndefined();
    expect(f.published).toEqual([id]);

    const replacement = "[rolebox-team replacement-delivery]\nNew authorized team work";
    await restored.prompt(id, { agent: "designer", parts: [{ type: "text", text: replacement }] });
    await f.ctx.agents.get(id as never)!.whenIdle();
    const text = (await restored.messages(id)).flatMap(message => message.parts.flatMap(part => part.type === "text" ? [part.text] : []));
    expect(text).toContain("Keep this user request");
    expect(text).toContain(replacement);
    expect(text).not.toContain(stale);
    expect(f.published).toEqual([id, id]);
  });
});
