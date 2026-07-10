import type { CompletionOrchestratorDeps } from "../completion/completion-orchestrator.ts";
import { DEFAULT_BUDGET_SAMPLE_INTERVAL_MS, MATERIALIZE_TIMEOUT_MS } from "../config.ts";
import { debugLog, infoLog } from "../core/debug-log.ts";
import { metrics } from "../persistence/metrics.ts";
import { withTimeout } from "../core/with-timeout.ts";

export function startBudgetSampler(deps: CompletionOrchestratorDeps): ReturnType<typeof setInterval> | undefined {
  const interval = deps.config.budgetSampleIntervalMs ?? DEFAULT_BUDGET_SAMPLE_INTERVAL_MS;

  const hasBudgetLimits =
    deps.config.maxInputTokensPerRequest !== undefined ||
    deps.config.maxOutputTokensPerRequest !== undefined ||
    deps.config.maxCostPerRequest !== undefined ||
    deps.config.maxInputTokensPerSession !== undefined ||
    deps.config.maxCostPerSession !== undefined;

  if (!hasBudgetLimits) return undefined;

  return setInterval(async () => {
    await sampleBudgetUsage(deps);
  }, interval);
}

export async function sampleBudgetUsage(deps: CompletionOrchestratorDeps): Promise<void> {
  for (const [sessionId, taskId] of deps.sessionToTask) {
    const task = deps.tasks.get(taskId);
    if (!task || task.status !== "running") continue;

    try {
      const messages = await withTimeout(
        deps.client.messages(sessionId),
        deps.config.materializeTimeoutMs ?? MATERIALIZE_TIMEOUT_MS,
        "budgetSampler:session.messages",
      );

      if (!messages || messages.length === 0) continue;

      let inputTokens = 0;
      let outputTokens = 0;
      let cost = 0;

      for (const msg of messages) {
        const info = msg.info as { cost?: number; tokens?: { input?: number; output?: number; reasoning?: number; cache?: number } };
        if (info.tokens) {
          inputTokens += info.tokens.input ?? 0;
          outputTokens += info.tokens.output ?? 0;
        }
        if (info.cost !== undefined) {
          cost += info.cost;
        }
      }

      deps.budgetTracker.recordUsage(
        sessionId,
        task.parentSessionId,
        { input: inputTokens, output: outputTokens },
        cost,
      );

      const sessionCheck = deps.budgetTracker.isSessionBudgetExceeded(sessionId);
      if (sessionCheck.exceeded) {
        infoLog("budget", taskId, `session budget exceeded — cancelling: ${sessionCheck.reason}`);
        metrics.counter("dispatch_rejected_total", { reason: "session-budget-exceeded" }).inc();
        void deps.cancelTask(taskId);
      }
    } catch (err) {
      debugLog("budget", taskId, `sampler error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
