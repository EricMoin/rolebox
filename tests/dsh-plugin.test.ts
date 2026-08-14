/// <reference types="bun-types" />

/**
 * dsh-plugin tests — the cordis plugin entry point (`src/dsh-plugin.ts`)
 * booted on a minimal fake cordis ctx against a temp rolebox directory.
 *
 * Verifies:
 *   - the plugin shape (name/inject/Config/apply) matches the verified cordis
 *     plugin conventions (`docs/dsh-plugin-contract.md` §2.2)
 *   - Config is a StandardSchemaV1 schema (contract §2.4 mechanism)
 *   - apply() resolves roles from a temp rolebox dir, registers >= 1 tool
 *     into the fake tools registry, syncs agents into the fake subagents
 *     catalog, and reports the discovered/resolved/skipped counts
 *   - the enabledNamespaces tool filter and the defaultRole promotion
 *   - the disposer cleans up registrations/listeners
 *   - the plugin source stays free of @opencode-ai / @deepseek-ai imports
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { load } from "js-yaml";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { apply, name, inject, Config } from "../src/dsh-plugin.ts";
import type {
  DshPluginContext,
  DshPluginDisposer,
  DshPluginStats,
  DshPluginConfig,
} from "../src/dsh-plugin.ts";
import type { DshDefineToolOptions } from "../src/platform/adapters/dsh/tool-factory.ts";
import type {
  DshSubagentProvider,
} from "../src/platform/adapters/dsh/agent-registrar.ts";
import type { DshSubagentDispatchRuntime } from "../src/platform/adapters/dsh/dispatch.ts";
import type { DshSessionStoreLike } from "../src/platform/adapters/dsh/session.ts";

// ── Fake cordis ctx double ─────────────────────────────────────────────────

/**
 * Minimal fake of the cordis Context + the three injected dsh services
 * (`tools`, `sessions`, `subagents`). Tracks tool registrations, subagent
 * provider registrations, and event subscriptions so tests can assert that
 * apply() wired everything.
 */
function createFakeCtx() {
  const registeredTools: DshDefineToolOptions[] = [];
  const providers = new Map<string, DshSubagentProvider>();
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  const tools = {
    registeredTools,
    register(definition: DshDefineToolOptions): () => void {
      registeredTools.push(definition);
      return () => {
        const i = registeredTools.indexOf(definition);
        if (i >= 0) registeredTools.splice(i, 1);
      };
    },
  };

  const subagents: DshSubagentDispatchRuntime = {
    registerProvider(provider: DshSubagentProvider): () => void {
      providers.set(provider.name, provider);
      return () => {
        providers.delete(provider.name);
      };
    },
    getProvider: (providerName: string) => providers.get(providerName),
    list: () => [...providers.keys()],
    // Dispatch seam (DshDispatchAdapter surface): this fake never actually
    // runs a subagent — apply() only wires the adapter; tests that exercise
    // dispatch use the dedicated mocked-service tests (tests/dsh-dispatch).
    start: async () => {
      throw new Error("dsh-dispatch: fake subagents.start not wired in this test");
    },
  };

  const sessions: DshSessionStoreLike = {
    create: (id?: string) => ({
      id: id ?? "session-1",
      seq: 0,
      events: [],
      header: { cwd: process.cwd() },
      append: () => ({ type: "log/only", seq: 0 } as never),
      deriveMessages: () => [],
    }),
    get: () => undefined,
    list: () => [],
    fork: () => ({ id: "session-fork", seq: 0, events: [] } as never),
  };

  const ctx: DshPluginContext = {
    tools,
    sessions,
    subagents,
    on(event: string, listener: (...args: unknown[]) => void) {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
      return () => {
        const cur = listeners.get(event) ?? [];
        listeners.set(
          event,
          cur.filter((l) => l !== listener),
        );
      };
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };

  return { ctx, tools, providers, listeners };
}

// ── Fixtures ───────────────────────────────────────────────────────────────

let tmpDir: string;

/** Create `{tmpDir}/{roleId}/role.yaml` with the given yaml body. */
function writeRoleYaml(roleId: string, body: string): void {
  const roleDir = join(tmpDir, roleId);
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, "role.yaml"), body, "utf-8");
}

const SIMPLE_ROLE = [
  "name: Test Role",
  "description: A minimal role for the dsh plugin test",
  "prompt: You are a test role.",
].join("\n");

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "rolebox-dsh-plugin-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Plugin shape ───────────────────────────────────────────────────────────

describe("dsh plugin shape", () => {
  it("exports the verified cordis plugin metadata (name/inject/Config/apply)", () => {
    expect(name).toBe("rolebox");
    // Contract §2.2 `inject` — the dsh services the adapters consume.
    expect(inject).toEqual(
      expect.arrayContaining(["tools", "sessions", "subagents"]),
    );
    // Contract §2.4 — Config is a StandardSchemaV1 schema.
    expect(typeof apply).toBe("function");
    expect((Config as unknown as { "~standard"?: unknown })["~standard"]).toBeDefined();
  });

  it("Config validates and defaults through the standard-schema interface", () => {
    const std = (Config as unknown as {
      "~standard": {
        validate(value: unknown): { value?: unknown; issues?: unknown[] };
      };
    })["~standard"];

    const ok = std.validate({ roleboxDir: "/tmp/rb", defaultRole: "admin" });
    expect("value" in ok).toBe(true);
    const value = ok.value as {
      roleboxDir?: string;
      skillsDir?: string;
      webEnabled?: boolean;
      webHost?: string;
      webPort?: number;
    };
    expect(value.roleboxDir).toBe("/tmp/rb");
    // Web role-switch defaults ride the validated output (Config uses
    // `.default(...)`, so the standard-schema validation applies them).
    expect(value.webEnabled).toBe(false);
    expect(value.webHost).toBe("127.0.0.1");
    expect(value.webPort).toBe(8787);
    // Absent optional keys validate to undefined — no required fields.
    const empty = std.validate({});
    expect("value" in empty).toBe(true);
    expect((empty.value as { webEnabled?: boolean }).webEnabled).toBe(false);
    expect((empty.value as { webHost?: string }).webHost).toBe("127.0.0.1");
    expect((empty.value as { webPort?: number }).webPort).toBe(8787);

    const bad = std.validate({ roleboxDir: 42 });
    expect("issues" in bad).toBe(true);
    expect((bad.issues as unknown[]).length).toBeGreaterThan(0);
  });
});

// ── apply() end-to-end on the fake ctx ─────────────────────────────────────

describe("dsh plugin apply()", () => {
  it("resolves roles from a temp rolebox dir, registers tools + agents, reports counts", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, tools, providers, listeners } = createFakeCtx();

    const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
    const stats: DshPluginStats = disposer.stats;

    // Role discovery/resolution against the temp dir.
    expect(stats.discovered).toBeGreaterThanOrEqual(1);
    expect(stats.resolved).toBeGreaterThanOrEqual(1);
    expect(stats.skipped).toBe(0);
    expect(stats.resolvedRoles.length).toBeGreaterThanOrEqual(1);

    // >= 1 tool registered into the fake tools registry, each well-formed.
    expect(tools.registeredTools.length).toBeGreaterThanOrEqual(1);
    for (const tool of tools.registeredTools) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.parameters).toBe("object");
      expect(typeof tool.execute).toBe("function");
    }
    expect(stats.registeredTools).toBe(tools.registeredTools.length);

    // Agents synced into the fake subagents catalog (the role + its agents).
    expect(providers.size).toBeGreaterThanOrEqual(1);
    expect([...providers.keys()]).toContain("tester");
    expect(stats.registeredAgents).toBe(providers.size);

    // Hooks mounted: the dsh extension-point listeners are subscribed.
    expect(listeners.has("tools/pre-execute")).toBe(true);
    expect(listeners.has("tools/post-execute")).toBe(true);
    expect(listeners.has("tools/result")).toBe(true);
    expect(listeners.has("session/event")).toBe(true);

    disposer();
  });

  it("registers every assembled tool when enabledNamespaces is absent", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, tools } = createFakeCtx();

    const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
    const keys = tools.registeredTools.map((t) => t.name);

    // The intersection tool set spans multiple namespaces.
    expect(keys).toContain("hashline_read");
    expect(keys).toContain("web_search");
    expect(keys).toContain("asset_search");

    disposer();
  });

  it("enabledNamespaces filters registered tools by exact name or prefix", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, tools } = createFakeCtx();

    const disposer = await apply(ctx, {
      roleboxDir: tmpDir,
      enabledNamespaces: ["hashline", "web"],
    } as DshPluginConfig);
    const keys = tools.registeredTools.map((t) => t.name);

    expect(keys.length).toBeGreaterThanOrEqual(1);
    for (const key of keys) {
      expect(key.startsWith("hashline_") || key.startsWith("web_")).toBe(true);
    }
    expect(keys).not.toContain("asset_search");

    disposer();
  });

  it("applies defaultRole promotion to the resolved roles", async () => {
    writeRoleYaml("alpha", SIMPLE_ROLE.replace("Test Role", "Alpha"));
    writeRoleYaml("beta", SIMPLE_ROLE.replace("Test Role", "Beta"));
    const { ctx } = createFakeCtx();

    const disposer = await apply(ctx, { roleboxDir: tmpDir, defaultRole: "beta" } as DshPluginConfig);
    const roles = disposer.stats.resolvedRoles;

    const alpha = roles.find((r) => r.id === "alpha");
    const beta = roles.find((r) => r.id === "beta");
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    // defaultRole demotes the other primary(s) and promotes the target.
    expect(alpha!.config.mode).toBe("all");
    expect(beta!.config.mode).toBe("primary");

    disposer();
  });

  it("disposer cleans up tool registrations and hook listeners", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, tools, listeners } = createFakeCtx();

    const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
    expect(tools.registeredTools.length).toBeGreaterThanOrEqual(1);

    disposer();

    expect(tools.registeredTools).toHaveLength(0);
    expect(listeners.get("tools/pre-execute") ?? []).toHaveLength(0);
    expect(listeners.get("session/event") ?? []).toHaveLength(0);
  });

  it("reports webServerStarted: false when the web role-switch server is not enabled", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx } = createFakeCtx();

    const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
    expect(disposer.stats.webServerStarted).toBe(false);

    disposer();
  });
});

// ── Bundle patch files parse as YAML ───────────────────────────────────────

describe("dsh bundle patch files", () => {
  const BUNDLE_PATCH = resolve(import.meta.dir, "../dsh/cordis.patch.yml");
  const EXAMPLE_PATCH = resolve(import.meta.dir, "../examples/dsh/cordis.patch.yml");

  it("the shipped bundle patch (dsh/cordis.patch.yml) parses as a YAML entry list", () => {
    const doc = load(readFileSync(BUNDLE_PATCH, "utf-8"));
    expect(Array.isArray(doc)).toBe(true);
    const entries = doc as unknown[];
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const first = entries[0] as { insert?: Array<{ id?: string; name?: string }> };
    expect(first.insert?.[0]?.id).toBe("rolebox");
    expect(first.insert?.[0]?.name).toBe("rolebox/dsh");
  });

  it("the configured example (examples/dsh/cordis.patch.yml) parses as a YAML entry list", () => {
    const doc = load(readFileSync(EXAMPLE_PATCH, "utf-8"));
    expect(Array.isArray(doc)).toBe(true);
    const entries = doc as unknown[];
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const insert = (entries[0] as { insert?: Array<{ id?: string; name?: string; config?: unknown }> })
      .insert?.[0];
    expect(insert?.id).toBe("rolebox");
    expect(insert?.name).toBe("rolebox/dsh");
    // Every Config option from the README table is representable.
    const config = insert?.config as Record<string, unknown> | undefined;
    expect(typeof config?.roleboxDir).toBe("string");
    expect(typeof config?.skillsDir).toBe("string");
    expect(typeof config?.defaultRole).toBe("string");
    expect(Array.isArray(config?.enabledNamespaces)).toBe(true);
  });
});

// ── Import hygiene ─────────────────────────────────────────────────────────

describe("dsh-plugin import hygiene", () => {
  const FILE = resolve(import.meta.dir, "../src/dsh-plugin.ts");

  function extractImportSpecifiers(source: string): string[] {
    const importRe =
      /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+["']([^"']+)["']/g;
    const specifiers: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(source)) !== null) {
      specifiers.push(match[1]);
    }
    return specifiers;
  }

  it("contains no @opencode-ai or @deepseek-ai imports", () => {
    const specifiers = extractImportSpecifiers(readFileSync(FILE, "utf-8"));
    const forbidden = specifiers.filter(
      (s) => s.includes("@opencode-ai/") || s.includes("@deepseek-ai/"),
    );
    expect(forbidden, `${FILE} imports platform SDK packages`).toEqual([]);
  });
});
