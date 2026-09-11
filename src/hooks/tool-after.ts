import { functionSessionState } from "../function/session-state.ts";
import { functionRuntime } from "../function/runtime-state.ts";
import { ArtifactStore } from "../function/artifact-store.ts";
import { loadHandlers, safeCall } from "../function/handlers-loader.ts";
import { FunctionContext } from "../function/context.ts";
import { runToolObserve } from "../function/observe.ts";
import { collectAllFunctions, fetchLastAssistantText, appendCorrection } from "./context.ts";
import { drainHandlerContext } from "./drain-handler.ts";
import { createSubLogger, formatError } from "../logger.ts";
import type { HookState } from "./state.ts";
import type { HookDeps } from "./deps.ts";

const log = createSubLogger("hook-tool-after");

export async function handleToolAfter(
  input: { sessionID?: string; tool?: string; args?: unknown },
  output: unknown,
  state: HookState,
  deps: HookDeps,
): Promise<void> {
  if (!input.sessionID || !input.tool) return;
  const sid: string = input.sessionID;

  // Defense-in-depth: if dispatch_output returned "still running" (edge cases),
  // inject a correction to prevent repeated polling
  if (input.tool === "dispatch_output" && typeof output === "string" && output.includes("still running")) {
    appendCorrection(state.pendingCorrections, sid,
      "WARNING: dispatch_output was called on a task that is still running. " +
      "Do NOT call dispatch_output again for this task_id. " +
      "Wait for the <system-reminder> notification.",
    );
  }

  const toolArgs = input.args;

  // Built-in hooks: before phase (runs before custom hooks)
  const builtinBeforeCtx = () => ({
    hookName: "[builtin.before]",
    config: undefined,
    sessionID: sid,
    agent: state.sessionAgentRegistry.get(sid),
    inject: (text: string) => appendCorrection(state.pendingCorrections, sid, text),
    log: createSubLogger("hook:builtin-before"),
  });
  await deps.builtInHooks?.runHooks(
    "tool.execute.after",
    "before",
    builtinBeforeCtx,
    { tool: input.tool, args: toolArgs, output },
    deps.builtinConfig ?? {},
  );

  // Custom hooks: before phase

  const toolBeforeCtx = () => ({
    hookName: "[custom.before]",
    config: undefined,
    sessionID: sid,
    agent: state.sessionAgentRegistry.get(sid),
    inject: (text: string) => appendCorrection(state.pendingCorrections, sid, text),
    log: createSubLogger("hook:custom-before"),
  });
  await deps.customHooks.runHooks(
    "tool.execute.after",
    "before",
    toolBeforeCtx,
    { tool: input.tool, args: toolArgs, output },
  );

  // --- function OBSERVE ---
  const activeNames = functionSessionState.getActive(input.sessionID);
  if (activeNames.size === 0) return;
  const allFns = collectAllFunctions(deps.roleFunctionsMap);
  const activeFns = allFns.filter((f) => activeNames.has(f.name));
  if (activeFns.length === 0) return;

  let artifacts: ArtifactStore | undefined;
  let lastAssistantText: string | null = null;

  // Tier-1: function observe
  try {
    artifacts = new ArtifactStore(deps.dir);
    const needsText = activeFns.some((f) =>
      (f.observe ?? []).some(
        (s) => s.on === "tool_after" && s.capture_artifact && (!s.tool || s.tool === input.tool),
      ),
    );
    lastAssistantText = needsText
      ? await fetchLastAssistantText(deps.session, input.sessionID)
      : null;
    const injects = runToolObserve({
      sessionID: input.sessionID, tool: input.tool,
      activeFns, artifacts, lastAssistantText,
      toolArgs: input.args,
      toolOutput: output,
    });
    for (const inj of injects) {
      appendCorrection(state.pendingCorrections, input.sessionID, inj);
    }
  } catch (err) {
    log.warn("tool.execute.after observe error", { error: formatError(err) });
  }

  // --- Tier-2 handlers: onToolAfter ---
  try {
    for (const fn of activeFns) {
      if (!fn.handlers) continue;
      const mod = await loadHandlers(fn.filePath, fn.handlers);
      if (!mod?.onToolAfter) continue;
      const ctx = new FunctionContext(
        input.sessionID, fn.name, functionRuntime, artifacts ?? new ArtifactStore(deps.dir),
        lastAssistantText ?? null, fn.state_schema_version ?? 1,
      );
      await safeCall(() => mod.onToolAfter!(ctx, { tool: input.tool!, args: input.args }));
      drainHandlerContext(ctx, input.sessionID, fn.name, state.pendingCorrections, functionSessionState, functionRuntime, allFns);
    }
  } catch (err) {
    log.warn("tool.execute.after handler error", { error: formatError(err) });
  }

  // Custom hooks: after phase
  await deps.customHooks.runHooks(
    "tool.execute.after",
    "after",
    () => ({
      hookName: "[custom.after]",
      config: undefined,
      sessionID: sid,
      agent: state.sessionAgentRegistry.get(sid),
      inject: (text: string) => appendCorrection(state.pendingCorrections, sid, text),
      log: createSubLogger("hook:custom-after"),
    }),
    { tool: input.tool, args: toolArgs, output },
  );

  // Built-in hooks: after phase (runs after custom hooks)
  await deps.builtInHooks?.runHooks(
    "tool.execute.after",
    "after",
    () => ({
      hookName: "[builtin.after]",
      config: undefined,
      sessionID: sid,
      agent: state.sessionAgentRegistry.get(sid),
      inject: (text: string) => appendCorrection(state.pendingCorrections, sid, text),
      log: createSubLogger("hook:builtin-after"),
    }),
    { tool: input.tool, args: toolArgs, output },
    deps.builtinConfig ?? {},
  );
}
