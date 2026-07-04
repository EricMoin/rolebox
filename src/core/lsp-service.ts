import type { PluginService } from "./service.ts";
import type { PluginContext } from "./context.ts";
import type { ToolContributor } from "./tool-registry.ts";
import { LspClientManager } from "../lsp/client-manager.ts";
import { LspDocumentManager } from "../lsp/document-manager.ts";
import { createAllLspTools } from "../lsp/index.ts";

export class LspService implements PluginService, ToolContributor {
  readonly name = "lsp-service";
  readonly dependencies: string[] = [];

  private lspClientManager!: LspClientManager;
  private lspDocManager!: LspDocumentManager;

  async init(ctx: PluginContext): Promise<void> {
    this.lspClientManager = new LspClientManager(ctx.directory);
    this.lspDocManager = new LspDocumentManager();
  }

  async dispose(): Promise<void> {
    try { this.lspDocManager.closeAll(this.lspClientManager); } catch {}
    try { await this.lspClientManager.shutdownAll(); } catch {}
  }

  getTools(): Record<string, any> {
    return createAllLspTools(this.lspClientManager, this.lspDocManager);
  }

  getLspClientManager(): LspClientManager {
    return this.lspClientManager;
  }

  getLspDocumentManager(): LspDocumentManager {
    return this.lspDocManager;
  }
}
