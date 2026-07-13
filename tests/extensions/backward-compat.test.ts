import { describe, it, expect } from "bun:test";
import { KNOWN_CONDITIONS } from "../../src/function/conditions";
import { GRAPH_TEMPLATE_VALUES } from "../../src/constants";
import { KNOWN_STRATEGIES } from "../../src/recovery/config";
import { NOTIFICATION_CHANNEL_KINDS, NOTIFICATION_EVENT_TYPES } from "../../src/notifications/types";

describe("Backward Compatibility", () => {
  it("KNOWN_CONDITIONS has at least 7 built-in conditions", () => {
    expect(KNOWN_CONDITIONS.size).toBeGreaterThanOrEqual(7);
  });

  it("GRAPH_TEMPLATE_VALUES has at least 3 built-in topologies", () => {
    expect(GRAPH_TEMPLATE_VALUES.size).toBeGreaterThanOrEqual(3);
  });

  it("KNOWN_STRATEGIES has at least 7 built-in strategies", () => {
    expect(KNOWN_STRATEGIES.size).toBeGreaterThanOrEqual(7);
  });

  it("NOTIFICATION_CHANNEL_KINDS has 6 built-in channel kinds", () => {
    const values = Object.values(NOTIFICATION_CHANNEL_KINDS);
    expect(values.length).toBe(6);
    expect(values).toContain("system_toast");
    expect(values).toContain("sound");
    expect(values).toContain("custom_command");
    expect(values).toContain("webhook");
    expect(values).toContain("file");
    expect(values).toContain("log");
  });

  it("NOTIFICATION_EVENT_TYPES has 9 built-in event types", () => {
    const values = Object.values(NOTIFICATION_EVENT_TYPES);
    expect(values.length).toBe(9);
    expect(values).toContain("idle");
    expect(values).toContain("question");
    expect(values).toContain("error");
    expect(values).toContain("dispatch_complete");
    expect(values).toContain("loop_complete");
    expect(values).toContain("session_deleted");
    expect(values).toContain("custom");
  });

  it("empty extensions config does not crash ExtensionRegistry", async () => {
    const { ExtensionRegistry } = await import("../../src/extensions/registry");
    const registry = new ExtensionRegistry();
    await registry.loadExtensions(undefined, "/tmp");
    await registry.loadExtensions(null, "/tmp");
    await registry.loadExtensions({}, "/tmp");
    await registry.dispose();
  });
});
