import type { MaterializedResultRef, SessionMessageSnapshot } from "../types.ts";
import type { TaskLifecycleDeps } from "../core/lifecycle-shared.ts";
import {
  getInflightCount,
  notifyCompletion,
  scheduleSidecarGC,
} from "../core/lifecycle-shared.ts";
import { extractResultBlock, readResultSidecar, resultSidecarPath, writeResultSidecar } from "./result-extractor.ts";
import { withTimeout, TimeoutError } from "../core/with-timeout.ts";
import { MATERIALIZE_TIMEOUT_MS } from "../config.ts";

/**
 * Get materialized result for a task.
 * Checks: task.result cache → lazy backward-compat fetch → orphaned sidecar → expired/not_found.
 */
export async function getResult(
  d: TaskLifecycleDeps,
  taskId: string,
): Promise<{
  kind: "ok" | "expired" | "not_found" | "fetch_error";
  text: string;
  resultText: string;
  hadFence: boolean;
  totalChars: number;
  error?: string;
}> {
  const task = d.tasks.get(taskId);

  // Step 1: Check task.result (cache hit)
  if (task?.result) {
    if (task.result.fetchError) {
      return {
        kind: "fetch_error",
        text: "",
        resultText: "",
        hadFence: false,
        totalChars: 0,
        error: task.result.fetchError,
      };
    }
    const sidecarText = readResultSidecar(task.result.sidecarPath);
    if (sidecarText !== null) {
      const extracted = extractResultBlock(sidecarText);
      return {
        kind: "ok",
        text: sidecarText,
        resultText: extracted.result,
        hadFence: extracted.hadFence,
        totalChars: task.result.totalChars,
      };
    }
  }

  // Step 2: Task completed but no result (lazy backward-compat fetch)
  if (task && task.status === "completed" && !task.result) {
    const ref = await materializeResult(d, taskId);
    task.result = ref;
    d.persistState();

    if (ref.fetchError) {
      return {
        kind: "fetch_error",
        text: "",
        resultText: "",
        hadFence: false,
        totalChars: 0,
        error: ref.fetchError,
      };
    }
    const sidecarText = readResultSidecar(ref.sidecarPath);
    if (sidecarText !== null) {
      const extracted = extractResultBlock(sidecarText);
      return {
        kind: "ok",
        text: sidecarText,
        resultText: extracted.result,
        hadFence: extracted.hadFence,
        totalChars: ref.totalChars,
      };
    }
  }

  // Step 3: Task missing but sidecar exists
  if (!task) {
    const sidecarPath = resultSidecarPath(taskId, d.directory);
    const sidecarText = readResultSidecar(sidecarPath);
    if (sidecarText !== null) {
      const extracted = extractResultBlock(sidecarText);
      return {
        kind: "ok",
        text: sidecarText,
        resultText: extracted.result,
        hadFence: extracted.hadFence,
        totalChars: sidecarText.length,
      };
    }
  }

  // Step 4: Expired / Not found
  if (task) {
    return {
      kind: "expired",
      text: "",
      resultText: "",
      hadFence: false,
      totalChars: 0,
      error: "Task status neither completed nor has materialized result",
    };
  }
  if (d.cleanedUpTasks.has(taskId)) {
    return {
      kind: "expired",
      text: "",
      resultText: "",
      hadFence: false,
      totalChars: 0,
      error: "Task result no longer available (was cleaned up)",
    };
  }
  return {
    kind: "not_found",
    text: "",
    resultText: "",
    hadFence: false,
    totalChars: 0,
    error: "Task never existed",
  };
}

/**
 * Materialize a task's output by fetching session messages and writing a sidecar file.
 */
export async function materializeResult(
  d: TaskLifecycleDeps,
  taskId: string,
): Promise<MaterializedResultRef> {
  const task = d.tasks.get(taskId);
  if (!task) {
    return {
      sidecarPath: "",
      totalChars: 0,
      hadFence: false,
      fetchError: "task not found",
      materializedAt: Date.now(),
    };
  }

  const boundary = task.messageCountAtStart ?? 0;

  try {
    const msgs = await withTimeout(
      d.client.messages(task.sessionId),
      d.config.materializeTimeoutMs ?? MATERIALIZE_TIMEOUT_MS,
      "materializeResult:session.messages",
    );

    const allMessages = (msgs ?? []) as SessionMessageSnapshot[];
    const fullText = buildAssistantText(allMessages, boundary);
    const extracted = extractResultBlock(fullText);
    const path = writeResultSidecar(taskId, fullText, d.directory);

    return {
      sidecarPath: path,
      totalChars: fullText.length,
      hadFence: extracted.hadFence,
      materializedAt: Date.now(),
    };
  } catch (err: unknown) {
    if (err instanceof TimeoutError) {
      return {
        sidecarPath: "",
        totalChars: 0,
        hadFence: false,
        fetchError: "timeout",
        materializedAt: Date.now(),
      };
    }
    return {
      sidecarPath: "",
      totalChars: 0,
      hadFence: false,
      fetchError: String(err),
      materializedAt: Date.now(),
    };
  }
}

/**
 * Build the full assistant output text from session messages,
 * starting from the given boundary index.
 */
export function buildAssistantText(
  messages: readonly SessionMessageSnapshot[],
  boundary: number,
): string {
  const textParts: string[] = [];
  for (let i = boundary; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.info.role !== "assistant") continue;
    for (const part of msg.parts) {
      if (part.type === "text") {
        textParts.push(
          (part as { type: "text"; text: string }).text,
        );
      }
    }
  }
  return textParts.join("");
}

/**
 * Materialize result for a completed task and notify the parent.
 * Only adds to notifyOutbox for final notifications (remainingTasks === 0).
 */
export async function materializeAndNotify(
  d: TaskLifecycleDeps,
  taskId: string,
): Promise<void> {
  const t = d.tasks.get(taskId);
  if (!t || t.status !== "completed") return;

  const ref = await materializeResult(d, taskId);
  t.result = ref;
  scheduleSidecarGC(d, taskId);
  d.persistState();

  let resultText: string | undefined;
  if (ref.sidecarPath && !ref.fetchError) {
    const sidecarText = readResultSidecar(ref.sidecarPath);
    if (sidecarText !== null) {
      resultText = extractResultBlock(sidecarText).result;
    }
  }

  const remaining = getInflightCount(d, t.parentSessionId);
  if (remaining === 0) {
    d.addToOutbox(taskId);
  }
  await notifyCompletion(d, t, remaining, resultText);
}
