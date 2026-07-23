import type { PluginService } from "../service.ts";
import type { PluginContext } from "../context.ts";
import type { ToolContributor } from "../tool-registry.ts";
import type { ISessionClient } from "../../platform/ports/session-client.ts";
import {
  createSessionListTool,
  createSessionReadTool,
  createSessionSearchTool,
  createSessionInfoTool,
  createSessionDiffTool,
  createSessionForkTool,
} from "../../session/tools.ts";

export class SessionService implements PluginService, ToolContributor {
  readonly name = "session-service";
  readonly dependencies: string[] = [];

  private sessionClient!: ISessionClient;

  async init(ctx: PluginContext): Promise<void> {
    this.sessionClient = ctx.session;
  }

  async dispose(): Promise<void> {
    // no-op — ISessionClient has no disposable resources
  }

  getTools(): Record<string, any> {
    const sc = this.sessionClient;
    return {
      session_list: createSessionListTool(sc),
      session_read: createSessionReadTool(sc),
      session_search: createSessionSearchTool(sc),
      session_info: createSessionInfoTool(sc),
      session_diff: createSessionDiffTool(sc),
      session_fork: createSessionForkTool(sc),
    };
  }

  getSessionClient(): ISessionClient {
    return this.sessionClient;
  }
}
