/**
 * THE CORE SLICE'S PLACE IN THE SHARED LOG VOCABULARY.
 *
 * Stage 4 promoted the core slice's recurring, identity-carrying diagnostics
 * into registered events — the service kernel, the plugin composition, the
 * restart supervisor, the health monitor and the dispatch/loop services. What
 * is pinned HERE is the part the slice owns:
 *
 * 1. THE VOCABULARY. Every code this slice reports is registered in the shared
 *    table (src/log/registry.ts) at THE LEVEL ITS CALL SITE HAD — the service
 *    lifecycle warnings stay `warn`, the failures that lose a service for the
 *    process lifetime stay `error` — so visibility does not move in either
 *    direction.
 * 2. THE CHANNELS. A code reports on the channel of the module that emits it:
 *    `plugin-core`, `plugin-hooks`, `service-supervisor`, `health-monitor`,
 *    `loop-service` and `dispatch-service` (which is what the file sink turns
 *    into <logDir>/<channel>.log). The slice owns every code on those channels,
 *    so nothing outside this list can claim one.
 * 3. THE FIELD SHAPE. The scope vocabulary (src/log/types.ts) carries sessions,
 *    agents, graphs and tools — NOT services — so a service name stays a FIELD
 *    (`service`), the way the engine events keep an execution id.
 * 4. THE REAL CALL SITES. Two codes are emitted by driving the production code
 *    that owns them: the real ServiceSupervisor over a core whose restart keeps
 *    failing (the failed-restart ladder and the entry guard), and the real
 *    HealthMonitorService's periodic tick over a service that reports itself
 *    unhealthy — rather than by calling logEvent directly.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOG_EVENTS,
  __resetLoggingForTest,
  configureLogging,
  isLogEventCode,
  logEvent,
  logEventDefinition,
  withLogScope,
} from "../../src/log/index.ts";
import type { LogEventCode } from "../../src/log/index.ts";
import { createMemorySink, type MemorySink } from "../../src/log/sinks/memory.ts";
import { PluginCore } from "../../src/core/plugin-core.ts";
import type { PluginService, PluginCoreLike } from "../../src/core/service.ts";
import type { PluginContext } from "../../src/core/context.ts";
import { ServiceSupervisor, SUPERVISOR_DEFAULTS } from "../../src/core/service-supervisor.ts";
import { HealthMonitorService } from "../../src/core/services/health-monitor-service.ts";
import { opencodeCapabilities } from "../../src/platform/capabilities.ts";
import { makeSessionClient } from "./helpers.ts";
import { fakeServiceName } from "../helpers/service-names.ts";
import { beginLogTest, endLogTest } from "../helpers/log.ts";

/**
 * Every event the core slice registers: the code, the level its call site had,
 * and the channel it belongs to.
 */
const CORE_EVENTS: ReadonlyArray<readonly [LogEventCode, "warn" | "error", string]> = [
  ["plugin-core.registration-replaced", "warn", "plugin-core"],
  ["plugin-core.init-skipped", "warn", "plugin-core"],
  ["plugin-core.init-failed", "error", "plugin-core"],
  ["plugin-core.dispose-failed", "warn", "plugin-core"],
  ["plugin-core.restart-unknown-service", "warn", "plugin-core"],
  ["plugin-core.restart-no-context", "warn", "plugin-core"],
  ["plugin-core.restart-dispose-failed", "warn", "plugin-core"],
  ["plugin-hooks.hook-service-unavailable", "error", "plugin-hooks"],
  ["plugin-hooks.handlers-uninitialized", "error", "plugin-hooks"],
  ["service-supervisor.budget-exceeded", "error", "service-supervisor"],
  ["service-supervisor.permanently-degraded", "error", "service-supervisor"],
  ["health-monitor.service-unhealthy", "warn", "health-monitor"],
  ["health-monitor.service-degraded", "error", "health-monitor"],
  ["health-monitor.supervisor-error", "error", "health-monitor"],
  ["loop-service.degraded", "warn", "loop-service"],
  ["loop-service.state-load-failed", "error", "loop-service"],
  ["loop-service.state-reconcile-failed", "error", "loop-service"],
  ["dispatch-service.degraded", "warn", "dispatch-service"],
  ["dispatch-service.recover-failed", "error", "dispatch-service"],
  ["dispatch-service.flush-failed", "warn", "dispatch-service"],
];

/** The channels this slice's modules own. */
const SLICE_CHANNELS: readonly string[] = [
  "plugin-core",
  "plugin-hooks",
  "service-supervisor",
  "health-monitor",
  "loop-service",
  "dispatch-service",
];

/** The identity names a record carries in its scope instead of its fields. */
const SCOPE_KEYS: readonly string[] = ["sessionId", "graphId", "attemptId", "effectId"];

let state: { env: Record<string, string | undefined>; dir: string };
let memory: MemorySink;

beforeEach(() => {
  state = beginLogTest();
  memory = createMemorySink({ capacity: 64 });
  configureLogging({ sinks: [memory], level: "debug" });
});

afterEach(() => {
  endLogTest(state);
});

/** A context shaped the way PluginCore.init and its services read one. */
function makeContext(core: PluginCore, dir: string): PluginContext {
  return {
    session: makeSessionClient(),
    resolvedRoles: [],
    roleFunctionsMap: new Map(),
    rawDirectory: dir,
    directory: dir,
    core,
    bus: core.getBus(),
    capabilities: opencodeCapabilities(),
  };
}

/** Wait for a record with this code, or answer undefined when the window closes. */
async function waitForRecord(code: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = memory.records().find((record) => record.code === code);
    if (found) return found;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("core slice event vocabulary", () => {
  it("registers exactly the slice's twenty events on the slice's channels", () => {
    expect(CORE_EVENTS.length).toBe(20);
    for (const [code] of CORE_EVENTS) {
      expect(isLogEventCode(code)).toBe(true);
      expect(LOG_EVENTS[code]).toBeDefined();
    }
    const registered = Object.entries(LOG_EVENTS)
      .filter(([, entry]) => SLICE_CHANNELS.includes(entry.channel))
      .map(([code]) => code);
    expect([...registered].sort()).toEqual(CORE_EVENTS.map(([code]) => code as string).sort());
  });

  it("keeps every slice event at the level its call site had", () => {
    const counts = { warn: 0, error: 0 };
    for (const [code, level] of CORE_EVENTS) {
      expect(logEventDefinition(code).level).toBe(level);
      counts[level] += 1;
    }
    // Ten warnings and ten errors: the promotion moved no diagnostic across the
    // console gate (`ROLEBOX_LOG_CONSOLE_LEVEL`, default "warn").
    expect(counts).toEqual({ warn: 10, error: 10 });
  });

  it("routes every slice event to the channel of the module that emits it", () => {
    const counts: Record<string, number> = {};
    for (const [code, , channel] of CORE_EVENTS) {
      expect(logEventDefinition(code).channel).toBe(channel);
      counts[channel] = (counts[channel] ?? 0) + 1;
    }
    expect(counts).toEqual({
      "plugin-core": 7,
      "plugin-hooks": 2,
      "service-supervisor": 2,
      "health-monitor": 3,
      "loop-service": 3,
      "dispatch-service": 3,
    });
  });

  it("keeps every message a single non-empty sentence", () => {
    for (const [code] of CORE_EVENTS) {
      const { message } = logEventDefinition(code);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("\n");
    }
  });

  it("carries identity in the scope and data in the fields", () => {
    for (const [code, level, channel] of CORE_EVENTS) {
      withLogScope({ sessionId: "s1", attemptId: "a1" }, () => {
        logEvent(code, { reason: "denied", count: 2, ok: false, ids: ["a", "b"] });
      });
      const record = memory.last();
      expect(record?.code).toBe(code);
      expect(record?.level).toBe(level);
      expect(record?.channel).toBe(channel);
      expect(record?.scope).toEqual({ sessionId: "s1", attemptId: "a1" });
      expect(record?.fields).toEqual({ reason: "denied", count: 2, ok: false, ids: ["a", "b"] });
      for (const identity of SCOPE_KEYS) {
        expect(Object.hasOwn(record?.fields ?? {}, identity)).toBe(false);
      }
    }
  });
});

describe("the core slice's events come from the modules that own them", () => {
  /** A core whose supervised restarts always fail. */
  function makeFailingCore(): PluginCoreLike {
    const restartService = mock(() => Promise.reject(new Error("restart refused")));
    return {
      getService: mock(() => undefined),
      getServices: mock(() => new Map()),
      restartService,
      isDegraded: mock(() => false),
    } satisfies PluginCoreLike as PluginCoreLike;
  }

  it("reports the failed-restart ladder from the real supervisor", async () => {
    const supervisor = new ServiceSupervisor(makeFailingCore());
    const service = fakeServiceName("svc-core-events");
    const { maxRestartsPerWindow, windowMs } = SUPERVISOR_DEFAULTS;

    // Each failed attempt parks the service in a backoff window, so the clock is
    // moved just past it — never past `windowMs`, which would reset the counter.
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      await supervisor.tryRestart(service);
      now += SUPERVISOR_DEFAULTS.baseBackoffMs * SUPERVISOR_DEFAULTS.backoffFactor + 1;
      await supervisor.tryRestart(service);
      now += SUPERVISOR_DEFAULTS.baseBackoffMs * SUPERVISOR_DEFAULTS.backoffFactor ** 2 + 1;
      await supervisor.tryRestart(service);
    } finally {
      Date.now = realNow;
    }

    const records = memory.records().filter((record) => record.code === "service-supervisor.permanently-degraded");
    expect(records.length).toBe(1);
    expect(records[0].level).toBe("error");
    expect(records[0].channel).toBe("service-supervisor");
    expect(records[0].message).toBe(LOG_EVENTS["service-supervisor.permanently-degraded"].message);
    expect(records[0].fields).toEqual({
      service,
      attempts: maxRestartsPerWindow,
      error: "restart refused",
      windowMs,
    });
  });

  it("reports the restart budget from the real supervisor's entry guard", async () => {
    const supervisor = new ServiceSupervisor(makeFailingCore());
    const service = fakeServiceName("svc-core-budget");

    // One failed attempt creates the tracking record; the guard under test is
    // the one that answers a service whose attempt count already reached the
    // budget and whose backoff window has passed — which getStatus() exposes as
    // the live record.
    await supervisor.tryRestart(service);
    const tracked = supervisor.getStatus(service);
    tracked.attempts = SUPERVISOR_DEFAULTS.maxRestartsPerWindow;
    tracked.status = "backoff";
    tracked.backoffUntil = 0;

    await supervisor.tryRestart(service);

    const record = memory.records().find((item) => item.code === "service-supervisor.budget-exceeded");
    expect(record?.level).toBe("error");
    expect(record?.channel).toBe("service-supervisor");
    expect(record?.message).toBe(LOG_EVENTS["service-supervisor.budget-exceeded"].message);
    expect(record?.fields).toEqual({
      service,
      attempts: SUPERVISOR_DEFAULTS.maxRestartsPerWindow,
      windowMs: SUPERVISOR_DEFAULTS.windowMs,
    });
  });

  it("reports an unhealthy service from the real health-check tick", async () => {
    const dir = mkdtempSync(join(tmpdir(), "core-log-events-"));
    const previousInterval = process.env.ROLEBOX_HEALTH_CHECK_INTERVAL_MS;
    const previousDisabled = process.env.ROLEBOX_HEALTH_CHECK;
    process.env.ROLEBOX_HEALTH_CHECK_INTERVAL_MS = "50";
    delete process.env.ROLEBOX_HEALTH_CHECK;

    const core = new PluginCore();
    try {
      core.registerService({
        name: fakeServiceName("svc-unhealthy"),
        dependencies: [],
        init: mock(() => Promise.resolve()),
        dispose: mock(() => Promise.resolve()),
        health: () => ({ status: "unhealthy", detail: "probe says no" }),
      } satisfies PluginService);
      const monitor = new HealthMonitorService();
      core.registerService(monitor);
      await core.init(makeContext(core, dir));

      const record = await waitForRecord("health-monitor.service-unhealthy");
      expect(record?.level).toBe("warn");
      expect(record?.channel).toBe("health-monitor");
      expect(record?.message).toBe(LOG_EVENTS["health-monitor.service-unhealthy"].message);
      expect(record?.fields).toEqual({ service: "svc-unhealthy", detail: "probe says no" });
    } finally {
      await core.dispose();
      rmSync(dir, { recursive: true, force: true });
      if (previousInterval === undefined) delete process.env.ROLEBOX_HEALTH_CHECK_INTERVAL_MS;
      else process.env.ROLEBOX_HEALTH_CHECK_INTERVAL_MS = previousInterval;
      if (previousDisabled === undefined) delete process.env.ROLEBOX_HEALTH_CHECK;
      else process.env.ROLEBOX_HEALTH_CHECK = previousDisabled;
      __resetLoggingForTest();
    }
  });
});
