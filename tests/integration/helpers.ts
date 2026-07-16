/**
 * Shared integration test harness for rolebox.
 *
 * Provides:
 *   - createMockClient()        – minimal OpencodeClient mock
 *   - makeMinimalRole()         – pre-resolved primary ResolvedRole
 *   - makeMinimalSubagent()     – pre-resolved subagent ResolvedRole
 *   - createTestContext()       – temp dir + YAML fixtures + PluginCore init
 *   - cleanupTestState()        – reset module-level singletons between tests
 *
 * Usage:
 *   import { createTestContext, cleanupTestState } from "./helpers.ts";
 *
 *   beforeEach(() => { cleanupTestState(); });
 *
 *   it("does something", async () => {
 *     const ctx = await createTestContext();
 *     try {
 *       // use ctx.hooks, ctx.client, ctx.roleId etc.
 *     } finally { ctx.cleanup(); }
 *   });
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import { mock } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { createPluginHooks, managerMap, pendingCorrections } from "../../src/core/composition.ts";
import { graphSessionState } from "../../src/graph/state.ts";
import { roleFunctionsMap } from "../../src/resolver/registry.ts";
import type { ResolvedRole, ResolvedSubAgent, ResolvedGraph } from "../../src/types.ts";
import { RoleMode } from "../../src/constants.ts";
import type { Hooks } from "@opencode-ai/plugin";

// ── Constants ──────────────────────────────────────────────────────────────

/** Prefix used by mkdtempSync for integration test temp dirs. */
const TMPDIR_PREFIX = "rolebox-int-";

/** Name of the minimal primary role created during setup. */
export const MINIMAL_PRIMARY_ID = "test-primary";

/** Name of the minimal subagent created during setup. */
export const MINIMAL_SUBAGENT_ID = "test-primary--helper";

// ── Mock Client ────────────────────────────────────────────────────────────

/**
 * Create a minimal mock OpencodeClient suitable for testing PluginCore.
 *
 * All session methods return resolved promises with a predictable shape.
 * Individual tests can override specific methods via `mock.module()` or
 * direct property assignment after receiving the client.
 */
export function createMockClient(): OpencodeClient {
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
      delete: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      list: mock(() =>
        Promise.resolve({ data: [], error: undefined }),
      ),
      fork: mock(() =>
        Promise.resolve({ data: { id: "forked-session" }, error: undefined }),
      ),
      init: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      command: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      shell: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      todo: mock(() =>
        Promise.resolve({ data: [], error: undefined }),
      ),
      children: mock(() =>
        Promise.resolve({ data: [], error: undefined }),
      ),
      update: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      diff: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      summarize: mock(() =>
        Promise.resolve({ data: { summary: "" }, error: undefined }),
      ),
      message: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      revert: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      unrevert: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      unshare: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
      share: mock(() =>
        Promise.resolve({ data: undefined, error: undefined }),
      ),
    },
    global: {} as any,
    project: {} as any,
    pty: {} as any,
    config: {} as any,
    tool: {} as any,
    instance: {} as any,
    path: {} as any,
    vcs: {} as any,
    command: {} as any,
    provider: {} as any,
    find: {} as any,
    file: {} as any,
    app: {} as any,
    mcp: {} as any,
    lsp: {} as any,
    formatter: {} as any,
    tui: {} as any,
    auth: {} as any,
    event: {} as any,
    postSessionIdPermissionsPermissionId: mock(() =>
      Promise.resolve({ data: undefined, error: undefined }),
    ),
  } as unknown as OpencodeClient;
}

// ── Fixture Builders ────────────────────────────────────────────────────────

/**
 * The raw YAML content for the minimal primary role.
 * Written to `{tmpDir}/{roleId}/role.yaml` by createTestContext().
 */
export const MINIMAL_PRIMARY_YAML = `\
name: Test Primary
description: Primary test role for integration tests
prompt: |
  You are a test primary agent for integration testing.
  Your purpose is to verify that PluginCore initializes correctly.
subagents:
  - name: Helper
    description: A helper subagent for integration tests
    prompt: |
      You are a helper agent for integration testing.
`;

/**
 * The raw YAML content for the minimal helper subagent role.
 * Written to `{tmpDir}/{subagentId}/role.yaml` by createTestContext().
 */
export const MINIMAL_SUBAGENT_YAML = `\
name: Helper
description: A helper subagent for integration tests
mode: subagent
prompt: |
  You are a helper agent for integration testing.
`;

/**
 * Create a pre-resolved primary ResolvedRole (no YAML parsing needed).
 *
 * Matches MINIMAL_PRIMARY_YAML so tests that bootstrap from real files
 * and tests that pass pre-resolved roles behave identically.
 */
export function makeMinimalRole(overrides?: Partial<ResolvedRole>): ResolvedRole {
  return {
    id: MINIMAL_PRIMARY_ID,
    config: {
      name: "Test Primary",
      description: "Primary test role for integration tests",
      prompt: "You are a test primary agent for integration testing.\n",
      mode: RoleMode.Primary,
    },
    prompt: "You are a test primary agent for integration testing.\n",
    skills: [],
    functions: [],
    references: [],
    subagents: [makeMinimalSubagent()],
    ...overrides,
  };
}

/**
 * Create a pre-resolved ResolvedSubAgent for the helper.
 *
 * Matches MINIMAL_SUBAGENT_YAML.
 */
export function makeMinimalSubagent(
  overrides?: Partial<ResolvedSubAgent>,
): ResolvedSubAgent {
  return {
    id: MINIMAL_SUBAGENT_ID,
    config: {
      name: "Helper",
      description: "A helper subagent for integration tests",
      prompt: "You are a helper agent for integration testing.\n",
    },
    prompt: "You are a helper agent for integration testing.\n",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
    parentId: MINIMAL_PRIMARY_ID,
    inheritedFrom: {},
    ...overrides,
  };
}

// ── State Management ───────────────────────────────────────────────────────

/**
 * Reset all module-level singletons and mocks between tests.
 *
 * Call this in a `beforeEach` block to ensure clean state for each test case.
 * Without it, consecutive tests share the same DispatchManager, LoopCoordinator,
 * and other cached state from createPluginHooks().
 */
export function cleanupTestState(): void {
  managerMap.clear();
  pendingCorrections.clear();
  roleFunctionsMap.clear();
  mock.restore();
}

// ── Test Context ───────────────────────────────────────────────────────────

/**
 * Everything returned by createTestContext().
 */
export interface TestContext {
  /** Temporary directory path (cleaned up on ctx.cleanup()). */
  tmpDir: string;
  /** The plugin hooks object returned by createPluginHooks(). */
  hooks: Hooks;
  /** The mock client used during initialization. */
  client: OpencodeClient;
  /** The resolved role that was injected into PluginCore. */
  role: ResolvedRole;
  /** The role ID for the primary test role. */
  roleId: string;
  /** Cleanup function — removes tmpDir and resets state. Idempotent safe. */
  cleanup: () => void;
}

/**
 * Create a fully initialized test context: temp directory with role YAML
 * fixtures + real PluginCore initialized via createPluginHooks().
 *
 * The temp directory contains:
 *   {tmpDir}/test-primary/role.yaml
 *   {tmpDir}/test-primary--helper/role.yaml
 *
 * YAML files are written for documentation and potential bootstrap-based
 * testing, while the actual PluginCore init uses pre-resolved ResolvedRole
 * objects for speed and reliability.
 *
 * @example
 *   it("initializes hooks", async () => {
 *     const ctx = await createTestContext();
 *     try {
 *       expect(ctx.hooks).toBeDefined();
 *       expect(ctx.hooks["tool.execute.before"]).toBeDefined();
 *     } finally { ctx.cleanup(); }
 *   });
 */
export async function createTestContext(): Promise<TestContext> {
  const tmpDir = mkdtempSync(path.join(osTmpdir(), TMPDIR_PREFIX));

  // ── Write YAML fixture files ───────────────────────────────────────
  const primaryDir = path.join(tmpDir, MINIMAL_PRIMARY_ID);
  const subagentDir = path.join(tmpDir, `${MINIMAL_PRIMARY_ID}--helper`);

  mkdirSync(primaryDir, { recursive: true });
  mkdirSync(subagentDir, { recursive: true });

  // ── Create resolver context dirs (required by HotReloadService guard) ──
  const globalSkillsDir = path.join(tmpDir, "skills");
  const configDir = path.join(tmpDir, "config");
  const builtinDir = path.join(tmpDir, "builtin");
  mkdirSync(globalSkillsDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(builtinDir, { recursive: true });

  writeFileSync(path.join(primaryDir, "role.yaml"), MINIMAL_PRIMARY_YAML, "utf-8");
  writeFileSync(path.join(subagentDir, "role.yaml"), MINIMAL_SUBAGENT_YAML, "utf-8");

  // ── Prepare pre-resolved roles ─────────────────────────────────────
  const role = makeMinimalRole();
  const subagent = makeMinimalSubagent();

  // role.subagents is already populated by makeMinimalRole(), but write
  // it through the ResolvedRole for clarity:
  role.subagents = [subagent];

  const graph: ResolvedGraph = {
    edges: [
      { from: "parent", to: MINIMAL_SUBAGENT_ID },
      { from: MINIMAL_SUBAGENT_ID, to: "parent", exit: true },
    ],
    nodes: [MINIMAL_SUBAGENT_ID],
    maxIterations: 3,
    exitEdges: [{ from: MINIMAL_SUBAGENT_ID, to: "parent", exit: true }],
    template: "pipeline",
    loopGroups: [],
  };

  const graphMap = new Map<string, ResolvedGraph>();
  graphMap.set(role.id, graph);

  // ── Clear any leftover state ───────────────────────────────────────
  // Do NOT call cleanupTestState() here since that clears roleFunctionsMap
  // which is needed across the test lifecycle. The caller owns cleanup.
  roleFunctionsMap.clear();

  // ── Create hooks via production composition ─────────────────────────
  const client = createMockClient();
  const hooks = await createPluginHooks({
    resolvedRoles: [role],
    client,
    roleFunctionsMap,
    roleGraphMap: graphMap,
    directory: tmpDir,
    roleboxDir: tmpDir,
    globalSkillsDir,
    configDir,
    builtinDir,
  });

  // ── Build cleanup ──────────────────────────────────────────────────
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;

    // Remove temp directory
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }

    // Reset singleton state
    managerMap.delete(tmpDir);
    graphSessionState.flushSync();
  };

  return {
    tmpDir,
    hooks,
    client,
    role,
    roleId: role.id,
    cleanup,
  };
}
