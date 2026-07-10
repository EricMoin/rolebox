/**
 * Graceful degradation tests — verify that services handle errors without crashing.
 *
 * IMPORTANT: These tests do NOT use mock.module() because bun's mock.module
 * is process-wide and pollutes other test files when all tests run together.
 * Instead, we test via alternative approaches:
 *   - Health/critical flag assertions for clean starts
 *   - Real StartupChecker with controlled temp directories
 *   - Direct service behavior validation
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PluginCore } from "../../src/core/plugin-core.ts";
import { DispatchService } from "../../src/core/services/dispatch-service.ts";
import { LoopService } from "../../src/core/services/loop-service.ts";
import { RecoveryService } from "../../src/core/services/recovery-service.ts";
import type { PluginContext } from "../../src/core/context.ts";
import type { PluginCoreLike } from "../../src/core/service.ts";
import { StartupChecker } from "../../src/recovery/startup-check.ts";
import type { OpencodeClient } from "@opencode-ai/sdk";

// ── helpers ────────────────────────────────────────────────────────

function makeContext(core: PluginCoreLike, dir?: string): PluginContext {
  return {
    client: {} as OpencodeClient,
    resolvedRoles: [],
    roleFunctionsMap: new Map(),
    roleGraphMap: new Map(),
    rawDirectory: dir ?? "/tmp/test-graceful",
    directory: dir ?? "/tmp/test-graceful",
    core,
    bus: core.getBus(),
  };
}

// ── DispatchService tests ───────────────────────────────────────────

describe("DispatchService graceful degradation", () => {
  it("has critical = true", () => {
    const svc = new DispatchService();
    expect(svc.critical).toBe(true);
  });

  it("health() returns degraded before init", () => {
    const svc = new DispatchService();
    const health = svc.health();
    expect(health.status).toBe("unhealthy");
    expect(health.detail).toContain("not initialized");
  });
});

// ── LoopService tests ──────────────────────────────────────────────

describe("LoopService graceful degradation", () => {
  it("has critical = true", () => {
    const svc = new LoopService();
    expect(svc.critical).toBe(true);
  });
});

// ── RecoveryService tests ───────────────────────────────────────────

describe("RecoveryService graceful degradation", () => {
  afterAll(() => {
    RecoveryService.__resetNotifiedQuarantine();
  });

  it("has critical = true", () => {
    const svc = new RecoveryService();
    expect(svc.critical).toBe(true);
  });

  it("handles a clean startup successfully", async () => {
    const dir = mkdtempSync(join(tmpdir(), "graceful-recovery-"));
    try {
      // Create a clean state directory
      mkdirSync(join(dir, ".rolebox", "state"), { recursive: true });

      const core = new PluginCore();
      const recoveryService = new RecoveryService();
      core.registerService(recoveryService);
      await core.init(makeContext(core, dir));

      const startupHealth = recoveryService.getStartupHealth();
      expect(startupHealth).toBeDefined();
      expect(startupHealth!.healthy).toBe(true);

      const health = recoveryService.health();
      expect(health.status).toBe("healthy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles recovery with quarantined files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "graceful-recovery2-"));
    try {
      const stateDir = join(dir, ".rolebox", "state");
      mkdirSync(stateDir, { recursive: true });

      // Write a corrupt state file that will be quarantined
      writeFileSync(join(stateDir, "loops-bad.json"), "not-json-at-all{{{", "utf-8");

      const health = StartupChecker.checkAll(dir, stateDir);
      expect(health.healthy).toBe(false);
      expect(health.quarantined.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
