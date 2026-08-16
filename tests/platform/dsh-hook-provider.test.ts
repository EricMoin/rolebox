/// <reference types="bun-types" />

import { describe, it, expect, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DshHookProvider } from "../../src/platform/adapters/dsh/hook-provider.ts";
import type { DshHookPayload } from "../../src/platform/adapters/dsh/hook-provider.ts";

/**
 * Fake cordis ctx — records `on` subscriptions per event and lets tests
 * drive them via `emit`, exactly like the cordis Context event bus.
 */
function createFakeCtx() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    listeners,
    on(event: string, listener: (...args: unknown[]) => void) {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
      return () => {
        const cur = listeners.get(event) ?? [];
        listeners.set(
          event,
          cur.filter((l) => l !== listener),
        );
      };
    },
    emit(event: string, ...args: unknown[]) {
      for (const l of listeners.get(event) ?? []) l(...args);
    },
  };
}

describe("DshHookProvider", () => {
  it("maps tool-before → tools/pre-execute on the fake ctx", () => {
    const ctx = createFakeCtx();
    const toolBefore = mock((_p: DshHookPayload) => {});

    new DshHookProvider(ctx, { toolBefore });

    expect(ctx.listeners.has("tools/pre-execute")).toBe(true);
    ctx.emit("tools/pre-execute", {
      name: "bash",
      callId: "c1",
      args: { command: "ls" },
      sessionID: "s1",
    });

    expect(toolBefore).toHaveBeenCalledTimes(1);
    const payload = toolBefore.mock.calls[0][0];
    expect(payload.tool).toBe("bash");
    expect(payload.callID).toBe("c1");
    expect(payload.sessionID).toBe("s1");
    expect(payload.hookKind).toBe("tool-before");
    expect(payload.event).toBe("tools/pre-execute");
  });

  it("maps tool-after → tools/post-execute on the fake ctx", () => {
    const ctx = createFakeCtx();
    const toolAfter = mock((_p: DshHookPayload) => {});

    new DshHookProvider(ctx, { toolAfter });

    expect(ctx.listeners.has("tools/post-execute")).toBe(true);
    ctx.emit("tools/post-execute", {
      name: "bash",
      callId: "c1",
      result: { isError: false, value: "ok" },
    });

    expect(toolAfter).toHaveBeenCalledTimes(1);
    const payload = toolAfter.mock.calls[0][0];
    expect(payload.hookKind).toBe("tool-after");
    expect(payload.event).toBe("tools/post-execute");
    expect(payload.tool).toBe("bash");
  });

  it("routes tools/result to tool-after as the frozen-outcome observation", () => {
    const ctx = createFakeCtx();
    const toolAfter = mock((_p: DshHookPayload) => {});

    new DshHookProvider(ctx, { toolAfter });

    ctx.emit("tools/result", { name: "bash", callId: "c1" }, { isError: false, value: "ok" });
    expect(toolAfter).toHaveBeenCalledTimes(1);
    expect(toolAfter.mock.calls[0][0].event).toBe("tools/result");
    expect(toolAfter.mock.calls[0][0].hookKind).toBe("tool-after");
  });

  it("maps chat-message → session/event for message appends only", () => {
    const ctx = createFakeCtx();
    const chatMessage = mock((_p: DshHookPayload) => {});

    new DshHookProvider(ctx, { chatMessage });

    expect(ctx.listeners.has("session/event")).toBe(true);

    // assistant/message append → routed to chat-message.
    ctx.emit("session/event", { id: "s1", type: "assistant/message", seq: 4 });
    expect(chatMessage).toHaveBeenCalledTimes(1);
    const payload = chatMessage.mock.calls[0][0];
    expect(payload.hookKind).toBe("chat-message");
    expect(payload.event).toBe("session/event");
    expect(payload.sessionEventType).toBe("assistant/message");
    expect(payload.sessionID).toBe("s1");

    // Non-message session event sub-types (turn/end) are NOT routed.
    ctx.emit("session/event", { id: "s1", type: "turn/end", seq: 5 });
    expect(chatMessage).toHaveBeenCalledTimes(1);

    // user/message append → routed.
    ctx.emit("session/event", { id: "s1", type: "user/message", seq: 6 });
    expect(chatMessage).toHaveBeenCalledTimes(2);
  });

  it("getHandlers() exposes every rolebox hook kind plus tool and dispose", () => {
    const ctx = createFakeCtx();
    const provider = new DshHookProvider(ctx, {});

    const handlers = provider.getHandlers();
    for (const kind of [
      "system-transform",
      "chat-message",
      "tool-before",
      "tool-after",
      "context",
      "compaction",
    ]) {
      expect(typeof handlers[kind], `handler for ${kind}`).toBe("function");
    }
    // Port conformance: `tool` key present (empty — DshToolFactory owns
    // registration) and `dispose` provided.
    expect(handlers.tool).toEqual({});
    expect(typeof handlers.dispose).toBe("function");
  });

  it("unmapped hook kinds (system-transform, context, compaction) are no-ops", () => {
    const ctx = createFakeCtx();
    const provider = new DshHookProvider(ctx, {});

    const handlers = provider.getHandlers();
    // No-ops must not throw and must not invoke any callback.
    expect(() =>
      (handlers["system-transform"] as (p: unknown) => void)({ sessionID: "s1" }),
    ).not.toThrow();
    expect(() =>
      (handlers["context"] as (p: unknown) => void)({}),
    ).not.toThrow();
    expect(() =>
      (handlers["compaction"] as (p: unknown) => void)({}),
    ).not.toThrow();

    // No dsh event listeners are registered for the unmapped kinds.
    expect(ctx.listeners.has("system-transform")).toBe(false);
    expect(ctx.listeners.has("context")).toBe(false);
    expect(ctx.listeners.has("compaction")).toBe(false);
  });

  it("each unmapped hook kind is documented as a no-op in the module docstring", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../../src/platform/adapters/dsh/hook-provider.ts"),
      "utf-8",
    );
    const header = source.slice(0, 3000);
    expect(header.toLowerCase()).toContain("no-op");
    // The mapping table and the "Documented no-ops" section name all three.
    for (const kind of ["system-transform", "context", "compaction"]) {
      expect(header).toContain(kind);
    }
  });

  it("dispose unsubscribes the dsh event listeners", () => {
    const ctx = createFakeCtx();
    const toolBefore = mock((_p: DshHookPayload) => {});

    const provider = new DshHookProvider(ctx, { toolBefore });
    provider.dispose();

    ctx.emit("tools/pre-execute", { name: "bash", callId: "c1" });
    expect(toolBefore).not.toHaveBeenCalled();
  });
});
