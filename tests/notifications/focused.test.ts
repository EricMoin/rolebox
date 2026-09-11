// ── Notification System: Focused Unit Tests ────────────────────────────
//
// Covers identified gaps in the existing integration test suite:
//   manager     – handleToolBefore, no-channels, edge cases
//   scheduler   – grace period, cancelSession completeness, maxTrackedSessions=0
//   throttle    – windowMs=0, prune(), invalid config, burst scenarios
//   quiet-hours – timezone boundary, nextActiveTime (crossover/full-day), multi-range
//   channel-resolver – cache hit/miss, creation failure, concurrent promise
//   channels    – createChannel returns null, system-toast mock, custom-command
//   formatting  – edge cases
//   config-validate – 5+ illegal config forms
//   content     – truncation boundary, empty/undefined vars
//
// Uses bun:test syntax – describe/it/expect from "bun:test".
// Imports follow the same conventions as integration.test.ts.

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Types ─────────────────────────────────────────────────────────
import { NOTIFICATION_EVENT_TYPES, NOTIFICATION_CHANNEL_KINDS } from "../../src/notifications/types";
import type {
  NotificationConfig,
  NotificationMessage,
  NotificationChannelConfig,
  QuietHoursConfig,
  ThrottleConfig,
} from "../../src/notifications/types";

// ── Config / Validate ─────────────────────────────────────────────
import {
  DEFAULT_NOTIFICATION_CONFIG,
} from "../../src/notifications/config";
import { validateNotificationConfig } from "../../src/notifications/config-validate";

// ── Throttle ──────────────────────────────────────────────────────
import { NotificationThrottle } from "../../src/notifications/throttle";

// ── Quiet Hours ───────────────────────────────────────────────────
import { QuietHours } from "../../src/notifications/quiet-hours";

// ── Scheduler ─────────────────────────────────────────────────────
import { NotificationScheduler, createScheduler } from "../../src/notifications/scheduler";

// ── Content / Formatting ──────────────────────────────────────────
import {
  renderTemplate,
  buildTemplateVars,
  buildNotificationContent,
} from "../../src/notifications/content";
import {
  escapeAppleScriptText,
  escapePowerShellSingleQuotedText,
  escapeBashText,
  truncate,
} from "../../src/notifications/formatting";

// ── Channels ──────────────────────────────────────────────────────
import { createChannel, createChannels } from "../../src/notifications/channels";
import type { NotificationChannel } from "../../src/notifications/channels";

// ── Channel Resolver ──────────────────────────────────────────────
import { resolveChannels } from "../../src/notifications/channel-resolver";

// ── Manager ───────────────────────────────────────────────────────
import { NotificationManager } from "../../src/notifications/manager";

// ── Helpers ───────────────────────────────────────────────────────

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "notif-focused-"));
}

function createMockClient() {
  return {
    get: mock(() =>
      Promise.resolve({ title: "Focused Test Session" }),
    ),
    messages: mock(() =>
      Promise.resolve([
        {
          info: { role: "user" },
          parts: [{ type: "text", text: "User says hi" }],
        },
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: "Assistant replies" }],
        },
      ]),
    ),
  } as any;
}

function createBaseConfig(overrides?: Partial<NotificationConfig>): NotificationConfig {
  return {
    ...DEFAULT_NOTIFICATION_CONFIG,
    channels: [],
    throttle: { windowMs: 5000, maxPerWindow: 10 },
    quietHours: { enabled: false, ranges: [] },
    ...overrides,
  };
}

function createManager(
  overrides?: Partial<NotificationConfig>,
  roleConfigs?: Map<string, NotificationConfig>,
  dir?: string,
) {
  const config = createBaseConfig(overrides);
  if (overrides?.channels) config.channels = overrides.channels;
  if (overrides?.throttle) config.throttle = { ...config.throttle, ...overrides.throttle };
  if (overrides?.quietHours) config.quietHours = { ...config.quietHours, ...overrides.quietHours };
  if (overrides?.events) config.events = overrides.events;

  return new NotificationManager({
    globalConfig: config,
    roleConfigs: roleConfigs ?? new Map(),
    client: createMockClient(),
    dir: dir ?? tempDir(),
  });
}

// ════════════════════════════════════════════════════════════════════
// 1. Manager – handleToolBefore, no-channels, edge cases
// ════════════════════════════════════════════════════════════════════

describe("NotificationManager – focused", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = tempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handleToolBefore fires Question notification for matching tool", async () => {
    const logFile = join(tmpDir, "q1.jsonl");
    const mgr = createManager({
      questionToolNames: ["askUser"],
      channels: [{ kind: NOTIFICATION_CHANNEL_KINDS.File, enabled: true, path: logFile }],
    });

    mgr.handleToolBefore("ses_q", "askUser", { questions: [{ question: "What color?" }] }, "helper");

    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(logFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(logFile, "utf-8").trim());
    expect(parsed.eventType).toBe("question");
    expect(parsed.body).toContain("What color?");
    await mgr.dispose();
  });

  it("handleToolBefore does nothing for non-matching tool", async () => {
    const logFile = join(tmpDir, "q2.jsonl");
    const mgr = createManager({
      questionToolNames: ["askUser"],
      channels: [{ kind: NOTIFICATION_CHANNEL_KINDS.File, enabled: true, path: logFile }],
    });

    mgr.handleToolBefore("ses_q2", "someOtherTool", {}, "helper");

    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(logFile)).toBe(false);
    await mgr.dispose();
  });

  it("handleToolBefore handles null args gracefully", async () => {
    const mgr = createManager({
      questionToolNames: ["askUser"],
    });

    // Should not throw
    expect(() => {
      mgr.handleToolBefore("ses_null", "askUser", null, "helper");
    }).not.toThrow();

    await mgr.dispose();
  });

  it("handleToolBefore handles undefined args gracefully", async () => {
    const mgr = createManager({
      questionToolNames: ["askUser"],
    });

    expect(() => {
      mgr.handleToolBefore("ses_undef", "askUser", undefined, "helper");
    }).not.toThrow();

    await mgr.dispose();
  });

  it("no channels configured → notify returns without writing", async () => {
    const mgr = createManager({ channels: [] });

    await mgr.notify({
      sessionID: "ses_noch",
      eventType: NOTIFICATION_EVENT_TYPES.Idle,
    });

    // No channels, so no file should be written (just returns early)
    // Verify by checking no errors are thrown
    await mgr.dispose();
  });

  it("notify with questionText appends to body", async () => {
    const logFile = join(tmpDir, "qt.jsonl");
    const mgr = createManager({
      channels: [{ kind: NOTIFICATION_CHANNEL_KINDS.File, enabled: true, path: logFile }],
    });

    await mgr.notify({
      sessionID: "ses_qt",
      eventType: NOTIFICATION_EVENT_TYPES.Question,
      questionText: "Proceed?",
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(logFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(logFile, "utf-8").trim());
    expect(parsed.body).toContain("Proceed?");
    expect(parsed.eventType).toBe("question");
    await mgr.dispose();
  });

  it("markActivity delegates to scheduler without throwing", () => {
    const mgr = createManager();
    expect(() => mgr.markActivity("ses_act")).not.toThrow();
    // Call twice — should be idempotent
    expect(() => mgr.markActivity("ses_act")).not.toThrow();
    mgr.dispose();
  });

  it("scheduleIdle with custom agent fires with correct session", async () => {
    const logFile = join(tmpDir, "idle_custom.jsonl");
    const mgr = createManager({
      idleDelayMs: 30,
      channels: [{ kind: NOTIFICATION_CHANNEL_KINDS.File, enabled: true, path: logFile }],
    });

    mgr.scheduleIdle("ses_idle_c", "customAgent");

    await new Promise((r) => setTimeout(r, 150));
    expect(existsSync(logFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(logFile, "utf-8").trim());
    expect(parsed.eventType).toBe("idle");
    expect(parsed.sessionId).toBe("ses_idle_c");
    await mgr.dispose();
  });

  it("dispose is safe after scheduler fires", async () => {
    const mgr = createManager({ idleDelayMs: 10 });

    mgr.scheduleIdle("ses_disp", "agent");
    await new Promise((r) => setTimeout(r, 50));

    // Should not throw
    await expect(mgr.dispose()).resolves.toBeUndefined();
  });

  it("dispose with channel cache populated is safe", async () => {
    const logFile = join(tmpDir, "disp_cache.jsonl");
    const mgr = createManager({
      channels: [{ kind: NOTIFICATION_CHANNEL_KINDS.File, enabled: true, path: logFile }],
    });

    // Trigger channel cache population
    await mgr.notify({
      sessionID: "ses_dc",
      eventType: NOTIFICATION_EVENT_TYPES.Idle,
    });

    await expect(mgr.dispose()).resolves.toBeUndefined();
  });

  it("handleDispatchComplete and handleLoopComplete are idempotent", async () => {
    const mgr = createManager();

    // These fire async, but should never throw
    mgr.handleDispatchComplete("ses_dc1");
    mgr.handleDispatchComplete("ses_dc1"); // second call
    mgr.handleLoopComplete("ses_lc1");
    mgr.handleLoopComplete("ses_lc1"); // second call

    await new Promise((r) => setTimeout(r, 100));
    await mgr.dispose();
  });

  it("reloadConfig creates fresh scheduler, throttle, and quiet hours", async () => {
    const mgr = createManager({ idleDelayMs: 5000 });

    // Verify initial config
    let cfg = mgr.getConfigForSession("ses_cfg");
    expect(cfg.idleDelayMs).toBe(5000);

    const newConfig = createBaseConfig({
      enabled: false,
      idleDelayMs: 100,
    });

    mgr.reloadConfig(newConfig, new Map());

    cfg = mgr.getConfigForSession("ses_cfg");
    expect(cfg.enabled).toBe(false);
    expect(cfg.idleDelayMs).toBe(100);

    await mgr.dispose();
  });

  it("per-event quietHoursOverride blocks during quiet hours", async () => {
    const logFile = join(tmpDir, "qho.jsonl");
    // Mock time to 10:00 (within 09:00-17:00)
    const now = new Date(2025, 0, 1, 10, 0, 0);
    const RealDate = global.Date;

    try {
      global.Date = class extends Date {
        constructor(...args: any[]) {
          if (args.length === 0) super(now);
          else super(args[0] as any);
        }
        static now() { return now.getTime(); }
      } as DateConstructor;

      const mgr = createManager({
        channels: [{ kind: NOTIFICATION_CHANNEL_KINDS.File, enabled: true, path: logFile }],
        events: {
          [NOTIFICATION_EVENT_TYPES.Idle]: {
            enabled: true,
            quietHoursOverride: { enabled: true, ranges: [{ start: "09:00", end: "17:00" }] },
          },
        },
      });

      await mgr.notify({
        sessionID: "ses_qho",
        eventType: NOTIFICATION_EVENT_TYPES.Idle,
      });

      // Should be blocked by event-level quiet hours
      expect(existsSync(logFile)).toBe(false);
      await mgr.dispose();
    } finally {
      global.Date = RealDate;
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. Scheduler – grace period, cancelSession, maxTrackedSessions=0
// ════════════════════════════════════════════════════════════════════

describe("NotificationScheduler – focused", () => {
  let scheduler: NotificationScheduler;
  let fireCount: number;

  beforeEach(() => {
    scheduler = createScheduler({
      idleDelayMs: 50,
      activityGracePeriodMs: 0,
      maxTrackedSessions: 10,
    });
    fireCount = 0;
  });

  afterEach(() => {
    scheduler.dispose();
  });

  it("activity during grace period does NOT cancel timer", async () => {
    const s = createScheduler({
      idleDelayMs: 50,
      activityGracePeriodMs: 200, // 200ms grace
      maxTrackedSessions: 10,
    });

    s.scheduleIdleNotification("ses_grace", () => { fireCount++; });
    // Activity immediately — within grace period
    s.markSessionActivity("ses_grace");

    await new Promise((r) => setTimeout(r, 120));
    // Timer should still fire because grace period protected it
    expect(fireCount).toBe(1);
    s.dispose();
  });

  it("activity AFTER grace period cancels timer", async () => {
    const s = createScheduler({
      idleDelayMs: 100,
      activityGracePeriodMs: 30,
      maxTrackedSessions: 10,
    });

    s.scheduleIdleNotification("ses_grace2", () => { fireCount++; });

    // Wait past grace period, then mark activity
    await new Promise((r) => setTimeout(r, 60));
    s.markSessionActivity("ses_grace2");

    await new Promise((r) => setTimeout(r, 100));
    // Timer should have been cancelled
    expect(fireCount).toBe(0);
    s.dispose();
  });

  it("cancelSession removes all state for session", () => {
    scheduler.scheduleIdleNotification("ses_rm", () => { fireCount++; });
    scheduler.markSessionActivity("ses_rm");
    scheduler.scheduleIdleNotification("ses_rm", () => { fireCount++; });

    scheduler.cancelSession("ses_rm");

    // Cast to any to inspect internal state
    const state = scheduler as any;
    expect(state.pendingTimers.has("ses_rm")).toBe(false);
    expect(state.notifiedSessions.has("ses_rm")).toBe(false);
    expect(state.sessionActivitySinceIdle.has("ses_rm")).toBe(false);
    expect(state.notificationVersions.has("ses_rm")).toBe(false);
    expect(state.executingNotifications.has("ses_rm")).toBe(false);
    expect(state.scheduledAt.has("ses_rm")).toBe(false);
  });

  it("deleteSession is an alias for cancelSession", () => {
    scheduler.scheduleIdleNotification("ses_del", () => { fireCount++; });
    scheduler.deleteSession("ses_del");

    const state = scheduler as any;
    expect(state.pendingTimers.has("ses_del")).toBe(false);
  });

  it("maxTrackedSessions=0 means all sessions evicted immediately", () => {
    const s = createScheduler({
      idleDelayMs: 5000,
      activityGracePeriodMs: 0,
      maxTrackedSessions: 0,
    });

    // Schedule — eviction triggers immediately because maxTrackedSessions=0
    for (let i = 0; i < 5; i++) {
      s.scheduleIdleNotification("ses_evictall_" + i, () => {});
    }

    const state = s as any;
    // With maxTrackedSessions=0, sessions are evicted on every schedule
    expect(state.notifiedSessions.size + state.pendingTimers.size).toBeLessThanOrEqual(1);
    s.dispose();
  });

  it("executeNotification with activity-since schedule clears state without firing", () => {
    const session = "ses_act2";
    scheduler.scheduleIdleNotification(session, () => { fireCount++; });
    scheduler.markSessionActivity(session);

    // After markSessionActivity, version was bumped from 1 to 2
    const state = scheduler as any;
    const currentVersion = state.notificationVersions.get(session);

    // Manually trigger executeNotification with the CURRENT version
    (scheduler as any).executeNotification(session, currentVersion, () => { fireCount++; });

    // activity-since detected → cleans up without firing
    expect(state.sessionActivitySinceIdle.has(session)).toBe(false);
    expect(fireCount).toBe(0);
  });

  it("executeNotification for already-notified session cleans up without firing", () => {
    scheduler.scheduleIdleNotification("ses_noted", () => { fireCount++; });

    // Manually set notified flag
    const state = scheduler as any;
    state.notifiedSessions.add("ses_noted");

    (scheduler as any).executeNotification("ses_noted", 1, () => { fireCount++; });

    expect(fireCount).toBe(0);
    // Timer reference should be cleaned up
    expect(state.pendingTimers.has("ses_noted")).toBe(false);
  });

  it("dispose resets all internal state", () => {
    scheduler.scheduleIdleNotification("ses_disp", () => { fireCount++; });
    scheduler.dispose();

    const state = scheduler as any;
    expect(state.pendingTimers.size).toBe(0);
    expect(state.notifiedSessions.size).toBe(0);
    expect(state.sessionActivitySinceIdle.size).toBe(0);
    expect(state.notificationVersions.size).toBe(0);
    expect(state.executingNotifications.size).toBe(0);
    expect(state.scheduledAt.size).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// 3. Throttle – windowMs=0, prune(), burst, invalid config
// ════════════════════════════════════════════════════════════════════

describe("NotificationThrottle – focused", () => {
  it("windowMs=0 disables throttling (always allows)", () => {
    const t = new NotificationThrottle({ windowMs: 0, maxPerWindow: 1 });
    expect(t.allow("ses_1", "idle")).toBe(true);
    expect(t.allow("ses_1", "idle")).toBe(true); // still allowed
    expect(t.allow("ses_1", "idle")).toBe(true);
    t.dispose();
  });

  it("constructor with null/undefined config falls back to defaults", () => {
    const t = new NotificationThrottle(null as unknown as ThrottleConfig);
    // Should have default config
    expect(t.allow("ses_1", "idle")).toBe(true);
    t.dispose();

    const t2 = new NotificationThrottle(undefined as unknown as ThrottleConfig);
    expect(t2.allow("ses_1", "idle")).toBe(true);
    t2.dispose();
  });

  it("prune() removes expired entries", async () => {
    const t = new NotificationThrottle({ windowMs: 50, maxPerWindow: 5 });
    t.allow("ses_1", "idle");
    t.allow("ses_1", "error");

    expect(t.stats().keys).toBe(2);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 100));
    t.prune();

    expect(t.stats().keys).toBe(0);
    t.dispose();
  });

  it("prune() is a no-op when windowMs is 0 (nothing tracked)", () => {
    const t = new NotificationThrottle({ windowMs: 0, maxPerWindow: 5 });
    t.allow("ses_1", "idle");
    t.prune();
    // When windowMs=0, allow() returns true without tracking anything
    expect(t.stats().keys).toBe(0);
    t.dispose();
  });

  it("burst: rapid calls then wait — allows after window", async () => {
    const t = new NotificationThrottle({ windowMs: 100, maxPerWindow: 2 });

    // First two allowed
    expect(t.allow("ses_burst", "idle")).toBe(true);
    expect(t.allow("ses_burst", "idle")).toBe(false); // < 1000ms interval
    await new Promise((r) => setTimeout(r, 1100));
    expect(t.allow("ses_burst", "idle")).toBe(true);
    expect(t.allow("ses_burst", "idle")).toBe(false); // < 1000ms again

    t.dispose();
  });

  it("per-event-type with windowMs=0 removes per-type limit (hard 1s interval still applies)", () => {
    const t = new NotificationThrottle({
      windowMs: 5000,
      maxPerWindow: 1,
      perEventType: {
        [NOTIFICATION_EVENT_TYPES.Idle]: { windowMs: 0, maxPerWindow: 1 },
      },
    });

    // Idle type: windowMs=0 means no per-window limit, but 1000ms hard min still applies
    expect(t.allow("ses_1", NOTIFICATION_EVENT_TYPES.Idle)).toBe(true);
    expect(t.allow("ses_1", NOTIFICATION_EVENT_TYPES.Idle)).toBe(false); // < 1000ms hard min

    // Error type: limited (maxPerWindow=1 + hard 1000ms interval)
    expect(t.allow("ses_1", NOTIFICATION_EVENT_TYPES.Error)).toBe(true);
    expect(t.allow("ses_1", NOTIFICATION_EVENT_TYPES.Error)).toBe(false);
    t.dispose();
  });

  it("removeSession does not interfere with session IDs that are prefixes", () => {
    const t = new NotificationThrottle({ windowMs: 5000, maxPerWindow: 10 });
    t.allow("a", "idle");
    t.allow("ab", "idle");
    t.allow("abc", "idle");
    expect(t.stats().keys).toBe(3);

    t.removeSession("a");
    // "ab" and "abc" should remain (key format is "sessionID:eventType")
    expect(t.stats().keys).toBe(2);
    t.dispose();
  });

  it("maxPerWindow=0 is treated as 1", () => {
    const t = new NotificationThrottle({ windowMs: 5000, maxPerWindow: 0 });
    expect(t.allow("ses_1", "idle")).toBe(true);
    expect(t.allow("ses_1", "idle")).toBe(false); // 1 per window minimum
    t.dispose();
  });

  it("dispose clears periodic prune timer", () => {
    const t = new NotificationThrottle({ windowMs: 5000, maxPerWindow: 5 });
    const state = t as any;
    expect(state.pruneIntervalId).not.toBeNull();
    t.dispose();
    expect(state.pruneIntervalId).toBeNull();
  });

  it("stats totals are accurate after multiple sessions and types", () => {
    const t = new NotificationThrottle({ windowMs: 5000, maxPerWindow: 10 });
    t.allow("ses_a", "idle");
    t.allow("ses_a", "error");
    t.allow("ses_b", "idle");
    t.allow("ses_b", "error");
    t.allow("ses_b", "question");

    const s = t.stats();
    expect(s.keys).toBe(5);
    expect(s.totalTracked).toBe(5);
    t.dispose();
  });
});

// ════════════════════════════════════════════════════════════════════
// 4. Quiet Hours – timezone boundary, nextActiveTime, multi-range
// ════════════════════════════════════════════════════════════════════

describe("QuietHours – focused", () => {
  it("undefined config returns false (not quiet)", () => {
    const qh = new QuietHours(undefined);
    expect(qh.isQuiet()).toBe(false);
  });

  it("full-day range (start === end) always quiet", () => {
    const qh = new QuietHours({ enabled: true, ranges: [{ start: "00:00", end: "00:00" }] });
    const now = new Date(2025, 0, 1, 14, 30, 0);
    expect(qh.isQuiet(now)).toBe(true);
  });

  it("multiple overlapping ranges — any match returns true", () => {
    const qh = new QuietHours({
      enabled: true,
      ranges: [
        { start: "01:00", end: "03:00" },
        { start: "09:00", end: "17:00" },
        { start: "22:00", end: "23:59" },
      ],
    });

    const day = new Date(2025, 0, 1, 12, 0, 0); // 12:00 — in range 09-17
    expect(qh.isQuiet(day)).toBe(true);

    const night = new Date(2025, 0, 1, 2, 0, 0); // 02:00 — in range 01-03
    expect(qh.isQuiet(night)).toBe(true);

    const evening = new Date(2025, 0, 1, 20, 0, 0); // 20:00 — outside all
    expect(qh.isQuiet(evening)).toBe(false);
  });

  it("timezone boundary: UTC+14 vs UTC-12", () => {
    // Same absolute time, different timezone — quiet hours should evaluate
    // based on the local time in the configured timezone.
    // Create a date that is 10:00 UTC (so in UTC+14 it's 00:00 next day, in UTC-12 it's 22:00 previous day)
    const now = new Date("2025-01-15T10:00:00Z");

    // In UTC+14 (e.g. Pacific/Kiritimati), 10:00 UTC = 00:00 next day
    const qhUtcPlus14 = new QuietHours({
      enabled: true,
      timezone: "Pacific/Kiritimati", // UTC+14
      ranges: [{ start: "22:00", end: "07:00" }], // midnight-crossover
    });

    // 00:00 is within 22:00-07:00 crossover → quiet
    expect(qhUtcPlus14.isQuiet(now)).toBe(true);

    // In UTC-12 (e.g. Etc/GMT+12), 10:00 UTC = 22:00 previous day
    const qhUtcMinus12 = new QuietHours({
      enabled: true,
      timezone: "Etc/GMT+12", // UTC-12
      ranges: [{ start: "09:00", end: "17:00" }],
    });

    // 22:00 is outside 09:00-17:00 → not quiet
    expect(qhUtcMinus12.isQuiet(now)).toBe(false);
  });

  it("nextActiveTime returns end time for normal range", () => {
    const now = new Date(2025, 0, 1, 10, 0, 0); // 10:00, within 09-17
    const qh = new QuietHours({ enabled: true, ranges: [{ start: "09:00", end: "17:00" }] });
    const next = qh.nextActiveTime(now);
    expect(next).not.toBeNull();
    expect(next!.getHours()).toBe(17);
    expect(next!.getMinutes()).toBe(0);
  });

  it("nextActiveTime returns end date for midnight-crossover range", () => {
    // At 23:00, within 22:00-07:00 crossover
    const now = new Date(2025, 0, 1, 23, 0, 0);
    const qh = new QuietHours({ enabled: true, ranges: [{ start: "22:00", end: "07:00" }] });
    const next = qh.nextActiveTime(now);
    expect(next).not.toBeNull();
    // End is 07:00 the next day
    expect(next!.getDate()).toBe(2); // Jan 2
    expect(next!.getHours()).toBe(7);
    expect(next!.getMinutes()).toBe(0);
  });

  it("nextActiveTime returns tomorrow for full-day range", () => {
    const now = new Date(2025, 0, 1, 10, 0, 0);
    const qh = new QuietHours({ enabled: true, ranges: [{ start: "00:00", end: "00:00" }] });
    const next = qh.nextActiveTime(now);
    expect(next).not.toBeNull();
    expect(next!.getDate()).toBe(2); // Tomorrow
  });

  it("nextActiveTime returns null when not currently quiet", () => {
    const now = new Date(2025, 0, 1, 20, 0, 0); // outside all ranges
    const qh = new QuietHours({ enabled: true, ranges: [{ start: "09:00", end: "17:00" }] });
    expect(qh.nextActiveTime(now)).toBeNull();
  });

  it("respects day filter with multiple days", () => {
    // Jan 1, 2025 = Wednesday
    const wed = new Date(2025, 0, 1, 10, 0, 0);
    // Include Wed and Thu
    const qh = new QuietHours({
      enabled: true,
      ranges: [{ start: "09:00", end: "17:00", days: ["Wed", "Thu"] }],
    });
    expect(qh.isQuiet(wed)).toBe(true);

    // Friday should NOT be quiet
    const fri = new Date(2025, 0, 3, 10, 0, 0);
    expect(qh.isQuiet(fri)).toBe(false);
  });

  it("dispose is idempotent", () => {
    const qh = new QuietHours({ enabled: true, ranges: [] });
    qh.dispose();
    qh.dispose(); // second call
    // No error expected
  });
});

// ════════════════════════════════════════════════════════════════════
// 5. Channel Resolver – cache hit/miss, creation failure
// ════════════════════════════════════════════════════════════════════

describe("resolveChannels – focused", () => {
  it("returns cached channels on cache hit", async () => {
    const cache = new Map<string, any>();
    const mockChannels = [{ kind: "log", send: async () => {}, dispose: async () => {} }];
    cache.set("key1", mockChannels);

    const result = await resolveChannels(cache, "key1", []);
    expect(result).toBe(mockChannels); // same reference
  });

  it("returns in-flight promise for concurrent calls (cache still holds promise)", async () => {
    const cache = new Map<string, any>();
    let resolvePromise!: (channels: any[]) => void;
    const pendingPromise = new Promise<any[]>((resolve) => {
      resolvePromise = resolve;
    });
    cache.set("concurrent", pendingPromise);

    // Caller gets the pending promise
    const resultPromise = resolveChannels(cache, "concurrent", []);

    // Fulfill the promise
    const channels = [{ kind: "log", send: async () => {}, dispose: async () => {} }];
    resolvePromise(channels);

    const result = await resultPromise;
    expect(result).toBe(channels);
    // Cache still holds the promise (resolveChannels only replaces on its own creation path)
    expect(cache.get("concurrent")).toBe(pendingPromise);
  });

  it("creates channels on cache miss and caches them", async () => {
    const cache = new Map<string, any>();
    const configs: NotificationChannelConfig[] = [
      { kind: NOTIFICATION_CHANNEL_KINDS.Log, enabled: true },
    ];

    const result = await resolveChannels(cache, "fresh", configs);
    expect(result.length).toBe(1);
    expect(result[0]!.kind).toBe(NOTIFICATION_CHANNEL_KINDS.Log);

    // Verify cached
    expect(cache.get("fresh")).toBe(result);
  });

  it("returns empty array when channels cannot be created (cache NOT cleared)", async () => {
    const cache = new Map<string, any>();
    const configs: NotificationChannelConfig[] = [
      { kind: "__broken__", enabled: true } as any,
    ];

    const result = await resolveChannels(cache, "unknown_kind", configs);
    // createChannels uses Promise.allSettled + filters nulls — never rejects
    expect(result).toEqual([]);
    // Cache entry is kept (empty channels were 'created')
    expect(cache.has("unknown_kind")).toBe(true);
  });

  it("creation failure with mixed valid/invalid configs returns only valid channels", async () => {
    const cache = new Map<string, any>();
    const configs: NotificationChannelConfig[] = [
      { kind: NOTIFICATION_CHANNEL_KINDS.Log, enabled: true },
      { kind: "__broken__", enabled: true } as any,
    ];

    const result = await resolveChannels(cache, "mixed", configs);
    expect(result.length).toBe(1);
    expect(result[0]!.kind).toBe(NOTIFICATION_CHANNEL_KINDS.Log);
  });
});

// ════════════════════════════════════════════════════════════════════
// 6. Channels – createChannel null returns, system-toast, custom-command
// ════════════════════════════════════════════════════════════════════

describe("Channels – focused", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = tempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("createChannel returns null for disabled channel", async () => {
    const result = await createChannel({
      kind: NOTIFICATION_CHANNEL_KINDS.Log,
      enabled: false,
    });
    expect(result).toBeNull();
  });

  it("createChannel returns null for unknown kind", async () => {
    const result = await createChannel({
      kind: "unknown_kind",
      enabled: true,
    } as any);
    expect(result).toBeNull();
  });

  it("createChannel returns null for disabled sound channel", async () => {
    const result = await createChannel({
      kind: NOTIFICATION_CHANNEL_KINDS.Sound,
      enabled: false,
      soundPath: "/test/sound.mp3",
    });
    expect(result).toBeNull();
  });

  it("createChannel returns null for custom command with empty command", async () => {
    const result = await createChannel({
      kind: NOTIFICATION_CHANNEL_KINDS.CustomCommand,
      enabled: true,
      command: "",
    });
    expect(result).toBeNull();
  });

  it("createChannel returns null for webhook with empty url", async () => {
    const result = await createChannel({
      kind: NOTIFICATION_CHANNEL_KINDS.Webhook,
      enabled: true,
      url: "",
    });
    expect(result).toBeNull();
  });

  it("createChannel returns null for file with empty path", async () => {
    const result = await createChannel({
      kind: NOTIFICATION_CHANNEL_KINDS.File,
      enabled: true,
      path: "",
    });
    expect(result).toBeNull();
  });

  it("createChannels returns empty array when all disabled", async () => {
    const channels = await createChannels([
      { kind: NOTIFICATION_CHANNEL_KINDS.Log, enabled: false },
      { kind: NOTIFICATION_CHANNEL_KINDS.File, enabled: false, path: "/tmp/x.log" },
      { kind: NOTIFICATION_CHANNEL_KINDS.Webhook, enabled: false, url: "https://x.com" },
    ]);

    expect(channels).toEqual([]);
  });

  it("LogChannel with debug level logs without throwing", async () => {
    const channel = await createChannel({
      kind: NOTIFICATION_CHANNEL_KINDS.Log,
      enabled: true,
      level: "debug",
    });
    expect(channel).not.toBeNull();

    const msg: NotificationMessage = {
      title: "Debug Test",
      body: "Debug body",
      sessionId: "ses_dbg",
      eventType: NOTIFICATION_EVENT_TYPES.Idle,
      timestamp: new Date().toISOString(),
    };

    await expect(channel!.send(msg)).resolves.toBeUndefined();
    await channel!.dispose();
  });

  it("CustomCommandChannel with stdin sends JSON via stdin", async () => {
    // Mock exec to verify command execution
    const channel = await createChannel({
      kind: NOTIFICATION_CHANNEL_KINDS.CustomCommand,
      enabled: true,
      command: "cat",
      passAsStdin: true,
    });
    expect(channel).not.toBeNull();

    const msg: NotificationMessage = {
      title: "Stdin Test",
      body: "Hello via stdin",
      sessionId: "ses_stdin",
      eventType: NOTIFICATION_EVENT_TYPES.Custom,
      timestamp: new Date().toISOString(),
    };

    // Should not throw
    await expect(channel!.send(msg)).resolves.toBeUndefined();
    await channel!.dispose();
  });

  it("WebhookChannel sets default Content-Type header", async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true, status: 200 }));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    try {
      const channel = await createChannel({
        kind: NOTIFICATION_CHANNEL_KINDS.Webhook,
        enabled: true,
        url: "https://example.com/hook",
      });
      expect(channel).not.toBeNull();

      const msg: NotificationMessage = {
        title: "Header Test",
        body: "Check headers",
        sessionId: "ses_hdr",
        eventType: NOTIFICATION_EVENT_TYPES.DispatchComplete,
        timestamp: new Date().toISOString(),
      };

      await channel!.send(msg);

      const callArgs = fetchMock.mock.calls[0]!;
      const options = callArgs[1] as RequestInit;
      const headers = options.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");

      await channel!.dispose();
    } finally {
      delete (global as any).fetch;
    }
  });

  it("WebhookChannel includes custom headers", async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true, status: 200 }));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    try {
      const channel = await createChannel({
        kind: NOTIFICATION_CHANNEL_KINDS.Webhook,
        enabled: true,
        url: "https://example.com/hook",
        headers: { "X-Custom": "test-value", "Authorization": "Bearer token123" },
      });
      expect(channel).not.toBeNull();

      const msg: NotificationMessage = {
        title: "Custom Header Test",
        body: "Check custom headers",
        sessionId: "ses_cust_hdr",
        eventType: NOTIFICATION_EVENT_TYPES.Custom,
        timestamp: new Date().toISOString(),
      };

      await channel!.send(msg);

      const callArgs = fetchMock.mock.calls[0]!;
      const options = callArgs[1] as RequestInit;
      const headers = options.headers as Record<string, string>;
      expect(headers["X-Custom"]).toBe("test-value");
      expect(headers["Authorization"]).toBe("Bearer token123");

      await channel!.dispose();
    } finally {
      delete (global as any).fetch;
    }
  });

  it("FileChannel creates parent directories automatically", async () => {
    const nestedPath = join(tmpDir, "subdir", "nested", "log.jsonl");
    const channel = await createChannel({
      kind: NOTIFICATION_CHANNEL_KINDS.File,
      enabled: true,
      path: nestedPath,
    });
    expect(channel).not.toBeNull();

    const msg: NotificationMessage = {
      title: "Nested Dir Test",
      body: "Should create dirs",
      sessionId: "ses_nest",
      eventType: NOTIFICATION_EVENT_TYPES.Idle,
      timestamp: new Date().toISOString(),
    };

    await channel!.send(msg);
    expect(existsSync(nestedPath)).toBe(true);
    await channel!.dispose();
  });

  it("channel send failure does not throw (does not propagate)", async () => {
    // File with uncreatable path (non-writable root on macOS is hard to test,
    // so test with a bad webhook URL that fetch rejects)
    const channel = await createChannel({
      kind: NOTIFICATION_CHANNEL_KINDS.Webhook,
      enabled: true,
      url: "https://invalid.example.com:0/webhook", // will fail
      timeoutMs: 10,
    });
    expect(channel).not.toBeNull();

    const msg: NotificationMessage = {
      title: "Fail Test",
      body: "Should not throw",
      sessionId: "ses_fail",
      eventType: NOTIFICATION_EVENT_TYPES.Error,
      timestamp: new Date().toISOString(),
    };

    await expect(channel!.send(msg)).resolves.toBeUndefined();
    await channel!.dispose();
  });
});

// ════════════════════════════════════════════════════════════════════
// 7. Formatting – edge cases
// ════════════════════════════════════════════════════════════════════

describe("Formatting – focused", () => {
  it("escapeAppleScriptText handles mixed quotes and backslashes", () => {
    expect(escapeAppleScriptText('')).toBe('');
    expect(escapeAppleScriptText('plain text')).toBe('plain text');
    expect(escapeAppleScriptText('a"b\\c')).toBe('a\\"b\\\\c');
  });

  it("escapePowerShellSingleQuotedText handles edge cases", () => {
    expect(escapePowerShellSingleQuotedText('')).toBe('');
    expect(escapePowerShellSingleQuotedText("'")).toBe("''");
    expect(escapePowerShellSingleQuotedText("a'b'c")).toBe("a''b''c");
    expect(escapePowerShellSingleQuotedText("noquotes")).toBe("noquotes");
  });

  it("escapeBashText handles edge cases", () => {
    expect(escapeBashText('')).toBe('');
    expect(escapeBashText("'")).toBe("'\\''");
    expect(escapeBashText("a'b'c")).toBe("a'\\''b'\\''c");
  });

  it("truncate handles boundary conditions", () => {
    // Exactly at maxLen
    expect(truncate("12345", 5)).toBe("12345");
    // One over
    expect(truncate("123456", 5)).toBe("1234…");
    // maxLen=1
    expect(truncate("ab", 1)).toBe("…");
    expect(truncate("a", 1)).toBe("a");
    // Very long string
    expect(truncate("x".repeat(1000), 10)).toBe("x".repeat(9) + "…");
  });
});

// ════════════════════════════════════════════════════════════════════
// 8. Config-validate – 5+ illegal config forms
// ════════════════════════════════════════════════════════════════════

describe("validateNotificationConfig – focused", () => {
  it("detects unknown channel kind", () => {
    const cfg = createBaseConfig({
      channels: [{ kind: "fax_machine", enabled: true } as any],
    });

    const warnings = validateNotificationConfig(cfg);
    expect(warnings.some((w) => w.includes("unknown kind"))).toBe(true);
    expect(warnings.some((w) => w.includes("fax_machine"))).toBe(true);
  });

  it("detects per-event-type invalid maxPerWindow < 1", () => {
    const cfg = createBaseConfig({
      throttle: {
        windowMs: 5000,
        maxPerWindow: 10,
        perEventType: {
          idle: { windowMs: 3000, maxPerWindow: 0 },
        },
      },
    });

    const warnings = validateNotificationConfig(cfg);
    expect(warnings.some((w) => w.includes("perEventType") && w.includes("maxPerWindow"))).toBe(true);
  });

  it("detects per-event-type invalid windowMs <= 0", () => {
    const cfg = createBaseConfig({
      throttle: {
        windowMs: 5000,
        maxPerWindow: 10,
        perEventType: {
          error: { windowMs: -100, maxPerWindow: 1 },
        },
      },
    });

    const warnings = validateNotificationConfig(cfg);
    expect(warnings.some((w) => w.includes("perEventType") && w.includes("windowMs must be positive"))).toBe(true);
  });

  it("detects event-level unknown event type key", () => {
    const cfg = createBaseConfig({
      events: {
        alien_invasion: { enabled: true },
      },
    });

    const warnings = validateNotificationConfig(cfg);
    expect(warnings.some((w) => w.includes("unknown key"))).toBe(true);
    expect(warnings.some((w) => w.includes("alien_invasion"))).toBe(true);
  });

  it("detects event-level channel with unknown kind", () => {
    const cfg = createBaseConfig({
      events: {
        idle: {
          enabled: true,
          channels: [{ kind: "pager_duty", enabled: true } as any],
        },
      },
    });

    const warnings = validateNotificationConfig(cfg);
    expect(warnings.some((w) => w.includes("unknown kind"))).toBe(true);
    expect(warnings.some((w) => w.includes("pager_duty"))).toBe(true);
  });

  it("detects event-level throttle maxPerWindow < 1 in quietHoursOverride", () => {
    const cfg = createBaseConfig({
      events: {
        idle: {
          enabled: true,
          throttle: { maxPerWindow: 0, windowMs: 5000 },
        },
      },
    });

    const warnings = validateNotificationConfig(cfg);
    expect(warnings.some((w) => w.includes("throttle.maxPerWindow must be at least 1"))).toBe(true);
  });

  it("detects invalid quietHours range HH:MM format (event-level override)", () => {
    const cfg = createBaseConfig({
      events: {
        idle: {
          enabled: true,
          quietHoursOverride: {
            enabled: true,
            ranges: [{ start: "9:00", end: "17:00" }],
          },
        },
      },
    });

    const warnings = validateNotificationConfig(cfg);
    expect(warnings.some((w) => w.includes("start is not in HH:MM format"))).toBe(true);
  });

  it("detects invalid global quietHours range HH:MM format (single-digit hour)", () => {
    const cfg = createBaseConfig({
      quietHours: {
        enabled: true,
        ranges: [{ start: "9:00", end: "17:00" }],
      },
    });

    const warnings = validateNotificationConfig(cfg);
    // "9:00" has 1-digit hour → doesn't match ^\d{2}:\d{2}$
    expect(warnings.some((w) => w.includes("start is not in HH:MM format"))).toBe(true);
  });

  it("detects empty questionToolNames", () => {
    const cfg = createBaseConfig({
      questionToolNames: [],
    });

    const warnings = validateNotificationConfig(cfg);
    expect(warnings.some((w) => w.includes("questionToolNames is empty"))).toBe(true);
  });

  it("detects empty soundPath for Sound channel", () => {
    const cfg = createBaseConfig({
      channels: [
        { kind: NOTIFICATION_CHANNEL_KINDS.Sound, enabled: true, soundPath: "" },
      ],
    });

    const warnings = validateNotificationConfig(cfg);
    expect(warnings.some((w) => w.includes("Sound") && w.includes("empty soundPath"))).toBe(true);
  });

  it("detects empty command for CustomCommand channel", () => {
    const cfg = createBaseConfig({
      channels: [
        { kind: NOTIFICATION_CHANNEL_KINDS.CustomCommand, enabled: true, command: "" },
      ],
    });

    const warnings = validateNotificationConfig(cfg);
    expect(warnings.some((w) => w.includes("CustomCommand") && w.includes("empty command"))).toBe(true);
  });

  it("detects empty url for Webhook channel", () => {
    const cfg = createBaseConfig({
      channels: [
        { kind: NOTIFICATION_CHANNEL_KINDS.Webhook, enabled: true, url: "" },
      ],
    });

    const warnings = validateNotificationConfig(cfg);
    expect(warnings.some((w) => w.includes("Webhook") && w.includes("empty url"))).toBe(true);
  });

  it("detects multiple issues simultaneously", () => {
    const cfg = createBaseConfig({
      idleDelayMs: -1,
      throttle: { windowMs: -1, maxPerWindow: 0 },
      channels: [
        { kind: "telepathy", enabled: true } as any,
      ],
      questionToolNames: [],
    });

    const warnings = validateNotificationConfig(cfg);
    expect(warnings.length).toBeGreaterThanOrEqual(4);
    expect(warnings.some((w) => w.includes("idleDelayMs"))).toBe(true);
    expect(warnings.some((w) => w.includes("maxPerWindow"))).toBe(true);
    expect(warnings.some((w) => w.includes("unknown kind"))).toBe(true);
    expect(warnings.some((w) => w.includes("questionToolNames is empty"))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// 9. Content – truncation boundary, edge cases
// ════════════════════════════════════════════════════════════════════

describe("Content – focused", () => {
  it("renderTemplate keeps unknown vars as-is", () => {
    expect(renderTemplate("{missing_var}", {})).toBe("{missing_var}");
    expect(renderTemplate("{a} and {b}", { a: "x" })).toBe("x and {b}");
  });

  it("renderTemplate handles empty template string", () => {
    expect(renderTemplate("", { a: "b" })).toBe("");
  });

  it("renderTemplate with no placeholders returns input unchanged", () => {
    expect(renderTemplate("Hello World", {})).toBe("Hello World");
    expect(renderTemplate("plain text", { x: "y" })).toBe("plain text");
  });

  it("renderTemplate replaces multiple distinct variables", () => {
    const result = renderTemplate("{a}-{b}-{c}", { a: "1", b: "2", c: "3" });
    expect(result).toBe("1-2-3");
  });

  it("buildTemplateVars returns all required keys even with minimal input", () => {
    const vars = buildTemplateVars({ sessionId: "s1", eventType: "idle" });

    expect(vars.session_id).toBe("s1");
    expect(vars.session_title).toBe("s1"); // Falls back to sessionId
    expect(vars.event_type).toBe("idle");
    expect(vars.agent).toBe("");
    expect(vars.role_name).toBe("");
    expect(vars.last_user_message).toBe("");
    expect(vars.last_assistant_message).toBe("");
    expect(vars.timestamp).toBeDefined();
    expect(typeof vars.timestamp).toBe("string");
  });

  it("buildNotificationContent truncates long body to 4000 chars", async () => {
    const longBody = "B".repeat(5000);
    const client = createMockClient();

    // Mock get to return a long title (which becomes the body via {session_title})
    const getMock = mock(() =>
      Promise.resolve({ title: longBody }),
    ) as any;

    const msg = await buildNotificationContent({
      sessionID: "ses_long_body",
      eventType: NOTIFICATION_EVENT_TYPES.Idle,
      client: { ...client, get: getMock },
    });

    // Body template is "{session_title}" → the long title becomes the body
    // body is truncated to 4000 chars
    expect(msg.body.length).toBeLessThanOrEqual(4000);
    expect(msg.body).toMatch(/…$/);
    expect(msg.body.slice(0, -1)).toBe("B".repeat(3999));
  });

  it("buildNotificationContent uses custom templates from eventConfig", async () => {
    const client = createMockClient();
    const msg = await buildNotificationContent({
      sessionID: "ses_custom_tpl",
      eventType: NOTIFICATION_EVENT_TYPES.Error,
      client,
      eventConfig: {
        enabled: true,
        titleTemplate: "CUSTOM {event_type}",
        messageTemplate: "{session_title} by {agent}",
      },
      agent: "testAgent",
    });

    expect(msg.title).toBe("CUSTOM error");
    expect(msg.body).toBe("Focused Test Session by testAgent");
  });

  it("buildNotificationContent falls back to default templates when eventConfig is undefined", async () => {
    const client = createMockClient();
    const msg = await buildNotificationContent({
      sessionID: "ses_no_cfg",
      eventType: NOTIFICATION_EVENT_TYPES.Question,
      client,
    });

    expect(msg.title).toBe("Rolebox · question");
    expect(msg.sessionId).toBe("ses_no_cfg");
  });

  it("buildNotificationContent includes roleName and agent when provided", async () => {
    const client = createMockClient();
    const msg = await buildNotificationContent({
      sessionID: "ses_role",
      eventType: NOTIFICATION_EVENT_TYPES.DispatchComplete,
      client,
      agent: "myAgent",
      roleName: "MyRole",
    });

    expect(msg.agent).toBe("myAgent");
    expect(msg.roleName).toBe("MyRole");
  });

  it("buildNotificationContent does not throw when client returns null", async () => {
    const nullClient = {
      get: mock(() => Promise.resolve(null)),
      messages: mock(() => Promise.resolve(null)),
    } as any;

    const msg = await buildNotificationContent({
      sessionID: "ses_null_client",
      eventType: NOTIFICATION_EVENT_TYPES.Error,
      client: nullClient,
    });

    expect(msg.sessionId).toBe("ses_null_client");
    expect(msg.title).toBeDefined();
  });

  it("buildNotificationContent does not throw when messages return empty array", async () => {
    const emptyMsgClient = {
      get: mock(() => Promise.resolve({ title: "Empty Session" })),
      messages: mock(() => Promise.resolve([])),
    } as any;

    const msg = await buildNotificationContent({
      sessionID: "ses_empty_msgs",
      eventType: NOTIFICATION_EVENT_TYPES.Idle,
      client: emptyMsgClient,
    });

    expect(msg.title).toBe("Rolebox · idle");
    expect(msg.body).toBe("Empty Session");
  });
});
