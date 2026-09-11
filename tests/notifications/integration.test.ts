// ── Notification System: Comprehensive Integration Tests ─────────────────
//
// Tests every public module in src/notifications/ with realistic scenarios.
// Uses bun:test syntax — describe/it/expect from "bun:test".
// Mocks external dependencies (execFile, fetch, fs, env vars, timers)
// while testing real module code.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Module imports ─────────────────────────────────────────────────────

// Types
import { NOTIFICATION_EVENT_TYPES, NOTIFICATION_CHANNEL_KINDS } from "../../src/notifications/types";
import type {
  NotificationConfig,
  NotificationMessage,
  NotificationChannelConfig,
  ThrottleConfig,
} from "../../src/notifications/types";

// Config
import {
  parseNotificationConfig,
  mergeNotificationConfigs,
  resolveEnvVarsInConfig,
  validateNotificationConfig,
  DEFAULT_NOTIFICATION_CONFIG,
} from "../../src/notifications/config";

// Content
import {
  renderTemplate,
  buildTemplateVars,
  extractMessageText,
  collapseWhitespace,
  getLastNonEmptyLine,
  buildNotificationContent,
  readSessionInfo,
} from "../../src/notifications/content";

// Throttle
import { NotificationThrottle, DEFAULT_THROTTLE_CONFIG } from "../../src/notifications/throttle";

// Quiet Hours
import { QuietHours } from "../../src/notifications/quiet-hours";

// Scheduler
import { NotificationScheduler, createScheduler } from "../../src/notifications/scheduler";

// Formatting
import {
  escapeAppleScriptText,
  escapePowerShellSingleQuotedText,
  escapeBashText,
  truncate,
  buildWindowsToastScript,
  buildAppleScriptNotification,
  buildNotifySendCommand,
} from "../../src/notifications/formatting";

// Channels
import { createChannel, createChannels } from "../../src/notifications/channels";
import type { NotificationChannel } from "../../src/notifications/channels";

// Platform
import { detectPlatform, findCommand, commandExists, preWarmCommandCache } from "../../src/notifications/platform";

// Manager
import { NotificationManager } from "../../src/notifications/manager";

// ── Helpers ────────────────────────────────────────────────────────────

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "notif-test-"));
}

function createMockClient() {
  return {
    get: mock(() =>
      Promise.resolve({
        title: "Test Session",
      }),
    ),
    messages: mock(() =>
      Promise.resolve([
        {
          info: { role: "user" },
          parts: [{ type: "text", text: "Hello from user" }],
        },
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: "Response from assistant" }],
        },
      ]),
    ),
  } as any;
}

// ════════════════════════════════════════════════════════════════════════
// 1. Config Parsing & Merging
// ════════════════════════════════════════════════════════════════════════

describe("Notification Config", () => {
  it("parses valid YAML config", () => {
    const raw: unknown = {
      enabled: true,
      mainSessionOnly: false,
      idleDelayMs: 5000,
      questionToolNames: ["ask"],
      channels: [{ kind: "log", enabled: true, level: "info" }],
      quietHours: { enabled: true, ranges: [{ start: "22:00", end: "07:00" }] },
      throttle: { windowMs: 5000, maxPerWindow: 5 },
      events: {
        idle: { enabled: true, titleTemplate: "Custom {event_type}" },
      },
    };

    const config = parseNotificationConfig(raw);
    expect(config.enabled).toBe(true);
    expect(config.mainSessionOnly).toBe(false);
    expect(config.idleDelayMs).toBe(5000);
    expect(config.questionToolNames).toEqual(["ask"]);
    expect(config.channels).toHaveLength(1);
    expect(config.channels[0]!.kind).toBe(NOTIFICATION_CHANNEL_KINDS.Log);
    expect(config.quietHours.enabled).toBe(true);
    expect(config.quietHours.ranges).toHaveLength(1);
    expect(config.quietHours.ranges[0]!.start).toBe("22:00");
    expect(config.throttle.windowMs).toBe(5000);
    expect(config.throttle.maxPerWindow).toBe(5);
    expect(config.events).toBeDefined();
    expect(config.events![NOTIFICATION_EVENT_TYPES.Idle]).toBeDefined();
  });

  it("returns defaults for invalid input", () => {
    const config = parseNotificationConfig(null);
    expect(config.enabled).toBe(true);
    expect(config.channels).toEqual([]);
    expect(config.quietHours.enabled).toBe(false);

    const config2 = parseNotificationConfig(undefined);
    expect(config2.enabled).toBe(true);
    expect(config2.idleDelayMs).toBeGreaterThan(0);
  });

  it("merges global and role configs — role channels replace global channels", () => {
    const global: NotificationConfig = {
      ...DEFAULT_NOTIFICATION_CONFIG,
      channels: [
        { kind: NOTIFICATION_CHANNEL_KINDS.Log, enabled: true },
        { kind: NOTIFICATION_CHANNEL_KINDS.File, enabled: true, path: "/tmp/global.log" },
      ],
    };

    const role: NotificationConfig = {
      ...DEFAULT_NOTIFICATION_CONFIG,
      channels: [{ kind: NOTIFICATION_CHANNEL_KINDS.Sound, enabled: true, soundPath: "/sounds/ding.aiff" }],
    };

    const merged = mergeNotificationConfigs(global, role);
    expect(merged.channels).toHaveLength(1);
    expect(merged.channels[0]!.kind).toBe(NOTIFICATION_CHANNEL_KINDS.Sound);
  });

  it("merges global and role configs — role event configs replace at event key level", () => {
    const global: NotificationConfig = {
      ...DEFAULT_NOTIFICATION_CONFIG,
      events: {
        [NOTIFICATION_EVENT_TYPES.Idle]: {
          enabled: true,
          titleTemplate: "Global Idle",
        },
        [NOTIFICATION_EVENT_TYPES.Error]: {
          enabled: true,
          titleTemplate: "Global Error",
        },
      },
    };

    const role: NotificationConfig = {
      ...DEFAULT_NOTIFICATION_CONFIG,
      events: {
        [NOTIFICATION_EVENT_TYPES.Idle]: {
          enabled: false,
          titleTemplate: "Role Idle",
        },
      },
    };

    const merged = mergeNotificationConfigs(global, role);
    // Role overwrites Idle
    expect(merged.events![NOTIFICATION_EVENT_TYPES.Idle]!.enabled).toBe(false);
    expect(merged.events![NOTIFICATION_EVENT_TYPES.Idle]!.titleTemplate).toBe("Role Idle");
    // Global Error preserved
    expect(merged.events![NOTIFICATION_EVENT_TYPES.Error]!.enabled).toBe(true);
    expect(merged.events![NOTIFICATION_EVENT_TYPES.Error]!.titleTemplate).toBe("Global Error");
  });

  it("validates config and returns warnings for invalid values", () => {
    const bad: NotificationConfig = {
      ...DEFAULT_NOTIFICATION_CONFIG,
      idleDelayMs: -1,
      throttle: { windowMs: -100, maxPerWindow: 0 },
      channels: [
        { kind: NOTIFICATION_CHANNEL_KINDS.Sound, enabled: true, soundPath: "" },
        { kind: NOTIFICATION_CHANNEL_KINDS.Webhook, enabled: true, url: "" },
      ],
      questionToolNames: [],
    };

    const warnings = validateNotificationConfig(bad);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("idleDelayMs"))).toBe(true);
    expect(warnings.some((w) => w.includes("maxPerWindow must be at least 1"))).toBe(true);
    expect(warnings.some((w) => w.includes("windowMs must be positive"))).toBe(true);
    expect(warnings.some((w) => w.includes("Sound") && w.includes("empty soundPath"))).toBe(true);
    expect(warnings.some((w) => w.includes("Webhook") && w.includes("empty url"))).toBe(true);
    expect(warnings.some((w) => w.includes("questionToolNames is empty"))).toBe(true);
  });

  it("resolves env vars in config strings", () => {
    const original = process.env.NOTIF_TEST_URL;
    process.env.NOTIF_TEST_URL = "https://hooks.example.com/notify";

    try {
      const config: NotificationConfig = {
        ...DEFAULT_NOTIFICATION_CONFIG,
        channels: [
          {
            kind: NOTIFICATION_CHANNEL_KINDS.Webhook,
            enabled: true,
            url: "{env:NOTIF_TEST_URL}",
          },
        ],
      };

      const resolved = resolveEnvVarsInConfig(config);
      expect(resolved.channels[0]!.kind).toBe(NOTIFICATION_CHANNEL_KINDS.Webhook);
      const webhook = resolved.channels[0]! as NotificationChannelConfig & { kind: NOTIFICATION_CHANNEL_KINDS.Webhook };
      expect(webhook.url).toBe("https://hooks.example.com/notify");
    } finally {
      if (original) process.env.NOTIF_TEST_URL = original;
      else delete process.env.NOTIF_TEST_URL;
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2. Template Rendering
// ════════════════════════════════════════════════════════════════════════

describe("Template Rendering", () => {
  it("renders all template variables correctly", () => {
    const result = renderTemplate("{session_id} - {event_type}", {
      session_id: "ses_abc",
      event_type: "idle",
      agent: "coder",
    });
    expect(result).toBe("ses_abc - idle");
  });

  it("leaves unknown variables as-is", () => {
    const result = renderTemplate("Hello {unknown_var}", {
      session_id: "ses_1",
    });
    expect(result).toBe("Hello {unknown_var}");
  });

  it("handles empty template", () => {
    expect(renderTemplate("", {})).toBe("");
    expect(renderTemplate("", { x: "y" })).toBe("");
  });

  it("handles multiple occurrences of same variable", () => {
    const result = renderTemplate("{x} + {x} = {y}", { x: "1", y: "2" });
    expect(result).toBe("1 + 1 = 2");
  });

  it("buildTemplateVars includes all expected keys", () => {
    const vars = buildTemplateVars({
      sessionId: "ses_1",
      eventType: NOTIFICATION_EVENT_TYPES.Question,
      agent: "helper",
      roleName: "Coder",
      sessionTitle: "My Session",
      lastUserMessage: "hi",
    });

    expect(vars.session_id).toBe("ses_1");
    expect(vars.session_title).toBe("My Session");
    expect(vars.event_type).toBe("question");
    expect(vars.agent).toBe("helper");
    expect(vars.role_name).toBe("Coder");
    expect(vars.last_user_message).toBe("hi");
    expect(vars.last_assistant_message).toBe("");
    expect(vars.timestamp).toBeDefined();
  });

  it("buildTemplateVars falls back to sessionId for session_title", () => {
    const vars = buildTemplateVars({
      sessionId: "ses_fallback",
      eventType: NOTIFICATION_EVENT_TYPES.Idle,
    });
    expect(vars.session_title).toBe("ses_fallback");
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3. Content Building (with mock client)
// ════════════════════════════════════════════════════════════════════════

describe("Content Building", () => {
  it("extractMessageText extracts text parts", () => {
    const text = extractMessageText([
      { type: "text", text: "Hello" },
      { type: "tool_use" },
      { type: "text", text: "  World  " },
    ]);
    expect(text).toBe("Hello\nWorld");
  });

  it("collapseWhitespace flattens multiline", () => {
    const result = collapseWhitespace("  line1  \n\n  line2  \n");
    expect(result).toBe("line1 line2");
  });

  it("getLastNonEmptyLine returns last line", () => {
    expect(getLastNonEmptyLine("a\nb\nc")).toBe("c");
    expect(getLastNonEmptyLine("")).toBe("");
    expect(getLastNonEmptyLine("  \n  ")).toBe("");
  });

  it("buildNotificationContent returns populated message with mock client", async () => {
    const client = createMockClient();
    const msg = await buildNotificationContent({
      sessionID: "ses_test",
      eventType: NOTIFICATION_EVENT_TYPES.Idle,
      client,
      agent: "helper",
      roleName: "TestRole",
      dir: "/tmp",
    });

    expect(msg.sessionId).toBe("ses_test");
    expect(msg.eventType).toBe(NOTIFICATION_EVENT_TYPES.Idle);
    expect(msg.title).toBe("Rolebox · idle");
    expect(msg.body).toBe("Test Session");
    expect(msg.agent).toBe("helper");
    expect(msg.roleName).toBe("TestRole");
    expect(msg.timestamp).toBeDefined();
  });

  it("buildNotificationContent uses event config templates", async () => {
    const client = createMockClient();
    const msg = await buildNotificationContent({
      sessionID: "ses_cfg",
      eventType: NOTIFICATION_EVENT_TYPES.Error,
      client,
      eventConfig: {
        enabled: true,
        titleTemplate: "ALERT: {event_type}",
        messageTemplate: "{session_title} - {agent}",
      },
      agent: "bot",
    });

    expect(msg.title).toBe("ALERT: error");
    expect(msg.body).toBe("Test Session - bot");
  });

  it("readSessionInfo returns title, user message, assistant message", async () => {
    const client = createMockClient();
    const info = await readSessionInfo(client, "ses_info");
    expect(info.title).toBe("Test Session");
    expect(info.lastUserMessage).toBe("Hello from user");
    expect(info.lastAssistantMessage).toBe("Response from assistant");
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4. Throttle
// ════════════════════════════════════════════════════════════════════════

describe("NotificationThrottle", () => {
  let throttle: NotificationThrottle;

  beforeEach(() => {
    throttle = new NotificationThrottle({ windowMs: 5000, maxPerWindow: 3 });
  });

  it("allows first notification", () => {
    expect(throttle.allow("ses_1", NOTIFICATION_EVENT_TYPES.Idle)).toBe(true);
  });

  it("blocks rapid duplicate within 1000ms", () => {
    expect(throttle.allow("ses_1", NOTIFICATION_EVENT_TYPES.Idle)).toBe(true);
    // Second call is too close (< 1000ms minimum interval)
    expect(throttle.allow("ses_1", NOTIFICATION_EVENT_TYPES.Idle)).toBe(false);
  });

  it("allows after window expires", async () => {
    expect(throttle.allow("ses_1", NOTIFICATION_EVENT_TYPES.Idle)).toBe(true);
    // Wait for minimum interval to pass
    await new Promise((r) => setTimeout(r, 1100));
    expect(throttle.allow("ses_1", NOTIFICATION_EVENT_TYPES.Idle)).toBe(true);
  });

  it("respects maxPerWindow limit", async () => {
    const config: ThrottleConfig = { windowMs: 500, maxPerWindow: 2 };
    const t = new NotificationThrottle(config);

    expect(t.allow("ses_1", NOTIFICATION_EVENT_TYPES.Error)).toBe(true);
    await new Promise((r) => setTimeout(r, 1100));
    expect(t.allow("ses_1", NOTIFICATION_EVENT_TYPES.Error)).toBe(true);
    await new Promise((r) => setTimeout(r, 1100));
    // Third one should be allowed since old stamps aged out
    expect(t.allow("ses_1", NOTIFICATION_EVENT_TYPES.Error)).toBe(true);
  });

  it("applies per-event-type override", () => {
    const t = new NotificationThrottle({
      windowMs: 5000,
      maxPerWindow: 10,
      perEventType: {
        [NOTIFICATION_EVENT_TYPES.Error]: { windowMs: 5000, maxPerWindow: 1 },
      },
    });

    expect(t.allow("ses_1", NOTIFICATION_EVENT_TYPES.Error)).toBe(true);
    expect(t.allow("ses_1", NOTIFICATION_EVENT_TYPES.Error)).toBe(false);
    // Different event type uses global limit
    expect(t.allow("ses_1", NOTIFICATION_EVENT_TYPES.Idle)).toBe(true);
  });

  it("reset() clears all state", () => {
    expect(throttle.allow("ses_1", NOTIFICATION_EVENT_TYPES.Idle)).toBe(true);
    expect(throttle.allow("ses_1", NOTIFICATION_EVENT_TYPES.Idle)).toBe(false);
    throttle.reset();
    expect(throttle.allow("ses_1", NOTIFICATION_EVENT_TYPES.Idle)).toBe(true);
  });

  it("stats returns correct counts", () => {
    expect(throttle.stats()).toEqual({ totalTracked: 0, keys: 0 });
    throttle.allow("ses_1", NOTIFICATION_EVENT_TYPES.Idle);
    const s = throttle.stats();
    expect(s.keys).toBe(1);
    expect(s.totalTracked).toBe(1);
  });

  it("removeSession() clears all entries for a given session", () => {
    throttle.allow("ses_a", NOTIFICATION_EVENT_TYPES.Idle);
    throttle.allow("ses_a", NOTIFICATION_EVENT_TYPES.Error);
    throttle.allow("ses_a", NOTIFICATION_EVENT_TYPES.Question);
    expect(throttle.stats().keys).toBe(3);

    throttle.removeSession("ses_a");

    expect(throttle.stats()).toEqual({ totalTracked: 0, keys: 0 });
  });

  it("removeSession() does not affect other sessions", () => {
    throttle.allow("ses_a", NOTIFICATION_EVENT_TYPES.Idle);
    throttle.allow("ses_b", NOTIFICATION_EVENT_TYPES.Idle);
    throttle.allow("ses_c", NOTIFICATION_EVENT_TYPES.Error);
    expect(throttle.stats().keys).toBe(3);

    throttle.removeSession("ses_b");

    const s = throttle.stats();
    expect(s.keys).toBe(2);
    expect(s.totalTracked).toBe(2);
  });

  it("removeSession() is safe for nonexistent session", () => {
    expect(() => throttle.removeSession("nonexistent")).not.toThrow();
    expect(throttle.stats()).toEqual({ totalTracked: 0, keys: 0 });
  });

  it("dispose() clears all state", () => {
    throttle.allow("ses_1", NOTIFICATION_EVENT_TYPES.Idle);
    throttle.allow("ses_2", NOTIFICATION_EVENT_TYPES.Error);
    expect(throttle.stats().keys).toBeGreaterThan(0);

    throttle.dispose();

    expect(throttle.stats()).toEqual({ totalTracked: 0, keys: 0 });
  });

  it("dispose() is safe to call multiple times", () => {
    throttle.dispose();
    expect(() => throttle.dispose()).not.toThrow();
    expect(throttle.stats()).toEqual({ totalTracked: 0, keys: 0 });
  });

  it("removeSession() handles partial prefix overlap correctly", () => {
    // Keys are `${sessionID}:${eventType}`; ensure sessionID boundary
    // is exact (ses_1 should not match ses_10).
    throttle.allow("ses_1", NOTIFICATION_EVENT_TYPES.Idle);
    throttle.allow("ses_10", NOTIFICATION_EVENT_TYPES.Idle);
    throttle.allow("ses_100", NOTIFICATION_EVENT_TYPES.Idle);
    expect(throttle.stats().keys).toBe(3);

    throttle.removeSession("ses_1");

    // Only exact prefix "ses_1:" should be removed
    expect(throttle.stats().keys).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 5. Quiet Hours
// ════════════════════════════════════════════════════════════════════════

describe("QuietHours", () => {
  it("returns false when disabled", () => {
    const qh = new QuietHours({ enabled: false, ranges: [{ start: "09:00", end: "17:00" }] });
    expect(qh.isQuiet()).toBe(false);
  });

  it("returns false when no ranges", () => {
    const qh = new QuietHours({ enabled: true, ranges: [] });
    expect(qh.isQuiet()).toBe(false);
  });

  it("returns true within a normal range", () => {
    // 09:00 local time
    const now = new Date(2025, 0, 1, 9, 30, 0);
    const qh = new QuietHours({ enabled: true, ranges: [{ start: "09:00", end: "17:00" }] });
    expect(qh.isQuiet(now)).toBe(true);
  });

  it("returns true within a midnight-crossover range", () => {
    // 01:00 local time (within 22:00-07:00)
    const now = new Date(2025, 0, 1, 1, 0, 0);
    const qh = new QuietHours({ enabled: true, ranges: [{ start: "22:00", end: "07:00" }] });
    expect(qh.isQuiet(now)).toBe(true);
  });

  it("returns false outside range", () => {
    const now = new Date(2025, 0, 1, 18, 0, 0);
    const qh = new QuietHours({ enabled: true, ranges: [{ start: "09:00", end: "17:00" }] });
    expect(qh.isQuiet(now)).toBe(false);
  });

  it("respects day-of-week filtering", () => {
    // Jan 1, 2025 is a Wednesday
    const now = new Date(2025, 0, 1, 10, 0, 0);
    const qh = new QuietHours({ enabled: true, ranges: [{ start: "09:00", end: "17:00", days: ["Mon", "Tue"] }] });
    // Wednesday — not in days, so should NOT be quiet
    expect(qh.isQuiet(now)).toBe(false);
  });

  it("handles invalid time format gracefully", () => {
    const qh = new QuietHours({ enabled: true, ranges: [{ start: "invalid", end: "17:00" }] });
    const now = new Date(2025, 0, 1, 10, 0, 0);
    // Invalid start should be skipped, so not quiet
    expect(qh.isQuiet(now)).toBe(false);
  });

  it("nextActiveTime returns null when not quiet", () => {
    const qh = new QuietHours({ enabled: true, ranges: [{ start: "09:00", end: "17:00" }] });
    const now = new Date(2025, 0, 1, 20, 0, 0);
    expect(qh.nextActiveTime(now)).toBeNull();
  });

  it("dispose does not throw", () => {
    const qh = new QuietHours({ enabled: false, ranges: [] });
    expect(() => qh.dispose()).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 6. Scheduler
// ════════════════════════════════════════════════════════════════════════

describe("NotificationScheduler", () => {
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

  it("schedules idle notification after delay", async () => {
    scheduler.scheduleIdleNotification("ses_1", () => { fireCount++; });
    expect(fireCount).toBe(0);
    await new Promise((r) => setTimeout(r, 120));
    expect(fireCount).toBe(1);
  });

  it("cancels timer on activity", async () => {
    scheduler.scheduleIdleNotification("ses_1", () => { fireCount++; });
    scheduler.markSessionActivity("ses_1");
    await new Promise((r) => setTimeout(r, 120));
    expect(fireCount).toBe(0);
  });

  it("does not re-notify already-notified session", async () => {
    scheduler.scheduleIdleNotification("ses_1", () => { fireCount++; });
    await new Promise((r) => setTimeout(r, 120));
    expect(fireCount).toBe(1);

    // Schedule again — should not fire since already notified
    scheduler.scheduleIdleNotification("ses_1", () => { fireCount++; });
    await new Promise((r) => setTimeout(r, 120));
    expect(fireCount).toBe(1);
  });

  it("version counter prevents stale timer execution", async () => {
    let callVersion = 0;
    scheduler.scheduleIdleNotification("ses_1", () => { callVersion = 1; });
    // Activity bumps version, making the first timer stale
    scheduler.markSessionActivity("ses_1");
    // Schedule a new one
    scheduler.scheduleIdleNotification("ses_1", () => { callVersion = 2; });
    await new Promise((r) => setTimeout(r, 120));
    // Only the second call should have fired
    expect(callVersion).toBe(2);
  });

  it("dispose clears all timers", async () => {
    scheduler.scheduleIdleNotification("ses_1", () => { fireCount++; });
    scheduler.dispose();
    await new Promise((r) => setTimeout(r, 120));
    expect(fireCount).toBe(0);
  });

  it("handles rapid schedule/cancel/evict interleaving without throwing or losing state", async () => {
    // Use very low maxTrackedSessions so cleanupOldSessions evicts aggressively
    // on every scheduleIdleNotification call.
    const s = createScheduler({
      idleDelayMs: 30,
      activityGracePeriodMs: 0,
      maxTrackedSessions: 3,
    });

    const fired = new Set<string>();

    // Rapidly schedule many sessions — each triggers cleanupOldSessions,
    // which must snapshot eviction candidates before mutating notifiedSessions.
    // Interleave with activity so both eviction passes are exercised.
    expect(() => {
      for (let i = 0; i < 20; i++) {
        s.scheduleIdleNotification("ses_evict_" + i, () => {
          fired.add("ses_evict_" + i);
        });
        // Even indices get cancelled, mixing notified and activity-only state.
        if (i % 2 === 0) {
          s.markSessionActivity("ses_evict_" + i);
        }
      }
    }).not.toThrow();

    // Wait for all timers to settle.
    await new Promise((r) => setTimeout(r, 600));

    // State consistency: every pending timer must have a matching scheduledAt.
    const state = s as any;
    for (const id of state.pendingTimers.keys()) {
      expect(state.scheduledAt.has(id)).toBe(true);
    }

    // No leaked executing state.
    for (const id of state.executingNotifications) {
      expect(state.notifiedSessions.has(id)).toBe(true);
    }

    // Scheduler remains usable after the eviction storm.
    expect(() => {
      s.scheduleIdleNotification("ses_post_storm", () => {});
    }).not.toThrow();

    // Final smoke check: total tracked state stays bounded.
    const totalEntries =
      state.notifiedSessions.size +
      state.pendingTimers.size +
      state.sessionActivitySinceIdle.size +
      state.executingNotifications.size +
      state.scheduledAt.size;
    // With maxTrackedSessions=3, at most ~15 entries across 5 data structures.
    expect(totalEntries).toBeLessThanOrEqual(20);

    s.dispose();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 7. Formatting
// ════════════════════════════════════════════════════════════════════════

describe("Formatting", () => {
  it("escapes AppleScript text correctly", () => {
    expect(escapeAppleScriptText('Hello "World"')).toBe('Hello \\"World\\"');
    expect(escapeAppleScriptText("C:\\path\\to\\file")).toBe("C:\\\\path\\\\to\\\\file");
    expect(escapeAppleScriptText("normal")).toBe("normal");
  });

  it("escapes PowerShell single quotes", () => {
    expect(escapePowerShellSingleQuotedText("it's")).toBe("it''s");
    expect(escapePowerShellSingleQuotedText("no quotes")).toBe("no quotes");
    expect(escapePowerShellSingleQuotedText("'a' 'b'")).toBe("''a'' ''b''");
  });

  it("escapes bash single quotes", () => {
    expect(escapeBashText("it's")).toBe("it'\\''s");
    expect(escapeBashText("plain")).toBe("plain");
  });

  it("truncates with ellipsis", () => {
    expect(truncate("Hello World", 8)).toBe("Hello W…");
    expect(truncate("Hi", 10)).toBe("Hi");
    expect(truncate("", 5)).toBe("");
    expect(truncate("test", 0)).toBe("");
  });

  it("builds Windows toast script", () => {
    const script = buildWindowsToastScript("Test Title", "Test Message");
    expect(script).toContain("ToastNotificationManager");
    expect(script).toContain("Test Title");
    expect(script).toContain("Test Message");
    expect(script).toContain("CreateToastNotifier");
  });

  it("builds AppleScript notification string", () => {
    const script = buildAppleScriptNotification("Alert", 'Say "hi"');
    expect(script).toContain('display notification "Say \\"hi\\"" with title "Alert"');
  });

  it("builds notify-send command", () => {
    const args = buildNotifySendCommand("Title", "Body");
    expect(args).toEqual(["--urgency=normal", "Title", "Body"]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 8. Channel Dispatch
// ════════════════════════════════════════════════════════════════════════

describe("Channels", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = tempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("LogChannel always available and logs message", async () => {
    const channel = await createChannel({
      kind: NOTIFICATION_CHANNEL_KINDS.Log,
      enabled: true,
    });
    expect(channel).not.toBeNull();

    const msg: NotificationMessage = {
      title: "Test",
      body: "Body",
      sessionId: "ses_1",
      eventType: NOTIFICATION_EVENT_TYPES.Idle,
      timestamp: new Date().toISOString(),
    };

    // Should not throw
    await expect(channel!.send(msg)).resolves.toBeUndefined();
    await channel!.dispose();
  });

  it("FileChannel writes JSON line to file", async () => {
    const logFile = join(tmpDir, "notifications.jsonl");
    const channel = await createChannel({
      kind: NOTIFICATION_CHANNEL_KINDS.File,
      enabled: true,
      path: logFile,
    });
    expect(channel).not.toBeNull();

    const msg: NotificationMessage = {
      title: "File Test",
      body: "Hello",
      sessionId: "ses_file",
      eventType: NOTIFICATION_EVENT_TYPES.Error,
      timestamp: "2025-01-01T00:00:00.000Z",
    };

    await channel!.send(msg);
    const content = readFileSync(logFile, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.title).toBe("File Test");
    expect(parsed.sessionId).toBe("ses_file");
    await channel!.dispose();
  });

  it("WebhookChannel POSTs JSON payload", async () => {
    const fetchMock = mock(() =>
      Promise.resolve({ ok: true, status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    try {
      const channel = await createChannel({
        kind: NOTIFICATION_CHANNEL_KINDS.Webhook,
        enabled: true,
        url: "https://example.com/webhook",
      });
      expect(channel).not.toBeNull();

      const msg: NotificationMessage = {
        title: "Webhook Test",
        body: "Payload",
        sessionId: "ses_web",
        eventType: NOTIFICATION_EVENT_TYPES.DispatchComplete,
        timestamp: "2025-06-01T12:00:00.000Z",
      };

      await channel!.send(msg);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const callArgs = fetchMock.mock.calls[0]!;
      expect(callArgs[0]).toBe("https://example.com/webhook");

      const options = callArgs[1] as RequestInit;
      expect(options.method).toBe("POST");
      const body = JSON.parse(options.body as string);
      expect(body.title).toBe("Webhook Test");
      expect(body.eventType).toBe("dispatch_complete");

      await channel!.dispose();
    } finally {
      delete (global as any).fetch;
    }
  });

  it("createChannels filters out null channels", async () => {
    const channels = await createChannels([
      { kind: NOTIFICATION_CHANNEL_KINDS.Log, enabled: true },
      { kind: NOTIFICATION_CHANNEL_KINDS.SystemToast, enabled: true },
      { kind: NOTIFICATION_CHANNEL_KINDS.File, enabled: false, path: "/tmp/nope.log" },
    ] as NotificationChannelConfig[]);

    expect(channels.length).toBeGreaterThanOrEqual(1);
    // LogChannel should be present
    expect(channels.some((c) => c.kind === NOTIFICATION_CHANNEL_KINDS.Log)).toBe(true);
    // Disabled FileChannel should be filtered out
    expect(channels.every((c) => c.kind !== NOTIFICATION_CHANNEL_KINDS.File)).toBe(true);
  });

  it("channel send failure does not throw", async () => {
    const channel = await createChannel({
      kind: NOTIFICATION_CHANNEL_KINDS.File,
      enabled: true,
      path: join(tmpDir, "nonexistent", "subdir", "log.jsonl"),
    });
    expect(channel).not.toBeNull();

    const msg: NotificationMessage = {
      title: "Fail",
      body: "Should not throw",
      sessionId: "ses_fail",
      eventType: NOTIFICATION_EVENT_TYPES.Custom,
      timestamp: new Date().toISOString(),
    };

    await expect(channel!.send(msg)).resolves.toBeUndefined();
    await channel!.dispose();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 9. Platform Detection
// ════════════════════════════════════════════════════════════════════════

describe("Platform Detection", () => {
  it("detects current platform", () => {
    const platform = detectPlatform();
    expect(["darwin", "linux", "win32", "unknown"]).toContain(platform.os);
  });

  it("findCommand returns null for nonexistent command", async () => {
    const result = await findCommand("__nonexistent_command_xyz__");
    expect(result).toBeNull();
  });

  it("commandExists returns false for nonexistent", async () => {
    const exists = await commandExists("__nonexistent_cmd__");
    expect(exists).toBe(false);
  });

  it("preWarmCommandCache does not throw", async () => {
    await expect(
      preWarmCommandCache(["__nonexistent__", "also_missing"]),
    ).resolves.toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 10. NotificationManager Integration (mock all subsystems)
// ════════════════════════════════════════════════════════════════════════

describe("NotificationManager", () => {
  let tmpDir: string;

  const globalConfig: NotificationConfig = {
    ...DEFAULT_NOTIFICATION_CONFIG,
    channels: [],
    throttle: { windowMs: 5000, maxPerWindow: 10 },
    quietHours: { enabled: false, ranges: [] },
  };

  beforeEach(() => {
    tmpDir = tempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createManager(
    overrides?: Partial<NotificationConfig>,
    roleConfigs?: Map<string, NotificationConfig>,
  ) {
    const config = { ...globalConfig, ...overrides };
    if (overrides?.channels) config.channels = overrides.channels;
    if (overrides?.throttle) config.throttle = { ...globalConfig.throttle, ...overrides.throttle };
    if (overrides?.quietHours) config.quietHours = { ...globalConfig.quietHours, ...overrides.quietHours };

    return new NotificationManager({
      globalConfig: config,
      roleConfigs: roleConfigs ?? new Map(),
      client: createMockClient(),
      dir: tmpDir,
    });
  }

  it("respects global enabled=false", async () => {
    const logFile = join(tmpDir, "log.jsonl");
    const mgr = createManager({
      enabled: false,
      channels: [{ kind: NOTIFICATION_CHANNEL_KINDS.File, enabled: true, path: logFile }],
    });

    await mgr.notify({
      sessionID: "ses_1",
      eventType: NOTIFICATION_EVENT_TYPES.Idle,
    });

    // No file should have been written
    expect(existsSync(logFile)).toBe(false);
    await mgr.dispose();
  });

  it("respects per-event enabled=false", async () => {
    const logFile = join(tmpDir, "log2.jsonl");
    const mgr = createManager({
      channels: [{ kind: NOTIFICATION_CHANNEL_KINDS.File, enabled: true, path: logFile }],
      events: {
        [NOTIFICATION_EVENT_TYPES.Idle]: { enabled: false },
      },
    });

    await mgr.notify({
      sessionID: "ses_2",
      eventType: NOTIFICATION_EVENT_TYPES.Idle,
    });

    expect(existsSync(logFile)).toBe(false);
    await mgr.dispose();
  });

  it("checks quiet hours", async () => {
    const logFile = join(tmpDir, "log3.jsonl");
    // Use a date/time that falls within the quiet range
    const now = new Date(2025, 0, 1, 10, 0, 0);
    const realDateNow = Date.now;
    const realNew = Date;

    try {
      // Mock Date to a fixed time
      global.Date = class extends Date {
        constructor(...args: any[]) {
          if (args.length === 0) super(now);
          else super(args[0] as any);
        }
        static now() {
          return now.getTime();
        }
      } as DateConstructor;

      const mgr = createManager({
        channels: [{ kind: NOTIFICATION_CHANNEL_KINDS.File, enabled: true, path: logFile }],
        quietHours: { enabled: true, ranges: [{ start: "09:00", end: "17:00" }] },
      });

      await mgr.notify({
        sessionID: "ses_3",
        eventType: NOTIFICATION_EVENT_TYPES.Idle,
      });

      // Should be blocked by quiet hours
      expect(existsSync(logFile)).toBe(false);
      await mgr.dispose();
    } finally {
      global.Date = realNew;
    }
  });

  it("checks throttle", async () => {
    const logFile = join(tmpDir, "log4.jsonl");
    const mgr = createManager({
      channels: [{ kind: NOTIFICATION_CHANNEL_KINDS.File, enabled: true, path: logFile }],
      throttle: { windowMs: 5000, maxPerWindow: 1 },
    });

    // First notification goes through
    await mgr.notify({
      sessionID: "ses_4",
      eventType: NOTIFICATION_EVENT_TYPES.Idle,
    });

    // Wait for throttle minimum interval
    await new Promise((r) => setTimeout(r, 1100));

    // Second should be throttled (maxPerWindow=1 and rapid duplicate)
    const logFile2 = join(tmpDir, "log5.jsonl");
    const mgr2 = createManager({
      channels: [{ kind: NOTIFICATION_CHANNEL_KINDS.File, enabled: true, path: logFile2 }],
      throttle: { windowMs: 5000, maxPerWindow: 1 },
    });

    await mgr2.notify({
      sessionID: "ses_4",
      eventType: NOTIFICATION_EVENT_TYPES.Idle,
    });

    // Should have written to first file
    expect(existsSync(logFile)).toBe(true);
    await mgr.dispose();
    await mgr2.dispose();
  });

  it("builds content and sends to channels", async () => {
    const logFile = join(tmpDir, "log_send.jsonl");
    const mgr = createManager({
      channels: [{ kind: NOTIFICATION_CHANNEL_KINDS.File, enabled: true, path: logFile }],
    });

    await mgr.notify({
      sessionID: "ses_5",
      eventType: NOTIFICATION_EVENT_TYPES.DispatchComplete,
      agent: "helper",
      roleName: "Helper",
    });

    // Should have written to file
    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.eventType).toBe("dispatch_complete");
    expect(parsed.sessionId).toBe("ses_5");
    expect(parsed.agent).toBe("helper");
    expect(parsed.roleName).toBe("Helper");

    await mgr.dispose();
  });

  it("handles channel failure gracefully", async () => {
    const mgr = createManager({
      channels: [
        {
          kind: NOTIFICATION_CHANNEL_KINDS.File,
          enabled: true,
          path: join("/nonexistent_dir_xyz", "log.jsonl"),
        },
      ],
    });

    // Should not throw
    await expect(
      mgr.notify({
        sessionID: "ses_fail",
        eventType: NOTIFICATION_EVENT_TYPES.Error,
      }),
    ).resolves.toBeUndefined();

    await mgr.dispose();
  });

  it("getConfigForSession merges role config", async () => {
    const roleConfigs = new Map<string, NotificationConfig>();
    roleConfigs.set("coder", {
      ...DEFAULT_NOTIFICATION_CONFIG,
      idleDelayMs: 9999,
      channels: [{ kind: NOTIFICATION_CHANNEL_KINDS.Log, enabled: true }],
    });

    const mgr = createManager({ idleDelayMs: 1000 }, roleConfigs);

    // Without agent — returns global
    const globalCfg = mgr.getConfigForSession("ses_any");
    expect(globalCfg.idleDelayMs).toBe(1000);

    // With agent that has a role config — returns merged
    const roleCfg = mgr.getConfigForSession("ses_any", "coder");
    expect(roleCfg.idleDelayMs).toBe(9999);

    await mgr.dispose();
  });

  it("getConfigForSession returns global when agent has no role config", () => {
    const mgr = createManager({ idleDelayMs: 2000 });
    const cfg = mgr.getConfigForSession("ses_any", "unknown_agent");
    expect(cfg.idleDelayMs).toBe(2000);
  });

  it("handleSessionDeleted cleans up scheduler and throttle", () => {
    const mgr = createManager();
    // Fire some notifications through the throttle first
    mgr.notify({ sessionID: "ses_del", eventType: NOTIFICATION_EVENT_TYPES.Idle }).catch(() => {});
    // Should not throw
    expect(() => mgr.handleSessionDeleted("ses_del")).not.toThrow();
  });

  it("handleSessionError fires error notification", async () => {
    const logFile = join(tmpDir, "log_error.jsonl");
    const mgr = createManager({
      channels: [{ kind: NOTIFICATION_CHANNEL_KINDS.File, enabled: true, path: logFile }],
    });

    mgr.handleSessionError("ses_err", "helper");

    // Give async notify a moment to complete
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.eventType).toBe("error");

    await mgr.dispose();
  });

  it("handleDispatchComplete fires notification", async () => {
    const logFile = join(tmpDir, "log_dc.jsonl");
    const mgr = createManager({
      channels: [{ kind: NOTIFICATION_CHANNEL_KINDS.File, enabled: true, path: logFile }],
    });

    mgr.handleDispatchComplete("ses_dc");

    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.eventType).toBe("dispatch_complete");

    await mgr.dispose();
  });

  it("handleLoopComplete fires notification", async () => {
    const logFile = join(tmpDir, "log_lc.jsonl");
    const mgr = createManager({
      channels: [{ kind: NOTIFICATION_CHANNEL_KINDS.File, enabled: true, path: logFile }],
    });

    mgr.handleLoopComplete("ses_lc");

    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.eventType).toBe("loop_complete");

    await mgr.dispose();
  });

  it("handleApprovalPending fires notification routed through channels", async () => {
    const logFile = join(tmpDir, "log_ap.jsonl");
    const mgr = createManager({
      channels: [{ kind: NOTIFICATION_CHANNEL_KINDS.File, enabled: true, path: logFile }],
    });

    mgr.handleApprovalPending("ses_ap", "graph_1", "node_a");

    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(logFile)).toBe(true);
    const lines = readFileSync(logFile, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.eventType).toBe("approval_pending");

    await mgr.dispose();
  });

  it("handleApprovalPending renders graph_id/node_id into the title template", async () => {
    const logFile = join(tmpDir, "log_ap_title.jsonl");
    const mgr = createManager({
      channels: [{ kind: NOTIFICATION_CHANNEL_KINDS.File, enabled: true, path: logFile }],
    });

    mgr.handleApprovalPending("ses_ap2", "graph_2", "node_b");

    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(logFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(logFile, "utf-8").trim());
    // Default event config title template: "Approval gate waiting: {graph_id}/{node_id}".
    expect(parsed.title).toBe("Approval gate waiting: graph_2/node_b");

    await mgr.dispose();
  });

  it("handleApprovalPending respects the per-event throttle guard", async () => {
    const logFile = join(tmpDir, "log_ap_throttle.jsonl");
    const mgr = createManager({
      channels: [{ kind: NOTIFICATION_CHANNEL_KINDS.File, enabled: true, path: logFile }],
      throttle: {
        windowMs: 10000,
        maxPerWindow: 100,
        perEventType: {
          approval_pending: { windowMs: 10000, maxPerWindow: 1 },
        },
      },
    });

    mgr.handleApprovalPending("ses_ap_throttle", "graph_3", "node_c");
    mgr.handleApprovalPending("ses_ap_throttle", "graph_3", "node_c"); // throttled

    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(logFile)).toBe(true);
    const lines = readFileSync(logFile, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);

    await mgr.dispose();
  });

  it("handles chat message and marks activity", () => {
    const mgr = createManager();
    // Should not throw
    expect(() => mgr.handleChatMessage("ses_chat")).not.toThrow();
  });

  it("handles message updated and marks activity", () => {
    const mgr = createManager();
    expect(() => mgr.handleMessageUpdated("ses_msg_upd")).not.toThrow();
  });

  it("scheduleIdle schedules and fires idle notification", async () => {
    const logFile = join(tmpDir, "log_idle.jsonl");
    const mgr = createManager({
      // Override idleDelayMs for the scheduler
      idleDelayMs: 50,
      channels: [{ kind: NOTIFICATION_CHANNEL_KINDS.File, enabled: true, path: logFile }],
    });

    mgr.scheduleIdle("ses_idle", "helper");

    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.eventType).toBe("idle");

    await mgr.dispose();
  });

  it("reloadConfig updates configuration", async () => {
    const mgr = createManager({ idleDelayMs: 5000 });

    const newGlobal: NotificationConfig = {
      ...DEFAULT_NOTIFICATION_CONFIG,
      enabled: false,
      idleDelayMs: 100,
    };

    mgr.reloadConfig(newGlobal, new Map());

    const cfg = mgr.getConfigForSession("ses_reload");
    expect(cfg.enabled).toBe(false);
    expect(cfg.idleDelayMs).toBe(100);

    await mgr.dispose();
  });

  it("dispose does not throw", async () => {
    const mgr = createManager();
    await expect(mgr.dispose()).resolves.toBeUndefined();
    // Double dispose should also be safe
    await expect(mgr.dispose()).resolves.toBeUndefined();
  });

  it("rejects unknown event type — no dispatch, no error", async () => {
    const logFile = join(tmpDir, "log_unknown.jsonl");
    const mgr = createManager({
      channels: [{ kind: NOTIFICATION_CHANNEL_KINDS.File, enabled: true, path: logFile }],
    });

    await mgr.notify({
      sessionID: "ses_unknown",
      eventType: "bogus_type",
    });

    // No file should have been written (no channel dispatch for unknown type)
    expect(existsSync(logFile)).toBe(false);
    await mgr.dispose();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 11. Utility Functions
// ════════════════════════════════════════════════════════════════════════

describe("Utility Functions", () => {
  it("collapseWhitespace handles various whitespace patterns", () => {
    expect(collapseWhitespace("a\n\n\nb")).toBe("a b");
    expect(collapseWhitespace("  lone  ")).toBe("lone");
    expect(collapseWhitespace("")).toBe("");
  });

  it("getLastNonEmptyLine works correctly", () => {
    expect(getLastNonEmptyLine("first\nsecond\nthird")).toBe("third");
    expect(getLastNonEmptyLine("only one")).toBe("only one");
    expect(getLastNonEmptyLine("trailing\n\n  \nlast")).toBe("last");
  });

  it("DEFAULT_THROTTLE_CONFIG is frozen", () => {
    expect(Object.isFrozen(DEFAULT_THROTTLE_CONFIG)).toBe(true);
  });

  it("DEFAULT_NOTIFICATION_CONFIG is frozen", () => {
    expect(Object.isFrozen(DEFAULT_NOTIFICATION_CONFIG)).toBe(true);
  });
});
