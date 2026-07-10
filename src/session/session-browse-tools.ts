import { defineTool } from "../platform/ports/tool-factory.ts";
import { z } from "zod";
import type { SessionClientWrapper } from "./client.ts";
import type { SearchMatch, ToolContext, TextPart, ToolPart, ToolStateCompleted } from "./types.ts";
import { shortId, getDirectory, searchTexts, extractContext } from "./tool-helpers.ts";
import {
  formatSessionListTable,
  formatSearchResults,
} from "./formatters.ts";

export function createSessionListTool(client: SessionClientWrapper) {
  return defineTool({
    description:
      "List all sessions with optional date range filtering. Returns a markdown table with session IDs, titles, message counts, date ranges, and durations.",
    args: {
      limit: z.number().int().min(1).max(100).optional().default(20)
        .describe("Max sessions to return (default: 20, max: 100)"),
      from_date: z.string().optional()
        .describe("Filter sessions from this date (ISO 8601 format)"),
      to_date: z.string().optional()
        .describe("Filter sessions until this date (ISO 8601 format)"),
      project_path: z.string().optional()
        .describe("Filter by project directory (default: current working directory)"),
    },
    async execute(input, context) {
      const ctx = context as ToolContext;
      const dir = input.project_path || getDirectory(ctx);
      const sessions = await client.list(dir);

      if (sessions.length === 0) return "No sessions found.";

      let filtered = sessions;
      if (input.from_date) {
        const fromMs = new Date(input.from_date).getTime();
        if (!isNaN(fromMs)) filtered = filtered.filter((s) => s.time.created >= fromMs);
      }
      if (input.to_date) {
        const toMs = new Date(input.to_date).getTime();
        if (!isNaN(toMs)) filtered = filtered.filter((s) => s.time.created <= toMs);
      }

      filtered.sort((a, b) => b.time.updated - a.time.updated);
      const limited = filtered.slice(0, input.limit ?? 20);

      const messageCounts: Record<string, number> = {};
      await Promise.all(
        limited.map(async (s) => {
          const msgs = await client.messages(s.id, { directory: dir });
          messageCounts[s.id] = msgs.length;
        }),
      );

      return formatSessionListTable(limited, messageCounts);
    },
  });
}

export function createSessionSearchTool(client: SessionClientWrapper) {
  return defineTool({
    description:
      "Full-text search across all session messages. Returns ranked results with context excerpts and bold match highlights.",
    args: {
      query: z.string().min(1).describe("Search text"),
      session_id: z.string().optional().describe("Search within a specific session only"),
      case_sensitive: z.boolean().optional().default(false).describe("Case-sensitive search"),
      limit: z.number().int().min(1).max(100).optional().default(20)
        .describe("Max results to return (default: 20)"),
      include_tool_output: z.boolean().optional().default(false)
        .describe("Also search in tool call outputs"),
    },
    async execute(input, context) {
      const ctx = context as ToolContext;
      const dir = getDirectory(ctx);
      const query = input.query;
      const caseSensitive = input.case_sensitive ?? false;
      const maxResults = input.limit ?? 20;

      let sessions;
      if (input.session_id) {
        const session = await client.get(input.session_id, dir);
        sessions = session ? [session] : [];
      } else {
        sessions = await client.list(dir);
      }

      if (sessions.length === 0) return "No sessions found.";

      const matches: SearchMatch[] = [];

      for (const session of sessions) {
        const messages = await client.messages(session.id, { directory: dir });
        if (messages.length === 0) continue;

        for (const { info, parts } of messages) {
          const textsToSearch: string[] = [];

          for (const part of parts) {
            if (part.type === "text") {
              const tp = part as TextPart;
              if (!tp.ignored) textsToSearch.push(tp.text);
            }
            if (input.include_tool_output && part.type === "tool") {
              const tp = part as ToolPart;
              if (tp.state.status === "completed") {
                const cs = tp.state as ToolStateCompleted;
                textsToSearch.push(String(cs.output));
              }
            }
          }

          if (!searchTexts(textsToSearch, query, caseSensitive)) continue;

          const fullText = textsToSearch.join(" ");
          const ctxResult = extractContext(fullText, query, caseSensitive);

          matches.push({
            sessionID: session.id,
            sessionTitle: session.title,
            messageID: info.id,
            role: info.role,
            text: ctxResult.match,
            contextBefore: ctxResult.before,
            contextAfter: ctxResult.after,
          });
        }

        if (matches.length >= maxResults) break;
      }

      const limited = matches.slice(0, maxResults);
      const sessionIds = new Set(limited.map((m) => m.sessionID));
      return formatSearchResults(limited, matches.length, sessionIds.size);
    },
  });
}
