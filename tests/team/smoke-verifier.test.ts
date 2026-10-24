import { describe, expect, it } from "bun:test";
import { verifyTeamSmoke, type TeamSmokeEvidence } from "../../scripts/team-smoke/verify.ts";
import type { DshSessionEventLike } from "../../src/platform/adapters/dsh/session.ts";
import type { TeamEvent, TeamState } from "../../src/team/types.ts";

function evidence(): TeamSmokeEvidence {
  const events: TeamEvent[] = [
    { type: "team_created", sender: "owner", content: "Design and implement", wake: false },
    { type: "member_joined", sender: "owner", content: "Designer joined", wake: false },
    { type: "message", sender: "owner", recipient: "designer", content: "Prepare the design", wake: true },
    { type: "task_offer", sender: "owner", taskId: "design", content: "Design the page", wake: true },
    { type: "task_claim", sender: "designer", taskId: "design", content: "I will design", wake: false },
  ].map((event, index) => ({ ...event, id: `event-${index + 1}`, seq: index + 1, at: index + 1 }));
  const before: TeamState = {
    version: 1, id: "team-smoke", name: "Smoke", goal: "Design and implement", platformId: "dsh",
    ownerSessionId: "owner-session", ownerRoleId: "implementer", status: "active", createdAt: 0,
    nextSeq: 6, maxTurns: 10, turns: 1,
    members: [
      { id: "owner", roleId: "implementer", sessionId: "owner-session", status: "active", managed: false, cursor: 0 },
      { id: "designer", roleId: "designer", sessionId: "designer-session", status: "active", managed: true, cursor: 0,
        delivery: { id: "delivery-before", throughSeq: 4, startedAt: 1, ownerPid: 101, ownerId: "runtime-before", baselineMessageIds: [] } },
    ],
    tasks: [{ id: "design", description: "Design the page", status: "claimed", owner: "designer", leaseUntil: 5000 }], events,
  };
  const after = structuredClone(before);
  const additional = [
    { type: "member_failed", sender: "designer", content: "Interrupted", wake: false },
    { type: "team_resumed", sender: "owner", content: "Resume", wake: false },
    { type: "task_complete", sender: "designer", taskId: "design", content: "Use accessible spacing", wake: true },
    { type: "turn_completed", sender: "designer", content: "Design ready", wake: false },
    { type: "turn_completed", sender: "owner", content: "Implemented", wake: false },
  ].map((event, index) => ({ ...event, id: `event-${index + 6}`, seq: index + 6, at: index + 6 }));
  after.events.push(...additional);
  after.nextSeq = 11;
  after.turns = 3;
  after.tasks = [{ id: "design", description: "Design the page", status: "completed", owner: "designer", result: "Use accessible spacing" }];
  after.members[0]!.cursor = 9;
  after.members[0]!.lastTurnId = "owner-session:event:3";
  after.members[1]!.cursor = 7;
  after.members[1]!.lastTurnId = "designer-session:event:8";
  delete after.members[1]!.delivery;
  const marker = (id: string, member: string, throughSeq: number) => ({ id, content: [{ type: "text",
    text: `[rolebox-team ${id}]\nTeam: team-smoke; member: ${member}; goal: Design and implement\nEvents through ${throughSeq}:\n${JSON.stringify(after.events.slice(0, throughSeq))}` }] });
  const tool = (kind: string) => ({ message: { content: [{ type: "tool-call", name: "team_send_event", arguments: JSON.stringify({ kind, task_id: "design", team_id: "team-smoke" }) }] } });
  const log = (values: Array<{ type: string; data: unknown }>): DshSessionEventLike[] => values.map((event, seq) => ({ ...event, seq, time: seq }));
  return { before, after, killedSessionId: "designer-session", killedDeliveryId: "delivery-before", firstPid: 101, secondPid: 102, signal: "SIGKILL",
    sessions: {
      "designer-session": log([
        { type: "turn/start", data: { turn: 1 } },
        { type: "user/message", data: marker("delivery-before", "designer", 4) },
        { type: "assistant/message", data: tool("task_claim") },
        { type: "turn/end", data: { turn: 1, reason: { kind: "interrupted" } } },
        { type: "turn/start", data: { turn: 2 } },
        { type: "user/message", data: marker("delivery-after", "designer", 7) },
        { type: "assistant/message", data: tool("task_complete") },
        { type: "assistant/message", data: { message: { content: [{ type: "text", text: "Design ready" }] } } },
        { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } },
      ]),
      "owner-session": log([
        { type: "turn/start", data: { turn: 1 } },
        { type: "user/message", data: marker("delivery-owner", "owner", 9) },
        { type: "assistant/message", data: { message: { content: [{ type: "text", text: "Implemented" }] } } },
        { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
      ]),
    } };
}

describe("team process smoke evidence", () => {
  it("accepts persisted claim interruption, same-session recovery, and peer handoff", () => {
    const result = verifyTeamSmoke(evidence());
    expect(result.summary).toMatchObject({ checkpoint: "after-real-model-task-claim", automaticDeliveries: 3, resumedDeliveries: 1, completedTasks: 1 });
    expect(result.checks).toContain("exact-result-delivered-to-peer");
  });

  it("refuses a graceful restart presented as a kill", () => {
    const input = evidence();
    input.signal = "SIGTERM";
    expect(() => verifyTeamSmoke(input)).toThrow("[process-restart]");
  });

  it("refuses a recovered turn that used a new session identity", () => {
    const input = evidence();
    input.after.members[1]!.sessionId = "replacement-session";
    expect(() => verifyTeamSmoke(input)).toThrow("[member-identity]");
  });

  it("refuses a task that actually completed before the kill", () => {
    const input = evidence();
    input.sessions["designer-session"]![3] = { ...input.sessions["designer-session"]![3]!, data: { turn: 1, reason: { kind: "completed" } } };
    expect(() => verifyTeamSmoke(input)).toThrow("[interrupted-turn]");
  });

  it("refuses completion without a model task action", () => {
    const input = evidence();
    input.sessions["designer-session"]![6] = { ...input.sessions["designer-session"]![6]!, data: { message: { content: [{ type: "text", text: "Claimed by the driver" }] } } };
    expect(() => verifyTeamSmoke(input)).toThrow("[model-task-actions]");
  });

  it("refuses acknowledgement-only automatic turns", () => {
    const input = evidence();
    input.sessions["owner-session"]![1] = { ...input.sessions["owner-session"]![1]!, data: { content: [{ type: "text", text:
      `[rolebox-team delivery-owner]\nTeam: team-smoke; member: owner; goal: Design and implement\nEvents through 9:\n${JSON.stringify([input.after.events[8]])}` }] } };
    expect(() => verifyTeamSmoke(input)).toThrow("[notification-loop]");
  });

  it("refuses a peer that did not acknowledge the specialist result", () => {
    const input = evidence();
    input.after.members[0]!.cursor = 7;
    expect(() => verifyTeamSmoke(input)).toThrow("[peer-handoff]");
  });

  it("refuses replay after an already successful automatic turn", () => {
    const input = evidence();
    const ownerEvents = input.sessions["owner-session"]!;
    const replayed = structuredClone(ownerEvents[1]!.data) as { content: Array<{ text: string }> };
    replayed.content[0]!.text = replayed.content[0]!.text.replace("delivery-owner", "delivery-owner-again");
    ownerEvents.push(
      { seq: 4, time: 4, type: "turn/start", data: { turn: 2 } },
      { seq: 5, time: 5, type: "user/message", data: replayed },
      { seq: 6, time: 6, type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } },
    );
    input.after.turns++;
    input.after.members[0]!.lastTurnId = "owner-session:event:6";
    expect(() => verifyTeamSmoke(input)).toThrow("[confirmed-replay]");
  });
});
