import type { PluginService } from "../service.ts";
import type { PluginContext } from "../context.ts";
import { createMemoryUpdateTool } from "../../memory/tools.ts";
import { registerToolSchema } from "../../hooks/tool-before.ts";
import { createSubLogger } from "../../logger.ts";
import type { DispatchService } from "./dispatch-service.ts";
import type { LspService } from "./lsp-service.ts";
import type { SessionService } from "./session-service.ts";
import { createTaskConcurrencyTool } from "../../dispatch/concurrency/task-concurrency.ts";
import { createTaskChronologyTool } from "../../dispatch/query/task-chronology.ts";
import { createTaskExportTool } from "../../dispatch/query/task-export.ts";
import { createSkillComposeTool } from "../../asset/skill-compose.ts";
import { createAssetHotReloadTool } from "../../asset/hot-reload.ts";
import { createContextAssembleTool } from "../../dispatch/query/context-assemble.ts";
import { createTaskSearchTool } from "../../dispatch/query/task-search.ts";
import { createFunctionStateTool } from "../../function/function-state.ts";
import { createFunctionGraphTool } from "../../function/function-graph.ts";
import { createTaskBudgetTool } from "../../dispatch/budget/task-budget.ts";
import { createTaskGraphTool } from "../../dispatch/query/task-graph.ts";
import { createTaskRetryTool } from "../../dispatch/query/task-retry.ts";
import { createCheckpointTool } from "../../dispatch/query/checkpoint-tools.ts";
import type { HotReloadService } from "./hot-reload-service.ts";
import type { LoopService } from "./loop-service.ts";
import { createLoopStartTool } from "../../platform/adapters/pi/loop-tool.ts";
import { createLoopTools } from "../../loop/loop-tools.ts";
import { buildCanonicalTools } from "../../platform/tool-assembly.ts";
import { defaultCapabilities } from "../../platform/capabilities.ts";

const log = createSubLogger("tool-service");

export class ToolService implements PluginService {
  readonly name = "tool-service";
  readonly dependencies = ["dispatch-service", "lsp-service", "session-service", "hot-reload-service"];

  private tools: Record<string, any> = {};

  async init(ctx: PluginContext): Promise<void> {
    // 1. Get dispatch tools from DispatchService
    const dispatchService = ctx.core.getService<DispatchService>("dispatch-service");
    if (!dispatchService) throw new Error("dispatch-service not found");
    const dispatchManager = dispatchService.getDispatchManager();
    const resolvedSubagents = dispatchService.getResolvedSubagents();
    const subagentModelKey = dispatchService.getSubagentModelKey();

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

    // 3.8. Get LoopService for loop tools (optional — skip if unavailable or degraded)
    const loopService = ctx.core.getService<LoopService>("loop-service");
    let loopTools: Record<string, any> = {};
    if (loopService && !ctx.core.isDegraded("loop-service")) {
      try {
        const loopCoordinator = loopService.getLoopManager();
        loopTools = {
          loop_start: createLoopStartTool(loopCoordinator, undefined, () => ""),
          ...createLoopTools(loopCoordinator, sessionClient),
        };
      } catch {
        // LoopService degraded or coordinator unavailable — skip loop tools gracefully
      }
    }

    // 4. Assemble shared canonical tools + OpenCode-only extras
    this.tools = buildCanonicalTools({
      sessionClient,
      dispatchManager,
      resolvedSubagents,
      subagentModelKey,
      resolvedRoles: ctx.resolvedRoles,
      directory: ctx.directory,
      capabilities: ctx.capabilities ?? defaultCapabilities(),
      extraTools: {
        // OpenCode-only memory update (write/recall/list are in the shared set)
        memory_update: createMemoryUpdateTool(),
        // LSP tools are OpenCode-only
        ...lspService.getTools(),
        // OpenCode-only dispatch/query/function/asset extras
        dispatch_search: createTaskSearchTool(dispatchManager, ctx.directory),
        function_state: createFunctionStateTool(ctx.directory),
        function_graph: createFunctionGraphTool(ctx.resolvedRoles),
        dispatch_budget: createTaskBudgetTool(dispatchManager),
        dispatch_graph: createTaskGraphTool(dispatchManager),
        dispatch_retry: createTaskRetryTool(dispatchManager),
        dispatch_checkpoint: createCheckpointTool(dispatchManager),
        dispatch_concurrency: createTaskConcurrencyTool(dispatchManager),
        dispatch_chronology: createTaskChronologyTool(dispatchManager),
        dispatch_export: createTaskExportTool(dispatchManager, ctx.directory),
        skill_compose: createSkillComposeTool(ctx.resolvedRoles),
        asset_hot_reload: createAssetHotReloadTool(hotReloadService),
        context_assemble: createContextAssembleTool({
          dispatchManager,
          sessionClient,
          resolvedRoles: ctx.resolvedRoles,
          directory: ctx.directory,
        }),
        ...loopTools,
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
