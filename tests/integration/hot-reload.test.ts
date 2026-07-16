/**
 * Integration tests for HotReloadService — real file-system reload cascade.
 *
 * Uses REAL fs operations and the production PluginCore composition —
 * no mocked fs, no mocked core, no mocked watcher.
 */

import { describe, it, expect } from "bun:test";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createTestContext,
  cleanupTestState,
  MINIMAL_PRIMARY_ID,
  type TestContext,
} from "./helpers.ts";

// ── Constants ───────────────────────────────────────────────────────────────

/** Wait time for service restart to settle after tool-triggered reload. */
const RELOAD_SETTLE_MS = 500;

// ── Helpers ─────────────────────────────────────────────────────────────────

async function buildAgentConfig(
  hooks: TestContext["hooks"],
): Promise<Record<string, any>> {
  const cfg: Record<string, any> = { agent: {} };
  await hooks.config(cfg);
  return cfg;
}

async function triggerReload(
  hooks: TestContext["hooks"],
): Promise<string> {
  const tool = hooks.tool as Record<string, any> | undefined;
  const reloadTool = tool!.asset_hot_reload as
    | { execute: (...args: unknown[]) => Promise<string> }
    | undefined;
  return await reloadTool!.execute({ type: "role" }, {} as any);
}

function expectPrimaryAgent(
  config: Record<string, any>,
  roleId: string,
): Record<string, any> {
  expect(config.agent).toBeDefined();
  const agent = config.agent[roleId];
  expect(agent).toBeDefined();
  return agent;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("HotReloadService cascade", () => {
  it("reloads without file changes — role state preserved after reload", async () => {
    cleanupTestState();
    const ctx = await createTestContext();
    try {
      const initialCfg = await buildAgentConfig(ctx.hooks);
      expectPrimaryAgent(initialCfg, MINIMAL_PRIMARY_ID);

      const result = await triggerReload(ctx.hooks);
      expect(result).toContain("completed");
      await Bun.sleep(RELOAD_SETTLE_MS);

      const afterCfg = await buildAgentConfig(ctx.hooks);
      const agent = expectPrimaryAgent(afterCfg, MINIMAL_PRIMARY_ID);
      expect(agent.mode).toBe("primary");
      expect(agent.description).toBe("Primary test role for integration tests");
    } finally {
      ctx.cleanup();
    }
  });

  it("reload after writing updated YAML — picks up changed description", async () => {
    cleanupTestState();
    const ctx = await createTestContext();
    try {
      // Initial state
      const initialCfg = await buildAgentConfig(ctx.hooks);
      expectPrimaryAgent(initialCfg, MINIMAL_PRIMARY_ID);

      // Write updated YAML
      const yamlPath = join(ctx.tmpDir, MINIMAL_PRIMARY_ID, "role.yaml");
      const currentYaml = readFileSync(yamlPath, "utf-8");
      const updatedYaml = currentYaml.replace(
        "Primary test role for integration tests",
        "RELOADED-DESC",
      );
      writeFileSync(yamlPath, updatedYaml, "utf-8");

      // Trigger reload via tool
      const result = await triggerReload(ctx.hooks);
      expect(result).toContain("completed");
      await Bun.sleep(RELOAD_SETTLE_MS);

      // Verify updated description
      const updatedCfg = await buildAgentConfig(ctx.hooks);
      const agent = expectPrimaryAgent(updatedCfg, MINIMAL_PRIMARY_ID);
      expect(agent.description).toBe("RELOADED-DESC");
    } finally {
      ctx.cleanup();
    }
  });
});
