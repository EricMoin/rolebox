/**
 * Pi synthetic session.status event wiring tests (subtask S4, updated for S6).
 *
 * Verifies the status-event wiring exported from `src/pi-extension.ts`
 * (`wirePiSessionStatusEvents`):
 *   1. pi.on("agent_start") → canonical session.status event with
 *      properties.status "busy" and the sessionID resolved through the
 *      extractSessionId fallback chain (sessionID / sessionId /
 *      info.sessionID / info.sessionId / info.id).
 *   2. pi.on("agent_settled") → canonical session.status event with
 *      properties.status "idle" and the correct sessionID.
 *   3. Events without a resolvable sessionID are dropped.
 *   4. The wiring is SYNTHESIS-ONLY — it never calls the dispatchManager
 *      directly. Routing session.status → dispatchManager.handleSessionStatus
 *      is owned by the PiHookPipeline (S6): its single handleEvent dispatch
 *      covers the completion pipeline's progress-heartbeat path (covered in
 *      tests/pi-hook-pipeline.test.ts).
 *   5. PiProcessSessionAdapter turn_end (_completeTurn) additionally
 *      emits a canonical session.status idle while the existing
 *      session.idle synthesis is unchanged (additive).
 *
 * @module
 */

import { describe, expect, it } from "bun:test";
import { PiProcessSessionAdapter } from "../src/platform/adapters/pi/process-session.ts";
import { PiEventBridge } from "../src/platform/adapters/pi/event-bridge.ts";
import { wirePiSessionStatusEvents } from "../src/pi-extension.ts";
import type { PiStatusWireResult } from "../src/pi-extension.ts";
import type { CanonicalEvent } from "../src/platform/types.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Capture pi.on registrations on a fake ExtensionAPI. */
function createMockPi(): {
  handlers: Map<string, (...args: unknown[]) => unknown>;
  pi: any;
} {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    pi: {
      on: (name: string, cb: (...args: unknown[]) => unknown) => {
        handlers.set(name, cb);
      },
    },
  };
}

/** Minimal DispatchManager spy — must NOT be called by the synthesis wiring. */
function createDispatchSpy(): {
  calls: Array<[string, string]>;
  dispatchManager: {
    handleSessionStatus(sessionId: string, statusType: string): Promise<void>;
  };
} {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    dispatchManager: {
      handleSessionStatus: async (sessionId: string, statusType: string) => {
        calls.push([sessionId, statusType]);
      },
    },
  };
}

/** Flush fire-and-forget `void eventBridge.emit(...)` chains. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── wirePiSessionStatusEvents ──────────────────────────────────────────────

describe("wirePiSessionStatusEvents", () => {
  it("agent_start → session.status busy with top-level sessionID", async () => {
    const { handlers, pi } = createMockPi();
    const eventBridge = new PiEventBridge();
    const spy = createDispatchSpy();
    const wiring: PiStatusWireResult = wirePiSessionStatusEvents({
      pi,
      eventBridge,
      dispatchManager: spy.dispatchManager,
    });

    const canonical: CanonicalEvent[] = [];
    const collect = eventBridge.onType("session.status", (event) => {
      canonical.push(event);
    });

    await handlers.get("agent_start")!(
      { type: "agent_start", sessionID: "sess-1" },
      {},
    );

    expect(canonical).toHaveLength(1);
    expect(canonical[0].type).toBe("session.status");
    expect(canonical[0].properties.status).toBe("busy");
    expect(canonical[0].properties.sessionID).toBe("sess-1");
    // Synthesis-only: the wiring never talks to the dispatchManager —
    // the S6 hook pipeline owns the handleSessionStatus routing.
    expect(spy.calls).toEqual([]);

    collect();
    wiring.unsubscribe();
  });

  it("agent_settled → session.status idle with info.sessionID fallback", async () => {
    const { handlers, pi } = createMockPi();
    const eventBridge = new PiEventBridge();
    const spy = createDispatchSpy();
    wirePiSessionStatusEvents({
      pi,
      eventBridge,
      dispatchManager: spy.dispatchManager,
    });

    const canonical: CanonicalEvent[] = [];
    const collect = eventBridge.onType("session.status", (event) => {
      canonical.push(event);
    });

    // info.sessionID fallback — the extractSessionId chain's third branch.
    await handlers.get("agent_settled")!(
      { type: "agent_settled", info: { sessionID: "sess-2" } },
      {},
    );

    expect(canonical).toHaveLength(1);
    expect(canonical[0].type).toBe("session.status");
    expect(canonical[0].properties.status).toBe("idle");
    expect(canonical[0].properties.sessionID).toBe("sess-2");
    expect(spy.calls).toEqual([]);

    collect();
  });

  it("agent_start resolves the sessionId camelCase fallback", async () => {
    const { handlers, pi } = createMockPi();
    const eventBridge = new PiEventBridge();
    const spy = createDispatchSpy();
    wirePiSessionStatusEvents({
      pi,
      eventBridge,
      dispatchManager: spy.dispatchManager,
    });

    const canonical: CanonicalEvent[] = [];
    const collect = eventBridge.onType("session.status", (event) => {
      canonical.push(event);
    });

    await handlers.get("agent_start")!({ type: "agent_start", sessionId: "sess-3" }, {});

    expect(canonical).toHaveLength(1);
    expect(canonical[0].properties.sessionID).toBe("sess-3");
    expect(spy.calls).toEqual([]);

    collect();
  });

  it("drops events with no resolvable sessionID", async () => {
    const { handlers, pi } = createMockPi();
    const eventBridge = new PiEventBridge();
    const spy = createDispatchSpy();
    wirePiSessionStatusEvents({
      pi,
      eventBridge,
      dispatchManager: spy.dispatchManager,
    });

    const canonical: CanonicalEvent[] = [];
    const collect = eventBridge.onType("session.status", (event) => {
      canonical.push(event);
    });

    await handlers.get("agent_start")!({ type: "agent_start" }, {});
    await handlers.get("agent_settled")!({ type: "agent_settled" }, {});

    expect(canonical).toHaveLength(0);
    expect(spy.calls).toEqual([]);

    collect();
  });

  it("unsubscribe is a no-op — the pi.on synthesis remains registered (S6: pipeline owns routing)", async () => {
    const { handlers, pi } = createMockPi();
    const eventBridge = new PiEventBridge();
    const spy = createDispatchSpy();
    const wiring = wirePiSessionStatusEvents({
      pi,
      eventBridge,
      dispatchManager: spy.dispatchManager,
    });

    const canonical: CanonicalEvent[] = [];
    const collect = eventBridge.onType("session.status", (event) => {
      canonical.push(event);
    });

    wiring.unsubscribe();
    await handlers.get("agent_settled")!({ type: "agent_settled", sessionID: "sess-9" }, {});

    // The synthesized event still flows into the bridge (pi.on handlers have
    // no Pi-side unsubscribe API); whether it reaches the dispatchManager is
    // decided by the hook pipeline's subscription, not this wiring.
    expect(canonical).toHaveLength(1);
    expect(canonical[0].properties.status).toBe("idle");
    expect(spy.calls).toEqual([]);

    collect();
  });

  it("is a no-op when pi.on is unavailable", () => {
    const eventBridge = new PiEventBridge();
    const spy = createDispatchSpy();
    expect(() =>
      wirePiSessionStatusEvents({
        pi: {},
        eventBridge,
        dispatchManager: spy.dispatchManager,
      }),
    ).not.toThrow();
  });
});

// ── PiProcessSessionAdapter turn_end status emission ───────────────────────

describe("PiProcessSessionAdapter turn_end status emission", () => {
  it("_completeTurn emits session.status idle alongside unchanged session.idle", async () => {
    const eventBridge = new PiEventBridge();
    const statuses: CanonicalEvent[] = [];
    eventBridge.onType("session.status", (event) => {
      statuses.push(event);
    });
    const idles: CanonicalEvent[] = [];
    eventBridge.onType("session.idle", (event) => {
      idles.push(event);
    });

    const adapter = new PiProcessSessionAdapter(undefined, undefined);
    adapter.setEventBridge(eventBridge);
    const info = await adapter.create({ directory: "/tmp/rolebox-test-project" });
    if (!info) throw new Error("adapter.create() returned null");
    const record = (adapter as any).processes.get(info.id);

    (adapter as any)._completeTurn(record);
    await flush();

    // Existing session.idle synthesis preserved.
    expect(idles).toHaveLength(1);
    expect(idles[0].type).toBe("session.idle");
    expect(idles[0].properties.sessionID).toBe(info.id);

    // Additive session.status idle.
    expect(statuses).toHaveLength(1);
    expect(statuses[0].type).toBe("session.status");
    expect(statuses[0].properties.status).toBe("idle");
    expect(statuses[0].properties.sessionID).toBe(info.id);
  });

  it("_completeTurn is idempotent — a second call emits nothing more", async () => {
    const eventBridge = new PiEventBridge();
    const statuses: CanonicalEvent[] = [];
    eventBridge.onType("session.status", (event) => {
      statuses.push(event);
    });

    const adapter = new PiProcessSessionAdapter(undefined, undefined);
    adapter.setEventBridge(eventBridge);
    const info = await adapter.create({ directory: "/tmp/rolebox-test-project" });
    if (!info) throw new Error("adapter.create() returned null");
    const record = (adapter as any).processes.get(info.id);

    (adapter as any)._completeTurn(record);
    (adapter as any)._completeTurn(record);
    await flush();

    expect(statuses).toHaveLength(1);
    expect(statuses[0].properties.status).toBe("idle");
    expect(statuses[0].properties.sessionID).toBe(info.id);
  });
});
