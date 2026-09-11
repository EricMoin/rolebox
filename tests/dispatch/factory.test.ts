import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatchManager } from "../../src/dispatch/factory";
import { DEFAULT_CONFIG } from "../../src/dispatch/config";
import type { DispatchManagerConfig } from "../../src/dispatch/config";
import { RoleMode } from "../../src/constants";
import type { ResolvedRole, ResolvedSubAgent } from "../../src/types";
import { createMockClient } from "./helpers";

const savedEnv: Record<string, string | undefined> = {};

function resetEnvVars() {
  for (const key of [
    "ROLEBOX_DISPATCH_BG_STALE_MS",
    "ROLEBOX_DISPATCH_MATERIALIZE_TIMEOUT_MS",
    "ROLEBOX_DISPATCH_RESULT_RETENTION_MS",
  ]) {
    if (key in process.env) {
      savedEnv[key] = process.env[key];
    }
    delete process.env[key];
  }
}

function restoreEnvVars() {
  for (const key of Object.keys(savedEnv)) {
    process.env[key] = savedEnv[key];
  }
}

/** Build a minimal ResolvedRole fixture (mirrors resolver/orchestrator.ts output shape). */
function makeResolvedRole(overrides: {
  id: string;
  mode?: RoleMode;
  dispatchConfig?: Partial<DispatchManagerConfig>;
  subagents?: ResolvedSubAgent[];
}): ResolvedRole {
  return {
    id: overrides.id,
    config: {
      name: overrides.id,
      description: overrides.id,
      prompt: "test prompt",
      ...(overrides.mode ? { mode: overrides.mode } : {}),
    },
    prompt: "test prompt",
    skills: [],
    functions: [],
    references: [],
    subagents: overrides.subagents ?? [],
    ...(overrides.dispatchConfig
      ? { dispatchConfig: overrides.dispatchConfig }
      : {}),
  };
}

/** Role WITHOUT a dispatch: block — alphabetically first in the user's setup. */
function makeNoConfigPrimary(id: string): ResolvedRole {
  return makeResolvedRole({ id, mode: RoleMode.Primary });
}

/** Role WITH a dispatch: block — mirrors the emperor role's maxed-out limits. */
function makeConfigBearingPrimary(id: string): ResolvedRole {
  return makeResolvedRole({
    id,
    mode: RoleMode.Primary,
    dispatchConfig: {
      materializeTimeoutMs: 2147483647,
      backgroundStaleTimeoutMs: 2147483647,
    },
  });
}

describe("createDispatchManager primary-role selection", () => {
  const managed: { dispose: () => Promise<void> }[] = [];
  let tmpDir: string;

  beforeEach(() => {
    resetEnvVars();
    tmpDir = mkdtempSync(join(tmpdir(), "rolebox-factory-"));
  });

  afterEach(async () => {
    await Promise.all(managed.splice(0).map((m) => m.dispose()));
    restoreEnvVars();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createManager(resolvedRoles: ResolvedRole[]) {
    const result = await createDispatchManager({
      sessionClient: createMockClient(),
      resolvedRoles,
      storeDirectory: tmpDir,
    });
    managed.push(result.manager);
    return result.manager;
  }

  it("picks the later config-bearing primary over an alphabetically-first primary without a dispatch block", async () => {
    // User's setup: "ai-designer" (primary, no dispatch) sorts first;
    // "emperor" (primary, with dispatch block) is the config-bearing role.
    const manager = await createManager([
      makeNoConfigPrimary("ai-designer"),
      makeConfigBearingPrimary("emperor"),
    ]);

    const cfg = manager.getConfig();
    expect(cfg.materializeTimeoutMs).toBe(2147483647);
    expect(cfg.backgroundStaleTimeoutMs).toBe(2147483647);
  });

  it("prefers the FIRST config-bearing primary in resolvedRoles array order", async () => {
    // Both primaries carry a dispatch block — array order must be decisive.
    const manager = await createManager([
      makeResolvedRole({
        id: "alpha",
        mode: RoleMode.Primary,
        dispatchConfig: { materializeTimeoutMs: 7 },
      }),
      makeResolvedRole({
        id: "beta",
        mode: RoleMode.Primary,
        dispatchConfig: { materializeTimeoutMs: 9 },
      }),
    ]);

    expect(manager.getConfig().materializeTimeoutMs).toBe(7);
  });

  it("falls back to the first primary when no primary carries a dispatch block", async () => {
    // No config-bearing primary: historical first-primary behavior must win.
    const manager = await createManager([
      makeNoConfigPrimary("ai-designer"),
      makeNoConfigPrimary("emperor"),
    ]);

    expect(manager.getConfig().materializeTimeoutMs).toBe(
      DEFAULT_CONFIG.materializeTimeoutMs,
    );
  });

  it("single primary behaves exactly as before (zero behavior change)", async () => {
    const manager = await createManager([
      makeNoConfigPrimary("emperor"),
    ]);

    const cfg = manager.getConfig();
    expect(cfg.taskTtlMs).toBe(DEFAULT_CONFIG.taskTtlMs);
    expect(cfg.minRuntimeMs).toBe(DEFAULT_CONFIG.minRuntimeMs);
    expect(cfg.backgroundStaleTimeoutMs).toBe(DEFAULT_CONFIG.backgroundStaleTimeoutMs);
    // Removed concurrency fields must not surface on the effective config
    expect((cfg as any).maxConcurrent).toBeUndefined();
  });

  it("explicit primaryRole override still wins over deterministic selection", async () => {
    const emperor = makeConfigBearingPrimary("emperor");
    const aiDesigner = makeNoConfigPrimary("ai-designer");
    const result = await createDispatchManager({
      sessionClient: createMockClient(),
      resolvedRoles: [emperor, aiDesigner],
      storeDirectory: tmpDir,
      primaryRole: aiDesigner,
    });
    managed.push(result.manager);

    // The explicit primary (ai-designer) has no dispatch block → defaults apply.
    expect(result.manager.getConfig().backgroundStaleTimeoutMs).toBe(
      DEFAULT_CONFIG.backgroundStaleTimeoutMs,
    );
  });

  it("no primaries at all falls back to defaults without crashing", async () => {
    const manager = await createManager([
      makeResolvedRole({ id: "helper", mode: RoleMode.Subagent }),
    ]);

    expect(manager.getConfig().backgroundStaleTimeoutMs).toBe(
      DEFAULT_CONFIG.backgroundStaleTimeoutMs,
    );
  });
});
