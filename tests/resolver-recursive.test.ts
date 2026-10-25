import { describe, it, expect } from "vitest";
import { resolveAllRoles, type ResolveContext } from "../src/resolver/orchestrator.ts";
import { collectOpenRoles } from "../src/resolver/open-roles.ts";
import type { RoleConfig, ResolvedFunction } from "../src/types.ts";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dirname, ".tmp-resolver-recursive");

function setup(): { ctx: ResolveContext; roleMap: Map<string, RoleConfig>; cleanup: () => void } {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });

  const ctx: ResolveContext = {
    roleboxDir: TEST_DIR,
    globalSkillsDir: TEST_DIR,
    configDir: TEST_DIR,
    builtinDir: TEST_DIR,
    roleFunctionsMap: new Map<string, ResolvedFunction[]>(),
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
  it("tracks inherited memory settings for nested agents", async () => {
    const { ctx, roleMap, cleanup } = setup();
    try {
      const parent = roleMap.get("emperor")!;
      const memory = { inject: false };
      parent.memory = memory;
      parent.subagents![0].memory = memory;
      parent.subagents![0].subagents![0].memory = memory;
      const resolved = await resolveAllRoles(roleMap, ctx);
      expect(resolved[0].subagents[0].inheritedFrom.memory).toBe(memory);
      expect(resolved[0].subagents[0].subagents[0].inheritedFrom.memory).toBe(memory);
    } finally {
      cleanup();
    }
  });

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
      expect(chancellor.prompt).toContain("## Available sub-agents");
      expect(chancellor.prompt).toContain("- `emperor--chancellor--drafter` — Writes first draft");
      expect(chancellor.prompt).toContain("- `emperor--chancellor--reviewer` — Reviews output");
      expect(chancellor.prompt).toContain("- `emperor--chancellor--finalizer` — Finalizes work");
    } finally {
      cleanup();
    }
  });

  it("keeps nested agents addressable without advertising forbidden delegation", async () => {
    const { ctx, roleMap, cleanup } = setup();
    try {
      const config = roleMap.get("emperor")!;
      config.subagents![0].tools = { graph_declare: false };
      const resolved = await resolveAllRoles(roleMap, ctx);
      const chancellor = resolved[0].subagents[0];
      expect(chancellor.subagents).toHaveLength(3);
      expect(chancellor.prompt).not.toContain("## Available sub-agents");
      expect(chancellor.prompt).not.toContain("You can delegate tasks");
    } finally { cleanup(); }
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
      expect(emperor.prompt).toContain("- `emperor--chancellor` — Strategic planner");
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
    const results: string[] = [];

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

describe("Top-level teammate prompt wiring", () => {
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
    };

    // Legacy export declarations must not expose the producer's child.
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
      open: false,
    };

    const roleMap = new Map<string, RoleConfig>();
    roleMap.set("producer", producer);
    roleMap.set("consumer", consumer);
    roleMap.set("plain", plain);

    return { ctx, roleMap, cleanup: () => rmSync(TEST_DIR, { recursive: true }) };
  }

  it("injects the teammate catalog into the consumer prompt", async () => {
    const { ctx, roleMap, cleanup } = setupConsumerScenario();
    try {
      const resolved = await resolveAllRoles(roleMap, ctx);
      const consumer = resolved.find((r) => r.id === "consumer")!;

      // Producer id and description are listed.
      expect(consumer.prompt).toContain("## Available public agents");
      expect(consumer.prompt).toContain("- `producer` — Exposes a helper subagent");
    } finally {
      cleanup();
    }
  });

  it("discovers other top-level roles without an open_roles declaration", async () => {
    const { ctx, roleMap, cleanup } = setupConsumerScenario();
    try {
      const resolved = await resolveAllRoles(roleMap, ctx);
      const plain = resolved.find((r) => r.id === "plain")!;
      const producer = resolved.find((r) => r.id === "producer")!;

      expect(plain.prompt).toContain("## Available public agents");
      expect(plain.prompt).toContain("- `producer` — ");
      expect(plain.prompt).toContain("- `consumer` — ");
      expect(plain.prompt).not.toContain("- `plain` — ");
      expect(producer.prompt).toContain("- `plain` — ");
      expect(producer.prompt).toContain("- `consumer` — ");
      expect(producer.prompt).not.toContain("- `producer` — ");
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

      expect(helper.prompt).not.toContain("## Available public agents");
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
      expect(consumer.prompt).toContain("- `producer` — Exposes a helper subagent");
      expect(consumer.prompt).not.toContain("no-such-open-role");
    } finally {
      cleanup();
    }
  });

  it("teammates and owned children coexist without exposing another role's children", async () => {
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
      expect(consumer.prompt).toContain("## Available sub-agents");
      expect(consumer.prompt).toContain("- `consumer--worker` — Does consumer work");

      // The teammate block lists only the top-level role.
      expect(consumer.prompt).toContain("## Available public agents");
      expect(consumer.prompt).toContain("- `producer` — Exposes a helper subagent");
      expect(consumer.prompt).not.toContain("`producer--helper`");

      // The producer's own subagent full id is visible on the producer side.
      expect(producer.prompt).toContain("- `producer--helper` — Does the helper work");

      // Namespace disjointness: the open-role id referenced as a public agent
      // never contains the separator; subagent full ids always do.
      expect("producer".includes("--")).toBe(false);
      expect("consumer--worker".includes("--")).toBe(true);
      expect("producer--helper".includes("--")).toBe(true);

      // Both blocks appear in the SAME consumer prompt, subagents first.
      const subIdx = consumer.prompt.indexOf("## Available sub-agents");
      const pubIdx = consumer.prompt.indexOf("## Available public agents");
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

      // Each consumer prompt lists the other in its public-agents section.
      expect(alpha.prompt).toContain("## Available public agents");
      expect(alpha.prompt).toContain("- `beta` — ");
      expect(beta.prompt).toContain("## Available public agents");
      expect(beta.prompt).toContain("- `alpha` — ");
    } finally {
      cleanup();
    }
  });
});

describe("Legacy exports compatibility", () => {
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

  it("ignores legacy exports and exposes only the top-level role", async () => {
    const { ctx, roleMap, cleanup } = setupExportsScenario();
    try {
      const resolved = await resolveAllRoles(roleMap, ctx);

      // Resolution completes with both roles; the consumer still receives the
      // producer's `## Available public agents` section.
      expect(resolved.length).toBe(2);
      const consumer = resolved.find((r) => r.id === "consumer")!;
      expect(consumer.prompt).toContain("- `producer` — Exports a known and an unknown subagent");

      const registry = collectOpenRoles(resolved);
      expect(registry.get("producer")!.exports).toEqual([]);
      expect(consumer.prompt).not.toContain("producer--helper");
      expect(consumer.prompt).not.toContain("missing-agent");
    } finally {
      cleanup();
    }
  });
});
