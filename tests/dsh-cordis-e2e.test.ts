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
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Context, Service } from "@deepseek-ai/cordis";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import roleboxPlugin from "../src/dsh-plugin.ts";
import type { DshPluginDisposer } from "../src/dsh-plugin.ts";
import type { DshDefineToolOptions } from "../src/platform/adapters/dsh/tool-factory.ts";
import type {
  DshSubagentProvider,
  DshSubagentRun,
  DshSubagentStartRequest,
} from "../src/platform/adapters/dsh/agent-registrar.ts";

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

// ── Fixtures ───────────────────────────────────────────────────────────────

let tmpDir: string;
let oldCwd: string;
let oldDshHome: string | undefined;

const SIMPLE_ROLE = [
  "name: Tester",
  "description: e2e role for the cordis boot test",
  "prompt: You are the tester.",
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
