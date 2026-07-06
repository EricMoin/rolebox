import type { PluginService } from "./service.ts";
import type { PluginContext } from "./context.ts";
import type { ToolContributor } from "./tool-registry.ts";
import type { DispatchManager } from "../dispatch/manager.ts";
import type { ResolvedRole } from "../types.ts";
import { createTaskSearchTool } from "../search/task-search.ts";
import { createAssetSearchTool } from "../search/asset-search.ts";
import { createSubLogger } from "../logger.ts";
import type { DispatchService } from "./dispatch-service.ts";

const log = createSubLogger("search-service");

export class SearchService implements PluginService, ToolContributor {
  readonly name = "search-service";
  readonly dependencies = ["dispatch-service"];

  private dispatchManager!: DispatchManager;
  private resolvedRoles: ResolvedRole[] = [];
  private directory: string = "";

  async init(ctx: PluginContext): Promise<void> {
    const dispatchService = ctx.core.getService<DispatchService>("dispatch-service");
    if (!dispatchService) throw new Error("dispatch-service not found");
    this.dispatchManager = dispatchService.getDispatchManager();
    this.resolvedRoles = ctx.resolvedRoles;
    this.directory = ctx.directory;
  }

  async dispose(): Promise<void> {
    // Nothing to dispose
  }

  getTools(): Record<string, any> {
    return {
      task_search: createTaskSearchTool(this.dispatchManager, this.directory),
      asset_search: createAssetSearchTool(this.resolvedRoles),
    };
  }
}
