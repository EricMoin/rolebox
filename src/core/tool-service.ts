import type { PluginService } from "./service.ts";
import type { PluginContext } from "./context.ts";
import type { ToolContributor } from "./tool-registry.ts";
import { createDispatchTool, createDispatchOutputTool, createDispatchCancelTool, createDispatchMetricsTool } from "../dispatch/tools.ts";
import { createHashlineReadTool } from "../hashline/hashline-read.ts";
import { createHashlineEditTool } from "../hashline/hashline-edit.ts";
import { createMemoryWriteTool, createMemoryRecallTool, createMemoryListTool, createMemoryUpdateTool } from "../memory/tools.ts";
import { registerToolSchema } from "../hooks/tool-before.ts";
import { createSubLogger } from "../logger.ts";
import type { DispatchService } from "./dispatch-service.ts";
import type { LspService } from "./lsp-service.ts";
import type { SessionService } from "./session-service.ts";
import { createTaskConcurrencyTool } from "../dispatch/task-concurrency.ts";
import { createTaskChronologyTool } from "../dispatch/task-chronology.ts";
import { createTaskExportTool } from "../dispatch/task-export.ts";
import { createSkillComposeTool } from "../asset/skill-compose.ts";
import { createAssetHotReloadTool } from "../asset/hot-reload.ts";
import { createContextAssembleTool } from "../dispatch/context-assemble.ts";
import { createTaskSearchTool } from "../dispatch/task-search.ts";
import { createAssetSearchTool } from "../asset/asset-search.ts";
import { createReferenceSearchTool } from "../reference-search.ts";
import { createAssetInspectTool } from "../asset/asset-inspect.ts";
import { createAssetValidateTool } from "../asset/asset-validate.ts";
import { createFunctionStateTool } from "../function/function-state.ts";
import { createFunctionGraphTool } from "../function/function-graph.ts";
import { createTaskBudgetTool } from "../dispatch/task-budget.ts";
import { createTaskGraphTool } from "../dispatch/task-graph.ts";
import { createTaskRetryTool } from "../dispatch/task-retry.ts";
import { createDispatchStatusTool } from "../dispatch/task-status.ts";
import type { HotReloadService } from "./hot-reload-service.ts";
import { createWebSearchTool } from "../web/web-search.ts";
import { createPageReadTool } from "../web/page-read.ts";

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


    // 4. Assemble all tools
    this.tools = {
      // Dispatch tools
      dispatch: createDispatchTool(dispatchManager, resolvedSubagents, subagentModelKey),
      dispatch_output: createDispatchOutputTool(dispatchManager),
      dispatch_cancel: createDispatchCancelTool(dispatchManager),
      dispatch_metrics: createDispatchMetricsTool(),
      dispatch_status: createDispatchStatusTool(dispatchManager),
      // Session tools
      ...sessionService.getTools(),
      // LSP tools
      ...lspService.getTools(),
      // Hashline tools
      hashline_read: createHashlineReadTool(),
      hashline_edit: createHashlineEditTool(),
      // Memory tools
      memory_write: createMemoryWriteTool(),
      memory_recall: createMemoryRecallTool(),
      memory_list: createMemoryListTool(),
      memory_update: createMemoryUpdateTool(),
      // Search tools (direct factory imports — SearchService dissolved)
      task_search: createTaskSearchTool(dispatchManager, ctx.directory),
      asset_search: createAssetSearchTool(ctx.resolvedRoles),
      reference_search: createReferenceSearchTool(ctx.resolvedRoles),
      asset_inspect: createAssetInspectTool(ctx.resolvedRoles),
      asset_validate: createAssetValidateTool(ctx.resolvedRoles),
      function_state: createFunctionStateTool(ctx.directory),
      function_graph: createFunctionGraphTool(ctx.resolvedRoles),
      task_budget: createTaskBudgetTool(dispatchManager),
      task_graph: createTaskGraphTool(dispatchManager),
      task_retry: createTaskRetryTool(dispatchManager),
      // New P2 tools
      task_concurrency: createTaskConcurrencyTool(dispatchManager),
      task_chronology: createTaskChronologyTool(dispatchManager),
      task_export: createTaskExportTool(dispatchManager, ctx.directory),
      skill_compose: createSkillComposeTool(ctx.resolvedRoles),
      asset_hot_reload: createAssetHotReloadTool(hotReloadService),
      context_assemble: createContextAssembleTool({
        dispatchManager,
        sessionClient,
        resolvedRoles: ctx.resolvedRoles,
        directory: ctx.directory,
      }),
      // Web tools
      web_search: createWebSearchTool(),
      web_read: createPageReadTool(),
    };

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
