/**
 * Tests for the integration test harness (helpers.ts).
 *
 * Verifies:
 *   1. createTestContext() initializes without throwing
 *   2. The returned hooks object has expected hook methods
 *   3. Temporary directories are cleaned up after ctx.cleanup()
 *   4. cleanupTestState() resets module-level state
 *   5. The harness can be exercised end-to-end through tool hooks
 *   6. Concurrent createTestContext() calls use separate directories
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import {
  createTestContext,
  cleanupTestState,
  createMockClient,
  makeMinimalRole,
  makeMinimalSubagent,
  MINIMAL_PRIMARY_ID,
  MINIMAL_SUBAGENT_ID,
  type TestContext,
} from "./helpers.ts";

// ── State cleanup ───────────────────────────────────────────────────────────

beforeEach(() => {
  cleanupTestState();
});

afterEach(() => {
  mockRestoreAll();
});

/**
 * restoreAll mock wrappers. bun:test's mock.restore() is called via
 * cleanupTestState(), but we also defensive-restore in afterEach.
 */
function mockRestoreAll(): void {
  const { mock } = require("bun:test");
  mock.restore();
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("createMockClient", () => {
  it("returns an object with session methods", () => {
    const client = createMockClient();
    expect(client.session).toBeDefined();
    expect(client.session.create).toBeDefined();
    expect(client.session.prompt).toBeDefined();
    expect(client.session.messages).toBeDefined();
    expect(client.session.status).toBeDefined();
    expect(client.session.abort).toBeDefined();
    expect(client.session.get).toBeDefined();
  });

  it("session.create resolves to a predictable shape", async () => {
    const client = createMockClient();
    const result = await client.session.create();
    expect(result.data).toBeDefined();
    expect(result.data!.id).toBe("test-session-1");
  });
});

describe("makeMinimalRole", () => {
  it("returns a primary role with expected defaults", () => {
    const role = makeMinimalRole();
    expect(role.id).toBe(MINIMAL_PRIMARY_ID);
    expect(role.config.name).toBe("Test Primary");
    expect(role.config.mode).toBe("primary");
    expect(role.subagents).toHaveLength(1);
  });

  it("allows overrides", () => {
    const role = makeMinimalRole({ id: "custom-primary" });
    expect(role.id).toBe("custom-primary");
    // Functions, skills, refs should still be empty arrays
    expect(role.skills).toEqual([]);
  });
});

describe("makeMinimalSubagent", () => {
  it("returns a subagent linked to the primary role", () => {
    const sub = makeMinimalSubagent();
    expect(sub.id).toBe(MINIMAL_SUBAGENT_ID);
    expect(sub.parentId).toBe(MINIMAL_PRIMARY_ID);
  });
});

describe("createTestContext", () => {
  it("initializes without throwing", async () => {
    const ctx = await createTestContext();
    expect(ctx).toBeDefined();
    expect(ctx.tmpDir).toBeDefined();
    expect(ctx.hooks).toBeDefined();
    expect(ctx.role).toBeDefined();
    expect(ctx.roleId).toBe(MINIMAL_PRIMARY_ID);
    ctx.cleanup();
  });

  it("returns a hooks object with expected plugin hook methods", async () => {
    const ctx = await createTestContext();
    try {
      const hooks = ctx.hooks;
      // Core hooks that the rolebox composition populates
      expect(typeof hooks["tool.execute.before"]).toBe("function");
      expect(typeof hooks["tool.execute.after"]).toBe("function");
      expect(typeof hooks["experimental.chat.system.transform"]).toBe("function");
      expect(typeof hooks["chat.message"]).toBe("function");
      expect(typeof hooks["experimental.session.compacting"]).toBe("function");
      expect(typeof hooks.event).toBe("function");
      expect(typeof hooks.config).toBe("function");
      expect(typeof hooks.dispose).toBe("function");
    } finally {
      ctx.cleanup();
    }
  });

  it("creates YAML fixture files in the temp directory", async () => {
    const ctx = await createTestContext();
    try {
      const primaryYaml = `${ctx.tmpDir}/${MINIMAL_PRIMARY_ID}/role.yaml`;
      const subagentYaml = `${ctx.tmpDir}/test-primary--helper/role.yaml`;
      expect(existsSync(primaryYaml)).toBe(true);
      expect(existsSync(subagentYaml)).toBe(true);
    } finally {
      ctx.cleanup();
    }
  });

  it("cleans up the temp directory after cleanup()", async () => {
    const ctx = await createTestContext();
    const tmpDir = ctx.tmpDir;

    // Temp dir should exist before cleanup
    expect(existsSync(tmpDir)).toBe(true);

    ctx.cleanup();

    // Temp dir should be removed after cleanup
    expect(existsSync(tmpDir)).toBe(false);
  });

  it("idempotent cleanup — calling cleanup() twice does not throw", async () => {
    const ctx = await createTestContext();
    ctx.cleanup();
    // Second call must not throw
    expect(() => ctx.cleanup()).not.toThrow();
  });

  it("supports hooks.tool.execute.before — can intercept tool calls", async () => {
    const ctx = await createTestContext();
    try {
      const output = { args: { command: "echo hello" } };
      await ctx.hooks["tool.execute.before"]!(
        { tool: "bash", sessionID: "test-session-int", callID: "call-1" },
        output,
      );
      // The hook should not alter the args (no transform in play)
      expect(output.args.command).toBe("echo hello");
    } finally {
      ctx.cleanup();
    }
  });
});

describe("cleanupTestState", () => {
  it("does not throw when called on fresh state", () => {
    expect(() => cleanupTestState()).not.toThrow();
  });

  it("clears state between createTestContext calls", async () => {
    const ctx1 = await createTestContext();
    ctx1.cleanup();

    // Cleanup between tests
    cleanupTestState();

    // Second context should initialize cleanly
    const ctx2 = await createTestContext();
    try {
      expect(ctx2.hooks).toBeDefined();
      expect(ctx2.tmpDir).not.toBe(ctx1.tmpDir);
    } finally {
      ctx2.cleanup();
    }
  });
});

describe("concurrent contexts", () => {
  it("two createTestContext calls use separate directories", async () => {
    const ctx1 = await createTestContext();
    const ctx2 = await createTestContext();
    try {
      expect(ctx1.tmpDir).not.toBe(ctx2.tmpDir);
      expect(ctx1.hooks).toBeDefined();
      expect(ctx2.hooks).toBeDefined();
    } finally {
      ctx1.cleanup();
      ctx2.cleanup();
    }
  });
});
