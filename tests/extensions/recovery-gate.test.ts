import { describe, it, expect } from "bun:test";
import { KNOWN_STRATEGIES, addKnownStrategy } from "../../src/recovery/config";

describe("Recovery Strategies YAML Gate", () => {
  it("built-in strategies exist in KNOWN_STRATEGIES", () => {
    expect(KNOWN_STRATEGIES.has("retry")).toBe(true);
    expect(KNOWN_STRATEGIES.has("compact")).toBe(true);
    expect(KNOWN_STRATEGIES.has("fallback_model")).toBe(true);
    expect(KNOWN_STRATEGIES.has("abort")).toBe(true);
    expect(KNOWN_STRATEGIES.has("remind_and_retry")).toBe(true);
    expect(KNOWN_STRATEGIES.has("truncate")).toBe(true);
    expect(KNOWN_STRATEGIES.has("summarize")).toBe(true);
  });

  it("addKnownStrategy adds a custom strategy name", () => {
    addKnownStrategy("my_custom_strategy");
    expect(KNOWN_STRATEGIES.has("my_custom_strategy")).toBe(true);
  });

  it("KNOWN_STRATEGIES size is at least 7 (backward compat)", () => {
    expect(KNOWN_STRATEGIES.size).toBeGreaterThanOrEqual(7);
  });
});
