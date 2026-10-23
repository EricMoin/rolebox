/** Shared computer-use defaults and explicit restrictions across host policies. */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  COMPUTER_TOOL_NAMES,
  COMPUTER_TOOL_WILDCARD,
  decideComputerToolGrant,
  isComputerToolName,
  isRegisteredComputerToolName,
  roleGrantsComputerTool,
} from "../src/loader/computer-grants.ts";
import {
  resolveComputerUseGate,
  readComputerUseFromJsonFile,
  readComputerUseFromYamlFile,
} from "../src/loader/computer-use-gate.ts";
import {
  buildAgentConfig,
  setAgentConfigWorkspace,
  withComputerUseDenials,
} from "../src/prompt/agent-config.ts";
import {
  dshGuardSessionId,
  installDshComputerUsePolicy,
  isComputerUseRegistrationAllowed,
  type DshToolGuardExecution,
  type DshToolGuardRegistry,
} from "../src/platform/adapters/dsh/role-tool-policy.ts";
import { interceptToolBefore } from "../src/platform/adapters/pi/tool-interceptor.ts";
import { registerToolSchema } from "../src/hooks/tool-before.ts";
import { HookState } from "../src/hooks/state.ts";
import { createComputerTools } from "../src/computer/index.ts";
import type { ResolvedRole, ResolvedSubAgent } from "../src/types.ts";
import type { CanonicalToolContext } from "../src/platform/types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Write one file into a fresh temp dir and return its path. */
function writeFile(name: string, body: string): string {
  const dir = makeTmpDir("rolebox-computer-use-");
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

function toolContext(sessionID = "sess-1"): CanonicalToolContext {
  return {
    sessionID,
    messageID: "msg-1",
    agent: "role-agent",
    directory: "/tmp/rolebox-workspace",
    worktree: "/tmp/rolebox-workspace",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  };
}

/** A recording `ctx.tools` double: captures the installed guard. */
function guardDouble(options: { withGuard?: boolean } = {}): {
  registry: DshToolGuardRegistry;
  evaluate(execution: DshToolGuardExecution): string | undefined;
  installed(): boolean;
  disposals(): number;
} {
  let installed: ((execution: DshToolGuardExecution) => string | undefined) | undefined;
  let disposals = 0;
  const registry: DshToolGuardRegistry =
    options.withGuard === false
      ? {}
      : {
          guard(guard: (execution: DshToolGuardExecution) => string | undefined) {
            installed = guard;
            return () => {
              disposals++;
            };
          },
        };
  return {
    registry,
    /** Evaluate the installed guard for one execution. */
    evaluate(execution: DshToolGuardExecution): string | undefined {
      return installed ? installed(execution) : undefined;
    },
    installed: () => installed !== undefined,
    disposals: () => disposals,
  };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  setAgentConfigWorkspace(undefined);
});

// ── 1. The global gate ──────────────────────────────────────────────────────

describe("computer-use gate — default ON, explicit settings can disable", () => {
  const missing = "/nonexistent/rolebox/config-does-not-exist";

  it("allows an unconfigured boot and keeps missing source values distinct", () => {
    const gate = resolveComputerUseGate({ globalConfigPath: missing, projectConfigPath: `${missing}.json` });
    expect(gate.enabled).toBe(true);
    expect(gate.host).toBeUndefined();
    expect(gate.globalConfig).toBeUndefined();
    expect(gate.projectConfig).toBeUndefined();
    expect(gate.reason).toContain("default");
  });

  it("honors every explicit false regardless of true values in other sources", () => {
    for (const host of [undefined, false, true]) {
      for (const global of [undefined, false, true]) {
        for (const project of [undefined, false, true]) {
          const gate = resolveComputerUseGate({
            hostOverride: host,
            globalConfigPath: writeFile("config.yaml", global === undefined ? "registries: []\n" : `computerUse: ${global}\n`),
            projectConfigPath: writeFile("config.json", JSON.stringify(project === undefined ? {} : { computerUse: project })),
          });
          expect(gate.enabled).toBe(![host, global, project].includes(false));
          expect(gate.host).toBe(host);
          expect(gate.globalConfig).toBe(global);
          expect(gate.projectConfig).toBe(project);
        }
      }
    }
  });

  it("reports the source that disables registration", () => {
    const globalConfigPath = writeFile("config.yaml", "computerUse: false\n");
    const gate = resolveComputerUseGate({ hostOverride: true, globalConfigPath, projectConfigPath: missing });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain("OFF");
    expect(gate.reason).toContain(globalConfigPath);
  });

  it("uses the workspace project config when no project path is supplied", () => {
    const workspaceDir = makeTmpDir("rolebox-computer-workspace-");
    mkdirSync(join(workspaceDir, ".rolebox"));
    writeFileSync(join(workspaceDir, ".rolebox", "config.json"), JSON.stringify({ computerUse: false }));
    const gate = resolveComputerUseGate({ hostOverride: true, globalConfigPath: missing, workspaceDir });
    expect(gate.projectConfig).toBe(false);
    expect(gate.enabled).toBe(false);
  });

  it("treats an invalid explicit value as disabling even if another source enables", () => {
    for (const value of ["true", 1, null, {}, []]) {
      const config = JSON.stringify({ computerUse: value });
      const yaml = writeFile("config.yaml", config);
      const json = writeFile("config.json", config);
      expect(readComputerUseFromYamlFile(yaml)).toBe(false);
      expect(readComputerUseFromJsonFile(json)).toBe(false);
      expect(resolveComputerUseGate({ hostOverride: true, globalConfigPath: yaml, projectConfigPath: missing }).enabled).toBe(false);
      expect(resolveComputerUseGate({ hostOverride: true, globalConfigPath: missing, projectConfigPath: json }).enabled).toBe(false);
    }
  });

  it("distinguishes missing settings from unreadable or malformed config", () => {
    expect(readComputerUseFromYamlFile(missing)).toBeUndefined();
    expect(readComputerUseFromJsonFile(missing)).toBeUndefined();
    expect(readComputerUseFromYamlFile(writeFile("config.yaml", "registries: []\n"))).toBeUndefined();
    expect(readComputerUseFromYamlFile(writeFile("config.yaml", ""))).toBeUndefined();
    expect(readComputerUseFromJsonFile(writeFile("config.json", "{}"))).toBeUndefined();
    expect(readComputerUseFromYamlFile(writeFile("config.yaml", "computerUse: [\n"))).toBe(false);
    expect(readComputerUseFromJsonFile(writeFile("config.json", "{not json"))).toBe(false);
    expect(readComputerUseFromYamlFile(writeFile("config.yaml", "- a\n"))).toBe(false);
    expect(readComputerUseFromJsonFile(writeFile("config.json", "[1]"))).toBe(false);
    expect(readComputerUseFromJsonFile(makeTmpDir("rolebox-config-directory-"))).toBe(false);
  });
});

// ── 2. Per-role grants ──────────────────────────────────────────────────────

describe("computer-use grants — allow by default with explicit role restrictions", () => {
  it("covers every registered computer tool, and no more", () => {
    // Compared as string[]: the matcher's expected parameter is inferred from
    // the received side, which the const annotation widens.
    const declared: string[] = [...COMPUTER_TOOL_NAMES];
    expect(declared.sort()).toEqual(Object.keys(createComputerTools()).sort());
    expect(isComputerToolName("computer_screenshot")).toBe(true);
    expect(isComputerToolName("computer_future_tool")).toBe(true);
    expect(isComputerToolName("hashline_read")).toBe(false);
    expect(isRegisteredComputerToolName("computer_click")).toBe(true);
    expect(isRegisteredComputerToolName("computer_future_tool")).toBe(false);
  });

  it("allows tools without a matching restriction", () => {
    expect(roleGrantsComputerTool({ computer_screenshot: true }, "computer_screenshot")).toBe(true);
    expect(roleGrantsComputerTool({ computer_screenshot: true }, "computer_click")).toBe(true);
    expect(roleGrantsComputerTool({ [COMPUTER_TOOL_WILDCARD]: true }, "computer_key")).toBe(true);
  });

  it("honors an exact denial before the family wildcard for every tool", () => {
    for (const name of COMPUTER_TOOL_NAMES) {
      expect(roleGrantsComputerTool({ [COMPUTER_TOOL_WILDCARD]: true, [name]: false }, name)).toBe(false);
      expect(roleGrantsComputerTool({ [COMPUTER_TOOL_WILDCARD]: false, [name]: true }, name)).toBe(true);
    }
  });

  it("allows missing maps and honors exact and longest-prefix rules", () => {
    expect(roleGrantsComputerTool(undefined, "computer_screenshot")).toBe(true);
    expect(roleGrantsComputerTool({}, "computer_screenshot")).toBe(true);
    expect(roleGrantsComputerTool({ "*": true }, "computer_screenshot")).toBe(true);
    expect(roleGrantsComputerTool({ computer: false }, "computer_screenshot")).toBe(true);
    expect(roleGrantsComputerTool({ "*": false }, "computer_screenshot")).toBe(false);
    expect(roleGrantsComputerTool({ "computer_*": false, "*": true }, "computer_screenshot")).toBe(false);
    expect(roleGrantsComputerTool({ "computer_sc*": true, "computer_*": false, "*": true }, "computer_screenshot")).toBe(true);
    expect(roleGrantsComputerTool({ "computer_sc*": false, "computer_*": true }, "computer_screenshot")).toBe(false);
    expect(roleGrantsComputerTool({ "computer_sc*": true, computer_screenshot: false }, "computer_screenshot")).toBe(false);
  });

  it("denies with a reason naming the role and its disabling rule", () => {
    const roles = [makeRole("tester", { "computer_*": false })];
    const decision = decideComputerToolGrant({
      toolName: "computer_click",
      roleId: "tester",
      roles,
    });
    expect(decision.granted).toBe(false);
    if (decision.granted) throw new Error("unreachable");
    expect(decision.reason).toContain('"tester"');
    expect(decision.reason).toContain("computer_click");
    expect(decision.reason).toContain("computer_click: true");
  });

  it("allows the base agent but denies an explicitly named unknown role", () => {
    const base = decideComputerToolGrant({
      toolName: "computer_move",
      roleId: null,
      roles: [makeRole("tester", { [COMPUTER_TOOL_WILDCARD]: true })],
    });
    expect(base.granted).toBe(true);
    for (const roleId of [undefined, ""]) {
      expect(decideComputerToolGrant({ toolName: "computer_move", roleId, roles: NO_ROLES }).granted).toBe(true);
    }

    const unknown = decideComputerToolGrant({
      toolName: "computer_move",
      roleId: "ghost",
      roles: NO_ROLES,
    });
    expect(unknown.granted).toBe(false);
    if (!unknown.granted) expect(unknown.reason).toContain('"ghost"');
  });

  it("allows a granted role, by exact name and by wildcard", () => {
    const exact = decideComputerToolGrant({
      toolName: "computer_type",
      roleId: "operator",
      roles: [makeRole("operator", { computer_type: true })],
    });
    expect(exact.granted).toBe(true);
    const wildcard = decideComputerToolGrant({
      toolName: "computer_permissions",
      roleId: "operator",
      roles: [makeRole("operator", { [COMPUTER_TOOL_WILDCARD]: true })],
    });
    expect(wildcard.granted).toBe(true);
  });

  it("resolves nested roles and applies their own effective tools map", () => {
    const parent = makeRole("parent", { "computer_*": false });
    const child: ResolvedSubAgent = { ...makeRole("parent--child"), parentId: parent.id, inheritedFrom: {} };
    const nested: ResolvedSubAgent = { ...makeRole("parent--child--nested", { computer_click: false }), parentId: child.id, inheritedFrom: {} };
    parent.subagents.push(child);
    child.subagents.push(nested);
    const decide = (roleId: string, toolName = "computer_click") => decideComputerToolGrant({ roleId, toolName, roles: [parent] });
    expect(decide(parent.id).granted).toBe(false);
    expect(decide(child.id).granted).toBe(true);
    expect(decide(nested.id).granted).toBe(false);
    expect(decide(nested.id, "computer_screenshot").granted).toBe(true);
  });
});

// ── 3. opencode v1 + v2 emission ────────────────────────────────────────────

describe("opencode agent config — materializes explicit computer tool restrictions", () => {
  it("leaves the tools map untouched while the gate is OFF", () => {
    const owned = { web_search: false, hashline_read: true };
    expect(withComputerUseDenials(owned, false)).toBe(owned);
    expect(withComputerUseDenials(undefined, false)).toBeUndefined();
    const config = buildAgentConfig(makeRole("tester", owned), { computerUse: false });
    expect(config.tools).toBe(owned);
    expect(config.tools?.computer_screenshot).toBeUndefined();
  });

  it("keeps unrestricted roles unchanged while the gate is ON", () => {
    const config = buildAgentConfig(makeRole("tester", { web_search: false }), {
      computerUse: true,
    });
    expect(config.tools).toBeDefined();
    expect(config.tools!.web_search).toBe(false);
    for (const name of COMPUTER_TOOL_NAMES) expect(config.tools![name]).toBeUndefined();
    expect(buildAgentConfig(makeRole("tester"), { computerUse: true }).tools).toBeUndefined();
  });

  it("preserves an exact denial alongside a family grant in the host config", () => {
    const tools = withComputerUseDenials({ [COMPUTER_TOOL_WILDCARD]: true, computer_drag: false }, true)!;
    expect(tools[COMPUTER_TOOL_WILDCARD]).toBe(true);
    expect(tools.computer_drag).toBe(false);
    expect(tools.computer_scroll).toBeUndefined();
  });

  it("materializes broad denials and keeps exact exceptions", () => {
    const exact = withComputerUseDenials({ "computer_*": false, computer_click: true }, true)!;
    expect(exact.computer_click).toBe(true);
    expect(exact.computer_screenshot).toBe(false);

    const wildcard = withComputerUseDenials({ [COMPUTER_TOOL_WILDCARD]: true }, true)!;
    for (const name of COMPUTER_TOOL_NAMES) {
      // The wildcard grant is rolebox's own key; it is not a tool name, and no
      // family member is denied once it is present.
      expect(wildcard[name]).toBeUndefined();
    }
    expect(wildcard[COMPUTER_TOOL_WILDCARD]).toBe(true);
  });

  it("uses the workspace project gate and honors an explicit override", () => {
    const workspaceDir = makeTmpDir("rolebox-agent-config-workspace-");
    mkdirSync(join(workspaceDir, ".rolebox"), { recursive: true });
    writeFileSync(join(workspaceDir, ".rolebox", "config.json"), JSON.stringify({ computerUse: false }));
    const role = makeRole("tester", { "computer_*": false });
    expect(buildAgentConfig(role, { workspaceDir }).tools?.computer_screenshot).toBeUndefined();
    expect(buildAgentConfig(role, { workspaceDir, computerUse: true }).tools?.computer_screenshot).toBe(false);
    setAgentConfigWorkspace(workspaceDir);
    expect(buildAgentConfig(role).tools?.computer_key).toBeUndefined();
  });
});

// ── 4. dsh guard ────────────────────────────────────────────────────────────

describe("dsh computer-use guard — per-role enforcement, fail closed", () => {
  it("never registers a computer_* name while the gate is off", () => {
    for (const name of COMPUTER_TOOL_NAMES) {
      expect(isComputerUseRegistrationAllowed(name, false)).toBe(false);
      expect(isComputerUseRegistrationAllowed(name, true)).toBe(true);
    }
    // The check is namespace-independent: every other tool is untouched.
    expect(isComputerUseRegistrationAllowed("hashline_read", false)).toBe(true);
    expect(isComputerUseRegistrationAllowed("computer_screenshot", true)).toBe(true);
  });

  it("denies a role that explicitly disables the family", () => {
    const double = guardDouble();
    const policy = installDshComputerUsePolicy({
      tools: double.registry,
      enabled: true,
      activeRoleOf: (sessionId) => (sessionId === "sess-1" ? "tester" : null),
      roles: () => [makeRole("tester", { "computer_*": false })],
    });
    expect(policy.guardInstalled).toBe(true);
    expect(policy.allowRegistration).toBe(true);

    const reason = double.evaluate({
      name: "computer_click",
      agent: { id: "agent-1", session: { id: "sess-1" } },
    });
    expect(reason).toBeDefined();
    expect(reason!).toContain('"tester"');
    expect(reason!).toContain("computer_click");

    // Other tools are left alone — the guard is monotonic and namespace-scoped.
    expect(double.evaluate({ name: "hashline_read", agent: { session: { id: "sess-1" } } })).toBeUndefined();
    policy.dispose();
    expect(double.disposals()).toBe(1);
  });

  it("allows a role that grants the tool — exact name or wildcard", () => {
    const double = guardDouble();
    installDshComputerUsePolicy({
      tools: double.registry,
      enabled: true,
      activeRoleOf: () => "operator",
      roles: () => [
        makeRole("operator", { computer_screenshot: true, [COMPUTER_TOOL_WILDCARD]: true }),
      ],
    });
    expect(double.evaluate({ name: "computer_screenshot", agent: { id: "a" } })).toBeUndefined();
    expect(double.evaluate({ name: "computer_key", agent: { id: "a" } })).toBeUndefined();
  });

  it("uses the execution role instead of an inherited parent selection", () => {
    const parent = makeRole("parent", { "computer_*": false });
    const child: ResolvedSubAgent = { ...makeRole("parent--child", { computer_click: false }), parentId: parent.id, inheritedFrom: {} };
    parent.subagents.push(child);
    let roleId: string | null = child.id;
    const double = guardDouble();
    installDshComputerUsePolicy({ tools: double.registry, enabled: true,
      activeRoleOf: () => parent.id, roleOfExecution: () => roleId, roles: () => [parent] });
    expect(double.evaluate({ name: "computer_screenshot", agent: { id: "child-session" } })).toBeUndefined();
    expect(double.evaluate({ name: "computer_click", agent: { id: "child-session" } })).toContain(child.id);
    roleId = null;
    expect(double.evaluate({ name: "computer_click", agent: { id: "child-session" } })).toBeUndefined();
    roleId = "missing-child";
    expect(double.evaluate({ name: "computer_click", agent: { id: "child-session" } })).toContain("missing-child");
  });

  it("checks collision aliases against the canonical rule using the live mapping", () => {
    const names = new Map<string, string>();
    const double = guardDouble();
    installDshComputerUsePolicy({ tools: double.registry, enabled: true,
      activeRoleOf: () => "operator", canonicalToolNameOf: name => names.get(name),
      roles: () => [makeRole("operator", { computer_click: false })] });
    names.set("rolebox_computer_click", "computer_click");
    expect(double.evaluate({ name: "rolebox_computer_click" })).toContain("computer_click");
    expect(double.evaluate({ name: "computer_click" })).toContain("computer_click");
    expect(double.evaluate({ name: "computer_screenshot" })).toBeUndefined();
    expect(double.evaluate({ name: "rolebox_memory_read" })).toBeUndefined();
  });

  it("denies an explicitly disabled input tool even when its role grants the family", () => {
    const double = guardDouble();
    const policy = installDshComputerUsePolicy({
      tools: double.registry,
      enabled: true,
      activeRoleOf: () => "operator",
      roles: () => [makeRole("operator", { [COMPUTER_TOOL_WILDCARD]: true, computer_drag: false })],
    });
    expect(double.evaluate({ name: "computer_drag", agent: { id: "a" } })).toContain("computer_drag: true");
    expect(double.evaluate({ name: "computer_scroll", agent: { id: "a" } })).toBeUndefined();
    policy.dispose();
  });

  it("allows the base agent and denies an unknown role", () => {
    const double = guardDouble();
    installDshComputerUsePolicy({
      tools: double.registry,
      enabled: true,
      activeRoleOf: () => null,
      roles: () => [makeRole("tester", { [COMPUTER_TOOL_WILDCARD]: true })],
    });
    const baseReason = double.evaluate({ name: "computer_move", agent: { id: "agent-1" } });
    expect(baseReason).toBeUndefined();

    const unknown = guardDouble();
    installDshComputerUsePolicy({
      tools: unknown.registry,
      enabled: true,
      activeRoleOf: () => "ghost",
      roles: () => NO_ROLES,
    });
    expect(unknown.evaluate({ name: "computer_move", agent: { id: "agent-1" } })).toContain('"ghost"');
  });

  it("installs nothing and refuses registration when the gate is off", () => {
    const double = guardDouble();
    const policy = installDshComputerUsePolicy({
      tools: double.registry,
      enabled: false,
      activeRoleOf: () => "tester",
      roles: () => [makeRole("tester", { [COMPUTER_TOOL_WILDCARD]: true })],
    });
    expect(policy.guardInstalled).toBe(false);
    expect(policy.allowRegistration).toBe(false);
    expect(double.installed()).toBe(false);
    expect(policy.reason).toContain("disabled");
  });

  it("FAILS CLOSED when the host exposes no ctx.tools.guard", () => {
    const double = guardDouble({ withGuard: false });
    const policy = installDshComputerUsePolicy({
      tools: double.registry,
      enabled: true,
      activeRoleOf: () => "tester",
      roles: () => [makeRole("tester", { [COMPUTER_TOOL_WILDCARD]: true })],
    });
    expect(policy.guardInstalled).toBe(false);
    expect(policy.allowRegistration).toBe(false);
    expect(policy.reason).toContain("ctx.tools.guard");
    expect(policy.reason).toContain("fail closed");
  });

  it("resolves the guarded session from agent.session.id then agent.id", () => {
    expect(dshGuardSessionId({ name: "x", agent: { id: "a", session: { id: "s" } } })).toBe("s");
    expect(dshGuardSessionId({ name: "x", agent: { id: "a" } })).toBe("a");
    expect(dshGuardSessionId({ name: "x" })).toBe("");
  });
});

// ── 5. Pi interceptor ───────────────────────────────────────────────────────

describe("pi tool interceptor — the same grant decision, per call", () => {
  // Registered so an ALLOWED call runs the real pipeline below the policy.
  registerToolSchema("computer_screenshot", { dry_run: z.boolean().optional() });

  const hooks = (roleId: string | null, roles: ResolvedRole[], state?: HookState) => ({
    ...(state === undefined ? {} : { state }),
    computerUse: { enabled: true, activeRoleFor: () => roleId, roles: () => roles },
  });

  it("denies computer_* for a role with a disabling rule and returns the reason", async () => {
    const outcome = await interceptToolBefore(
      "computer_screenshot",
      "call-1",
      { dry_run: true },
      toolContext("sess-deny"),
      hooks("tester", [makeRole("tester", { "computer_*": false })]),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error).toContain('"tester"');
    expect(outcome.error).toContain("computer_screenshot");
  });

  it("injects the denial into pendingCorrections when hook state is wired", async () => {
    const state = new HookState();
    const outcome = await interceptToolBefore(
      "computer_click",
      "call-2",
      {},
      toolContext("sess-correct"),
      hooks("tester", [makeRole("tester", { "computer_*": false })], state),
    );
    expect(outcome.ok).toBe(false);
    expect(state.pendingCorrections.get("sess-correct")).toContain("computer_click");
  });

  it("allows a granted role through the unchanged pipeline", async () => {
    const outcome = await interceptToolBefore(
      "computer_screenshot",
      "call-3",
      { dry_run: true },
      toolContext("sess-allow"),
      hooks("operator", [makeRole("operator", { [COMPUTER_TOOL_WILDCARD]: true })]),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.value).toEqual({ dry_run: true });
  });

  it("allows both a base agent and a role without computer rules", async () => {
    for (const roleId of [null, "operator"]) {
      const outcome = await interceptToolBefore("computer_screenshot", "call-default", { dry_run: true },
        toolContext(), hooks(roleId, [makeRole("operator")]));
      expect(outcome.ok).toBe(true);
    }
  });

  it("enforces an exact denial before a family grant on new input tools", async () => {
    const outcome = await interceptToolBefore(
      "computer_drag",
      "call-denied-drag",
      {},
      toolContext("sess-denied-drag"),
      hooks("operator", [makeRole("operator", { [COMPUTER_TOOL_WILDCARD]: true, computer_drag: false })]),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error).toContain("computer_drag");
  });

  it("leaves every non-computer tool on the existing pipeline", async () => {
    // An unknown (unregistered) tool passes through untouched …
    const passthrough = await interceptToolBefore(
      "hashline_read",
      "call-4",
      { filePath: "/tmp/x" },
      toolContext("sess-other"),
      hooks("tester", [makeRole("tester", { "computer_*": false })]),
    );
    expect(passthrough.ok).toBe(true);
    if (!passthrough.ok) throw new Error("unreachable");
    expect(passthrough.value).toEqual({ filePath: "/tmp/x" });

    // … and the strict-validation error path is unchanged for a registered one.
    registerToolSchema("hashline_edit", { filePath: z.string() });
    const rejected = await interceptToolBefore(
      "hashline_edit",
      "call-5",
      { nonsense: true },
      toolContext("sess-other"),
      hooks("tester", [makeRole("tester", { "computer_*": false })]),
    );
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("unreachable");
    expect(rejected.error).toContain("nonsense");
  });

  it("is inert when the gate is off or the seam is absent", async () => {
    const gateOff = await interceptToolBefore(
      "computer_screenshot",
      "call-6",
      { dry_run: true },
      toolContext("sess-off"),
      { computerUse: { enabled: false, activeRoleFor: () => "tester", roles: () => [makeRole("tester")] } },
    );
    expect(gateOff.ok).toBe(true);

    const noSeam = await interceptToolBefore(
      "computer_screenshot",
      "call-7",
      { dry_run: true },
      toolContext("sess-none"),
      {},
    );
    expect(noSeam.ok).toBe(true);
  });
});
