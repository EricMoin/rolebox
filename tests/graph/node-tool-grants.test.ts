import { describe, expect, it } from "vitest";
import { compileGraph } from "../../src/graph/compiler/compile.ts";
import { parseGraphDeclarationV3, type DeclarationV3ErrorCode } from "../../src/graph/compiler/parse-declaration-v3.ts";
import { createPersistedCompiledPlan, declaredNodeTools } from "../../src/graph/compiler/plan.ts";
import { workerTaskToolAllowed, declaredToolsAllow, declaredToolAllows } from "../../src/graph/host/tool-binding.ts";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";

function declaration(tools?: string[]): GraphDeclarationV3 {
  return { version: 3, name: "legacy-node-tools", nodes: [{
    id: "worker", agent: "worker", prompt: "Inspect", outcomes: [{ id: "done" }],
    ...(tools === undefined ? {} : { tools }),
  }], edges: [] };
}

describe("legacy node tools compatibility", () => {
  it.each([{ tools: undefined }, { tools: [] }, { tools: ["docs_read"] }, { tools: ["missing_lookup", "graph_*"] }])(
    "ignores the node list for task authorization: $tools", ({ tools }) => {
      const graph = declaration(tools);
      const parsed = parseGraphDeclarationV3(graph);
      expect(parsed.ok).toBe(true);
      const compiled = compileGraph(graph);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) throw new Error("Fixture must compile");
      expect(declaredNodeTools(createPersistedCompiledPlan(compiled.plan), "worker")).toEqual(tools?.slice().sort());
      for (const name of ["hashline_read", "hashline_edit", "docs_read"]) {
        expect(workerTaskToolAllowed(name, tools, ["hashline_read", "hashline_edit", "docs_read"])).toBe(true);
      }
      expect(workerTaskToolAllowed("private_lookup", tools, ["hashline_read"])).toBe(false);
    },
  );

  it("normalizes legacy lists without using them as capability grants", () => {
    const parsed = parseGraphDeclarationV3(declaration([" docs_write ", "docs_read", "docs_read"]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("Fixture must parse");
    expect(parsed.declaration.nodes[0].tools).toEqual(["docs_read", "docs_write"]);
    expect(workerTaskToolAllowed("hashline_edit", parsed.declaration.nodes[0].tools, ["hashline_edit"])).toBe(true);
  });

  it.each(["graph_control", "graph_status", "rb_graph_control", "dispatch", "rb_dispatch", "team_create", "task", "task_retry", "session_fork"])(
    "keeps orchestration unavailable even when inherited and listed: %s", name => {
      expect(workerTaskToolAllowed(name, [name, "rb_*", "graph_*"], [name])).toBe(false);
    },
  );

  it("retains allow-list matching for parent catalogs and broker sessions", () => {
    expect(declaredToolsAllow("docs_read", ["docs_*"])).toBe(true);
    expect(declaredToolsAllow("private_read", ["docs_*"])).toBe(false);
    expect(declaredToolsAllow("docs_read", [])).toBe(false);
    expect(declaredToolsAllow("docs_read", undefined)).toBe(true);
  });
});

function declarationWith(extra: Record<string, unknown>, nodeCount = 1): unknown {
  const nodes: unknown[] = [];
  for (let index = 0; index < nodeCount; index++) {
    nodes.push({
      id: "alpha" + (index === 0 ? "" : String(index)),
      agent: "agent.alpha",
      prompt: "Do alpha.",
      outcomes: [{ id: "done" }],
      ...(index === 0 ? extra : {}),
    });
  }
  return { version: 3, name: "node-tool-grants.grammar", nodes, edges: [] };
}

describe("legacy v3 node `tools` grammar", () => {
  it("accepts a trailing-star prefix and normalizes the retained set", () => {
    const parsed = parseGraphDeclarationV3(
      declarationWith({ tools: [" computer_b ", "computer_a", "computer_a", "computer_*"] }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Trimmed, de-duplicated and sorted: the retained value IS the grant the
    // boundary matches on, so two spellings of one node compare equal.
    expect(parsed.declaration.nodes[0].tools).toEqual([
      "computer_*",
      "computer_a",
      "computer_b",
    ]);
  });

  it("preserves an absent field so workers inherit parent task tools", () => {
    const parsed = parseGraphDeclarationV3(declarationWith({}));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect("tools" in parsed.declaration.nodes[0]).toBe(false);
  });

  it("accepts exactly 32 entries and refuses 33", () => {
    const names = (count: number) => Array.from({ length: count }, (_, i) => "tool_" + i);
    expect(parseGraphDeclarationV3(declarationWith({ tools: names(32) })).ok).toBe(true);
    const tooMany = parseGraphDeclarationV3(declarationWith({ tools: names(33) }));
    expect(tooMany.ok).toBe(false);
    if (tooMany.ok) return;
    expect(tooMany.errors.map((entry) => entry.code)).toContain("invalid-value");
    expect(tooMany.errors[0].path).toBe("$.nodes[0].tools");
  });

  it("refuses a blank entry, a non-string entry and a non-array", () => {
    const cases: Array<{ readonly extra: Record<string, unknown>; readonly code: DeclarationV3ErrorCode; readonly path: string }> = [
      { extra: { tools: ["   "] }, code: "invalid-value", path: "$.nodes[0].tools[0]" },
      { extra: { tools: ["computer_*", 7] }, code: "wrong-type", path: "$.nodes[0].tools[1]" },
      { extra: { tools: "computer_*" }, code: "wrong-type", path: "$.nodes[0].tools" },
    ];
    for (const entry of cases) {
      const parsed = parseGraphDeclarationV3(declarationWith(entry.extra));
      expect(parsed.ok, JSON.stringify(entry.extra)).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.errors.map((issue) => issue.code)).toContain(entry.code);
      expect(parsed.errors.map((issue) => issue.path)).toContain(entry.path);
    }
  });

  it("refuses an unknown node key instead of ignoring it (the grammar stays closed)", () => {
    const parsed = parseGraphDeclarationV3(declarationWith({ toools: ["computer_*"] }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.map((issue) => issue.code)).toContain("unknown-key");
    expect(parsed.errors.map((issue) => issue.path)).toContain("$.nodes[0].toools");
  });
});

// ── (e) The compiled and persisted plan ─────────────────────────────────────

describe("the compiled plan preserves legacy tool metadata", () => {
  const DECLARED: GraphDeclarationV3 = {
    version: 3,
    name: "node-tool-grants.plan",
    nodes: [
      {
        id: "alpha",
        agent: "agent.alpha",
        prompt: "Do alpha.",
        outcomes: [{ id: "done" }],
        tools: ["computer_*"],
      },
      { id: "beta", agent: "agent.beta", prompt: "Do beta.", outcomes: [{ id: "done" }] },
    ],
    edges: [],
  };

  it("preserves the field per node, and preserves ABSENCE for the others", () => {
    const compiled = compileGraph(DECLARED);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const alpha = compiled.plan.nodes.find((node) => node.id === "alpha");
    const beta = compiled.plan.nodes.find((node) => node.id === "beta");
    expect(alpha?.tools).toEqual(["computer_*"]);
    expect(beta !== undefined && "tools" in beta).toBe(false);
  });

  it("survives the persisted (JSON) round trip and the defensive plan reader", () => {
    const compiled = compileGraph(DECLARED);
    if (!compiled.ok) throw new Error("fixture: the declaration did not compile");
    const record = createPersistedCompiledPlan(compiled.plan);
    const reread: unknown = JSON.parse(JSON.stringify(record));
    expect(declaredNodeTools(reread, "alpha")).toEqual(["computer_*"]);
    expect(declaredNodeTools(reread, "beta")).toBeUndefined();
    expect(declaredNodeTools(reread, "missing")).toEqual([]);
    expect(declaredNodeTools(null, "alpha")).toEqual([]);
    expect(declaredNodeTools({ nodes: [{ id: "alpha", tools: [1] }] }, "alpha")).toEqual([]);
  });
});

// ── The matcher itself ──────────────────────────────────────────────────────

describe("parent-catalog allow-list matching", () => {
  it("admits an exact name or a trailing-star prefix, and nothing else", () => {
    expect(declaredToolAllows("computer_screenshot", "computer_screenshot")).toBe(true);
    expect(declaredToolAllows("computer_screenshot", "computer_click")).toBe(false);
    expect(declaredToolAllows("computer_*", "computer_click")).toBe(true);
    expect(declaredToolAllows("computer_*", "browser_open")).toBe(false);
    // A bare star has no stem to name, so it admits nothing rather than
    // granting the whole host tool surface.
    expect(declaredToolAllows("*", "computer_click")).toBe(false);
  });

  it("supports unrestricted and empty parent catalogs", () => {
    expect(declaredToolsAllow("computer_click", undefined)).toBe(true);
    expect(declaredToolsAllow("computer_click", [])).toBe(false);
    expect(declaredToolsAllow("computer_click", ["computer_*"])).toBe(true);
  });
});
