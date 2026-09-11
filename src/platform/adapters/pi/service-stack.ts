/**
 * PiLightweightServiceStack — Minimal PluginCore-equivalent service stack
 * for the Pi (plugin) platform.
 *
 * Pi cannot run the full PluginCore because PluginCore depends on the
 * `@opencode-ai/plugin` SDK's client object. This stack provides a
 * lightweight replacement that:
 *
 *   1. Initializes PiSessionAdapter for filesystem-backed session reading
 *   2. Constructs all standalone tools (hashline, memory, web, signal, etc.)
 *   3. Constructs session tools backed by PiSessionAdapter
 *   4. Constructs asset/metadata tools from resolved roles
 *   5. Creates stub dispatch tools returning "Not available on Pi"
 *   6. Compiles all tools into Pi's native format via PiToolFactory
 *   7. Registers them with pi.registerTool()
 *
 * Must NOT import from @opencode-ai/plugin.
 *
 * @module
 */

import { defineTool } from "../../ports/tool-factory.ts";
import type { IHookProvider } from "../../ports/hook-provider.ts";
import { PiToolFactory } from "./tool-factory.ts";
import type { ToolInterceptorHooks } from "./tool-interceptor.ts";
import { PiSessionAdapter } from "./session.ts";
import { z } from "zod";
import { registerToolSchema, registerDeprecatedTool } from "../../../hooks/tool-before.ts";
import type { DispatchManager } from "../../../dispatch/core/manager.ts";
import type { ISessionClient } from "../../ports/session-client.ts";
import {
  createGraphToolSet,
  type GraphToolSet,
} from "../../../graph/tools/index.ts";
import type { NodeLivenessFeed } from "../../../graph/engine/index.ts";

// ── Shared tool assembly ────────────────────────────────────────────────────

import { buildCanonicalTools } from "../../tool-assembly.ts";
import { piCapabilities } from "../../capabilities.ts";

// ── Logger ──────────────────────────────────────────────────────────────────

import { createSubLogger } from "../../../logger.ts";
import type { ResolvedRole } from "../../../types.ts";
import type { CanonicalToolDef } from "../../types.ts";

const log = createSubLogger("pi-service-stack");

// ── Stub dispatch tools ──────────────────────────────────────────────────────

/**
 * Create a stub tool that returns "Not available on Pi" for platform-specific
 * features that Pi does not support (dispatch, etc.).
 */
function stubTool(description: string): CanonicalToolDef {
  return defineTool({
    description,
    args: {
      _stub: z.string().optional().describe("This tool is not available on Pi"),
    },
    async execute() {
      return "Dispatch is not available on Pi — use opencode for multi-agent workflows.";
    },
  });
}

const stubDispatch = stubTool(
  "Dispatch work to a subagent. (Stub — not available on Pi)",
);

const stubDispatchOutput = stubTool(
  "Retrieve output from a completed background task. (Stub — not available on Pi)",
);

const stubDispatchCancel = stubTool(
  "Cancel a running background task. (Stub — not available on Pi)",
);

const stubDispatchMetrics = stubTool(
  "Retrieve runtime metrics snapshot. (Stub — not available on Pi)",
);

const stubDispatchStatus = stubTool(
  "Proactively check task liveness. (Stub — not available on Pi)",
);

/**
 * Registry of named canonical tool definitions before compilation.
 * Maps tool name → CanonicalToolDef.
 */
type ToolRegistry = Record<string, CanonicalToolDef>;


// ── Stub dispatch tools ─────────────────────────────────────────────────────

function buildDispatchStubTools(): ToolRegistry {
  return {
    dispatch: stubDispatch,
    dispatch_output: stubDispatchOutput,
    dispatch_cancel: stubDispatchCancel,
    dispatch_metrics: stubDispatchMetrics,
    dispatch_status: stubDispatchStatus,
  };
}

// ── Service Stack ───────────────────────────────────────────────────────────

/**
 * Lightweight service stack for the Pi platform.
 *
 * Orchestrates the creation, compilation, and registration of all rolebox
 * tools with the Pi extension API. Does not use PluginCore or any
 * @opencode-ai/plugin imports.
 */
export class PiLightweightServiceStack implements IHookProvider {
  private _toolFactory: PiToolFactory;
  private _sessionAdapter: PiSessionAdapter;
  private _resolvedRoles: ResolvedRole[];
  private _pi: any;
  private _dispatchTools?: Record<string, CanonicalToolDef>;
  private _loopTools?: Record<string, CanonicalToolDef>;
  private _taskTools?: Record<string, CanonicalToolDef>;
  private _extraTools?: Record<string, CanonicalToolDef>;
  private _dispatchManager?: DispatchManager;
  private _graphNotifyClient?: ISessionClient;
  private _stateDir: string;
  /** Hook wiring consumed by the tool-execution interceptor (subtask S9). */
  private _interceptorHooks: ToolInterceptorHooks | undefined;
  /**
   * The single GraphToolSet instance (subtask 2) backing BOTH the `graph_*`
   * tools (threaded into buildCanonicalTools via the `graphTools` option) and
   * the HookDeps `graphTools` in-flight query (consumed by the Pi hook
   * pipeline through {@link getGraphToolSet}). Constructed eagerly with the
   * SAME deps the graph_* tools receive inside buildCanonicalTools — manager,
   * directory (process.cwd()), stateDir and graphNotify — so both surfaces
   * observe the same in-memory graph registry. Absent (undefined) when no
   * dispatch manager is supplied, mirroring the graph_* gating in
   * buildCanonicalTools.
   */
  private _graphToolSet: GraphToolSet | undefined;
  /**
   * Shared node-liveness feed (subtask 6). Threaded into every graph engine
   * the stack's toolset builds so the engine records dispatch heartbeats,
   * registers its sessions with the feed, and maintains the `sessionId →
   * nodeId` reverse index the Pi liveness relay resolves through. Absent →
   * engines run without liveness recording (backward compatible).
   */
  private _livenessFeed?: NodeLivenessFeed;
  /**
   * Optional platform-provided acting-agent resolver (Pi/DSH parity). On Pi
   * `context.agent` is never populated, so the graph tools (wired via
   * buildCanonicalTools → createGraphTools) fall back to this resolver so the
   * injected `<system-reminder>` still forwards the orchestrator's real role
   * instead of falling back to `default_agent`. Reads the role switcher's
   * shared `ActiveAgentRef` (global, session-agnostic on Pi).
   */
  private _getEffectiveAgent?: (sessionID?: string) => string;
  /** Pi-compiled tools stored after init() for getHandlers(). */
  private _compiledTools: Record<string, unknown> = {};

  constructor(
    pi: any,
    resolvedRoles: ResolvedRole[],
    sessionDir?: string,
    dispatchTools?: Record<string, CanonicalToolDef>,
    loopTools?: Record<string, CanonicalToolDef>,
    taskTools?: Record<string, CanonicalToolDef>,
    extraTools?: Record<string, CanonicalToolDef>,
    dispatchManager?: DispatchManager,
    graphNotifyClient?: ISessionClient,
    stateDir: string = process.cwd(),
    interceptorHooks?: ToolInterceptorHooks,
    livenessFeed?: NodeLivenessFeed,
    getEffectiveAgent?: (sessionID?: string) => string,
  ) {
    this._pi = pi;
    this._resolvedRoles = resolvedRoles;
    this._toolFactory = new PiToolFactory(interceptorHooks);
    this._sessionAdapter = new PiSessionAdapter(sessionDir);
    this._dispatchTools = dispatchTools;
    this._loopTools = loopTools;
    this._taskTools = taskTools;
    this._extraTools = extraTools;
    this._dispatchManager = dispatchManager;
    this._graphNotifyClient = graphNotifyClient;
    this._stateDir = stateDir;
    this._interceptorHooks = interceptorHooks;
    this._livenessFeed = livenessFeed;
    this._getEffectiveAgent = getEffectiveAgent;
    // Subtask 2: the graph tools only assemble when a dispatch manager is
    // present (buildCanonicalTools gates the eight graph_* keys on it), so
    // the shared toolset is constructed under the same gate. The graph-notify
    // session client resolves exactly as in init() below (external client
    // wins over the filesystem-backed session adapter).
    if (dispatchManager) {
      this._graphToolSet = createGraphToolSet({
        manager: dispatchManager,
        directory: process.cwd(),
        stateDir,
        graphNotify: {
          sessionClient: graphNotifyClient ?? this._sessionAdapter,
          emperorSessionId: (invokingSessionId) => invokingSessionId,
        },
        // Subtask 6: thread the shared node-liveness feed into the toolset's
        // engines (absent → engine behavior unchanged).
        ...(livenessFeed !== undefined ? { livenessFeed } : {}),
      });
    }
  }

  /** The PiSessionAdapter instance for external access. */
  get sessionAdapter(): PiSessionAdapter {
    return this._sessionAdapter;
  }

  /** The PiToolFactory instance for external access. */
  get toolFactory(): PiToolFactory {
    return this._toolFactory;
  }

  /**
   * The single GraphToolSet instance (subtask 2) backing the graph_* tools and
   * the HookDeps `graphTools` in-flight query. `undefined` when no dispatch
   * manager was supplied (no graph tools are registered either). The Pi hook
   * pipeline reads this when assembling HookDeps.
   */
  getGraphToolSet(): GraphToolSet | undefined {
    return this._graphToolSet;
  }

  /**
   * Initialize the service stack: build all tools, compile them to Pi's
   * native format, and register each with pi.registerTool().
   *
   * Returns the count of registered tools.
   */
  async init(): Promise<number> {
    // 1. Build the dispatch tools override: use external dispatch tools when
    //    provided (from real dispatch system), falling back to built-in stubs.
    // dispatch_* tools are graph-superseded: when no real dispatch tools are
    // provided, register NOTHING (previously stub tools). Registering stubs
    // would still expose the dispatch_* names to the model, inviting bare
    // dispatch calls that bypass the graph engine.
    const dispatchToolsOverride: ToolRegistry | undefined = this._dispatchTools && Object.keys(this._dispatchTools).length > 0
      ? this._dispatchTools
      : undefined;

    // 2. Assemble all tools via the shared canonical builder
    const allTools = buildCanonicalTools({
      resolvedRoles: this._resolvedRoles,
      sessionClient: this._sessionAdapter,
      directory: process.cwd(),
      capabilities: piCapabilities(),
      // When a dispatch manager is provided (real dispatch system, e.g. graph
      // orchestration on Pi), it gates registration of the eight graph_* tools
      // inside buildCanonicalTools. Absent → graph tools are not assembled
      // (backward compatible with the stub/override-only path).
      dispatchManager: this._dispatchManager,
      // Subtask 3 (graph-notify source): thread the emperor session identity +
      // session client into the graph engine's completion AND graph-terminal
      // seams. The emperor/orchestrator session is the session whose execution
      // context drives graph_run — resolved at runtime by the graph tool's
      // context (tool assembly is session-agnostic). `graphParentContext` budget
      // scoping (sessionID: graphId) is untouched; the emperor session is carried
      // ONLY for notification targeting. The notification client defaults to the
      // Pi session adapter (filesystem-backed, read-only) unless an external
      // graph notify client is supplied.
      graphNotify: {
        sessionClient: this._graphNotifyClient ?? this._sessionAdapter,
        emperorSessionId: (invokingSessionId) => invokingSessionId,
      },
      // Subtask 2: bind the graph_* tools to the prebuilt toolset (single
      // instance — same registry the HookDeps graphTools query reads). Absent
      // when no dispatch manager was supplied (no graph tools are assembled).
      graphTools: this._graphToolSet,
      dispatchToolsOverride,
      loopToolsOverride: this._loopTools && Object.keys(this._loopTools).length > 0
        ? this._loopTools
        : undefined,
      // Restored legacy task_* surface. Merged additive with the same
      // `.length > 0` degradation guard: real task_* tools when provided,
      // omitted entirely otherwise (dispatch/loop still carry stubs).
      taskToolsOverride: this._taskTools && Object.keys(this._taskTools).length > 0
        ? this._taskTools
        : undefined,
      // Platform-extra tools (opencode-only surface adapted for Pi, e.g.
      // memory_update, function_graph, skill_compose, context_assemble).
      // Same `.length > 0` degradation guard as the other overrides: an empty
      // record registers nothing rather than overriding the shared surface.
      extraTools: this._extraTools && Object.keys(this._extraTools).length > 0
        ? this._extraTools
        : undefined,
      // Engine-state persistence dir, threaded through createGraphTools into
      // every engine the graph tools construct (`.rolebox/state`). Defaults to
      // process.cwd() at construction.
      stateDir: this._stateDir,
      // Subtask 6: thread the shared node-liveness feed into the graph tools'
      // engine construction (absent → engine behavior unchanged).
      ...(this._livenessFeed !== undefined
        ? { livenessFeed: this._livenessFeed }
        : {}),
      // Pi never populates `context.agent`, so the graph tools fall back to
      // this resolver to forward the orchestrator's role into the injected
      // `<system-reminder>` (absent → context.agent-only, backward compatible).
      ...(this._getEffectiveAgent !== undefined
        ? { getEffectiveAgent: this._getEffectiveAgent }
        : {}),
    });

    // 2.5 Register tool schemas + deprecation markers into the shared hook
    // registries (mirrors tool-service.ts:109-112). The S9 interceptor
    // (inside PiToolFactory.execute) reads these to run strict zod
    // validation and deprecated-tool warnings on every Pi tool invocation.
    for (const [name, def] of Object.entries(allTools)) {
      registerToolSchema(name, (def as { args: z.ZodRawShape }).args);
      if (def.deprecated) {
        const message =
          typeof def.deprecated === "object" ? def.deprecated.message : undefined;
        registerDeprecatedTool(name, message);
      }
    }

    // 3. Compile all tools to Pi's native format
    const compiled = this._toolFactory.compileAll(allTools);

    // 4. Store compiled tools for getHandlers() (IHookProvider compliance)
    this._compiledTools = compiled;

    // 5. Register each tool with pi.registerTool()
    let registeredCount = 0;
    for (const [name, toolDef] of Object.entries(compiled)) {
      if (typeof this._pi.registerTool === "function") {
        this._pi.registerTool(toolDef);
        registeredCount++;
      } else {
        log.warn("pi.registerTool is not a function — cannot register tool", { name });
      }
    }

    log.info("Tool registration complete", { registeredCount, total: Object.keys(allTools).length });
    return registeredCount;
  }

  /**
   * Return the assembled hook handlers.
   *
   * Implements IHookProvider.getHandlers(). Returns a handler map whose
   * `tool` key carries the Pi-compiled tool definitions. Because Pi does
   * not consume hooks through the same opencode handler pattern, only
   * the `tool` key is populated. Additional keys (`event`, `config`, etc.)
   * would be populated if Pi ever adopts the PluginCore pipeline.
   */
  getHandlers(): Record<string, unknown> {
    return {
      tool: this._compiledTools,
    };
  }
}
