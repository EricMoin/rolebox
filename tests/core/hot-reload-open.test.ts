/**
 * Hot-reload open-roles wiring tests (subtask 5 of the open-role strategy).
 *
 * Covers:
 *   1. Fast reload (skill-only change) rebuilds a consumer role's prompt WITH
 *      the <available_public_agents> block intact — the block must survive
 *      skill-only reloads for roles declaring open_roles.
 *   2. Full reload recomputes the shared open-roles registry from the freshly
 *      resolved roles (stale entries removed, open producers re-registered).
 *
 * The OpencodeAgentRegistrar is mocked to avoid writing agent files to the
 * real ~/.claude/agents during tests. mock.module is safe here because the
 * test runner uses `--isolate` (per-file processes).
 */

mock.module("../../src/platform/adapters/opencode/agent-registrar.ts", () => ({
  OpencodeAgentRegistrar: class {
    async sync() {
      return { added: [], removed: [], unchanged: [] };
    }
    async register() {}
    async unregister() {}
    async list() {
      return [];
    }
  },
}));

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HotReloadService } from "../../src/core/services/hot-reload-service.ts";
import { roleOpenRegistry } from "../../src/resolver/registry.ts";
import type { ResolvedRole, ResolvedSubAgent } from "../../src/types.ts";

// ── helpers ────────────────────────────────────────────────────────

function makeMockCore() {
  return {
    getService: mock(() => undefined),
    getServices: mock(() => new Map()),
    restartService: mock(() => Promise.resolve()),
  };
}

function makeCtx(dir: string, core: any = makeMockCore()): any {
  return {
    client: {} as any,
    resolvedRoles: [] as any[],
    roleFunctionsMap: new Map(),
    roleGraphMap: new Map(),
    rawDirectory: dir,
    directory: dir,
    core,
    bus: { on: mock(), off: mock(), emit: mock(), clear: mock() },
    roleboxDir: dir,
    globalSkillsDir: join(dir, "global-skills"),
    configDir: join(dir, "config"),
    builtinDir: dir,
  };
}

function makeSubagent(name: string, id: string): ResolvedSubAgent {
  return {
    id,
    config: { name, description: `${name} description`, prompt: `You are ${name}.` },
    prompt: `You are ${name}.`,
    skills: [],
    functions: [],
    references: [],
    subagents: [],
    parentId: id.split("--").slice(0, -1).join("--"),
    inheritedFrom: {},
  };
}

/** Consumer role declaring open_roles: [producer]. */
function makeConsumerRole(): ResolvedRole {
  return {
    id: "consumer",
    config: {
      name: "Consumer Role",
      description: "Consumes the producer",
      prompt: "You are the consumer.",
      open_roles: ["producer"],
    },
    prompt: "You are the consumer.",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
  };
}

/** Open producer role exposing one helper subagent via exports. */
function makeProducerRole(): ResolvedRole {
  return {
    id: "producer",
    config: {
      name: "Producer Role",
      description: "Exposes a helper subagent",
      prompt: "You are the producer.",
      open: true,
      exports: ["helper"],
      subagents: [
        { name: "Helper", description: "Does the helper work", prompt: "You are the helper." },
      ],
    },
    prompt: "You are the producer.",
    skills: [],
    functions: [],
    references: [],
    subagents: [makeSubagent("Helper", "producer--helper")],
  };
}

describe("HotReloadService open-roles wiring", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hot-reload-open-"));
    roleOpenRegistry.clear();
  });

  afterEach(() => {
    mock.restore();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
    roleOpenRegistry.clear();
  });

  it("fast reload retains <available_public_agents> in the rebuilt prompt for a role declaring open_roles", async () => {
    const svc = new HotReloadService();
    const core = makeMockCore();
    const ctx = makeCtx(tempDir, core);
    ctx.resolvedRoles = [makeConsumerRole(), makeProducerRole()];
    await svc.init(ctx);

    // Drive the fast path directly: re-resolve skills for the consumer role.
    const result = await (svc as any).performFastReload("consumer");

    expect(result.success).toBe(true);

    // The rebuilt prompt must retain the <available_public_agents> block
    // listing the declared producer with its id, name, and description.
    const consumer = ctx.resolvedRoles.find((r: ResolvedRole) => r.id === "consumer")!;
    expect(consumer.prompt).toContain("<available_public_agents>");
    expect(consumer.prompt).toContain("</available_public_agents>");
    expect(consumer.prompt).toContain("<id>producer</id>");
    expect(consumer.prompt).toContain("Producer Role");
    expect(consumer.prompt).toContain("Exposes a helper subagent");

    await svc.dispose();
  });

  it("full reload recomputes the open-roles registry from freshly resolved roles", async () => {
    // Real role.yaml fixtures on disk so discoverRoles + resolveAllRoles run.
    mkdirSync(join(tempDir, "producer"), { recursive: true });
    writeFileSync(
      join(tempDir, "producer", "role.yaml"),
      [
        "name: Producer Role",
        "description: Exposes a helper subagent",
        "prompt: You are the producer.",
        "open: true",
        "exports:",
        "  - helper",
        "subagents:",
        "  - name: Helper",
        "    description: Does the helper work",
        "    prompt: You are the helper.",
      ].join("\n"),
      "utf-8",
    );
    mkdirSync(join(tempDir, "consumer"), { recursive: true });
    writeFileSync(
      join(tempDir, "consumer", "role.yaml"),
      [
        "name: Consumer Role",
        "description: Consumes the producer",
        "prompt: You are the consumer.",
        "open_roles:",
        "  - producer",
      ].join("\n"),
      "utf-8",
    );

    const svc = new HotReloadService();
    const core = makeMockCore();
    const ctx = makeCtx(tempDir, core);
    // Seed a stale registry entry that must be evicted by the rebuild.
    roleOpenRegistry.set("stale-role", {
      roleId: "stale-role",
      name: "Stale Role",
      description: "Removed from disk",
      exports: [],
    });
    await svc.init(ctx);

    const result = await svc.triggerReload();

    expect(result.success).toBe(true);
    expect(result.discovered).toBe(2);
    expect(result.resolved).toBe(2);

    // Stale entry evicted; open producer re-registered with resolved exports.
    expect(roleOpenRegistry.has("stale-role")).toBe(false);
    expect(roleOpenRegistry.has("producer")).toBe(true);
    const producerEntry = roleOpenRegistry.get("producer")!;
    expect(producerEntry.name).toBe("Producer Role");
    expect(producerEntry.description).toBe("Exposes a helper subagent");
    expect(producerEntry.exports).toEqual(["producer--helper"]);
    // Consumer is not open → absent from the registry.
    expect(roleOpenRegistry.has("consumer")).toBe(false);

    await svc.dispose();
  });
});
