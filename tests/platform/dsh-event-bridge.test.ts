/// <reference types="bun-types" />

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DshEventBridge,
  mapDshEventType,
} from "../../src/platform/adapters/dsh/event-bridge.ts";
import type { CanonicalEvent } from "../../src/platform/ports/event-bridge.ts";

/**
 * Fake cordis ctx — records `on` subscriptions per event and lets tests
 * drive them via `emit`, exactly like the cordis Context event bus
 * (`ctx.on` / `ctx.emit`).
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

/** Let fire-and-forget async dispatch settle before asserting. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("DshEventBridge", () => {
  it("emitting a canonical event triggers the subscribed handler", async () => {
    const ctx = createFakeCtx();
    const bridge = new DshEventBridge(ctx);

    const received: CanonicalEvent[] = [];
    bridge.on((e) => {
      received.push(e);
    });

    const event: CanonicalEvent = {
      type: "session.created",
      rawType: "session/created",
      properties: { sessionID: "s1" },
    };
    await bridge.emit(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
    bridge.dispose();
  });

  it("onType handlers only receive events of the matching canonical type", async () => {
    const ctx = createFakeCtx();
    const bridge = new DshEventBridge(ctx);

    const created: CanonicalEvent[] = [];
    const idle: CanonicalEvent[] = [];
    bridge.onType("session.created", (e) => { created.push(e); });
    bridge.onType("session.idle", (e) => { idle.push(e); });

    await bridge.emit({
      type: "session.created",
      rawType: "session/created",
      properties: {},
    });
    await bridge.emit({
      type: "session.idle",
      rawType: "turn/end",
      properties: {},
    });

    expect(created).toHaveLength(1);
    expect(idle).toHaveLength(1);
    bridge.dispose();
  });

  it("unsubscribe removes a handler", async () => {
    const ctx = createFakeCtx();
    const bridge = new DshEventBridge(ctx);

    const received: CanonicalEvent[] = [];
    const off = bridge.on((e) => { received.push(e); });

    await bridge.emit({
      type: "session.created",
      rawType: "session/created",
      properties: {},
    });
    expect(received).toHaveLength(1);

    off();
    await bridge.emit({
      type: "session.created",
      rawType: "session/created",
      properties: {},
    });
    expect(received).toHaveLength(1);
    bridge.dispose();
  });

  it("bridges dsh session/created events into canonical events", async () => {
    const ctx = createFakeCtx();
    const bridge = new DshEventBridge(ctx);

    const received: CanonicalEvent[] = [];
    bridge.on((e) => { received.push(e); });

    ctx.emit("session/created", { id: "s1", seq: 0 });
    await flush();

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("session.created");
    expect(received[0].rawType).toBe("session/created");
    expect(received[0].properties.sessionID).toBe("s1");
    bridge.dispose();
  });

  it("bridges session/disposed into session.deleted", async () => {
    const ctx = createFakeCtx();
    const bridge = new DshEventBridge(ctx);

    const received: CanonicalEvent[] = [];
    bridge.on((e) => { received.push(e); });

    ctx.emit("session/disposed", { id: "s1" });
    await flush();

    expect(received[0].type).toBe("session.deleted");
    expect(received[0].rawType).toBe("session/disposed");
    bridge.dispose();
  });

  it("maps session/event sub-types (turn/end → session.idle)", async () => {
    const ctx = createFakeCtx();
    const bridge = new DshEventBridge(ctx);

    const received: CanonicalEvent[] = [];
    bridge.on((e) => { received.push(e); });

    ctx.emit("session/event", {
      id: "s1",
      seq: 3,
      type: "turn/end",
      data: { stopReason: "completed" },
    });
    await flush();

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("session.idle");
    expect(received[0].rawType).toBe("turn/end");
    expect(received[0].properties.sessionID).toBe("s1");
    expect(received[0].properties.sourceEvent).toBe("session/event");
    bridge.dispose();
  });

  it("maps session/event user/message appends into message.created", async () => {
    const ctx = createFakeCtx();
    const bridge = new DshEventBridge(ctx);

    const received: CanonicalEvent[] = [];
    bridge.on((e) => { received.push(e); });

    ctx.emit("session/event", { id: "s1", type: "user/message", seq: 1 });
    await flush();

    expect(received[0].type).toBe("message.created");
    expect(received[0].rawType).toBe("user/message");
    bridge.dispose();
  });

  it("bridges tools/result into part.updated", async () => {
    const ctx = createFakeCtx();
    const bridge = new DshEventBridge(ctx);

    const received: CanonicalEvent[] = [];
    bridge.on((e) => { received.push(e); });

    ctx.emit("tools/result", { name: "bash", callId: "c1" }, { isError: false, value: "ok" });
    await flush();

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("part.updated");
    expect(received[0].rawType).toBe("tools/result");
    bridge.dispose();
  });

  it("normalize maps unknown dsh types to unknown and preserves properties", () => {
    const ctx = createFakeCtx();
    const bridge = new DshEventBridge(ctx);

    const canonical = bridge.normalize({ type: "mystery/event", payload: "x" });
    expect(canonical.type).toBe("unknown");
    expect(canonical.rawType).toBe("mystery/event");
    expect(canonical.properties.payload).toBe("x");

    bridge.dispose();
  });

  it("dispose unsubscribes the dsh event listeners", async () => {
    const ctx = createFakeCtx();
    const bridge = new DshEventBridge(ctx);

    const received: CanonicalEvent[] = [];
    bridge.on((e) => { received.push(e); });

    bridge.dispose();
    ctx.emit("session/created", { id: "s1" });
    await flush();

    expect(received).toHaveLength(0);
  });
});

describe("mapDshEventType", () => {
  it("maps the verified dsh event names", () => {
    expect(mapDshEventType("session/created")).toBe("session.created");
    expect(mapDshEventType("session/disposed")).toBe("session.deleted");
    expect(mapDshEventType("session/flush")).toBe("session.updated");
    expect(mapDshEventType("tools/result")).toBe("part.updated");
    expect(mapDshEventType("tools/change")).toBe("session.updated");
    // SessionEvent sub-types
    expect(mapDshEventType("user/message")).toBe("message.created");
    expect(mapDshEventType("assistant/message")).toBe("message.created");
    expect(mapDshEventType("assistant/chunk")).toBe("part.updated");
    expect(mapDshEventType("tool/call")).toBe("part.created");
    expect(mapDshEventType("tool/result")).toBe("message.updated");
    expect(mapDshEventType("turn/start")).toBe("session.status");
    expect(mapDshEventType("turn/end")).toBe("session.idle");
    expect(mapDshEventType("todo/write")).toBe("session.updated");
  });

  it("resolves unmapped types to unknown", () => {
    expect(mapDshEventType("not/a-real-event")).toBe("unknown");
  });
});

describe("DshEventBridge is SDK-free", () => {
  it("contains no @opencode-ai or @deepseek-ai imports", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../../src/platform/adapters/dsh/event-bridge.ts"),
      "utf-8",
    );
    // Check import specifiers only — docstrings legitimately mention the
    // package scopes when documenting the "must not import" rule.
    const importRe =
      /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+["']([^"']+)["']/g;
    const specifiers: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(source)) !== null) {
      specifiers.push(match[1]);
    }
    const forbidden = specifiers.filter(
      (s) => s.includes("@opencode-ai/") || s.includes("@deepseek-ai/"),
    );
    expect(forbidden).toEqual([]);
  });
});
