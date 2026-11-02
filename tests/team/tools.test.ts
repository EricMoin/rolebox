import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ISessionClient } from "../../src/platform/ports/session-client.ts";
import type { CanonicalToolContext, SessionStatus } from "../../src/platform/types.ts";
import type { ResolvedRole } from "../../src/types.ts";
import { TeamRuntime } from "../../src/team/runtime.ts";
import { TeamStore } from "../../src/team/store.ts";
import { createTeamTools } from "../../src/team/tools.ts";
import type { TeamEvent, TeamMember, TeamState } from "../../src/team/types.ts";

type CreateReceipt = Pick<TeamState, "id" | "name" | "status" | "ownerSessionId" | "ownerRoleId" | "createdAt" | "maxTurns" | "turns"> & {
  members: Array<Pick<TeamMember, "id" | "roleId" | "sessionId" | "status">>;
};
type EventReceipt = Omit<TeamEvent, "content">;
const fixtures: Array<{ directory: string; runtime: TeamRuntime }> = [];

afterEach(async () => {
  for (const { directory, runtime } of fixtures.splice(0)) {
    await runtime.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "team-tools-"));
  const roles = ["developer", "reviewer"].map(id => ({ id, config: { name: id }, subagents: [] }) as unknown as ResolvedRole);
  const statuses = new Map<string, SessionStatus>([["owner", { type: "busy" }]]);
  const prompts: Array<{ id: string; text: string }> = [];
  const session = {
    async create() { statuses.set("peer", { type: "idle" }); return { id: "peer" }; },
    async prompt(id: string, options: { parts: Array<{ text: string }> }) {
      prompts.push({ id, text: options.parts.map(part => part.text).join("\n") });
      statuses.set(id, { type: "busy" });
      return { id: `prompt-${prompts.length}` };
    },
    async status(id: string) { return statuses.get(id) ?? null; },
    async messages() { return []; },
    async abort() { return true; },
  } as unknown as ISessionClient;
  const runtime = new TeamRuntime({ directory, platformId: "dsh", session, roles: () => roles, canPollStatus: true });
  fixtures.push({ directory, runtime });
  const context: CanonicalToolContext = {
    sessionID: "owner", messageID: "call", agent: "developer", directory, worktree: directory,
    abort: new AbortController().signal, metadata() {}, async ask() {},
  };
  const tools = createTeamTools(runtime);
  async function call<T>(name: string, args: Record<string, unknown>) {
    const result = await tools[name].execute(args, context);
    if (typeof result !== "string") throw new Error("Expected a JSON text result");
    return { text: result, value: JSON.parse(result) as T };
  }
  const create = (goal = "Review the implementation") => call<CreateReceipt>("team_create", { name: "Review", goal, max_turns: 8 });
  return { directory, runtime, context, tools, prompts, call, create };
}

describe("team tool receipts", () => {
  it("acknowledges creation without echoing a long goal while retaining its durable state", async () => {
    const f = setup();
    const goal = "Detailed review objective. ".repeat(500);
    const { text, value: receipt } = await f.create(goal);

    expect(receipt).toEqual({
      id: expect.any(String), name: "Review", status: "active", ownerSessionId: "owner", ownerRoleId: "developer",
      createdAt: expect.any(Number), maxTurns: 8, turns: 0,
      members: [{ id: expect.any(String), roleId: "developer", sessionId: "owner", status: "active" }],
    });
    expect(text).not.toContain(goal);
    expect(text.length).toBeLessThan(1000);

    const store = new TeamStore(join(f.directory, ".rolebox", "team"));
    try {
      expect(store.read(receipt.id).goal).toBe(goal);
      expect(store.read(receipt.id).events[0].content).toBe(goal);
    } finally { store.close(); }
    const { value: state } = await f.call<TeamState>("team_status", { team_id: receipt.id });
    expect(state.goal).toBe(goal);
    expect(state.events[0].content).toBe(goal);
  });

  it("returns a message receipt while delivering the complete content to its resolved recipient", async () => {
    const f = setup();
    const goal = "Shared objective. ".repeat(300);
    const { value: team } = await f.create(goal);
    const { value: peer } = await f.call<TeamMember>("team_add", { team_id: team.id, role_id: "reviewer" });
    const content = "Review every boundary and report evidence. ".repeat(300);
    const { text, value: receipt } = await f.call<EventReceipt>("team_send_event", {
      team_id: team.id, kind: "message", content, recipient: "reviewer",
    });

    expect(receipt).toEqual({
      id: expect.any(String), seq: 3, type: "message", sender: team.members[0].id,
      recipient: peer.id, at: expect.any(Number), wake: true,
    });
    expect(text).not.toContain(content);
    expect(text.length).toBeLessThan(1000);
    const { value: state } = await f.call<TeamState>("team_status", { team_id: team.id, after_seq: receipt.seq - 1 });
    expect(state.events).toEqual([{ ...receipt, content }]);

    await f.runtime.tick();
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0].id).toBe("peer");
    expect(f.prompts[0].text).toContain(goal);
    expect(f.prompts[0].text).toContain(content);
    expect(f.runtime.status(f.context, team.id).members[1].delivery?.promptId).toBe("prompt-1");
  });

  it("keeps generated task identity and effective wake flags across every task event", async () => {
    const f = setup();
    const { value: team } = await f.create();
    const { value: peer } = await f.call<TeamMember>("team_add", { team_id: team.id, role_id: "reviewer" });
    const offer = "Task acceptance criteria. ".repeat(300);
    const offered = await f.call<EventReceipt>("team_send_event", {
      team_id: team.id, kind: "task_offer", content: offer, recipient: "reviewer", wake: false,
    });
    expect(offered.value).toEqual({
      id: expect.any(String), seq: 3, type: "task_offer", sender: team.members[0].id,
      recipient: peer.id, taskId: expect.any(String), at: expect.any(Number), wake: false,
    });
    expect(offered.text).not.toContain(offer);
    await f.runtime.tick();
    expect(f.prompts).toEqual([]);

    const taskId = offered.value.taskId!;
    const contents = [offer];
    for (const [index, kind] of ["task_claim", "task_release", "task_claim", "task_complete"].entries()) {
      const content = `${kind} evidence. `.repeat(300);
      contents.push(content);
      const { text, value: receipt } = await f.call<EventReceipt>("team_send_event", {
        team_id: team.id, kind, task_id: taskId, content, wake: true,
      });
      expect(receipt).toEqual({
        id: expect.any(String), seq: 4 + index, type: kind, taskId, sender: team.members[0].id,
        at: expect.any(Number), wake: kind !== "task_claim",
      });
      expect(text).not.toContain(content);
      expect(text.length).toBeLessThan(1000);
    }

    const { value: state } = await f.call<TeamState>("team_status", { team_id: team.id, after_seq: 2 });
    expect(state.events.map(event => event.content)).toEqual(contents);
    expect(state.tasks).toEqual([{
      id: taskId, description: offer, status: "completed", owner: team.members[0].id, result: contents.at(-1),
    }]);
  });

  it("does not acknowledge or record a rejected event", async () => {
    const f = setup();
    const { value: team } = await f.create();
    const before = f.runtime.status(f.context, team.id);

    await expect(f.call("team_send_event", {
      team_id: team.id, kind: "message", content: "Review this", recipient: "missing",
    })).rejects.toThrow("Recipient is not an active team member");
    await expect(f.call("team_send_event", {
      team_id: team.id, kind: "task_claim", content: "Claim", task_id: "missing",
    })).rejects.toThrow("Unknown task ID");

    expect(f.runtime.status(f.context, team.id)).toEqual(before);
  });
});
