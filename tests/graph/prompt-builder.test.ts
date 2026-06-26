import { describe, it, expect } from "bun:test";
import {
  buildCollaborationBlock,
  buildSubagentRoleBlock,
} from "../../src/graph/prompt-builder";
import type { ResolvedGraph, GraphNodeRole } from "../../src/types";

function graph(overrides: Partial<ResolvedGraph> = {}): ResolvedGraph {
  return {
    edges: [],
    nodes: [],
    maxIterations: 3,
    exitEdges: [],
    ...overrides,
  };
}

function role(overrides: Partial<GraphNodeRole> = {}): GraphNodeRole {
  return {
    agentId: "agent-a",
    upstream: [],
    downstream: [],
    isEntryPoint: false,
    isExitPoint: false,
    ...overrides,
  };
}

describe("buildCollaborationBlock", () => {
  const meta = [
    { id: "researcher", name: "Researcher", description: "Researches topics" },
    { id: "writer", name: "Writer", description: "Writes content" },
    { id: "editor", name: "Editor", description: "Edits content" },
    { id: "coder", name: "Coder", description: "Writes code" },
    { id: "reviewer", name: "Reviewer", description: "Reviews code" },
  ];

  describe("pipeline", () => {
    it("generates ordered steps with correct agent IDs and task() syntax", () => {
      const g = graph({
        template: "pipeline",
        nodes: ["researcher", "writer", "editor"],
        edges: [
          { from: "parent", to: "researcher" },
          { from: "researcher", to: "writer" },
          { from: "writer", to: "editor" },
          { from: "editor", to: "parent", exit: true },
        ],
        exitEdges: [{ from: "editor", to: "parent", exit: true }],
        maxIterations: 3,
      });

      const result = buildCollaborationBlock(g, meta);

      expect(result).toContain("<collaboration_graph>");
      expect(result).toContain("</collaboration_graph>");
      expect(result).toContain("<topology>pipeline</topology>");

      // Step 1
      expect(result).toContain(
        'task(subagent_type="researcher"',
      );
      // Step 2
      expect(result).toContain(
        'task(subagent_type="writer"',
      );
      // Step 3
      expect(result).toContain(
        'task(subagent_type="editor"',
      );
      // Final step — no further dispatching
      expect(result).toContain("Editor's output is the final result");
    });

    it("handles a single agent pipeline", () => {
      const g = graph({
        template: "pipeline",
        nodes: ["researcher"],
        edges: [
          { from: "parent", to: "researcher" },
          { from: "researcher", to: "parent", exit: true },
        ],
        exitEdges: [{ from: "researcher", to: "parent", exit: true }],
      });

      const result = buildCollaborationBlock(g, meta);

      expect(result).toContain('task(subagent_type="researcher"');
      expect(result).toContain("Researcher's output is the final result");
    });

    it("includes guard rules", () => {
      const g = graph({
        template: "pipeline",
        nodes: ["researcher"],
        edges: [
          { from: "parent", to: "researcher" },
          { from: "researcher", to: "parent", exit: true },
        ],
        exitEdges: [{ from: "researcher", to: "parent", exit: true }],
      });

      const result = buildCollaborationBlock(g, meta);

      expect(result).toContain("<routing_rules>");
      expect(result).toContain(
        "NEVER do specialist work yourself. Always dispatch via task()",
      );
      expect(result).toContain(
        "Never call more than one specialist in a single step.",
      );
      expect(result).toContain(
        "Always pass the previous step's context and output when dispatching the next step.",
      );
    });

    it("includes exit conditions with max iterations", () => {
      const g = graph({
        template: "pipeline",
        nodes: ["researcher"],
        edges: [
          { from: "parent", to: "researcher" },
          { from: "researcher", to: "parent", exit: true },
        ],
        exitEdges: [{ from: "researcher", to: "parent", exit: true }],
        maxIterations: 5,
      });

      const result = buildCollaborationBlock(g, meta);

      expect(result).toContain("<exit_conditions>");
      expect(result).toContain("max 5 iteration(s) reached");
    });

    it("falls back to custom when fan-out exists (Bug #11)", () => {
      // Pipeline [coder, reviewer, editor] with coder -> editor fan-out edge.
      // traceLinearPath follows coder -> reviewer (first edge), missing editor.
      const g = graph({
        template: "pipeline",
        nodes: ["coder", "reviewer", "editor"],
        edges: [
          { from: "parent", to: "coder" },
          { from: "coder", to: "reviewer" },
          { from: "coder", to: "editor" },         // fan-out branch
          { from: "reviewer", to: "parent", exit: true },
          { from: "editor", to: "parent", exit: true },
        ],
        exitEdges: [
          { from: "reviewer", to: "parent", exit: true },
          { from: "editor", to: "parent", exit: true },
        ],
        maxIterations: 3,
      });

      const result = buildCollaborationBlock(g, meta);

      // Falls back to custom because path.length (2) < nodes.length (3)
      expect(result).toContain("<topology>custom</topology>");
      expect(result).toContain("Editor");           // fan-out target included
      expect(result).toContain("Coder");
      expect(result).toContain("Reviewer");
    });
  });

  describe("review-loop", () => {
    it("contains loop instruction and exit condition", () => {
      const g = graph({
        template: "review-loop",
        nodes: ["coder", "reviewer"],
        edges: [
          { from: "parent", to: "coder" },
          { from: "coder", to: "reviewer" },
          { from: "reviewer", to: "coder", label: "loop" },
          { from: "reviewer", to: "parent", label: "exit", exit: true },
        ],
        exitEdges: [{ from: "reviewer", to: "parent", label: "exit", exit: true }],
        maxIterations: 3,
      });

      const result = buildCollaborationBlock(g, meta);

      expect(result).toContain("<topology>review-loop</topology>");
      expect(result).toContain('task(subagent_type="coder"');
      expect(result).toContain('task(subagent_type="reviewer"');
      // Loop instruction
      expect(result).toContain("may send work back to");
      expect(result).toContain("quality");
      // Exit condition should reference quality criteria
      expect(result).toContain("quality criteria");
    });

    it("handles three-agent review loop", () => {
      const g = graph({
        template: "review-loop",
        nodes: ["researcher", "writer", "editor"],
        edges: [
          { from: "parent", to: "researcher" },
          { from: "researcher", to: "writer" },
          { from: "writer", to: "editor" },
          { from: "editor", to: "researcher", label: "loop" },
          { from: "editor", to: "parent", label: "exit", exit: true },
        ],
        exitEdges: [{ from: "editor", to: "parent", label: "exit", exit: true }],
      });

      const result = buildCollaborationBlock(g, meta);

      expect(result).toContain("Researcher");
      expect(result).toContain("Writer");
      expect(result).toContain('task(subagent_type="editor"');
    });

    it("falls back to custom when fan-out exists (Bug #11)", () => {
      // Review-loop [coder, reviewer, editor] with coder -> editor fan-out edge.
      // traceLinearPath follows coder -> reviewer, missing editor.
      const g = graph({
        template: "review-loop",
        nodes: ["coder", "reviewer", "editor"],
        edges: [
          { from: "parent", to: "coder" },
          { from: "coder", to: "reviewer" },
          { from: "coder", to: "editor" },             // fan-out branch
          { from: "reviewer", to: "coder", label: "loop" },
          { from: "reviewer", to: "parent", exit: true },
          { from: "editor", to: "parent", exit: true },
        ],
        exitEdges: [
          { from: "reviewer", to: "parent", exit: true },
          { from: "editor", to: "parent", exit: true },
        ],
        maxIterations: 3,
      });

      const result = buildCollaborationBlock(g, meta);

      // Falls back to custom because path.length (2) < nodes.length (3)
      expect(result).toContain("<topology>custom</topology>");
      expect(result).toContain("Editor");               // fan-out target included
      expect(result).toContain("Coder");
      expect(result).toContain("Reviewer");
      expect(result).not.toContain("<topology>review-loop</topology>");
    });
  });

  describe("star", () => {
    it("lists all workers with parallel dispatch note", () => {
      const g = graph({
        template: "star",
        nodes: ["researcher", "writer", "editor"],
        edges: [
          { from: "parent", to: "researcher" },
          { from: "researcher", to: "parent", exit: true },
          { from: "parent", to: "writer" },
          { from: "writer", to: "parent", exit: true },
          { from: "parent", to: "editor" },
          { from: "editor", to: "parent", exit: true },
        ],
        exitEdges: [
          { from: "researcher", to: "parent", exit: true },
          { from: "writer", to: "parent", exit: true },
          { from: "editor", to: "parent", exit: true },
        ],
      });

      const result = buildCollaborationBlock(g, meta);

      expect(result).toContain("<topology>star</topology>");
      expect(result).toContain("V1 limitation");
      expect(result).toContain('task(subagent_type="researcher"');
      expect(result).toContain('task(subagent_type="writer"');
      expect(result).toContain('task(subagent_type="editor"');
      // Star doesn't include "previous step's context" rule
      expect(result).not.toContain("Always pass the previous step");
      // But it does have the first two guard rules
      expect(result).toContain("NEVER do specialist work yourself");
      expect(result).toContain("all agents have returned their outputs");
    });

    it("handles a single worker", () => {
      const g = graph({
        template: "star",
        nodes: ["researcher"],
        edges: [
          { from: "parent", to: "researcher" },
          { from: "researcher", to: "parent", exit: true },
        ],
        exitEdges: [{ from: "researcher", to: "parent", exit: true }],
      });

      const result = buildCollaborationBlock(g, meta);

      expect(result).toContain('task(subagent_type="researcher"');
    });
  });

  describe("custom", () => {
    it("generates routing from arbitrary edges", () => {
      const g = graph({
        nodes: ["researcher", "writer"],
        edges: [
          { from: "parent", to: "researcher" },
          { from: "researcher", to: "writer" },
          { from: "writer", to: "parent", exit: true },
        ],
        exitEdges: [{ from: "writer", to: "parent", exit: true }],
        maxIterations: 3,
      });

      const result = buildCollaborationBlock(g, meta);

      expect(result).toContain("<topology>custom</topology>");
      expect(result).toContain("Researcher");
      expect(result).toContain("Writer");
    });

    it("lists entry points, transitions, and exit points", () => {
      const g = graph({
        nodes: ["researcher", "writer"],
        edges: [
          { from: "parent", to: "researcher" },
          { from: "researcher", to: "writer" },
          { from: "writer", to: "parent", exit: true },
        ],
        exitEdges: [{ from: "writer", to: "parent", exit: true }],
      });

      const result = buildCollaborationBlock(g, meta);

      expect(result).toContain("dispatches initial work to");
      expect(result).toContain("Agent-to-agent transitions");
      expect(result).toContain("Exit points");
    });
  });

  describe("deterministic", () => {
    it("produces identical output for the same input", () => {
      const g = graph({
        template: "pipeline",
        nodes: ["researcher", "writer"],
        edges: [
          { from: "parent", to: "researcher" },
          { from: "researcher", to: "writer" },
          { from: "writer", to: "parent", exit: true },
        ],
        exitEdges: [{ from: "writer", to: "parent", exit: true }],
      });

      const result1 = buildCollaborationBlock(g, meta);
      const result2 = buildCollaborationBlock(g, meta);

      expect(result1).toBe(result2);
    });
  });

  describe("edge cases", () => {
    it("returns empty string for empty graph", () => {
      const g = graph({ nodes: [] });
      expect(buildCollaborationBlock(g, meta)).toBe("");
    });

    it("falls back to agent ID when name not in meta", () => {
      const g = graph({
        template: "pipeline",
        nodes: ["unknown-agent"],
        edges: [
          { from: "parent", to: "unknown-agent" },
          { from: "unknown-agent", to: "parent", exit: true },
        ],
        exitEdges: [{ from: "unknown-agent", to: "parent", exit: true }],
      });

      const result = buildCollaborationBlock(g, meta);

      expect(result).toContain('task(subagent_type="unknown-agent"');
      // Falls back to ID as display name
      expect(result).toContain("unknown-agent");
    });

    it("uses maxIterations from graph", () => {
      const g = graph({
        template: "pipeline",
        nodes: ["researcher"],
        edges: [
          { from: "parent", to: "researcher" },
          { from: "researcher", to: "parent", exit: true },
        ],
        exitEdges: [{ from: "researcher", to: "parent", exit: true }],
        maxIterations: 10,
      });

      const result = buildCollaborationBlock(g, meta);

      expect(result).toContain("max 10 iteration(s) reached");
    });
  });
});

describe("buildSubagentRoleBlock", () => {
  it("entry point agent says 'receive work from the orchestrator'", () => {
    const r = role({
      agentId: "researcher",
      isEntryPoint: true,
      downstream: ["writer"],
    });

    const result = buildSubagentRoleBlock(r);

    expect(result).toContain("<collaboration_role>");
    expect(result).toContain("</collaboration_role>");
    expect(result).toContain("You receive work from the orchestrator");
    expect(result).toContain("Your output will be passed to: writer");
  });

  it("exit point agent says 'output completes the workflow'", () => {
    const r = role({
      agentId: "editor",
      isExitPoint: true,
      upstream: ["writer"],
    });

    const result = buildSubagentRoleBlock(r);

    expect(result).toContain("Your output completes the workflow");
    expect(result).toContain("You receive work from: writer");
  });

  it("middle agent lists upstream and downstream", () => {
    const r = role({
      agentId: "writer",
      upstream: ["researcher"],
      downstream: ["editor"],
    });

    const result = buildSubagentRoleBlock(r);

    expect(result).toContain("middle agent");
    expect(result).toContain("receives work from: researcher");
    expect(result).toContain("passes output to: editor");
  });

  it("single agent is both entry and exit", () => {
    const r = role({
      agentId: "researcher",
      isEntryPoint: true,
      isExitPoint: true,
    });

    const result = buildSubagentRoleBlock(r);

    expect(result).toContain("You receive work from the orchestrator");
    expect(result).toContain("Your output completes the workflow");
  });

  it("exit point with no upstream still says output completes workflow", () => {
    const r = role({
      agentId: "editor",
      isExitPoint: true,
      upstream: [],
    });

    const result = buildSubagentRoleBlock(r);

    expect(result).toContain("Your output completes the workflow");
    expect(result).not.toContain("You receive work from");
  });

  it("entry point with no downstream does not mention output passing", () => {
    const r = role({
      agentId: "researcher",
      isEntryPoint: true,
      downstream: [],
    });

    const result = buildSubagentRoleBlock(r);

    expect(result).toContain("You receive work from the orchestrator");
    expect(result).not.toContain("Your output will be passed to");
  });

  it("middle agent with only upstream is concise", () => {
    const r = role({
      agentId: "writer",
      upstream: ["researcher", "coder"],
      downstream: [],
    });

    const result = buildSubagentRoleBlock(r);

    expect(result).toContain("middle agent");
    expect(result).toContain(
      "receives work from: researcher, coder",
    );
    expect(result).not.toContain("passes output to");
  });

  it("middle agent with only downstream is concise", () => {
    const r = role({
      agentId: "writer",
      upstream: [],
      downstream: ["editor"],
    });

    const result = buildSubagentRoleBlock(r);

    expect(result).toContain("middle agent");
    expect(result).toContain("passes output to: editor");
    expect(result).not.toContain("receives work from");
  });

  it("middle agent with neither upstream nor downstream is concise", () => {
    const r = role({
      agentId: "orphan",
      upstream: [],
      downstream: [],
    });

    const result = buildSubagentRoleBlock(r);

    expect(result).toContain("middle agent");
    expect(result).not.toContain("receives work");
    expect(result).not.toContain("passes output");
  });

  it("output is wrapped in collaboration_role XML", () => {
    const r = role({ isEntryPoint: true });

    const result = buildSubagentRoleBlock(r);

    expect(result).toMatch(/^<collaboration_role>/);
    expect(result).toMatch(/<\/collaboration_role>$/);
  });
});
