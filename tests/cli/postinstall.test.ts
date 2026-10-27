import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

let scratch: string;
let homes: string[];

beforeEach(() => {
  vi.resetModules();
  scratch = mkdtempSync(join(tmpdir(), "rolebox-postinstall-"));
  homes = [join(scratch, "xdg", "opencode"), join(scratch, "pi"), join(scratch, "dsh"), join(scratch, "codex")];
  vi.stubEnv("XDG_CONFIG_HOME", join(scratch, "xdg"));
  vi.stubEnv("PI_CODING_AGENT_DIR", homes[1]);
  vi.stubEnv("DSH_HOME", homes[2]);
  vi.stubEnv("CODEX_HOME", homes[3]);
  vi.stubEnv("ROLEBOX_CONFIG_DIR", join(scratch, "config"));
  vi.stubEnv("ROLEBOX_DATA_DIR", join(scratch, "data"));
  vi.stubEnv("ROLEBOX_LOG_DIR", join(scratch, "logs"));
  vi.stubEnv("CI", "1");
  vi.stubEnv("ROLEBOX_NO_WELCOME", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

describe("installation skill sync", () => {
  it("syncs all existing harness homes even with welcome output disabled", async () => {
    for (const home of homes) mkdirSync(home, { recursive: true });
    await import("../../src/cli/postinstall.ts");
    const source = resolve(import.meta.dirname, "../../skills/rolebox-config");
    for (const home of homes) {
      const skill = join(home, "skills", "rolebox-config");
      expect(realpathSync(skill)).toBe(realpathSync(source));
      expect(readFileSync(join(skill, "references/configuration.md"), "utf8"))
        .toBe(readFileSync(join(source, "references/configuration.md"), "utf8"));
    }
    expect(existsSync(join(homes[3], "config.toml"))).toBe(false);
  });

  it("does not create directories for absent harnesses", async () => {
    mkdirSync(homes[2]);
    await import("../../src/cli/postinstall.ts");
    expect(existsSync(join(homes[2], "skills", "rolebox-config", "SKILL.md"))).toBe(true);
    for (const home of [homes[0], homes[1], homes[3]]) expect(existsSync(home)).toBe(false);
  });

  it("continues with other hosts when one home cannot contain skills", async () => {
    mkdirSync(homes[0], { recursive: true });
    writeFileSync(join(homes[0], "skills"), "User file");
    mkdirSync(homes[3]);
    await import("../../src/cli/postinstall.ts");
    expect(readFileSync(join(homes[0], "skills"), "utf8")).toBe("User file");
    expect(existsSync(join(homes[3], "skills", "rolebox-config", "SKILL.md"))).toBe(true);
  });
});
