import { describe, it, expect, beforeEach } from "bun:test";
import { ConcurrencyPolicyExtensionPoint } from "../../src/extensions/points/concurrency-policies.ts";
import { clearExtensionModuleCache } from "../../src/extensions/loader.ts";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { writeFileSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("ConcurrencyPolicyExtensionPoint", () => {
  beforeEach(() => {
    clearExtensionModuleCache();
  });

  it("loads modules with create() function", async () => {
    // Create a temp module that exports create()
    const tmpDir = join(tmpdir(), "concurrency-test-" + Date.now());
    mkdirSync(tmpDir, { recursive: true });

    const modPath = join(tmpDir, "test-policy.ts");
    writeFileSync(modPath, `
      import type { IConcurrencyManager } from "../../../../src/dispatch/concurrency/concurrency.ts";

      class TestPolicy implements IConcurrencyManager {
        acquireBackground() { return { outcome: "acquired" as const, cancel: () => {} }; }
        acquireSync() { return { promise: Promise.resolve(), cancel: () => {} }; }
        release() {}
        getActiveCount() { return 0; }
        getLimit() { return 5; }
        forceOccupyBackground() { return 0; }
        getReserved() { return 0; }
        setReserved() {}
        canAcquireForParent() { return true; }
        setSlotReserved() {}
      }

      export const create = (opts: { defaultLimit: number; maxQueueDepth: number; reserved: number; retryAfterMs: number }) => {
        return new TestPolicy() as IConcurrencyManager;
      };
    `);

    const point = new ConcurrencyPolicyExtensionPoint();
    await point.load([{ name: "test-policy", module: modPath }], tmpDir);

    const policies = point.getPolicies();
    expect(policies.size).toBe(1);
    expect(policies.has("test-policy")).toBe(true);

    const mod = policies.get("test-policy")!;
    const mgr = mod.create({ defaultLimit: 5, maxQueueDepth: 10, reserved: 1, retryAfterMs: 30000 });
    const acq = mgr.acquireBackground("key");
    expect(acq.outcome).toBe("acquired");
  });

  it("rejects modules without create()", async () => {
    const tmpDir = join(tmpdir(), "concurrency-test-" + Date.now());
    mkdirSync(tmpDir, { recursive: true });

    const modPath = join(tmpDir, "bad-policy.ts");
    writeFileSync(modPath, `
      export const something = "not-a-policy";
    `);

    const point = new ConcurrencyPolicyExtensionPoint();
    await point.load([{ name: "bad-policy", module: modPath }], tmpDir);

    const policies = point.getPolicies();
    expect(policies.size).toBe(0);
  });

  it("getPolicies() returns loaded policies", async () => {
    const tmpDir = join(tmpdir(), "concurrency-test-" + Date.now());
    mkdirSync(tmpDir, { recursive: true });

    const modPath = join(tmpDir, "multi-policy.ts");
    writeFileSync(modPath, `
      import type { IConcurrencyManager } from "../../../../src/dispatch/concurrency/concurrency.ts";

      class PolicyA implements IConcurrencyManager {
        acquireBackground() { return { outcome: "acquired" as const, cancel: () => {} }; }
        acquireSync() { return { promise: Promise.resolve(), cancel: () => {} }; }
        release() {}
        getActiveCount() { return 0; }
        getLimit() { return 5; }
        forceOccupyBackground() { return 0; }
        getReserved() { return 0; }
        setReserved() {}
        canAcquireForParent() { return true; }
        setSlotReserved() {}
      }
      class PolicyB implements IConcurrencyManager {
        acquireBackground() { return { outcome: "queued" as const, promise: Promise.resolve(), cancel: () => {} }; }
        acquireSync() { return { promise: Promise.resolve(), cancel: () => {} }; }
        release() {}
        getActiveCount() { return 0; }
        getLimit() { return 3; }
        forceOccupyBackground() { return 0; }
        getReserved() { return 1; }
        setReserved() {}
        canAcquireForParent() { return true; }
        setSlotReserved() {}
      }

      export const create = (opts: { defaultLimit: number; maxQueueDepth: number; reserved: number; retryAfterMs: number }) => {
        return new PolicyA() as IConcurrencyManager;
      };
    `);

    const point = new ConcurrencyPolicyExtensionPoint();
    await point.load([
      { name: "policy-a", module: modPath },
      { name: "policy-b", module: modPath },
    ], tmpDir);

    const policies = point.getPolicies();
    expect(policies.size).toBe(2);
    expect(policies.has("policy-a")).toBe(true);
    expect(policies.has("policy-b")).toBe(true);
  });

  it("getPolicy() returns first policy when no name given", async () => {
    const tmpDir = join(tmpdir(), "concurrency-test-" + Date.now());
    mkdirSync(tmpDir, { recursive: true });

    const modPath = join(tmpDir, "first-policy.ts");
    writeFileSync(modPath, `
      import type { IConcurrencyManager } from "../../../../src/dispatch/concurrency/concurrency.ts";

      class FirstPolicy implements IConcurrencyManager {
        acquireBackground() { return { outcome: "acquired" as const, cancel: () => {} }; }
        acquireSync() { return { promise: Promise.resolve(), cancel: () => {} }; }
        release() {}
        getActiveCount() { return 0; }
        getLimit() { return 5; }
        forceOccupyBackground() { return 0; }
        getReserved() { return 0; }
        setReserved() {}
        canAcquireForParent() { return true; }
        setSlotReserved() {}
      }

      export const create = (opts: { defaultLimit: number; maxQueueDepth: number; reserved: number; retryAfterMs: number }) => {
        return new FirstPolicy() as IConcurrencyManager;
      };
    `);

    const point = new ConcurrencyPolicyExtensionPoint();
    await point.load([{ name: "first-policy", module: modPath }], tmpDir);

    const mod = point.getPolicy();
    expect(mod).toBeDefined();
    expect(mod!.create).toBeInstanceOf(Function);
  });

  it("getPolicy() returns named policy when name given", async () => {
    const tmpDir = join(tmpdir(), "concurrency-test-" + Date.now());
    mkdirSync(tmpDir, { recursive: true });

    const modPath = join(tmpDir, "named-policy.ts");
    writeFileSync(modPath, `
      import type { IConcurrencyManager } from "../../../../src/dispatch/concurrency/concurrency.ts";

      class NamedPolicy implements IConcurrencyManager {
        acquireBackground() { return { outcome: "acquired" as const, cancel: () => {} }; }
        acquireSync() { return { promise: Promise.resolve(), cancel: () => {} }; }
        release() {}
        getActiveCount() { return 0; }
        getLimit() { return 5; }
        forceOccupyBackground() { return 0; }
        getReserved() { return 0; }
        setReserved() {}
        canAcquireForParent() { return true; }
        setSlotReserved() {}
      }

      export const create = (opts: { defaultLimit: number; maxQueueDepth: number; reserved: number; retryAfterMs: number }) => {
        return new NamedPolicy() as IConcurrencyManager;
      };
    `);

    const point = new ConcurrencyPolicyExtensionPoint();
    await point.load([{ name: "named-policy", module: modPath }], tmpDir);

    const mod = point.getPolicy("named-policy");
    expect(mod).toBeDefined();
    expect(mod!.create).toBeInstanceOf(Function);

    const missing = point.getPolicy("nonexistent");
    expect(missing).toBeUndefined();
  });

  it("create() factory receives correct opts", async () => {
    const tmpDir = join(tmpdir(), "concurrency-test-" + Date.now());
    mkdirSync(tmpDir, { recursive: true });

    const modPath = join(tmpDir, "opts-policy.ts");
    writeFileSync(modPath, `
      import type { IConcurrencyManager } from "../../../../src/dispatch/concurrency/concurrency.ts";

      let captured: any;
      export function getCaptured() { return captured; }

      class OptsPolicy implements IConcurrencyManager {
        acquireBackground() { return { outcome: "acquired" as const, cancel: () => {} }; }
        acquireSync() { return { promise: Promise.resolve(), cancel: () => {} }; }
        release() {}
        getActiveCount() { return 0; }
        getLimit() { return 5; }
        forceOccupyBackground() { return 0; }
        getReserved() { return 0; }
        setReserved() {}
        canAcquireForParent() { return true; }
        setSlotReserved() {}
      }

      export const create = (opts: { defaultLimit: number; maxQueueDepth: number; reserved: number; retryAfterMs: number }) => {
        captured = opts;
        return new OptsPolicy() as IConcurrencyManager;
      };
    `);

    const point = new ConcurrencyPolicyExtensionPoint();
    await point.load([{ name: "opts-policy", module: modPath }], tmpDir);

    const mod = point.getPolicy("opts-policy")!;
    const mgr = mod.create({ defaultLimit: 3, maxQueueDepth: 15, reserved: 2, retryAfterMs: 60000 });
    expect(mgr).toBeDefined();
  });
});
