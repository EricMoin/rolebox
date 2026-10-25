import { describe, expect, it, vi } from "vitest";
import { buildCanonicalTools } from "../../src/platform/tool-assembly.ts";
import { opencodeCapabilities } from "../../src/platform/capabilities.ts";
import type { CanonicalToolDef } from "../../src/platform/types.ts";
import type { ResolvedRole, ResolvedSubAgent } from "../../src/types.ts";
import { makeToolContext } from "../asset/helpers.ts";

function roles(): ResolvedRole[] {
  const base = (id: string, subagents: ResolvedSubAgent[] = []): ResolvedRole => ({
    id, config: { name: id, description: id, prompt: id }, prompt: id,
    skills: [], functions: [], references: [], subagents,
  });
  const child = (id: string, subagents: ResolvedSubAgent[] = []): ResolvedSubAgent => ({
    ...base(id, subagents), parentId: id.split("--").slice(0, -1).join("--"), inheritedFrom: {},
  });
  return [
    base("engineer", [child("engineer--worker", [child("engineer--worker--nested")])]),
    base("designer", [child("designer--private")]),
  ];
}

function fixture(result = "host-result", getEffectiveAgent?: (sessionID?: string) => string | undefined) {
  const execute = vi.fn(async () => result);
  const graph: CanonicalToolDef = { description: "Host-bound graph tool", args: {}, execute };
  const tools = buildCanonicalTools({
    resolvedRoles: roles(), directory: "/tmp/rolebox-visibility", capabilities: opencodeCapabilities(),
    outcomeGraphTools: { graph_declare: graph }, getEffectiveAgent,
  });
  return { tool: tools.graph_declare, execute };
}

function declaration(agent: string) {
  return { version: 3, name: "visibility", nodes: [{ id: "work", agent, prompt: "Work", outcomes: [{ id: "done" }] }], edges: [] };
}

describe("graph role delegation boundary", () => {
  it("allows top-level teammates and the caller's direct children", async () => {
    const { tool, execute } = fixture();
    for (const target of ["designer", "engineer", "engineer--worker"]) {
      expect(await tool.execute({ declaration: declaration(target) }, makeToolContext({ agent: "engineer" }))).toBe("host-result");
    }
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("rejects foreign children and grandchildren before the host persists or starts work", async () => {
    const { tool, execute } = fixture();
    for (const target of ["designer--private", "engineer--worker--nested", "unregistered-role"]) {
      for (const input of [declaration(target), JSON.stringify(declaration(target))]) {
        const result = await tool.execute({ declaration: input }, makeToolContext({ agent: "engineer" }));
        expect(result).toContain("graph_declare refused");
      }
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("allows a nested caller's direct child while retaining foreign-child isolation", async () => {
    const { tool, execute } = fixture();
    const context = makeToolContext({ agent: "engineer--worker" });
    expect(await tool.execute({ declaration: declaration("engineer--worker--nested") }, context)).toBe("host-result");
    expect(await tool.execute({ declaration: declaration("designer--private") }, context)).toContain("graph_declare refused");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("preserves compatibility for empty and unknown external caller identities", async () => {
    const { tool, execute } = fixture();
    for (const agent of ["", "external-agent"]) {
      expect(await tool.execute({ declaration: declaration("external-worker") }, makeToolContext({ agent }))).toBe("host-result");
    }
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("resolves session attribution while retaining an explicitly known caller", async () => {
    const { tool, execute } = fixture("host-result", () => "engineer");
    expect(await tool.execute({ declaration: declaration("designer--private") }, makeToolContext({ agent: "" }))).toContain("graph_declare refused");
    expect(await tool.execute({ declaration: declaration("engineer--worker") }, makeToolContext({ agent: "host-session-agent" }))).toBe("host-result");
    expect(await tool.execute({ declaration: declaration("designer--private") }, makeToolContext({ agent: "designer" }))).toBe("host-result");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("keeps the underlying worker capability guard authoritative for permitted targets", async () => {
    const { tool, execute } = fixture("host-refused-worker-capability");
    const context = makeToolContext({ agent: "engineer--worker" });
    const input = { declaration: declaration("designer") };
    expect(await tool.execute(input, context)).toBe("host-refused-worker-capability");
    expect(execute).toHaveBeenCalledWith(input, context);
  });

  it("leaves malformed declaration diagnostics to the graph compiler", async () => {
    const { tool, execute } = fixture("compiler-refusal");
    expect(await tool.execute({ declaration: "invalid JSON" }, makeToolContext({ agent: "engineer" }))).toBe("compiler-refusal");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
