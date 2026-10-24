import type { ISessionClient } from "../../ports/session-client.ts";
import type { CanonicalToolDef, SessionInfo } from "../../types.ts";
import {
  createSessionListTool,
  createSessionReadTool,
  createSessionSearchTool,
  createSessionInfoTool,
  createSessionDiffTool,
  createSessionForkTool,
} from "../../../session/tools.ts";

export const DSH_SESSION_ACCESS_DENIED = "Session access denied: DSH session tools may only access the calling session.";

/** Session ancestry alone never grants access: team peers may reference their creator. */
export function scopeDshSessionClient(client: ISessionClient, callerSessionId: string): ISessionClient {
  if (typeof callerSessionId !== "string" || !callerSessionId.trim()) {
    throw new Error("DSH session tools require a trusted calling session.");
  }
  const requireOwnSession = (id: string): void => {
    if (id !== callerSessionId) throw new Error(DSH_SESSION_ACCESS_DENIED);
  };
  const visibleInfo = (session: SessionInfo | null): SessionInfo | null => {
    if (!session) return null;
    if (!session.parentID || session.parentID === callerSessionId) return session;
    const { parentID: _parentID, ...info } = session;
    return info;
  };
  return {
    async list(directory) {
      const own = visibleInfo(await client.get(callerSessionId));
      if (!own) return [];
      if (directory && own.directory.replace(/[\\/]+$/, "") !== directory.replace(/[\\/]+$/, "")) return [];
      return [own];
    },
    async get(id, directory) { requireOwnSession(id); return visibleInfo(await client.get(id, directory)); },
    async messages(id, options) { requireOwnSession(id); return client.messages(id, options); },
    async children(id) { requireOwnSession(id); return []; },
    async todo(id, directory) { requireOwnSession(id); return client.todo(id, directory); },
    async diff(id, options) { requireOwnSession(id); return client.diff(id, options); },
    async fork(id, options) { requireOwnSession(id); return visibleInfo(await client.fork(id, options)); },
    async status(id, directory) { requireOwnSession(id); return client.status(id, directory); },
    async prompt(id, options) { requireOwnSession(id); return client.prompt(id, options); },
    async promptSync(id, options) { requireOwnSession(id); return client.promptSync(id, options); },
    async create() { throw new Error("Session creation is not available through scoped session readers."); },
    async abort(id) { requireOwnSession(id); return client.abort(id); },
    ...(client.compact ? { async compact(id: string) { requireOwnSession(id); return client.compact!(id); } } : {}),
  };
}

export function createDshSessionTools(client: ISessionClient): Record<string, CanonicalToolDef> {
  const factories = {
    session_list: createSessionListTool,
    session_read: createSessionReadTool,
    session_search: createSessionSearchTool,
    session_info: createSessionInfoTool,
    session_diff: createSessionDiffTool,
    session_fork: createSessionForkTool,
  };
  return Object.fromEntries(Object.entries(factories).map(([name, factory]) => {
    const create = factory as (client: ISessionClient) => CanonicalToolDef;
    const definition = create(client);
    return [name, {
      ...definition,
      description: `${definition.description} On DSH, access is limited to the calling session; use team events to exchange information with other members.`,
      execute(input, context) {
        const scoped = scopeDshSessionClient(client, context?.sessionID);
        return create(scoped).execute(input, context);
      },
    } satisfies CanonicalToolDef];
  }));
}
