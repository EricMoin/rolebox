import { describe, it, expect } from "bun:test";
import { HookState, hookState } from "../../src/hooks/state.ts";

// ── HookState Instance ───────────────────────────────────────────────────────

describe("HookState", () => {
  it("initializes with empty managed maps", () => {
    const state = new HookState();
    expect(state.managerMap.size).toBe(0);
    expect(state.loopManagerMap.size).toBe(0);
    expect(state.loopStoreMap.size).toBe(0);
  });

  it("initializes with empty session state collections", () => {
    const state = new HookState();
    expect(state.pendingCorrections.size).toBe(0);
    expect(state.userMessagedSessions.size).toBe(0);
    expect(state.sessionAgentRegistry.size).toBe(0);
  });

  it("initializes with empty role state collections", () => {
    const state = new HookState();
    expect(state.roleAutoActivateMap.size).toBe(0);
    expect(state.roleLockedMap.size).toBe(0);
    expect(state.autoActivatedSessions.size).toBe(0);
  });

  it("initializes activeLoopManager as undefined", () => {
    const state = new HookState();
    expect(state.activeLoopManager).toBeUndefined();
  });

  it("initializes shutdownRegistered as false", () => {
    const state = new HookState();
    expect(state.shutdownRegistered).toBe(false);
  });

  it("supports concurrent writes to pendingCorrections across sessions", () => {
    const state = new HookState();
    state.pendingCorrections.set("sess-a", "correction A");
    state.pendingCorrections.set("sess-b", "correction B");

    // Simulate concurrent writes from multiple hook phases
    const existingA = state.pendingCorrections.get("sess-a") ?? "";
    state.pendingCorrections.set("sess-a", existingA + "\ncorrection A2");

    expect(state.pendingCorrections.get("sess-a")).toBe("correction A\ncorrection A2");
    expect(state.pendingCorrections.get("sess-b")).toBe("correction B");
  });

  it("supports concurrent writes to userMessagedSessions", () => {
    const state = new HookState();
    state.userMessagedSessions.add("sess-1");
    state.userMessagedSessions.add("sess-2");
    state.userMessagedSessions.add("sess-1"); // duplicate

    expect(state.userMessagedSessions.size).toBe(2);
    expect(state.userMessagedSessions.has("sess-1")).toBe(true);
    expect(state.userMessagedSessions.has("sess-2")).toBe(true);
  });

  it("supports concurrent writes to sessionAgentRegistry", () => {
    const state = new HookState();
    state.sessionAgentRegistry.set("sess-1", "agent-alpha");
    state.sessionAgentRegistry.set("sess-2", "agent-beta");

    // Overwrite
    state.sessionAgentRegistry.set("sess-1", "agent-gamma");

    expect(state.sessionAgentRegistry.get("sess-1")).toBe("agent-gamma");
    expect(state.sessionAgentRegistry.get("sess-2")).toBe("agent-beta");
  });

  it("supports concurrent writes to roleAutoActivateMap", () => {
    const state = new HookState();
    state.roleAutoActivateMap.set("role-a", ["fn1", "fn2"]);
    state.roleAutoActivateMap.set("role-b", ["fn3"]);

    expect(state.roleAutoActivateMap.get("role-a")).toEqual(["fn1", "fn2"]);
    expect(state.roleAutoActivateMap.get("role-b")).toEqual(["fn3"]);
  });

  it("supports concurrent writes to roleLockedMap", () => {
    const state = new HookState();
    state.roleLockedMap.set("role-a", true);
    state.roleLockedMap.set("role-b", false);

    expect(state.roleLockedMap.get("role-a")).toBe(true);
    expect(state.roleLockedMap.get("role-b")).toBe(false);
  });

  it("supports concurrent writes to autoActivatedSessions", () => {
    const state = new HookState();
    state.autoActivatedSessions.add("sess-1");
    state.autoActivatedSessions.add("sess-2");
    state.autoActivatedSessions.add("sess-1"); // duplicate

    expect(state.autoActivatedSessions.size).toBe(2);
  });

  // ── Guard: read-after-write consistency across collections ──

  it("maintains read-after-write consistency across multiple collections", () => {
    const state = new HookState();

    // Simulate the lifecycle: session agent registration + correction
    state.sessionAgentRegistry.set("sess-1", "test-agent");
    state.pendingCorrections.set("sess-1", "correction");
    state.userMessagedSessions.add("sess-1");

    expect(state.sessionAgentRegistry.get("sess-1")).toBe("test-agent");
    expect(state.pendingCorrections.get("sess-1")).toBe("correction");
    expect(state.userMessagedSessions.has("sess-1")).toBe(true);
  });
});

// ── Singleton ────────────────────────────────────────────────────────────────

describe("hookState singleton", () => {
  it("exists and is a HookState instance", () => {
    expect(hookState).toBeInstanceOf(HookState);
  });

  it("has all expected properties", () => {
    expect(hookState).toHaveProperty("managerMap");
    expect(hookState).toHaveProperty("loopManagerMap");
    expect(hookState).toHaveProperty("loopStoreMap");
    expect(hookState).toHaveProperty("activeLoopManager");
    expect(hookState).toHaveProperty("pendingCorrections");
    expect(hookState).toHaveProperty("userMessagedSessions");
    expect(hookState).toHaveProperty("sessionAgentRegistry");
    expect(hookState).toHaveProperty("roleAutoActivateMap");
    expect(hookState).toHaveProperty("roleLockedMap");
    expect(hookState).toHaveProperty("autoActivatedSessions");
    expect(hookState).toHaveProperty("shutdownRegistered");
  });
});
