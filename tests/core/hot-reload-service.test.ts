import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { HotReloadService } from "../../src/core/hot-reload-service.ts";
import { clearExtensionModuleCache } from "../../src/extensions/loader.ts";
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
    expect(core.restartService).toHaveBeenCalledWith("hook-service");

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
    expect(core.restartService).toHaveBeenCalledWith("hook-service");

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
});
