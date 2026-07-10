/**
 * OpenCode session adapter — implements ISessionClient by wrapping
 * the opencode SDK client (PluginInput["client"] or OpencodeClient).
 *
 * This adapter subsumes the old SessionClientWrapper and adds prompt/create/abort.
 */

import type { PluginInput } from "@opencode-ai/plugin";
import type { ISessionClient } from "../ports/session-client.ts";
import type {
  SessionInfo,
  Message,
  FileDiff,
  Todo,
  SessionStatus,
} from "../types.ts";

type SdkClient = PluginInput["client"];

function extractListResponse<T>(result: unknown): T[] {
  try {
    const r = result as { data?: T[]; error?: unknown };
    if (r.error) return [];
    return r.data ?? [];
  } catch {
    return [];
  }
}

function extractSingularResponse<T>(result: unknown): T | null {
  try {
    const r = result as { data?: T; error?: unknown };
    if (r.error) return null;
    return r.data ?? null;
  } catch {
    return null;
  }
}

/**
 * ISessionClient adapter for the opencode platform.
 *
 * Wraps the raw SDK client and provides the canonical ISessionClient
 * interface used by all platform-agnostic services.
 */
export class OpencodeSessionAdapter implements ISessionClient {
  private session: NonNullable<SdkClient["session"]>;

  constructor(client: SdkClient) {
    this.session = client.session;
  }

  async list(directory?: string): Promise<SessionInfo[]> {
    try {
      const result = await this.session.list({
        query: directory ? { directory } : undefined,
      });
      return extractListResponse<SessionInfo>(result);
    } catch {
      return [];
    }
  }

  async get(id: string, directory?: string): Promise<SessionInfo | null> {
    try {
      const result = await this.session.get({
        path: { id },
        query: directory ? { directory } : undefined,
      });
      return extractSingularResponse<SessionInfo>(result);
    } catch {
      return null;
    }
  }

  async messages(
    id: string,
    options?: { directory?: string; limit?: number },
  ): Promise<Message[]> {
    try {
      const result = await this.session.messages({
        path: { id },
        query: {
          ...(options?.directory ? { directory: options.directory } : {}),
          ...(options?.limit ? { limit: options.limit } : {}),
        },
      });
      return extractListResponse<Message>(result);
    } catch {
      return [];
    }
  }

  async children(id: string, directory?: string): Promise<SessionInfo[]> {
    try {
      const result = await this.session.children({
        path: { id },
        query: directory ? { directory } : undefined,
      });
      return extractListResponse<SessionInfo>(result);
    } catch {
      return [];
    }
  }

  async todo(id: string, directory?: string): Promise<Todo[]> {
    try {
      const result = await this.session.todo({
        path: { id },
        query: directory ? { directory } : undefined,
      });
      return extractListResponse<Todo>(result);
    } catch {
      return [];
    }
  }

  async diff(
    id: string,
    options?: { directory?: string; messageID?: string },
  ): Promise<FileDiff[]> {
    try {
      const result = await this.session.diff({
        path: { id },
        query: {
          ...(options?.directory ? { directory: options.directory } : {}),
          ...(options?.messageID ? { messageID: options.messageID } : {}),
        },
      });
      return extractListResponse<FileDiff>(result);
    } catch {
      return [];
    }
  }

  async fork(
    id: string,
    options?: { directory?: string; messageID?: string },
  ): Promise<SessionInfo | null> {
    try {
      const result = await this.session.fork({
        path: { id },
        body: options?.messageID ? { messageID: options.messageID } : undefined,
        query: options?.directory ? { directory: options.directory } : undefined,
      });
      return extractSingularResponse<SessionInfo>(result);
    } catch {
      return null;
    }
  }

  async status(id: string, directory?: string): Promise<SessionStatus | null> {
    try {
      const result = await this.session.status({
        query: directory ? { directory } : undefined,
      });
      const r = result as {
        data?: Record<string, SessionStatus>;
        error?: unknown;
      };
      if (r.error) return null;
      const statusMap = r.data;
      if (!statusMap) return null;
      return statusMap[id] ?? null;
    } catch {
      return null;
    }
  }

  async prompt(
    id: string,
    options: {
      parts: Array<{ type: string; text: string }>;
      noReply?: boolean;
      system?: string;
      agent?: string;
    },
  ): Promise<{ id: string } | null> {
    try {
      const result = await this.session.promptAsync({
        path: { id },
        body: {
          parts: options.parts.map((p) => ({ type: p.type as "text", text: p.text })),
          ...(options.noReply !== undefined ? { noReply: options.noReply } : {}),
          ...(options.system ? { system: options.system } : {}),
          ...(options.agent ? { agent: options.agent } : {}),
        },
      });
      const r = result as { data?: { id: string }; error?: unknown };
      if (r.error) return null;
      return r.data ?? null;
    } catch {
      return null;
    }
  }

  async promptSync(
    id: string,
    options: {
      parts: Array<{ type: string; text: string }>;
      agent?: string;
      signal?: AbortSignal;
    },
  ): Promise<{ parts: Array<{ type: string; text?: string }> } | null> {
    try {
      const result = await this.session.prompt({
        path: { id },
        body: {
          parts: options.parts.map((p) => ({ type: p.type as "text", text: p.text })),
          ...(options.agent ? { agent: options.agent } : {}),
        },
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const r = result as { data?: { parts: Array<{ type: string; text?: string }> }; error?: unknown };
      if (r.error) return null;
      return r.data ?? null;
    } catch {
      return null;
    }
  }

  async create(options: {
    directory: string;
    agent?: string;
    parentID?: string;
  }): Promise<SessionInfo | null> {
    try {
      const result = await this.session.create({
        body: {
          ...(options.parentID ? { parentID: options.parentID } : {}),
        },
        query: { directory: options.directory },
      });
      return extractSingularResponse<SessionInfo>(result);
    } catch {
      return null;
    }
  }

  async abort(id: string): Promise<boolean> {
    try {
      await this.session.abort({ path: { id } });
      return true;
    } catch {
      return false;
    }
  }
}
