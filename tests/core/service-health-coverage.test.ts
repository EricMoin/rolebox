import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SERVICE_NAMES, type ServiceName } from "../../src/core/service-names.ts";
import type { PluginCoreLike, PluginService, ServiceHealth } from "../../src/core/service.ts";
import type { PluginContext } from "../../src/core/context.ts";
import { EventBus } from "../../src/core/event-bus.ts";
import { HotReloadService } from "../../src/core/services/hot-reload-service.ts";
import { DispatchService } from "../../src/core/services/dispatch-service.ts";
import { LoopService } from "../../src/core/services/loop-service.ts";
import { LspService } from "../../src/core/services/lsp-service.ts";
import { NotificationService } from "../../src/core/services/notification-service.ts";
import { SessionService } from "../../src/core/services/session-service.ts";
import { RecoveryService } from "../../src/core/services/recovery-service.ts";
import { ExtensionService } from "../../src/core/services/extension-service.ts";
import { ToolService } from "../../src/core/services/tool-service.ts";
import { HookService } from "../../src/core/services/hook-service.ts";
import { HealthMonitorService } from "../../src/core/services/health-monitor-service.ts";
import { opencodeCapabilities } from "../../src/platform/capabilities.ts";
import { makeSessionClient } from "./helpers.ts";
import { __resetForTest } from "../../src/logger.ts";

// ── helpers ────────────────────────────────────────────────────────

/**
 * Every service createPluginHooks registers (src/core/composition.ts:129-139),
 * keyed by its SERVICE_NAMES entry. All eleven are constructible with no
 * arguments (DispatchService's options parameter is optional).
 *
 * The `Record<ServiceName, ...>` annotation is the compile-time half of the
 * coverage guard: a name added to SERVICE_NAMES without a row here fails
 * `bun run typecheck`. The runtime probes below fail if any registered class
 * stops exposing health().
 */
const REGISTERED_SERVICES: Record<ServiceName, new () => PluginService> = {
  [SERVICE_NAMES.hotReload]: HotReloadService,
  [SERVICE_NAMES.dispatch]: DispatchService,
  [SERVICE_NAMES.loop]: LoopService,
  [SERVICE_NAMES.lsp]: LspService,
  [SERVICE_NAMES.notification]: NotificationService,
  [SERVICE_NAMES.session]: SessionService,
  [SERVICE_NAMES.recovery]: RecoveryService,
  [SERVICE_NAMES.extension]: ExtensionService,
  [SERVICE_NAMES.tool]: ToolService,
  [SERVICE_NAMES.hook]: HookService,
  [SERVICE_NAMES.healthMonitor]: HealthMonitorService,
};

/**
 * The exact status/detail a never-initialized probe must return. For
 * tool-service and hook-service this is the only cheap way to reach the
 * failing branch: their init() needs a fully assembled core.
 */
const PRE_INIT_HEALTH: Array<{ name: ServiceName; ctor: new () => PluginService; expected: ServiceHealth }> = [
  { name: SERVICE_NAMES.session, ctor: SessionService, expected: { status: "unhealthy", detail: "ISessionClient not initialized" } },
  { name: SERVICE_NAMES.tool, ctor: ToolService, expected: { status: "unhealthy", detail: "tool surface not assembled" } },
  { name: SERVICE_NAMES.notification, ctor: NotificationService, expected: { status: "unhealthy", detail: "NotificationManager not initialized" } },
  { name: SERVICE_NAMES.extension, ctor: ExtensionService, expected: { status: "unhealthy", detail: "ExtensionRegistry not initialized" } },
  { name: SERVICE_NAMES.hook, ctor: HookService, expected: { status: "unhealthy", detail: "hook handlers not assembled" } },
];

/** A core with no registered services — the bridges in ExtensionService are optional. */
function makeCore(): PluginCoreLike {
  return {
    getService: () => undefined,
    getServices: () => new Map(),
    restartService: async () => {},
    isDegraded: () => false,
  };
}

function makeContext(): PluginContext {
  return {
    session: makeSessionClient(),
    resolvedRoles: [],
    roleFunctionsMap: new Map(),
    rawDirectory: "/tmp",
    directory: "/tmp",
    core: makeCore(),
    bus: new EventBus(),
    capabilities: opencodeCapabilities(),
  };
}

// ── tests ──────────────────────────────────────────────────────────

describe("service health coverage", () => {
  beforeEach(() => {
    __resetForTest();
  });

  afterEach(() => {
    __resetForTest();
  });

  it("maps every SERVICE_NAMES entry to the class composition registers", () => {
    expect(Object.keys(REGISTERED_SERVICES).sort()).toEqual(Object.values(SERVICE_NAMES).sort());
  });

  it("every registered service exposes a callable health() probe", () => {
    for (const name of Object.values(SERVICE_NAMES)) {
      const svc = new REGISTERED_SERVICES[name]();
      expect(svc.name).toBe(name);
      expect(typeof svc.health).toBe("function");
    }
  });

  for (const { name, ctor, expected } of PRE_INIT_HEALTH) {
    it(`${name} fails closed before init`, () => {
      const health = new ctor().health!();
      expect(health.status).toBe(expected.status);
      expect(health.detail).toBe(expected.detail);
    });
  }

  describe("post-init", () => {
    it("session-service is healthy once ctx.session is wired", async () => {
      const svc = new SessionService();
      await svc.init(makeContext());

      expect(svc.health()).toEqual({ status: "healthy" });
    });

    it("notification-service is healthy once the bus subscriptions exist", async () => {
      const svc = new NotificationService();
      await svc.init(makeContext());

      expect(svc.health()).toEqual({ status: "healthy" });
      await svc.dispose();
    });

    it("extension-service is healthy after a clean init with no roles", async () => {
      const svc = new ExtensionService();
      await svc.init(makeContext());

      expect(svc.health()).toEqual({ status: "healthy" });
      await svc.dispose();
    });

    it("extension-service is degraded when a role's extension list fails to load", async () => {
      const svc = new ExtensionService();
      const ctx = makeContext();
      // A role.yaml author writing `recovery_strategies:` as a mapping instead of
      // a sequence yields an object here, so the point's entry loop throws and the
      // per-role catch counts one failure.
      ctx.resolvedRoles = [
        { id: "broken", config: { extensions: { recovery_strategies: { name: "x", module: "y" } } } },
      ] as any;

      await svc.init(ctx);

      expect(svc.health()).toEqual({ status: "degraded", detail: "1 extension load failure(s)" });
    });

    it("extension-service clears the load-failure count on a clean re-init", async () => {
      const svc = new ExtensionService();
      const brokenCtx = makeContext();
      brokenCtx.resolvedRoles = [
        { id: "broken", config: { extensions: { recovery_strategies: { name: "x", module: "y" } } } },
      ] as any;
      await svc.init(brokenCtx);
      expect(svc.health().status).toBe("degraded");

      await svc.init(makeContext());

      expect(svc.health()).toEqual({ status: "healthy" });
    });
  });
});
