import type { DshSessionEventLike } from "../../src/platform/adapters/dsh/session.ts";
import type { TeamEvent, TeamMember, TeamState } from "../../src/team/types.ts";

export interface TeamSmokeEvidence {
  before: TeamState;
  after: TeamState;
  sessions: Record<string, DshSessionEventLike[]>;
  killedSessionId: string;
  killedDeliveryId: string;
  firstPid: number;
  secondPid: number;
  signal: string;
}

export interface TeamSmokeVerification {
  checks: string[];
  summary: {
    checkpoint: "after-real-model-task-claim";
    members: number;
    completedTasks: number;
    automaticDeliveries: number;
    resumedDeliveries: number;
    recoveredCursor: number;
    limitation: string;
  };
}

interface DeliveryMarker {
  id: string;
  index: number;
  throughSeq: number;
  events: TeamEvent[];
}

function requireEvidence(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new Error(`Team smoke evidence failed [${code}]: ${message}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function eventData(event: DshSessionEventLike): Record<string, unknown> {
  return record(event.data) ? event.data : {};
}

function textOf(value: unknown): string {
  if (!record(value) || !Array.isArray(value.content)) return "";
  return value.content.flatMap(block => record(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
}

function markers(events: DshSessionEventLike[], member: TeamMember, team: TeamState): DeliveryMarker[] {
  const found: DeliveryMarker[] = [];
  const ids = new Set<string>();
  for (const [index, event] of events.entries()) {
    requireEvidence(event.seq === index, "session-sequence", "A persisted session log is not contiguous from sequence zero");
    if (event.type !== "user/message") continue;
    const text = textOf(event.data);
    if (!text.startsWith("[rolebox-team ")) continue;
    const id = /^\[rolebox-team ([^\]\r\n]+)\]\n/.exec(text)?.[1];
    requireEvidence(id && !ids.has(id), "delivery-identity", "A team delivery marker is malformed or appears more than once");
    ids.add(id);
    requireEvidence(text.includes(`\nTeam: ${team.id}; member: ${member.id}; goal:`), "delivery-recipient", "A team delivery marker targets a different team or member");
    const payload = /\nEvents through (\d+):\n([\s\S]*)$/.exec(text);
    requireEvidence(payload, "delivery-payload", "A team delivery has no readable event batch");
    let decoded: unknown;
    try { decoded = JSON.parse(payload[2]!); }
    catch { requireEvidence(false, "delivery-payload", "A team delivery event batch is not valid JSON"); }
    requireEvidence(Array.isArray(decoded) && decoded.length > 0, "delivery-payload", "A team delivery event batch is empty or malformed");
    const batch = decoded as TeamEvent[];
    const throughSeq = Number(payload[1]);
    requireEvidence(Number.isSafeInteger(throughSeq) && throughSeq > 0 && throughSeq < team.nextSeq
      && batch.at(-1)?.seq === throughSeq, "delivery-cursor", "A delivery cursor does not match its event batch");
    for (const [offset, item] of batch.entries()) {
      requireEvidence(record(item) && Number.isSafeInteger(item.seq)
        && (offset === 0 || item.seq > batch[offset - 1]!.seq)
        && same(team.events.find(candidate => candidate.seq === item.seq), item),
      "delivery-events", "A delivered event is missing, changed, or out of order in team storage");
    }
    requireEvidence(batch.some(item => item.wake && item.sender !== member.id
      && (!item.recipient || item.recipient === member.id)
      && ["message", "task_offer", "task_complete", "task_release"].includes(item.type)),
    "notification-loop", "An automatic delivery has no substantive peer event addressed to its member");
    found.push({ id, index, throughSeq, events: batch });
  }
  return found;
}

function turnEnd(events: DshSessionEventLike[], marker: DeliveryMarker): DshSessionEventLike | undefined {
  let turn: unknown;
  for (let index = marker.index - 1; index >= 0; index--) {
    if (events[index]!.type === "turn/start") { turn = eventData(events[index]!).turn; break; }
  }
  requireEvidence(Number.isSafeInteger(turn), "delivery-turn", "A delivered team message has no preceding host turn");
  return events.slice(marker.index + 1).find(event => event.type === "turn/end" && eventData(event).turn === turn);
}

function terminalKind(event: DshSessionEventLike | undefined): unknown {
  const reason = event && eventData(event).reason;
  return record(reason) ? reason.kind : undefined;
}

function modelTaskCall(events: DshSessionEventLike[], kind: string, taskId: string, fromIndex = 0, beforeIndex = events.length): boolean {
  return events.slice(fromIndex, beforeIndex).some(event => {
    if (event.type !== "assistant/message") return false;
    const message = eventData(event).message;
    if (!record(message) || !Array.isArray(message.content)) return false;
    return message.content.some(block => {
      if (!record(block) || block.type !== "tool-call" || block.name !== "team_send_event") return false;
      let args: unknown = block.arguments;
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { return false; }
      }
      return record(args) && args.kind === kind && args.task_id === taskId;
    });
  });
}

/** Inspect snapshots read from disk after both processes exit; never resumes a host or modifies storage. */
export function verifyTeamSmoke(input: TeamSmokeEvidence): TeamSmokeVerification {
  const { before, after, sessions, killedSessionId, killedDeliveryId } = input;
  requireEvidence(input.signal === "SIGKILL" && Number.isSafeInteger(input.firstPid) && input.firstPid > 0
    && Number.isSafeInteger(input.secondPid) && input.secondPid > 0 && input.firstPid !== input.secondPid,
  "process-restart", "Recovery evidence must identify separate processes and a confirmed SIGKILL exit");
  requireEvidence(before.version === 1 && after.version === 1 && before.id === after.id
    && before.platformId === "dsh" && after.platformId === "dsh"
    && before.ownerSessionId === after.ownerSessionId && before.ownerRoleId === after.ownerRoleId,
  "team-identity", "Recovery changed the team, platform, or creator identity");
  requireEvidence(before.status === "active" && after.status === "active", "team-state", "The claim checkpoint or recovered team is not active");
  requireEvidence(after.members.length === before.members.length && before.members.length >= 2,
    "roster-size", "Recovery changed the team roster or the evidence lacks two collaborators");
  requireEvidence(after.events.length >= before.events.length && same(after.events.slice(0, before.events.length), before.events),
    "event-prefix", "Recovery removed or changed a committed team event");
  requireEvidence(after.events.every((event, index) => event.seq === index + 1) && after.nextSeq === after.events.length + 1,
    "team-sequence", "The team event stream is not contiguous");
  requireEvidence(after.turns >= before.turns && after.turns < after.maxTurns && before.maxTurns === after.maxTurns,
    "turn-budget", "Recovery reset or exhausted the team turn budget");
  requireEvidence(!after.control && after.members.every(member => member.status === "active" && !member.delivery && !member.error),
    "settled-team", "The final team still has lifecycle work, a pending delivery, or a member error");

  const killedBefore = before.members.find(member => member.sessionId === killedSessionId);
  requireEvidence(killedBefore?.managed && killedBefore.delivery?.id === killedDeliveryId
    && killedBefore.delivery.ownerPid === input.firstPid && killedBefore.cursor < killedBefore.delivery.throughSeq,
  "kill-checkpoint", "The interrupted member did not hold the specified unacknowledged delivery in the killed process");
  const claimed = before.tasks.filter(task => task.status === "claimed" && task.owner === killedBefore.id);
  requireEvidence(claimed.length > 0, "claim-checkpoint", "The killed member had no committed task claim");
  const byMember = new Map<string, DeliveryMarker[]>();
  const allDeliveryIds = new Set<string>();
  for (const oldMember of before.members) {
    const member = after.members.find(candidate => candidate.id === oldMember.id);
    requireEvidence(member && member.roleId === oldMember.roleId && member.sessionId === oldMember.sessionId
      && member.managed === oldMember.managed && member.cursor >= oldMember.cursor,
    "member-identity", "Recovery replaced a member, its role/session binding, or regressed its cursor");
    requireEvidence(member.sessionId && Array.isArray(sessions[member.sessionId]), "session-evidence", "A member's disk session log is missing");
    const events = sessions[member.sessionId]!;
    const deliveries = markers(events, member, after);
    byMember.set(member.id, deliveries);
    for (const [index, delivery] of deliveries.entries()) {
      requireEvidence(!allDeliveryIds.has(delivery.id), "cross-session-delivery", "A delivery identity appears in more than one member session");
      allDeliveryIds.add(delivery.id);
      const previous = deliveries[index - 1];
      if (previous && previous.id !== killedDeliveryId && terminalKind(turnEnd(events, previous)) === "completed") {
        requireEvidence(delivery.events[0]!.seq > previous.throughSeq,
          "confirmed-replay", "A later automatic delivery replays events from a confirmed successful turn");
      }
    }
    requireEvidence(member.lastTurnId && events.some(event => event.type === "turn/end"
      && `${member.sessionId}:event:${event.seq}` === member.lastTurnId && terminalKind(event) === "completed"),
    "final-acknowledgement", "A member's acknowledged final does not identify a durable successful host turn");
  }
  requireEvidence(allDeliveryIds.size <= after.turns, "delivery-accounting", "Persisted delivery markers exceed the recorded turn budget usage");
  const killedAfter = after.members.find(member => member.id === killedBefore.id)!;
  const killedEvents = sessions[killedSessionId]!;
  const killedMarkers = byMember.get(killedBefore.id)!;
  const original = killedMarkers.find(marker => marker.id === killedDeliveryId);
  requireEvidence(original && original.throughSeq === killedBefore.delivery.throughSeq,
    "original-delivery", "The original durable delivery marker is missing or its cursor changed");
  const originalEnd = turnEnd(killedEvents, original);
  requireEvidence(terminalKind(originalEnd) === "interrupted", "interrupted-turn", "The killed delivery was not preserved as an interrupted host turn");
  const resumed = killedMarkers.filter(marker => marker.index > original.index && marker.id !== killedDeliveryId);
  requireEvidence(resumed.length > 0 && resumed.every(marker => terminalKind(turnEnd(killedEvents, marker)) === "completed"),
    "resumed-delivery", "Recovery has no new successful delivery in the original member session");
  requireEvidence(killedAfter.cursor >= killedBefore.delivery.throughSeq,
    "recovered-cursor", "The interrupted member never acknowledged its original event batch");

  for (const task of claimed) {
    const completed = after.tasks.find(candidate => candidate.id === task.id);
    requireEvidence(completed?.status === "completed" && completed.owner === killedBefore.id && completed.description === task.description
      && typeof completed.result === "string" && completed.result.trim().length > 0,
    "task-completion", "A claimed task was lost, reassigned, changed, or completed without a result");
    requireEvidence(modelTaskCall(killedEvents, "task_claim", task.id, original.index, originalEnd?.seq)
      && modelTaskCall(killedEvents, "task_complete", task.id, resumed[0]!.index),
    "model-task-actions", "The original claim or recovered completion has no matching model tool call in the durable session");
    const completions = after.events.filter(event => event.type === "task_complete" && event.taskId === task.id);
    requireEvidence(completions.length === 1 && completions[0]!.sender === killedBefore.id && completions[0]!.content === completed.result,
      "completion-publication", "A task result was duplicated or does not match its owner's published completion");
    const completion = completions[0]!;
    const recipient = after.members.find(member => member.sessionId === after.ownerSessionId && member.roleId === after.ownerRoleId);
    requireEvidence(recipient && recipient.id !== killedBefore.id && recipient.cursor >= completion.seq
      && byMember.get(recipient.id)?.some(marker => marker.events.some(event => event.id === completion.id && same(event, completion))
        && terminalKind(turnEnd(sessions[recipient.sessionId!]!, marker)) === "completed"),
    "peer-handoff", "The creator did not acknowledge a successful team turn containing the specialist's exact published result");
  }
  requireEvidence(after.tasks.every(task => task.status === "completed"), "unfinished-tasks", "The final team retains unfinished tasks");
  requireEvidence(after.events.some(event => event.type === "team_resumed" && event.seq >= before.nextSeq),
    "explicit-resume", "The interrupted team has no persisted explicit resume event");

  return {
    checks: ["separate-process-sigkill", "same-team-and-sessions", "committed-event-prefix", "persisted-claim-owner",
      "interrupted-host-turn", "fresh-successful-delivery", "recovered-cursor", "model-claim-and-completion",
      "exact-result-delivered-to-peer", "substantive-wake-events", "settled-below-turn-budget"],
    summary: { checkpoint: "after-real-model-task-claim", members: after.members.length,
      completedTasks: after.tasks.length, automaticDeliveries: allDeliveryIds.size,
      resumedDeliveries: resumed.length, recoveredCursor: killedAfter.cursor,
      limitation: "Checks the observed claim-then-kill recovery only; the runner must confirm OS exit, disk origin, real provider calls, artifact correctness, and a quiet observation interval." },
  };
}
