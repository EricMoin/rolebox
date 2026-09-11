import { describe, it, expect } from "bun:test";
import { resolveAllRoles, type ResolveContext } from "../src/resolver/orchestrator.ts";
import { collectOpenRoles, __setLoggerForTest } from "../src/resolver/open-roles.ts";
import type { RoleConfig, ResolvedFunction, ResolvedGraph } from "../src/types.ts";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dirname, ".tmp-resolver-recursive");

// Capture warns emitted by the open-roles registry collector (collectOpenRoles
// warns on unknown export names — mirroring the seam pattern in
// tests/open-roles.test.ts). Swapping the module logger is safe here because
// the test runner uses `--isolate` (per-file processes).
const capturedWarns: unknown[][] = [];
__setLoggerForTest({
  warn: (...args: unknown[]) => { capturedWarns.push(args); },
  debug: () => {},
  error: () => {},
  info: () => {},
  silly: () => {},
  trace: () => {},
  fatal: () => {},
  getSubLogger: () => ({}),
  attachTransport: () => {},
} as any);

function setup(): { ctx: ResolveContext; roleMap: Map<string, RoleConfig>; cleanup: () => void } {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });

  const ctx: ResolveContext = {
    roleboxDir: TEST_DIR,
    globalSkillsDir: TEST_DIR,
    configDir: TEST_DIR,
    builtinDir: TEST_DIR,
    roleFunctionsMap: new Map<string, ResolvedFunction[]>(),
    roleGraphMap: new Map<string, ResolvedGraph>(),
  };

  // Build a role with nested subagents: emperor -> chancellor -> [drafter, reviewer, finalizer]
  const emperor: RoleConfig = {
    name: "Emperor",
    description: "Orchestrator role",
    prompt: "You are the Emperor.",
    subagents: [
      {
        name: "Chancellor",
        description: "Strategic planner",
        prompt: "You are the Chancellor.",
        subagents: [
          {
            name: "Drafter",
            description: "Writes first draft",
            prompt: "You are the Drafter.",
          },
          {
            name: "Reviewer",
            description: "Reviews output",
            prompt: "You are the Reviewer.",
          },
          {
            name: "Finalizer",
            description: "Finalizes work",
            prompt: "You are the Finalizer.",
          },
        ],
      },
    ],
  };

  const roleMap = new Map<string, RoleConfig>();
  roleMap.set("emperor", emperor);

  return { ctx, roleMap, cleanup: () => rmSync(TEST_DIR, { recursive: true }) };
}

describe("Recursive subagent resolution", () => {
  it("resolves nested subagents with hierarchical IDs", async () => {
    const { ctx, roleMap, cleanup } = setup();
    try {
      const resolved = await resolveAllRoles(roleMap, ctx);
      expect(resolved.length).toBe(1);

      const emperor = resolved[0];
      expect(emperor.id).toBe("emperor");
      expect(emperor.subagents.length).toBe(1);

      const chancellor = emperor.subagents[0];
      expect(chancellor.id).toBe("emperor--chancellor");
      expect(chancellor.parentId).toBe("emperor");
      expect(chancellor.subagents.length).toBe(3);

      const childIds = chancellor.subagents.map(s => s.id).sort();
      expect(childIds).toEqual([
        "emperor--chancellor--drafter",
        "emperor--chancellor--finalizer",
        "emperor--chancellor--reviewer",
      ]);

      for (const child of chancellor.subagents) {
        expect(child.parentId).toBe("emperor--chancellor");
        expect(child.subagents.length).toBe(0);
      }
    } finally {
      cleanup();
    }
  });

  it("includes child metadata in parent subagent prompt", async () => {
    const { ctx, roleMap, cleanup } = setup();
    try {
      const resolved = await resolveAllRoles(roleMap, ctx);
      const chancellor = resolved[0].subagents[0];
      expect(chancellor.prompt).toContain("available_subagents");
      expect(chancellor.prompt).toContain("emperor--chancellor--drafter");
      expect(chancellor.prompt).toContain("emperor--chancellor--reviewer");
      expect(chancellor.prompt).toContain("emperor--chancellor--finalizer");
      expect(chancellor.prompt).toContain("Drafter");
      expect(chancellor.prompt).toContain("Reviewer");
      expect(chancellor.prompt).toContain("Finalizer");
    } finally {
      cleanup();
    }
  });

  it("registers functions for nested subagent IDs", async () => {
    const { ctx, roleMap, cleanup } = setup();
    try {
      await resolveAllRoles(roleMap, ctx);
      expect(ctx.roleFunctionsMap.has("emperor--chancellor")).toBe(true);
      expect(ctx.roleFunctionsMap.has("emperor--chancellor--drafter")).toBe(true);
      expect(ctx.roleFunctionsMap.has("emperor--chancellor--reviewer")).toBe(true);
      expect(ctx.roleFunctionsMap.has("emperor--chancellor--finalizer")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("still resolves roles without subagents", async () => {
    const { ctx, roleMap, cleanup } = setup();
    // Add a flat role without subagents
    roleMap.set("simple-role", {
      name: "Simple Role",
      description: "A plain role",
      prompt: "You are a simple role.",
    });

    try {
      const resolved = await resolveAllRoles(roleMap, ctx);
      expect(resolved.length).toBe(2);
      const simple = resolved.find(r => r.id === "simple-role")!;
      expect(simple.subagents.length).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("does not modify top-level prompt for nested grandchildren", async () => {
    const { ctx, roleMap, cleanup } = setup();
    try {
      const resolved = await resolveAllRoles(roleMap, ctx);
      const emperor = resolved[0];
      expect(emperor.prompt).toContain("Chancellor");
      expect(emperor.prompt).toContain("emperor--chancellor");
      expect(emperor.prompt).not.toContain("emperor--chancellor--drafter");
    } finally {
      cleanup();
    }
  });

  it("parallel resolution produces deterministic output (results identical across multiple runs)", async () => {
    // Run resolution multiple times — results must be identical
    // regardless of Promise.all concurrency ordering
    const runCount = 5;
    const results: string[][] = [];

    for (let i = 0; i < runCount; i++) {
      const { ctx, roleMap, cleanup } = setup();
      try {
        const resolved = await resolveAllRoles(roleMap, ctx);
        // Serialize the full structure into a stable representation for comparison
        const serialized = resolved.map(r => ({
          id: r.id,
          subagentIds: r.subagents.map(sa => ({
            id: sa.id,
            parentId: sa.parentId,
            childIds: sa.subagents.map(c => c.id).sort(),
          })).sort((a, b) => a.id.localeCompare(b.id)),
        }));
        results.push(JSON.stringify(serialized));
      } finally {
        cleanup();
      }
    }

    // All runs must produce identical output
    const first = results[0];
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBe(first);
    }
  });
});

describe("Open-role consumer wiring", () => {
  function setupConsumerScenario(): {
    ctx: ResolveContext;
    roleMap: Map<string, RoleConfig>;
    cleanup: () => void;
  } {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });

    const ctx: ResolveContext = {
      roleboxDir: TEST_DIR,
      globalSkillsDir: TEST_DIR,
      configDir: TEST_DIR,
      builtinDir: TEST_DIR,
      roleFunctionsMap: new Map<string, ResolvedFunction[]>(),
      roleGraphMap: new Map<string, ResolvedGraph>(),
    };

    // Producer: open role exposing a helper subagent via exports.
    const producer: RoleConfig = {
      name: "Producer Role",
      description: "Exposes a helper subagent",
      prompt: "You are the producer.",
      open: true,
      exports: ["helper"],
      subagents: [
        {
          name: "Helper",
          description: "Does the helper work",
          prompt: "You are the helper.",
        },
      ],
    };

    // Consumer: declares the producer in open_roles.
    const consumer: RoleConfig = {
      name: "Consumer Role",
      description: "Consumes the producer",
      prompt: "You are the consumer.",
      open_roles: ["producer"],
    };

    // Plain role: declares no open_roles.
    const plain: RoleConfig = {
      name: "Plain Role",
      description: "Declares nothing",
      prompt: "You are the plain role.",
    };

    const roleMap = new Map<string, RoleConfig>();
    roleMap.set("producer", producer);
    roleMap.set("consumer", consumer);
    roleMap.set("plain", plain);

    return { ctx, roleMap, cleanup: () => rmSync(TEST_DIR, { recursive: true }) };
  }

  it("injects <available_public_agents> into a consumer role's prompt listing the declared producer", async () => {
    const { ctx, roleMap, cleanup } = setupConsumerScenario();
    try {
      const resolved = await resolveAllRoles(roleMap, ctx);
      const consumer = resolved.find((r) => r.id === "consumer")!;

      expect(consumer.prompt).toContain("<available_public_agents>");
      expect(consumer.prompt).toContain("</available_public_agents>");
      // Producer id, name, and description are all listed.
      expect(consumer.prompt).toContain("<id>producer</id>");
      expect(consumer.prompt).toContain("Producer Role");
      expect(consumer.prompt).toContain("Exposes a helper subagent");
    } finally {
      cleanup();
    }
  });

  it("does not inject the block into a non-declaring role's prompt", async () => {
    const { ctx, roleMap, cleanup } = setupConsumerScenario();
    try {
      const resolved = await resolveAllRoles(roleMap, ctx);
      const plain = resolved.find((r) => r.id === "plain")!;
      const producer = resolved.find((r) => r.id === "producer")!;

      expect(plain.prompt).not.toContain("<available_public_agents>");
      expect(producer.prompt).not.toContain("<available_public_agents>");
    } finally {
      cleanup();
    }
  });

  it("does not inject the block into subagent prompts", async () => {
    const { ctx, roleMap, cleanup } = setupConsumerScenario();
    try {
      const resolved = await resolveAllRoles(roleMap, ctx);
      const producer = resolved.find((r) => r.id === "producer")!;
      const helper = producer.subagents[0];

      expect(helper.prompt).not.toContain("<available_public_agents>");
    } finally {
      cleanup();
    }
  });

  it("ignores open_roles entries that match no open role", async () => {
    const { ctx, roleMap, cleanup } = setupConsumerScenario();
    roleMap.get("consumer")!.open_roles = ["producer", "no-such-open-role"];
    try {
      const resolved = await resolveAllRoles(roleMap, ctx);
      const consumer = resolved.find((r) => r.id === "consumer")!;

      // Known producer still listed; unknown one silently skipped.
      expect(consumer.prompt).toContain("<id>producer</id>");
      expect(consumer.prompt).not.toContain("no-such-open-role");
    } finally {
      cleanup();
    }
  });

  it("open-role ids (no '--') and subagent full ids (always '--') are disjoint namespaces that coexist in one consumer prompt", async () => {
    const { ctx, roleMap, cleanup } = setupConsumerScenario();
    // The consumer gains its OWN subagent, whose full id is always built with
    // the separator (orchestrator.ts:119-120) — coexisting in the same prompt
    // with the declared open role (id never contains "--", role-loader.ts:39-42).
    roleMap.get("consumer")!.subagents = [
      {
        name: "Worker",
        description: "Does consumer work",
        prompt: "You are the worker.",
      },
    ];
    try {
      const resolved = await resolveAllRoles(roleMap, ctx);
      const consumer = resolved.find((r) => r.id === "consumer")!;
      const producer = resolved.find((r) => r.id === "producer")!;

      // The consumer's own subagent block lists its subagent full id.
      expect(consumer.prompt).toContain("<available_subagents>");
      expect(consumer.prompt).toContain("<id>consumer--worker</id>");

      // The public-agents block lists the open role itself (id, name,
      // description) — exports are registry metadata, not consumer entries.
      expect(consumer.prompt).toContain("<available_public_agents>");
      expect(consumer.prompt).toContain("<id>producer</id>");
      expect(consumer.prompt).not.toContain("<id>producer--helper</id>");

      // The producer's own subagent full id is visible on the producer side.
      expect(producer.prompt).toContain("<id>producer--helper</id>");

      // Namespace disjointness: the open-role id referenced as a public agent
      // never contains the separator; subagent full ids always do.
      expect("producer".includes("--")).toBe(false);
      expect("consumer--worker".includes("--")).toBe(true);
      expect("producer--helper".includes("--")).toBe(true);

      // Both blocks appear in the SAME consumer prompt, subagents first.
      const subIdx = consumer.prompt.indexOf("<available_subagents>");
      const pubIdx = consumer.prompt.indexOf("<available_public_agents>");
      expect(subIdx).toBeGreaterThanOrEqual(0);
      expect(pubIdx).toBeGreaterThan(subIdx);
    } finally {
      cleanup();
    }
  });
});

describe("Circular open_roles declarations", () => {
  function setupCircularScenario(): {
    ctx: ResolveContext;
    roleMap: Map<string, RoleConfig>;
    cleanup: () => void;
  } {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });

    const ctx: ResolveContext = {
      roleboxDir: TEST_DIR,
      globalSkillsDir: TEST_DIR,
      configDir: TEST_DIR,
      builtinDir: TEST_DIR,
      roleFunctionsMap: new Map<string, ResolvedFunction[]>(),
      roleGraphMap: new Map<string, ResolvedGraph>(),
    };

    // alpha declares beta, beta declares alpha — both open producers.
    const alpha: RoleConfig = {
      name: "Alpha Role",
      description: "Open producer consuming beta",
      prompt: "You are alpha.",
      open: true,
      open_roles: ["beta"],
    };
    const beta: RoleConfig = {
      name: "Beta Role",
      description: "Open producer consuming alpha",
      prompt: "You are beta.",
      open: true,
      open_roles: ["alpha"],
    };

    const roleMap = new Map<string, RoleConfig>();
    roleMap.set("alpha", alpha);
    roleMap.set("beta", beta);

    return { ctx, roleMap, cleanup: () => rmSync(TEST_DIR, { recursive: true }) };
  }

  it("resolves mutually-referencing open roles without recursion", async () => {
    const { ctx, roleMap, cleanup } = setupCircularScenario();
    try {
      // Must COMPLETE — no RangeError: Maximum call stack size exceeded. The
      // registry is metadata-only (collectOpenRoles reads configs, not
      // prompts), so the cycle never recurses.
      const resolved = await resolveAllRoles(roleMap, ctx);
      expect(resolved.length).toBe(2);

      const alpha = resolved.find((r) => r.id === "alpha")!;
      const beta = resolved.find((r) => r.id === "beta")!;

      // Each consumer prompt lists the other's id in <available_public_agents>.
      expect(alpha.prompt).toContain("<available_public_agents>");
      expect(alpha.prompt).toContain("<id>beta</id>");
      expect(beta.prompt).toContain("<available_public_agents>");
      expect(beta.prompt).toContain("<id>alpha</id>");
    } finally {
      cleanup();
    }
  });
});

describe("Open-role exports validation at resolution level", () => {
  function setupExportsScenario(): {
    ctx: ResolveContext;
    roleMap: Map<string, RoleConfig>;
    cleanup: () => void;
  } {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });

    const ctx: ResolveContext = {
      roleboxDir: TEST_DIR,
      globalSkillsDir: TEST_DIR,
      configDir: TEST_DIR,
      builtinDir: TEST_DIR,
      roleFunctionsMap: new Map<string, ResolvedFunction[]>(),
      roleGraphMap: new Map<string, ResolvedGraph>(),
    };

    // Producer exports a known subagent plus a name that matches nothing.
    const producer: RoleConfig = {
      name: "Producer Role",
      description: "Exports a known and an unknown subagent",
      prompt: "You are the producer.",
      open: true,
      exports: ["helper", "missing-agent"],
      subagents: [
        {
          name: "Helper",
          description: "Does the helper work",
          prompt: "You are the helper.",
        },
      ],
    };
    const consumer: RoleConfig = {
      name: "Consumer Role",
      description: "Consumes the producer",
      prompt: "You are the consumer.",
      open_roles: ["producer"],
    };

    const roleMap = new Map<string, RoleConfig>();
    roleMap.set("producer", producer);
    roleMap.set("consumer", consumer);

    return { ctx, roleMap, cleanup: () => rmSync(TEST_DIR, { recursive: true }) };
  }

  it("warns on unknown export names but never fails resolution", async () => {
    capturedWarns.length = 0;
    const { ctx, roleMap, cleanup } = setupExportsScenario();
    try {
      const resolved = await resolveAllRoles(roleMap, ctx);

      // Resolution completes with both roles; the consumer still receives the
      // producer's <available_public_agents> block.
      expect(resolved.length).toBe(2);
      const consumer = resolved.find((r) => r.id === "consumer")!;
      expect(consumer.prompt).toContain("<id>producer</id>");

      // The registry entry exports only the known subagent id — the unknown
      // name is dropped, not fatal.
      const registry = collectOpenRoles(resolved);
      expect(registry.get("producer")!.exports).toEqual(["producer--helper"]);

      // A warn was emitted naming the unknown export and its owning role.
      const warnMessages = capturedWarns.flatMap((args) => args.map(String));
      expect(warnMessages.some((m) => m.includes("missing-agent"))).toBe(true);
      expect(warnMessages.some((m) => m.includes("producer"))).toBe(true);
    } finally {
      cleanup();
    }
  });
});
