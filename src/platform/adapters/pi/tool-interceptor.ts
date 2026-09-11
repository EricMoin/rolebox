/**
 * Pi tool-execution interceptor — `src/platform/adapters/pi/tool-interceptor.ts`
 *
 * Wraps each Pi-compiled tool's `execute` so that before invoking the
 * canonical def it runs the shared handleToolBefore pipeline
 * (`src/hooks/tool-before.ts`) — the same logic the opencode platform runs
 * in its `tool.execute.before` hook:
 *
 *   - zod strict validation against the shared toolSchemaRegistry
 *     (populated by `registerToolSchema` in
 *     `PiLightweightServiceStack.init`, mirroring tool-service.ts:109-112)
 *   - deprecated-tool warnings (`registerDeprecatedTool`)
 *   - custom-hook before/after phases from the S6 CustomHookRegistry
 *     (reached through `HookDeps.customHooks`)
 *   - correction injection into the session's `pendingCorrections` on
 *     validation failure, so the next system transform surfaces the
 *     rejection in the prompt
 *
 * Validation failures are RETURNED as an error string (listing the unknown
 * key(s) and the valid parameter list) instead of being thrown into Pi —
 * the model receives the correction as a normal tool result and can
 * self-correct on the next turn without polluting the session with a
 * thrown error.
 *
 * @module
 */

import { handleToolBefore } from "../../../hooks/tool-before.ts";
import { appendCorrection } from "../../../hooks/context.ts";
import type { HookState } from "../../../hooks/state.ts";
import type { HookDeps } from "../../../hooks/deps.ts";
import type { CanonicalToolContext } from "../../types.ts";

/**
 * Optional hook wiring for the interceptor. When absent, validation and
 * deprecation warnings still run (both use module-scope registries); only
 * the custom-hook phases and correction injection are skipped.
 */
export interface ToolInterceptorHooks {
  /** Hook-owned session state — pendingCorrections receives failure corrections. */
  state?: HookState;
  /** Assembled HookDeps — customHooks drives the before/after phases. */
  deps?: HookDeps;
}

/**
 * Outcome of running the tool-before pipeline against a Pi invocation.
 * `ok: false` carries the human-readable error to return to the model.
 */
export type ToolBeforeOutcome =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Run the shared handleToolBefore pipeline against a Pi tool invocation.
 *
 * On success returns the (possibly zod-normalized) args — defaults applied,
 * unknown keys stripped. On failure returns the error string built by
 * handleToolBefore (unknown key(s) + valid parameter list) and, when hook
 * state is wired, injects it into the session's pendingCorrections so the
 * next system transform carries the correction to the model.
 *
 * Never throws into Pi.
 */
export async function interceptToolBefore(
  tool: string,
  callID: string,
  params: Record<string, unknown>,
  context: CanonicalToolContext,
  hooks?: ToolInterceptorHooks,
): Promise<ToolBeforeOutcome> {
  const output = { args: params };
  try {
    await handleToolBefore(
      { tool, sessionID: context.sessionID, callID },
      output,
      hooks?.state,
      hooks?.deps,
    );
    return { ok: true, args: output.args };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Correction injection: surface the rejection in the next system
    // transform, not only as a tool result.
    if (hooks?.state) {
      appendCorrection(hooks.state.pendingCorrections, context.sessionID, error);
    }
    return { ok: false, error };
  }
}
