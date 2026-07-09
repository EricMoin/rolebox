import type { CompletionOrchestratorDeps } from "./completion-orchestrator.ts";
import { DEFAULT_BUDGET_SAMPLE_INTERVAL_MS, MATERIALIZE_TIMEOUT_MS } from "./config.ts";
import { debugLog, infoLog } from "./debug-log.ts";
import { metrics } from "./metrics.ts";
import { withTimeout } from "./with-timeout.ts";

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
      const msgResult = await withTimeout(
        deps.client.session.messages({ path: { id: sessionId } }),
        deps.config.materializeTimeoutMs ?? MATERIALIZE_TIMEOUT_MS,
        "budgetSampler:session.messages",
      );

      if (msgResult.error !== undefined || !msgResult.data) continue;

      const messages = msgResult.data as Array<{
        cost?: number;
        tokens?: { input?: number; output?: number; reasoning?: number; cache?: number };
      }>;

      let inputTokens = 0;
      let outputTokens = 0;
      let cost = 0;

      for (const msg of messages) {
        if (msg.tokens) {
          inputTokens += msg.tokens.input ?? 0;
          outputTokens += msg.tokens.output ?? 0;
        }
        if (msg.cost !== undefined) {
          cost += msg.cost;
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
