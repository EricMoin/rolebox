/**
 * Behavioral regression test: deferred <system-reminder> delivery on Pi.
 *
 * Reproduces the reported bug: silent dispatch notifications
 * (noReply: true) were previously sent with deliverAs:"nextTurn", which
 * parks the message until the next agent turn instead of delivering it
 * immediately — so graph-completion <system-reminder> prompts never
 * reached the parent session.
 *
 * Uses a BehavioralPi mock that implements pi 0.84.2 sendCustomMessage
 * delivery semantics faithfully:
 *   (a) deliverAs:"nextTurn"            -> parked in pendingNextTurn (NOT delivered)
 *   (b) deliverAs:"followUp" + no turn  -> appended to delivered immediately
 *                                          (+ message_start/message_end) when idle
 *   (c) deliverAs:"followUp" + turn     -> records a triggered turn when idle
 *   (d) streaming session               -> followUp queued
 *
 * The test is written such that reverting the production mapping to
 * deliverAs:"nextTurn" for noReply:true makes the pendingNextTurn-empty
 * assertion fail, reproducing the bug.
 *
 * @module
 */

import { describe, it, expect, mock } from "bun:test";
import { PiNotificationSessionClient } from "../src/platform/adapters/pi/notification-session.ts";
import type { ISessionClient } from "../src/platform/ports/session-client.ts";
import type { Logger } from "tslog";
import type { ILogObj } from "tslog";

// ── Mocks ───────────────────────────────────────────────────────────────────

function createMockInner(processIds: string[] = []): ISessionClient & { processes: Map<string, unknown> } {
  const processes = new Map<string, unknown>();
  for (const id of processIds) {
    processes.set(id, { proc: null, messages: [], exitCode: 0 });
  }

  return {
    processes,
    list: mock(async (_dir?: string) => []),
    get: mock(async (_id: string, _dir?: string) => null),
    messages: mock(async (_id: string, _opts?: { directory?: string; limit?: number }) => []),
    children: mock(async (_id: string, _dir?: string) => []),
    todo: mock(async (_id: string, _dir?: string) => []),
    diff: mock(async (_id: string, _opts?: { directory?: string; messageID?: string }) => []),
    fork: mock(async (_id: string, _opts?: { directory?: string; messageID?: string }) => null),
    status: mock(async (_id: string, _dir?: string) => null),
    prompt: mock(async (_id: string, _opts: any) => ({ id: _id })),
    promptSync: mock(async (_id: string, _opts: any) => ({ parts: [{ type: "text", text: "response" }] })),
    create: mock(async (_opts: { directory: string; agent?: string; parentID?: string }) => null),
    abort: mock(async (_id: string) => true),
  };
}

function createMockLogger(): Logger<ILogObj> {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  } as unknown as Logger<ILogObj>;
}

/**
 * Behavioral Pi mock implementing pi 0.84.2 sendCustomMessage delivery
 * semantics through `sendMessage(message, opts)`. Exposes observable state
 * so tests can assert where each message landed.
 */
interface BehavioralPiState {
  /** (a) Messages parked until the next agent turn — NOT delivered. */
  pendingNextTurn: Array<{ text: string }>;
  /** (b) Messages appended to the session immediately (sessionMessages). */
  delivered: Array<{ text: string }>;
  /** (d) Follow-up messages queued while the session is streaming/busy. */
  followUpQueue: Array<{ text: string }>;
  /** (c) Count of agent turns triggered via triggerTurn: true. */
  triggeredTurns: number;
  /** (b) message_start / message_end events emitted for immediate silent deliveries. */
  messageEvents: Array<"message_start" | "message_end">;
  /** Whether the session is idle (not streaming). Defaults to true. */
  idle: boolean;
}

function createBehavioralPi(): {
  pi: { sendMessage: ReturnType<typeof mock>; sendUserMessage: ReturnType<typeof mock> };
  state: BehavioralPiState;
} {
  const state: BehavioralPiState = {
    pendingNextTurn: [],
    delivered: [],
    followUpQueue: [],
    triggeredTurns: 0,
    messageEvents: [],
    idle: true,
  };

  const sendMessage = mock((message: any, opts?: { triggerTurn?: boolean; deliverAs?: string }) => {
    const text: string = message?.content ?? "";
    const deliverAs = opts?.deliverAs ?? "followUp";
    const triggerTurn = opts?.triggerTurn ?? true;

    // (a) deliverAs:"nextTurn" -> park the message for the next agent turn;
    //     NOT delivered now.
    if (deliverAs === "nextTurn") {
      state.pendingNextTurn.push({ text });
      return;
    }

    // deliverAs:"followUp" -> deliver now (any other deliverAs is ignored).
    if (deliverAs !== "followUp") return;

    // (d) Streaming/busy session -> queue as a follow-up for when the
    //     current turn finishes.
    if (!state.idle) {
      state.followUpQueue.push({ text });
      return;
    }

    // (c) Idle + triggerTurn -> record a triggered agent turn.
    if (triggerTurn) {
      state.triggeredTurns++;
      return;
    }

    // (b) Idle + silent -> append to the session immediately and emit
    //     message_start / message_end.
    state.delivered.push({ text });
    state.messageEvents.push("message_start", "message_end");
  });

  return {
    pi: {
      sendMessage,
      sendUserMessage: mock((_text: string) => {}),
    },
    state,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("PiNotificationSessionClient — deferred-delivery regression", () => {
  function makeClient() {
    const { pi, state } = createBehavioralPi();
    const client = new PiNotificationSessionClient(
      createMockInner() as any,
      pi as any,
      createMockLogger(),
    );
    return { pi, state, client };
  }

  it("delivers [GRAPH NODE COMPLETED] silently and immediately for noReply:true — never parked in pendingNextTurn", async () => {
    const { pi, state, client } = makeClient();

    const result = await client.prompt("emperor-session-1", {
      parts: [{ type: "text", text: "[GRAPH NODE COMPLETED] node-1 finished" }],
      noReply: true,
    });

    // Anti-regression tripwire: the silent notification must NOT be deferred
    // to the next agent turn. If the production mapping ever reverts to
    // deliverAs:"nextTurn" for noReply:true, this assertion fails — the bug.
    expect(state.pendingNextTurn).toEqual([]);

    // Immediate silent append: present in delivered, no turn triggered.
    expect(state.delivered).toContainEqual({
      text: "[GRAPH NODE COMPLETED] node-1 finished",
    });
    expect(state.messageEvents).toEqual(["message_start", "message_end"]);
    expect(state.triggeredTurns).toBe(0);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      {
        customType: "rolebox-inject",
        content: "[GRAPH NODE COMPLETED] node-1 finished",
        display: true,
        details: { source: "rolebox-dispatch" },
      },
      { triggerTurn: false, deliverAs: "followUp" },
    );
    expect(result).toEqual({ id: "emperor-session-1" });
  });

  it("triggers a turn immediately when idle for [GRAPH COMPLETE] (noReply:false)", async () => {
    const { pi, state, client } = makeClient();

    const result = await client.prompt("emperor-session-1", {
      parts: [{ type: "text", text: "[GRAPH COMPLETE] all 3 nodes finished" }],
      noReply: false,
    });

    expect(state.triggeredTurns).toBe(1);
    expect(state.pendingNextTurn).toEqual([]);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      {
        customType: "rolebox-inject",
        content: "[GRAPH COMPLETE] all 3 nodes finished",
        display: true,
        details: { source: "rolebox-dispatch" },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    expect(result).toEqual({ id: "emperor-session-1" });
  });

  it("regression tripwire: the deferred nextTurn path exists and is what the old mapping hit (bug reproduction)", async () => {
    const { pi, state } = createBehavioralPi();

    // Simulate the OLD (buggy) production mapping — silent notifications were
    // sent with deliverAs:"nextTurn", parking the message until the next turn.
    pi.sendMessage(
      {
        customType: "rolebox-inject",
        content: "[GRAPH NODE COMPLETED] deferred",
        display: true,
        details: { source: "rolebox-dispatch" },
      },
      { triggerTurn: false, deliverAs: "nextTurn" },
    );

    // The message is NOT delivered — it is parked, which is the reported bug.
    expect(state.pendingNextTurn).toHaveLength(1);
    expect(state.pendingNextTurn).toContainEqual({
      text: "[GRAPH NODE COMPLETED] deferred",
    });
    expect(state.delivered).toHaveLength(0);
    expect(state.triggeredTurns).toBe(0);
  });

  it("mock contract (d): a followUp sent while streaming is queued, not dropped", async () => {
    const { pi, state, client } = makeClient();
    state.idle = false; // session currently streaming

    await client.prompt("emperor-session-1", {
      parts: [{ type: "text", text: "[GRAPH COMPLETE] queued while streaming" }],
      noReply: false,
    });

    expect(state.followUpQueue).toContainEqual({
      text: "[GRAPH COMPLETE] queued while streaming",
    });
    expect(state.delivered).toHaveLength(0);
    expect(state.triggeredTurns).toBe(0);
  });
});
