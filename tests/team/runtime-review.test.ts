import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ISessionClient } from "../../src/platform/ports/session-client.ts";
import type { Message, SessionInfo } from "../../src/platform/types.ts";
import type { ResolvedRole } from "../../src/types.ts";
import { TeamRuntime } from "../../src/team/runtime.ts";

const roots: string[] = [];
const runtimes: TeamRuntime[] = [];
const actor = { sessionID: "owner-session", agent: "owner" };
const roles = ["owner", "designer"].map(id => ({ id, config: { name: id } })) as ResolvedRole[];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(overrides: Partial<ISessionClient> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "team-runtime-review-"));
  roots.push(directory);
  const transcripts = new Map<string, Message[]>();
  const customPrompt = overrides.prompt;
  const session = {
    status: async () => ({ type: "idle" }),
    messages: async (id: string) => transcripts.get(id) ?? [],
    create: async () => ({ id: "peer-session" }),
    abort: async () => true,
    ...overrides,
    prompt: async (id: string, options: Parameters<ISessionClient["prompt"]>[1]) => {
      const response = customPrompt ? await customPrompt(id, options) : { id: `prompt-${transcripts.get(id)?.length ?? 0}` };
      if (response) {
        const messages = transcripts.get(id) ?? [];
        messages.push({ info: { id: response.id, role: "user", time: { created: Date.now() } }, parts: options.parts } as unknown as Message);
        transcripts.set(id, messages);
      }
      return response;
    },
  } as ISessionClient;
  function runtime(platformId = "platform-one") {
    const instance = new TeamRuntime({ directory, platformId, session, roles: () => roles, canPollStatus: true });
    runtimes.push(instance);
    return instance;
  }
  return { runtime, session, transcripts };
}

describe("team runtime concurrency review", () => {
  it("never cancels the user's creator session when deletion races its prompt", async () => {
    const entered = deferred<void>();
    const response = deferred<{ id: string }>();
    const aborted: string[] = [];
    const { runtime } = await fixture({
      prompt: async id => {
        if (id === actor.sessionID) { entered.resolve(); return response.promise; }
        return { id: "peer-prompt" };
      },
      abort: async id => { aborted.push(id); return true; },
    });
    const instance = runtime();
    const team = instance.create(actor, "Review", "Review creator lifetime");
    instance.add(actor, team.id, "designer");
    await instance.tick();
    instance.send({ agent: "designer", sessionID: "peer-session" }, team.id, { kind: "message", content: "Please review" });
    const pumping = instance.tick();
    await entered.promise;
    try {
      await instance.delete(actor, team.id);
    } finally {
      response.resolve({ id: "creator-prompt" });
      await pumping;
    }
    expect(aborted).toEqual(["peer-session"]);
    expect(instance.status(actor, team.id).status).toBe("deleted");
  });

  it("rejects writes from a different host even when actor identities collide", async () => {
    const { runtime } = await fixture();
    const first = runtime();
    const second = runtime("platform-two");
    const team = first.create(actor, "Review", "Review isolation");
    expect(() => second.add(actor, team.id, "designer")).toThrow();
    expect(() => second.send(actor, team.id, { kind: "message", content: "Foreign host" })).toThrow();
    await expect(second.resume(actor, team.id)).rejects.toThrow();
    expect(first.status(actor, team.id)).toEqual(team);
  });

  it("serializes removal, deletion, and resumption until cancellation has finished", async () => {
    const cancellation = deferred<boolean>();
    let aborts = 0;
    const { runtime } = await fixture({ abort: async () => ++aborts === 1 ? cancellation.promise : true });
    const instance = runtime();
    const team = instance.create(actor, "Review", "Review cancellation");
    const member = instance.add(actor, team.id, "designer");
    await instance.tick();
    const removing = instance.remove(actor, team.id, member.id);
    try {
      await expect(instance.delete(actor, team.id)).rejects.toThrow();
      await expect(instance.resume(actor, team.id)).rejects.toThrow();
      expect(instance.status(actor, team.id).status).toBe("paused");
    } finally {
      cancellation.resolve(true);
      await removing;
    }
    expect(instance.status(actor, team.id).members.find(item => item.id === member.id)?.status).toBe("removed");
    await instance.delete(actor, team.id);
    expect(instance.status(actor, team.id).status).toBe("deleted");
    await expect(instance.resume(actor, team.id)).rejects.toThrow();
  });

  it("can retry after the host fails to create a member session", async () => {
    let creates = 0;
    const { runtime } = await fixture({ create: async () => ++creates === 1 ? null : { id: "peer-session" } as SessionInfo });
    const instance = runtime();
    const team = instance.create(actor, "Review", "Review creation failure");
    const member = instance.add(actor, team.id, "designer");
    await instance.tick();
    const failed = instance.status(actor, team.id);
    expect(failed.status).toBe("paused");
    expect(failed.members.find(item => item.id === member.id)?.delivery).toBeUndefined();
    await instance.resume(actor, team.id);
    await instance.tick();
    expect(creates).toBe(2);
    expect(instance.status(actor, team.id).members.find(item => item.id === member.id)?.delivery).toBeDefined();
  });

  it("replays unacknowledged events after a failed member turn is resumed", async () => {
    let prompts = 0;
    const { runtime, transcripts } = await fixture({
      prompt: async () => ({ id: `prompt-${++prompts}` }),
    });
    const instance = runtime();
    const team = instance.create(actor, "Review", "Review failed turn retry");
    const member = instance.add(actor, team.id, "designer");
    await instance.tick();
    transcripts.get("peer-session")!.push({ info: { id: "failed-turn", role: "assistant", time: { created: 1, completed: 2 }, finish: "error" }, parts: [] } as unknown as Message);
    await instance.tick();
    expect(instance.status(actor, team.id).status).toBe("paused");
    expect(instance.status(actor, team.id).members.find(item => item.id === member.id)?.cursor).toBe(0);
    await instance.resume(actor, team.id);
    await instance.tick();
    expect(prompts).toBe(2);
  });

  it("acknowledges a durable completed turn before resuming another member failure", async () => {
    let prompts = 0;
    const cancelled: string[] = [];
    const { runtime, transcripts } = await fixture({
      prompt: async () => ({ id: `prompt-${++prompts}` }),
      abort: async id => { cancelled.push(id); return true; },
    });
    const instance = runtime();
    const team = instance.create(actor, "Review", "Keep confirmed work acknowledged during resume");
    const member = instance.add(actor, team.id, "designer");
    await instance.tick();
    const throughSeq = instance.status(actor, team.id).members.find(item => item.id === member.id)!.delivery!.throughSeq;
    transcripts.get("peer-session")!.push({ info: { id: "completed-turn", role: "assistant", time: { created: 1, completed: 2 }, finish: "stop" }, parts: [] } as unknown as Message);
    await instance.handleEvent({ type: "session.error", properties: { sessionID: actor.sessionID } });
    expect(instance.status(actor, team.id).status).toBe("paused");
    await instance.resume(actor, team.id);
    const completed = instance.status(actor, team.id).members.find(item => item.id === member.id)!;
    expect(completed.cursor).toBe(throughSeq);
    expect(completed.delivery).toBeUndefined();
    expect(cancelled).not.toContain("peer-session");
    await instance.tick();
    expect(prompts).toBe(1);
  });

  it("does not acknowledge an unrelated final that arrived before the delivery marker", async () => {
    const entered = deferred<void>();
    const response = deferred<{ id: string } | null>();
    const { runtime, transcripts } = await fixture({ prompt: async () => { entered.resolve(); return response.promise; } });
    const first = runtime();
    const observer = runtime();
    const team = first.create(actor, "Review", "Review completion attribution");
    const member = first.add(actor, team.id, "designer");
    const pumping = first.tick();
    await entered.promise;
    try {
      transcripts.set("peer-session", [{ info: { id: "unrelated-final", role: "assistant", time: { created: 1, completed: 2 }, finish: "stop" }, parts: [] } as unknown as Message]);
      await observer.tick();
      const pending = observer.status(actor, team.id).members.find(item => item.id === member.id)!;
      expect(pending.cursor).toBe(0);
      expect(pending.delivery).toBeDefined();
    } finally {
      response.resolve({ id: "team-prompt" });
      await pumping;
    }
    transcripts.get("peer-session")!.push({ info: { id: "team-final", role: "assistant", time: { created: 3, completed: 4 }, finish: "stop" }, parts: [] } as unknown as Message);
    await observer.tick();
    const completed = observer.status(actor, team.id).members.find(item => item.id === member.id)!;
    expect(completed.cursor).toBeGreaterThan(0);
    expect(completed.delivery).toBeUndefined();
  });

  it("holds one durable session lease when two teams wake their shared creator", async () => {
    let sessions = 0;
    const prompted: string[] = [];
    const { runtime } = await fixture({
      create: async () => ({ id: `peer-${++sessions}` } as SessionInfo),
      prompt: async id => { prompted.push(id); return { id: `prompt-${prompted.length}` }; },
    });
    const instance = runtime();
    const first = instance.create(actor, "First", "First team");
    const second = instance.create(actor, "Second", "Second team");
    instance.add(actor, first.id, "designer");
    instance.add(actor, second.id, "designer");
    await instance.tick();
    for (const team of [first, second]) {
      const peer = instance.status(actor, team.id).members.find(member => member.roleId === "designer")!;
      instance.send({ agent: "designer", sessionID: peer.sessionId! }, team.id, { kind: "message", content: "Design is ready for review" });
    }
    await instance.tick();
    expect(prompted.filter(id => id === actor.sessionID)).toHaveLength(1);
    const creatorDeliveries = [first, second].flatMap(team => {
      const creator = instance.status(actor, team.id).members.find(member => member.roleId === "owner")!;
      return creator.delivery ? [creator.delivery] : [];
    });
    expect(creatorDeliveries).toHaveLength(1);
  });

  it("keeps deletion terminal when an in-flight prompt reports failure", async () => {
    const entered = deferred<void>();
    const response = deferred<{ id: string } | null>();
    const { runtime } = await fixture({ prompt: async () => { entered.resolve(); return response.promise; } });
    const instance = runtime();
    const team = instance.create(actor, "Review", "Review in-flight failure");
    instance.add(actor, team.id, "designer");
    const pumping = instance.tick();
    await entered.promise;
    try {
      await instance.delete(actor, team.id);
    } finally {
      response.resolve(null);
      await pumping;
    }
    expect(instance.status(actor, team.id).status).toBe("deleted");
  });

  it("reconciles an interrupted reservation after runtime replacement in the same process", async () => {
    const entered = deferred<void>();
    const created = deferred<Awaited<ReturnType<ISessionClient["create"]>>>();
    const { runtime } = await fixture({ create: async () => { entered.resolve(); return created.promise; } });
    const first = runtime();
    const team = first.create(actor, "Review", "Review runtime replacement");
    const member = first.add(actor, team.id, "designer");
    const pumping = first.tick();
    await entered.promise;
    const disposing = first.dispose();
    created.resolve({ id: "peer-session" } as Awaited<ReturnType<ISessionClient["create"]>>);
    await pumping;
    await disposing;
    const second = runtime();
    await second.tick();
    const recovered = second.status(actor, team.id);
    expect(recovered.status).toBe("paused");
    await second.resume(actor, team.id);
    expect(second.status(actor, team.id).members.find(item => item.id === member.id)?.delivery).toBeUndefined();
  });
});
