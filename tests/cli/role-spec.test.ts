import { describe, it, expect } from "vitest";
import { formatRoleSpec, parseRoleSpec } from "../../src/cli/role-spec.ts";

describe("parseRoleSpec", () => {
  it("parses a plain role name", () => {
    expect(parseRoleSpec("software-architect")).toEqual({ roleId: "software-architect" });
  });

  it("parses a role with a version", () => {
    expect(parseRoleSpec("software-architect@1.0.0")).toEqual({
      roleId: "software-architect",
      version: "1.0.0",
    });
  });

  it("parses registry:role", () => {
    expect(parseRoleSpec("my-registry:custom-role")).toEqual({
      registry: "my-registry",
      roleId: "custom-role",
    });
  });

  it("parses registry:role@version", () => {
    expect(parseRoleSpec("my-registry:role@2.0.0")).toEqual({
      registry: "my-registry",
      roleId: "role",
      version: "2.0.0",
    });
  });

  it("treats only the last @ as the version separator", () => {
    expect(parseRoleSpec("some@role@1.0.0")).toEqual({
      roleId: "some@role",
      version: "1.0.0",
    });
  });

  it("parses an empty spec as an empty role id", () => {
    expect(parseRoleSpec("")).toEqual({ roleId: "" });
  });
});

describe("formatRoleSpec", () => {
  it("renders a bare role id", () => {
    expect(formatRoleSpec({ roleId: "software-architect" })).toBe("software-architect");
  });

  it("renders the version when present", () => {
    expect(formatRoleSpec({ roleId: "role", version: "2.0.0" })).toBe("role@2.0.0");
  });

  it("renders the registry when present", () => {
    expect(formatRoleSpec({ registry: "custom", roleId: "role" })).toBe("custom:role");
  });

  it("renders registry and version together", () => {
    expect(formatRoleSpec({ registry: "custom", roleId: "role", version: "2.0.0" })).toBe(
      "custom:role@2.0.0",
    );
  });

  it("round-trips every spec shape", () => {
    const specs = [
      "role",
      "role@1.0.0",
      "custom:role",
      "custom:role@2.0.0",
      "some@role@1.0.0",
    ];
    for (const spec of specs) {
      expect(formatRoleSpec(parseRoleSpec(spec))).toBe(spec);
    }
  });
});
