import type { DispatchTask } from "./types.ts";
import { applyWindow, spillToFile, formatResultEnvelope, DEFAULT_MAX_RESULT_CHARS } from "./completion/result-extractor.ts";
import { getDataDir } from "../cli/paths.ts";

export function formatDuration(task: DispatchTask): string {
  const end = task.completedAt ?? new Date();
  const ms = end.getTime() - task.startedAt.getTime();
  if (ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return `${minutes}m ${remain}s`;
}

export function parentContextFromTool(context: {
  sessionID: string;
  agent: string;
  directory: string;
}) {
  return {
    sessionID: context.sessionID,
    agent: context.agent,
    directory: context.directory,
  };
}

export function buildCompletedOutput(
  task: DispatchTask,
  result: { text: string; resultText: string; totalChars: number },
  opts: { maxChars: number; offset?: number; limit?: number; tail?: boolean },
  dir: string,
): string {
  const header = [
    "Task Result\n",
    `Task ID: ${task.id}`,
    `Description: ${task.description || "N/A"}`,
    `Duration: ${formatDuration(task)}`,
    `Session ID: ${task.sessionId}`,
    "",
    "---\n",
  ].join("\n");

  const windowed = applyWindow(result.resultText ?? "", opts);

  let spillPath: string | undefined;
  if (result.totalChars > opts.maxChars) {
    spillPath = spillToFile(task.id, result.text, dir);
  }

  const envelope = formatResultEnvelope({
    truncated: windowed.truncated,
    returnedChars: windowed.returnedChars,
    totalChars: windowed.totalChars,
    nextOffset: windowed.nextOffset,
    spilledFile: spillPath,
  });

  return header + windowed.text + "\n" + envelope;
}
