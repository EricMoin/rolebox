import { describe, expect, it } from "vitest";
import { buildGraphWorkerToolGrantBlock } from "../../src/prompt/graph-worker.ts";

describe("graph worker tool guidance", () => {
  it.each([undefined, "native", "discover", "code"] as const)(
    "separates baseline entry points from host tool grants in %s mode",
    mode => {
      const presentation = mode === undefined ? undefined : { mode };
      const block = buildGraphWorkerToolGrantBlock(["docs_read", "browse_*"], presentation);
      expect(block).toContain("Worker entry points are graph_submit_outcome");
      expect(block).toContain("inherits the parent's authorized task tools");
      expect(block).not.toContain("hashline_");
      expect(block).not.toContain("docs_read, browse_*");
      expect(block).toContain("Use them directly when exposed");
      expect(block).toContain("Graph control tools and recursive agent dispatch remain unavailable");
      expect(block).not.toContain("only tools you may call");
    },
  );

  it.each([{ declared: undefined }, { declared: [] }] as const)("states an absent host grant without freezing tool visibility: $declared", ({ declared }) => {
    const block = buildGraphWorkerToolGrantBlock(declared, { mode: "discover" });
    expect(block).toContain("inherits the parent's authorized task tools");
    expect(block).toContain("graph_worker_tools");
    expect(block).toContain("Discovery cannot grant additional permissions");
    expect(block).not.toContain("only tools you may call");
  });

  it("explains discovery before calling an activated native tool", () => {
    const block = buildGraphWorkerToolGrantBlock(["docs_*"], { mode: "discover" });
    expect(block).toContain("list/search authorized host tools");
    expect(block).toContain("describe a tool to load its schema before calling its exposed native entry point");
    expect(block).not.toContain("graph_worker_code");
  });

  it("explains discovery and JavaScript calls in code mode", () => {
    const block = buildGraphWorkerToolGrantBlock(["docs_*"], { mode: "code" });
    expect(block).toContain("list/search authorized host tools and inspect their schemas");
    expect(block).toContain("graph_worker_code to call them from JavaScript");
    expect(block).toContain("Discovery cannot grant additional permissions");
    expect(block).toContain("Submit the outcome separately using graph_submit_outcome");
  });

  it("uses the host's baseline without adding another host's command tool", () => {
    const block = buildGraphWorkerToolGrantBlock(["docs_read"], { mode: "code" }, ["bash", "graph_submit_outcome"]);
    expect(block).toContain("Worker entry points are bash, graph_submit_outcome, graph_worker_tools, graph_worker_code");
    expect(block).not.toContain("graph_worker_exec");
  });
});
