import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ISessionClient } from "../../src/platform/ports/session-client.ts";
import type { Message, SessionStatus } from "../../src/platform/types.ts";
import type { ResolvedRole } from "../../src/types.ts";
import { TeamRuntime } from "../../src/team/runtime.ts";
import { TeamStore } from "../../src/team/store.ts";

const owner = { sessionID: "owner", agent: "developer" };
const directories: string[] = [];
const runtimes: TeamRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * Build a team fixture. `memberProblem` models the host's role-model gate (the
 * dsh entry's "no usable provider/model" check) so its precedence against
 * authorization and team state can be pinned.
 */
function setup(memberProblem?: (roleId: string) => string | undefined) {
  const directory = mkdtempSync(join(tmpdir(), "team-runtime-"));
  directories.push(directory);
  const roles = ["developer", "designer", "reviewer"].map(id => ({ id, config: { name: id }, subagents: [] }) as unknown as ResolvedRole);
  const messages = new Map<string, Message[]>();
  const statuses = new Map<string, SessionStatus>([["owner", { type: "busy" }]]);
  const prompts: Array<{ id: string; text: string }> = [];
  let nextSession = 0;
  let accept = true;
  let aborted = true;
  const session = {
    async create() { const id = `peer-${++nextSession}`; statuses.set(id, { type: "idle" }); return { id }; },
    async prompt(id: string, options: { parts: Array<{ text: string }> }) {
      prompts.push({ id, text: options.parts[0].text });
      if (!accept) return null;
      statuses.set(id, { type: "busy" });
      const messageId = `prompt-${prompts.length}`;
      messages.set(id, [...(messages.get(id) ?? []), {
        info: { id: messageId, sessionID: id, role: "user", time: { created: Date.now() } },
        parts: [{ type: "text", id: messageId, messageID: messageId, sessionID: id, text: options.parts[0].text }],
      }]);
      return { id: `prompt-${prompts.length}` };
    },
    async status(id: string) { return statuses.get(id) ?? null; },
    async messages(id: string) { return messages.get(id) ?? []; },
    async abort(id: string) { if (aborted) statuses.set(id, { type: "idle" }); return aborted; },
  } as unknown as ISessionClient;
  function make(platformId = "opencode") {
    const runtime = new TeamRuntime({ directory, platformId, session, roles: () => roles, canPollStatus: true,
      ...(memberProblem ? { memberProblem } : {}) });
    runtimes.push(runtime);
    return runtime;
  }
  const runtime = make();
  const team = runtime.create(owner, "Screen", "Design and implement the screen");
  // Adding a member only records membership; the first woken event starts it.
  function wake(content = "Start the collaboration") {
    runtime.send(owner, team.id, { kind: "message", content });
  }
  async function wakePeer(content?: string) {
    wake(content);
    await runtime.tick();
  }
  function finish(id: string, messageId = `final-${id}`) {
    statuses.set(id, { type: "idle" });
    messages.set(id, [...(messages.get(id) ?? []), { info: { id: messageId, sessionID: id, role: "assistant", finish: "stop", time: { created: 1, completed: 2 } },
      parts: [{ type: "text", id: "part", messageID: messageId, sessionID: id, text: "Design ready" }] }]);
  }
  /** A host turn that ended in a structured error, as dsh reports it. */
  function fail(id: string, reason: string, messageId = `failed-${id}`) {
    statuses.set(id, { type: "idle" });
    messages.set(id, [...(messages.get(id) ?? []), { info: { id: `${messageId}-reply`, sessionID: id, role: "assistant", time: { created: 1 } }, parts: [] },
      { info: { id: messageId, sessionID: id, role: "idle", finish: "failed", error: { message: reason, code: "MODEL_ERROR" },
        time: { created: 1, completed: 2 } }, parts: [] }]);
  }
  return { runtime, team, make, finish, fail, wake, wakePeer, prompts, messages, statuses, directory,
    accept(value: boolean) { accept = value; }, abort(value: boolean) { aborted = value; } };
}

describe("durable team runtime", () => {
  it("settles a durable final before applying an expired delivery timeout after restart", async () => {
    const f = setup();
    f.runtime.add(owner, f.team.id, "designer");
    await f.wakePeer();
    f.finish("peer-1");
    const store = new TeamStore(join(f.directory, ".rolebox", "team"));
    store.update(f.team.id, state => { state.members[1].delivery!.startedAt = Date.now() - 60 * 60_000; });
    store.close();
    await f.runtime.dispose();
    const recovered = f.make();
    await recovered.tick();
    const state = recovered.status(owner, f.team.id);
    expect(state.status).toBe("active");
    expect(state.members[1].delivery).toBeUndefined();
    expect(state.members[1].cursor).toBe(3);
    expect(state.events.filter(event => event.type === "turn_completed")).toHaveLength(1);
    expect(f.prompts).toHaveLength(1);
  });

  it("waits for the host to confirm an evicted creator is idle despite cached events", async () => {
    const f = setup();
    f.runtime.add(owner, f.team.id, "designer");
    await f.wakePeer();
    f.runtime.send({ sessionID: "peer-1", agent: "designer" }, f.team.id, { kind: "message", content: "Ready for review" });
    f.statuses.delete("owner");
    await f.runtime.handleEvent({ type: "session.idle", rawType: "session.idle", properties: { sessionID: "owner" } });
    await f.runtime.tick();
    expect(f.prompts.map(prompt => prompt.id)).toEqual(["peer-1"]);
    f.statuses.set("owner", { type: "idle" });
    await f.runtime.tick();
    expect(f.prompts.map(prompt => prompt.id)).toEqual(["peer-1", "owner"]);
  });

  it("binds a peer session, claims tasks atomically, and rejects nonmembers or private roles", async () => {
    const f = setup();
    const peer = f.runtime.add(owner, f.team.id, "designer");
    expect(() => f.runtime.add(owner, f.team.id, "developer--private")).toThrow("top-level");
    await f.wakePeer();
    const actual = f.runtime.status(owner, f.team.id).members.find(m => m.id === peer.id)!;
    const actor = { sessionID: actual.sessionId!, agent: "designer" };
    const offer = f.runtime.send(owner, f.team.id, { kind: "task_offer", content: "Design the screen" });
    // A task can only be completed or released after a member claimed it.
    expect(() => f.runtime.send(owner, f.team.id, { kind: "task_complete", content: "not claimed yet", task_id: offer.taskId })).toThrow("Task is not claimed");
    expect(() => f.runtime.send(owner, f.team.id, { kind: "task_release", content: "nothing to release", task_id: offer.taskId })).toThrow("Task is not claimed");
    f.runtime.send(actor, f.team.id, { kind: "task_claim", content: "I will design", task_id: offer.taskId });
    expect(() => f.runtime.send(owner, f.team.id, { kind: "task_claim", content: "I will take it", task_id: offer.taskId })).toThrow("already claimed");
    expect(() => f.runtime.send({ ...actor, sessionID: "unrelated" }, f.team.id, { kind: "message", content: "spoof" })).toThrow("not an active member");
    expect(() => f.runtime.send(owner, f.team.id, { kind: "task_complete", content: "not mine", task_id: offer.taskId })).toThrow("current task owner");
    f.runtime.send(actor, f.team.id, { kind: "task_complete", content: "Design spec", task_id: offer.taskId });
    expect(f.runtime.status(owner, f.team.id).tasks[0]).toMatchObject({ status: "completed", owner: peer.id, result: "Design spec" });
    expect(() => f.runtime.send(actor, f.team.id, { kind: "task_complete", content: "again", task_id: offer.taskId })).toThrow("Task is already completed");
    expect(() => f.runtime.send(actor, f.team.id, { kind: "task_claim", content: "reclaim", task_id: offer.taskId })).toThrow("Task is already completed");
    // The rejected branches left the completed task untouched.
    expect(f.runtime.status(owner, f.team.id).tasks[0]).toMatchObject({ status: "completed", result: "Design spec" });
  });

  it("reports authorization and team state before a member's role-model problem", async () => {
    const f = setup(() => "no usable provider/model");
    const outsider = { sessionID: "unrelated", agent: "designer" };

    // A call that may not change membership is told exactly that; the model
    // gate belongs to a call that reached the mutation.
    expect(() => f.runtime.add(outsider, f.team.id, "designer")).toThrow("not an active member");
    // The creator passes the checks and still gets the real role-model reason,
    // with no member recorded.
    expect(() => f.runtime.add(owner, f.team.id, "designer")).toThrow("no usable provider/model");
    expect(f.runtime.status(owner, f.team.id).members.map(member => member.roleId)).toEqual(["developer"]);
    // A deleted team reports its own state rather than the model problem.
    await f.runtime.delete(owner, f.team.id);
    expect(() => f.runtime.add(owner, f.team.id, "designer")).toThrow("Team is deleted");
  });

  it("deduplicates turns and does not wake agents for completion or membership notices", async () => {
    const f = setup();
    f.runtime.add(owner, f.team.id, "designer");
    await f.wakePeer();
    f.finish("peer-1");
    await f.runtime.tick();
    await f.runtime.tick();
    const state = f.runtime.status(owner, f.team.id);
    expect(state.events.filter(e => e.type === "turn_completed")).toHaveLength(1);
    expect(state.members[1].cursor).toBe(3);
    expect(f.prompts).toHaveLength(1);
  });

  it("publishes turn status without disclosing a member's private final transcript", async () => {
    const f = setup();
    f.runtime.add(owner, f.team.id, "designer");
    await f.wakePeer();
    f.finish("peer-1");
    const final = f.messages.get("peer-1")!.at(-1)!;
    final.parts = [{ type: "text", id: "private", messageID: final.info.id, sessionID: "peer-1",
      text: "Internal work used designer--private-review and its private skill." }];
    await f.runtime.tick();
    const state = f.runtime.status(owner, f.team.id);
    expect(state.events.some(event => event.type === "turn_completed" && !event.wake)).toBe(true);
    expect(JSON.stringify(state.events)).not.toContain("designer--private-review");
    expect(f.messages.get("peer-1")!.at(-1)!.parts).toEqual(final.parts);
    expect(f.prompts).toHaveLength(1);
  });

  it("coalesces messages while a member is busy, then delivers once", async () => {
    const f = setup();
    f.runtime.add(owner, f.team.id, "designer");
    await f.wakePeer();
    f.runtime.send(owner, f.team.id, { kind: "message", content: "Use a warm palette" });
    f.runtime.send(owner, f.team.id, { kind: "message", content: "Check contrast" });
    await f.runtime.tick();
    expect(f.prompts).toHaveLength(1);
    f.finish("peer-1");
    await f.runtime.tick();
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1].text).toContain("Check contrast");
    expect(f.prompts[1].text).toContain("Use a warm palette");
  });

  it("recovers a completed in-flight delivery without executing it again", async () => {
    const f = setup();
    f.runtime.add(owner, f.team.id, "designer");
    await f.wakePeer();
    await f.runtime.dispose();
    f.finish("peer-1");
    const recovered = f.make();
    await recovered.tick();
    expect(recovered.status(owner, f.team.id).members[1].delivery).toBeUndefined();
    expect(f.prompts).toHaveLength(1);
  });

  it("pauses ambiguous delivery and preserves its cursor until confirmed cancellation and resumption", async () => {
    const f = setup();
    f.runtime.add(owner, f.team.id, "designer");
    f.accept(false);
    await f.wakePeer();
    let state = f.runtime.status(owner, f.team.id);
    expect(state.status).toBe("paused");
    expect(state.members[1].cursor).toBe(0);
    expect(state.members[1].delivery).toBeDefined();
    f.abort(false);
    await expect(f.runtime.resume(owner, f.team.id)).rejects.toThrow("not confirmed");
    f.abort(true);
    f.accept(true);
    await f.runtime.resume(owner, f.team.id);
    await f.runtime.tick();
    expect(f.prompts).toHaveLength(2);
    state = f.runtime.status(owner, f.team.id);
    expect(state.status).toBe("active");
  });

  it("uses durable reservations across runtimes and retains a hard turn budget", async () => {
    const f = setup();
    f.runtime.add(owner, f.team.id, "designer");
    const second = f.make();
    f.wake();
    await Promise.all([f.runtime.tick(), second.tick()]);
    expect(f.prompts).toHaveLength(1);
    const store = new TeamStore(join(f.directory, ".rolebox", "team"));
    store.update(f.team.id, state => { state.maxTurns = 1; });
    store.close();
    f.finish("peer-1");
    f.runtime.send(owner, f.team.id, { kind: "message", content: "One more revision" });
    await second.tick();
    expect(second.status(owner, f.team.id).status).toBe("paused");
    expect(f.prompts).toHaveLength(1);
    await expect(second.resume(owner, f.team.id)).rejects.toThrow("budget exhausted");
  });

  it("prevents another host platform from mutating a team even with colliding identities", () => {
    const f = setup();
    const otherHost = f.make("other");
    expect(() => otherHost.add(owner, f.team.id, "designer")).toThrow("another host");
    expect(() => otherHost.send(owner, f.team.id, { kind: "message", content: "collision" })).toThrow("another host");
  });

  it("broadcasts departure, releases claims, and retains a closed team's history", async () => {
    const f = setup();
    const peer = f.runtime.add(owner, f.team.id, "designer");
    await f.wakePeer();
    const offer = f.runtime.send(owner, f.team.id, { kind: "task_offer", content: "Design" });
    f.runtime.send({ sessionID: "peer-1", agent: "designer" }, f.team.id, { kind: "task_claim", content: "Claim", task_id: offer.taskId });
    await f.runtime.remove(owner, f.team.id, peer.id);
    const state = f.runtime.status(owner, f.team.id);
    expect(state.status).toBe("paused");
    expect(state.tasks[0].status).toBe("offered");
    expect(state.events.at(-1)?.type).toBe("member_left");
    await f.runtime.delete(owner, f.team.id);
    expect(f.runtime.status(owner, f.team.id).status).toBe("deleted");
    expect(() => f.runtime.send(owner, f.team.id, { kind: "message", content: "late" })).toThrow("deleted");
  });

  it("releases expired claims and wakes peers, while a running owner keeps its claim", async () => {
    const f = setup();
    f.runtime.add(owner, f.team.id, "designer");
    await f.wakePeer();
    const offer = f.runtime.send(owner, f.team.id, { kind: "task_offer", content: "Design" });
    f.runtime.send({ sessionID: "peer-1", agent: "designer" }, f.team.id, { kind: "task_claim", content: "Claim", task_id: offer.taskId });
    const store = new TeamStore(join(f.directory, ".rolebox", "team"));
    store.update(f.team.id, state => { state.tasks[0].leaseUntil = 0; });
    store.close();
    await f.runtime.tick();
    expect(f.runtime.status(owner, f.team.id).tasks[0].status).toBe("claimed");
    f.finish("peer-1");
    await f.runtime.tick();
    await f.runtime.tick();
    // Another queued task event may start a new owner turn; complete it before the lease can be released.
    if (f.runtime.status(owner, f.team.id).members[1].delivery) { f.finish("peer-1", "second-final"); await f.runtime.tick(); }
    await f.runtime.tick();
    expect(f.runtime.status(owner, f.team.id).tasks[0].status).toBe("offered");
    expect(f.runtime.status(owner, f.team.id).events.some(e => e.sender === "system" && e.type === "task_release")).toBe(true);
  });

  it("does not let a managed peer create independent teams to reset its turn budget", async () => {
    const f = setup();
    f.runtime.add(owner, f.team.id, "designer");
    await f.wakePeer();
    expect(() => f.runtime.create({ sessionID: "peer-1", agent: "designer" }, "Nested", "More work")).toThrow("existing team");
  });

  it("keeps a failed turn's real reason, refunds its turn, and replays the pending event after resume", async () => {
    const f = setup();
    f.runtime.add(owner, f.team.id, "designer");
    await f.wakePeer();
    const delivered = f.runtime.status(owner, f.team.id).members[1].delivery!;
    expect(f.runtime.status(owner, f.team.id).turns).toBe(1);

    f.fail("peer-1", "provider returned 500");
    await f.runtime.tick();
    let state = f.runtime.status(owner, f.team.id);
    expect(state.status).toBe("paused");
    expect(state.turns).toBe(0);
    expect(state.members[1].error).toBe("provider returned 500 (MODEL_ERROR)");
    expect(state.members[1].delivery).toBeUndefined();
    expect(state.members[1].cursor).toBe(0);
    const failures = state.events.filter(event => event.type === "member_failed");
    expect(failures).toHaveLength(1);
    expect(failures[0].content).toBe("Member turn failed: provider returned 500 (MODEL_ERROR)");

    expect(await f.runtime.resume(owner, f.team.id)).toEqual(["designer: provider returned 500 (MODEL_ERROR)"]);
    await f.runtime.tick();
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1].text).toContain("Start the collaboration");

    f.finish("peer-1", "recovered-final");
    await f.runtime.tick();
    state = f.runtime.status(owner, f.team.id);
    expect(state.status).toBe("active");
    // The replayed batch also carried the failure and resume notices.
    expect(state.members[1].cursor).toBeGreaterThan(delivered.throughSeq);
    expect(state.members[1].error).toBeUndefined();
    expect(state.events.filter(event => event.type === "turn_completed")).toHaveLength(1);
  });

  it.each(["owner", "peer-1"])("does not refund a failed %s turn without a team delivery", async sessionId => {
    const f = setup();
    f.runtime.add(owner, f.team.id, "designer");
    await f.wakePeer();
    f.finish("peer-1");
    await f.runtime.tick();
    expect(f.runtime.status(owner, f.team.id).turns).toBe(1);

    f.fail(sessionId, "Ordinary turn failed");
    await f.runtime.tick();
    const failed = f.runtime.status(owner, f.team.id);
    expect(failed.status).toBe("paused");
    expect(failed.members.find(member => member.sessionId === sessionId)?.delivery).toBeUndefined();
    expect(failed.turns).toBe(1);

    await f.runtime.resume(owner, f.team.id);
    await f.runtime.tick();
    expect(f.runtime.status(owner, f.team.id).turns).toBe(1);
    expect(f.prompts).toHaveLength(1);
  });
});
