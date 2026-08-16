/// <reference types="bun-types" />

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  dshPlatformPaths,
  defaultPlatformPaths,
  piPlatformPaths,
} from "../../src/platform/paths.ts";
import { resolveRoleboxDirectories } from "../../src/platform/factory.ts";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DSH_HOME = process.env.DSH_HOME;

let tempDshHome: string;

beforeAll(() => {
  tempDshHome = mkdtempSync(join(tmpdir(), "rolebox-dsh-"));
});

afterAll(() => {
  rmSync(tempDshHome, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.DSH_HOME = tempDshHome;
});

afterEach(() => {
  if (ORIGINAL_DSH_HOME === undefined) {
    delete process.env.DSH_HOME;
  } else {
    process.env.DSH_HOME = ORIGINAL_DSH_HOME;
  }
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
});

describe("dshPlatformPaths", () => {
  it("resolves every path under DSH_HOME when it is set", () => {
    const paths = dshPlatformPaths();

    expect(paths.platformId).toBe("dsh");
    expect(paths.configDir).toBe(tempDshHome);
    expect(paths.agentsDir).toBe(join(tempDshHome, "skills"));
    expect(paths.skillsDir).toBe(join(tempDshHome, "skills"));
    expect(paths.sessionsDir).toBe(join(tempDshHome, "sessions"));
  });

  it("falls back to ~/.dsh when DSH_HOME is unset", () => {
    delete process.env.DSH_HOME;

    const paths = dshPlatformPaths();

    expect(paths.platformId).toBe("dsh");
    expect(paths.configDir).toBe(join(homedir(), ".dsh"));
    expect(paths.agentsDir).toBe(join(homedir(), ".dsh", "skills"));
    expect(paths.skillsDir).toBe(join(homedir(), ".dsh", "skills"));
  });

  it("treats a blank DSH_HOME as unset and falls back to ~/.dsh", () => {
    const fallback = join(homedir(), ".dsh");

    process.env.DSH_HOME = "";
    expect(dshPlatformPaths().configDir).toBe(fallback);

    process.env.DSH_HOME = "   ";
    expect(dshPlatformPaths().configDir).toBe(fallback);
  });
});

describe("resolveRoleboxDirectories with platformId 'dsh'", () => {
  it("routes to dshPlatformPaths so directories resolve under DSH_HOME", () => {
    const dirs = resolveRoleboxDirectories({
      platformId: "dsh",
      workingDir: tempDshHome,
    });

    // {workingDir}/rolebox does not exist, so roleboxDir falls back under configDir.
    expect(dirs.roleboxDir).toBe(join(tempDshHome, "rolebox"));
    expect(dirs.configDir).toBe(tempDshHome);
    expect(dirs.globalSkillsDir).toBe(join(tempDshHome, "skills"));
  });

  it("defaults to opencode paths when platformId is omitted", () => {
    const dirs = resolveRoleboxDirectories({ workingDir: tempDshHome });

    expect(dirs.configDir).toBe(defaultPlatformPaths().configDir);
    expect(dirs.globalSkillsDir).toBe(defaultPlatformPaths().skillsDir);
  });
});

describe("existing platform path helpers", () => {
  it("still resolve for opencode and pi", () => {
    const home = homedir();

    const opencode = defaultPlatformPaths();
    expect(opencode.platformId).toBe("opencode");
    expect(opencode.configDir).toBe(join(home, ".config", "opencode"));
    expect(opencode.skillsDir).toBe(join(opencode.configDir, "skills"));

    const pi = piPlatformPaths();
    expect(pi.platformId).toBe("pi");
    expect(pi.configDir).toBe(join(home, ".pi", "agent"));
  });
});

describe("platform path modules stay free of platform SDK imports", () => {
  const FILES = [
    resolve(import.meta.dir, "../../src/platform/paths.ts"),
    resolve(import.meta.dir, "../../src/platform/factory.ts"),
  ];

  function extractImportSpecifiers(source: string): string[] {
    const importRe =
      /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+["']([^"']+)["']/g;
    const specifiers: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(source)) !== null) {
      specifiers.push(match[1]);
    }
    return specifiers;
  }

  it("contains no @deepseek-ai/* or @opencode-ai/* imports", () => {
    for (const file of FILES) {
      const specifiers = extractImportSpecifiers(readFileSync(file, "utf-8"));
      const forbidden = specifiers.filter(
        (s) => s.includes("@deepseek-ai/") || s.includes("@opencode-ai/"),
      );
      expect(forbidden, `${file} imports platform SDK packages`).toEqual([]);
    }
  });
});
