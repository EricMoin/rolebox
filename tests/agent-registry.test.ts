/**
 * Agent registry tests — OpencodeAgentRegistrar + syncAllAgents.
 *
 * Verifies:
 *   - OpencodeAgentRegistrar.register() writes expected markdown files
 *   - OpencodeAgentRegistrar.sync() adds/removes/unchanged correctly
 *   - OpencodeAgentRegistrar.list() returns registered rolebox-managed IDs
 *   - syncAllAgents() converts ResolvedRole[] into AgentDefinition[] and calls registrar.sync()
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { OpencodeAgentRegistrar } from "../src/platform/adapters/opencode/agent-registrar.ts";
import { syncAllAgents } from "../src/sync/agent-files.ts";
import { RoleMode, ROLEBOX_AGENT_MARKER } from "../src/constants.ts";
import type { AgentDefinition } from "../src/platform/types.ts";
import type { IAgentRegistrar } from "../src/platform/ports/agent-registrar.ts";
import type { ResolvedRole } from "../src/types.ts";
import { syncBuiltinSkills } from "../src/sync/builtin-skills.ts";
import { syncSkillSymlinks } from "../src/sync/skill-symlinks.ts";
import { initializeRoleboxRuntime } from "../src/platform/factory.ts";
import { createDirSymlink } from "./helpers/symlink.ts";

describe("built-in skill synchronization", () => {
  let tempDir: string;
  const source = resolve(import.meta.dirname, "../skills/rolebox-config");

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rolebox-builtin-skills-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("exposes the full skill directory and references without installed roles", () => {
    syncBuiltinSkills(tempDir);
    const entry = join(tempDir, "rolebox-config");
    expect(lstatSync(entry).isSymbolicLink()).toBe(true);
    expect(realpathSync(entry)).toBe(realpathSync(source));
    expect(readFileSync(join(entry, "references/roles.md"), "utf8"))
      .toBe(readFileSync(join(source, "references/roles.md"), "utf8"));
  });

  it("keeps an unchanged link and survives role-skill cleanup", () => {
    syncBuiltinSkills(tempDir);
    const entry = join(tempDir, "rolebox-config");
    const inode = lstatSync(entry).ino;
    syncBuiltinSkills(tempDir);
    syncSkillSymlinks([], tempDir);
    expect(lstatSync(entry).ino).toBe(inode);
    expect(realpathSync(entry)).toBe(realpathSync(source));
  });

  it.each([false, true])("refreshes an old package link (broken: %s)", (broken) => {
    const oldSource = join(tempDir, "old-package", "skills", "rolebox-config");
    mkdirSync(oldSource, { recursive: true });
    const entry = join(tempDir, "rolebox-config");
    createDirSymlink(oldSource, entry);
    if (broken) rmSync(join(tempDir, "old-package"), { recursive: true });
    syncBuiltinSkills(tempDir);
    expect(realpathSync(entry)).toBe(realpathSync(source));
  });

  it.each(["file", "directory"])("preserves a user-owned %s at the destination", (kind) => {
    const entry = join(tempDir, "rolebox-config");
    if (kind === "directory") mkdirSync(entry);
    const file = kind === "directory" ? join(entry, "SKILL.md") : entry;
    writeFileSync(file, "User content");
    syncBuiltinSkills(tempDir);
    expect(readFileSync(file, "utf8")).toBe("User content");
    expect(lstatSync(entry).isSymbolicLink()).toBe(false);
  });

  it("does not block startup when the skills path is not writable as a directory", () => {
    const file = join(tempDir, "skills-file");
    writeFileSync(file, "Keep this file");
    expect(() => syncBuiltinSkills(file)).not.toThrow();
    expect(readFileSync(file, "utf8")).toBe("Keep this file");
  });

  it("syncs at host bootstrap before resolving explicitly declared global skills", async () => {
    const roleDir = join(tempDir, "rolebox", "example");
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(join(roleDir, "role.yaml"), [
      "name: Example", "description: Example role", "prompt: Configure this project.",
      "opencode_skills: [rolebox-config]",
    ].join("\n"));
    const result = await initializeRoleboxRuntime({
      directories: {
        roleboxDir: join(tempDir, "rolebox"),
        globalSkillsDir: join(tempDir, "skills"),
        configDir: tempDir,
        platformId: "opencode",
        builtinDir: resolve(import.meta.dirname, "../functions"),
      },
      roleFunctionsMap: new Map(),
    });
    expect(result.resolved).toBe(1);
    expect(result.resolvedRoles[0].skills.map(skill => skill.name)).toContain("rolebox-config");
    expect(result.resolvedRoles[0].skills[0].references.length).toBeGreaterThan(0);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeAgentDefs(count: number): AgentDefinition[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `test-agent-${i}`,
    name: `Test Agent ${i}`,
    description: `Description ${i}`,
    systemPrompt: `Prompt ${i}`,
    mode: RoleMode.Subagent,
    model: i % 2 === 0 ? "claude-sonnet" : undefined,
  }));
}

function makeResolvedRoles(): ResolvedRole[] {
  return [
    {
      id: "primary-role",
      config: {
        name: "Primary Role",
        description: "Primary role description",
        mode: RoleMode.Primary,
        model: "claude-sonnet",
      },
      prompt: "Primary system prompt",
      skills: [],
      functions: [],
      references: [],
      subagents: [
        {
          id: "sub-agent-1",
          config: {
            name: "Sub Agent 1",
            description: "Sub agent 1 description",
            model: "claude-opus",
          },
          prompt: "Sub agent 1 prompt",
          skills: [],
          functions: [],
          references: [],
          subagents: [],
          parentId: "primary-role",
          inheritedFrom: {},
        },
      ],
    },
  ] as unknown as ResolvedRole[];
}

// ── OpencodeAgentRegistrar ─────────────────────────────────────────────────

describe("OpencodeAgentRegistrar", () => {
  let tempDir: string;
  let registrar: OpencodeAgentRegistrar;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rolebox-agent-registry-"));
    registrar = new OpencodeAgentRegistrar(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("register() writes an agent file with the expected content", async () => {
    await registrar.register(makeAgentDefs(1));
    const filePath = join(tempDir, "test-agent-0.md");
    expect(existsSync(filePath)).toBe(true);
    const text = readFileSync(filePath, "utf-8");
    expect(text).toContain(ROLEBOX_AGENT_MARKER);
    expect(text).toContain("name: Test Agent 0");
    expect(text).toContain("description: Description 0");
    expect(text).toContain("mode: subagent");
    expect(text).toContain("model: claude-sonnet");
    expect(text).toContain("Prompt 0");
  });

  it("register() skips model line when model is undefined", async () => {
    const defs = makeAgentDefs(2).slice(1); // index 1 has no model
    await registrar.register(defs);
    const text = readFileSync(join(tempDir, "test-agent-1.md"), "utf-8");
    expect(text).not.toContain("model:");
  });

  it("unregister() removes only rolebox-managed files", async () => {
    await registrar.register(makeAgentDefs(1));
    await registrar.unregister(["test-agent-0"]);
    expect(existsSync(join(tempDir, "test-agent-0.md"))).toBe(false);
  });

  it("sync() adds new agents and reports added IDs", async () => {
    const result = await registrar.sync(makeAgentDefs(2));
    expect(result.added.sort()).toEqual(["test-agent-0", "test-agent-1"]);
    expect(result.removed).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(existsSync(join(tempDir, "test-agent-0.md"))).toBe(true);
    expect(existsSync(join(tempDir, "test-agent-1.md"))).toBe(true);
  });

  it("sync() reports unchanged agents when content is identical", async () => {
    const defs = makeAgentDefs(2);
    await registrar.sync(defs);
    const result = await registrar.sync(defs);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.unchanged.sort()).toEqual(["test-agent-0", "test-agent-1"]);
  });

  it("sync() removes stale agents and reports removed IDs", async () => {
    await registrar.sync(makeAgentDefs(2));
    const result = await registrar.sync(makeAgentDefs(1));
    expect(result.removed).toEqual(["test-agent-1"]);
    expect(existsSync(join(tempDir, "test-agent-1.md"))).toBe(false);
  });

  it("list() returns registered IDs sorted", async () => {
    await registrar.sync(makeAgentDefs(2));
    const ids = await registrar.list();
    expect(ids).toEqual(["test-agent-0", "test-agent-1"]);
  });
});

// ── syncAllAgents ──────────────────────────────────────────────────────────

describe("syncAllAgents", () => {
  it("converts ResolvedRole[] to AgentDefinition[] and calls registrar.sync()", async () => {
    let received: AgentDefinition[] = [];
    const fakeRegistrar: IAgentRegistrar = {
      async register(agents) { received = agents; },
      async unregister() {},
      async sync(agents) {
        received = agents;
        return { added: received.map((a) => a.id), removed: [], unchanged: [] };
      },
      async list() { return []; },
    };

    const result = await syncAllAgents(makeResolvedRoles(), fakeRegistrar);
    expect(received.length).toBe(2);
    expect(received[0].id).toBe("primary-role");
    expect(received[0].mode).toBe(RoleMode.Primary);
    expect(received[0].systemPrompt).toBe("Primary system prompt");
    expect(received[1].id).toBe("sub-agent-1");
    expect(received[1].mode).toBe(RoleMode.Subagent);
    expect(received[1].systemPrompt).toBe("Sub agent 1 prompt");
    expect(result.added).toEqual(["primary-role", "sub-agent-1"]);
  });
});
