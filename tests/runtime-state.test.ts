import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FunctionRuntimeManager } from "../src/function/runtime-state";

describe("FunctionRuntimeManager", () => {
  it("persists to disk and recovers with kv intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-test-"));
    try {
      const mgr1 = new FunctionRuntimeManager();
      mgr1.setStoreDirectory(dir);
      mgr1.init("sid", "plan", 1);
      const state = mgr1.get("sid", "plan")!;
      state.kv.x = 42;
      state.kv.y = "hello";
      mgr1.flushSync();

      const mgr2 = new FunctionRuntimeManager();
      mgr2.setStoreDirectory(dir);
      mgr2.recover();

      const recovered = mgr2.get("sid", "plan");
      expect(recovered).toBeDefined();
      expect(recovered!.kv.x).toBe(42);
      expect(recovered!.kv.y).toBe("hello");
      expect(recovered!.schemaVersion).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resets kv on schema skew (different version on re-init)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-test-"));
    try {
      const mgr = new FunctionRuntimeManager();
      mgr.setStoreDirectory(dir);

      // Init with version 1, set kv
      const s1 = mgr.init("sid", "plan", 1);
      s1.kv.x = 100;
      s1.phase = "gated";
      mgr.flushSync();

      // Init same fn with version 2 → schema skew → reset
      const s2 = mgr.init("sid", "plan", 2);
      // kv should be reset to empty object, phase back to "active"
      expect(s2.kv).toEqual({});
      expect(s2.phase).toBe("active");
      expect(s2.schemaVersion).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("markDirty triggers persistence (recover sees changes)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-test-"));
    try {
      const mgr1 = new FunctionRuntimeManager();
      mgr1.setStoreDirectory(dir);
      mgr1.init("sid", "fn-a", 1);
      mgr1.get("sid", "fn-a")!.kv.count = 1;
      mgr1.markDirty();
      mgr1.flushSync(); // force flush so it's on disk

      const mgr2 = new FunctionRuntimeManager();
      mgr2.setStoreDirectory(dir);
      mgr2.recover();
      expect(mgr2.get("sid", "fn-a")!.kv.count).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("all returns all functions for a session", () => {
    const mgr = new FunctionRuntimeManager();
    mgr.init("sid", "fn-a", 1);
    mgr.init("sid", "fn-b", 1);
    const all = mgr.all("sid");
    expect(all.size).toBe(2);
    expect(all.has("fn-a")).toBe(true);
    expect(all.has("fn-b")).toBe(true);
  });

  it("all returns empty map for unknown session", () => {
    const mgr = new FunctionRuntimeManager();
    const all = mgr.all("unknown");
    expect(all).toBeInstanceOf(Map);
    expect(all.size).toBe(0);
  });

  it("get returns undefined for unknown session", () => {
    const mgr = new FunctionRuntimeManager();
    expect(mgr.get("unknown", "fn")).toBeUndefined();
  });

  it("clearSession removes state and persists removal", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-test-"));
    try {
      const mgr1 = new FunctionRuntimeManager();
      mgr1.setStoreDirectory(dir);
      mgr1.init("sid", "plan", 1);
      mgr1.get("sid", "plan")!.kv.x = 99;
      mgr1.flushSync();

      mgr1.clearSession("sid");
      expect(mgr1.get("sid", "plan")).toBeUndefined();
      mgr1.flushSync();

      const mgr2 = new FunctionRuntimeManager();
      mgr2.setStoreDirectory(dir);
      mgr2.recover();
      expect(mgr2.get("sid", "plan")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recover is no-op when store not set", () => {
    const mgr = new FunctionRuntimeManager();
    mgr.init("sid", "plan", 1);
    mgr.recover(); // no-op, should not throw
    expect(mgr.get("sid", "plan")).toBeDefined();
  });
});
