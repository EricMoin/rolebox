/**
 * Computer-use policy tests — the global gate, the per-role grants, and the
 * three enforcement surfaces that consume them.
 *
 * Covers:
 *   1. `src/loader/computer-use-gate.ts` — one resolution point, DEFAULT OFF:
 *      absent everywhere is false, any explicit `true` enables, a config typo
 *      fails closed, and the reason says which surface decided.
 *   2. `src/loader/computer-grants.ts` — a role grants with an exact name or
 *      the `computer_*` wildcard; absent, `false` and the opencode `"*"`
 *      wildcard are NOT grants.
 *   3. `src/prompt/agent-config.ts` — with the gate ON, every registered
 *      `computer_*` name a role does not grant is emitted as `false` (only
 *      then; with the gate OFF the map is untouched).
 *   4. `src/platform/adapters/dsh/role-tool-policy.ts` — the boot-time guard
 *      denies an ungranted call with a reason naming the role and the missing
 *      grant, allows a granted one, and FAILS CLOSED (no registration) when the
 *      host exposes no `ctx.tools.guard`.
 *   5. `src/platform/adapters/pi/tool-interceptor.ts` — the same decision per
 *      Pi invocation, returned as an error string (never thrown into Pi), with
 *      every non-computer tool left on the existing pipeline.
 *
 * @module
 */

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
import type { ResolvedRole } from "../src/types.ts";
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

describe("computer-use gate — default OFF, one resolution point", () => {
  const missing = "/nonexistent/rolebox/config-does-not-exist";

  it("is OFF when no surface sets computerUse", () => {
    const gate = resolveComputerUseGate({
      globalConfigPath: missing,
      projectConfigPath: `${missing}.json`,
    });
    expect(gate.enabled).toBe(false);
    expect(gate.host).toBe(false);
    expect(gate.globalConfig).toBe(false);
    expect(gate.projectConfig).toBe(false);
    // The reason names every surface consulted, so a boot log explains itself.
    expect(gate.reason).toContain("OFF");
    expect(gate.reason).toContain(missing);
  });

  it("is enabled by computerUse: true in the global config.yaml", () => {
    const globalConfigPath = writeFile("config.yaml", "computerUse: true\nregistries: []\n");
    const gate = resolveComputerUseGate({
      globalConfigPath,
      projectConfigPath: `${missing}.json`,
    });
    expect(gate.enabled).toBe(true);
    expect(gate.globalConfig).toBe(true);
    expect(gate.reason).toContain(globalConfigPath);
  });

  it("is enabled by computerUse: true in the project .rolebox/config.json", () => {
    const workspace = makeTmpDir("rolebox-workspace-");
    writeFileSync(
      join(workspace, "project.json"),
      JSON.stringify({ computerUse: true }),
      "utf-8",
    );
    const gate = resolveComputerUseGate({
      globalConfigPath: missing,
      projectConfigPath: join(workspace, "project.json"),
    });
    expect(gate.enabled).toBe(true);
    expect(gate.projectConfig).toBe(true);
  });

  it("is enabled by the host plugin option, which can only assert enablement", () => {
    const fromHost = resolveComputerUseGate({
      hostOverride: true,
      globalConfigPath: missing,
      projectConfigPath: `${missing}.json`,
    });
    expect(fromHost.enabled).toBe(true);
    expect(fromHost.host).toBe(true);

    // A schema-defaulted `false` means "unset", so it never vetoes a user's
    // explicit config-file opt-in.
    const configOnly = resolveComputerUseGate({
      hostOverride: false,
      globalConfigPath: writeFile("config.yaml", "computerUse: true\n"),
      projectConfigPath: `${missing}.json`,
    });
    expect(configOnly.enabled).toBe(true);
  });

  it("fails CLOSED on a non-boolean value (a config typo is not enablement)", () => {
    expect(readComputerUseFromYamlFile(writeFile("config.yaml", 'computerUse: "true"\n'))).toBe(false);
    expect(readComputerUseFromYamlFile(writeFile("config.yaml", "computerUse: 1\n"))).toBe(false);
    expect(readComputerUseFromJsonFile(writeFile("config.json", '{"computerUse":"yes"}'))).toBe(false);
    expect(readComputerUseFromJsonFile(writeFile("config.json", '{"computerUse":1}'))).toBe(false);
  });

  it("treats a missing or malformed file as absent instead of throwing", () => {
    expect(readComputerUseFromYamlFile("/nonexistent/config.yaml")).toBe(false);
    expect(readComputerUseFromJsonFile("/nonexistent/config.json")).toBe(false);
    expect(readComputerUseFromYamlFile(writeFile("config.yaml", "::: not yaml :::\n"))).toBe(false);
    expect(readComputerUseFromJsonFile(writeFile("config.json", "{not json"))).toBe(false);
    // A non-object root (a bare scalar/list) is not a config either.
    expect(readComputerUseFromYamlFile(writeFile("config.yaml", "- a\n"))).toBe(false);
    expect(readComputerUseFromJsonFile(writeFile("config.json", "[1]"))).toBe(false);
  });
});

// ── 2. Per-role grants ──────────────────────────────────────────────────────

describe("computer-use grants — explicit per-role opt-in", () => {
  it("covers the seven registered tools, and no more", () => {
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

  it("grants by exact name or by the computer_* wildcard", () => {
    expect(roleGrantsComputerTool({ computer_screenshot: true }, "computer_screenshot")).toBe(true);
    expect(roleGrantsComputerTool({ computer_screenshot: true }, "computer_click")).toBe(false);
    expect(roleGrantsComputerTool({ [COMPUTER_TOOL_WILDCARD]: true }, "computer_key")).toBe(true);
  });

  it("does NOT grant from an absent map, a false value, or the opencode '*' wildcard", () => {
    expect(roleGrantsComputerTool(undefined, "computer_screenshot")).toBe(false);
    expect(roleGrantsComputerTool({}, "computer_screenshot")).toBe(false);
    expect(roleGrantsComputerTool({ computer_screenshot: false }, "computer_screenshot")).toBe(false);
    // `"*"` is a generic allowance; screen control is never inherited from it.
    expect(roleGrantsComputerTool({ "*": true }, "computer_screenshot")).toBe(false);
    expect(roleGrantsComputerTool({ computer: true }, "computer_screenshot")).toBe(false);
  });

  it("denies with a reason naming the role and the missing grant", () => {
    const roles = [makeRole("tester")];
    const decision = decideComputerToolGrant({
      toolName: "computer_click",
      roleId: "tester",
      roles,
    });
    expect(decision.granted).toBe(false);
    if (decision.granted) throw new Error("unreachable");
    expect(decision.reason).toContain('"tester"');
    expect(decision.reason).toContain("computer_click");
    expect(decision.reason).toContain(`${COMPUTER_TOOL_WILDCARD}: true`);
  });

  it("denies the base agent (no active role) and an unknown role", () => {
    const base = decideComputerToolGrant({
      toolName: "computer_move",
      roleId: null,
      roles: [makeRole("tester", { [COMPUTER_TOOL_WILDCARD]: true })],
    });
    expect(base.granted).toBe(false);
    if (!base.granted) expect(base.reason).toContain("no active rolebox role");

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
});

// ── 3. opencode v1 + v2 emission ────────────────────────────────────────────

describe("opencode agent config — a non-opting role sees no callable computer tool", () => {
  it("leaves the tools map untouched while the gate is OFF", () => {
    const owned = { web_search: false, hashline_read: true };
    expect(withComputerUseDenials(owned, false)).toBe(owned);
    expect(withComputerUseDenials(undefined, false)).toBeUndefined();
    const config = buildAgentConfig(makeRole("tester", owned), { computerUse: false });
    expect(config.tools).toBe(owned);
    expect(config.tools?.computer_screenshot).toBeUndefined();
  });

  it("emits every ungranted registered name as false while the gate is ON", () => {
    const config = buildAgentConfig(makeRole("tester", { web_search: false }), {
      computerUse: true,
    });
    expect(config.tools).toBeDefined();
    expect(config.tools!.web_search).toBe(false);
    for (const name of COMPUTER_TOOL_NAMES) {
      expect(config.tools![name]).toBe(false);
    }
  });

  it("keeps an exact grant and a wildcard grant, denying only the rest", () => {
    const exact = withComputerUseDenials({ computer_click: true }, true)!;
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

  it("resolves the gate from the workspace's project config when no override is passed", () => {
    // A workspace whose `.rolebox/config.json` turns the gate on; the emission
    // must follow the FILE, not a default.
    const workspaceDir = makeTmpDir("rolebox-agent-config-workspace-");
    mkdirSync(join(workspaceDir, ".rolebox"), { recursive: true });
    writeFileSync(
      join(workspaceDir, ".rolebox", "config.json"),
      JSON.stringify({ computerUse: true }),
      "utf-8",
    );
    const role = makeRole("tester");
    const enabled = buildAgentConfig(role, { workspaceDir });
    expect(enabled.tools?.computer_screenshot).toBe(false);

    const elsewhere = makeTmpDir("rolebox-agent-config-other-");
    const disabled = buildAgentConfig(role, { workspaceDir: elsewhere });
    expect(disabled.tools).toBeUndefined();

    // The registered hint is what the opencode entries use; an explicit option
    // still wins over it.
    setAgentConfigWorkspace(workspaceDir);
    expect(buildAgentConfig(makeRole("tester")).tools?.computer_key).toBe(false);
    setAgentConfigWorkspace(undefined);
    expect(buildAgentConfig(makeRole("tester")).tools).toBeUndefined();
  });
});

// ── 4. dsh guard ────────────────────────────────────────────────────────────

describe("dsh computer-use guard — per-role enforcement, fail closed", () => {
  it("never registers a computer_* name while the gate is off", () => {
    expect(isComputerUseRegistrationAllowed("computer_screenshot", false)).toBe(false);
    expect(isComputerUseRegistrationAllowed("computer_windows", false)).toBe(false);
    // The check is namespace-independent: every other tool is untouched.
    expect(isComputerUseRegistrationAllowed("hashline_read", false)).toBe(true);
    expect(isComputerUseRegistrationAllowed("computer_screenshot", true)).toBe(true);
  });

  it("denies a role without the grant, naming the role and the missing grant", () => {
    const double = guardDouble();
    const policy = installDshComputerUsePolicy({
      tools: double.registry,
      enabled: true,
      activeRoleOf: (sessionId) => (sessionId === "sess-1" ? "tester" : null),
      roles: () => [makeRole("tester")],
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

  it("denies the base agent and an unknown role", () => {
    const double = guardDouble();
    installDshComputerUsePolicy({
      tools: double.registry,
      enabled: true,
      activeRoleOf: () => null,
      roles: () => [makeRole("tester", { [COMPUTER_TOOL_WILDCARD]: true })],
    });
    const baseReason = double.evaluate({ name: "computer_move", agent: { id: "agent-1" } });
    expect(baseReason).toContain("no active rolebox role");

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

  it("denies computer_* for a role without the grant and returns the reason", async () => {
    const outcome = await interceptToolBefore(
      "computer_screenshot",
      "call-1",
      { dry_run: true },
      toolContext("sess-deny"),
      hooks("tester", [makeRole("tester")]),
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
      hooks("tester", [makeRole("tester")], state),
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

  it("leaves every non-computer tool on the existing pipeline", async () => {
    // An unknown (unregistered) tool passes through untouched …
    const passthrough = await interceptToolBefore(
      "hashline_read",
      "call-4",
      { filePath: "/tmp/x" },
      toolContext("sess-other"),
      hooks("tester", [makeRole("tester")]),
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
      hooks("tester", [makeRole("tester")]),
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
