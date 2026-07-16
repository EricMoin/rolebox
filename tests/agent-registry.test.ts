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

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpencodeAgentRegistrar } from "../src/platform/adapters/opencode/agent-registrar.ts";
import { syncAllAgents } from "../src/sync/agent-files.ts";
import { RoleMode, ROLEBOX_AGENT_MARKER } from "../src/constants.ts";
import type { AgentDefinition } from "../src/platform/types.ts";
import type { IAgentRegistrar } from "../src/platform/ports/agent-registrar.ts";
import type { ResolvedRole } from "../src/types.ts";

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
