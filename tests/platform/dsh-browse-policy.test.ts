
/**
 * The dsh browse-use guard — per-role enforcement, fail closed.
 *
 * `installDshBrowseUsePolicy` shares the computer family's installer
 * (src/platform/adapters/dsh/role-tool-policy.ts): the gate and the grant
 * decision differ, the enforcement and the refusal paths must not. These tests
 * pin the browse side AND the fact that both families can be installed on one
 * host registry without shadowing each other.
 */

import { describe, it, expect } from "vitest";
import {
  dshGuardSessionId,
  installDshBrowseUsePolicy,
  installDshComputerUsePolicy,
  isBrowseUseRegistrationAllowed,
  isComputerUseRegistrationAllowed,
  type DshToolGuardExecution,
  type DshToolGuardRegistry,
} from "../../src/platform/adapters/dsh/role-tool-policy.ts";
import {
  BROWSE_TOOL_NAMES,
  BROWSE_TOOL_WILDCARD,
} from "../../src/loader/browse-grants.ts";
import { COMPUTER_TOOL_NAMES } from "../../src/loader/computer-grants.ts";
import type { ResolvedRole, ResolvedSubAgent } from "../../src/types.ts";

function makeRole(id: string, tools?: Record<string, boolean>): ResolvedRole {
  return {
    id,
    config: { name: id, description: "", prompt: "", ...(tools === undefined ? {} : { tools }) },
    prompt: "",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
  };
}

const NO_ROLES: ResolvedRole[] = [];

/** A recording `ctx.tools` double: keeps every installed guard, in order. */
function guardDouble(options: { withGuard?: boolean; disposer?: boolean } = {}) {
  const guards: Array<(execution: DshToolGuardExecution) => string | undefined> = [];
  let disposals = 0;
  const registry: DshToolGuardRegistry = options.withGuard === false
    ? {}
    : {
        guard(guard: (execution: DshToolGuardExecution) => string | undefined) {
          guards.push(guard);
          if (options.disposer === false) return undefined;
          return () => {
            disposals++;
            const index = guards.indexOf(guard);
            if (index >= 0) guards.splice(index, 1);
          };
        },
      };
  return {
    registry,
    /** Run every installed guard; the first refusal wins, as the host's does. */
    evaluate(execution: DshToolGuardExecution): string | undefined {
      for (const guard of guards) {
        const refusal = guard(execution);
        if (refusal !== undefined) return refusal;
      }
      return undefined;
    },
    installed: () => guards.length,
    disposals: () => disposals,
  };
}

describe("dsh browse-use registration gate", () => {
  it("never admits a browse_* name while the gate is off, and always when it is on", () => {
    for (const name of BROWSE_TOOL_NAMES) {
      expect(isBrowseUseRegistrationAllowed(name, false), name).toBe(false);
      expect(isBrowseUseRegistrationAllowed(name, true), name).toBe(true);
    }
    // The check is namespace-scoped and gate-independent for every other tool.
    expect(isBrowseUseRegistrationAllowed("hashline_read", false)).toBe(true);
    expect(isBrowseUseRegistrationAllowed("computer_screenshot", false)).toBe(true);
    expect(isBrowseUseRegistrationAllowed("browse_future_tool", false)).toBe(false);
    // The computer predicate never filters the browse namespace.
    expect(isComputerUseRegistrationAllowed("browse_open", false)).toBe(true);
  });
});

describe("dsh browse-use guard — per-role enforcement", () => {
  it("denies a role that explicitly disables the family", () => {
    const double = guardDouble();
    const policy = installDshBrowseUsePolicy({
      tools: double.registry,
      enabled: true,
      activeRoleOf: sessionId => (sessionId === "sess-1" ? "tester" : null),
      roles: () => [makeRole("tester", { "browse_*": false })],
    });
    expect(policy.gateEnabled).toBe(true);
    expect(policy.guardInstalled).toBe(true);
    expect(policy.allowRegistration).toBe(true);
    expect(double.installed()).toBe(1);

    const reason = double.evaluate({ name: "browse_click", agent: { id: "agent-1", session: { id: "sess-1" } } });
    expect(reason).toBeDefined();
    expect(reason!).toContain('"tester"');
    expect(reason!).toContain("browse_click");
    // Other families and unrelated tools are left alone.
    expect(double.evaluate({ name: "computer_screenshot", agent: { session: { id: "sess-1" } } })).toBeUndefined();
    expect(double.evaluate({ name: "hashline_read", agent: { session: { id: "sess-1" } } })).toBeUndefined();

    policy.dispose();
    expect(double.disposals()).toBe(1);
    expect(double.installed()).toBe(0);
  });

  it("allows the base agent and a role without browse rules", () => {
    const double = guardDouble();
    installDshBrowseUsePolicy({
      tools: double.registry,
      enabled: true,
      activeRoleOf: () => "operator",
      roles: () => [makeRole("operator", { [BROWSE_TOOL_WILDCARD]: true })],
    });
    expect(double.evaluate({ name: "browse_open", agent: { id: "a" } })).toBeUndefined();
    expect(double.evaluate({ name: "browse_close", agent: { id: "a" } })).toBeUndefined();

    const base = guardDouble();
    installDshBrowseUsePolicy({
      tools: base.registry,
      enabled: true,
      activeRoleOf: () => null,
      roles: () => [makeRole("tester", { "browse_*": false })],
    });
    expect(base.evaluate({ name: "browse_open", agent: { id: "a" } })).toBeUndefined();
  });

  it("denies an unknown role instead of assuming it unrestricted", () => {
    const double = guardDouble();
    installDshBrowseUsePolicy({
      tools: double.registry,
      enabled: true,
      activeRoleOf: () => "ghost",
      roles: () => NO_ROLES,
    });
    expect(double.evaluate({ name: "browse_open", agent: { id: "a" } })).toContain('"ghost"');
  });

  it("uses the execution role instead of an inherited parent selection", () => {
    const parent = makeRole("parent", { "browse_*": false });
    const child: ResolvedSubAgent = { ...makeRole("parent--child", { browse_click: false }), parentId: parent.id, inheritedFrom: {} };
    parent.subagents.push(child);
    let roleId: string | null = child.id;
    const double = guardDouble();
    installDshBrowseUsePolicy({
      tools: double.registry,
      enabled: true,
      activeRoleOf: () => parent.id,
      roleOfExecution: () => roleId,
      roles: () => [parent],
    });
    expect(double.evaluate({ name: "browse_snapshot", agent: { id: "child-session" } })).toBeUndefined();
    expect(double.evaluate({ name: "browse_click", agent: { id: "child-session" } })).toContain(child.id);
    roleId = null;
    expect(double.evaluate({ name: "browse_click", agent: { id: "child-session" } })).toBeUndefined();
    roleId = "missing-child";
    expect(double.evaluate({ name: "browse_click", agent: { id: "child-session" } })).toContain("missing-child");
  });

  it("checks collision aliases against the canonical rule", () => {
    const names = new Map<string, string>();
    const double = guardDouble();
    installDshBrowseUsePolicy({
      tools: double.registry,
      enabled: true,
      activeRoleOf: () => "operator",
      canonicalToolNameOf: name => names.get(name),
      roles: () => [makeRole("operator", { browse_click: false })],
    });
    names.set("rolebox_browse_click", "browse_click");
    expect(double.evaluate({ name: "rolebox_browse_click" })).toContain("browse_click");
    expect(double.evaluate({ name: "browse_click" })).toContain("browse_click");
    expect(double.evaluate({ name: "browse_snapshot" })).toBeUndefined();
    expect(double.evaluate({ name: "rolebox_memory_read" })).toBeUndefined();
  });

  it("enforces an exact denial before a family grant", () => {
    const double = guardDouble();
    installDshBrowseUsePolicy({
      tools: double.registry,
      enabled: true,
      activeRoleOf: () => "operator",
      roles: () => [makeRole("operator", { [BROWSE_TOOL_WILDCARD]: true, browse_eval: false })],
    });
    expect(double.evaluate({ name: "browse_eval", agent: { id: "a" } })).toContain("browse_eval: true");
    expect(double.evaluate({ name: "browse_read", agent: { id: "a" } })).toBeUndefined();
  });

  it("installs nothing and refuses registration when the gate is off", () => {
    const double = guardDouble();
    const policy = installDshBrowseUsePolicy({
      tools: double.registry,
      enabled: false,
      activeRoleOf: () => "tester",
      roles: () => [makeRole("tester", { [BROWSE_TOOL_WILDCARD]: true })],
    });
    expect(policy.gateEnabled).toBe(false);
    expect(policy.guardInstalled).toBe(false);
    expect(policy.allowRegistration).toBe(false);
    expect(double.installed()).toBe(0);
    expect(policy.reason).toContain("disabled");
    expect(policy.reason).toContain("browse_*");
  });

  it("FAILS CLOSED when the host exposes no ctx.tools.guard", () => {
    const double = guardDouble({ withGuard: false });
    const policy = installDshBrowseUsePolicy({
      tools: double.registry,
      enabled: true,
      activeRoleOf: () => "tester",
      roles: () => [makeRole("tester", { [BROWSE_TOOL_WILDCARD]: true })],
    });
    expect(policy.guardInstalled).toBe(false);
    expect(policy.allowRegistration).toBe(false);
    expect(policy.reason).toContain("ctx.tools.guard");
    expect(policy.reason).toContain("fail closed");
  });

  it("FAILS CLOSED when the guard seam returns no disposer", () => {
    const double = guardDouble({ disposer: false });
    const policy = installDshBrowseUsePolicy({
      tools: double.registry,
      enabled: true,
      activeRoleOf: () => "tester",
      roles: () => [makeRole("tester", { [BROWSE_TOOL_WILDCARD]: true })],
    });
    expect(policy.guardInstalled).toBe(false);
    expect(policy.allowRegistration).toBe(false);
    expect(policy.reason).toContain("no disposer");
    expect(policy.reason).toContain("fail closed");
    // The undelivered guard is never left enforcing (the seam owns it).
    policy.dispose();
  });

  it("runs beside the computer guard without shadowing it", () => {
    const double = guardDouble();
    const browse = installDshBrowseUsePolicy({
      tools: double.registry,
      enabled: true,
      activeRoleOf: () => "tester",
      roles: () => [makeRole("tester", { "browse_*": false })],
    });
    const computer = installDshComputerUsePolicy({
      tools: double.registry,
      enabled: true,
      activeRoleOf: () => "tester",
      roles: () => [makeRole("tester", { "computer_*": false })],
    });
    expect(double.installed()).toBe(2);
    expect(double.evaluate({ name: "browse_open" })).toContain("browse_open");
    expect(double.evaluate({ name: "computer_screenshot" })).toContain("computer_screenshot");
    expect(double.evaluate({ name: "web_search" })).toBeUndefined();
    browse.dispose();
    computer.dispose();
    expect(double.installed()).toBe(0);
    for (const name of COMPUTER_TOOL_NAMES) {
      expect(isComputerUseRegistrationAllowed(name, true)).toBe(true);
    }
  });

  it("resolves the guarded session from agent.session.id then agent.id", () => {
    expect(dshGuardSessionId({ name: "x", agent: { id: "a", session: { id: "s" } } })).toBe("s");
    expect(dshGuardSessionId({ name: "x", agent: { id: "a" } })).toBe("a");
    expect(dshGuardSessionId({ name: "x" })).toBe("");
  });
});
