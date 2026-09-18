/**
 * Dispatch-service restart regression tests.
 *
 * Verifies that `PluginCore.restartService("dispatch-service")` produces a
 * FRESH DispatchManager whose periodic timers are re-armed and whose state
 * store re-acquires the state lock, and that a zombie manager (sweeper
 * stopped) reports unhealthy so HealthMonitorService restarts it.
 *
 * The state-file assertion is the one that fails if the fresh store were
 * read-only (the old manager leaked its lock file).
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { PluginCore } from "../../src/core/plugin-core.ts";
import { DispatchService } from "../../src/core/services/dispatch-service.ts";
import { HealthMonitorService } from "../../src/core/services/health-monitor-service.ts";
import type { PluginContext } from "../../src/core/context.ts";
import type { PluginCoreLike } from "../../src/core/service.ts";
import { hookState } from "../../src/hooks/state.ts";
import { createMockClient } from "../dispatch/helpers.ts";

function makeContext(core: PluginCore, dir: string): PluginContext {
  return {
    client: createMockClient() as any,
    resolvedRoles: [],
    roleFunctionsMap: new Map(),
    roleGraphMap: new Map(),
    rawDirectory: dir,
    directory: dir,
    core: core as unknown as PluginCoreLike,
    bus: core.getBus(),
  };
}

/** State files written by TaskStateStore under <dir>/.rolebox/state. */
function stateFiles(dir: string): string[] {
  const stateDir = path.join(dir, ".rolebox", "state");
  try {
    return readdirSync(stateDir).filter((f) => /^dispatch-.*\.json$/.test(f));
  } catch {
    return [];
  }
}

describe("dispatch-service restart (integration)", () => {
  it("restartService() rebuilds a fresh, operational manager that can persist", async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "dispatch-restart-"));
    const core = new PluginCore();
    const svc = new DispatchService({ sessionClient: createMockClient() });
    core.registerService(svc);

    try {
      await core.init(makeContext(core, tmpDir));
      const m1 = svc.getDispatchManager();
      expect(m1.isOperational()).toBe(true);

      await core.restartService("dispatch-service");

      const m2 = svc.getDispatchManager();
      expect(m2).not.toBe(m1);
      expect(m1.isOperational()).toBe(false);
      expect(m2.isOperational()).toBe(true);
      expect(hookState.managerMap.get(tmpDir)).toBe(m2);
      expect(svc.health().status).toBe("healthy");
      // Fresh store re-acquired the state lock (the old manager released it)
      expect((m2 as any).store.readOnly).toBe(false);

      // Persistence actually reaches disk — this fails if the fresh store
      // silently degraded to read-only.
      for (const f of stateFiles(tmpDir)) {
        unlinkSync(path.join(tmpDir, ".rolebox", "state", f));
      }
      expect(stateFiles(tmpDir)).toHaveLength(0);

      m2.persistState();
      await m2.flushPersist();
      expect(stateFiles(tmpDir)).toHaveLength(1);
    } finally {
      await core.dispose();
      hookState.managerMap.delete(tmpDir);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("a zombie manager reports unhealthy and is restarted by HealthMonitorService", async () => {
    const prevInterval = process.env.ROLEBOX_HEALTH_CHECK_INTERVAL_MS;
    process.env.ROLEBOX_HEALTH_CHECK_INTERVAL_MS = "50";

    const tmpDir = mkdtempSync(path.join(tmpdir(), "dispatch-restart-health-"));
    const core = new PluginCore();
    const svc = new DispatchService({ sessionClient: createMockClient() });
    core.registerService(svc);
    core.registerService(new HealthMonitorService());

    try {
      await core.init(makeContext(core, tmpDir));
      const m1 = svc.getDispatchManager();

      // Zombify: stop the periodic pipelines without disposing the manager
      m1.flushPersistSync();
      expect(svc.health().status).toBe("unhealthy");

      const deadline = Date.now() + 1000;
      while (svc.getDispatchManager() === m1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }

      const m2 = svc.getDispatchManager();
      expect(m2).not.toBe(m1);
      expect(m2.isOperational()).toBe(true);
      expect(svc.health().status).toBe("healthy");
    } finally {
      await core.dispose();
      hookState.managerMap.delete(tmpDir);
      rmSync(tmpDir, { recursive: true, force: true });
      if (prevInterval === undefined) {
        delete process.env.ROLEBOX_HEALTH_CHECK_INTERVAL_MS;
      } else {
        process.env.ROLEBOX_HEALTH_CHECK_INTERVAL_MS = prevInterval;
      }
    }
  });
});
