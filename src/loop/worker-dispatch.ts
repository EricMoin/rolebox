import type { LoopState } from "./types.js";
import type { IDispatchAdapter } from "./dispatch-adapter.js";
import {
  SEED_CHAR_CAP,
  DISPATCH_ROUND_TIMEOUT_MS,
  LOOP_PROGRESS_MARKER,
} from "./constants.js";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("loop/worker-dispatch");

/**
 * Dispatch a single loop round: build prompt, call adapter, update loop state.
 */
export async function dispatchRound(
  adapter: IDispatchAdapter,
  loop: LoopState,
  workerToOrigin: Map<string, string>,
  opts?: { roundTimeoutMs?: number },
): Promise<void> {
  let prompt = loop.basePrompt;
  if (loop.mode === "inherit" && loop.lastSummary) {
    const seed =
      loop.lastSummary.length > SEED_CHAR_CAP
        ? loop.lastSummary.slice(-SEED_CHAR_CAP)
        : loop.lastSummary;
    prompt = seed + "\n\n---\n\n" + loop.basePrompt;
  }

  const result = await adapter.dispatchRound({
    originSessionId: loop.originSessionId,
    agent: loop.agent,
    prompt,
    description: `Loop round ${loop.current}/${loop.total}`,
    timeoutMs: opts?.roundTimeoutMs ?? DISPATCH_ROUND_TIMEOUT_MS,
  });

  loop.activeWorkerTaskId = result.workerTaskId;
  loop.activeWorkerSessionId = result.workerSessionId;
  if (!loop.rounds) loop.rounds = [];
  loop.rounds.push({
    round: loop.current,
    workerTaskId: result.workerTaskId,
    workerSessionId: result.workerSessionId,
    startedAt: Date.now(),
    status: "running",
  });
  loop.phase = "awaiting_worker";
  loop.roundStartedAt = Date.now();
  loop.updatedAt = Date.now();

  workerToOrigin.set(result.workerTaskId, loop.originSessionId);

  if (loop.current === 1) {
    await adapter
      .injectNote(
        loop.originSessionId,
        `${LOOP_PROGRESS_MARKER} loop started: ${loop.total} rounds, ${loop.mode} mode]`,
      )
      .catch((err) => {
        log.warn("Failed to inject loop-started note", { err });
      });
  }
}

/**
 * Handle the summary phase: read origin summary, advance round, branch to finalize or dispatch.
 */
export async function handleSummary(
  adapter: IDispatchAdapter,
  loop: LoopState,
  workerToOrigin: Map<string, string>,
  dispatchRoundFn: () => Promise<void>,
  opts?: { delayMs?: number },
): Promise<void> {
  const summary = await adapter.readOriginSummary(
    loop.originSessionId,
    loop.summaryBoundaryMessageId,
  );

  loop.lastSummary =
    summary.length > SEED_CHAR_CAP
      ? summary.slice(-SEED_CHAR_CAP)
      : summary;
  loop.updatedAt = Date.now();

  loop.current += 1;

  if (loop.current > loop.total) {
    loop.phase = "finalizing";
    await finalizeLoop(adapter, loop, "complete", workerToOrigin);
    return;
  }

  if (loop.cancelRequested) {
    loop.phase = "finalizing";
    await finalizeLoop(adapter, loop, "cancelled", workerToOrigin);
    return;
  }

  loop.phase = "dispatching";
  const delay = opts?.delayMs ?? 0;
  if (delay > 0) {
    await new Promise((r) => setTimeout(r, delay));
  }
  await dispatchRoundFn();
}

/**
 * Finalize a loop: cancel in-flight worker, mark rounds, inject completion note.
 */
export async function finalizeLoop(
  adapter: IDispatchAdapter,
  loop: LoopState,
  terminalPhase: "complete" | "cancelled",
  workerToOrigin: Map<string, string>,
): Promise<void> {
  if (loop.activeWorkerTaskId) {
    await adapter.cancelRound(loop.activeWorkerTaskId).catch((err) => {
      log.warn("Failed to cancel active round during finalize", { err });
    });
    workerToOrigin.delete(loop.activeWorkerTaskId);
    loop.activeWorkerTaskId = undefined;
    loop.activeWorkerSessionId = undefined;
  }

  const lastRound = loop.rounds?.[loop.rounds.length - 1];
  if (lastRound && lastRound.status === "running") {
    lastRound.completedAt = Date.now();
    lastRound.durationMs = lastRound.completedAt - lastRound.startedAt;
    lastRound.status = "cancelled";
  }

  loop.phase = terminalPhase;
  loop.updatedAt = Date.now();

  const roundsSummary = (loop.rounds ?? [])
    .map((r) => {
      const dur = r.durationMs !== undefined ? `${(r.durationMs / 1000).toFixed(1)}s` : "?";
      return `r${r.round}:${r.workerSessionId}(${dur},${r.status})`;
    })
    .join(", ");

  const marker =
    terminalPhase === "complete"
      ? `${LOOP_PROGRESS_MARKER} loop complete]\nRounds: ${roundsSummary}`
      : `${LOOP_PROGRESS_MARKER} loop cancelled]\nRounds: ${roundsSummary}`;

  await adapter.injectNote(loop.originSessionId, marker);
}

/**
 * Mark a loop as failed, cancel in-flight worker, inject error note.
 */
export async function failLoop(
  adapter: IDispatchAdapter,
  loop: LoopState,
  reason: string,
  workerToOrigin: Map<string, string>,
): Promise<void> {
  if (loop.activeWorkerTaskId) {
    await adapter.cancelRound(loop.activeWorkerTaskId).catch((err) => {
      log.warn("Failed to cancel active round during failLoop", { err });
    });
    workerToOrigin.delete(loop.activeWorkerTaskId);
    loop.activeWorkerTaskId = undefined;
    loop.activeWorkerSessionId = undefined;
  }
  loop.phase = "error";
  loop.errorReason = reason;
  loop.updatedAt = Date.now();

  const lastRound = loop.rounds?.[loop.rounds.length - 1];
  if (lastRound && lastRound.status === "running") {
    lastRound.completedAt = Date.now();
    lastRound.durationMs = lastRound.completedAt - lastRound.startedAt;
    lastRound.status = "error";
  }

  await adapter
    .injectNote(loop.originSessionId, `${LOOP_PROGRESS_MARKER} error: ${reason}]`)
    .catch((err) => {
      log.warn("Failed to inject loop error note", { err });
    });
}
