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
    "ROLEBOX_DISPATCH_MAX_CONCURRENT",
    "ROLEBOX_DISPATCH_MAX_QUEUE_DEPTH",
    "ROLEBOX_DISPATCH_SYNC_RESERVED",
    "ROLEBOX_DISPATCH_MAX_ACTIVE_PER_PARENT",
    "ROLEBOX_DISPATCH_RETRY_AFTER_MS",
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

/** Build a minimal ResolvedSubAgent fixture carrying an explicit model override. */
function makeChildSubagent(
  parentId: string,
  id: string,
  model: string,
): ResolvedSubAgent {
  return {
    id,
    config: { name: id, description: "d", prompt: "p", model },
    prompt: "p",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
    parentId,
    inheritedFrom: {},
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
      maxConcurrent: 2147483647,
      maxQueueDepth: 2147483647,
      maxActivePerParent: 2147483647,
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
    expect(cfg.maxConcurrent).toBe(2147483647);
    expect(cfg.maxQueueDepth).toBe(2147483647);
    expect(cfg.maxActivePerParent).toBe(2147483647);
  });

  it("prefers the FIRST config-bearing primary in resolvedRoles array order", async () => {
    // Both primaries carry a dispatch block — array order must be decisive.
    const manager = await createManager([
      makeResolvedRole({
        id: "alpha",
        mode: RoleMode.Primary,
        dispatchConfig: { maxConcurrent: 7 },
      }),
      makeResolvedRole({
        id: "beta",
        mode: RoleMode.Primary,
        dispatchConfig: { maxConcurrent: 9 },
      }),
    ]);

    expect(manager.getConfig().maxConcurrent).toBe(7);
  });

  it("two config-bearing primaries with same-model subagents get independent per-role composite keys", async () => {
    // Both primaries own a subagent using the SAME model id. The composite
    // concurrency keys must NOT collapse onto a single winner: each role's
    // key resolves its own limit from its own merged per-role config.
    const manager = await createManager([
      makeResolvedRole({
        id: "alpha",
        mode: RoleMode.Primary,
        dispatchConfig: { maxConcurrent: 7 },
        subagents: [makeChildSubagent("alpha", "alpha--child", "gpt-4")],
      }),
      makeResolvedRole({
        id: "beta",
        mode: RoleMode.Primary,
        dispatchConfig: { maxConcurrent: 9 },
        subagents: [makeChildSubagent("beta", "beta--child", "gpt-4")],
      }),
    ]);

    // Existing behavior unchanged: the manager-level config still comes from
    // the FIRST config-bearing primary (array order).
    expect(manager.getConfig().maxConcurrent).toBe(7);

    // Slots are lazily created — touch both composite keys with a
    // zero-occupancy probe so their per-role limits materialize.
    const cm = (manager as any).concurrency;
    cm.forceOccupyBackground("alpha::gpt-4", 0);
    cm.forceOccupyBackground("beta::gpt-4", 0);

    // Both composite keys exist with their OWN limits — no single-winner collapse.
    const status = manager.getConcurrencyStatus();
    const alphaKey = status.keys.find((k) => k.key === "alpha::gpt-4");
    const betaKey = status.keys.find((k) => k.key === "beta::gpt-4");
    expect(alphaKey).toBeDefined();
    expect(alphaKey!.limit).toBe(7);
    expect(betaKey).toBeDefined();
    expect(betaKey!.limit).toBe(9);
    expect(status.total.keys).toBe(2);

    // Per-key getLimit confirms the limits are role-scoped, not the manager-wide
    // default (which would resolve to 7 for BOTH keys if role configs were lost).
    expect(cm.getLimit("alpha::gpt-4")).toBe(7);
    expect(cm.getLimit("beta::gpt-4")).toBe(9);
  });

  it("falls back to the first primary when no primary carries a dispatch block", async () => {
    // No config-bearing primary: historical first-primary behavior must win.
    const manager = await createManager([
      makeNoConfigPrimary("ai-designer"),
      makeNoConfigPrimary("emperor"),
    ]);

    expect(manager.getConfig().maxConcurrent).toBe(
      DEFAULT_CONFIG.maxConcurrent,
    );
  });

  it("single primary behaves exactly as before (zero behavior change)", async () => {
    const manager = await createManager([
      makeNoConfigPrimary("emperor"),
    ]);

    const cfg = manager.getConfig();
    expect(cfg.maxConcurrent).toBe(DEFAULT_CONFIG.maxConcurrent);
    expect(cfg.maxQueueDepth).toBe(DEFAULT_CONFIG.maxQueueDepth);
    expect(cfg.maxActivePerParent).toBe(DEFAULT_CONFIG.maxActivePerParent);
    expect(cfg.maxConcurrent).toBe(5);
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
    expect(result.manager.getConfig().maxConcurrent).toBe(
      DEFAULT_CONFIG.maxConcurrent,
    );
  });

  it("no primaries at all falls back to defaults without crashing", async () => {
    const manager = await createManager([
      makeResolvedRole({ id: "helper", mode: RoleMode.Subagent }),
    ]);

    expect(manager.getConfig().maxConcurrent).toBe(
      DEFAULT_CONFIG.maxConcurrent,
    );
  });
});
