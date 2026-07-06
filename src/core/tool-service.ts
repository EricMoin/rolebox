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
import type { SearchService } from "./search-service.ts";

const log = createSubLogger("tool-service");

export class ToolService implements PluginService {
  readonly name = "tool-service";
  readonly dependencies = ["dispatch-service", "lsp-service", "session-service", "search-service"];

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

    // 3.5. Get search tools from SearchService
    const searchService = ctx.core.getService<SearchService>("search-service");


    // 4. Assemble all tools
    this.tools = {
      // Dispatch tools
      dispatch: createDispatchTool(dispatchManager, resolvedSubagents, subagentModelKey),
      dispatch_output: createDispatchOutputTool(dispatchManager),
      dispatch_cancel: createDispatchCancelTool(dispatchManager),
      dispatch_metrics: createDispatchMetricsTool(),
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
      // Search tools
      ...(searchService ? searchService.getTools() : {}),
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
