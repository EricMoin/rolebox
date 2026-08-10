import type { PluginService } from "../service.ts";
import type { PluginContext } from "../context.ts";
import { createMemoryUpdateTool } from "../../memory/tools.ts";
import { registerToolSchema } from "../../hooks/tool-before.ts";
import { createSubLogger } from "../../logger.ts";
import type { DispatchService } from "./dispatch-service.ts";
import type { LoopService } from "./loop-service.ts";
import type { LspService } from "./lsp-service.ts";
import type { SessionService } from "./session-service.ts";
import { createSkillComposeTool } from "../../asset/skill-compose.ts";
import { createAssetHotReloadTool } from "../../asset/hot-reload.ts";
import { createContextAssembleTool } from "../../dispatch/query/context-assemble.ts";
import { createTaskTools } from "../../dispatch/query/task-tools.ts";
import { createFunctionGraphTool } from "../../function/function-graph.ts";
import type { HotReloadService } from "./hot-reload-service.ts";
import { buildCanonicalTools } from "../../platform/tool-assembly.ts";
import { defaultCapabilities } from "../../platform/capabilities.ts";
import {
  createGraphToolSet,
  type GraphToolSet,
  type GraphNotifySource,
} from "../../graph/tools/index.ts";
import type { NodeLivenessFeed } from "../../graph/engine/index.ts";

const log = createSubLogger("tool-service");

export class ToolService implements PluginService {
  readonly name = "tool-service";
  readonly dependencies = ["dispatch-service", "loop-service", "lsp-service", "session-service", "hot-reload-service"];

  private tools: Record<string, any> = {};
  /**
   * The single GraphToolSet instance (subtask 2) backing BOTH the `graph_*`
   * tools (threaded into buildCanonicalTools via the `graphTools` option) and
   * the HookDeps `graphTools` in-flight query (consumed by hook-service via
   * {@link getGraphToolSet}). Constructed once so both surfaces observe the
   * same in-memory graph registry.
   */
  private graphToolSet?: GraphToolSet;

  async init(ctx: PluginContext): Promise<void> {
    // 1. Get dispatch tools from DispatchService
    const dispatchService = ctx.core.getService<DispatchService>("dispatch-service");
    if (!dispatchService) throw new Error("dispatch-service not found");
    const dispatchManager = dispatchService.getDispatchManager();
    const resolvedSubagents = dispatchService.getResolvedSubagents();
    const subagentModelKey = dispatchService.getSubagentModelKey();

    // 1.6. loop_* tool registration DISABLED — prevents models from bypassing
    // the graph engine (graph_add_loop) via bare loop_* calls. LoopService
    // remains available internally; only the model-facing tools are withheld.
    // const loopService = ctx.core.getService<LoopService>("loop-service");
    // if (!loopService) throw new Error("loop-service not found");
    // const loopToolsOverride = loopService.getLoopTools();

    // 2. Get LSP tools from LspService
    const lspService = ctx.core.getService<LspService>("lsp-service");
    if (!lspService) throw new Error("lsp-service not found");

    // 3. Get session tools from SessionService
    const sessionService = ctx.core.getService<SessionService>("session-service");
    if (!sessionService) throw new Error("session-service not found");

    // 3.6. Get HotReloadService for P2 tools
    const hotReloadService = ctx.core.getService<HotReloadService>("hot-reload-service");
    if (!hotReloadService) throw new Error("hot-reload-service not found");
    const sessionClient = sessionService.getSessionClient();

    // 3.7. Construct the single GraphToolSet (subtask 2) with the SAME deps
    // the graph_* tools receive inside buildCanonicalTools — manager,
    // directory, stateDir, graphNotify. stateDir is intentionally absent here
    // exactly as it is for the graph tools in this assembly.
    //
    // Platform contract (monitor S10): on the opencode platform the graph
    // engine runs FULLY IN-MEMORY — engine state is never persisted to
    // `.rolebox/state/engine-*.json`, so a graph's state does NOT cross
    // sessions, there is no crash recovery sweep, and the durable
    // graph-events ndjson log is not written either. Graph lifecycles are
    // scoped to the process that created them; a plugin reload / process
    // restart abandons any in-flight graph. This is the opposite of the Pi
    // platform path (pi-extension.ts), which wires stateDir + the recovery
    // sweep + the event recorder. Keep the two assemblies aligned: do NOT add
    // stateDir here unless opencode gains engine-state persistence.
    //
    // The instance is threaded
    // into buildCanonicalTools below via the `graphTools` option so the
    // graph_* tools bind to it (no second toolset), and is exposed to
    // hook-service through getGraphToolSet() for the HookDeps graphTools
    // in-flight query.
    const graphNotify: GraphNotifySource = {
      sessionClient,
      emperorSessionId: (invokingSessionId) => invokingSessionId,
    };
    // Node-liveness feed (opencode analog of the Pi `livenessFeed` in
    // pi-extension.ts). Intentionally inert (observe-only logging is omitted
    // here): its PRESENCE is what gates each engine's `sessionId → nodeId`
    // reverse-index population at launch + terminal detach (engine-advance.ts
    // `_dispatchNode` / `_detachLiveness`) and its launch-time `dispatch`
    // heartbeat — the index is the liveness relay's authoritative owner
    // source. The relay itself lives in hook-service's `event` handler (it
    // resolves owners through GraphToolSet.resolveSessionOwner and calls
    // `recordLivenessHeartbeat`), mirroring the Pi relay's bridge wiring.
    const livenessFeed: NodeLivenessFeed = {
      attach(_nodeId: string, _sessionId: string): void {},
      detach(_nodeId: string): void {},
    };
    this.graphToolSet = createGraphToolSet({
      manager: dispatchManager,
      directory: ctx.directory,
      graphNotify,
      livenessFeed,
    });

    // 4. Assemble shared canonical tools + OpenCode-only extras
    this.tools = buildCanonicalTools({
      sessionClient,
      dispatchManager,
      resolvedSubagents,
      subagentModelKey,
      resolvedRoles: ctx.resolvedRoles,
      directory: ctx.directory,
      capabilities: ctx.capabilities ?? defaultCapabilities(),
      // Subtask 3 (graph-notify source): thread the emperor session identity +
      // session client into the graph engine's completion AND graph-terminal
      // seams. The emperor/orchestrator session is the session whose execution
      // context drives graph_run — resolved at runtime by the graph tool's
      // context. A resolver is used (rather than a static id) because tool
      // assembly is session-agnostic; the real orchestrator session is only
      // known when a graph is actually run. `graphParentContext` budget scoping
      // (sessionID: graphId) is unaffected — the emperor session is carried ONLY
      // for notification targeting.
      graphNotify,
      // dispatch_* tool registration DISABLED — orchestration is graph-only
      // (graph_create/graph_add_node/graph_run). Bare dispatch calls would
      // bypass graph budget accounting, approval gates, and loop caps.
      // dispatchToolsOverride: dispatchService.getTools(),
      // loop_* tool registration DISABLED (see 1.6 above).
      // loopToolsOverride,
      // Restored legacy task_* compatibility surface (thin adapters over the
      // surviving dispatch/graph/query subsystems — see task-tools.ts).
      // task_retry is withheld: it re-dispatches via reopenForContinuation and
      // would bypass graph budget/approval enforcement (bare-dispatch risk).
      taskToolsOverride: (() => {
        const { task_retry: _omitted, ...taskTools } = createTaskTools(dispatchManager, ctx.directory);
        return taskTools;
      })(),
      // Subtask 2: bind the graph_* tools to the prebuilt toolset (single
      // instance — same registry the HookDeps graphTools query reads).
      graphTools: this.graphToolSet,
      extraTools: {
        // OpenCode-only memory update (write/recall/list are in the shared set)
        memory_update: createMemoryUpdateTool(),
        // LSP tools are OpenCode-only
        ...lspService.getTools(),
        // OpenCode-only function/asset extras
        function_graph: createFunctionGraphTool(ctx.resolvedRoles),
        skill_compose: createSkillComposeTool(ctx.resolvedRoles),
        asset_hot_reload: createAssetHotReloadTool(hotReloadService),
        context_assemble: createContextAssembleTool({
          dispatchManager,
          sessionClient,
          resolvedRoles: ctx.resolvedRoles,
          directory: ctx.directory,
        }),
      },
    });

    // 5. Register tool schemas
    for (const [name, def] of Object.entries(this.tools)) {
      registerToolSchema(name, (def as any).args);
    }
  }

  async dispose(): Promise<void> {
    // Nothing to dispose
  }

  getTools(): Record<string, any> {
    return this.tools;
  }

  /**
   * The single GraphToolSet instance (subtask 2) backing the graph_* tools and
   * the HookDeps `graphTools` in-flight query. `undefined` only if init() has
   * not run yet (or failed). hook-service reads this when assembling HookDeps.
   */
  getGraphToolSet(): GraphToolSet | undefined {
    return this.graphToolSet;
  }
}
