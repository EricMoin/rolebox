import { defineTool } from "../platform/ports/tool-factory.ts";
import { z } from "zod";
import type { ISessionClient } from "../platform/ports/session-client.ts";
import type { ToolContext } from "./types.ts";
import { shortId, getDirectory, collectSessionAnalytics } from "./tool-helpers.ts";
import {
  formatDate,
  formatDuration,
  formatMessages,
  formatStats,
  formatDiff,
  formatTodoList,
  relativeTime,
} from "./formatters.ts";

export function createSessionReadTool(client: ISessionClient) {
  return defineTool({
    description:
      "Read the full transcript of a session with optional filtering by role, tool, or message range. Includes metadata like model info and cost per message.",
    args: {
      session_id: z.string().describe("Session ID"),
      include_todos: z.boolean().optional().default(false).describe("Include todo list if available"),
      include_thinking: z.boolean().optional().default(false).describe("Include reasoning/thinking parts"),
      include_tool_results: z.boolean().optional().default(false).describe("Include tool call outputs"),
      limit: z.number().int().min(1).optional().describe("Max messages to return (default: all)"),
      offset: z.number().int().min(0).optional().default(0).describe("Skip first N messages (0-based)"),
      role_filter: z.enum(["user", "assistant"]).optional().describe("Only show messages from this role"),
      tool_filter: z.string().optional().describe("Only show tool calls matching this tool name (substring match)"),
    },
    async execute(input, context) {
      const ctx = context as ToolContext;
      const dir = getDirectory(ctx);
      const session = await client.get(input.session_id, dir);

      if (!session) return `Session not found: ${input.session_id}`;

      let messages = await client.messages(input.session_id, { directory: dir, limit: input.limit });
      if (messages.length === 0) {
        return `Session "${session.title}" (${shortId(session.id)}) has no messages.`;
      }

      const offset = input.offset ?? 0;
      if (offset > 0) messages = messages.slice(offset);

      const header = [
        `Session: ${session.title}`,
        `ID: ${session.id}`,
        `Created: ${formatDate(session.time.created)}`,
        `Updated: ${formatDate(session.time.updated)}`,
        `Duration: ${formatDuration(session.time.updated - session.time.created)}`,
        "", "---", "",
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

export function createSessionInfoTool(client: ISessionClient) {
  return defineTool({
    description:
      "Get comprehensive session information including token usage breakdown, cost, tool call frequencies, model distribution, file modifications, and todo progress.",
    args: { session_id: z.string().describe("Session ID") },
    async execute(input, context) {
      const ctx = context as ToolContext;
      const dir = getDirectory(ctx);
      const session = await client.get(input.session_id, dir);

      if (!session) return `Session not found: ${input.session_id}`;

      const analytics = await collectSessionAnalytics(client, session, dir);

      const lines: string[] = [];
      lines.push(`## Session: ${session.title}`, "");
      lines.push(`**ID:** ${session.id}`);
      lines.push(`**Project:** ${session.projectID}`);
      lines.push(`**Directory:** ${session.directory}`);
      lines.push(`**Created:** ${formatDate(session.time.created)} (${relativeTime(session.time.created)})`);
      lines.push(`**Updated:** ${formatDate(session.time.updated)} (${relativeTime(session.time.updated)})`);
      lines.push(`**Duration:** ${formatDuration(session.time.updated - session.time.created)}`);
      lines.push(`**Version:** ${session.version}`);
      if (session.parentID) lines.push(`**Parent Session:** ${session.parentID}`);
      if (session.summary?.diffs) {
        const sum = session.summary;
        lines.push(`**Summary:** +${sum.additions} / -${sum.deletions} across ${sum.files} files`);
      }
      lines.push("");
      lines.push(`**Messages:** ${analytics.messageCount}`);
      lines.push(`**Children:** ${analytics.childrenCount}`);
      lines.push(`**Status:** ${analytics.status}`);
      lines.push("");
      lines.push(formatStats(analytics.stats));

      if (analytics.todos.length > 0) {
        lines.push("### Todo Progress");
        const completed = analytics.todos.filter((t) => t.status === "completed").length;
        const inProgress = analytics.todos.filter((t) => t.status === "in_progress").length;
        const pending = analytics.todos.length - completed - inProgress;
        lines.push(`  ${completed} completed, ${inProgress} in progress, ${pending} pending`);
        lines.push("");
      }

      return lines.join("\n");
    },
  });
}

export function createSessionDiffTool(client: ISessionClient) {
  return defineTool({
    description:
      "Get all file changes made in a session. Shows a unified diff of every file modified, added, or deleted. Optionally filter to a specific message.",
    args: {
      session_id: z.string().describe("Session ID"),
      message_id: z.string().optional().describe("Get diff up to a specific message"),
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

export function createSessionForkTool(client: ISessionClient) {
  return defineTool({
    description:
      "Fork (branch) a session at a specific message. Creates a new session diverging from the original at the given point. If no message ID provided, forks at the latest message.",
    args: {
      session_id: z.string().describe("Session ID to fork"),
      message_id: z.string().optional().describe("Fork at this message ID (if omitted, fork at latest)"),
    },
    async execute(input, context) {
      const ctx = context as ToolContext;
      const dir = getDirectory(ctx);
      const session = await client.get(input.session_id, dir);

      if (!session) return `Session not found: ${input.session_id}`;

      const forked = await client.fork(input.session_id, {
        directory: dir,
        messageID: input.message_id,
      });

      if (!forked) {
        return "Failed to fork session. The session may not exist or the message ID may be invalid.";
      }

      return [
        "## Session Forked Successfully", "",
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
