import { describe, it, expect } from "bun:test";
import { collectOpenRoles } from "../src/resolver/open-roles.js";
import { RoleMode } from "../src/constants.ts";
import type { RoleConfig, ResolvedRole, ResolvedSubAgent } from "../src/types.js";

function makeSubagent(
  name: string,
  id: string,
  subagents: ResolvedSubAgent[] = [],
): ResolvedSubAgent {
  return {
    id,
    config: {
      name,
      description: `${name} description`,
      prompt: `You are ${name}.`,
      subagents: subagents.map((s) => s.config),
    },
    prompt: `You are ${name}.`,
    skills: [],
    functions: [],
    references: [],
    subagents,
    parentId: id.split("--").slice(0, -1).join("--"),
    inheritedFrom: {},
  };
}

function makeRole(
  id: string,
  opts: {
    name?: string;
    description?: string;
    open?: boolean;
    exports?: string[];
    subagents?: ResolvedSubAgent[];
  } = {},
): ResolvedRole {
  const config: RoleConfig = {
    name: opts.name ?? `Role ${id}`,
    description: opts.description ?? `Description of ${id}`,
    prompt: `You are ${id}.`,
    subagents: opts.subagents?.map((s) => s.config) ?? [],
  };
  if (opts.open !== undefined) config.open = opts.open;
  if (opts.exports !== undefined) config.exports = opts.exports;
  return {
    id,
    config,
    prompt: config.prompt,
    skills: [],
    functions: [],
    references: [],
    subagents: opts.subagents ?? [],
  };
}

describe("top-level teammate catalog", () => {
  it("discovers every top-level role regardless of legacy open configuration", () => {
    const roles = [
      makeRole("designer", { name: "Designer", description: "Design expertise", open: true }),
      makeRole("engineer"),
      makeRole("reviewer", { open: false }),
    ];
    const registry = collectOpenRoles(roles);
    expect([...registry.keys()]).toEqual(["designer", "engineer", "reviewer"]);
    expect(registry.get("designer")).toEqual({
      roleId: "designer", name: "Designer", description: "Design expertise", exports: [],
    });
  });

  it("includes top-level roles configured with subagent mode", () => {
    const role = makeRole("designer");
    role.config.mode = RoleMode.Subagent;
    expect(collectOpenRoles([role]).has("designer")).toBe(true);
  });

  it("ignores legacy exports without traversing or publishing child roles", () => {
    const role = makeRole("designer", {
      open: true,
      exports: ["helper", "nested", "missing"],
      subagents: [makeSubagent("helper", "designer--helper", [
        makeSubagent("nested", "designer--helper--nested"),
      ])],
    });
    const registry = collectOpenRoles([role]);
    expect([...registry.keys()]).toEqual(["designer"]);
    expect(registry.get("designer")!.exports).toEqual([]);
    expect(JSON.stringify([...registry.values()])).not.toContain("--");
  });

  it("rejects child ids accidentally passed as top-level roles", () => {
    const registry = collectOpenRoles([makeRole("designer"), makeRole("designer--helper")]);
    expect([...registry.keys()]).toEqual(["designer"]);
  });
});
