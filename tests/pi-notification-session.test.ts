/**
 * PiNotificationSessionClient tests.
 *
 * Verifies that the class:
 *   1. Delegates non-prompt methods to the inner adapter
 *   2. Delegates prompt to inner for managed sessions
 *   3. Calls pi.sendMessage for external sessions on prompt (with triggerTurn)
 *   4. Delegates promptSync to inner for managed sessions
 *   5. Returns null for external sessions on promptSync
 *
 * @module
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
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

function createMockPi(): { sendMessage: ReturnType<typeof mock>; sendUserMessage: ReturnType<typeof mock> } {
  return {
    sendMessage: mock((_message: any, _opts?: any) => {}),
    sendUserMessage: mock((_text: string) => {}),
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe("PiNotificationSessionClient", () => {
  let inner: ReturnType<typeof createMockInner>;
  let pi: ReturnType<typeof createMockPi>;
  let log: Logger<ILogObj>;
  let client: PiNotificationSessionClient;

  beforeEach(() => {
    inner = createMockInner();
    pi = createMockPi();
    log = createMockLogger();
    client = new PiNotificationSessionClient(
      inner as any,
      pi as any,
      log,
    );
  });

  it("delegates list to inner adapter", async () => {
    await client.list("/tmp");
    expect(inner.list).toHaveBeenCalledWith("/tmp");
  });

  it("delegates get to inner adapter", async () => {
    await client.get("session-1", "/tmp");
    expect(inner.get).toHaveBeenCalledWith("session-1", "/tmp");
  });

  it("delegates messages to inner adapter", async () => {
    await client.messages("session-1", { limit: 10 });
    expect(inner.messages).toHaveBeenCalledWith("session-1", { limit: 10 });
  });

  it("delegates children to inner adapter", async () => {
    await client.children("session-1", "/tmp");
    expect(inner.children).toHaveBeenCalledWith("session-1", "/tmp");
  });

  it("delegates todo to inner adapter", async () => {
    await client.todo("session-1", "/tmp");
    expect(inner.todo).toHaveBeenCalledWith("session-1", "/tmp");
  });

  it("delegates diff to inner adapter", async () => {
    await client.diff("session-1", { directory: "/tmp", messageID: "msg-1" });
    expect(inner.diff).toHaveBeenCalledWith("session-1", { directory: "/tmp", messageID: "msg-1" });
  });

  it("delegates fork to inner adapter", async () => {
    await client.fork("session-1", { directory: "/tmp", messageID: "msg-1" });
    expect(inner.fork).toHaveBeenCalledWith("session-1", { directory: "/tmp", messageID: "msg-1" });
  });

  it("delegates status to inner adapter", async () => {
    await client.status("session-1", "/tmp");
    expect(inner.status).toHaveBeenCalledWith("session-1", "/tmp");
  });

  it("delegates create to inner adapter", async () => {
    await client.create({ directory: "/tmp", agent: "test-agent" });
    expect(inner.create).toHaveBeenCalledWith({ directory: "/tmp", agent: "test-agent" });
  });

  it("delegates abort to inner adapter", async () => {
    await client.abort("session-1");
    expect(inner.abort).toHaveBeenCalledWith("session-1");
  });

  it("delegates prompt to inner for managed sessions", async () => {
    const managedInner = createMockInner(["managed-1"]);
    const managedClient = new PiNotificationSessionClient(
      managedInner as any,
      pi as any,
      log,
    );

    const options = { parts: [{ type: "text", text: "hello" }] };
    await managedClient.prompt("managed-1", options);

    expect(managedInner.prompt).toHaveBeenCalledWith("managed-1", options);
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("calls pi.sendMessage with triggerTurn=true for external sessions on prompt", async () => {
    const options = {
      parts: [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ],
    };

    const result = await client.prompt("external-1", options);

    expect(inner.prompt).not.toHaveBeenCalled();
    expect(pi.sendMessage).toHaveBeenCalledWith(
      { customType: "rolebox-inject", content: "hello\nworld", display: true, details: { source: "rolebox-dispatch" } },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    expect(result).toEqual({ id: "external-1" });
  });

  it("returns null when neither sendMessage nor sendUserMessage is available", async () => {
    const emptyPi = {} as any;
    const noNotifyClient = new PiNotificationSessionClient(
      inner as any,
      emptyPi,
      log,
    );

    const options = { parts: [{ type: "text", text: "hello" }] };
    const result = await noNotifyClient.prompt("external-1", options);

    expect(inner.prompt).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("calls pi.sendMessage with triggerTurn=false when noReply: true", async () => {
    const options = {
      parts: [{ type: "text", text: "silent note" }],
      noReply: true,
    };

    const result = await client.prompt("external-1", options);

    expect(pi.sendMessage).toHaveBeenCalledWith(
      { customType: "rolebox-inject", content: "silent note", display: true, details: { source: "rolebox-dispatch" } },
      { triggerTurn: false, deliverAs: "followUp" },
    );
    expect(result).toEqual({ id: "external-1" });
  });

  it("falls back to sendUserMessage when sendMessage is unavailable (legacy Pi)", async () => {
    const legacyPi = {
      sendUserMessage: mock((_text: string) => {}),
    } as any;
    const legacyClient = new PiNotificationSessionClient(
      inner as any,
      legacyPi,
      log,
    );

    const options = {
      parts: [{ type: "text", text: "legacy hello" }],
    };

    const result = await legacyClient.prompt("external-1", options);

    expect(legacyPi.sendUserMessage).toHaveBeenCalledWith("legacy hello");
    expect(result).toEqual({ id: "external-1" });
  });

  it("delegates promptSync to inner for managed sessions", async () => {
    const managedInner = createMockInner(["managed-1"]);
    const managedClient = new PiNotificationSessionClient(
      managedInner as any,
      pi as any,
      log,
    );

    const options = {
      parts: [{ type: "text", text: "hello" }],
      agent: "test-agent",
    };
    const result = await managedClient.promptSync("managed-1", options);

    expect(managedInner.promptSync).toHaveBeenCalledWith("managed-1", options);
    expect(result).toEqual({ parts: [{ type: "text", text: "response" }] });
  });

  it("returns null for external sessions on promptSync", async () => {
    const options = { parts: [{ type: "text", text: "hello" }] };
    const result = await client.promptSync("external-1", options);

    expect(inner.promptSync).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("calls pi.sendMessage with triggerTurn=false when fromLoop:true and noReply:true", async () => {
    const options = {
      parts: [{ type: "text", text: "[loop-progress] round 1/3 completed]" }],
      noReply: true,
      fromLoop: true,
    };

    const result = await client.prompt("external-1", options);

    expect(pi.sendMessage).toHaveBeenCalledWith(
      { customType: "rolebox-inject", content: "[loop-progress] round 1/3 completed]", display: true, details: { source: "rolebox-dispatch" } },
      { triggerTurn: false, deliverAs: "followUp" },
    );
    expect(result).toEqual({ id: "external-1" });
  });

  it("calls pi.sendMessage with triggerTurn=true when fromLoop:true and noReply:false", async () => {
    const options = {
      parts: [{ type: "text", text: "[loop-progress] loop complete]" }],
      noReply: false,
      fromLoop: true,
    };

    const result = await client.prompt("external-1", options);

    expect(pi.sendMessage).toHaveBeenCalledWith(
      { customType: "rolebox-inject", content: "[loop-progress] loop complete]", display: true, details: { source: "rolebox-dispatch" } },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    expect(result).toEqual({ id: "external-1" });
  });

  it("non-loop dispatch notification with noReply:true uses triggerTurn:false with immediate silent delivery (no fromLoop)", async () => {
    const options = {
      parts: [{ type: "text", text: "dispatch completed" }],
      noReply: true,
      fromLoop: false,
    };

    const result = await client.prompt("external-1", options);

    expect(pi.sendMessage).toHaveBeenCalledWith(
      { customType: "rolebox-inject", content: "dispatch completed", display: true, details: { source: "rolebox-dispatch" } },
      { triggerTurn: false, deliverAs: "followUp" },
    );
    expect(result).toEqual({ id: "external-1" });
  });
});
