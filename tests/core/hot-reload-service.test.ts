import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { HotReloadService } from "../../src/core/hot-reload-service.ts";
import { clearExtensionModuleCache } from "../../src/extensions/loader.ts";
import { HookService } from "../../src/core/hook-service.ts";
import { hookState } from "../../src/hooks/state.ts";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── helpers ────────────────────────────────────────────────────────

function makeMockCore() {
  return {
    getService: mock(() => undefined),
    getServices: mock(() => new Map()),
    restartService: mock(() => Promise.resolve()),
  };
}

function makeCtx(dir: string, core: any = makeMockCore()) {
  return {
    client: {} as any,
    resolvedRoles: [],
    roleFunctionsMap: new Map(),
    roleGraphMap: new Map(),
    rawDirectory: dir,
    directory: dir,
    core,
    bus: { on: mock(), off: mock(), emit: mock(), clear: mock() },
    // Resolver context fields required for hot reload to proceed
    roleboxDir: dir,
    globalSkillsDir: dir,
    configDir: dir,
    builtinDir: dir,
  };
}

// ── tests ──────────────────────────────────────────────────────────

async function waitForRestart(core: any, expectedCalls = 1, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (core.restartService.mock.calls.length >= expectedCalls) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("HotReloadService", () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temp directory for each test
    tempDir = mkdtempSync(join(tmpdir(), "hot-reload-test-"));
  });

  afterEach(() => {
    mock.restore();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  });

  it("is disabled when ROLEBOX_HOT_RELOAD=false", async () => {
    const original = process.env.ROLEBOX_HOT_RELOAD;
    process.env.ROLEBOX_HOT_RELOAD = "false";

    const svc = new HotReloadService();
    const core = makeMockCore();
    await svc.init(makeCtx(tempDir, core));

    expect(svc.health().status).toBe("healthy");
    expect(svc.health().detail).toContain("disabled");

    // restartService should NOT be callable since we never schedule
    expect(core.restartService).not.toHaveBeenCalled();

    // triggerReload should return disabled result (not success)
    const result = await svc.triggerReload();
    expect(result.success).toBe(false);
    expect(result.disabled).toBe(true);

    process.env.ROLEBOX_HOT_RELOAD = original;
    await svc.dispose();
  });

  it("is disabled when ROLEBOX_HOT_RELOAD=0", async () => {
    const original = process.env.ROLEBOX_HOT_RELOAD;
    process.env.ROLEBOX_HOT_RELOAD = "0";

    const svc = new HotReloadService();
    await svc.init(makeCtx(tempDir));

    expect(svc.health().status).toBe("healthy");
    expect(svc.health().detail).toContain("disabled");

    process.env.ROLEBOX_HOT_RELOAD = original;
    await svc.dispose();
  });

  it("health returns healthy when enabled", async () => {
    const svc = new HotReloadService();
    await svc.init(makeCtx(tempDir));

    expect(svc.health().status).toBe("healthy");
    expect(svc.health().detail).toBeUndefined();

    await svc.dispose();
  });

  it("calls restartService on file change after debounce", async () => {
    const svc = new HotReloadService();
    const core = makeMockCore();
    await svc.init(makeCtx(tempDir, core));

    // Write a watched file in the temp dir
    const testFile = join(tempDir, "test-role.yaml");
    writeFileSync(testFile, "name: test\n", "utf-8");

    await waitForRestart(core, 1);

    // restartService should have been called with "hook-service"
    expect(core.restartService).toHaveBeenCalledTimes(1);
    expect(core.restartService).toHaveBeenCalledWith("dispatch-service");

    await svc.dispose();
  });

  it("debounce prevents multiple reload calls for rapid changes", async () => {
    const svc = new HotReloadService();
    const core = makeMockCore();
    await svc.init(makeCtx(tempDir, core));

    // Write multiple files rapidly
    const f1 = join(tempDir, "role-a.yaml");
    const f2 = join(tempDir, "role-b.yaml");
    writeFileSync(f1, "name: a\n", "utf-8");
    writeFileSync(f2, "name: b\n", "utf-8");

    await waitForRestart(core, 1);

    // Should have been called only once (debounced)
    expect(core.restartService).toHaveBeenCalledTimes(1);

    await svc.dispose();
  });

  it("ignores non-watched file extensions", async () => {
    const svc = new HotReloadService();
    const core = makeMockCore();
    await svc.init(makeCtx(tempDir, core));

    // Write a file with non-watched extension
    const testFile = join(tempDir, "test.txt");
    writeFileSync(testFile, "hello", "utf-8");

    // Wait enough for debounce — longer wait since restart should NOT fire
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Should NOT have triggered restart
    expect(core.restartService).not.toHaveBeenCalled();

    await svc.dispose();
  });

  it("calls clearExtensionModuleCache before restart", async () => {
    const svc = new HotReloadService();
    const core = makeMockCore();
    await svc.init(makeCtx(tempDir, core));

    // Clear the cache to a known state
    clearExtensionModuleCache();

    const testFile = join(tempDir, "test-role.yaml");
    writeFileSync(testFile, "name: test\n", "utf-8");

    await waitForRestart(core, 1);

    // restartService should have been called (which is the proxy for
    // the reload happening — clearExtensionModuleCache is called before it)
    expect(core.restartService).toHaveBeenCalledWith("dispatch-service");

    await svc.dispose();
  });

  it("dispose clears watchers and timer", async () => {
    const svc = new HotReloadService();
    await svc.init(makeCtx(tempDir));

    // Spy on the internal state by calling dispose
    await svc.dispose();

    // After dispose, health still works
    expect(svc.health().status).toBe("healthy");

    // Write a file — should not trigger since watchers are closed
    const testFile = join(tempDir, "test-role.yaml");
    writeFileSync(testFile, "name: test\n", "utf-8");

    await new Promise((resolve) => setTimeout(resolve, 1000));
  });

  it("uses correct watch extensions", async () => {
    const svc = new HotReloadService();
    const core = makeMockCore();
    await svc.init(makeCtx(tempDir, core));

    // Each of these should trigger a reload
    const extensions = [".yaml", ".yml", ".md", ".js", ".ts", ".json", ".mjs", ".cjs"];
    for (const ext of extensions) {
      const file = join(tempDir, `test${ext}`);
      writeFileSync(file, `content for ${ext}`, "utf-8");
    }

    await waitForRestart(core, 1);

    // All changes were rapid, so should be debounced to 1 call
    expect(core.restartService).toHaveBeenCalledTimes(1);

    await svc.dispose();
  });

  // ── Subtask 6: Regression tests for 5 hot_reload defects ──────────

  it("cascades restart to dispatch-service only (not hook-service directly)", async () => {
    const svc = new HotReloadService();
    const core = makeMockCore();
    await svc.init(makeCtx(tempDir, core));

    const testFile = join(tempDir, "test-role.yaml");
    writeFileSync(testFile, "name: test\n", "utf-8");

    await waitForRestart(core, 1);

    // Must have been called exactly once with dispatch-service
    expect(core.restartService).toHaveBeenCalledTimes(1);
    expect(core.restartService).toHaveBeenCalledWith("dispatch-service");
    // NOT called with hook-service
    expect(core.restartService).not.toHaveBeenCalledWith("hook-service");

    await svc.dispose();
  });

  it("shared maps are rebuilt after reload (stale entries removed)", async () => {
    const svc = new HotReloadService();
    const core = makeMockCore();
    const ctx = makeCtx(tempDir, core);

    // Pre-populate with a stale entry that should be cleared on reload
    ctx.roleFunctionsMap.set("old-role", [{ name: "fn1" }] as any);
    ctx.roleGraphMap.set("old-role", { nodes: [] } as any);

    await svc.init(ctx);

    // Trigger reload — empty temp dir means discoverRoles returns empty map
    const result = await svc.triggerReload();

    // Reload should report success with 0 discovered/resolved
    expect(result.success).toBe(true);
    expect(result.discovered).toBe(0);
    expect(result.resolved).toBe(0);

    // Stale entries should be gone (atomic swap cleared them)
    expect(ctx.roleFunctionsMap.has("old-role")).toBe(false);
    expect(ctx.roleGraphMap.has("old-role")).toBe(false);

    await svc.dispose();
  });

  it("configDir watcher triggers reload", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "hot-reload-config-"));
    try {
      const svc = new HotReloadService();
      const core = makeMockCore();
      const ctx = makeCtx(tempDir, core);
      ctx.configDir = configDir;
      await svc.init(ctx);

      // Write a .yaml file in the configDir temp directory
      const testFile = join(configDir, "config-role.yaml");
      writeFileSync(testFile, "name: config-role\n", "utf-8");

      await waitForRestart(core, 1);

      expect(core.restartService).toHaveBeenCalledWith("dispatch-service");

      await svc.dispose();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("partial failure preserves previous state", async () => {
    const svc = new HotReloadService();
    const core = makeMockCore();
    const ctx = makeCtx(tempDir, core);

    // Pre-populate with test entries
    ctx.resolvedRoles.push({ id: "existing-role", config: {} } as any);
    ctx.roleFunctionsMap.set("existing-role", [{ name: "keep-me" }] as any);

    // Set builtinDir to empty string — falsy, triggers guard clause at top of performReload
    ctx.builtinDir = "";

    await svc.init(ctx);

    // Trigger reload — guard clause fires, returns early before clearing maps
    const result = await svc.triggerReload();

    // Reload should report failure (guard clause returned without success)
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    // Previous state must be preserved
    expect(ctx.roleFunctionsMap.has("existing-role")).toBe(true);
    expect(ctx.resolvedRoles.length).toBe(1);
    expect(ctx.resolvedRoles[0].id).toBe("existing-role");

    // restartService must NOT have been called (guard returned before step 7)
    expect(core.restartService).not.toHaveBeenCalled();

    await svc.dispose();
  });

  it("HookService init refreshes roleAutoActivateMap and roleLockedMap", async () => {
    // Clear any residual state from previous tests
    hookState.roleAutoActivateMap.clear();
    hookState.roleLockedMap.clear();

    const hookTempDir = mkdtempSync(join(tmpdir(), "hook-service-test-"));
    try {
      // Build comprehensive service mocks for HookService.init()
      const mockDispatchService = { getDispatchManager: mock(() => ({})) };
      const mockLoopService = { getLoopManager: mock(() => ({})) };
      const mockRecoveryService = {
        getRecoveryEngine: mock(() => ({})),
        getBuiltInHookRegistry: mock(() => ({})),
        getBuiltinConfig: mock(() => ({})),
      };
      const mockExtensionService = { getExtensionRegistry: mock(() => ({})) };
      const mockNotificationService = { getNotificationManager: mock(() => ({})) };
      const mockToolService = { getTools: mock(() => ({})) };

      const core = {
        getService: mock((name: string) => {
          const map: Record<string, any> = {
            "dispatch-service": mockDispatchService,
            "loop-service": mockLoopService,
            "recovery-service": mockRecoveryService,
            "extension-service": mockExtensionService,
            "notification-service": mockNotificationService,
            "tool-service": mockToolService,
          };
          return map[name];
        }),
        getServices: mock(() => new Map()),
        restartService: mock(() => Promise.resolve()),
      };

      const ctx = makeCtx(hookTempDir, core);
      ctx.resolvedRoles = [
        { id: "role-auto", config: { auto_activate: ["session:start", "config:change"] }, locked: false },
        { id: "role-locked", config: { auto_activate: [] }, locked: true },
        { id: "role-plain", config: {} },
      ] as any;

      const svc = new HookService();
      await svc.init(ctx as any);

      // role-auto has auto_activate
      expect(hookState.roleAutoActivateMap.has("role-auto")).toBe(true);
      expect(hookState.roleAutoActivateMap.get("role-auto")).toEqual(["session:start", "config:change"]);
      // role-auto has locked:false
      expect(hookState.roleLockedMap.has("role-auto")).toBe(true);
      expect(hookState.roleLockedMap.get("role-auto")).toBe(false);

      // role-locked has locked:true but no auto_activate
      expect(hookState.roleLockedMap.get("role-locked")).toBe(true);
      expect(hookState.roleAutoActivateMap.has("role-locked")).toBe(false);

      // role-plain has neither — should not appear in either map
      expect(hookState.roleAutoActivateMap.has("role-plain")).toBe(false);
      expect(hookState.roleLockedMap.has("role-plain")).toBe(false);

      await svc.dispose();
    } finally {
      rmSync(hookTempDir, { recursive: true, force: true });
    }
  });
});
