import { describe, expect, it } from "vitest";
import { createDshComputerContext } from "../../src/platform/adapters/dsh/computer-context.ts";
import { resolveDshSessionContext, type DshContextOptions } from "../../src/platform/adapters/dsh/session-context.ts";
import { installDshComputerUsePolicy } from "../../src/platform/adapters/dsh/role-tool-policy.ts";
import { COMPUTER_TOOL_NAMES } from "../../src/loader/computer-grants.ts";
import type { ResolvedRole } from "../../src/types.ts";

function role(id: string): ResolvedRole {
  return { id, config: { name: id, description: id, prompt: id }, prompt: id,
    skills: [], functions: [], references: [], subagents: [] };
}

function fixture() {
  const parent = role("parent");
  const child = { ...role("parent--child"), parentId: parent.id, inheritedFrom: {} };
  parent.subagents.push(child);
  let active: string | null = null;
  let tools: readonly string[] = COMPUTER_TOOL_NAMES;
  const options: DshContextOptions = {
    roles: () => [parent], activeRole: () => active, session: () => undefined, tools: () => tools,
  };
  return { options, parent, child, render: createDshComputerContext(options),
    active: (value: string | null) => { active = value; }, tools: (value: readonly string[]) => { tools = value; } };
}

describe("DSH computer workflow", () => {
  it("reads role and workspace from SDK snapshots, excluding inherited descriptors", () => {
    const f = fixture();
    f.active("parent");
    const session = { id: "child-session", header: { cwd: "/initial" }, inheritedEventCount: 1,
      snapshotEvents: () => [
        { type: "subagent/descriptor", data: { provider: "parent" } },
        { type: "subagent/descriptor", data: { provider: "parent--child" } },
        { type: "working-directory/change", data: { cwd: "/workspace" } },
      ] };
    const result = resolveDshSessionContext(f.options, { session });
    expect(result.roleId).toBe("parent--child");
    expect(result.directory).toBe("/workspace");
  });

  it("is available to the base agent and a role without configuration, only for registered tools", () => {
    const f = fixture();
    expect(f.render({})).toContain("computer_permissions");
    f.active("parent");
    expect(f.render({})).toContain("computer_screenshot");
    f.tools([]);
    expect(f.render({})).toBe("");
  });

  it("respects explicit role restrictions and does not advertise an unknown role", () => {
    const f = fixture();
    f.active("parent");
    f.parent.config.tools = { "computer_*": false, computer_status: true };
    const result = f.render({});
    expect(result).toContain("computer_status");
    expect(result).not.toContain("computer_permissions");
    expect(result).not.toContain("computer_screenshot");
    f.active("unknown");
    expect(f.render({})).toBe("");
  });

  it.each(["native", "discover", "code"] as const)("follows worker grants and %s presentation", mode => {
    const f = fixture();
    f.options.worker = () => ({ agent: "parent--child", declaredTools: ["computer_screenshot", "computer_permissions"], toolPresentation: { mode } });
    const result = f.render({ id: "worker" });
    expect(result).toContain("computer_permissions");
    expect(result).toContain("computer_screenshot");
    expect(result).not.toContain("computer_click");
    if (mode === "discover") expect(result).toContain('action="call"');
    if (mode === "code") expect(result).toContain("graph_worker_code");
    f.options.worker = () => ({ agent: "parent--child" });
    expect(f.render({ id: "worker" })).toContain("computer_screenshot");
    f.options.worker = () => ({ agent: "parent--child", declaredTools: [] });
    expect(f.render({ id: "worker" })).toBe("");
    f.options.worker = () => ({ agent: "parent--child", inheritedTools: [] });
    expect(f.render({ id: "worker" })).toBe("");
  });

  it("uses the child's own identity consistently in prompt and execution, including aliases", () => {
    const f = fixture();
    f.active("parent");
    f.parent.config.tools = { "computer_*": false };
    f.child.config.tools = { computer_click: false };
    const agent = { id: "child-session", session: { id: "child-session", inheritedEventCount: 1, events: [
      { type: "subagent/descriptor", data: { provider: "parent" } },
      { type: "subagent/descriptor", data: { provider: "parent--child" } },
    ] } };
    const names = new Map(COMPUTER_TOOL_NAMES.map(name => [name, `rolebox_${name}`]));
    f.options.names = () => names;
    f.tools([...names.values()]);
    let guard: Parameters<NonNullable<Parameters<typeof installDshComputerUsePolicy>[0]["tools"]["guard"]>>[0];
    const policy = installDshComputerUsePolicy({ enabled: true, roles: f.options.roles, activeRoleOf: () => "parent",
      roleOfExecution: exec => resolveDshSessionContext(f.options, exec.agent ?? {}).requestedRoleId ?? null,
      canonicalToolNameOf: name => name.replace(/^rolebox_/, ""),
      tools: { guard: callback => { guard = callback; return () => {}; } },
    });
    try {
      expect(f.render(agent)).toContain("rolebox_computer_screenshot");
      expect(f.render(agent)).not.toContain("rolebox_computer_click");
      expect(guard!({ name: "rolebox_computer_screenshot", agent })).toBeUndefined();
      expect(guard!({ name: "rolebox_computer_click", agent })).toContain("denied");
    } finally { policy.dispose(); }
  });
});
