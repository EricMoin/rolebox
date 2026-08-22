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
 *   - the optional host webServer seam: the `/rolebox` role-switch AND
 *     monitor (`/status`, `/metrics`) surfaces register — composed into ONE
 *     `/rolebox` prefix route (the real host webserver rejects duplicate
 *     prefix registrations) — when `ctx.get('webServer')` returns a
 *     registrar, and are skipped when absent
 *   - the optional systemPrompt seam: the `rolebox:role` section and
 *     `rolebox:context` context entry register on the service double, and
 *     the section provider serves the ACTIVE role's prompt after a switch;
 *     headless profiles (no service) degrade with unchanged stats
 *   - the disposer cleans up registrations/listeners
 *   - the plugin source stays free of @opencode-ai / @deepseek-ai imports
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { load } from "js-yaml";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
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
import type {
  DshSystemPromptContextEntry,
  DshSystemPromptRegistry,
  DshSystemPromptSection,
} from "../src/platform/adapters/dsh/system-prompt.ts";
import type {
  DshWebRouteLike,
  DshWebServerRouteRegistrar,
} from "../src/platform/adapters/dsh/web-role-switch-route.ts";

// ── Fake cordis ctx double ─────────────────────────────────────────────────

/**
 * Minimal fake of the cordis Context + the three injected dsh services
 * (`tools`, `sessions`, `subagents`) and the optional systemPrompt registry.
 * Tracks tool registrations, subagent provider registrations, event
 * subscriptions, and system-prompt section/context registrations so tests can
 * assert that apply() wired everything.
 *
 * The optional-service seam (`ctx.get`) resolves `"webServer"` to the
 * `webServer` option when supplied (a fake host-webserver registrar) and
 * `undefined` otherwise — mirroring the dsh host, where the web profile
 * registers the webserver service and headless profiles do not. The
 * `systemPrompt` option (default `false`) wires the factory's recording
 * system-prompt registry double onto `ctx.systemPrompt` (and
 * `ctx.get("systemPrompt")`) — mirroring the full profile, where the
 * `@deepseek-ai/dsh-system-prompt` service is mounted on the context; the
 * default leaves it absent so apply() exercises its graceful degrade.
 */
function createFakeCtx(
  options: {
    webServer?: DshWebServerRouteRegistrar | null;
    systemPrompt?: boolean;
  } = {},
) {
  const registeredTools: DshDefineToolOptions[] = [];
  const providers = new Map<string, DshSubagentProvider>();
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  // Recording system-prompt registry double: `section()`/`context()` record
  // every registration (so tests can inspect the entries and invoke their
  // `text` providers) and return disposers that record their invocation —
  // mirroring the real `@deepseek-ai/dsh-system-prompt` service surface.
  const sections: DshSystemPromptSection[] = [];
  const contexts: DshSystemPromptContextEntry[] = [];
  const promptDisposed: Array<{ kind: "section" | "context"; name: string }> = [];
  const systemPrompt: DshSystemPromptRegistry = {
    section(entry: DshSystemPromptSection): () => void {
      sections.push(entry);
      return () => {
        promptDisposed.push({ kind: "section", name: entry.name });
      };
    },
    context(entry: DshSystemPromptContextEntry): () => void {
      contexts.push(entry);
      return () => {
        promptDisposed.push({ kind: "context", name: entry.name });
      };
    },
  };

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
    // Optional-service seam (full profile): the system-prompt registry is
    // mounted directly on the context, mirroring the dsh host — and also
    // resolved by name for the probe's `ctx.get('systemPrompt')` fallback.
    ...(options.systemPrompt ? { systemPrompt } : {}),
    get(name: string): unknown {
      // Optional-service seam: the host web server and (in full profiles) the
      // system-prompt registry are probed by the plugin; every other name
      // resolves to undefined (absent).
      if (name === "webServer") return options.webServer ?? undefined;
      if (name === "systemPrompt") {
        return options.systemPrompt ? systemPrompt : undefined;
      }
      return undefined;
    },
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

  return { ctx, tools, providers, listeners, systemPrompt, sections, contexts };
}

// ── Mock req/res for driving the registered /rolebox route handler ──────────
//
// The role switcher created inside apply() is not exposed, so the tests reach
// its activate() through the /rolebox REST surface (the registered route
// handler delegates to DshRoleSwitcher.activate). Minimal
// IncomingMessage/ServerResponse doubles are used — no node:http server is
// ever created — the same pattern as tests/platform/dsh-role-switch-route.

/** Minimal IncomingMessage double: url/method + data/end/error listeners. */
class MockReq {
  url: string;
  method: string;
  private listeners = new Map<string, Array<(chunk?: unknown) => void>>();

  constructor(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  on(event: string, cb: (chunk?: unknown) => void) {
    const arr = this.listeners.get(event) ?? [];
    arr.push(cb);
    this.listeners.set(event, arr);
    return this;
  }

  /** Emit a body chunk to registered `data` listeners. */
  push(chunk: string | Buffer): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (const cb of this.listeners.get("data") ?? []) cb(buf);
  }

  /** Emit `end` to registered listeners. */
  finish(): void {
    for (const cb of this.listeners.get("end") ?? []) cb();
  }
}

/** Minimal ServerResponse double: records status/headers/body. */
class MockRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";
  headersSent = false;

  writeHead(status: number, headers: Record<string, string>) {
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }

  end(text = "") {
    this.body = text;
    return this;
  }
}

/** Invoke a route handler with a mock req/res and await completion. */
async function invoke(
  handler: DshWebRouteLike["handler"],
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const req = new MockReq(method, path);
  const res = new MockRes();
  const pending = handler(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
  );
  if (body !== undefined) req.push(body);
  req.finish();
  if (pending) await pending;
  return { status: res.statusCode, headers: res.headers, text: res.body };
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
      defaultRole?: string;
    };
    expect(value.roleboxDir).toBe("/tmp/rb");
    // Absent optional keys validate to undefined — no required fields.
    const empty = std.validate({});
    expect("value" in empty).toBe(true);

    const bad = std.validate({ roleboxDir: 42 });
    expect("issues" in bad).toBe(true);
    expect((bad.issues as unknown[]).length).toBeGreaterThan(0);
  });
});

// ── Packaging: the dsh-client-modules resolution seam ──────────────────────
//
// dsh-client-modules (node half) discovers dsh.client packages by resolving
// `require.resolve('<loader entry name>/package.json')` from the host context
// and parsing the manifest for `dsh.client` + `exports["./client"]`
// (lib/index.js:138-139, 238-264). rolebox's loader row is named
// `rolebox/dsh` (the cordis plugin lives at the `./dsh` sub-path export), so
// the exports map MUST expose `"./dsh/package.json"` or the entry is cached
// as a permanent negative verdict and the web client never reaches the boot
// graph. The browser half additionally requires the bundle envelope id to
// equal the graph row id (lib/client.js:84).

describe("dsh packaging — dsh-client-modules resolution seam", () => {
  const pkgRoot = resolve(import.meta.dir, "..");
  const pkg = JSON.parse(
    readFileSync(resolve(pkgRoot, "package.json"), "utf8"),
  ) as {
    dsh?: { client?: { platform?: string; inject?: string[] } };
    exports?: Record<string, unknown>;
  };

  it("declares the dsh.client web platform + inject roster", () => {
    expect(pkg.dsh?.client?.platform).toBe("web");
    expect(Array.isArray(pkg.dsh?.client?.inject)).toBe(true);
    expect(pkg.dsh?.client?.inject!.length).toBeGreaterThan(0);
  });

  it("exposes exports['./client'] pointing at the built bundle", () => {
    const client = pkg.exports?.["./client"] as
      | string
      | { default?: string }
      | undefined;
    const rel =
      typeof client === "string" ? client : client?.default;
    expect(typeof rel).toBe("string");
    expect(existsSync(resolve(pkgRoot, rel!))).toBe(true);
  });

  it("resolves require.resolve('rolebox/dsh/package.json') (the entry-name seam)", () => {
    // Mirror dsh-client-modules resolvePkgJson in the profile layout: the
    // host's createRequire is anchored at the profile/config tree, and the
    // profile installs rolebox as a `link:` dependency (pnpm link: → this
    // repo). Resolving the bare package spec 'rolebox/dsh/package.json' then
    // walks node_modules, follows the link, and consults THIS package.json's
    // exports map — which must expose './dsh/package.json'.
    const sandbox = mkdtempSync(join(tmpdir(), "rolebox-dsh-seam-"));
    try {
      const nm = join(sandbox, "node_modules");
      mkdirSync(nm, { recursive: true });
      symlinkSync(pkgRoot, join(nm, "rolebox"), "dir");
      const req = createRequire(join(sandbox, "host.js"));
      const resolved = req.resolve("rolebox/dsh/package.json");
      expect(resolved).toBe(resolve(pkgRoot, "package.json"));
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("builds the client bundle envelope with the graph-row id 'rolebox/dsh'", () => {
    const bundle = readFileSync(resolve(pkgRoot, "dist/dsh-web-client.js"), "utf8");
    expect(bundle.startsWith("window.__ModuleLoader__.load({")).toBe(true);
    expect(bundle).toContain('id: "rolebox/dsh"');
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

  it("registers /rolebox routes when ctx.get('webServer') returns a registrar", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const registered: DshWebRouteLike[] = [];
    const fakeWebServer: DshWebServerRouteRegistrar = {
      register(route: DshWebRouteLike): () => void {
        registered.push(route);
        return () => {
          const i = registered.indexOf(route);
          if (i >= 0) registered.splice(i, 1);
        };
      },
    };
    const { ctx } = createFakeCtx({ webServer: fakeWebServer });

    const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);

    // The seam registered the COMPOSED /rolebox prefix route exactly once:
    // the real host webserver rejects duplicate (kind, path) registrations
    // (`webserver: duplicate prefix route "/rolebox"`, lib/index.js:54-55),
    // so the role-switch surface and the monitor surface share one handler.
    expect(disposer.stats.webRouteRegistered).toBe(true);
    expect(disposer.stats.monitorRouteRegistered).toBe(true);
    expect(registered).toHaveLength(1);
    const route = registered[0];
    expect(route.kind).toBe("prefix");
    expect(route.path).toBe("/rolebox");
    expect(typeof route.handler).toBe("function");

    // The single composed handler serves BOTH surfaces: the role-switch
    // surface (/roles — a bare JSON array) and the monitor surface
    // (/status — the composed runtime snapshot, /metrics — the dispatch
    // metrics snapshot).
    const roles = await invoke(route.handler, "GET", "/rolebox/roles");
    expect(roles.status).toBe(200);
    expect(Array.isArray(JSON.parse(roles.text))).toBe(true);

    const metrics = await invoke(route.handler, "GET", "/rolebox/metrics");
    expect(metrics.status).toBe(200);
    const metricsBody = JSON.parse(metrics.text) as {
      counters: Record<string, unknown>;
      gauges: Record<string, unknown>;
      histograms: Record<string, unknown>;
    };
    expect(typeof metricsBody.counters).toBe("object");
    expect(typeof metricsBody.gauges).toBe("object");
    expect(typeof metricsBody.histograms).toBe("object");

    const status = await invoke(route.handler, "GET", "/rolebox/status");
    expect(status.status).toBe(200);
    const statusBody = JSON.parse(status.text) as {
      ok: boolean;
      loops: { count: number; states: unknown[] };
      engineGraphs: unknown[];
      sessions: {
        count: number;
        mostRecentId: string | null;
        activeRoles: Record<string, string | null>;
      };
    };
    expect(statusBody.ok).toBe(true);
    expect(typeof statusBody.loops.count).toBe("number");
    expect(Array.isArray(statusBody.loops.states)).toBe(true);
    expect(Array.isArray(statusBody.engineGraphs)).toBe(true);
    expect(typeof statusBody.sessions.count).toBe("number");
    expect(statusBody.sessions.mostRecentId).toBeNull();
    expect(statusBody.sessions.activeRoles).toEqual({});

    // The fiber disposer unmounts the route.
    disposer();
    expect(registered).toHaveLength(0);
  });

  it("registers the /rolebox prefix exactly once when the host rejects duplicate prefixes", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    // Mirror the real @deepseek-ai/dsh-host-webserver register(): duplicate
    // (kind, path) pairs THROW (`webserver: duplicate prefix route
    // "/rolebox"`, lib/index.js:54-55) — a tolerant array double would never
    // surface the collision this test guards against.
    const registered: DshWebRouteLike[] = [];
    const seenPaths = new Set<string>();
    const fakeWebServer: DshWebServerRouteRegistrar = {
      register(route: DshWebRouteLike): () => void {
        if (seenPaths.has(route.path)) {
          throw new Error(
            `webserver: duplicate ${route.kind} route "${route.path}"`,
          );
        }
        seenPaths.add(route.path);
        registered.push(route);
        return () => {
          const i = registered.indexOf(route);
          if (i >= 0) registered.splice(i, 1);
        };
      },
    };
    const { ctx } = createFakeCtx({ webServer: fakeWebServer });

    const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);

    // Exactly ONE registration under /rolebox — no duplicate was attempted
    // and nothing was swallowed: BOTH route surfaces report registered, and
    // the single composed handler serves the role-switch AND monitor faces.
    expect(registered).toHaveLength(1);
    expect(registered[0].kind).toBe("prefix");
    expect(registered[0].path).toBe("/rolebox");
    expect(disposer.stats.webRouteRegistered).toBe(true);
    expect(disposer.stats.monitorRouteRegistered).toBe(true);

    const roles = await invoke(registered[0].handler, "GET", "/rolebox/roles");
    expect(roles.status).toBe(200);
    expect(Array.isArray(JSON.parse(roles.text))).toBe(true);
    const status = await invoke(registered[0].handler, "GET", "/rolebox/status");
    expect(status.status).toBe(200);
    const metrics = await invoke(registered[0].handler, "GET", "/rolebox/metrics");
    expect(metrics.status).toBe(200);

    disposer();
    expect(registered).toHaveLength(0);
  });

  it("skips route registration when ctx.get('webServer') is absent", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx } = createFakeCtx(); // no webServer — headless profile

    const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
    expect(disposer.stats.webRouteRegistered).toBe(false);
    expect(disposer.stats.monitorRouteRegistered).toBe(false);

    disposer();
  });

  it("registers rolebox system-prompt contributions; the section provider serves the active role's prompt", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);

    // Host web server registrar — captures the registered /rolebox route so
    // the test can drive the switcher's REST surface (POST /roles/switch).
    const registeredRoutes: DshWebRouteLike[] = [];
    const fakeWebServer: DshWebServerRouteRegistrar = {
      register(route: DshWebRouteLike): () => void {
        registeredRoutes.push(route);
        return () => {
          const i = registeredRoutes.indexOf(route);
          if (i >= 0) registeredRoutes.splice(i, 1);
        };
      },
    };

    const { ctx, sections, contexts } = createFakeCtx({
      webServer: fakeWebServer,
      systemPrompt: true,
    });

    const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
    const stats = disposer.stats;

    // The prompt double recorded the two contributions at their documented
    // shape (section `rolebox:role` order 50, context `rolebox:context` order 0).
    expect(sections).toHaveLength(1);
    expect(sections[0].name).toBe("rolebox:role");
    expect(sections[0].order).toBe(50);
    expect(typeof sections[0].text).toBe("function");
    expect(contexts).toHaveLength(1);
    expect(contexts[0].name).toBe("rolebox:context");
    expect(contexts[0].order).toBe(0);
    expect(typeof contexts[0].text).toBe("function");

    // The prompt seam is additive — roles still resolve and tools still
    // register alongside the contributions.
    expect(stats.resolved).toBeGreaterThanOrEqual(1);
    expect(stats.registeredTools).toBeGreaterThanOrEqual(1);

    // Activate the role via the switcher: the /rolebox switch route delegates
    // to DshRoleSwitcher.activate(role, session) — the session rides in the
    // POST body (`{ role, session }`; the `?session=` query is only honored
    // by the GET/DELETE handlers).
    const sessionId = "session-1";
    const route = registeredRoutes[0];
    expect(route).toBeDefined();
    const switched = await invoke(
      route.handler,
      "POST",
      "/rolebox/roles/switch",
      JSON.stringify({ role: "tester", session: sessionId }),
    );
    expect(switched.status).toBe(200);

    // The registered section text provider now resolves the ACTIVE role's full
    // systemPrompt for the session. The adapter's resolution chain
    // (system-prompt.ts resolveActiveRolePrompt) reads the session id from the
    // context (sessionID/sessionId spellings) alongside agent.id — the exact
    // shape pinned by tests/platform/dsh-system-prompt.test.ts.
    expect(
      sections[0].text({ agent: { id: sessionId }, sessionID: sessionId }),
    ).toBe("You are a test role.");

    disposer();
  });

  it("degrades gracefully without a systemPrompt service — roles/tools still resolve, stats unchanged", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);

    // Baseline boot WITH the prompt seam present — the stats it reports.
    const withPrompt = createFakeCtx({ systemPrompt: true });
    const baselineDisposer = await apply(withPrompt.ctx, {
      roleboxDir: tmpDir,
    } as DshPluginConfig);

    // No systemPrompt double (the default fake — headless profile): apply()
    // must not throw, must still resolve roles + register tools/agents...
    const { ctx, tools, providers } = createFakeCtx();
    const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);
    const stats = disposer.stats;

    expect(stats.discovered).toBeGreaterThanOrEqual(1);
    expect(stats.resolved).toBeGreaterThanOrEqual(1);
    expect(stats.skipped).toBe(0);
    expect(tools.registeredTools.length).toBeGreaterThanOrEqual(1);
    expect(providers.size).toBeGreaterThanOrEqual(1);
    expect(stats.webRouteRegistered).toBe(false);

    // ...and the reported stats are identical to the seam-present boot: the
    // absent service adds no degradation marker and perturbs nothing.
    expect(stats).toEqual(baselineDisposer.stats);

    disposer();
    baselineDisposer();
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
