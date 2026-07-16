import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopService } from "../../src/core/services/loop-service";
import { hookState } from "../../src/hooks/state";

/**
 * Mock helpers for LoopService testing.
 *
 * PluginContext needs:
 *   - core.getService("dispatch-service") → a mock DispatchService
 *   - dispatchService.health() → { status: "healthy" }
 *   - dispatchService.getDispatchManager() → { getTask: () => undefined }
 *   - directory, rawDirectory → a real temp dir
 *   - client → { session: {}} (OpencodeSessionAdapter stores client.session)
 */

function createMockContext(tmpDir: string) {
  const mockDispatchManager = {
    getTask: mock(() => undefined),
  };

  const mockDispatchService = {
    health: mock(() => ({ status: "healthy" })),
    getDispatchManager: mock(() => mockDispatchManager),
  };

  // PluginCoreLike — only getService is used by LoopService.init()
  const mockCore = {
    getService: mock((name: string) => {
      if (name === "dispatch-service") return mockDispatchService;
      return undefined;
    }),
    getServices: mock(() => new Map()),
    restartService: mock(() => Promise.resolve()),
    isDegraded: mock(() => false),
  };

  // Cast to PluginContext — only init()-accessed properties are populated
  const client = { session: {} };

  return {
    directory: tmpDir,
    rawDirectory: tmpDir,
    core: mockCore,
    client,
    resolvedRoles: [],
    roleFunctionsMap: new Map(),
    roleGraphMap: new Map(),
    bus: { on: mock(() => {}), emit: mock(() => {}), off: mock(() => {}) },
  } as any;
}

describe("LoopService dispose → init recovery", () => {
  let svc: LoopService;
  let tmpDir: string;

  beforeEach(() => {
    svc = new LoopService();
    tmpDir = mkdtempSync(join(tmpdir(), "loop-dispose-"));
    hookState.loopManagerMap.clear();
    hookState.loopStoreMap.clear();
    hookState.activeLoopManager = undefined;
  });

  afterEach(() => {
    hookState.loopManagerMap.clear();
    hookState.loopStoreMap.clear();
    hookState.activeLoopManager = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  it("dispose clears loopManagerMap and loopStoreMap so re-init creates a fresh coordinator", async () => {
    const ctx = createMockContext(tmpDir);

    // ── First init ──────────────────────────────────────────────────────
    await svc.init(ctx);

    expect(hookState.loopManagerMap.has(tmpDir)).toBe(true);
    expect(hookState.loopStoreMap.has(tmpDir)).toBe(true);
    expect(hookState.activeLoopManager).toBeDefined();

    const oldManager = hookState.loopManagerMap.get(tmpDir);

    // ── Dispose (simulates hot-reload cascade) ───────────────────────────
    await svc.dispose();

    expect(hookState.loopManagerMap.has(tmpDir)).toBe(false);
    expect(hookState.loopStoreMap.has(tmpDir)).toBe(false);
    expect(hookState.activeLoopManager).toBeUndefined();

    // ── Second init (should NOT hit stale fast-path) ─────────────────────
    await svc.init(ctx);

    expect(hookState.loopManagerMap.has(tmpDir)).toBe(true);
    expect(hookState.loopStoreMap.has(tmpDir)).toBe(true);

    const newManager = hookState.loopManagerMap.get(tmpDir);
    // A fresh LoopCoordinator was created, not the disposed stale one
    expect(newManager).not.toBe(oldManager);
  });

  it("sequential init calls reuse the same coordinator (normal no-dispose path)", async () => {
    // This test verifies that the fast-path in init() still works for the
    // normal case (no dispose between inits).
    const ctx = createMockContext(tmpDir);

    await svc.init(ctx);
    const first = hookState.loopManagerMap.get(tmpDir);

    // Second init without dispose → fast-path reuses existing manager
    await svc.init(ctx);
    const second = hookState.loopManagerMap.get(tmpDir);

    expect(second).toBe(first); // Same coordinator — fast-path hit
    expect(hookState.loopManagerMap.has(tmpDir)).toBe(true);
    expect(hookState.loopStoreMap.has(tmpDir)).toBe(true);
  });

  it("service in degraded state skips both init and dispose map manipulations", async () => {
    // When dispatch-service is not available, init marks service as degraded
    const degradedCtx = {
      directory: tmpDir,
      rawDirectory: tmpDir,
      core: {
        getService: mock(() => undefined), // No dispatch-service
      },
      client: { session: {} },
    } as any;

    await svc.init(degradedCtx);

    // Maps should be empty (init returned early before setting them)
    expect(hookState.loopManagerMap.has(tmpDir)).toBe(false);
    expect(hookState.loopStoreMap.has(tmpDir)).toBe(false);
    expect(hookState.activeLoopManager).toBeUndefined();

    // dispose on degraded service is a no-op (also fine)
    await svc.dispose();
    // Still empty, no crash
  });
});
