import type { PluginService } from "../service.ts";
import type { PluginContext } from "../context.ts";
import type { ToolContributor } from "../tool-registry.ts";
import { SessionClientWrapper } from "../../session/client.ts";
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

  private sessionClient!: SessionClientWrapper;

  async init(ctx: PluginContext): Promise<void> {
    this.sessionClient = new SessionClientWrapper(ctx.client);
  }

  async dispose(): Promise<void> {
    // no-op — SessionClientWrapper has no disposable resources
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

  getSessionClient(): SessionClientWrapper {
    return this.sessionClient;
  }
}
