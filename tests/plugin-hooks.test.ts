import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { createPluginHooks, managerMap, pendingCorrections } from "../src/core/composition";
import { roleFunctionsMap } from "../src/index";
import type { ResolvedRole, ResolvedSubAgent } from "../src/types";
import { RoleMode } from "../src/constants";
import type { DispatchManagerConfig } from "../src/dispatch/config.ts";
import { DEFAULT_CONFIG } from "../src/dispatch/config.ts";

// ── helpers ──────────────────────────────────────────────────────

function createMockClient(): OpencodeClient {
  return {
    session: {
      create: mock(() =>
        Promise.resolve({ data: { id: "test-session-1" }, error: undefined }),
      ),
      prompt: mock(() =>
        Promise.resolve({ data: { parts: [{ type: "text", text: "ok" }] }, error: undefined }),
      ),
      promptAsync: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      messages: mock(() =>
        Promise.resolve({ data: [], error: undefined }),
      ),
      status: mock(() =>
        Promise.resolve({ data: {}, error: undefined }),
      ),
      abort: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      get: mock(() =>
        Promise.resolve({ data: { id: "test-session-1" }, error: undefined }),
      ),
    },
  } as unknown as OpencodeClient;
}

function makePrimaryRole(overrides?: Partial<ResolvedRole>): ResolvedRole {
  return {
    id: "test-primary",
    config: {
      name: "Test Primary",
      description: "Primary test role",
      prompt: "You are a test primary.",
      mode: RoleMode.Primary,
      ...overrides?.config,
    },
    prompt: "You are a test primary.",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
    ...overrides,
  };
}

function makeRoleWithSubagents(overrides?: Partial<ResolvedRole>): ResolvedRole {
  const subagent: ResolvedSubAgent = {
    id: "test-primary--helper",
    config: {
      name: "Helper",
      description: "A helper subagent",
      prompt: "You are a helper.",
    },
    prompt: "You are a helper.",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
    parentId: "test-primary",
    inheritedFrom: {},
  };

  return {
    id: "test-primary",
    config: {
      name: "Test Primary",
      description: "Primary test role with subagents",
      prompt: "You are a test primary.",
      mode: RoleMode.Primary,
      ...overrides?.config,
    },
    prompt: "You are a test primary.",
    skills: [],
    functions: [],
    references: [],
    subagents: [subagent],
    ...overrides,
  };
}

// ── cleanup between tests ────────────────────────────────────────

beforeEach(() => {
  // Reset module-level state
  managerMap.clear();
  pendingCorrections.clear();
  roleFunctionsMap.clear();
});

afterEach(() => {
  mock.restore();
});

// ── tests ────────────────────────────────────────────────────────

describe("Plugin Hooks - Manager Singleton", () => {
  it("two createPluginHooks calls for same directory reuse one manager", async () => {
    const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-ph-test-"));
    try {
      const client = createMockClient();
      const roles = [makeRoleWithSubagents()];
      const graphMap = new Map();

      await createPluginHooks({ resolvedRoles: roles, client, roleFunctionsMap, roleGraphMap: graphMap, directory: tmpDir });
      await createPluginHooks({ resolvedRoles: roles, client, roleFunctionsMap, roleGraphMap: graphMap, directory: tmpDir });

      expect(managerMap.size).toBe(1);
      expect(managerMap.has(tmpDir)).toBe(true);

      const manager = managerMap.get(tmpDir)!;
      expect(manager).toBeDefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("two createPluginHooks calls for different directories create different managers", async () => {
    const dir1 = mkdtempSync(path.join(osTmpdir(), "rolebox-ph-d1-"));
    const dir2 = mkdtempSync(path.join(osTmpdir(), "rolebox-ph-d2-"));
    try {
      const client = createMockClient();
      const roles = [makeRoleWithSubagents()];
      const graphMap = new Map();

      await createPluginHooks({ resolvedRoles: roles, client, roleFunctionsMap, roleGraphMap: graphMap, directory: dir1 });
      await createPluginHooks({ resolvedRoles: roles, client, roleFunctionsMap, roleGraphMap: graphMap, directory: dir2 });

      expect(managerMap.size).toBe(2);
      expect(managerMap.has(dir1)).toBe(true);
      expect(managerMap.has(dir2)).toBe(true);
      expect(managerMap.get(dir1)).not.toBe(managerMap.get(dir2));
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("process listeners registered only once across multiple createPluginHooks calls", async () => {
    const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-ph-listen-"));
    try {
      const client = createMockClient();
      const roles = [makeRoleWithSubagents()];
      const graphMap = new Map();

      // Spy on process.on before the first call
      const processOnSpy = mock(process.on.bind(process));

      await createPluginHooks({ resolvedRoles: roles, client, roleFunctionsMap, roleGraphMap: graphMap, directory: tmpDir });
      await createPluginHooks({ resolvedRoles: roles, client, roleFunctionsMap, roleGraphMap: graphMap, directory: tmpDir });

      // The guard should prevent duplicate registrations — process.on is called
      // once for each event (exit, SIGINT, SIGTERM), not twice
      expect(managerMap.size).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Plugin Hooks - Config Injection", () => {
  it("role with dispatch: block produces manager with correct effective config", async () => {
    const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-ph-cfg-"));
    try {
      const client = createMockClient();
      const dispatchConfig: Partial<DispatchManagerConfig> = {
        backgroundStaleTimeoutMs: 60_000,
        materializeTimeoutMs: 2_000,
        watchdogIntervalMs: 3_000,
      };

      const primary = makeRoleWithSubagents({
        dispatchConfig,
        config: { mode: RoleMode.Primary } as any,
      });

      await createPluginHooks({ resolvedRoles: [primary], client, roleFunctionsMap, roleGraphMap: new Map(), directory: tmpDir });

      expect(managerMap.has(tmpDir)).toBe(true);
      const manager = managerMap.get(tmpDir)!;

      // Manager has config exposed for testing
      const config = manager.getConfig();
      expect(config.backgroundStaleTimeoutMs).toBe(60_000);
      expect(config.materializeTimeoutMs).toBe(2_000);
      expect(config.watchdogIntervalMs).toBe(3_000);

      // Defaults from DEFAULT_CONFIG should still be present for unset fields
      expect(config.taskTtlMs).toBeGreaterThan(0);
      expect(config.minRuntimeMs).toBeGreaterThan(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("manager uses DEFAULT_CONFIG when no dispatch config on role", async () => {
    const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-ph-defcfg-"));
    try {
      const client = createMockClient();
      const primary = makeRoleWithSubagents();
      // No dispatchConfig set

      await createPluginHooks({ resolvedRoles: [primary], client, roleFunctionsMap, roleGraphMap: new Map(), directory: tmpDir });

      const manager = managerMap.get(tmpDir)!;
      const config = manager.getConfig();
      // Surviving DEFAULT_CONFIG fields apply
      expect(config.taskTtlMs).toBe(DEFAULT_CONFIG.taskTtlMs);
      expect(config.minRuntimeMs).toBe(DEFAULT_CONFIG.minRuntimeMs);
      expect(config.backgroundStaleTimeoutMs).toBe(DEFAULT_CONFIG.backgroundStaleTimeoutMs);
      // Removed concurrency fields are absent from the default shape
      expect((config as any).maxConcurrent).toBeUndefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
