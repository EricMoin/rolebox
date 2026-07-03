import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { SessionClientWrapper } from "./client.ts";
import type {
  SessionInfo,
  Message,
  Part,
  FileDiff,
  Todo,
  TextPart,
  ReasoningPart,
  ToolPart,
  ToolStateCompleted,
  SessionStats,
  SearchMatch,
  ToolContext,
} from "./types.ts";
import {
  relativeTime,
  formatDate,
  formatDuration,
  formatSessionListTable,
  formatMessages,
  formatStats,
  formatDiff,
  formatSearchResults,
  formatTodoList,
} from "./formatters.ts";

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return id.slice(0, 12) + "...";
}

function getDirectory(context: ToolContext): string | undefined {
  return context.directory || undefined;
}

function searchTexts(texts: string[], query: string, caseSensitive: boolean): boolean {
  if (caseSensitive) return texts.some((t) => t.includes(query));
  const lower = query.toLowerCase();
  return texts.some((t) => t.toLowerCase().includes(lower));
}

function extractContext(text: string, query: string, caseSensitive: boolean, window = 80): {
  before: string;
  match: string;
  after: string;
} {
  const idx = caseSensitive
    ? text.indexOf(query)
    : text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return { before: "", match: "", after: "" };

  const actual = text.slice(idx, idx + query.length);
  const start = Math.max(0, idx - window);
  const end = Math.min(text.length, idx + query.length + window);
  const before = text.slice(start, idx);
  const after = text.slice(idx + query.length, end);

  const trimmedBefore =
    before.length > window / 2 ? "..." + before.slice(-(window / 2)) : before;
  const trimmedAfter =
    after.length > window / 2 ? after.slice(0, window / 2) + "..." : after;

  return { before: trimmedBefore, match: actual, after: trimmedAfter };
}

async function collectSessionAnalytics(
  client: SessionClientWrapper,
  session: SessionInfo,
  directory?: string,
): Promise<{
  messageCount: number;
  childrenCount: number;
  stats: SessionStats;
  todos: Todo[];
  status: string;
}> {
  const messages = await client.messages(session.id, { directory });
  const children = await client.children(session.id, directory);
  const todos = await client.todo(session.id, directory);
  const diffs = await client.diff(session.id, { directory });
  const status = await client.status(session.id, directory);

  const stats: SessionStats = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalCost: 0,
    toolFrequencies: {},
    modelDistribution: {},
    totalAdditions: 0,
    totalDeletions: 0,
    filesModified: diffs.length,
    diffs,
  };

  for (const { info, parts } of messages) {
    if (info.role === "assistant") {
      stats.totalInputTokens += info.tokens?.input ?? 0;
      stats.totalOutputTokens += info.tokens?.output ?? 0;
      stats.totalReasoningTokens += info.tokens?.reasoning ?? 0;
      stats.totalCacheRead += info.tokens?.cache?.read ?? 0;
      stats.totalCacheWrite += info.tokens?.cache?.write ?? 0;
      stats.totalCost += info.cost ?? 0;

      const modelKey = `${info.providerID ?? "?"}/${info.modelID ?? "?"}`;
      stats.modelDistribution[modelKey] =
        (stats.modelDistribution[modelKey] ?? 0) + 1;
    }

    for (const part of parts) {
      if (part.type === "tool") {
        const tp = part as ToolPart;
        stats.toolFrequencies[tp.tool] =
          (stats.toolFrequencies[tp.tool] ?? 0) + 1;
      }
    }
  }

  for (const diff of diffs) {
    stats.totalAdditions += diff.additions;
    stats.totalDeletions += diff.deletions;
  }

  const statusText = status ? status.type : "unknown";

  return {
    messageCount: messages.length,
    childrenCount: children.length,
    stats,
    todos,
    status: statusText,
  };
}

export function createSessionListTool(client: SessionClientWrapper) {
  return tool({
    description:
      "List all sessions with optional date range filtering. Returns a markdown table with session IDs, titles, message counts, date ranges, and durations.",
    args: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .describe("Max sessions to return (default: 20, max: 100)"),
      from_date: z
        .string()
        .optional()
        .describe("Filter sessions from this date (ISO 8601 format)"),
      to_date: z
        .string()
        .optional()
        .describe("Filter sessions until this date (ISO 8601 format)"),
      project_path: z
        .string()
        .optional()
        .describe("Filter by project directory (default: current working directory)"),
    },
    async execute(input, context) {
      const ctx = context as ToolContext;
      const dir = input.project_path || getDirectory(ctx);
      const sessions = await client.list(dir);

      if (sessions.length === 0) {
        return "No sessions found.";
      }

      let filtered = sessions;
      if (input.from_date) {
        const fromMs = new Date(input.from_date).getTime();
        if (!isNaN(fromMs)) {
          filtered = filtered.filter((s) => s.time.created >= fromMs);
        }
      }
      if (input.to_date) {
        const toMs = new Date(input.to_date).getTime();
        if (!isNaN(toMs)) {
          filtered = filtered.filter((s) => s.time.created <= toMs);
        }
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

export function createSessionReadTool(client: SessionClientWrapper) {
  return tool({
    description:
      "Read the full transcript of a session with optional filtering by role, tool, or message range. Includes metadata like model info and cost per message.",
    args: {
      session_id: z.string().describe("Session ID"),
      include_todos: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include todo list if available"),
      include_thinking: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include reasoning/thinking parts"),
      include_tool_results: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include tool call outputs"),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Max messages to return (default: all)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(0)
        .describe("Skip first N messages (0-based)"),
      role_filter: z
        .enum(["user", "assistant"])
        .optional()
        .describe("Only show messages from this role"),
      tool_filter: z
        .string()
        .optional()
        .describe("Only show tool calls matching this tool name (substring match)"),
    },
    async execute(input, context) {
      const ctx = context as ToolContext;
      const dir = getDirectory(ctx);
      const session = await client.get(input.session_id, dir);

      if (!session) {
        return `Session not found: ${input.session_id}`;
      }

      let messages = await client.messages(input.session_id, {
        directory: dir,
        limit: input.limit,
      });

      if (messages.length === 0) {
        return `Session "${session.title}" (${shortId(session.id)}) has no messages.`;
      }

      const offset = input.offset ?? 0;
      if (offset > 0) {
        messages = messages.slice(offset);
      }

      const header = [
        `Session: ${session.title}`,
        `ID: ${session.id}`,
        `Created: ${formatDate(session.time.created)}`,
        `Updated: ${formatDate(session.time.updated)}`,
        `Duration: ${formatDuration(session.time.updated - session.time.created)}`,
        "",
        "---",
        "",
      ].join("\n");

      const body = formatMessages(messages, {
        includeThinking: input.include_thinking,
        includeToolResults: input.include_tool_results,
        roleFilter: input.role_filter,
        toolFilter: input.tool_filter,
        offset,
      });

      let todoSection = "";
      if (input.include_todos) {
        const todos = await client.todo(input.session_id, dir);
        todoSection = "\n\n### Todos\n" + formatTodoList(todos);
      }

      return header + body + todoSection;
    },
  });
}

export function createSessionSearchTool(client: SessionClientWrapper) {
  return tool({
    description:
      "Full-text search across all session messages. Returns ranked results with context excerpts and bold match highlights.",
    args: {
      query: z.string().min(1).describe("Search text"),
      session_id: z
        .string()
        .optional()
        .describe("Search within a specific session only"),
      case_sensitive: z
        .boolean()
        .optional()
        .default(false)
        .describe("Case-sensitive search"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .describe("Max results to return (default: 20)"),
      include_tool_output: z
        .boolean()
        .optional()
        .default(false)
        .describe("Also search in tool call outputs"),
    },
    async execute(input, context) {
      const ctx = context as ToolContext;
      const dir = getDirectory(ctx);
      const query = input.query;
      const caseSensitive = input.case_sensitive ?? false;
      const maxResults = input.limit ?? 20;

      let sessions: SessionInfo[];
      if (input.session_id) {
        const session = await client.get(input.session_id, dir);
        sessions = session ? [session] : [];
      } else {
        sessions = await client.list(dir);
      }

      if (sessions.length === 0) {
        return "No sessions found.";
      }

      const matches: SearchMatch[] = [];

      for (const session of sessions) {
        const messages = await client.messages(session.id, { directory: dir });
        if (messages.length === 0) continue;

        for (const { info, parts } of messages) {
          const textsToSearch: string[] = [];

          for (const part of parts) {
            if (part.type === "text") {
              const tp = part as TextPart;
              if (!tp.ignored) {
                textsToSearch.push(tp.text);
              }
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

export function createSessionInfoTool(client: SessionClientWrapper) {
  return tool({
    description:
      "Get comprehensive session information including token usage breakdown, cost, tool call frequencies, model distribution, file modifications, and todo progress.",
    args: {
      session_id: z.string().describe("Session ID"),
    },
    async execute(input, context) {
      const ctx = context as ToolContext;
      const dir = getDirectory(ctx);
      const session = await client.get(input.session_id, dir);

      if (!session) {
        return `Session not found: ${input.session_id}`;
      }

      const analytics = await collectSessionAnalytics(client, session, dir);

      const lines: string[] = [];

      lines.push(`## Session: ${session.title}`);
      lines.push("");
      lines.push(`**ID:** ${session.id}`);
      lines.push(`**Project:** ${session.projectID}`);
      lines.push(`**Directory:** ${session.directory}`);
      lines.push(
        `**Created:** ${formatDate(session.time.created)} (${relativeTime(session.time.created)})`,
      );
      lines.push(
        `**Updated:** ${formatDate(session.time.updated)} (${relativeTime(session.time.updated)})`,
      );
      lines.push(
        `**Duration:** ${formatDuration(session.time.updated - session.time.created)}`,
      );
      lines.push(`**Version:** ${session.version}`);
      if (session.parentID) {
        lines.push(`**Parent Session:** ${session.parentID}`);
      }
      if (session.summary?.diffs) {
        const sum = session.summary;
        lines.push(
          `**Summary:** +${sum.additions} / -${sum.deletions} across ${sum.files} files`,
        );
      }
      lines.push("");

      lines.push(`**Messages:** ${analytics.messageCount}`);
      lines.push(`**Children:** ${analytics.childrenCount}`);
      lines.push(`**Status:** ${analytics.status}`);
      lines.push("");

      lines.push(formatStats(analytics.stats));

      if (analytics.todos.length > 0) {
        lines.push("### Todo Progress");
        const completed = analytics.todos.filter(
          (t) => t.status === "completed",
        ).length;
        const inProgress = analytics.todos.filter(
          (t) => t.status === "in_progress",
        ).length;
        const pending = analytics.todos.length - completed - inProgress;
        lines.push(
          `  ${completed} completed, ${inProgress} in progress, ${pending} pending`,
        );
        lines.push("");
      }

      return lines.join("\n");
    },
  });
}

export function createSessionDiffTool(client: SessionClientWrapper) {
  return tool({
    description:
      "Get all file changes made in a session. Shows a unified diff of every file modified, added, or deleted. Optionally filter to a specific message.",
    args: {
      session_id: z.string().describe("Session ID"),
      message_id: z
        .string()
        .optional()
        .describe("Get diff up to a specific message"),
    },
    async execute(input, context) {
      const ctx = context as ToolContext;
      const dir = getDirectory(ctx);
      const diffs = await client.diff(input.session_id, {
        directory: dir,
        messageID: input.message_id,
      });

      return formatDiff(diffs);
    },
  });
}

export function createSessionForkTool(client: SessionClientWrapper) {
  return tool({
    description:
      "Fork (branch) a session at a specific message. Creates a new session diverging from the original at the given point. If no message ID provided, forks at the latest message.",
    args: {
      session_id: z.string().describe("Session ID to fork"),
      message_id: z
        .string()
        .optional()
        .describe("Fork at this message ID (if omitted, fork at latest)"),
    },
    async execute(input, context) {
      const ctx = context as ToolContext;
      const dir = getDirectory(ctx);
      const session = await client.get(input.session_id, dir);

      if (!session) {
        return `Session not found: ${input.session_id}`;
      }

      const forked = await client.fork(input.session_id, {
        directory: dir,
        messageID: input.message_id,
      });

      if (!forked) {
        return "Failed to fork session. The session may not exist or the message ID may be invalid.";
      }

      return [
        "## Session Forked Successfully",
        "",
        `**Original Session:** ${session.title} (${session.id})`,
        `**New Session:** ${forked.title} (${forked.id})`,
        `**Created:** ${formatDate(forked.time.created)}`,
        input.message_id
          ? `**Forked at message:** ${shortId(input.message_id)}`
          : "**Forked at:** latest message",
        "",
        "The new session is a copy of the original up to the fork point. Changes made after the fork point in the original session are not included.",
      ].join("\n");
    },
  });
}
