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

const log = createSubLogger("tool-service");

export class ToolService implements PluginService {
  readonly name = "tool-service";
  readonly dependencies = ["dispatch-service", "loop-service", "lsp-service", "session-service", "hot-reload-service"];

  private tools: Record<string, any> = {};

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
      graphNotify: {
        sessionClient,
        emperorSessionId: (invokingSessionId) => invokingSessionId,
      },
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
}
