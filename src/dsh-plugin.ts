/**
 * dsh (DeepSeek Harness) cordis plugin entry point — `src/dsh-plugin.ts`
 *
 * Exports a cordis plugin per the conventions verified in
 * `docs/dsh-plugin-contract.md` against the published npm artifacts
 * (`@deepseek-ai/cordis@4.0.1`, `@deepseek-ai/dsh-tools@0.1.0-rc.6`, ...):
 *
 *   - `name`    — `'rolebox'`
 *   - `inject`  — the dsh services rolebox's adapters consume: `tools`
 *                 (tool registration, §3.1), `sessions` (session lifecycle,
 *                 §4.1), `subagents` (agent catalog, §4.3). The live-agent
 *                 `agents` service (§4.2) is deliberately NOT injected:
 *                 `DshAgentRegistrar` manages the *catalog* of spawnable
 *                 definitions through `ctx.subagents` and explicitly keeps
 *                 the `ctx.agents` AgentRegistry side out of scope (see
 *                 `src/platform/adapters/dsh/agent-registrar.ts` module
 *                 docstring). Injecting a service we do not consume would
 *                 gate plugin activation on it for no reason.
 *   - `Config`  — a StandardSchemaV1 config schema (contract §2.4)
 *   - `apply(ctx, config)` — bootstrap + wire the dsh adapters
 *
 * ── Config mechanism (contract §2.4) ──────────────────────────────────────
 * The contract verified that cordis 4.0.1's `Config` field is typed
 * `StandardSchemaV1<any, T>` and that schemas implementing the standard
 * `'~standard'` interface work directly as a plugin Config (defaults applied,
 * invalid values rejected). The dsh packages use the
 * `@deepseek-ai/schemastery` fork as their schema DSL; this repo does not
 * depend on that fork (or any `@deepseek-ai/*` package — the adapters are
 * deliberately SDK-free, structural). zod v4 — already a rolebox dependency —
 * implements the same `StandardSchemaV1` interface (`~standard`), which is the
 * exact mechanism the contract verified. So `Config` below is a zod schema:
 * identical mechanism, no new dependency. `live:` verified on zod@4.1.8:
 * `schema['~standard'].validate({})` → `{value:{...defaults}}` and invalid
 * input → `{issues:[...]}`.
 *
 * ── Tool registration ─────────────────────────────────────────────────────
 * `DshToolFactory.compileAll(buildCanonicalTools(...))` produces objects
 * structurally matching the verified `defineTool()` options surface
 * (`DshDefineToolOptions` — name/description/parameters DSL/output/execute,
 * contract §3.2); `ctx.tools.register(def)` consumes them (§3.1). The real
 * dsh registry may wrap them in its own `defineTool()` at the host boundary;
 * the structural contract is identical, so direct registration is safe.
 *
 * MUST NOT import `@opencode-ai/plugin` (or any platform SDK).
 *
 * @module
 */

import { z } from "zod";
import { resolveRoleboxDirectories, initializeRoleboxRuntime } from "./platform/factory.ts";
import type {
  RoleboxDirectories,
  InitializeRuntimeOptions,
} from "./platform/factory.ts";
import { DshAgentRegistrar } from "./platform/adapters/dsh/agent-registrar.ts";
import type { DshSubagentProvider } from "./platform/adapters/dsh/agent-registrar.ts";
import { DshDispatchAdapter } from "./platform/adapters/dsh/dispatch.ts";
import type { DshSubagentDispatchRuntime } from "./platform/adapters/dsh/dispatch.ts";
import { DshToolFactory } from "./platform/adapters/dsh/tool-factory.ts";
import type { DshDefineToolOptions } from "./platform/adapters/dsh/tool-factory.ts";
import { DshSessionAdapter } from "./platform/adapters/dsh/session.ts";
import type { DshSessionStoreLike } from "./platform/adapters/dsh/session.ts";
import { DshHookProvider } from "./platform/adapters/dsh/hook-provider.ts";
import { buildCanonicalTools } from "./platform/tool-assembly.ts";
import type { PlatformCapabilities } from "./platform/capabilities.ts";
import { createGraphTools } from "./graph/tools/index.ts";
import { LoopCoordinator } from "./loop/coordinator.ts";
import { LoopStore } from "./loop/loop-store.ts";
import { createLoopTools } from "./loop/loop-tools.ts";
import { applyProjectConfig } from "./project-config.ts";
import { createSubLogger } from "./logger.ts";
import { roleFunctionsMap, roleGraphMap } from "./resolver/registry.ts";
import type { ResolvedRole } from "./types.ts";

// ── Plugin metadata ────────────────────────────────────────────────────────

/** Plugin name — the cordis fiber/logger label (contract §2.2). */
export const name = "rolebox";

/**
 * dsh services this plugin waits for (contract §2.2 `inject`).
 * `tools` / `sessions` / `subagents` are the services rolebox's dsh adapters
 * consume; see the module docstring for why `agents` is excluded.
 */
export const inject: string[] = ["tools", "sessions", "subagents"];

// ── Config (StandardSchemaV1, contract §2.4) ───────────────────────────────

/**
 * Plugin config schema — a zod v4 schema implementing the StandardSchemaV1
 * interface cordis 4.0.1 requires for `Config` (see module docstring).
 *
 * All options are optional:
 *   - `roleboxDir`        — override the rolebox directory (default:
 *                           `{cwd}/rolebox` if present, else `{dsh home}/rolebox`)
 *   - `skillsDir`         — override the global skills directory (default:
 *                           `{dsh home}/skills`)
 *   - `defaultRole`       — role id (directory name) promoted to primary
 *   - `enabledNamespaces` — allow-list of tool names / name-space prefixes;
 *                           `"*"` or absent registers every assembled tool
 */
export const Config = z.object({
  roleboxDir: z
    .string()
    .optional()
    .describe("Absolute path to the directory containing role.yaml files"),
  skillsDir: z
    .string()
    .optional()
    .describe("Absolute path to the global skills directory"),
  defaultRole: z
    .string()
    .optional()
    .describe("Role id (directory name) to promote to primary"),
  enabledNamespaces: z
    .array(z.string())
    .optional()
    .describe("Tool name / namespace-prefix allow-list; '*' registers all"),
});

/** Inferred config type — the object passed to `apply(ctx, config)`. */
export type DshPluginConfig = z.infer<typeof Config>;

// ── Structural cordis ctx surface ──────────────────────────────────────────

/** The dsh tool registry seam this plugin consumes (contract §3.1). */
export interface DshToolsRegistry {
  /**
   * Register a tool definition. Returns the disposer that removes it.
   * @param definition - A compiled tool definition (DshDefineToolOptions).
   */
  register(definition: DshDefineToolOptions): () => void;
}

/**
 * Minimal structural surface of the cordis `Context` this plugin consumes.
 * Mirrors the documented cordis context (§2.5 — property reads resolve
 * services, `on` subscribes to events) plus the three injected dsh services.
 * The real dsh host supplies the full Context; tests inject a fake double.
 */
export interface DshPluginContext {
  /** dsh tools service (`ToolRuntime`, contract §3.1). */
  tools: DshToolsRegistry;
  /** dsh session service (`SessionStore`, contract §4.1). */
  sessions: DshSessionStoreLike;
  /**
   * dsh subagent service (`SubagentRuntime`, contract §4.3). Typed as the
   * dispatch superset (adds `start`) because this plugin both syncs agents
   * into the catalog (via {@link DshAgentRegistrar}) and dispatches graph
   * nodes / loop rounds through `ctx.subagents.start` (via
   * {@link DshDispatchAdapter}).
   */
  subagents: DshSubagentDispatchRuntime;
  /** Subscribe to a cordis/dsh event (contract §2.5). */
  on(event: string, listener: (...args: unknown[]) => void): (() => void) | void;
  /** Emit a cordis/dsh event. */
  emit(event: string, ...args: unknown[]): void;
}

// ── Disposer / stats ───────────────────────────────────────────────────────

/** Bootstrap + wiring statistics exposed on the returned disposer. */
export interface DshPluginStats {
  /** Roles discovered on disk. */
  discovered: number;
  /** Roles successfully resolved. */
  resolved: number;
  /** Roles that failed resolution. */
  skipped: number;
  /** Tools registered into `ctx.tools` (after the namespace filter). */
  registeredTools: number;
  /** Agents registered into `ctx.subagents` (roles + subagents). */
  registeredAgents: number;
  /** The resolved roles (post `defaultRole` promotion). */
  resolvedRoles: ResolvedRole[];
  /**
   * Dispatch mode — always `"dsh"` on this platform. The graph engine and
   * loop mode dispatch subagent sessions through the dsh subagent seam
   * (`ctx.subagents.start` / the dsh session service) instead of the opencode
   * SDK client (see {@link DshDispatchAdapter}).
   */
  dispatchMode: "dsh";
  /**
   * Whether the loop coordinator was wired to the dsh dispatch adapter.
   * `false` would indicate a wiring failure (apply still degrades to
   * graph-only orchestration).
   */
  loopWired: boolean;
}

/**
 * The fiber disposer returned by `apply()` (cordis convention, contract §8
 * appendix: "return () => {...}; // fiber disposer"). Also carries the
 * `stats` from this boot so callers/tests can observe the bootstrap outcome.
 */
export interface DshPluginDisposer {
  /** Clean up tool registrations, hook listeners, and agent registrations. */
  (): void;
  /** Bootstrap + wiring statistics for this apply() run. */
  stats: DshPluginStats;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve the rolebox directories for the dsh platform, applying the
 * `roleboxDir` / `skillsDir` config overrides on top of `dshPlatformPaths()`
 * (which resolves `$DSH_HOME` or `~/.dsh` — contract §5.1).
 */
function resolveDirs(config: DshPluginConfig): RoleboxDirectories {
  const dirs = resolveRoleboxDirectories({
    platformId: "dsh",
    workingDir: process.cwd(),
  });
  return {
    ...dirs,
    roleboxDir: config.roleboxDir ?? dirs.roleboxDir,
    globalSkillsDir: config.skillsDir ?? dirs.globalSkillsDir,
  };
}

/**
 * Namespace filter for tool registration.
 *
 * `enabledNamespaces` is a dsh-specific config option: when set and
 * non-empty, only tools whose key matches one of the entries are registered.
 * An entry matches either exactly (the full tool key, e.g. `signal`) or as a
 * namespace prefix (the key's segment before the first `_`, e.g. `hashline`
 * matches `hashline_read` / `hashline_edit`). The wildcard `"*"` disables the
 * filter — as does an absent/empty option (register everything).
 */
function isNamespaceEnabled(
  key: string,
  enabled: string[] | undefined,
): boolean {
  if (!enabled || enabled.length === 0) return true;
  if (enabled.includes("*")) return true;
  const prefix = key.split("_")[0] ?? key;
  return enabled.some((ns) => ns === key || ns === prefix);
}

/**
 * Capabilities declared for the dsh platform. Values reflect what the dsh
 * adapters actually support (session fork/create/status via the SessionStore
 * adapter; event streaming via the event bus). Currently advisory —
 * `buildCanonicalTools` documents that capabilities are "not consulted in
 * Phase 1 tool assembly" — but kept honest for future consumers.
 */
const dshCapabilities: PlatformCapabilities = {
  platformId: "dsh",
  hasBackgroundTasks: false,
  hasSessionFork: true,
  hasSessionCreate: true,
  hasSessionAbort: false,
  hasAgentFileSync: false,
  hasMultiStepTools: true,
  hasEventStream: true,
  hasSessionStatus: true,
  hasRoleSwitch: false,
};

// ── apply ───────────────────────────────────────────────────────────────────

/**
 * Cordis plugin `apply(ctx, config)` — boots rolebox on the dsh platform.
 *
 * Flow (mirroring `src/index.ts`):
 *   1. Resolve directories via the dsh platform paths (config overrides win).
 *   2. `initializeRoleboxRuntime()` with a `DshAgentRegistrar` bound to
 *      `ctx.subagents` — discovers roles, resolves them, syncs agents into
 *      the dsh subagent catalog.
 *   3. Apply `defaultRole` project-config promotion when configured.
 *   4. Compile canonical tools via `DshToolFactory` from
 *      `buildCanonicalTools(...)` (with the dsh session adapter as the
 *      session client) and register them into `ctx.tools`, filtered by
 *      `enabledNamespaces`.
 *   5. Mount hooks via `DshHookProvider` (rolebox hook kinds onto the dsh
 *      `tools/*` / `session/event` extension points).
 *   6. Log discovered/resolved/skipped counts mirroring `src/index.ts`.
 *
 * @param ctx    - The cordis context (structural; the injected dsh services).
 * @param config - Validated plugin config (all options optional).
 * @returns A fiber disposer that also carries `stats`.
 */
export async function apply(
  ctx: DshPluginContext,
  config: DshPluginConfig = {},
): Promise<DshPluginDisposer> {
  const log = createSubLogger("dsh-plugin");

  // 1. Resolve directories (dsh platform paths + config overrides).
  const dirs = resolveDirs(config);
  log.info("dsh plugin starting", {
    roleboxDir: dirs.roleboxDir,
    globalSkillsDir: dirs.globalSkillsDir,
    configDir: dirs.configDir,
  });

  // 2. Discover + resolve roles; sync agents into ctx.subagents.
  const registrar = new DshAgentRegistrar({ subagents: ctx.subagents });
  const runtimeOptions: InitializeRuntimeOptions = {
    directories: dirs,
    roleFunctionsMap,
    roleGraphMap,
    registrar,
  };
  const { resolvedRoles, discovered, resolved, skipped } =
    await initializeRoleboxRuntime(runtimeOptions);

  // 3. Apply the defaultRole promotion when configured.
  if (config.defaultRole) {
    applyProjectConfig(resolvedRoles, { defaultRole: config.defaultRole });
  }

  // 4. Compile + register tools (dsh session adapter drives the session tools).
  const sessionAdapter = new DshSessionAdapter(ctx.sessions);
  const factory = new DshToolFactory();

  // ── dsh dispatch path (subtask 8) ────────────────────────────────────────
  //
  // The dsh platform's "dispatch manager": routes graph node dispatch AND
  // loop worker rounds through the dsh services instead of the opencode SDK
  // client — `ctx.subagents.start` for spawning (per-role agent mapping via
  // the providers {@link DshAgentRegistrar} registered above), `ctx.sessions`
  // + the run's `result` promise for collecting results, `run.dispose()` for
  // cancellation, and stopReason→DispatchTaskStatus translation so failures
  // map to the engine's escalate semantics. This mirrors how the opencode
  // entry constructs its DispatchManager (createDispatchManager in
  // src/pi-extension.ts / src/index.ts) — the opencode path is untouched;
  // this is additive routing by platform.
  const dshDispatch = new DshDispatchAdapter({
    subagents: ctx.subagents,
    sessionClient: sessionAdapter,
    directory: process.cwd(),
  });

  // Graph engine v2 tools bound to the dsh dispatch seam. Engines construct
  // with `{ dispatch: dshDispatch }` (no DispatchManager on the dsh path), so
  // every graph node dispatches through the dsh subagent API. stateDir
  // (process.cwd()) persists engine state under `.rolebox/state` — the same
  // layout the opencode path uses.
  const graphTools = createGraphTools(undefined, {
    dispatch: dshDispatch,
    directory: process.cwd(),
    stateDir: process.cwd(),
  });

  // Loop mode: the loop coordinator drives worker rounds through the SAME
  // dsh dispatch adapter (dispatchRound/getRoundResult/cancelRound map to
  // subagents.start / run.result / run.dispose), with a LoopStore under the
  // dsh config dir for restart recovery.
  const loopStore = new LoopStore(dirs.configDir);
  const loopCoordinator = new LoopCoordinator(dshDispatch, {
    delayMs: 2000,
    persist: (loops) => {
      void loopStore.save(loops);
    },
  });
  const loopTools = createLoopTools(loopCoordinator, sessionAdapter);

  const tools = {
    ...buildCanonicalTools({
      resolvedRoles,
      directory: process.cwd(),
      sessionClient: sessionAdapter,
      capabilities: dshCapabilities,
    }),
    ...graphTools,
    ...loopTools,
  };
  const compiled = factory.compileAll(tools);

  const toolDisposers: Array<() => void> = [];
  let registeredTools = 0;
  for (const [key, def] of Object.entries(compiled)) {
    if (!isNamespaceEnabled(key, config.enabledNamespaces)) continue;
    // compileAll() is typed `Record<string, unknown>` (the IToolFactory port
    // contract); the compiled objects are structurally DshDefineToolOptions.
    const dispose = ctx.tools.register(def as DshDefineToolOptions);
    toolDisposers.push(dispose);
    registeredTools++;
  }

  // 5. Mount hooks (rolebox hook kinds onto dsh extension points).
  const hookProvider = new DshHookProvider(ctx, {});

  // 5a. Loop-state recovery (mirrors the opencode/pi entry): reconcile
  // persisted loops against the dsh dispatch registry and re-subscribe
  // termination listeners so interrupted loops resume after a restart.
  // Best-effort — a failed load/reconcile degrades to a fresh coordinator
  // (loopWired stays true; only the persisted loops are lost).
  try {
    const loadedLoops = loopStore.load();
    if (loadedLoops && loadedLoops.size > 0) {
      const reconciled = await loopStore.reconcile(loadedLoops, async (taskId) => {
        const status = await dshDispatch.getTaskStatus(taskId);
        return { status: status ?? "unknown", exists: status !== undefined };
      });
      for (const [id, state] of reconciled) {
        loopCoordinator.restoreState(state);
      }
      await loopCoordinator.reSubscribeListeners();
      log.info("Loop state recovered", { restored: reconciled.size });
    }
  } catch (err) {
    log.warn("loop state recovery degraded — starting fresh", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 6. Log counts mirroring src/index.ts.
  const registeredAgents = (await registrar.list()).length;
  log.info("Plugin initialized", {
    discovered,
    resolved,
    skipped,
    registeredTools,
    registeredAgents,
  });
  if (discovered === 0) {
    log.info("No roles found in rolebox directory");
  }

  // Fiber disposer (cordis convention) + stats for callers/tests.
  const disposer = (() => {
    hookProvider.dispose();
    // Loop teardown: persist the live loop states, then stop the coordinator
    // (clears its sweeper interval + worker termination listeners).
    try {
      loopStore.saveSync(loopCoordinator.getAllLoopStates() ?? new Map());
    } catch (err) {
      log.debug("loop state save failed during dispose", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    loopCoordinator.dispose();
    loopStore.dispose();
    for (const dispose of toolDisposers) {
      try {
        dispose();
      } catch (err) {
        log.debug("tool disposer failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Best-effort agent-catalog cleanup (dsh providers are removed via the
    // registrar's unregister → disposer chain). Fire-and-forget: fiber
    // unload is synchronous in cordis.
    registrar
      .list()
      .then((ids) => (ids.length > 0 ? registrar.unregister(ids) : undefined))
      .catch((err) => {
        log.debug("agent unregister failed during dispose", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }) as DshPluginDisposer;
  disposer.stats = {
    discovered,
    resolved,
    skipped,
    registeredTools,
    registeredAgents,
    resolvedRoles,
    dispatchMode: "dsh",
    loopWired: true,
  };
  return disposer;
}

// ── Default export (object plugin shape) ───────────────────────────────────

/**
 * Default export — the object plugin shape (`{ apply(ctx, config) }`,
 * contract §2.2 `Plugin.Object`), which is what the cordis loader consumes
 * from a package's default export. The named exports above (`name`,
 * `inject`, `Config`, `apply`) are also provided for direct import.
 */
export default {
  name,
  inject,
  Config,
  apply,
};

// Type-only re-exports kept out of the plugin metadata: the dsh adapters'
// structural provider type, for consumers wiring a spawn delegate.
export type { DshSubagentProvider };
