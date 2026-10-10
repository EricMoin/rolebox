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
 * ── Computer use (per-role grant) ─────────────────────────────────────────
 * When the host wires {@link ToolInterceptorComputerUse}, the interceptor also
 * enforces the computer-use grant for the acting role: a `computer_*` call is
 * denied unless the session's active role declares it in role.yaml `tools:`
 * (`computer_screenshot: true`, or the family wildcard `computer_*: true`).
 * The denial is RETURNED as an error string exactly like a validation failure
 * (and injected into `pendingCorrections` when hook state is wired), so the
 * shared pipeline's throwing contract surfaces to Pi the same way it already
 * does — the model is told which role and which grant are missing. The check
 * runs BEFORE `handleToolBefore` so a computer tool that is not (or no longer)
 * in the schema registry cannot slip past it. Nothing changes for every other
 * tool: without the seam, or for a non-computer name, the pipeline below is
 * byte-for-byte the previous behavior.
 *
 * @module
 */

import { handleToolBefore } from "../../../hooks/tool-before.ts";
import { appendCorrection } from "../../../hooks/context.ts";
import type { HookState } from "../../../hooks/state.ts";
import type { HookDeps } from "../../../hooks/deps.ts";
import type { CanonicalToolContext } from "../../types.ts";
import type { ResolvedRole } from "../../../types.ts";
import {
  decideComputerToolGrant,
  isComputerToolName,
} from "../../../loader/computer-grants.ts";
import { createSubLogger } from "../../../logger.ts";
import { err, ok, type Result } from "../../../utils/result.ts";

const log = createSubLogger("pi-tool-interceptor");

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
  /**
   * Computer-use enforcement seam. Absent → no computer-use policy runs (the
   * family is then not registered by this host either, so the two cannot
   * disagree). See {@link ToolInterceptorComputerUse}.
   */
  computerUse?: ToolInterceptorComputerUse;
}

/**
 * The computer-use policy the Pi entry wires into the interceptor.
 *
 * Pi carries the acting role in its own active-agent ref rather than in the
 * tool context, so the entry supplies the lookup instead of the interceptor
 * reaching into the platform.
 */
export interface ToolInterceptorComputerUse {
  /** The resolved global gate; `false` makes the seam inert. */
  enabled: boolean;
  /** The role id acting in a session, or `null` for the base agent. */
  activeRoleFor(sessionID: string): string | null;
  /** The CURRENT resolved roles (read at call time so a role reload is seen). */
  roles(): readonly ResolvedRole[];
}

/** Outcome of running the tool-before pipeline against a Pi invocation.
 * `ok: false` carries the human-readable error to return to the model. */
export type ToolBeforeOutcome = Result<Record<string, unknown>, string>;

/** Surface one denial: the model gets the reason, the log gets the event. */
export function denyComputerTool(
  reason: string,
  sessionID: string,
  tool: string,
  state?: HookState,
): ToolBeforeOutcome {
  log.warn("computer use denied", { tool, sessionID, reason });
  // Correction injection: surface the rejection in the next system
  // transform, not only as a tool result.
  if (state) {
    appendCorrection(state.pendingCorrections, sessionID, reason);
  }
  return err(reason);
}

/**
 * Run the shared handleToolBefore pipeline against a Pi tool invocation.
 *
 * On success returns the (possibly zod-normalized) args — defaults applied,
 * unknown keys stripped. On failure returns the error string built by
 * handleToolBefore (unknown key(s) + valid parameter list) and, when hook
 * state is wired, injects it into the session's pendingCorrections so the
 * next system transform carries the correction to the model.
 *
 * A computer_* call whose acting role does not grant it fails the same way,
 * with a reason naming the role and the missing grant.
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
  // Computer-use policy first: a denial must not depend on the tool being in
  // the schema registry (an unregistered name returns early below).
  const computerUse = hooks?.computerUse;
  if (computerUse?.enabled === true && isComputerToolName(tool)) {
    const decision = decideComputerToolGrant({
      toolName: tool,
      roleId: computerUse.activeRoleFor(context.sessionID),
      roles: computerUse.roles(),
    });
    if (!decision.granted) {
      return denyComputerTool(decision.reason, context.sessionID, tool, hooks?.state);
    }
  }

  const output = { args: params };
  try {
    await handleToolBefore(
      { tool, sessionID: context.sessionID, callID },
      output,
      hooks?.state,
      hooks?.deps,
    );
    return ok(output.args);
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : String(caught);
    // Correction injection: surface the rejection in the next system
    // transform, not only as a tool result.
    if (hooks?.state) {
      appendCorrection(hooks.state.pendingCorrections, context.sessionID, error);
    }
    return err(error);
  }
}
