
/**
 * dsh browse-use gate — registration.
 *
 * The plugin registers the 22-tool browse family only when the resolved gate is
 * on AND the host can enforce per-role restrictions (`ctx.tools.guard`). The
 * gate is checked BEFORE `enabledNamespaces`, so a wildcard profile — the
 * common `["*"]` shape — can never turn the family on by itself.
 *
 * Every case runs under an isolated global config directory and an isolated
 * workspace, so neither a developer's `~/.config/rolebox/config.yaml` nor the
 * checkout's `.rolebox/config.json` can decide an outcome.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { apply } from "../src/entries/dsh.ts";
import type {
  DshPluginConfig,
  DshPluginContext,
  DshPluginDisposer,
} from "../src/entries/dsh.ts";
import type { DshSubagentProvider } from "../src/entries/dsh.ts";
import type { DshSubagentDispatchRuntime } from "../src/platform/adapters/dsh/dispatch.ts";
import type { DshToolGuardExecution } from "../src/platform/adapters/dsh/role-tool-policy.ts";
import type { DshSessionStoreLike } from "../src/platform/adapters/dsh/session.ts";
import type { DshToolDefinition } from "../src/platform/adapters/dsh/tool-factory.ts";
import { BROWSE_TOOL_NAMES } from "../src/loader/browse-grants.ts";
import { BrowseSessionManager } from "../src/browse/session.ts";
import { getRootLogger } from "../src/logger.ts";

const SIMPLE_ROLE = [
  "name: Test Role",
  "description: A minimal role for the dsh browse registration test",
  "prompt: You are a test role.",
].join("\n");

// ── Fake cordis ctx ─────────────────────────────────────────────────────────

function createFakeCtx(options: { withGuard?: boolean; takenTools?: ReadonlySet<string> } = {}) {
  const registeredTools: DshToolDefinition[] = [];
  const providers = new Map<string, DshSubagentProvider>();
  const guards: Array<(execution: DshToolGuardExecution) => string | undefined> = [];

  const lookup = (name: string): unknown =>
    options.takenTools?.has(name) || registeredTools.some(def => def.name === name)
      ? { name, description: `host-owned ${name}`, parameters: {}, output: { schema: {}, render: () => [] }, execute: async () => ({}) }
      : undefined;

  const tools = {
    register(definition: DshToolDefinition): () => void {
      registeredTools.push(definition);
      return () => {
        const index = registeredTools.indexOf(definition);
        if (index >= 0) registeredTools.splice(index, 1);
      };
    },
    get: lookup,
    ...(options.withGuard === false ? {} : {
      guard(callback: (execution: DshToolGuardExecution) => string | undefined) {
        guards.push(callback);
        return () => {
          const index = guards.indexOf(callback);
          if (index >= 0) guards.splice(index, 1);
        };
      },
    }),
  };

  const subagents: DshSubagentDispatchRuntime = {
    registerProvider(provider: DshSubagentProvider): () => void {
      providers.set(provider.name, provider);
      return () => {
        providers.delete(provider.name);
      };
    },
    getProvider: (name: string) => providers.get(name),
    list: () => [...providers.keys()],
    startActivation: async () => ({
      childId: "fake-run",
      result: Promise.resolve({ stopReason: "completed", output: [] }),
      dispose: async () => {},
    }),
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
    get: () => undefined,
    on: () => () => {},
    emit: () => {},
  };

  return { ctx, tools, guards, providers, registeredTools };
}

// ── Harness ─────────────────────────────────────────────────────────────────

let tmpDir: string;
let workspaceDir: string;
let configDir: string;
let dataDir: string;
let priorCwd: string;
let priorConfigDir: string | undefined;
let priorDataDir: string | undefined;
const pendingDisposers = new Set<DshPluginDisposer>();

function writeRoleYaml(roleId: string, body: string): void {
  const roleDir = join(tmpDir, roleId);
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, "role.yaml"), body, "utf-8");
}

async function boot(ctx: DshPluginContext, config: DshPluginConfig): Promise<DshPluginDisposer> {
  const boot = await apply(ctx, config);
  const tracked = Object.assign(
    () => {
      pendingDisposers.delete(tracked);
      boot();
    },
    boot,
  ) as DshPluginDisposer;
  pendingDisposers.add(tracked);
  return tracked;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "rolebox-dsh-browse-"));
  workspaceDir = mkdtempSync(join(tmpdir(), "rolebox-dsh-browse-workspace-"));
  configDir = mkdtempSync(join(tmpdir(), "rolebox-dsh-browse-config-"));
  dataDir = mkdtempSync(join(tmpdir(), "rolebox-dsh-browse-data-"));
  priorCwd = process.cwd();
  priorConfigDir = process.env.ROLEBOX_CONFIG_DIR;
  priorDataDir = process.env.ROLEBOX_DATA_DIR;
  process.env.ROLEBOX_CONFIG_DIR = configDir;
  process.env.ROLEBOX_DATA_DIR = dataDir;
  process.chdir(workspaceDir);
});

afterEach(() => {
  for (const disposer of [...pendingDisposers]) {
    try {
      disposer();
    } catch {
      // a failing teardown must not mask the assertion that failed first
    }
  }
  pendingDisposers.clear();
  process.chdir(priorCwd);
  if (priorConfigDir === undefined) delete process.env.ROLEBOX_CONFIG_DIR;
  else process.env.ROLEBOX_CONFIG_DIR = priorConfigDir;
  if (priorDataDir === undefined) delete process.env.ROLEBOX_DATA_DIR;
  else process.env.ROLEBOX_DATA_DIR = priorDataDir;
  for (const dir of [tmpDir, workspaceDir, configDir, dataDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function browseKeys(registered: DshToolDefinition[]): string[] {
  return registered.map(tool => tool.name).filter(name => name.startsWith("browse_")).sort();
}

// ── Registration ────────────────────────────────────────────────────────────

describe("dsh browse-use gate — registration", () => {
  it('registers all 22 browse tools under enabledNamespaces ["*"] when the gate is on', async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, registeredTools } = createFakeCtx();

    const disposer = await boot(ctx, {
      roleboxDir: tmpDir,
      enabledNamespaces: ["*"],
      browseUse: true,
    } as DshPluginConfig);

    expect(browseKeys(registeredTools)).toEqual([...BROWSE_TOOL_NAMES].sort());
    expect(registeredTools.map(tool => tool.name)).toContain("hashline_read");
    disposer();
    expect(registeredTools).toHaveLength(0);
  });

  it("registers nothing when the gate is off, even under a wildcard namespace", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, registeredTools } = createFakeCtx();

    const disposer = await boot(ctx, {
      roleboxDir: tmpDir,
      enabledNamespaces: ["*"],
      browseUse: false,
    } as DshPluginConfig);

    expect(browseKeys(registeredTools)).toEqual([]);
    // The rest of the surface is untouched.
    expect(registeredTools.map(tool => tool.name)).toContain("hashline_read");
    disposer();
  });

  it("respects an explicit global config opt-out even when the host enables browse use", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    writeFileSync(join(configDir, "config.yaml"), "browseUse: false\nregistries: []\n", "utf-8");
    const { ctx, registeredTools } = createFakeCtx();

    const disposer = await boot(ctx, {
      roleboxDir: tmpDir,
      enabledNamespaces: ["*"],
      browseUse: true,
    } as DshPluginConfig);

    expect(browseKeys(registeredTools)).toEqual([]);
    disposer();
  });

  it("honors an explicit global config opt-in", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    writeFileSync(join(configDir, "config.yaml"), "browseUse: true\nregistries: []\n", "utf-8");
    const { ctx, registeredTools } = createFakeCtx();

    const disposer = await boot(ctx, { roleboxDir: tmpDir } as DshPluginConfig);

    expect(browseKeys(registeredTools)).toEqual([...BROWSE_TOOL_NAMES].sort());
    disposer();
  });

  it("checks the browse gate before the namespace filter", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, registeredTools } = createFakeCtx();

    // A narrowed profile that names no browse namespace registers none of the
    // family, even with the gate on…
    const narrowed = await boot(ctx, {
      roleboxDir: tmpDir,
      enabledNamespaces: ["hashline"],
      browseUse: true,
    } as DshPluginConfig);
    expect(browseKeys(registeredTools)).toEqual([]);
    expect(registeredTools.map(tool => tool.name)).toContain("hashline_read");
    narrowed();

    // …and the reverse direction is the interesting one: a wildcard namespace
    // that matches `browse_` cannot register the family behind an OFF gate.
    const { ctx: offCtx, registeredTools: offTools } = createFakeCtx();
    const off = await boot(offCtx, {
      roleboxDir: tmpDir,
      enabledNamespaces: ["*", "!hashline"],
      browseUse: false,
    } as DshPluginConfig);
    expect(browseKeys(offTools)).toEqual([]);
    off();

    // An exclusion may also name the family explicitly.
    const { ctx: excludedCtx, registeredTools: excludedTools } = createFakeCtx();
    const excluded = await boot(excludedCtx, {
      roleboxDir: tmpDir,
      enabledNamespaces: ["*", "!browse"],
      browseUse: true,
    } as DshPluginConfig);
    expect(browseKeys(excludedTools)).toEqual([]);
    expect(excludedTools.map(tool => tool.name)).toContain("hashline_read");
    excluded();
  });

  it("FAILS CLOSED — a host without ctx.tools.guard registers nothing", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, registeredTools } = createFakeCtx({ withGuard: false });

    const disposer = await boot(ctx, {
      roleboxDir: tmpDir,
      enabledNamespaces: ["*"],
      browseUse: true,
    } as DshPluginConfig);

    expect(browseKeys(registeredTools)).toEqual([]);
    expect(registeredTools.map(tool => tool.name)).toContain("hashline_read");
    disposer();
  });

  it("falls back to a collision alias when the host already owns a browse name", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, registeredTools } = createFakeCtx({ takenTools: new Set(["browse_open"]) });

    const disposer = await boot(ctx, {
      roleboxDir: tmpDir,
      browseUse: true,
    } as DshPluginConfig);

    const names = registeredTools.map(tool => tool.name);
    // The host's own `browse_open` is left alone; rolebox registers its copy
    // under the `rb_` prefix instead of failing the boot.
    expect(names).toContain("rb_browse_open");
    expect(names.filter(name => name.startsWith("browse_")).sort())
      .toEqual([...BROWSE_TOOL_NAMES].filter(name => name !== "browse_open").sort());
    disposer();
  });

  it("installs both family guards and releases them, closing browse sessions, on dispose", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const { ctx, guards } = createFakeCtx();
    const disposeSpy = vi.spyOn(BrowseSessionManager.prototype, "dispose");

    const disposer = await boot(ctx, {
      roleboxDir: tmpDir,
      browseUse: true,
    } as DshPluginConfig);
    // At least one guard per family (computer + browse); the plugin's worker
    // boundary installs its own as well.
    expect(guards.length).toBeGreaterThanOrEqual(2);
    expect(disposeSpy).not.toHaveBeenCalled();

    await disposer();
    expect(guards).toHaveLength(0);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    disposeSpy.mockRestore();
  });

  it("reports the resolved browse gate in the boot log", async () => {
    writeRoleYaml("tester", SIMPLE_ROLE);
    const lines: string[] = [];
    getRootLogger().attachTransport(entry => {
      try {
        lines.push(JSON.stringify(entry));
      } catch {
        // an unserializable entry is not the boot report
      }
    });

    const { ctx } = createFakeCtx();
    const disposer = await boot(ctx, {
      roleboxDir: tmpDir,
      browseUse: true,
    } as DshPluginConfig);

    const gate = lines.find(line => line.includes("Browse use gate resolved"));
    expect(gate).toBeDefined();
    expect(gate).toContain('"setting":"browseUse"');
    expect(gate).toContain('"enabled":true');
    expect(gate).toContain('"driverAvailable":true');
    const policy = lines.find(line => line.includes("Browse use policy"));
    expect(policy).toBeDefined();
    const bootReport = lines.filter(line => line.includes("Plugin initialized"))
      .map(line => JSON.parse(line) as Record<string, unknown>);
    const fields = bootReport.at(-1)?.["1"] as Record<string, unknown> | undefined;
    expect(fields?.browseUse).toBe(true);
    disposer();
  });
});
