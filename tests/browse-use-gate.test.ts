/** Browse-use gate, per-role grants and the opencode denial emission. */

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BROWSE_TOOL_NAMES,
  BROWSE_TOOL_WILDCARD,
  decideBrowseToolGrant,
  isBrowseToolName,
  isRegisteredBrowseToolName,
  roleGrantsBrowseTool,
} from "../src/loader/browse-grants.ts";
import {
  BROWSE_USE_CONFIG_KEY,
  readBrowseUseFromJsonFile,
  readBrowseUseFromYamlFile,
  resolveBrowseUseGate,
} from "../src/loader/browse-use-gate.ts";
import { detectPlaywright } from "../src/browse/availability.ts";
import { createBrowseTools } from "../src/browse/tools.ts";
import {
  buildAgentConfig,
  setAgentConfigWorkspace,
  withBrowseUseDenials,
} from "../src/prompt/agent-config.ts";
import type { ResolvedRole, ResolvedSubAgent } from "../src/types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Write one file into a fresh temp dir and return its path. */
function writeFile(name: string, body: string): string {
  const dir = makeTmpDir("rolebox-browse-use-");
  const path = join(dir, name);
  writeFileSync(path, body, "utf-8");
  return path;
}

function makeRole(id: string, tools?: Record<string, boolean>): ResolvedRole {
  return {
    id,
    config: {
      name: id,
      description: "",
      prompt: "",
      ...(tools === undefined ? {} : { tools }),
    },
    prompt: "",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
  };
}

const NO_ROLES: ResolvedRole[] = [];
const MISSING = "/nonexistent/rolebox/config-does-not-exist";

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  setAgentConfigWorkspace(undefined);
});

// ── 1. The gate ─────────────────────────────────────────────────────────────

describe("browse-use gate — explicit setting first, AUTO otherwise", () => {
  /** Resolve with both config files absent, so only the driver answer matters. */
  function auto(driverAvailable: boolean) {
    return resolveBrowseUseGate({
      globalConfigPath: MISSING,
      projectConfigPath: `${MISSING}.json`,
      driverAvailable,
    });
  }

  it("is OFF by AUTO when the optional driver does not resolve", () => {
    const gate = auto(false);
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain("OFF");
    expect(gate.reason).toContain(BROWSE_USE_CONFIG_KEY);
    expect(gate.driver).toEqual({ available: false });
    // Missing source values stay distinct from an explicit false.
    expect(gate.host).toBeUndefined();
    expect(gate.globalConfig).toBeUndefined();
    expect(gate.projectConfig).toBeUndefined();
  });

  it("is ON by AUTO when the driver resolves", () => {
    const gate = auto(true);
    expect(gate.enabled).toBe(true);
    expect(gate.reason).toContain("auto-detection");
    expect(gate.driver.available).toBe(true);
  });

  it("honors every explicit setting, with false vetoing any true", () => {
    for (const host of [undefined, false, true]) {
      for (const global of [undefined, false, true]) {
        for (const project of [undefined, false, true]) {
          for (const driver of [false, true]) {
            const gate = resolveBrowseUseGate({
              hostOverride: host,
              globalConfigPath: writeFile("config.yaml", global === undefined ? "registries: []\n" : `browseUse: ${global}\n`),
              projectConfigPath: writeFile("config.json", JSON.stringify(project === undefined ? {} : { browseUse: project })),
              driverAvailable: driver,
            });
            const explicit = [host, global, project];
            // An explicit true wins over a MISSING driver; an explicit false
            // always disables; with no setting at all the driver decides.
            const enabled = explicit.includes(false)
              ? false
              : explicit.includes(true) ? true : driver;
            expect(gate.enabled, JSON.stringify({ host, global, project, driver })).toBe(enabled);
            expect(gate.host).toBe(host);
            expect(gate.globalConfig).toBe(global);
            expect(gate.projectConfig).toBe(project);
          }
        }
      }
    }
  });

  it("registers on an explicit true even without the driver, so browse_status can explain", () => {
    const gate = resolveBrowseUseGate({
      hostOverride: true,
      globalConfigPath: MISSING,
      projectConfigPath: `${MISSING}.json`,
      driverAvailable: false,
    });
    expect(gate.enabled).toBe(true);
    expect(gate.reason).toContain("ENABLED");
    expect(gate.reason).toContain("browse_status");
    expect(gate.reason).toContain("playwright");
  });

  it("reports the source that disables registration", () => {
    const globalConfigPath = writeFile("config.yaml", "browseUse: false\n");
    const gate = resolveBrowseUseGate({ hostOverride: true, globalConfigPath, projectConfigPath: MISSING, driverAvailable: true });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain("OFF");
    expect(gate.reason).toContain(globalConfigPath);
  });

  it("reads the workspace project config when no project path is supplied", () => {
    const workspaceDir = makeTmpDir("rolebox-browse-workspace-");
    mkdirSync(join(workspaceDir, ".rolebox"));
    writeFileSync(join(workspaceDir, ".rolebox", "config.json"), JSON.stringify({ browseUse: false }));
    const gate = resolveBrowseUseGate({ hostOverride: true, globalConfigPath: MISSING, workspaceDir, driverAvailable: true });
    expect(gate.projectConfig).toBe(false);
    expect(gate.enabled).toBe(false);
  });

  it("treats an invalid explicit value as disabling even if another source enables", () => {
    for (const value of ["true", 1, null, {}, []]) {
      const config = JSON.stringify({ browseUse: value });
      const yaml = writeFile("config.yaml", config);
      const json = writeFile("config.json", config);
      expect(readBrowseUseFromYamlFile(yaml)).toBe(false);
      expect(readBrowseUseFromJsonFile(json)).toBe(false);
      expect(resolveBrowseUseGate({ hostOverride: true, globalConfigPath: yaml, projectConfigPath: MISSING, driverAvailable: true }).enabled).toBe(false);
      expect(resolveBrowseUseGate({ hostOverride: true, globalConfigPath: MISSING, projectConfigPath: json, driverAvailable: true }).enabled).toBe(false);
    }
  });

  it("distinguishes missing settings from unreadable or malformed config", () => {
    expect(readBrowseUseFromYamlFile(MISSING)).toBeUndefined();
    expect(readBrowseUseFromJsonFile(MISSING)).toBeUndefined();
    expect(readBrowseUseFromYamlFile(writeFile("config.yaml", "registries: []\n"))).toBeUndefined();
    expect(readBrowseUseFromYamlFile(writeFile("config.yaml", ""))).toBeUndefined();
    expect(readBrowseUseFromJsonFile(writeFile("config.json", "{}"))).toBeUndefined();
    expect(readBrowseUseFromYamlFile(writeFile("config.yaml", "browseUse: [\n"))).toBe(false);
    expect(readBrowseUseFromJsonFile(writeFile("config.json", "{not json"))).toBe(false);
    expect(readBrowseUseFromYamlFile(writeFile("config.yaml", "- a\n"))).toBe(false);
    expect(readBrowseUseFromJsonFile(writeFile("config.json", "[1]"))).toBe(false);
    expect(readBrowseUseFromJsonFile(makeTmpDir("rolebox-browse-config-directory-"))).toBe(false);
  });

  it("never creates or modifies the config files it reads", () => {
    const dir = makeTmpDir("rolebox-browse-readonly-");
    const globalConfigPath = join(dir, "config.yaml");
    const projectConfigPath = join(dir, "missing", "config.json");
    const gate = resolveBrowseUseGate({ globalConfigPath, projectConfigPath, driverAvailable: false });
    expect(gate.enabled).toBe(false);
    expect(readBrowseUseFromYamlFile(globalConfigPath)).toBeUndefined();
    expect(readBrowseUseFromJsonFile(projectConfigPath)).toBeUndefined();
  });

  it("uses the same createRequire probe the driver itself uses when none is injected", () => {
    const gate = resolveBrowseUseGate({ globalConfigPath: MISSING, projectConfigPath: `${MISSING}.json` });
    const probe = detectPlaywright();
    expect(gate.driver.available).toBe(probe.available);
    expect(gate.enabled).toBe(probe.available);
    if (probe.resolvedPath !== undefined) expect(gate.driver.resolvedPath).toBe(probe.resolvedPath);
  });
});

// ── 2. Per-role grants ──────────────────────────────────────────────────────

describe("browse-use grants — allow by default with explicit role restrictions", () => {
  it("covers every registered browse tool, and no more", () => {
    // Compared as string[]: the matcher's expected parameter is inferred from
    // the received side, which the const annotation widens.
    const declared: string[] = [...BROWSE_TOOL_NAMES];
    expect(declared.sort()).toEqual(Object.keys(createBrowseTools()).sort());
    expect(BROWSE_TOOL_NAMES).toHaveLength(22);
    expect(isBrowseToolName("browse_open")).toBe(true);
    expect(isBrowseToolName("browse_future_tool")).toBe(true);
    expect(isBrowseToolName("hashline_read")).toBe(false);
    expect(isRegisteredBrowseToolName("browse_click")).toBe(true);
    expect(isRegisteredBrowseToolName("browse_future_tool")).toBe(false);
  });

  it("allows tools without a matching restriction", () => {
    expect(roleGrantsBrowseTool({ browse_status: true }, "browse_status")).toBe(true);
    expect(roleGrantsBrowseTool({ browse_status: true }, "browse_click")).toBe(true);
    expect(roleGrantsBrowseTool({ [BROWSE_TOOL_WILDCARD]: true }, "browse_wait")).toBe(true);
  });

  it("honors an exact denial before the family wildcard for every tool", () => {
    for (const name of BROWSE_TOOL_NAMES) {
      expect(roleGrantsBrowseTool({ [BROWSE_TOOL_WILDCARD]: true, [name]: false }, name)).toBe(false);
      expect(roleGrantsBrowseTool({ [BROWSE_TOOL_WILDCARD]: false, [name]: true }, name)).toBe(true);
    }
  });

  it("allows missing maps and honors exact and longest-prefix rules", () => {
    expect(roleGrantsBrowseTool(undefined, "browse_open")).toBe(true);
    expect(roleGrantsBrowseTool({}, "browse_open")).toBe(true);
    expect(roleGrantsBrowseTool({ "*": true }, "browse_open")).toBe(true);
    expect(roleGrantsBrowseTool({ browse: false }, "browse_open")).toBe(true);
    expect(roleGrantsBrowseTool({ "*": false }, "browse_open")).toBe(false);
    expect(roleGrantsBrowseTool({ "browse_*": false, "*": true }, "browse_open")).toBe(false);
    expect(roleGrantsBrowseTool({ "browse_op*": true, "browse_*": false, "*": true }, "browse_open")).toBe(true);
    expect(roleGrantsBrowseTool({ "browse_op*": false, "browse_*": true }, "browse_open")).toBe(false);
    expect(roleGrantsBrowseTool({ "browse_op*": true, browse_open: false }, "browse_open")).toBe(false);
  });

  it("denies with a reason naming the role and its disabling rule", () => {
    const roles = [makeRole("tester", { "browse_*": false })];
    const decision = decideBrowseToolGrant({ toolName: "browse_click", roleId: "tester", roles });
    expect(decision.granted).toBe(false);
    if (decision.granted) throw new Error("unreachable");
    expect(decision.reason).toContain('"tester"');
    expect(decision.reason).toContain("browse_click");
    expect(decision.reason).toContain("browse_click: true");
  });

  it("allows the base agent but denies an explicitly named unknown role", () => {
    const base = decideBrowseToolGrant({
      toolName: "browse_snapshot",
      roleId: null,
      roles: [makeRole("tester", { [BROWSE_TOOL_WILDCARD]: true })],
    });
    expect(base.granted).toBe(true);
    for (const roleId of [undefined, ""]) {
      expect(decideBrowseToolGrant({ toolName: "browse_snapshot", roleId, roles: NO_ROLES }).granted).toBe(true);
    }

    const unknown = decideBrowseToolGrant({ toolName: "browse_snapshot", roleId: "ghost", roles: NO_ROLES });
    expect(unknown.granted).toBe(false);
    if (!unknown.granted) expect(unknown.reason).toContain('"ghost"');
  });

  it("resolves nested roles and applies their own effective tools map", () => {
    const parent = makeRole("parent", { "browse_*": false });
    const child: ResolvedSubAgent = { ...makeRole("parent--child"), parentId: parent.id, inheritedFrom: {} };
    const nested: ResolvedSubAgent = { ...makeRole("parent--child--nested", { browse_click: false }), parentId: child.id, inheritedFrom: {} };
    parent.subagents.push(child);
    child.subagents.push(nested);
    const decide = (roleId: string, toolName = "browse_click") => decideBrowseToolGrant({ roleId, toolName, roles: [parent] });
    expect(decide(parent.id).granted).toBe(false);
    expect(decide(child.id).granted).toBe(true);
    expect(decide(nested.id).granted).toBe(false);
    expect(decide(nested.id, "browse_snapshot").granted).toBe(true);
  });
});

// ── 3. opencode emission ────────────────────────────────────────────────────

describe("opencode agent config — materializes explicit browse tool restrictions", () => {
  it("leaves the tools map untouched while the gate is OFF", () => {
    const owned = { web_search: false, hashline_read: true };
    expect(withBrowseUseDenials(owned, false)).toBe(owned);
    expect(withBrowseUseDenials(undefined, false)).toBeUndefined();
    const config = buildAgentConfig(makeRole("tester", owned), { browseUse: false });
    expect(config.tools).toBe(owned);
    expect(config.tools?.browse_open).toBeUndefined();
  });

  it("keeps unrestricted roles unchanged while the gate is ON", () => {
    const config = buildAgentConfig(makeRole("tester", { web_search: false }), { browseUse: true });
    expect(config.tools).toBeDefined();
    expect(config.tools!.web_search).toBe(false);
    for (const name of BROWSE_TOOL_NAMES) expect(config.tools![name]).toBeUndefined();
    expect(buildAgentConfig(makeRole("tester"), { browseUse: true }).tools).toBeUndefined();
  });

  it("preserves an exact denial alongside a family grant in the host config", () => {
    const tools = withBrowseUseDenials({ [BROWSE_TOOL_WILDCARD]: true, browse_click: false }, true)!;
    expect(tools[BROWSE_TOOL_WILDCARD]).toBe(true);
    expect(tools.browse_click).toBe(false);
    expect(tools.browse_snapshot).toBeUndefined();
  });

  it("materializes broad denials and keeps exact exceptions", () => {
    const exact = withBrowseUseDenials({ "browse_*": false, browse_status: true }, true)!;
    expect(exact.browse_status).toBe(true);
    expect(exact.browse_open).toBe(false);
    expect(exact.browse_close).toBe(false);
  });

  it("keeps the computer family's map when both families are on", () => {
    const tools = withBrowseUseDenials(
      { "computer_*": false, computer_status: true } as Record<string, boolean>,
      true,
    )!;
    // The computer map is the input, not this function's business: a role that
    // restricts only computer_* gains no browse denials.
    expect(tools.computer_status).toBe(true);
    expect(tools.browse_status).toBeUndefined();
  });

  it("uses the workspace project gate and honors an explicit override", () => {
    const workspaceDir = makeTmpDir("rolebox-agent-config-browse-");
    mkdirSync(join(workspaceDir, ".rolebox"), { recursive: true });
    writeFileSync(join(workspaceDir, ".rolebox", "config.json"), JSON.stringify({ browseUse: true }));
    const role = makeRole("tester", { "browse_*": false });
    setAgentConfigWorkspace(workspaceDir);
    expect(buildAgentConfig(role).tools?.browse_open).toBe(false);
    expect(buildAgentConfig(role, { browseUse: false }).tools?.browse_open).toBeUndefined();
    expect(buildAgentConfig(makeRole("tester", { "computer_*": false }), { browseUse: false })
      .tools?.browse_open).toBeUndefined();
  });
});
