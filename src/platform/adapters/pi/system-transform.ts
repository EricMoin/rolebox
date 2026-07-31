/**
 * Pi System-Prompt Transform Adapter — `src/platform/adapters/pi/system-transform.ts`
 *
 * Runs the opencode system-prompt transform pipeline
 * (`src/hooks/system-transform.ts` — `handleSystemTransform`) against the Pi
 * `before_agent_start` event shape, so the full rolebox prompt augmentation
 * works on the Pi platform without an opencode hook host:
 *
 *   - pending correction injection (`state.pendingCorrections`, consumed by
 *     `appendCorrection` from the S6 hook pipeline's event handlers)
 *   - `<available_functions>` block (`buildAvailableFunctionsBlock`)
 *   - `<available_memory>` block (`MemoryStore.create(deps.dir)` + the role's
 *     `config.memory` block, per system-transform.ts:87-110)
 *   - gate/transition evaluation (`evaluateGateAndTransitions` +
 *     `functionSessionState.activate`/`deactivate`), the function kernel's
 *     turn increment, and the priority-ordered `<active_functions>` block
 *     (`buildFunctionBlock`)
 *   - artifact consumption blocks (`buildActiveArtifactBlock`)
 *   - `<collaboration_state>` graph-state block (`graphSessionState`)
 *
 * The adapter is intentionally thin: it extracts the session id and acting
 * agent from the loosely-typed Pi event / extension ctx / active-agent ref,
 * seeds `output.system` with `[currentSystemPrompt + baseSection]` (the
 * static available_roles/loop_tool guidance the caller already built), and
 * delegates the rest to the shared pipeline. It returns `undefined` when no
 * session id can be resolved so the caller falls back to the static prompt.
 *
 * @module
 */

import { handleSystemTransform } from "../../../hooks/system-transform.ts";
import type { HookDeps } from "../../../hooks/deps.ts";
import type { HookState } from "../../../hooks/state.ts";
import { createSubLogger } from "../../../logger.ts";

const log = createSubLogger("pi-sys-xform");

// ── Pi event shape helpers ───────────────────────────────────────────────────

/**
 * Extract the session id from a Pi `before_agent_start` event with a
 * fallback chain mirroring `extractSessionId` (pi-extension.ts): direct
 * `sessionID` / `sessionId` fields, `info.sessionID` / `info.sessionId` /
 * `info.id`, then the extension context's `sessionManager.getSessionId()`.
 */
export function extractPiSessionId(
  event: Record<string, unknown>,
  ctx?: Record<string, unknown> | undefined,
): string | undefined {
  if (typeof event.sessionID === "string") return event.sessionID;
  if (typeof event.sessionId === "string") return event.sessionId;
  const info = event.info as Record<string, unknown> | undefined;
  if (typeof info?.sessionID === "string") return info.sessionID;
  if (typeof info?.sessionId === "string") return info.sessionId;
  if (typeof info?.id === "string") return info.id;
  const sessionManager = ctx?.sessionManager as
    | { getSessionId?: () => string }
    | undefined;
  if (typeof sessionManager?.getSessionId === "function") {
    return sessionManager.getSessionId();
  }
  return undefined;
}

/**
 * Extract the acting rolebox agent from the event, extension context, or the
 * Pi active-agent ref (the role-switcher source of truth — Pi never
 * populates `context.agent` itself, per pi-extension.ts). Returns
 * `undefined` when unresolved; `handleSystemTransform` then falls back to
 * `state.sessionAgentRegistry`.
 */
export function extractPiAgent(
  event: Record<string, unknown>,
  activeAgent?: { get(): string | null } | undefined,
  ctx?: Record<string, unknown> | undefined,
): string | undefined {
  if (typeof event.agent === "string") return event.agent;
  if (typeof event.agentID === "string") return event.agentID;
  if (typeof event.agentId === "string") return event.agentId;
  const info = event.info as Record<string, unknown> | undefined;
  if (typeof info?.agent === "string") return info.agent;
  if (typeof ctx?.agent === "string") return ctx.agent;
  return activeAgent?.get() ?? undefined;
}

// ── Options / result ─────────────────────────────────────────────────────────

export interface PiSystemTransformOptions {
  /**
   * Raw Pi `before_agent_start` event (loosely typed). Reads
   * `systemPrompt` (the current system prompt), plus session/agent
   * identifiers via `extractPiSessionId` / `extractPiAgent`.
   */
  event: Record<string, unknown>;
  /**
   * Pi extension context — `sessionManager.getSessionId()` resolves the
   * session id; `ctx.agent` is an agent fallback.
   */
  ctx?: Record<string, unknown> | undefined;
  /**
   * Static guidance appended verbatim after the base system prompt
   * (the existing `<available_roles>` / `<loop_tool>` block). The
   * transform pipeline pushes its own blocks AFTER this section.
   */
  baseSection?: string;
  /** Pi active-agent ref (role switcher) used as the agent fallback. */
  activeAgent?: { get(): string | null } | undefined;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Run the shared `handleSystemTransform` pipeline against a Pi
 * `before_agent_start` event.
 *
 * Seeds `output.system` with `[currentSystemPrompt + baseSection]`, then
 * lets the pipeline append the correction, available-functions, memory,
 * active-functions, artifact-consumption, and graph-state blocks. Returns
 * the joined augmented prompt, or `undefined` when no session id can be
 * resolved (the caller then keeps the static prompt unchanged). Transform
 * failures are caught and logged — the base prompt is always returned so a
 * pipeline defect can never break an agent start on Pi.
 */
export async function runPiSystemTransform(
  options: PiSystemTransformOptions,
  state: HookState,
  deps: HookDeps,
): Promise<string | undefined> {
  const sessionID = extractPiSessionId(options.event, options.ctx);
  if (!sessionID) {
    log.debug("runPiSystemTransform: no session id — skipping transform");
    return undefined;
  }

  const basePrompt =
    typeof options.event.systemPrompt === "string"
      ? options.event.systemPrompt
      : "";
  const output = { system: [basePrompt + (options.baseSection ?? "")] };
  const agent = extractPiAgent(options.event, options.activeAgent, options.ctx);

  try {
    await handleSystemTransform({ sessionID, agent }, output, state, deps);
  } catch (err) {
    log.warn("Pi system-prompt transform failed — returning base prompt", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return output.system.join("\n");
}
