import { describe, it, expect } from "bun:test";
import {
  ConcurrencyManager,
  QueueFullError,
} from "../../src/dispatch/concurrency/concurrency.ts";
import { deriveKey } from "../../src/dispatch/core/lifecycle-shared.ts";
import type { DispatchManagerConfig } from "../../src/dispatch/config.ts";

/**
 * Per-role dispatch-config refactor (Option B: composite keys `roleId::provider/model`).
 *
 * Coverage:
 *  (1) per-role isolation with a shared model — independent bg limits per role;
 *  (2) getLimit / getReserved resolve from each role's config for composite keys;
 *  (3) legacy plain keys (no `::` separator) fall back to constructor defaults;
 *  (4) per-key retryAfterMs surfaces in the QueueFullError of a full outcome;
 *  (5) deriveKey composite/fallback key derivation.
 */
describe("ConcurrencyManager per-role scope (composite keys roleId::model)", () => {
  // Partial per-role merged dispatch configs — the manager only reads the
  // concurrency-related fields. Cast to the full config type like production
  // does when merging partial role configs.
  const roleConfigs = new Map<string, Partial<DispatchManagerConfig>>([
    ["role-x", { maxConcurrent: 20, syncReservedSlots: 1, maxQueueDepth: 10, retryAfterMs: 15000 }],
    ["role-y", { maxConcurrent: 2, syncReservedSlots: 1 }],
  ]) as unknown as ReadonlyMap<string, DispatchManagerConfig>;

  it("(1) per-role isolation with a shared model — independent bg limits", () => {
    const cm = new ConcurrencyManager(5, 10, 1, 30_000, roleConfigs);

    // role-x::gpt-4 → maxConcurrent 20, syncReservedSlots 1 → bgLimit 19
    for (let i = 0; i < 19; i++) {
      const r = cm.acquireBackground("role-x::gpt-4");
      expect(r.outcome).toBe("acquired");
    }
    const x20th = cm.acquireBackground("role-x::gpt-4");
    expect(x20th.outcome).toBe("queued");
    if (x20th.outcome !== "queued") throw new Error("expected queued");
    expect(cm.getActiveCount("role-x::gpt-4")).toBe(19);

    // Same model "gpt-4" under role-y → maxConcurrent 2, syncReservedSlots 1 → bgLimit 1
    const y1st = cm.acquireBackground("role-y::gpt-4");
    expect(y1st.outcome).toBe("acquired");
    const y2nd = cm.acquireBackground("role-y::gpt-4");
    expect(y2nd.outcome).toBe("queued");
    if (y2nd.outcome !== "queued") throw new Error("expected queued");
    expect(cm.getActiveCount("role-y::gpt-4")).toBe(1);

    // role-x still at 19 — the shared model did not leak limits across roles
    expect(cm.getActiveCount("role-x::gpt-4")).toBe(19);
    expect(cm.getAllKeys().sort()).toEqual(["role-x::gpt-4", "role-y::gpt-4"]);

    x20th.cancel();
    y2nd.cancel();
  });

  it("(2) getLimit/getReserved reflect per-role configs for composite keys", () => {
    const cm = new ConcurrencyManager(5, 10, 1, 30_000, roleConfigs);

    // Touching a composite key creates its slot with the resolved role config
    cm.acquireBackground("role-x::gpt-4");
    cm.acquireBackground("role-y::gpt-4");

    expect(cm.getLimit("role-x::gpt-4")).toBe(20);
    expect(cm.getLimit("role-y::gpt-4")).toBe(2);
    expect(cm.getReserved("role-x::gpt-4")).toBe(1);
    expect(cm.getReserved("role-y::gpt-4")).toBe(1);

    // Distinct per-role reserved values prove getReserved resolves per-key,
    // not from the constructor default (3 here).
    const cm2 = new ConcurrencyManager(
      5, 10, 3, 30_000,
      new Map<string, Partial<DispatchManagerConfig>>([
        ["role-x", { maxConcurrent: 20, syncReservedSlots: 2 }],
        ["role-y", { maxConcurrent: 2, syncReservedSlots: 0 }],
      ]) as unknown as ReadonlyMap<string, DispatchManagerConfig>,
    );
    cm2.acquireBackground("role-x::gpt-4");
    cm2.acquireBackground("role-y::gpt-4");
    expect(cm2.getReserved("role-x::gpt-4")).toBe(2);
    expect(cm2.getReserved("role-y::gpt-4")).toBe(0);
    // Legacy plain key keeps the constructor default reserved
    expect(cm2.getReserved("gpt-4")).toBe(3);
  });

  it("(3) legacy plain keys (no role:: separator) fall back to constructor defaults", () => {
    const cm = new ConcurrencyManager(5, 10, 1, 30_000, roleConfigs);

    // bgLimit = defaultLimit - defaultReserved = 5 - 1 = 4
    for (let i = 0; i < 4; i++) {
      const r = cm.acquireBackground("gpt-4");
      expect(r.outcome).toBe("acquired");
    }
    const fifth = cm.acquireBackground("gpt-4");
    expect(fifth.outcome).toBe("queued");
    if (fifth.outcome !== "queued") throw new Error("expected queued");

    // Slot exists but was resolved to constructor defaults, not role configs
    expect(cm.getActiveCount("gpt-4")).toBe(4);
    expect(cm.getLimit("gpt-4")).toBe(5);
    expect(cm.getReserved("gpt-4")).toBe(1);

    fifth.cancel();
  });

  it("(4) per-key retryAfterMs surfaces in the QueueFullError of a full outcome", () => {
    const cm = new ConcurrencyManager(5, 10, 1, 30_000, roleConfigs);

    // role-x::gpt-4 → maxConcurrent 20, reserved 1 → bgLimit 19; queue depth 10
    for (let i = 0; i < 19; i++) {
      expect(cm.acquireBackground("role-x::gpt-4").outcome).toBe("acquired");
    }
    const queued: { cancel: () => void }[] = [];
    for (let i = 0; i < 10; i++) {
      const r = cm.acquireBackground("role-x::gpt-4");
      expect(r.outcome).toBe("queued");
      if (r.outcome === "queued") queued.push(r);
    }
    const full = cm.acquireBackground("role-x::gpt-4");
    expect(full.outcome).toBe("full");
    if (full.outcome !== "full") throw new Error("expected full");
    expect(full.error).toBeInstanceOf(QueueFullError);
    // role-x's retryAfterMs: 15000 — not the constructor default 30000
    expect(full.error.retryAfter).toBe(15_000);
    expect(full.error.limit).toBe(10);
    expect(full.error.message).toContain("Queue is full");

    // Clean up queued waiters so their TTL timers do not linger
    for (const q of queued) q.cancel();
  });
});

describe("deriveKey composite/fallback", () => {
  it("(5) returns roleId::model composite when a role resolves, plain model key otherwise", () => {
    const deps = {
      subagentModelKey: new Map([["sub-a", "gpt-4"]]),
      subagentRoleKey: new Map([["sub-a", "role-x"]]),
      roleConfigs: new Map([["role-x", { maxConcurrent: 20 }]]),
    } as any;

    // Explicit subagent→role mapping → composite key
    expect(deriveKey(deps, "sub-a")).toBe("role-x::gpt-4");

    // Empty subagentRoleKey → legacy fallback: plain model key
    const depsNoRole = {
      subagentModelKey: new Map([["sub-a", "gpt-4"]]),
      subagentRoleKey: new Map(),
      roleConfigs: new Map([["role-x", { maxConcurrent: 20 }]]),
    } as any;
    expect(deriveKey(depsNoRole, "sub-a")).toBe("gpt-4");
  });
});
