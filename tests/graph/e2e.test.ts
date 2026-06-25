/**
 * End-to-end integration tests for the collaboration graph feature.
 *
 * Exercises the full pipeline: graph resolution, prompt injection, backwards
 * compatibility, and runtime state tracking.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, cpSync } from "node:fs";
import path from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import type { PluginInput } from "@opencode-ai/plugin";
import type { Config } from "@opencode-ai/sdk";

import { discoverRoles } from "../../src/role-loader";
import { parseCollaboration } from "../../src/graph/parser";
import { graphSessionState } from "../../src/graph/state";
import { buildSubagentRoleBlock } from "../../src/graph/prompt-builder";
import type { ResolvedGraph, GraphNodeRole } from "../../src/types";
import RoleboxModule from "../../src/index";
const RoleboxPlugin = RoleboxModule.server;

const examplesDir = path.join(import.meta.dir, "..", "..", "examples");

// ── helpers ──────────────────────────────────────────────────────

function createPluginInput(directory: string): PluginInput {
  return {
    client: {} as never,
    project: {
      id: "test",
      worktree: directory,
      time: { created: Date.now() },
    },
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost:0"),
    $: {} as never,
  };
}

function emptyConfig(): Config {
  return {};
}

function childSlugs(subagentNames: string[]): string[] {
  return subagentNames.map((n) => n.toLowerCase().replace(/\s+/g, "-"));
}

// ── tests ────────────────────────────────────────────────────────

describe("Collaboration Graph E2E", () => {
  // ── A. Review Team — Graph Resolution ────────────────────────

  describe("Review Team — Graph Resolution", () => {
    it("discovers review-team role from examples/", async () => {
      const roles = await discoverRoles(examplesDir);
      expect(roles.has("review-team")).toBe(true);
    });

    it("review-team has collaboration config with review-loop topology", async () => {
      const roles = await discoverRoles(examplesDir);
      const rt = roles.get("review-team")!;

      expect(rt.collaboration).toBeDefined();
      expect(rt.collaboration!.topology).toBe("review-loop");
      expect(rt.collaboration!.agents).toEqual(["coder", "reviewer"]);
      expect(rt.collaboration!.max_iterations).toBe(3);
    });

    it("parseCollaboration resolves review-loop to correct edges", async () => {
      const roles = await discoverRoles(examplesDir);
      const rt = roles.get("review-team")!;
      const slugs = childSlugs(["Coder", "Reviewer"]);

      const graph = parseCollaboration(rt.collaboration!, slugs);
      expect(graph).not.toBeNull();
      const g = graph!;

      expect(g.edges.length).toBe(4);

      expect(g.edges.some((e) => e.from === "parent" && e.to === "coder")).toBe(true);
      expect(g.edges.some((e) => e.from === "coder" && e.to === "reviewer")).toBe(true);
      expect(
        g.edges.some((e) => e.from === "reviewer" && e.to === "coder" && e.label === "loop"),
      ).toBe(true);
      expect(
        g.edges.some((e) => e.from === "reviewer" && e.to === "parent" && e.exit === true),
      ).toBe(true);
    });

    it("resolved graph has correct metadata", async () => {
      const roles = await discoverRoles(examplesDir);
      const rt = roles.get("review-team")!;
      const slugs = childSlugs(["Coder", "Reviewer"]);

      const graph = parseCollaboration(rt.collaboration!, slugs)!;

      expect(graph.template).toBe("review-loop");
      expect(graph.maxIterations).toBe(3);
      expect(graph.nodes).toEqual(expect.arrayContaining(["coder", "reviewer"]));
      expect(graph.nodes.length).toBe(2);
      expect(graph.exitEdges.length).toBe(1);
      expect(graph.exitEdges[0].from).toBe("reviewer");
      expect(graph.exitEdges[0].to).toBe("parent");
    });
  });

  // ── B. Review Team — Full Plugin Prompt Verification ─────────

  describe("Review Team — Prompts", () => {
    it("parent prompt contains <collaboration_graph> with review-loop instructions", async () => {
      const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-graph-e2e-"));
      const roleboxDir = path.join(tmpDir, "rolebox");
      mkdirSync(roleboxDir, { recursive: true });

      const originalXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = tmpDir;

      try {
        cpSync(
          path.join(examplesDir, "review-team"),
          path.join(roleboxDir, "review-team"),
          { recursive: true },
        );

        const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
        const cfg = emptyConfig();
        await hooks.config!(cfg);

        const agents = cfg.agent ?? {};

        const parent = agents["review-team"]!;
        expect(parent).toBeDefined();
        expect(parent.prompt).toContain("You are a team lead");
        expect(parent.prompt).toContain("<collaboration_graph>");
        expect(parent.prompt).toContain("<topology>review-loop</topology>");
        expect(parent.prompt).toContain("<routing>");
        expect(parent.prompt).toContain("<exit_conditions>");
        expect(parent.prompt).toContain("<routing_rules>");
        expect(parent.prompt).toContain("max 3 iteration(s)");
        expect(parent.prompt).toContain("NEVER do specialist work yourself");
        expect(parent.prompt).toContain("Always pass the previous step's context");
        expect(parent.prompt).toContain("Dispatch initial work to coder");
        expect(parent.prompt).toContain("Collect coder's output");
        expect(parent.prompt).toContain("dispatch to reviewer");
        expect(parent.prompt).toContain("may send work back to coder");
        expect(parent.prompt).toContain("<available_subagents>");
        expect(parent.prompt).toContain("<id>review-team--coder</id>");
        expect(parent.prompt).toContain("<id>review-team--reviewer</id>");
      } finally {
        process.env.XDG_CONFIG_HOME = originalXdg;
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("Coder subagent prompt contains <collaboration_role> with entry-point info", async () => {
      const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-graph-e2e-"));
      const roleboxDir = path.join(tmpDir, "rolebox");
      mkdirSync(roleboxDir, { recursive: true });

      const originalXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = tmpDir;

      try {
        cpSync(
          path.join(examplesDir, "review-team"),
          path.join(roleboxDir, "review-team"),
          { recursive: true },
        );

        const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
        const cfg = emptyConfig();
        await hooks.config!(cfg);

        const agents = cfg.agent ?? {};

        const coder = agents["review-team--coder"]!;
        expect(coder).toBeDefined();
        expect(coder.mode).toBe("subagent");
        expect(coder.prompt).toContain("<collaboration_role>");
        expect(coder.prompt).toContain("You receive work from the orchestrator");
        expect(coder.prompt).toContain("Your output will be passed to: reviewer");
        expect((coder as Record<string, unknown>).hidden).toBe(true);
      } finally {
        process.env.XDG_CONFIG_HOME = originalXdg;
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("Reviewer subagent prompt contains <collaboration_role> with exit-point info", async () => {
      const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-graph-e2e-"));
      const roleboxDir = path.join(tmpDir, "rolebox");
      mkdirSync(roleboxDir, { recursive: true });

      const originalXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = tmpDir;

      try {
        cpSync(
          path.join(examplesDir, "review-team"),
          path.join(roleboxDir, "review-team"),
          { recursive: true },
        );

        const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
        const cfg = emptyConfig();
        await hooks.config!(cfg);

        const agents = cfg.agent ?? {};

        const reviewer = agents["review-team--reviewer"]!;
        expect(reviewer).toBeDefined();
        expect(reviewer.mode).toBe("subagent");
        expect(reviewer.prompt).toContain("<collaboration_role>");
        expect(reviewer.prompt).toContain("You receive work from: coder");
        expect(reviewer.prompt).toContain("Your output completes the workflow");
        expect((reviewer as Record<string, unknown>).hidden).toBe(true);
      } finally {
        process.env.XDG_CONFIG_HOME = originalXdg;
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ── C. Review Team Custom — Graph Resolution ─────────────────

  describe("Review Team Custom — Graph Resolution", () => {
    it("discovers review-team-custom role from examples/", async () => {
      const roles = await discoverRoles(examplesDir);
      expect(roles.has("review-team-custom")).toBe(true);
    });

    it("review-team-custom has flow array in collaboration config", async () => {
      const roles = await discoverRoles(examplesDir);
      const rtc = roles.get("review-team-custom")!;

      expect(rtc.collaboration).toBeDefined();
      expect(rtc.collaboration!.topology).toBeUndefined();
      expect(rtc.collaboration!.flow).toBeDefined();
      expect(Array.isArray(rtc.collaboration!.flow)).toBe(true);
      expect(rtc.collaboration!.flow!.length).toBe(5);
    });

    it("parseCollaboration resolves custom flow to correct edges", async () => {
      const roles = await discoverRoles(examplesDir);
      const rtc = roles.get("review-team-custom")!;
      const slugs = childSlugs(["Researcher", "Writer", "Editor"]);

      const graph = parseCollaboration(rtc.collaboration!, slugs);
      expect(graph).not.toBeNull();
      const g = graph!;

      expect(g.edges.length).toBeGreaterThanOrEqual(4);

      const researcherToWriter = g.edges.find(
        (e) => e.from === "researcher" && e.to === "writer",
      );
      expect(researcherToWriter).toBeDefined();
      expect(researcherToWriter!.label).toBe("research findings");

      const writerToEditor = g.edges.find(
        (e) => e.from === "writer" && e.to === "editor",
      );
      expect(writerToEditor).toBeDefined();
      expect(writerToEditor!.label).toBe("draft content");

      const editorToWriter = g.edges.find(
        (e) => e.from === "editor" && e.to === "writer" && e.label === "revision requests",
      );
      expect(editorToWriter).toBeDefined();

      const editorToParent = g.edges.find(
        (e) => e.from === "editor" && e.to === "parent" && e.exit === true,
      );
      expect(editorToParent).toBeDefined();
      expect(editorToParent!.label).toBe("approved");
    });

    it("resolved graph metadata for custom flow is correct", async () => {
      const roles = await discoverRoles(examplesDir);
      const rtc = roles.get("review-team-custom")!;
      const slugs = childSlugs(["Researcher", "Writer", "Editor"]);

      const graph = parseCollaboration(rtc.collaboration!, slugs);
      expect(graph).not.toBeNull();
      const g = graph!;

      expect(g.template).toBeUndefined();
      expect(g.maxIterations).toBe(2);
      expect(g.nodes).toEqual(
        expect.arrayContaining(["researcher", "writer", "editor"]),
      );
      expect(g.exitEdges.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── D. Review Team Custom — Full Plugin Prompt Verification ──

  describe("Review Team Custom — Prompts", () => {
    it("parent prompt contains <collaboration_graph> with custom topology", async () => {
      const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-graph-e2e-"));
      const roleboxDir = path.join(tmpDir, "rolebox");
      mkdirSync(roleboxDir, { recursive: true });

      const originalXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = tmpDir;

      try {
        cpSync(
          path.join(examplesDir, "review-team-custom"),
          path.join(roleboxDir, "review-team-custom"),
          { recursive: true },
        );

        const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
        const cfg = emptyConfig();
        await hooks.config!(cfg);

        const agents = cfg.agent ?? {};

        const parent = agents["review-team-custom"];
        if (!parent) return;

        expect(parent.prompt).toContain("<collaboration_graph>");
        expect(parent.prompt).toContain("<topology>custom</topology>");
        expect(parent.prompt).toContain("Researcher");
        expect(parent.prompt).toContain("Writer");
        expect(parent.prompt).toContain("Editor");
        expect(parent.prompt).toContain("researcher → writer");
        expect(parent.prompt).toContain("writer → editor");
        expect(parent.prompt).toContain("<exit_conditions>");
        expect(parent.prompt).toContain("max 2 iteration(s)");
        expect(parent.prompt).toContain("NEVER do specialist work yourself");
      } finally {
        process.env.XDG_CONFIG_HOME = originalXdg;
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("Researcher subagent prompt contains <collaboration_role> with entry-point info", async () => {
      const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-graph-e2e-"));
      const roleboxDir = path.join(tmpDir, "rolebox");
      mkdirSync(roleboxDir, { recursive: true });

      const originalXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = tmpDir;

      try {
        cpSync(
          path.join(examplesDir, "review-team-custom"),
          path.join(roleboxDir, "review-team-custom"),
          { recursive: true },
        );

        const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
        const cfg = emptyConfig();
        await hooks.config!(cfg);

        const agents = cfg.agent ?? {};

        const researcher = agents["review-team-custom--researcher"];
        if (!researcher) return;

        expect(researcher.mode).toBe("subagent");
        expect(researcher.prompt).toContain("<collaboration_role>");
        expect(researcher.prompt).toContain("You receive work from the orchestrator");
        expect(researcher.prompt).toContain("writer");
      } finally {
        process.env.XDG_CONFIG_HOME = originalXdg;
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("Writer subagent prompt contains <collaboration_role> with middle-agent info", async () => {
      const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-graph-e2e-"));
      const roleboxDir = path.join(tmpDir, "rolebox");
      mkdirSync(roleboxDir, { recursive: true });

      const originalXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = tmpDir;

      try {
        cpSync(
          path.join(examplesDir, "review-team-custom"),
          path.join(roleboxDir, "review-team-custom"),
          { recursive: true },
        );

        const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
        const cfg = emptyConfig();
        await hooks.config!(cfg);

        const agents = cfg.agent ?? {};

        const writer = agents["review-team-custom--writer"];
        if (!writer) return;

        expect(writer.mode).toBe("subagent");
        expect(writer.prompt).toContain("<collaboration_role>");
        expect(writer.prompt).toContain("researcher");
        expect(writer.prompt).toContain("editor");
        expect(writer.prompt).toContain("middle agent");
      } finally {
        process.env.XDG_CONFIG_HOME = originalXdg;
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("Editor subagent prompt contains <collaboration_role> with exit-point info", async () => {
      const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-graph-e2e-"));
      const roleboxDir = path.join(tmpDir, "rolebox");
      mkdirSync(roleboxDir, { recursive: true });

      const originalXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = tmpDir;

      try {
        cpSync(
          path.join(examplesDir, "review-team-custom"),
          path.join(roleboxDir, "review-team-custom"),
          { recursive: true },
        );

        const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
        const cfg = emptyConfig();
        await hooks.config!(cfg);

        const agents = cfg.agent ?? {};

        const editor = agents["review-team-custom--editor"];
        if (!editor) return;

        expect(editor.mode).toBe("subagent");
        expect(editor.prompt).toContain("<collaboration_role>");
        expect(editor.prompt).toContain("writer");
        expect(editor.prompt).toContain("Your output completes the workflow");
      } finally {
        process.env.XDG_CONFIG_HOME = originalXdg;
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ── E. Backwards Compatibility — team-lead ────────────────────

  describe("Backwards Compatibility", () => {
    it("team-lead role has no collaboration field", async () => {
      const roles = await discoverRoles(examplesDir);
      const tl = roles.get("team-lead")!;

      expect(tl).toBeDefined();
      expect(tl.collaboration).toBeUndefined();
    });

    it("team-lead parent prompt does NOT contain <collaboration_graph>", async () => {
      const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-graph-e2e-"));
      const roleboxDir = path.join(tmpDir, "rolebox");
      mkdirSync(roleboxDir, { recursive: true });

      const originalXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = tmpDir;

      try {
        cpSync(
          path.join(examplesDir, "team-lead"),
          path.join(roleboxDir, "team-lead"),
          { recursive: true },
        );

        const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
        const cfg = emptyConfig();
        await hooks.config!(cfg);

        const agents = cfg.agent ?? {};
        const tl = agents["team-lead"]!;

        expect(tl).toBeDefined();
        expect(tl.prompt).toContain("You are a team lead");
        expect(tl.prompt).toContain("<available_subagents>");
        expect(tl.prompt).not.toContain("<collaboration_graph>");
        expect(tl.prompt).not.toContain("<topology>");
        expect(tl.prompt).not.toContain("<routing_rules>");
      } finally {
        process.env.XDG_CONFIG_HOME = originalXdg;
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("team-lead subagent prompts do NOT contain <collaboration_role>", async () => {
      const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-graph-e2e-"));
      const roleboxDir = path.join(tmpDir, "rolebox");
      mkdirSync(roleboxDir, { recursive: true });

      const originalXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = tmpDir;

      try {
        cpSync(
          path.join(examplesDir, "team-lead"),
          path.join(roleboxDir, "team-lead"),
          { recursive: true },
        );

        const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
        const cfg = emptyConfig();
        await hooks.config!(cfg);

        const agents = cfg.agent ?? {};

        const implementer = agents["team-lead--implementer"]!;
        expect(implementer).toBeDefined();
        expect(implementer.prompt).not.toContain("<collaboration_role>");
        expect(implementer.prompt).toContain("You are a senior software engineer");

        const researcher = agents["team-lead--researcher"]!;
        expect(researcher).toBeDefined();
        expect(researcher.prompt).not.toContain("<collaboration_role>");
        expect(researcher.prompt).toContain("You are a research specialist");
      } finally {
        process.env.XDG_CONFIG_HOME = originalXdg;
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ── F. Runtime State Tracking ─────────────────────────────────

  describe("Runtime State Tracking", () => {
    function testGraph(): ResolvedGraph {
      return {
        edges: [
          { from: "parent", to: "coder" },
          { from: "coder", to: "reviewer" },
          { from: "reviewer", to: "parent", exit: true },
        ],
        nodes: ["coder", "reviewer"],
        maxIterations: 3,
        exitEdges: [{ from: "reviewer", to: "parent", exit: true }],
        template: "pipeline",
      };
    }

    it("initGraph creates active state with step 0", () => {
      const graph = testGraph();
      graphSessionState.initGraph("test-session", graph);

      const state = graphSessionState.getState("test-session");
      expect(state).toBeDefined();
      expect(state!.status).toBe("active");
      expect(state!.currentStep).toBe(0);
      expect(state!.completedSteps).toEqual([]);
      expect(state!.iterationCount).toBe(0);
    });

    it("advanceStep progresses through pipeline steps", () => {
      const graph = testGraph();
      graphSessionState.initGraph("test-session-2", graph);

      graphSessionState.advanceStep("test-session-2", "coder");
      let state = graphSessionState.getState("test-session-2")!;
      expect(state.status).toBe("active");
      expect(state.currentStep).toBe(1);
      expect(state.completedSteps).toEqual(["coder"]);
      expect(state.iterationCount).toBe(0);

      graphSessionState.advanceStep("test-session-2", "reviewer");
      state = graphSessionState.getState("test-session-2")!;
      expect(state.status).toBe("complete");
      expect(state.currentStep).toBe(2);
      expect(state.completedSteps).toEqual(["coder", "reviewer"]);
    });

    it("isComplete returns false when active, true when complete", () => {
      const graph = testGraph();
      graphSessionState.initGraph("test-session-3", graph);

      expect(graphSessionState.isComplete("test-session-3")).toBe(false);

      graphSessionState.advanceStep("test-session-3", "coder");
      expect(graphSessionState.isComplete("test-session-3")).toBe(false);

      graphSessionState.advanceStep("test-session-3", "reviewer");
      expect(graphSessionState.isComplete("test-session-3")).toBe(true);
    });

    it("isComplete returns true for exhausted state", () => {
      const graphWithLoop: ResolvedGraph = {
        edges: [
          { from: "parent", to: "coder" },
          { from: "coder", to: "reviewer" },
          { from: "reviewer", to: "coder", label: "loop" },
          { from: "reviewer", to: "parent", exit: true },
        ],
        nodes: ["coder", "reviewer"],
        maxIterations: 1,
        exitEdges: [{ from: "reviewer", to: "parent", exit: true }],
      };

      graphSessionState.initGraph("test-session-exhaust", graphWithLoop);

      graphSessionState.advanceStep("test-session-exhaust", "coder");
      expect(graphSessionState.isComplete("test-session-exhaust")).toBe(false);

      graphSessionState.advanceStep("test-session-exhaust", "reviewer");
      let state = graphSessionState.getState("test-session-exhaust")!;
      expect(state.status).toBe("active");
      expect(state.iterationCount).toBe(1);

      graphSessionState.advanceStep("test-session-exhaust", "coder");
      state = graphSessionState.getState("test-session-exhaust")!;
      expect(state.status).toBe("exhausted");

      graphSessionState.advanceStep("test-session-exhaust", "reviewer");
      expect(graphSessionState.isComplete("test-session-exhaust")).toBe(true);
    });

    it("buildCollaborationBlock produces XML with current state", () => {
      const graph = testGraph();
      graphSessionState.initGraph("test-session-4", graph);

      const state = graphSessionState.getState("test-session-4")!;
      const block = buildGraphStateBlock(state, graph);

      expect(block).toContain("<collaboration_state>");
      expect(block).toContain("<status>active</status>");
      expect(block).toContain("<current_step>0</current_step>");
      expect(block).toContain("<completed_steps>none</completed_steps>");
      expect(block).toContain("Dispatch to coder");

      graphSessionState.advanceStep("test-session-4", "coder");
      const state2 = graphSessionState.getState("test-session-4")!;
      const block2 = buildGraphStateBlock(state2, graph);

      expect(block2).toContain("<current_step>1</current_step>");
      expect(block2).toContain("<completed_steps>coder</completed_steps>");
      expect(block2).toContain("Dispatch to reviewer");
    });

    it("buildCollaborationBlock shows complete state after exit", () => {
      const graph = testGraph();
      graphSessionState.initGraph("test-session-5", graph);

      graphSessionState.advanceStep("test-session-5", "coder");
      graphSessionState.advanceStep("test-session-5", "reviewer");

      const state = graphSessionState.getState("test-session-5")!;
      const block = buildGraphStateBlock(state, graph);

      expect(block).toContain("<status>complete</status>");
      expect(block).toContain("<completed_steps>coder, reviewer</completed_steps>");
      expect(block).toContain("Workflow complete");
    });

    it("buildSubagentRoleBlock produces correct XML for entry point", () => {
      const nodeRole: GraphNodeRole = {
        agentId: "coder",
        upstream: [],
        downstream: ["reviewer"],
        isEntryPoint: true,
        isExitPoint: false,
      };

      const block = buildSubagentRoleBlock(nodeRole);
      expect(block).toContain("<collaboration_role>");
      expect(block).toContain("You receive work from the orchestrator");
      expect(block).toContain("Your output will be passed to: reviewer");
    });

    it("buildSubagentRoleBlock produces correct XML for exit point", () => {
      const nodeRole: GraphNodeRole = {
        agentId: "reviewer",
        upstream: ["coder"],
        downstream: [],
        isEntryPoint: false,
        isExitPoint: true,
      };

      const block = buildSubagentRoleBlock(nodeRole);
      expect(block).toContain("<collaboration_role>");
      expect(block).toContain("You receive work from: coder");
      expect(block).toContain("Your output completes the workflow");
    });

    it("buildSubagentRoleBlock produces correct XML for middle agent", () => {
      const nodeRole: GraphNodeRole = {
        agentId: "writer",
        upstream: ["researcher"],
        downstream: ["editor"],
        isEntryPoint: false,
        isExitPoint: false,
      };

      const block = buildSubagentRoleBlock(nodeRole);
      expect(block).toContain("<collaboration_role>");
      expect(block).toContain("receives work from: researcher");
      expect(block).toContain("passes output to: editor");
    });

    it("clear removes session state", () => {
      const graph = testGraph();
      graphSessionState.initGraph("test-session-6", graph);
      expect(graphSessionState.getState("test-session-6")).toBeDefined();

      graphSessionState.clear("test-session-6");
      expect(graphSessionState.getState("test-session-6")).toBeUndefined();
      expect(graphSessionState.isComplete("test-session-6")).toBe(false);
    });

    it("isComplete returns false for unknown session", () => {
      expect(graphSessionState.isComplete("nonexistent")).toBe(false);
    });

    it("getState returns undefined for unknown session", () => {
      expect(graphSessionState.getState("nonexistent")).toBeUndefined();
    });
  });
});

function buildGraphStateBlock(
  state: { status: string; currentStep: number; completedSteps: string[]; iterationCount: number },
  graph: ResolvedGraph,
): string {
  const stepInfo = state.status === "active"
    ? graph.edges[state.currentStep]
    : null;

  const nextAction = stepInfo
    ? `Dispatch to ${stepInfo.to}${stepInfo.label ? ` (${stepInfo.label})` : ""}`
    : "Workflow complete";

  return `<collaboration_state>
  <status>${state.status}</status>
  <current_step>${state.currentStep}</current_step>
  <completed_steps>${state.completedSteps.join(", ") || "none"}</completed_steps>
  <iteration>${state.iterationCount}/${graph.maxIterations || "unlimited"}</iteration>
  <next_action>${nextAction}</next_action>
</collaboration_state>`;
}
