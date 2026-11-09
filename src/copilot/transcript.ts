/** Builds bounded session excerpts while preserving the user's task and latest exchange. */

import type { ISessionClient } from "../platform/ports/session-client.ts";
import type { Part, ToolPart } from "../session/types.ts";
import { withTimeout, DEFAULT_TIMEOUT_MS } from "../utils/timeout.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("copilot-transcript");
const TOOL_SUMMARY_MAX = 120;
const TOOL_SUMMARY_COUNT = 12;

export interface TranscriptOptions {
  /** Recent text-bearing user/assistant messages; tool-only messages do not count. */
  window_size: number;
  /** Total character cap, including labels and tool summaries. */
  max_chars: number;
  /** Include brief tool results only after allocating space to the conversation. */
  include_tools: boolean;
}

interface TranscriptEntry {
  index: number;
  role: "user" | "assistant";
  text: string;
  tools: string[];
}

/** Returns null on a read failure, or an empty string when there is no usable context. */
export async function assembleTranscript(
  client: ISessionClient,
  sid: string,
  opts: TranscriptOptions,
): Promise<string | null> {
  const windowSize = Math.max(0, Math.floor(opts.window_size));
  const maxChars = Math.max(0, Math.floor(opts.max_chars));
  if (windowSize === 0 || maxChars === 0) return "";

  try {
    // Adapter limits can select a prefix (DSH/Pi), so window the complete
    // conversation here rather than mistaking its first messages for its tail.
    const msgs = await withTimeout(
      client.messages(sid),
      DEFAULT_TIMEOUT_MS,
      `assembleTranscript:${sid}`,
      log,
    );
    if (msgs === null) return null;

    const entries: TranscriptEntry[] = [];
    for (const [index, msg] of msgs.entries()) {
      const sourceRole = msg.info?.role;
      if (sourceRole !== "user" && sourceRole !== "assistant") continue;
      const role = sourceRole === "user" ? "user" : "assistant";

      const text = oneLine(msg.parts
        .filter((p): p is Part & { text: string } =>
          p.type === "text" && !p.synthetic && !p.ignored && typeof p.text === "string")
        .map((p) => p.text)
        .join(""));
      const tools = opts.include_tools
        ? msg.parts.map(summarizeTool).filter((s): s is string => s !== null)
        : [];
      if (text || tools.length > 0) entries.push({ index, role, text, tools });
    }

    const dialogue = entries.filter((entry) => entry.text.length > 0);
    const recent = dialogue.slice(-windowSize);
    const users = dialogue.filter((entry) => entry.role === "user");
    const latestAssistant = dialogue.findLast((entry) => entry.role === "assistant");
    const anchors = [...new Set([users.at(-1), latestAssistant, users[0]])]
      .filter((entry): entry is TranscriptEntry => entry !== undefined);

    const selected = new Map<number, string>();
    let remaining = maxChars;
    const add = (entry: TranscriptEntry, limit: number): void => {
      if (selected.has(entry.index)) return;
      const separator = selected.size > 0 ? 1 : 0;
      const available = Math.min(limit, remaining - separator);
      const prefix = `${entry.role}: `;
      if (available <= prefix.length) return;
      const line = prefix + excerpt(entry.text, available - prefix.length);
      selected.set(entry.index, line);
      remaining -= line.length + separator;
    };

    // Reserve excerpts before a long assistant reply can displace the task.
    for (const entry of anchors) add(entry, Math.floor(maxChars / 4));
    for (const entry of recent.toReversed()) {
      if (entry.role === "user") add(entry, remaining);
    }
    for (const entry of recent.toReversed()) add(entry, remaining);

    // Short histories can spend their unused budget on fuller anchor excerpts.
    for (const entry of anchors) {
      const previous = selected.get(entry.index);
      if (previous === undefined) continue;
      const prefix = `${entry.role}: `;
      const line = prefix + excerpt(entry.text, previous.length - prefix.length + remaining);
      remaining -= line.length - previous.length;
      selected.set(entry.index, line);
    }

    // Tools provide supporting evidence, not the user's intent. Keep only
    // recent results and spend at most an eighth of the transcript on them.
    const start = recent[0]?.index ?? entries.at(-windowSize)?.index ?? 0;
    const tools = entries.filter((entry) => entry.index >= start)
      .flatMap((entry) => entry.tools.map((summary) => ({
        index: entry.index,
        line: `${entry.role} ${summary}`,
      })))
      .slice(-TOOL_SUMMARY_COUNT);
    let toolBudget = Math.min(2000, Math.floor(maxChars / 8), remaining);
    const selectedTools: typeof tools = [];
    for (const tool of tools.toReversed()) {
      const separator = selected.size > 0 || selectedTools.length > 0 ? 1 : 0;
      const cost = tool.line.length + separator;
      if (cost > toolBudget) continue;
      selectedTools.push(tool);
      toolBudget -= cost;
    }
    for (const tool of selectedTools.toReversed()) {
      const previous = selected.get(tool.index);
      selected.set(tool.index, previous === undefined ? tool.line : `${previous}\n${tool.line}`);
    }

    return [...selected].sort(([a], [b]) => a - b).map(([, text]) => text).join("\n");
  } catch {
    return null;
  }
}

function isToolPart(part: Part): part is ToolPart {
  return part.type === "tool" && "state" in part && "tool" in part && "callID" in part;
}

function summarizeTool(part: Part): string | null {
  if (!isToolPart(part)) return null;
  const state = part.state;

  if (state.status === "completed") {
    const title = firstNonEmptyLine(state.title);
    const output = firstNonEmptyLine(state.output);
    const detail = title && title !== part.tool ? title : output ?? title ?? "(no output)";
    return `[tool ${oneLine(part.tool)}] completed: ${truncate(detail, TOOL_SUMMARY_MAX)}`;
  }
  if (state.status === "error") {
    return `[tool ${oneLine(part.tool)}] error: ${truncate(oneLine(String(state.error)), TOOL_SUMMARY_MAX)}`;
  }
  return null;
}

function firstNonEmptyLine(text: string): string | null {
  if (typeof text !== "string") return null;
  return text.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? null;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Keep the opening context and closing question/constraints without losing the role label. */
function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = " …[truncated]… ";
  if (limit <= marker.length) return text.slice(0, limit);
  const available = limit - marker.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(-tail) : "");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
