/// <reference types="bun-types" />

/**
 * dsh cordis e2e tests — boot the rolebox plugin on a REAL
 * `@deepseek-ai/cordis` Context (a devDependency) with fake `tools`,
 * `sessions`, and `subagents` services mounted as cordis `Service`
 * subclasses.
 *
 * This is the integration layer above the fake-ctx unit tests
 * (tests/dsh-plugin.test.ts) and the mocked-service dispatch tests
 * (tests/dsh-dispatch.test.ts): it exercises the REAL cordis loading path —
 * `ctx.plugin()` with the plugin's `inject` dependency list, zod `Config`
 * validated through cordis's `~standard` resolution (contract §2.3/§2.4),
 * the fiber lifecycle, and the disposer collected on fiber dispose.
 *
 * Verifies (subtask 9 of the dsh adaptation strategy):
 *   - `ctx.plugin(roleboxPlugin, config)` boots on a real cordis Context
 *     with the three injected services mounted; `inject` resolves
 *   - roles are discovered/resolved from a temp rolebox dir and registered
 *     as subagent providers (provider name == role id)
 *   - tools are registered into `ctx.tools` (the compiled dsh tool set,
 *     incl. the graph_* tools)
 *   - an invalid config is rejected by cordis's config validation
 *   - ONE graph dispatch round-trips: graph_create → graph_add_node →
 *     graph_run → graph_status, dispatching through `ctx.subagents.start`
 *     and materializing the node result (output readable via
 *     graph_status include_output)
 *   - fiber dispose cleans up tool registrations + providers
 *   - the REAL `@deepseek-ai/dsh-system-prompt` SystemPrompt service mounted
 *     on the cordis Context: the `rolebox:role` section + `rolebox:context`
 *     entry register into it, and `systemPrompt.assemble({ agent: { id:
 *     sessionId }, scope: {} })` — the real harness context shape — renders
 *     the ACTIVE role's system prompt (with its <available_skills> and
 *     <available_references> blocks) after a switcher activation, and drops
 *     it again after the role is cleared
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Context, Service } from "@deepseek-ai/cordis";
import SystemPrompt, { renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import roleboxPlugin from "../src/dsh-plugin.ts";
import type { DshPluginDisposer } from "../src/dsh-plugin.ts";
import type { DshDefineToolOptions } from "../src/platform/adapters/dsh/tool-factory.ts";
import type {
  DshSubagentProvider,
  DshSubagentRun,
  DshSubagentStartRequest,
} from "../src/platform/adapters/dsh/agent-registrar.ts";
import type { DshWebRouteLike } from "../src/platform/adapters/dsh/web-role-switch-route.ts";

// ── Fake cordis services (mounted as real Service subclasses) ──────────────

/**
 * Fake `ctx.tools` service: records every registered tool definition and
 * returns disposers that remove them (mirrors the real ToolRuntime surface,
 * contract §3.1 `register(definition): () => void`).
 */
class FakeToolsService extends Service {
  readonly tools: DshDefineToolOptions[] = [];

  constructor(ctx: Context) {
    super(ctx, "tools");
  }

  register(def: DshDefineToolOptions): () => void {
    this.tools.push(def);
    return () => {
      const i = this.tools.indexOf(def);
      if (i >= 0) this.tools.splice(i, 1);
    };
  }
}

/**
 * Fake `ctx.subagents` service (contract §4.3 `SubagentRuntime`): a catalog
 * seam (`registerProvider`/`getProvider`/`list`) plus `start()`, which
 * returns a run that settles as `completed` on a microtask — so a graph
 * dispatch through the DshDispatchAdapter round-trips without a real
 * spawn provider. Records every start request for assertions.
 */
class FakeSubagentsService extends Service {
  readonly providers = new Map<string, DshSubagentProvider>();
  readonly started: Array<{ name: string; request: DshSubagentStartRequest }> = [];

  constructor(ctx: Context) {
    super(ctx, "subagents");
  }

  registerProvider(provider: DshSubagentProvider): () => void {
    this.providers.set(provider.name, provider);
    return () => {
      this.providers.delete(provider.name);
    };
  }

  getProvider(name: string): DshSubagentProvider | undefined {
    return this.providers.get(name);
  }

  list(): string[] {
    return [...this.providers.keys()];
  }

  async start(
    name: string,
    request: DshSubagentStartRequest,
  ): Promise<DshSubagentRun> {
    this.started.push({ name, request });
    return {
      id: `dsh-e2e-run-${name}`,
      result: Promise.resolve({
        stopReason: "completed",
        output: [{ type: "text", text: `dsh e2e worker for ${name} finished` }],
      }),
      dispose: async () => {},
    };
  }
}

/**
 * Fake `ctx.sessions` service (contract §4.1 `SessionStore`): minimal
 * structural surface consumed by `DshSessionAdapter`.
 */
class FakeSessionsService extends Service {
  constructor(ctx: Context) {
    super(ctx, "sessions");
  }

  create(id?: string) {
    return {
      id: id ?? "e2e-session",
      seq: 0,
      events: [],
      header: { cwd: process.cwd() },
      append: () => ({ type: "log/only", seq: 0 } as never),
      deriveMessages: () => [],
    };
  }

  get() {
    return undefined;
  }

  list() {
    return [];
  }

  fork() {
    return { id: "e2e-fork", seq: 0, events: [] } as never;
  }
}

/**
 * Fake `ctx.webServer` service (the dsh host web server seam, contract §4.4):
 * captures every `register(route)` call so tests can drive the plugin's own
 * `/rolebox` role-switch route handler — the ONLY reachable surface for the
 * `DshRoleSwitcher` constructed inside `apply()` (the same pattern as
 * tests/dsh-plugin.test.ts).
 */
class FakeWebServerService extends Service {
  readonly routes: DshWebRouteLike[] = [];

  constructor(ctx: Context) {
    super(ctx, "webServer");
  }

  register(route: DshWebRouteLike): () => void {
    this.routes.push(route);
    return () => {
      const i = this.routes.indexOf(route);
      if (i >= 0) this.routes.splice(i, 1);
    };
  }
}

// ── Minimal HTTP doubles for driving the registered /rolebox route handler ──
//
// No node:http server is ever created — the handler is invoked directly with
// IncomingMessage/ServerResponse doubles, matching
// tests/platform/dsh-role-switch-route.test.ts and tests/dsh-plugin.test.ts.

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
  push(chunk: string): void {
    const buf = Buffer.from(chunk);
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
): Promise<{ status: number; text: string }> {
  const req = new MockReq(method, path);
  const res = new MockRes();
  const pending = handler(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
  );
  if (body !== undefined) req.push(body);
  req.finish();
  await pending;
  return { status: res.statusCode, text: res.body };
}

// ── Fixtures ───────────────────────────────────────────────────────────────

let tmpDir: string;
let oldCwd: string;
let oldDshHome: string | undefined;

const SIMPLE_ROLE = [
  "name: Tester",
  "description: e2e role for the cordis boot test",
  "prompt: You are the tester.",
].join("\n");

// ── Real-registry fixture: a primary role carrying skills + references ─────
//
// The resolver turns `skills:` + the `references/` dir into the role's
// systemPrompt via buildAgentPrompt (prompt/builder.ts), which renders the
// <available_skills> and <available_references> blocks. The prompt and the
// descriptions deliberately avoid `{{` so the registry's strict
// renderPrompt interpolation never trips.

const PROMPTER_ROLE = [
  "name: Prompter",
  "description: e2e role with skills and references for the real-registry test",
  "prompt: You are the prompter for the real registry test.",
  "skills:",
  "  - checklist",
].join("\n");

const CHECKLIST_SKILL = [
  "---",
  "name: checklist",
  "description: A checklist skill for the prompter role.",
  "---",
  "# Checklist",
  "Follow the checklist before answering.",
  "",
].join("\n");

const GUIDELINES_REFERENCE = [
  "---",
  "description: Prompting guidelines for the prompter role.",
  "---",
  "# Guidelines",
  "Be concise and cite sources.",
  "",
].join("\n");

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "rolebox-dsh-cordis-"));
  // Isolate the dsh home (LoopStore persists under `configDir`) and the
  // working dir (result sidecars + engine state land under `.rolebox/state`)
  // into the temp dir so the test never touches the real ~/.dsh or the repo.
  oldDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(tmpDir, "dsh-home");
  oldCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(oldCwd);
  if (oldDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = oldDshHome;
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeRoleYaml(roleId: string, body: string): void {
  const roleDir = join(tmpDir, roleId);
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, "role.yaml"), body, "utf-8");
}

/**
 * Boot the plugin on a real cordis Context: mount the three fake services,
 * then `ctx.plugin(roleboxPlugin, config)`. The default export is the cordis
 * Object plugin `{ name, inject, Config, apply }`; `apply` is wrapped to
 * capture the disposer (and its stats) that cordis collects as the fiber
 * effect. Returns the context, the fake services, the fiber, and the
 * captured disposer.
 */
async function bootPlugin(config: Record<string, unknown> = {}) {
  const ctx = new Context();
  const tools = new FakeToolsService(ctx);
  const subagents = new FakeSubagentsService(ctx);
  const sessions = new FakeSessionsService(ctx);

  let disposer: DshPluginDisposer | undefined;
  const wrapped = {
    ...roleboxPlugin,
    apply: async (c: unknown, cfg: unknown) => {
      const d = await roleboxPlugin.apply(c as never, cfg as never);
      disposer = d;
      return d;
    },
  };

  const fiber = await ctx.plugin(wrapped as never, config as never);
  // Let the async apply + any microtask-settled wiring finish.
  await new Promise((r) => setTimeout(r, 10));

  return { ctx, tools, subagents, sessions, fiber, disposer };
}

/**
 * Boot the plugin on a real cordis Context in the FULL-profile shape: the
 * three fake services PLUS a fake host `webServer` service (so the plugin
 * registers its `/rolebox` role-switch route — the reachable surface for the
 * internal switcher) and the REAL `@deepseek-ai/dsh-system-prompt`
 * SystemPrompt service mounted via `ctx.plugin(SystemPrompt, {})` (cordis
 * loads the Service subclass, validating its schemastery `Config` through
 * `~standard` — the exact path a dsh full profile uses for the
 * `system-prompt` bundle row). Returns the context, the fakes, the mounted
 * SystemPrompt service, the fiber, and the captured disposer.
 */
async function bootPromptFixture(config: Record<string, unknown> = {}) {
  const ctx = new Context();
  const tools = new FakeToolsService(ctx);
  const subagents = new FakeSubagentsService(ctx);
  const sessions = new FakeSessionsService(ctx);
  const webServer = new FakeWebServerService(ctx);

  // The real registry service, mounted BEFORE the plugin so `apply()`'s
  // probeSystemPrompt finds it on the ctx. The `{}` config is validated
  // through the service's schemastery `Config` (~standard), every field
  // optional — defaults applied.
  await ctx.plugin(SystemPrompt as never, {} as never);
  const systemPrompt = ctx.systemPrompt;

  let disposer: DshPluginDisposer | undefined;
  const wrapped = {
    ...roleboxPlugin,
    apply: async (c: unknown, cfg: unknown) => {
      const d = await roleboxPlugin.apply(c as never, cfg as never);
      disposer = d;
      return d;
    },
  };

  const fiber = await ctx.plugin(wrapped as never, config as never);
  await new Promise((r) => setTimeout(r, 10));

  return { ctx, tools, subagents, sessions, webServer, systemPrompt, fiber, disposer };
}

/** Execute a registered tool definition with a minimal dsh exec context. */
function runTool(
  tool: DshDefineToolOptions | undefined,
  args: Record<string, unknown>,
): Promise<unknown> {
  expect(tool, "expected a registered tool definition").toBeDefined();
  return tool!.execute(args, { signal: new AbortController().signal });
}

// ── Real cordis boot ───────────────────────────────────────────────────────

describe("rolebox plugin on a real cordis Context", () => {
  it("boots via ctx.plugin(), resolves roles, registers tools and providers", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { tools, subagents, fiber, disposer } = await bootPlugin({
      roleboxDir: tmpDir,
    });

    // inject resolved: the plugin activated and apply() ran.
    expect(disposer).toBeDefined();
    expect(disposer!.stats.dispatchMode).toBe("dsh");
    expect(disposer!.stats.loopWired).toBe(true);

    // Roles resolved from the temp rolebox dir.
    expect(disposer!.stats.discovered).toBeGreaterThanOrEqual(1);
    expect(disposer!.stats.resolved).toBeGreaterThanOrEqual(1);
    expect(disposer!.stats.resolvedRoles.map((r) => r.id)).toContain("tester");

    // The resolved role became a subagent provider (name == role id).
    expect(subagents.providers.size).toBeGreaterThanOrEqual(1);
    expect([...subagents.providers.keys()]).toContain("tester");
    expect(disposer!.stats.registeredAgents).toBe(subagents.providers.size);

    // Tools registered into ctx.tools — incl. the graph_* orchestration set.
    expect(tools.tools.length).toBeGreaterThanOrEqual(1);
    expect(disposer!.stats.registeredTools).toBe(tools.tools.length);
    const names = new Set(tools.tools.map((t) => t.name));
    expect(names.has("graph_create")).toBe(true);
    expect(names.has("graph_add_node")).toBe(true);
    expect(names.has("graph_run")).toBe(true);
    expect(names.has("graph_status")).toBe(true);

    fiber.dispose();
    await new Promise((r) => setTimeout(r, 10));
  });

  it("rejects an invalid config through cordis's ~standard validation", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const ctx = new Context();
    new FakeToolsService(ctx);
    new FakeSubagentsService(ctx);
    new FakeSessionsService(ctx);

    // Note: cordis's plugin() returns a custom thenable (the fiber wrapper);
    // bun's expect().rejects resolves it as a plain value, so assert via
    // try/catch around an await — same rejection path, no bun quirk.
    let err: unknown;
    try {
      await ctx.plugin(roleboxPlugin as never, { roleboxDir: 42 } as never);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String((err as Error)?.message ?? err)).toMatch(/roleboxDir|invalid config/i);
  });

  it("fiber dispose cleans up tool registrations and providers", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { tools, subagents, fiber } = await bootPlugin({
      roleboxDir: tmpDir,
    });
    expect(tools.tools.length).toBeGreaterThanOrEqual(1);
    expect(subagents.providers.size).toBeGreaterThanOrEqual(1);

    fiber.dispose();
    await new Promise((r) => setTimeout(r, 30));

    // Tool disposers ran (synchronous) and the registrar's async unregister
    // settled on the microtask loop.
    expect(tools.tools).toHaveLength(0);
    expect(subagents.providers.size).toBe(0);
  });
});

// ── Graph dispatch round-trip through the real cordis boot ─────────────────

describe("graph dispatch round-trip on the real cordis boot", () => {
  it("dispatches one node through ctx.subagents.start and materializes its result", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { tools, subagents, fiber, disposer } = await bootPlugin({
      roleboxDir: tmpDir,
    });
    const byName = new Map(tools.tools.map((t) => [t.name, t]));

    // 1. graph_create
    const created = JSON.parse(
      String(await runTool(byName.get("graph_create"), { name: "e2e-graph" })),
    ) as { graph_id: string };
    expect(created.graph_id).toBe("e2e-graph");

    // 2. graph_add_node — agent = the registered provider (role id "tester").
    await runTool(byName.get("graph_add_node"), {
      graph_id: created.graph_id,
      id: "N1",
      agent: "tester",
      prompt: "execute this node",
    });

    // 3. graph_run — non-blocking dispatch through the dsh subagent seam.
    await runTool(byName.get("graph_run"), { graph_id: created.graph_id });

    // The DshDispatchAdapter called ctx.subagents.start with the per-role
    // agent mapping and the node prompt as text content.
    expect(subagents.started).toHaveLength(1);
    expect(subagents.started[0].name).toBe("tester");
    expect(subagents.started[0].request.prompt).toEqual([
      { type: "text", text: "execute this node" },
    ]);
    expect(subagents.started[0].request.signal).toBeInstanceOf(AbortSignal);

    // 4. graph_status — wait for the run to settle and the engine to advance.
    let node: { node_id: string; status: string } | undefined;
    let graph: { phase: string; nodes: Array<{ node_id: string; status: string }> };
    const deadline = Date.now() + 2000;
    do {
      await new Promise((r) => setTimeout(r, 25));
      graph = JSON.parse(
        String(
          await runTool(byName.get("graph_status"), {
            graph_id: created.graph_id,
            format: "json",
          }),
        ),
      ) as typeof graph;
      node = graph.nodes.find((n) => n.node_id === "N1");
    } while (
      node?.status !== "completed" &&
      graph.phase !== "complete" &&
      Date.now() < deadline
    );

    expect(node?.status).toBe("completed");
    expect(graph.phase).toBe("complete");

    // The node result is materialized — readable via include_output.
    const withOutput = JSON.parse(
      String(
        await runTool(byName.get("graph_status"), {
          graph_id: created.graph_id,
          node_id: "N1",
          format: "json",
          include_output: true,
        }),
      ),
    ) as { output?: string };
    expect(String(withOutput.output ?? "")).toContain(
      "dsh e2e worker for tester finished",
    );

    expect(disposer!.stats.dispatchMode).toBe("dsh");
    fiber.dispose();
    await new Promise((r) => setTimeout(r, 10));
  });
});

// ── Real @deepseek-ai/dsh-system-prompt registry (subtask 6) ────────────────

describe("real @deepseek-ai/dsh-system-prompt registry on the cordis boot", () => {
  const SESSION_ID = "session-6";

  it("injects the active role's prompt + skills/references into the assembled prompt, and drops them on clear", async () => {
    // Temp rolebox dir: a primary role with one skill and one reference.
    writeRoleYaml("prompter", PROMPTER_ROLE);
    mkdirSync(join(tmpDir, "prompter", "skills", "checklist"), { recursive: true });
    writeFileSync(
      join(tmpDir, "prompter", "skills", "checklist", "SKILL.md"),
      CHECKLIST_SKILL,
      "utf-8",
    );
    mkdirSync(join(tmpDir, "prompter", "references"), { recursive: true });
    writeFileSync(
      join(tmpDir, "prompter", "references", "guidelines.md"),
      GUIDELINES_REFERENCE,
      "utf-8",
    );

    const { webServer, systemPrompt, fiber, disposer } = await bootPromptFixture({
      roleboxDir: tmpDir,
    });

    // The real registry is mounted and the plugin registered into it: the
    // systemPrompt service resolved on the ctx, and the /rolebox route was
    // registered on the fake host web server (webRouteRegistered proves the
    // probe found the service).
    expect(systemPrompt).toBeDefined();
    expect(disposer!.stats.webRouteRegistered).toBe(true);
    expect(webServer.routes).toHaveLength(1);
    const route = webServer.routes[0];
    expect(route.kind).toBe("prefix");
    expect(route.path).toBe("/rolebox");

    // Assemble BEFORE any switch: no role active → the rolebox:role section
    // renders '' and renderPrompt drops it — base-agent prompt only.
    const before = renderPrompt(
      await systemPrompt.assemble({
        agent: { id: SESSION_ID },
        scope: {},
      } as never),
    );
    expect(before).not.toContain("You are the prompter for the real registry test.");
    expect(before).not.toContain("<available_skills>");
    expect(before).not.toContain("<available_references>");

    // Activate the role for the session via the switcher's /rolebox surface
    // (the route handler delegates to DshRoleSwitcher.activate; the session
    // rides in the request body — the `?session=` query is only read by the
    // GET/DELETE active handlers).
    const switched = await invoke(
      route.handler,
      "POST",
      "/rolebox/roles/switch",
      JSON.stringify({ role: "prompter", session: SESSION_ID }),
    );
    expect(switched.status).toBe(200);

    // Assemble with the REAL harness context shape ({ agent, scope } — the
    // adapter resolves the session from agent.id): the rendered prompt now
    // carries the active role's systemPrompt — its own prompt text plus the
    // <available_skills> and <available_references> blocks the resolver
    // baked in from the role's skill + references dir.
    const assembly = await systemPrompt.assemble({
      agent: { id: SESSION_ID },
      scope: {},
    } as never);
    const rendered = renderPrompt(assembly);
    expect(rendered).toContain("You are the prompter for the real registry test.");
    expect(rendered).toContain("<available_skills>");
    expect(rendered).toContain("checklist");
    expect(rendered).toContain("<available_references>");
    expect(rendered).toContain("guidelines");

    // The contribution is a named, ordered section of the real assembly.
    const roleSection = assembly.sections.find((s) => s.name === "rolebox:role");
    expect(roleSection).toBeDefined();
    expect(roleSection!.text).toContain("You are the prompter for the real registry test.");

    // Clear the active role for the session → the NEXT assembly drops the
    // rolebox section (its provider re-evaluates live and returns '').
    const cleared = await invoke(
      route.handler,
      "DELETE",
      `/rolebox/roles/active?session=${SESSION_ID}`,
    );
    expect(cleared.status).toBe(200);

    const after = renderPrompt(
      await systemPrompt.assemble({
        agent: { id: SESSION_ID },
        scope: {},
      } as never),
    );
    expect(after).not.toContain("You are the prompter for the real registry test.");
    expect(after).not.toContain("<available_skills>");
    expect(after).not.toContain("<available_references>");

    fiber.dispose();
    await new Promise((r) => setTimeout(r, 10));
  });
});
