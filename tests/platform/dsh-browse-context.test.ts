
/**
 * The dsh browse workflow block — registered set, role grant, worker grant and
 * collision aliases.
 *
 * `createDshBrowseContext` (src/platform/adapters/dsh/browse-context.ts) is the
 * browse counterpart of the computer context: it advertises a `browse_*` tool
 * only when the host registered it AND the acting role's `tools:` map grants it
 * AND — for a graph worker — the node's declared grant admits it. The rendered
 * block is rewritten to the registered aliases, so the prompt names the tool the
 * model must actually call.
 */

import { describe, expect, it } from "vitest";
import { createDshBrowseContext } from "../../src/platform/adapters/dsh/browse-context.ts";
import type { DshContextOptions } from "../../src/platform/adapters/dsh/session-context.ts";
import { BROWSE_TOOL_NAMES } from "../../src/loader/browse-grants.ts";
import { COMPUTER_TOOL_NAMES } from "../../src/loader/computer-grants.ts";
import type { ResolvedRole } from "../../src/types.ts";

function role(id: string, tools?: Record<string, boolean>): ResolvedRole {
  return {
    id,
    config: { name: id, description: id, prompt: id, ...(tools === undefined ? {} : { tools }) },
    prompt: id,
    skills: [],
    functions: [],
    references: [],
    subagents: [],
  };
}

function fixture() {
  const parent = role("parent");
  const child = { ...role("parent--child"), parentId: parent.id, inheritedFrom: {} };
  parent.subagents.push(child);
  let active: string | null = null;
  let tools: readonly string[] = BROWSE_TOOL_NAMES;
  const options: DshContextOptions = {
    roles: () => [parent],
    activeRole: () => active,
    session: () => undefined,
    tools: () => tools,
  };
  return {
    options,
    parent,
    child,
    render: createDshBrowseContext(options),
    active: (value: string | null) => {
      active = value;
    },
    tools: (value: readonly string[]) => {
      tools = value;
    },
  };
}

describe("DSH browse workflow", () => {
  it("teaches the workflow for the registered tools, and nothing when none is registered", () => {
    const f = fixture();
    const base = f.render({});
    expect(base).toContain("browse_snapshot");
    expect(base).toContain("browse_open");
    expect(base).toContain("browse_close");
    f.tools([]);
    expect(f.render({})).toBe("");
  });

  it("only advertises the tools the host registered", () => {
    const f = fixture();
    f.tools(["browse_status"]);
    const result = f.render({});
    expect(result).toContain("browse_status");
    expect(result).not.toContain("browse_snapshot");
    expect(result).not.toContain("browse_click");
  });

  it("ignores a registered tool from another family", () => {
    const f = fixture();
    f.tools(COMPUTER_TOOL_NAMES);
    expect(f.render({})).toBe("");
  });

  it("respects explicit role restrictions and does not advertise an unknown role", () => {
    const f = fixture();
    f.active("parent");
    f.parent.config.tools = { "browse_*": false, browse_status: true };
    const result = f.render({});
    expect(result).toContain("browse_status");
    expect(result).not.toContain("browse_snapshot");
    expect(result).not.toContain("browse_click");
    f.active("unknown");
    expect(f.render({})).toBe("");
  });

  it.each(["native", "discover", "code"] as const)("follows worker grants and %s presentation", mode => {
    const f = fixture();
    f.options.worker = () => ({
      agent: "parent--child",
      declaredTools: ["browse_open", "browse_snapshot"],
      toolPresentation: { mode },
    });
    const result = f.render({ id: "worker" });
    expect(result).toContain("browse_open");
    expect(result).toContain("browse_snapshot");
    expect(result).not.toContain("browse_click");
    if (mode === "discover") expect(result).toContain('action="call"');
    if (mode === "code") expect(result).toContain("graph_worker_code");
    // A worker with no declared grant browses nothing.
    f.options.worker = () => ({ agent: "parent--child" });
    expect(f.render({ id: "worker" })).toBe("");
    f.options.worker = () => ({ agent: "parent--child", declaredTools: [] });
    expect(f.render({ id: "worker" })).toBe("");
  });

  it("rewrites every name to the registered collision alias", () => {
    const f = fixture();
    f.active("parent");
    const names = new Map(BROWSE_TOOL_NAMES.map(name => [name, `rolebox_${name}`]));
    f.options.names = () => names;
    f.tools([...names.values()]);
    const result = f.render({});
    expect(result).toContain("rolebox_browse_snapshot");
    expect(result).toContain("rolebox_browse_close");
    expect(result).not.toMatch(/(^|[^_a-z])browse_snapshot/);
  });

  it("uses the child's own identity, including its restrictions", () => {
    const f = fixture();
    f.active("parent");
    f.parent.config.tools = { "browse_*": false };
    f.child.config.tools = { browse_click: false };
    const agent = {
      id: "child-session",
      session: {
        id: "child-session",
        inheritedEventCount: 1,
        events: [
          { type: "subagent/descriptor", data: { provider: "parent" } },
          { type: "subagent/descriptor", data: { provider: "parent--child" } },
        ],
      },
    };
    const result = f.render(agent);
    // The parent's blanket denial does not follow the child…
    expect(result).toContain("browse_snapshot");
    // …but the child's own exact denial does.
    expect(result).not.toContain("browse_click");
  });
});
