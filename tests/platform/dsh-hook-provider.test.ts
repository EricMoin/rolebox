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
    // rc.6 signature is (exec, result): the outcome is the SECOND argument.
    ctx.emit(
      "tools/post-execute",
      { name: "bash", callId: "c1" },
      { isError: false, value: "ok" },
    );

    expect(toolAfter).toHaveBeenCalledTimes(1);
    const payload = toolAfter.mock.calls[0][0];
    expect(payload.hookKind).toBe("tool-after");
    expect(payload.event).toBe("tools/post-execute");
    expect(payload.tool).toBe("bash");
    expect(payload.result).toEqual({ isError: false, value: "ok" });
  });

  it("chains the tools/pre-execute waterfall to next() and returns its decision", () => {
    // Regression: cordis invokes waterfall listeners as (…args, next). Returning
    // undefined clobbers the waterfall, so dsh-tools' `gate.kind` read throws
    // "Cannot read properties of undefined (reading 'kind')" on every tool call.
    const ctx = createFakeCtx();
    const toolBefore = mock((_p: DshHookPayload) => {});
    new DshHookProvider(ctx, { toolBefore });

    const listener = ctx.listeners.get("tools/pre-execute")![0] as (...a: unknown[]) => unknown;
    const next = mock(() => ({ kind: "allow" }));

    const out = listener({ name: "bash", callId: "c1" }, next);

    expect(toolBefore).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ kind: "allow" });
  });

  it("chains tools/post-execute and awaits an async observer before next()", async () => {
    const ctx = createFakeCtx();
    const toolAfter = mock(async (_p: DshHookPayload) => {});
    new DshHookProvider(ctx, { toolAfter });

    const listener = ctx.listeners.get("tools/post-execute")![0] as (...a: unknown[]) => unknown;
    const next = mock(() => ({ kind: "accept" }));

    const out = await listener(
      { name: "bash", callId: "c1" },
      { isError: false, value: "ok" },
      next,
    );

    expect(toolAfter).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ kind: "accept" });
  });

  it("does not treat a trailing function on a plain event as a waterfall next", () => {
    const ctx = createFakeCtx();
    const toolAfter = mock((_p: DshHookPayload) => {});
    new DshHookProvider(ctx, { toolAfter });

    const listener = ctx.listeners.get("tools/result")![0] as (...a: unknown[]) => unknown;
    const notNext = mock(() => ({ kind: "nope" }));

    const out = listener({ name: "bash", callId: "c1" }, { isError: false }, notNext);

    expect(toolAfter).toHaveBeenCalledTimes(1);
    expect(notNext).not.toHaveBeenCalled();
    expect(out).toBeUndefined();
  });

  it("routes tools/result to tool-after as the frozen-outcome observation", () => {
    const ctx = createFakeCtx();
    const toolAfter = mock((_p: DshHookPayload) => {});

    new DshHookProvider(ctx, { toolAfter });

    ctx.emit("tools/result", { name: "bash", callId: "c1" }, { isError: false, value: "ok" });
    expect(toolAfter).toHaveBeenCalledTimes(1);
    expect(toolAfter.mock.calls[0][0].event).toBe("tools/result");
    expect(toolAfter.mock.calls[0][0].hookKind).toBe("tool-after");
    // the frozen outcome (arg1) is delivered under payload.result.
    expect(toolAfter.mock.calls[0][0].result).toEqual({ isError: false, value: "ok" });
  });

  it("maps chat-message → session/event for message appends only", () => {
    const ctx = createFakeCtx();
    const chatMessage = mock((_p: DshHookPayload) => {});

    new DshHookProvider(ctx, { chatMessage });

    expect(ctx.listeners.has("session/event")).toBe(true);

    // rc.6 signature is (session, event) — arg0 is the Session (no `type`),
    // arg1 is the SessionEvent. assistant/message append → routed.
    ctx.emit(
      "session/event",
      { id: "s1" },
      { type: "assistant/message", seq: 4, time: 100, data: { id: "m4" } },
    );
    expect(chatMessage).toHaveBeenCalledTimes(1);
    const payload = chatMessage.mock.calls[0][0];
    expect(payload.hookKind).toBe("chat-message");
    expect(payload.event).toBe("session/event");
    expect(payload.sessionEventType).toBe("assistant/message");
    expect(payload.sessionID).toBe("s1");

    // Non-message session event sub-types (turn/end) are NOT routed.
    ctx.emit(
      "session/event",
      { id: "s1" },
      { type: "turn/end", seq: 5, time: 101, data: {} },
    );
    expect(chatMessage).toHaveBeenCalledTimes(1);

    // user/message append → routed.
    ctx.emit(
      "session/event",
      { id: "s1" },
      { type: "user/message", seq: 6, time: 102, data: { id: "m6" } },
    );
    expect(chatMessage).toHaveBeenCalledTimes(2);
  });

  it("regression: two-arg user/message fires chat-message with sub-type and arg0 sessionID", () => {
    const ctx = createFakeCtx();
    const chatMessage = mock((_p: DshHookPayload) => {});
    new DshHookProvider(ctx, { chatMessage });

    // arg0 is a Session-like record with `id` (no `type`); arg1 is the event.
    ctx.emit(
      "session/event",
      { id: "sess-42" },
      { type: "user/message", seq: 7, time: 1234, data: { id: "m7" } },
    );

    expect(chatMessage).toHaveBeenCalledTimes(1);
    const payload = chatMessage.mock.calls[0][0];
    expect(payload.sessionEventType).toBe("user/message");
    expect(payload.sessionID).toBe("sess-42");
    // The SessionEvent envelope fields ride along for consumers.
    expect(payload.seq).toBe(7);
    expect(payload.time).toBe(1234);
    expect(payload.data).toEqual({ id: "m7" });
  });

  it("regression: two-arg turn/end does NOT fire chat-message", () => {
    const ctx = createFakeCtx();
    const chatMessage = mock((_p: DshHookPayload) => {});
    new DshHookProvider(ctx, { chatMessage });

    ctx.emit(
      "session/event",
      { id: "sess-42" },
      { type: "turn/end", seq: 8, time: 5678, data: {} },
    );

    expect(chatMessage).not.toHaveBeenCalled();
  });

  it("regression: tools/post-execute and tools/result deliver the result argument", () => {
    const ctx = createFakeCtx();
    const toolAfter = mock((_p: DshHookPayload) => {});
    new DshHookProvider(ctx, { toolAfter });

    const postExec = ctx.listeners.get("tools/post-execute")![0] as (
      ...a: unknown[]
    ) => unknown;
    const postResult = ctx.listeners.get("tools/result")![0] as (
      ...a: unknown[]
    ) => unknown;

    postExec({ name: "bash", callId: "c1" }, { isError: true, value: "boom" }, () => ({}));
    postResult({ name: "bash", callId: "c1" }, { isError: false, value: "ok" });

    expect(toolAfter).toHaveBeenCalledTimes(2);
    expect(toolAfter.mock.calls[0][0].result).toEqual({ isError: true, value: "boom" });
    expect(toolAfter.mock.calls[1][0].result).toEqual({ isError: false, value: "ok" });
    // exec (arg0) is still merged at the top level.
    expect(toolAfter.mock.calls[0][0].tool).toBe("bash");
  });

  it("regression: waterfall next() chaining is unchanged", () => {
    // Guards the existing waterfall contract: post-execute strips the trailing
    // `next`, still delivers the result, and returns next()'s decision.
    const ctx = createFakeCtx();
    const toolAfter = mock((_p: DshHookPayload) => {});
    new DshHookProvider(ctx, { toolAfter });

    const listener = ctx.listeners.get("tools/post-execute")![0] as (
      ...a: unknown[]
    ) => unknown;
    const next = mock(() => ({ kind: "accept" }));

    const out = listener(
      { name: "bash", callId: "c1" },
      { isError: false, value: "ok" },
      next,
    );

    expect(toolAfter).toHaveBeenCalledTimes(1);
    expect(toolAfter.mock.calls[0][0].result).toEqual({ isError: false, value: "ok" });
    // `next` must not leak into the payload.
    expect(toolAfter.mock.calls[0][0].next).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ kind: "accept" });
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
