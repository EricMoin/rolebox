import { graphSessionState, advanceGraphForDispatch } from "../graph/index.ts";
import { extractDispatchTarget } from "../graph/advance.ts";
import { extractResultBlock, normalizeResult, hashResult } from "../graph/result-capture.ts";
import { functionSessionState } from "../session-state.ts";
import { functionRuntime } from "../function/runtime-state.ts";
import { ArtifactStore } from "../function/artifact-store.ts";
import { loadHandlers, safeCall } from "../function/handlers-loader.ts";
import { FunctionContext } from "../function/context.ts";
import { runToolObserve } from "../function/observe.ts";
import { collectAllFunctions, fetchLastAssistantText, appendCorrection } from "./context.ts";
import { drainHandlerContext } from "./drain-handler.ts";
import { createSubLogger } from "../logger.ts";
import type { HookState } from "./state.ts";
import type { HookDeps } from "./deps.ts";

const log = createSubLogger("hook-tool-after");

function isDispatchError(output: unknown): boolean {
  if (typeof output === "object" && output !== null) {
    const obj = output as Record<string, unknown>;
    return "error" in obj || "failure" in obj;
  }
  return false;
}

function needsResultCapture(config: { any_of?: unknown[]; all_of?: unknown[] }): boolean {
  const check = (arr: unknown[] | undefined): boolean =>
    arr?.some(
      (c) =>
        typeof c === "object" && c !== null &&
        ("converged" in c || "result_matches" in c || "stuck" in c),
    ) ?? false;
  return check(config.any_of) || check(config.all_of);
}

export async function handleToolAfter(
  input: { sessionID?: string; tool?: string; args?: unknown },
  _output: unknown,
  state: HookState,
  deps: HookDeps,
): Promise<void> {
  if (!input.sessionID || !input.tool) return;

  if (input.tool === "task" || input.tool === "dispatch") {
    if (isDispatchError(_output)) {
      log.debug("skipping advance: dispatch failed", { sessionID: input.sessionID });
      return;
    }

    const gs = graphSessionState.getState(input.sessionID);
    const graph = graphSessionState.getGraph(input.sessionID);
    if (gs && graph?.termination?.config && needsResultCapture(graph.termination.config)) {
      const target = extractDispatchTarget(input.tool, input.args);
      if (target) {
        const lastText = await fetchLastAssistantText(deps.client, input.sessionID);
        if (lastText) {
          const resultBlock = extractResultBlock(lastText);
          const normalized = normalizeResult(resultBlock);
          const hash = hashResult(normalized);
          if (!gs.lastResults) gs.lastResults = {};
          gs.lastResults[target] = { hash, text: normalized };
        }
      }
    }

    const { correction } = advanceGraphForDispatch(input.sessionID, input.tool, input.args);
    if (correction) {
      appendCorrection(state.pendingCorrections, input.sessionID, correction);
      log.debug("guardrail correction stashed", { sessionID: input.sessionID });
    }
  }

  // --- function OBSERVE ---
  try {
    const activeNames = functionSessionState.getActive(input.sessionID);
    if (activeNames.size === 0) return;
    const allFns = collectAllFunctions(deps.roleFunctionsMap);
    const activeFns = allFns.filter((f) => activeNames.has(f.name));
    if (activeFns.length === 0) return;

    const artifacts = new ArtifactStore(deps.dir);
    const needsText = activeFns.some((f) =>
      (f.observe ?? []).some(
        (s) => s.on === "tool_after" && s.capture_artifact && (!s.tool || s.tool === input.tool),
      ),
    );
    const lastAssistantText = needsText
      ? await fetchLastAssistantText(deps.client, input.sessionID)
      : null;
    const injects = runToolObserve({
      sessionID: input.sessionID, tool: input.tool,
      activeFns, artifacts, lastAssistantText,
      toolArgs: input.args,
    });
    for (const inj of injects) {
      appendCorrection(state.pendingCorrections, input.sessionID, inj);
    }

    // --- Tier-2 handlers: onToolAfter ---
    for (const fn of activeFns) {
      if (!fn.handlers) continue;
      const mod = await loadHandlers(fn.filePath, fn.handlers);
      if (!mod?.onToolAfter) continue;
      const ctx = new FunctionContext(
        input.sessionID, fn.name, functionRuntime, artifacts,
        lastAssistantText, fn.state_schema_version ?? 1,
      );
      await safeCall(() => mod.onToolAfter!(ctx, { tool: input.tool!, args: input.args }));
      drainHandlerContext(ctx, input.sessionID, fn.name, state.pendingCorrections, functionSessionState, functionRuntime, allFns);
    }
  } catch (err) {
    log.debug("tool.execute.after observe error", { error: err instanceof Error ? err.message : String(err) });
  }
}
