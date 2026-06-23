import { describe, it, expect } from "bun:test";
import { getDataDir, getConfigDir, getRolesDir, getSyncTarget, getRolePath } from "./paths";

describe("paths", () => {
  it("getDataDir returns ~/.local/share/rolebox on macOS/Linux by default", () => {
    const dir = getDataDir();
    expect(dir).toEndWith(".local/share/rolebox");
  });

  it("getConfigDir returns ~/.config/rolebox on macOS/Linux by default", () => {
    const dir = getConfigDir();
    expect(dir).toEndWith(".config/rolebox");
  });

  it("getRolesDir returns {dataDir}/roles", () => {
    const rolesDir = getRolesDir();
    expect(rolesDir).toEndWith("roles");
    expect(rolesDir).toContain(getDataDir());
  });

  it("getSyncTarget opencode returns path ending with opencode/rolebox", () => {
    const target = getSyncTarget("opencode");
    expect(target).toEndWith("opencode/rolebox");
  });

  it("getSyncTarget with unknown target throws", () => {
    expect(() => getSyncTarget("vscode")).toThrow("Unknown sync target");
  });

  it("getRolePath constructs correct path", () => {
    const p = getRolePath("oh-my-role", "software-architect", "1.0.0");
    expect(p).toContain("oh-my-role");
    expect(p).toContain("software-architect@1.0.0");
  });

  it("getDataDir respects XDG_DATA_HOME", () => {
    const orig = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = "/tmp/test-xdg";
    try {
      const dir = getDataDir();
      expect(dir).toBe("/tmp/test-xdg/rolebox");
    } finally {
      if (orig) process.env.XDG_DATA_HOME = orig;
      else delete process.env.XDG_DATA_HOME;
    }
  });
});
