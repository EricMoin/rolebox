import type { SessionClientWrapper } from "./client.ts";
import type {
  SessionInfo,
  SessionStats,
  Todo,
  ToolPart,
  ToolStateCompleted,
} from "./types.ts";

export function shortId(id: string): string {
  if (id.length <= 12) return id;
  return id.slice(0, 12) + "...";
}

export function getDirectory(context: { directory?: string }): string | undefined {
  return context.directory || undefined;
}

export function searchTexts(texts: string[], query: string, caseSensitive: boolean): boolean {
  if (caseSensitive) return texts.some((t) => t.includes(query));
  const lower = query.toLowerCase();
  return texts.some((t) => t.toLowerCase().includes(lower));
}

export function extractContext(text: string, query: string, caseSensitive: boolean, window = 80): {
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

export async function collectSessionAnalytics(
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
