import { beforeEach as resetBeforeEach } from "vitest";
/** Top-level teammate discovery must survive both fast and full reloads. */

vi.doMock("../../src/platform/adapters/opencode/agent-registrar.ts", () => ({
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
const { HotReloadService } = await import("../../src/core/services/hot-reload-service.ts");
const { opencodeCapabilities } = await import("../../src/platform/capabilities.ts");
const { roleOpenRegistry } = await import("../../src/resolver/registry.ts");

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";



import type { ResolvedRole, ResolvedSubAgent } from "../../src/types.ts";

// ── helpers ────────────────────────────────────────────────────────

function makeMockCore() {
  return {
    getService: vi.fn(() => undefined),
    getServices: vi.fn(() => new Map()),
    restartService: vi.fn(() => Promise.resolve()),
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
    bus: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), clear: vi.fn() },
    roleboxDir: dir,
    globalSkillsDir: join(dir, "global-skills"),
    configDir: join(dir, "config"),
    builtinDir: dir,
    // Always present on a real PluginContext; the reload reads it to select
    // the harness's model catalog.
    capabilities: opencodeCapabilities(),
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

/** Consumer without legacy open-role configuration. */
function makeConsumerRole(): ResolvedRole {
  return {
    id: "consumer",
    config: {
      name: "Consumer Role",
      description: "Consumes the producer",
      prompt: "You are the consumer.",
    },
    prompt: "You are the consumer.",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
  };
}

/** Producer carrying legacy exports that must not expose its child. */
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

describe("HotReloadService teammate catalog", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hot-reload-open-"));
    roleOpenRegistry.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
    roleOpenRegistry.clear();
  });

  it("fast reload retains teammates without a legacy open_roles declaration", async () => {
    const svc = new HotReloadService();
    const core = makeMockCore();
    const ctx = makeCtx(tempDir, core);
    ctx.resolvedRoles = [makeConsumerRole(), makeProducerRole()];
    await svc.init(ctx);

    // Drive the fast path directly: re-resolve skills for the consumer role.
    const result = await (svc as any).performFastReload("consumer");

    expect(result.success).toBe(true);

    // The rebuilt prompt must retain the `## Available public agents` block
    // listing the producer with its id and description.
    const consumer = ctx.resolvedRoles.find((r: ResolvedRole) => r.id === "consumer")!;
    expect(consumer.prompt).toContain("## Available public agents");
    expect(consumer.prompt).toContain("- `producer` — Exposes a helper subagent");

    await svc.dispose();
  });

  it("fast reload keeps team guidance available when graph delegation is disabled", async () => {
    const svc = new HotReloadService();
    const ctx = makeCtx(tempDir);
    const consumer = makeConsumerRole();
    consumer.config.tools = { graph_declare: false };
    ctx.resolvedRoles = [consumer, makeProducerRole()];
    await svc.init(ctx);
    try {
      const result = await (svc as any).performFastReload("consumer");
      expect(result.success).toBe(true);
      expect(consumer.prompt).toContain("## Available public agents");
      expect(consumer.prompt).toContain("team_create");
      expect(consumer.prompt).not.toContain("## Available sub-agents");
    } finally {
      await svc.dispose();
    }
  });

  it("full reload recomputes the top-level role catalog", async () => {
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

    // Stale entries disappear and legacy exports remain private.
    expect(roleOpenRegistry.has("stale-role")).toBe(false);
    expect(roleOpenRegistry.has("producer")).toBe(true);
    const producerEntry = roleOpenRegistry.get("producer")!;
    expect(producerEntry.name).toBe("Producer Role");
    expect(producerEntry.description).toBe("Exposes a helper subagent");
    expect(producerEntry.exports).toEqual([]);
    expect(roleOpenRegistry.has("consumer")).toBe(true);
    expect(roleOpenRegistry.has("producer--helper")).toBe(false);

    await svc.dispose();
  });
});

resetBeforeEach(() => vi.resetModules());
