// ── Config Parsers: Unit Tests ──────────────────────────────────────────
//
// Tests every exported function from src/notifications/config-parsers.ts:
//   asBoolean, asNumber, isObject, parseQuietHoursRange, parseQuietHours,
//   parseThrottle, parseChannelConfig, parseEventConfig, parseEventConfigs
//
// Uses bun:test syntax – describe/it/expect from "bun:test".

import { describe, it, expect } from "bun:test";
import {
  asBoolean,
  asNumber,
  isObject,
  parseQuietHoursRange,
  parseQuietHours,
  parseThrottle,
  parseChannelConfig,
  parseEventConfig,
  parseEventConfigs,
} from "../../src/notifications/config-parsers";
import { NOTIFICATION_CHANNEL_KINDS, type LogChannelConfig } from "../../src/notifications/types";
import {
  DEFAULT_NOTIFICATION_THROTTLE_WINDOW_MS,
  DEFAULT_NOTIFICATION_MAX_PER_WINDOW,
} from "../../src/constants";

// ── asBoolean ───────────────────────────────────────────────────────────

describe("asBoolean", () => {
  it("returns true for boolean true", () => {
    expect(asBoolean(true)).toBe(true);
  });

  it("returns false for boolean false", () => {
    expect(asBoolean(false)).toBe(false);
  });

  it('returns true for string "true"', () => {
    expect(asBoolean("true")).toBe(true);
  });

  it('returns false for string "false"', () => {
    expect(asBoolean("false")).toBe(false);
  });

  it("is case-insensitive for string true", () => {
    expect(asBoolean("True")).toBe(true);
    expect(asBoolean("TRUE")).toBe(true);
    expect(asBoolean("  true  ")).toBe(true);
  });

  it("returns undefined for unrecognized strings", () => {
    expect(asBoolean("yes")).toBeUndefined();
    expect(asBoolean("1")).toBeUndefined();
    expect(asBoolean("")).toBeUndefined();
  });

  it("returns undefined for non-boolean, non-string values", () => {
    expect(asBoolean(1)).toBeUndefined();
    expect(asBoolean(null)).toBeUndefined();
    expect(asBoolean(undefined)).toBeUndefined();
    expect(asBoolean({})).toBeUndefined();
    expect(asBoolean([])).toBeUndefined();
  });
});

// ── asNumber ────────────────────────────────────────────────────────────

describe("asNumber", () => {
  it("returns the value for a numeric input", () => {
    expect(asNumber(42)).toBe(42);
    expect(asNumber(0)).toBe(0);
    expect(asNumber(-1)).toBe(-1);
    expect(asNumber(3.14)).toBe(3.14);
  });

  it("parses a string containing a valid number", () => {
    expect(asNumber("42")).toBe(42);
    expect(asNumber("3.14")).toBe(3.14);
    expect(asNumber("-7")).toBe(-7);
    expect(asNumber("  99  ")).toBe(99);
  });

  it("returns undefined for an invalid numeric string", () => {
    expect(asNumber("abc")).toBeUndefined();
    expect(asNumber("12abc")).toBeUndefined();
    expect(asNumber("")).toBeUndefined();
  });

  it("returns undefined for non-number, non-string values", () => {
    expect(asNumber(null)).toBeUndefined();
    expect(asNumber(undefined)).toBeUndefined();
    expect(asNumber({})).toBeUndefined();
    expect(asNumber([])).toBeUndefined();
    expect(asNumber(true)).toBeUndefined();
  });
});

// ── isObject ────────────────────────────────────────────────────────────

describe("isObject", () => {
  it("returns true for a plain object", () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ a: 1 })).toBe(true);
  });

  it("returns false for null", () => {
    expect(isObject(null)).toBe(false);
  });

  it("returns false for an array", () => {
    expect(isObject([])).toBe(false);
    expect(isObject([1, 2])).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isObject("hello")).toBe(false);
  });

  it("returns false for a number", () => {
    expect(isObject(42)).toBe(false);
  });

  it("returns false for boolean", () => {
    expect(isObject(true)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isObject(undefined)).toBe(false);
  });
});

// ── parseQuietHoursRange ────────────────────────────────────────────────

describe("parseQuietHoursRange", () => {
  it("parses a valid range with start and end", () => {
    expect(parseQuietHoursRange({ start: "22:00", end: "08:00" })).toEqual({
      start: "22:00",
      end: "08:00",
    });
  });

  it("parses a valid range with optional days", () => {
    expect(
      parseQuietHoursRange({
        start: "22:00",
        end: "08:00",
        days: ["Mon", "Tue", "Wed"],
      }),
    ).toEqual({
      start: "22:00",
      end: "08:00",
      days: ["Mon", "Tue", "Wed"],
    });
  });

  it("skips days that are not an array of strings", () => {
    const result = parseQuietHoursRange({
      start: "22:00",
      end: "08:00",
      days: "Mon",
    });
    expect(result).toEqual({ start: "22:00", end: "08:00" });
    expect(result!.days).toBeUndefined();
  });

  it("returns null for a non-object input", () => {
    expect(parseQuietHoursRange(null)).toBeNull();
    expect(parseQuietHoursRange("string")).toBeNull();
    expect(parseQuietHoursRange(42)).toBeNull();
  });

  it("returns null when start or end is missing", () => {
    expect(parseQuietHoursRange({ start: "22:00" })).toBeNull();
    expect(parseQuietHoursRange({ end: "08:00" })).toBeNull();
    expect(parseQuietHoursRange({})).toBeNull();
  });

  it("returns null when start or end is not a string", () => {
    expect(parseQuietHoursRange({ start: 22, end: "08:00" })).toBeNull();
    expect(parseQuietHoursRange({ start: "22:00", end: 8 })).toBeNull();
  });
});

// ── parseQuietHours ─────────────────────────────────────────────────────

describe("parseQuietHours", () => {
  it("returns undefined for non-object input", () => {
    expect(parseQuietHours(null)).toBeUndefined();
    expect(parseQuietHours("not-an-object")).toBeUndefined();
  });

  it("defaults enabled to false when missing", () => {
    const result = parseQuietHours({});
    expect(result).toBeDefined();
    expect(result!.enabled).toBe(false);
  });

  it("parses enabled as boolean", () => {
    const enabled = parseQuietHours({ enabled: true });
    expect(enabled!.enabled).toBe(true);

    const disabled = parseQuietHours({ enabled: false });
    expect(disabled!.enabled).toBe(false);
  });

  it("parses timezone when present", () => {
    const result = parseQuietHours({
      enabled: true,
      timezone: "America/New_York",
    });
    expect(result!.timezone).toBe("America/New_York");
  });

  it("leaves timezone undefined when not a string", () => {
    const result = parseQuietHours({ enabled: true, timezone: 123 });
    expect(result!.timezone).toBeUndefined();
  });

  it("parses ranges from valid array", () => {
    const result = parseQuietHours({
      enabled: true,
      ranges: [
        { start: "22:00", end: "08:00" },
        { start: "12:00", end: "13:00", days: ["Mon"] },
      ],
    });
    expect(result!.ranges).toHaveLength(2);
    expect(result!.ranges[0]).toEqual({ start: "22:00", end: "08:00" });
    expect(result!.ranges[1]).toEqual({
      start: "12:00",
      end: "13:00",
      days: ["Mon"],
    });
  });

  it("defaults to empty ranges when missing or invalid", () => {
    const noRanges = parseQuietHours({ enabled: true });
    expect(noRanges!.ranges).toEqual([]);

    const nonArray = parseQuietHours({ enabled: true, ranges: "invalid" });
    expect(nonArray!.ranges).toEqual([]);
  });

  it("filters out invalid range entries", () => {
    const result = parseQuietHours({
      enabled: true,
      ranges: [
        { start: "22:00", end: "08:00" },
        { start: "22:00" }, // missing end — invalid
        "not-an-object", // not an object — invalid
      ],
    });
    expect(result!.ranges).toHaveLength(1);
    expect(result!.ranges[0]).toEqual({ start: "22:00", end: "08:00" });
  });
});

// ── parseThrottle ───────────────────────────────────────────────────────

describe("parseThrottle", () => {
  it("returns undefined for non-object input", () => {
    expect(parseThrottle(null)).toBeUndefined();
    expect(parseThrottle("string")).toBeUndefined();
  });

  it("uses defaults when only windowMs is provided", () => {
    const result = parseThrottle({ windowMs: 5000 });
    expect(result!.windowMs).toBe(5000);
    expect(result!.maxPerWindow).toBe(DEFAULT_NOTIFICATION_MAX_PER_WINDOW);
  });

  it("uses defaults when only maxPerWindow is provided", () => {
    const result = parseThrottle({ maxPerWindow: 10 });
    expect(result!.maxPerWindow).toBe(10);
    expect(result!.windowMs).toBe(DEFAULT_NOTIFICATION_THROTTLE_WINDOW_MS);
  });

  it("returns undefined when neither windowMs nor maxPerWindow is provided", () => {
    expect(parseThrottle({})).toBeUndefined();
    expect(parseThrottle({ unrelatedField: "x" })).toBeUndefined();
  });

  it("parses perEventType overrides", () => {
    const result = parseThrottle({
      windowMs: 5000,
      maxPerWindow: 10,
      perEventType: {
        error: { windowMs: 1000, maxPerWindow: 5 },
        idle: { windowMs: 999 },
      },
    });
    expect(result!.perEventType).toBeDefined();
    expect(result!.perEventType!["error"]).toEqual({
      windowMs: 1000,
      maxPerWindow: 5,
    });
    // idle only provides windowMs, maxPerWindow should get default
    expect(result!.perEventType!["idle"]).toEqual({
      windowMs: 999,
      maxPerWindow: DEFAULT_NOTIFICATION_MAX_PER_WINDOW,
    });
  });

  it("ignores perEventType entries with no valid numeric fields", () => {
    const result = parseThrottle({
      windowMs: 5000,
      perEventType: {
        error: { unrelated: "x" },
      },
    });
    // perEventType has no valid entries, so the key should not appear
    expect(result!.perEventType).toBeUndefined();
  });

  it("ignores perEventType when not an object", () => {
    const result = parseThrottle({
      windowMs: 5000,
      perEventType: "not-an-object",
    });
    expect(result!.perEventType).toBeUndefined();
  });

  it("accepts string numeric values for windowMs and maxPerWindow", () => {
    const result = parseThrottle({ windowMs: "3000", maxPerWindow: "5" });
    expect(result!.windowMs).toBe(3000);
    expect(result!.maxPerWindow).toBe(5);
  });
});

// ── parseChannelConfig ──────────────────────────────────────────────────

describe("parseChannelConfig", () => {
  it("returns null for non-object input", () => {
    expect(parseChannelConfig(null)).toBeNull();
    expect(parseChannelConfig("string")).toBeNull();
  });

  it("returns null when kind is missing or not a string", () => {
    expect(parseChannelConfig({})).toBeNull();
    expect(parseChannelConfig({ kind: 123 })).toBeNull();
  });

  it("parses a SystemToast channel (kind 0)", () => {
    const result = parseChannelConfig({
      kind: NOTIFICATION_CHANNEL_KINDS.SystemToast,
    });
    expect(result).toEqual({
      kind: NOTIFICATION_CHANNEL_KINDS.SystemToast,
      enabled: true,
    });
  });

  it("parses a SystemToast channel with enabled: false", () => {
    const result = parseChannelConfig({
      kind: NOTIFICATION_CHANNEL_KINDS.SystemToast,
      enabled: false,
    });
    expect(result!.enabled).toBe(false);
  });

  it("parses a Sound channel with soundPath", () => {
    const result = parseChannelConfig({
      kind: NOTIFICATION_CHANNEL_KINDS.Sound,
      soundPath: "/usr/share/sounds/bell.wav",
    });
    expect(result).toEqual({
      kind: NOTIFICATION_CHANNEL_KINDS.Sound,
      enabled: true,
      soundPath: "/usr/share/sounds/bell.wav",
    });
  });

  it("parses a Sound channel defaulting soundPath to empty string", () => {
    const result = parseChannelConfig({
      kind: NOTIFICATION_CHANNEL_KINDS.Sound,
    });
    expect(result).toEqual({
      kind: NOTIFICATION_CHANNEL_KINDS.Sound,
      enabled: true,
      soundPath: "",
    });
  });

  it("parses a CustomCommand channel with all fields", () => {
    const result = parseChannelConfig({
      kind: NOTIFICATION_CHANNEL_KINDS.CustomCommand,
      command: "/usr/local/bin/notify",
      passAsStdin: true,
      env: { KEY: "value" },
    });
    expect(result).toEqual({
      kind: NOTIFICATION_CHANNEL_KINDS.CustomCommand,
      enabled: true,
      command: "/usr/local/bin/notify",
      passAsStdin: true,
      env: { KEY: "value" },
    });
  });

  it("parses a CustomCommand channel defaulting missing fields", () => {
    const result = parseChannelConfig({
      kind: NOTIFICATION_CHANNEL_KINDS.CustomCommand,
    });
    expect(result).toEqual({
      kind: NOTIFICATION_CHANNEL_KINDS.CustomCommand,
      enabled: true,
      command: "",
      passAsStdin: undefined,
      env: undefined,
    });
  });

  it("parses a Webhook channel with all fields", () => {
    const result = parseChannelConfig({
      kind: NOTIFICATION_CHANNEL_KINDS.Webhook,
      url: "https://hooks.example.com/hook",
      headers: { Authorization: "Bearer tok" },
      timeoutMs: 3000,
    });
    expect(result).toEqual({
      kind: NOTIFICATION_CHANNEL_KINDS.Webhook,
      enabled: true,
      url: "https://hooks.example.com/hook",
      headers: { Authorization: "Bearer tok" },
      timeoutMs: 3000,
    });
  });

  it("parses a Webhook channel defaulting missing fields", () => {
    const result = parseChannelConfig({
      kind: NOTIFICATION_CHANNEL_KINDS.Webhook,
    });
    expect(result).toEqual({
      kind: NOTIFICATION_CHANNEL_KINDS.Webhook,
      enabled: true,
      url: "",
      headers: undefined,
      timeoutMs: undefined,
    });
  });

  it("parses a File channel", () => {
    const result = parseChannelConfig({
      kind: NOTIFICATION_CHANNEL_KINDS.File,
      path: "/tmp/notifications.log",
    });
    expect(result).toEqual({
      kind: NOTIFICATION_CHANNEL_KINDS.File,
      enabled: true,
      path: "/tmp/notifications.log",
    });
  });

  it("parses a File channel defaulting path to empty string", () => {
    const result = parseChannelConfig({
      kind: NOTIFICATION_CHANNEL_KINDS.File,
    });
    expect(result).toEqual({
      kind: NOTIFICATION_CHANNEL_KINDS.File,
      enabled: true,
      path: "",
    });
  });

  it("parses a Log channel with valid level", () => {
    const result = parseChannelConfig({
      kind: NOTIFICATION_CHANNEL_KINDS.Log,
      level: "warn",
    });
    expect(result).toEqual({
      kind: NOTIFICATION_CHANNEL_KINDS.Log,
      enabled: true,
      level: "warn",
    });
  });

  it("parses a Log channel with invalid level (sets to undefined)", () => {
    const result = parseChannelConfig({
      kind: NOTIFICATION_CHANNEL_KINDS.Log,
      level: "critical",
    });
    const logResult = result as LogChannelConfig;
    expect(logResult.level).toBeUndefined();
  });

  it("parses a Log channel defaulting level to undefined", () => {
    const result = parseChannelConfig({
      kind: NOTIFICATION_CHANNEL_KINDS.Log,
    });
    const logResult = result as LogChannelConfig;
    expect(logResult.level).toBeUndefined();
  });

  it("returns null for an unknown channel kind", () => {
    const result = parseChannelConfig({
      kind: "unknown_kind",
      enabled: true,
    });
    expect(result).toBeNull();
  });
});

// ── parseEventConfig ────────────────────────────────────────────────────

describe("parseEventConfig", () => {
  it("returns undefined for non-object input", () => {
    expect(parseEventConfig(null)).toBeUndefined();
    expect(parseEventConfig(42)).toBeUndefined();
  });

  it("parses a full event config with all fields", () => {
    const result = parseEventConfig({
      enabled: true,
      channels: [
        { kind: NOTIFICATION_CHANNEL_KINDS.SystemToast },
        { kind: NOTIFICATION_CHANNEL_KINDS.Log, level: "error" },
      ],
      titleTemplate: "{{title}}",
      messageTemplate: "{{body}}",
      throttle: { windowMs: 1000 },
      quietHoursOverride: { enabled: true },
    });
    expect(result).toBeDefined();
    expect(result!.enabled).toBe(true);
    expect(result!.channels).toHaveLength(2);
    expect(result!.titleTemplate).toBe("{{title}}");
    expect(result!.messageTemplate).toBe("{{body}}");
    expect(result!.throttle).toBeDefined();
    expect(result!.throttle!.windowMs).toBe(1000);
    expect(result!.quietHoursOverride).toBeDefined();
    expect(result!.quietHoursOverride!.enabled).toBe(true);
  });

  it("returns undefined for an empty object (no meaningful fields)", () => {
    expect(parseEventConfig({})).toBeUndefined();
  });

  it("parses only the enabled field", () => {
    const result = parseEventConfig({ enabled: false });
    expect(result!.enabled).toBe(false);
    expect(result!.channels).toBeUndefined();
    expect(result!.titleTemplate).toBeUndefined();
  });

  it("filters out invalid channel entries", () => {
    const result = parseEventConfig({
      enabled: true,
      channels: [
        { kind: NOTIFICATION_CHANNEL_KINDS.SystemToast },
        { kind: "bogus" },
        null,
      ],
    });
    expect(result!.channels).toHaveLength(1);
    expect(result!.channels![0].kind).toBe(
      NOTIFICATION_CHANNEL_KINDS.SystemToast,
    );
  });

  it("ignores channels that is not an array", () => {
    const result = parseEventConfig({
      enabled: true,
      channels: "not-an-array",
    });
    expect(result!.channels).toBeUndefined();
  });

  it("parses throttle even when quietHoursOverride is invalid", () => {
    const result = parseEventConfig({
      throttle: { windowMs: 2000 },
      quietHoursOverride: "not-an-object",
    });
    expect(result).toBeDefined();
    expect(result!.throttle!.windowMs).toBe(2000);
    expect(result!.quietHoursOverride).toBeUndefined();
  });
});

// ── parseEventConfigs ───────────────────────────────────────────────────

describe("parseEventConfigs", () => {
  const validTypes = ["idle", "error", "question"];

  it("returns undefined for non-object input", () => {
    expect(parseEventConfigs(null, validTypes)).toBeUndefined();
    expect(parseEventConfigs("string", validTypes)).toBeUndefined();
  });

  it("parses valid event configs", () => {
    const result = parseEventConfigs(
      {
        idle: { enabled: true },
        error: { enabled: false, titleTemplate: "Error: {{title}}" },
      },
      validTypes,
    );
    expect(result).toBeDefined();
    expect(result!["idle"]).toBeDefined();
    expect(result!["idle"]!.enabled).toBe(true);
    expect(result!["error"]).toBeDefined();
    expect(result!["error"]!.enabled).toBe(false);
    expect(result!["error"]!.titleTemplate).toBe("Error: {{title}}");
  });

  it("skips unknown event types with a warning", () => {
    const result = parseEventConfigs(
      {
        idle: { enabled: true },
        unknown_event_type: { enabled: true },
      },
      validTypes,
    );
    expect(result).toBeDefined();
    // Only "idle" should be in the result
    expect(Object.keys(result!)).toEqual(["idle"]);
  });

  it("skips entries that fail to parse (empty objects)", () => {
    const result = parseEventConfigs(
      {
        idle: { enabled: true },
        error: {},
      },
      validTypes,
    );
    expect(result).toBeDefined();
    expect(Object.keys(result!)).toEqual(["idle"]);
  });

  it("returns undefined when no valid events remain", () => {
    const result = parseEventConfigs(
      {
        unknown: { enabled: true },
      },
      validTypes,
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when all events are empty configs", () => {
    const result = parseEventConfigs(
      {
        idle: {},
        error: {},
      },
      validTypes,
    );
    expect(result).toBeUndefined();
  });
});
