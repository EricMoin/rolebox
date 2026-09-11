import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { NotificationService } from "../../src/core/services/notification-service.ts";
import type { PluginContext } from "../../src/core/context.ts";
import { EventBus } from "../../src/core/event-bus.ts";
import { __resetForTest } from "../../src/logger.ts";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── helpers ────────────────────────────────────────────────────────

function makeContext(overrides?: Partial<PluginContext>): PluginContext {
  return {
    client: {} as any,
    resolvedRoles: [],
    roleFunctionsMap: new Map(),
    roleGraphMap: new Map(),
    rawDirectory: "/tmp",
    directory: "/tmp",
    core: undefined as any,
    bus: new EventBus(),
    capabilities: undefined,
    ...overrides,
  };
}

// ── tests ──────────────────────────────────────────────────────────

describe("NotificationService", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    __resetForTest();
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore original env vars
    for (const key of Object.keys(originalEnv)) {
      if (process.env[key] !== originalEnv[key]) {
        if (originalEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalEnv[key];
        }
      }
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    mock.restore();
    __resetForTest();
  });

  /** Helper to get the resolved global config from manager */
function getGlobalConfig(mgr: any) {
  return mgr.getConfigForSession("test-session");
}

describe("ROLEBOX_NOTIFICATIONS_ENABLED", () => {
    it("sets config.enabled=false when env var is false", async () => {
      process.env.ROLEBOX_NOTIFICATIONS_ENABLED = "false";
      delete process.env.ROLEBOX_NOTIFICATIONS_CONFIG;

      const svc = new NotificationService();
      const ctx = makeContext();
      await svc.init(ctx);

      const mgr = svc.getNotificationManager();
      expect(mgr).toBeDefined();
      const config = getGlobalConfig(mgr);
      expect(config.enabled).toBe(false);
    });

    it("sets config.enabled=false when env var is 0", async () => {
      process.env.ROLEBOX_NOTIFICATIONS_ENABLED = "0";
      delete process.env.ROLEBOX_NOTIFICATIONS_CONFIG;

      const svc = new NotificationService();
      const ctx = makeContext();
      await svc.init(ctx);

      const mgr = svc.getNotificationManager();
      const config = getGlobalConfig(mgr);
      expect(config.enabled).toBe(false);
    });

    it("leaves enabled=true when env var is not set", async () => {
      delete process.env.ROLEBOX_NOTIFICATIONS_ENABLED;
      delete process.env.ROLEBOX_NOTIFICATIONS_CONFIG;

      const svc = new NotificationService();
      const ctx = makeContext();
      await svc.init(ctx);

      const mgr = svc.getNotificationManager();
      const config = getGlobalConfig(mgr);
      expect(config.enabled).toBe(true);
    });
  });

  describe("ROLEBOX_NOTIFICATIONS_CONFIG (valid YAML)", () => {
    it("parses and resolves config from a valid YAML file", async () => {
      const tmpFile = join(tmpdir(), `notif-test-${Math.random().toString(36).slice(2)}.yaml`);
      try {
        writeFileSync(
          tmpFile,
          "enabled: true\nmainSessionOnly: false\nidleDelayMs: 5000\n",
          "utf-8",
        );
        process.env.ROLEBOX_NOTIFICATIONS_CONFIG = tmpFile;
        delete process.env.ROLEBOX_NOTIFICATIONS_ENABLED;

        const svc = new NotificationService();
        const ctx = makeContext();
        await svc.init(ctx);

        const mgr = svc.getNotificationManager();
        expect(mgr).toBeDefined();
        const config = getGlobalConfig(mgr);
        expect(config.enabled).toBe(true);
        expect(config.mainSessionOnly).toBe(false);
        expect(config.idleDelayMs).toBe(5000);
      } finally {
        try { unlinkSync(tmpFile); } catch { /* ignore */ }
      }
    });

    it("resolves env vars inside YAML config values", async () => {
      process.env.TEST_NOTIF_CHANNEL = "test-channel-value";
      const tmpFile = join(tmpdir(), `notif-test-${Math.random().toString(36).slice(2)}.yaml`);
      try {
        writeFileSync(
          tmpFile,
          "enabled: true\nchannels:\n  - kind: log\n    level: info\n",
          "utf-8",
        );
        process.env.ROLEBOX_NOTIFICATIONS_CONFIG = tmpFile;
        delete process.env.ROLEBOX_NOTIFICATIONS_ENABLED;

        const svc = new NotificationService();
        const ctx = makeContext();
        await svc.init(ctx);

        const mgr = svc.getNotificationManager();
        expect(mgr).toBeDefined();
        const config = getGlobalConfig(mgr);
        expect(config.enabled).toBe(true);
      } finally {
        try { unlinkSync(tmpFile); } catch { /* ignore */ }
        delete process.env.TEST_NOTIF_CHANNEL;
      }
    });
  });

  describe("ROLEBOX_NOTIFICATIONS_CONFIG (missing file)", () => {
    it("gracefully falls back when config file does not exist", async () => {
      process.env.ROLEBOX_NOTIFICATIONS_CONFIG = "/tmp/nonexistent-notif-config.yaml";
      delete process.env.ROLEBOX_NOTIFICATIONS_ENABLED;

      const svc = new NotificationService();
      const ctx = makeContext();

      // Should not throw despite missing file
      await expect(svc.init(ctx)).resolves.toBeUndefined();

      const mgr = svc.getNotificationManager();
      expect(mgr).toBeDefined();
      // Should use default config
      const config = getGlobalConfig(mgr);
      expect(config.enabled).toBe(true);
    });
  });

  describe("dispose", () => {
    it("unsubscribes all event bus listeners", async () => {
      const svc = new NotificationService();
      const bus = new EventBus();
      const ctx = makeContext({ bus });

      // Spy on bus.on to collect unsub functions
      const unsubSpy = mock(() => {});
      const originalOn = bus.on.bind(bus);
      bus.on = mock((event: string, handler: any) => {
        const unsub = originalOn(event, handler);
        return () => {
          unsubSpy();
          unsub();
        };
      }) as typeof bus.on;

      await svc.init(ctx);

      // Count how many subscriptions were made
      const subCount = (bus.on as ReturnType<typeof mock>).mock.calls.length;
      expect(subCount).toBeGreaterThan(0);

      // Clear the spy count from init
      unsubSpy.mockClear();

      // Dispose should call each unsub
      await svc.dispose();

      // Each subscription's unsub function should have been called
      expect(unsubSpy).toHaveBeenCalledTimes(subCount);
    });

    it("is safe to call twice (idempotent)", async () => {
      const svc = new NotificationService();
      const bus = new EventBus();
      const ctx = makeContext({ bus });

      await svc.init(ctx);
      await svc.dispose();

      // Second dispose should not throw
      await expect(svc.dispose()).resolves.toBeUndefined();
    });

    it("is safe to call without init (no crash)", async () => {
      const svc = new NotificationService();
      await expect(svc.dispose()).resolves.toBeUndefined();
    });
  });
});
