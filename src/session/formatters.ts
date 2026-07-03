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
} from "./types.ts";

const MS_IN_SECOND = 1000;
const MS_IN_MINUTE = 60 * MS_IN_SECOND;
const MS_IN_HOUR = 60 * MS_IN_MINUTE;
const MS_IN_DAY = 24 * MS_IN_HOUR;
const MAX_TEXT_PREVIEW = 500;

export function relativeTime(ms: number): string {
  const now = Date.now();
  const diff = now - ms;
  if (diff < 0) return "just now";
  if (diff < MS_IN_MINUTE) return `${Math.floor(diff / MS_IN_SECOND)}s ago`;
  if (diff < MS_IN_HOUR) return `${Math.floor(diff / MS_IN_MINUTE)}m ago`;
  if (diff < MS_IN_DAY) return `${Math.floor(diff / MS_IN_HOUR)}h ago`;
  const days = Math.floor(diff / MS_IN_DAY);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

export function formatDuration(ms: number): string {
  if (ms < 0) return "0s";
  if (ms < MS_IN_MINUTE) return `${Math.floor(ms / MS_IN_SECOND)}s`;
  if (ms < MS_IN_HOUR) {
    const m = Math.floor(ms / MS_IN_MINUTE);
    const s = Math.floor((ms % MS_IN_MINUTE) / MS_IN_SECOND);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(ms / MS_IN_HOUR);
  const m = Math.floor((ms % MS_IN_HOUR) / MS_IN_MINUTE);
  return `${h}h ${m}m`;
}

function truncate(text: string, max = MAX_TEXT_PREVIEW): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return id.slice(0, 12) + "...";
}

export function formatSessionTable(sessions: SessionInfo[]): string {
  if (sessions.length === 0) return "No sessions found.";

  const header = "| Session ID | Title | Date Range | Duration |\n| --- | --- | --- | --- |";
  const rows = sessions.map((s) => {
    const id = shortId(s.id);
    const title = s.title || "(untitled)";
    const created = formatDate(s.time.created);
    const updated = formatDate(s.time.updated);
    const dateRange = `${created.slice(0, 10)} -> ${updated.slice(0, 10)}`;
    const duration = formatDuration(s.time.updated - s.time.created);
    return `| ${id} | ${title} | ${dateRange} | ${duration} |`;
  });

  return [header, ...rows].join("\n");
}

export function formatSessionListTable(
  sessions: SessionInfo[],
  messageCounts: Record<string, number>,
): string {
  if (sessions.length === 0) return "No sessions found.";

  const header =
    "| Session ID | Title | Messages | Date Range | Duration |\n" +
    "| --- | --- | --- | --- | --- |";
  const rows = sessions.map((s) => {
    const id = shortId(s.id);
    const title = s.title || "(untitled)";
    const count = messageCounts[s.id] ?? 0;
    const created = formatDate(s.time.created);
    const updated = formatDate(s.time.updated);
    const dr = `${created.slice(0, 10)} -> ${updated.slice(0, 10)}`;
    const dur = formatDuration(s.time.updated - s.time.created);
    return `| ${id} | ${title} | ${count} | ${dr} | ${dur} |`;
  });

  return [header, ...rows].join("\n");
}

export function formatMessages(
  messages: Message[],
  options: {
    includeThinking?: boolean;
    includeToolResults?: boolean;
    roleFilter?: "user" | "assistant";
    toolFilter?: string;
    offset?: number;
  } = {},
): string {
  const { includeThinking, includeToolResults, roleFilter, toolFilter, offset = 0 } = options;

  const parts: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msgIdx = offset + i;
    const { info, parts: msgParts } = messages[i];

    if (roleFilter && info.role !== roleFilter) continue;

    const role = info.role === "user" ? "user" : "assistant";
    const ts = formatDate(info.time.created);
    parts.push(`\n[Message ${msgIdx + 1}] ${role} (${ts})`);

    if (info.role === "assistant" && info.modelID) {
      parts.push(`Model: ${info.providerID}/${info.modelID}`);
      if (typeof info.cost === "number") {
        parts.push(`Cost: $${info.cost.toFixed(6)}`);
      }
    }

    for (const part of msgParts) {
      switch (part.type) {
        case "text": {
          const tp = part as TextPart;
          if (tp.ignored) break;
          parts.push(truncate(tp.text));
          break;
        }
        case "reasoning": {
          if (!includeThinking) break;
          const rp = part as ReasoningPart;
          parts.push(`> thinking: ${truncate(rp.text)}`);
          break;
        }
        case "tool": {
          const tool = part as ToolPart;
          if (toolFilter && !tool.tool.includes(toolFilter)) break;

          const state = tool.state;
          if (state.status === "pending" || state.status === "running") {
            parts.push(`  [tool: ${tool.tool}] (${state.status})`);
          } else if (state.status === "completed") {
            const cs = state as ToolStateCompleted;
            parts.push(`  [tool: ${tool.tool}] ${cs.title || ""}`);
            if (includeToolResults) {
              parts.push(`    output: ${truncate(String(cs.output))}`);
            }
          } else if (state.status === "error") {
            parts.push(`  [tool: ${tool.tool}] ERROR: ${truncate(state.error)}`);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  return parts.join("\n");
}

export function formatStats(stats: SessionStats): string {
  const lines: string[] = [];

  lines.push("### Token Usage");
  lines.push(`  Input:     ${stats.totalInputTokens.toLocaleString()}`);
  lines.push(`  Output:    ${stats.totalOutputTokens.toLocaleString()}`);
  lines.push(`  Reasoning: ${stats.totalReasoningTokens.toLocaleString()}`);
  lines.push(`  Cache read:  ${stats.totalCacheRead.toLocaleString()}`);
  lines.push(`  Cache write: ${stats.totalCacheWrite.toLocaleString()}`);
  lines.push("");

  lines.push(`Total Cost: $${(stats.totalCost).toFixed(6)}`);
  lines.push("");

  const modelKeys = Object.keys(stats.modelDistribution);
  if (modelKeys.length > 0) {
    lines.push("### Models Used");
    for (const key of modelKeys.sort()) {
      lines.push(`  ${key}: ${stats.modelDistribution[key]} messages`);
    }
    lines.push("");
  }

  const toolKeys = Object.keys(stats.toolFrequencies);
  if (toolKeys.length > 0) {
    lines.push("### Tool Usage");
    const sorted = toolKeys.sort(
      (a, b) => stats.toolFrequencies[b] - stats.toolFrequencies[a],
    );
    for (const key of sorted) {
      lines.push(`  ${key}: ${stats.toolFrequencies[key]} calls`);
    }
    lines.push("");
  }

  if (stats.diffs.length > 0) {
    lines.push("### File Changes");
    lines.push(`  Files modified: ${stats.filesModified}`);
    lines.push(`  Additions: ${stats.totalAdditions}`);
    lines.push(`  Deletions: ${stats.totalDeletions}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function formatDiff(diffs: FileDiff[]): string {
  if (diffs.length === 0) return "No file changes in this session.";

  const totalAdditions = diffs.reduce((sum, d) => sum + d.additions, 0);
  const totalDeletions = diffs.reduce((sum, d) => sum + d.deletions, 0);

  const summary = [
    `Files changed: ${diffs.length}`,
    `Additions: ${totalAdditions}`,
    `Deletions: ${totalDeletions}`,
    "",
  ].join("\n");

  const fileBlocks = diffs.map((d) => {
    const lines: string[] = [];
    lines.push(`--- a/${d.file}`);
    lines.push(`+++ b/${d.file}`);

    const beforeLines = d.before.split("\n");
    const afterLines = d.after.split("\n");
    const maxLines = Math.max(beforeLines.length, afterLines.length);

    for (let i = 0; i < maxLines; i++) {
      const beforeLine = i < beforeLines.length ? beforeLines[i] : null;
      const afterLine = i < afterLines.length ? afterLines[i] : null;

      if (beforeLine !== afterLine) {
        if (beforeLine !== null) {
          lines.push(`-${beforeLine}`);
        }
        if (afterLine !== null) {
          lines.push(`+${afterLine}`);
        }
      } else {
        lines.push(` ${beforeLine}`);
      }
    }

    return lines.join("\n");
  });

  return summary + fileBlocks.join("\n\n");
}

export function formatSearchResults(
  matches: SearchMatch[],
  totalMatches: number,
  sessionCount: number,
): string {
  if (matches.length === 0) return "No matches found.";

  const header = [
    `Found ${totalMatches} match${totalMatches !== 1 ? "es" : ""} across ${sessionCount} session${sessionCount !== 1 ? "s" : ""}`,
    "",
    "---",
    "",
  ].join("\n");

  const perMatch = matches.slice(0, 20).map((m, i) => {
    const ctxBefore = m.contextBefore ? `...${m.contextBefore.slice(-80)}` : "";
    const ctxAfter = m.contextAfter ? `${m.contextAfter.slice(0, 80)}...` : "";

    return [
      `[${i + 1}] Session: ${shortId(m.sessionID)} (${m.sessionTitle})`,
      `    Message: ${shortId(m.messageID)} | Role: ${m.role}`,
      `    Context: ${ctxBefore}**${m.text}**${ctxAfter}`,
    ].join("\n");
  });

  const footer =
    matches.length > 20
      ? `\n... and ${totalMatches - 20} more matches. Use a more specific query.`
      : "";

  return header + perMatch.join("\n\n") + footer;
}

export function formatTodoList(todos: Todo[]): string {
  if (todos.length === 0) return "  No todos for this session.";

  const completed = todos.filter((t) => t.status === "completed").length;
  const header = `  ${completed}/${todos.length} completed`;
  const rows = todos.map((t) => {
    const statusIcon =
      t.status === "completed"
        ? "[x]"
        : t.status === "in_progress"
          ? "[~]"
          : "[ ]";
    return `  ${statusIcon} [${t.priority}] ${t.content}`;
  });

  return [header, ...rows].join("\n");
}
