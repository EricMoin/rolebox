/**
 * End-to-end integration tests for the rolebox plugin.
 *
 * These tests exercise the full pipeline using the example role
 * configurations under examples/:
 *
 *   1. Role discovery (discoverRoles)
 *   2. Role config validation
 *   3. Skill resolution (resolveSkills)
 *   4. Prompt construction (buildAgentPrompt)
 *   5. Full plugin config hook integration
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, cpSync } from "node:fs";
import path from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import type { PluginInput } from "@opencode-ai/plugin";
import type { Config } from "@opencode-ai/sdk";

import { discoverRoles } from "./role-loader";
import { resolveSkills } from "./skill-resolver";
import { buildAgentPrompt } from "./prompt-builder";
import RoleboxPlugin from "./index";

const examplesDir = path.join(import.meta.dir, "..", "examples");

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

// ── tests ────────────────────────────────────────────────────────

describe("End-to-end", () => {
  // ── Discovery ──────────────────────────────────────────────

  describe("role discovery", () => {
    it("discovers both example roles from examples/", async () => {
      const roles = await discoverRoles(examplesDir);

      expect(roles.size).toBe(2);
      expect(roles.has("code-reviewer")).toBe(true);
      expect(roles.has("tech-writer")).toBe(true);
    });

    it("returns an empty Map for a non-existent directory", async () => {
      const roles = await discoverRoles(
        path.join(examplesDir, "no-such-subdir"),
      );

      expect(roles.size).toBe(0);
    });
  });

  // ── Role config validation ─────────────────────────────────

  describe("role configs", () => {
    it("code-reviewer has all optional fields populated", async () => {
      const roles = await discoverRoles(examplesDir);
      const cr = roles.get("code-reviewer")!;

      expect(cr.name).toBe("Code Reviewer");
      expect(cr.description).toContain("Expert code reviewer");
      expect(cr.model).toBe("gpt-4");
      expect(cr.mode).toBe("subagent");
      expect(cr.color).toBe("#4CAF50");
      expect(cr.variant).toBe("thorough");
      expect(cr.temperature).toBe(0.2);
      expect(cr.top_p).toBe(0.95);
      expect(cr.skills).toEqual(["review-checklist"]);
      expect(cr.permission).toEqual({
        allow: ["Read", "Grep", "Glob", "Edit"],
      });
      expect(cr.prompt).toContain("You are an expert code reviewer");
      expect(cr.prompt).toContain("correctness");
      expect(cr.prompt).toContain("security issues");
      expect(cr.prompt).toContain("actionable feedback");
    });

    it("tech-writer has only minimal required fields", async () => {
      const roles = await discoverRoles(examplesDir);
      const tw = roles.get("tech-writer")!;

      expect(tw.name).toBe("Tech Writer");
      expect(tw.description).toBe("Technical documentation specialist");
      expect(tw.prompt).toContain("You are a technical writer");
      expect(tw.opencode_skills).toEqual(["humanizer"]);

      expect(tw.model).toBeUndefined();
      expect(tw.mode).toBeUndefined();
      expect(tw.color).toBeUndefined();
      expect(tw.variant).toBeUndefined();
      expect(tw.temperature).toBeUndefined();
      expect(tw.top_p).toBeUndefined();
      expect(tw.skills).toBeUndefined();
      expect(tw.permission).toBeUndefined();
    });
  });

  // ── Skill resolution ───────────────────────────────────────

  describe("skill resolution", () => {
    it("resolves review-checklist from code-reviewer's role-local skills/ dir", async () => {
      const roleDir = path.join(examplesDir, "code-reviewer");
      const skills = await resolveSkills(
        ["review-checklist"],
        roleDir,
        "/nonexistent/global/skills",
      );

      expect(skills.length).toBe(1);

      const skill = skills[0];
      expect(skill.name).toBe("review-checklist");
      expect(skill.scope).toBe("rolebox");
      expect(skill.description).toContain(
        "Standard code review checklist",
      );
      expect(skill.filePath).toContain("review-checklist/SKILL.md");
    });

    it("skips skills that cannot be found in any candidate location", async () => {
      const roleDir = path.join(examplesDir, "tech-writer");
      const skills = await resolveSkills(
        ["humanizer"],
        roleDir,
        "/nonexistent/global/skills",
      );

      expect(skills.length).toBe(0);
    });
  });

  // ── Prompt building ────────────────────────────────────────

  describe("prompt building", () => {
    it("code-reviewer prompt includes <available_skills> XML block", async () => {
      const roles = await discoverRoles(examplesDir);
      const cr = roles.get("code-reviewer")!;

      const skills = await resolveSkills(
        ["review-checklist"],
        path.join(examplesDir, "code-reviewer"),
        "/nonexistent/global/skills",
      );

      const prompt = buildAgentPrompt(cr, skills);

      expect(prompt).toContain("You are an expert code reviewer");

      expect(prompt).toContain("<available_skills>");
      expect(prompt).toContain("<skill>");
      expect(prompt).toContain("<name>review-checklist</name>");
      expect(prompt).toContain(
        "<description>Standard code review checklist covering correctness, security, performance, and style</description>",
      );
      expect(prompt).toContain("<scope>rolebox</scope>");
      expect(prompt).toContain("</skill>");
      expect(prompt).toContain("</available_skills>");
    });

    it("tech-writer prompt is raw when no skills are resolved", async () => {
      const roles = await discoverRoles(examplesDir);
      const tw = roles.get("tech-writer")!;

      const prompt = buildAgentPrompt(tw, []);

      expect(prompt).not.toContain("<available_skills>");
      expect(prompt).toContain("You are a technical writer");
      expect(prompt).toContain("accurate, well-structured");
    });
  });

  // ── Full plugin integration ────────────────────────────────

  describe("plugin config hook integration", () => {
    it("registers both example roles as opencode agents", async () => {
      const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-e2e-"));
      const roleboxDir = path.join(tmpDir, "rolebox");
      mkdirSync(roleboxDir, { recursive: true });

      try {
        cpSync(
          path.join(examplesDir, "code-reviewer"),
          path.join(roleboxDir, "code-reviewer"),
          { recursive: true },
        );
        cpSync(
          path.join(examplesDir, "tech-writer"),
          path.join(roleboxDir, "tech-writer"),
          { recursive: true },
        );

        const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
        const cfg = emptyConfig();
        await hooks.config!(cfg);

        const agents = cfg.agent ?? {};
        const keys = Object.keys(agents).sort();
        expect(keys).toEqual(["code-reviewer", "tech-writer"]);

        const cr = agents["code-reviewer"]!;
        expect(cr.prompt).toContain("You are an expert code reviewer");
        expect(cr.prompt).toContain("<available_skills>");
        expect(cr.prompt).toContain("<name>review-checklist</name>");
        expect(cr.mode).toBe("subagent");
        expect(cr.model).toBe("gpt-4");
        expect(cr.description).toContain("Expert code reviewer");
        expect(cr.color).toBe("#4CAF50");
        expect(cr.variant).toBe("thorough");
        expect(cr.temperature).toBe(0.2);
        expect(cr.top_p).toBe(0.95);

        const tw = agents["tech-writer"]!;
        expect(tw.prompt).toContain("You are a technical writer");
        expect(tw.prompt).not.toContain("<available_skills>");
        expect(tw.mode).toBe("primary");
        expect(tw.description).toBe("Technical documentation specialist");
        expect("model" in tw).toBe(false);
        expect("color" in tw).toBe(false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
