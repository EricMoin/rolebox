import { describe, it, expect } from "bun:test";
import { SERVICE_NAMES, type ServiceName } from "../../src/core/service-names.ts";

describe("SERVICE_NAMES", () => {
  it("keeps the historic service-name strings that appear in logs and bus events", () => {
    expect(Object.values(SERVICE_NAMES).sort()).toEqual([
      "dispatch-service",
      "extension-service",
      "health-monitor-service",
      "hook-service",
      "hot-reload-service",
      "loop-service",
      "lsp-service",
      "notification-service",
      "recovery-service",
      "session-service",
      "tool-service",
    ]);
  });

  it("declares every service name exactly once", () => {
    const names = Object.values(SERVICE_NAMES);
    expect(names).toHaveLength(11);
    expect(new Set(names).size).toBe(11);
  });

  it("rejects a misspelled service name at compile time", () => {
    // @ts-expect-error — "dispatch-servcie" is not a member of ServiceName
    const typo: ServiceName = "dispatch-servcie";
    // Runtime pin so the type probe above is not a dead case.
    expect(String(typo)).toBe("dispatch-servcie");
  });
});
