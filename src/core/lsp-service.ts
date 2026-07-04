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

  // ── Health ───────────────────────────────────────────────────

  health(): import("./service.ts").ServiceHealth {
    if (!this.lspClientManager) {
      return { status: "degraded", detail: "LSP client manager not initialized" };
    }
    // Check server statuses
    const servers = this.lspClientManager.servers;
    if (servers.size === 0) {
      return { status: "healthy", detail: "no LSP servers configured" };
    }
    let deadCount = 0;
    let failedCount = 0;
    for (const [, state] of servers) {
      if (state.status === "dead") deadCount++;
      if (state.status === "failed") failedCount++;
    }
    if (failedCount > 0 && failedCount === servers.size) {
      return { status: "unhealthy", detail: `all ${failedCount} LSP servers failed` };
    }
    if (deadCount > 0) {
      return { status: "degraded", detail: `${deadCount}/${servers.size} LSP servers dead` };
    }
    return { status: "healthy" };
  }
}
