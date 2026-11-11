import { resolve } from "node:path";
import { createAllLspTools, LspClientManager, LspDocumentManager } from "../../../../lsp/index.ts";
import type { CanonicalToolContext, CanonicalToolDef, ToolResult } from "../../../types.ts";
import { createSubLogger } from "../../../../logger.ts";

const log = createSubLogger("dsh-lsp");

interface Workspace {
  directory: string;
  client: LspClientManager;
  documents: LspDocumentManager;
  tools: Record<string, CanonicalToolDef>;
  sessions: Set<string>;
  pending: Set<Promise<ToolResult>>;
  closing?: Promise<void>;
}

interface LspContext {
  directory: string;
  sessionID?: string;
}

export class DshLspService {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly sessions = new Map<string, Workspace>();
  private readonly retired = new Set<Workspace>();
  private stopping?: Promise<void>;
  readonly tools: Record<string, CanonicalToolDef>;

  constructor(directory: string, contextOf: (context: CanonicalToolContext) => LspContext) {
    const templates = createAllLspTools(new LspClientManager(directory), new LspDocumentManager());
    this.tools = Object.fromEntries(Object.entries(templates).map(([name, definition]) => [name, {
      ...definition,
      execute: async (input, context) => {
        if (this.stopping) throw new Error("LSP service is shutting down");
        context.abort.throwIfAborted();
        const caller = contextOf(context);
        const workspace = this.workspace(caller.directory || directory);
        if (caller.sessionID) this.observe(this.bindSession(caller.sessionID, workspace));
        const pending = workspace.tools[name]!.execute(input, context);
        workspace.pending.add(pending);
        try { return await pending; }
        finally {
          workspace.pending.delete(pending);
          if (!workspace.sessions.size && !workspace.pending.size) this.observe(this.retire(workspace));
        }
      },
    } satisfies CanonicalToolDef]));
  }

  private workspace(directory: string) {
    const root = resolve(directory);
    let workspace = this.workspaces.get(root);
    if (!workspace) {
      const client = new LspClientManager(root);
      const documents = new LspDocumentManager();
      workspace = { directory: root, client, documents, tools: createAllLspTools(client, documents),
        sessions: new Set(), pending: new Set() };
      this.workspaces.set(root, workspace);
    }
    return workspace;
  }

  private observe(pending: Promise<void>): void {
    // retire logs failures and retains the generation for disposal to retry.
    void pending.catch(() => {});
  }

  moveSession(sessionID: string, directory: string): Promise<void> {
    if (this.stopping || !this.sessions.has(sessionID)) return Promise.resolve();
    return this.bindSession(sessionID, this.workspace(directory));
  }

  releaseSession(sessionID: string): Promise<void> {
    const workspace = this.sessions.get(sessionID);
    if (!workspace) return Promise.resolve();
    this.sessions.delete(sessionID);
    workspace.sessions.delete(sessionID);
    return workspace.sessions.size ? Promise.resolve() : this.retire(workspace);
  }

  private bindSession(sessionID: string, workspace: Workspace): Promise<void> {
    const previous = this.sessions.get(sessionID);
    if (previous === workspace) return Promise.resolve();
    this.sessions.set(sessionID, workspace);
    workspace.sessions.add(sessionID);
    if (!previous) return Promise.resolve();
    previous.sessions.delete(sessionID);
    return previous.sessions.size ? Promise.resolve() : this.retire(previous);
  }

  private retire(workspace: Workspace): Promise<void> {
    if (workspace.closing) return workspace.closing;
    // Remove it from acquisition immediately; accepted calls keep their generation.
    if (this.workspaces.get(workspace.directory) === workspace) this.workspaces.delete(workspace.directory);
    this.retired.add(workspace);
    const closing = (async () => {
      await Promise.allSettled([...workspace.pending]);
      try { workspace.documents.closeAll(workspace.client); }
      finally { await workspace.client.shutdownAll(); }
    })();
    workspace.closing = closing;
    void closing.then(() => this.retired.delete(workspace), error => {
      workspace.closing = undefined;
      log.warn("LSP workspace shutdown failed", { error: error instanceof Error ? error.message : String(error) });
    });
    return closing;
  }

  dispose(): Promise<void> {
    return this.stopping ??= this.close();
  }

  private async close(): Promise<void> {
    const workspaces = new Set([...this.workspaces.values(), ...this.retired]);
    this.sessions.clear();
    for (const workspace of workspaces) workspace.sessions.clear();
    const results = await Promise.allSettled([...workspaces].map(workspace => this.retire(workspace)));
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "LSP workspaces did not close");
  }
}
