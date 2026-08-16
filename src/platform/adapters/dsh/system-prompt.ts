/**
 * DshSystemPromptAdapter — rolebox's session-level contribution to dsh's
 * model-facing system-prompt registry.
 *
 * dsh composes the model-facing system prompt EXCLUSIVELY from the mounted
 * `@deepseek-ai/dsh-system-prompt` registry — the `systemPrompt` service that
 * `ctx.tools` waits for (`static inject: ["systemPrompt"]`, contract §3.1;
 * satisfied in a full profile by the `system-prompt` bundle row, §5.5).
 * rolebox never registered into it:
 *
 *   - `src/dsh-plugin.ts:97` injects only `tools` / `sessions` / `subagents`
 *   - `DshHookProvider` makes `system-transform` a documented no-op
 *     (hook-provider.ts:182 — dsh has no per-turn prompt transform hook)
 *   - `DshAgentRegistrar` applies the active role's system prompt only at
 *     SUBAGENT spawn (agent-registrar.ts:541-567)
 *
 * Net effect of the gap: the main session's model never saw the switched
 * role's system prompt or its available-functions context — only spawned
 * agents did. This adapter closes that at the SESSION level by registering
 * two contributions into the structural {@link DshSystemPromptRegistry}:
 *
 *   - `rolebox:role` section (order 50) — the ACTIVE role's full
 *     systemPrompt for the current session (`resolveActiveRolePrompt`),
 *     read through the shared per-session {@link ActiveRoleRef} so a web-UI
 *     role switch reaches the next model turn. Returns `''` when no role is
 *     active; the registry's `renderPrompt` drops empty sections.
 *   - `rolebox:context` context entry (order 0) — the available-functions
 *     block for the active role (`buildAvailableFunctionsBlock`), the
 *     session-level analog of the spawn-time context provider wired in
 *     `src/dsh-plugin.ts:386-393`. Also `''` when nothing applies.
 *
 * The context entry (order 0) renders ahead of the role section (order 50),
 * mirroring the spawn-time ordering where the injected context leads and the
 * role prompt follows (agent-registrar.ts composePrompt).
 *
 * ── Memory is deliberately NOT injected ─────────────────────────────────────
 * The section/context `text` providers are SYNCHRONOUS, while
 * `MemoryStore.create` is async (`src/memory/store.ts`) — an async read
 * cannot happen inside a sync provider without blocking the prompt assembly
 * or racing a fire-and-forget update. Memory therefore stays out of this
 * seam; on the spawn path it is covered by the async-capable spawn-time
 * context provider. A future synchronous memory source (or an async registry
 * API) could add it here — the `directory` option is carried for exactly
 * that.
 *
 * The registry surface is consumed structurally (duck typing). This module
 * does NOT import `@deepseek-ai/*` (or `@opencode-ai/*`).
 *
 * @module
 */

import { buildAvailableFunctionsBlock } from "../../../prompt/builder.ts";
import { createSubLogger, formatError } from "../../../logger.ts";
import type { ResolvedFunction } from "../../../types.ts";
import type { DshAgentRegistrar } from "./agent-registrar.ts";
import type { ActiveRoleRef } from "./role-switcher.ts";

// ── Structural dsh types (@deepseek-ai/dsh-system-prompt, contract §3.1) ────

/**
 * Context passed to a system-prompt registry `text` provider.
 *
 * Structural subset: the providers read `agent.id` (the model-facing agent —
 * ALSO the session id on the dsh harness, where the agent is the session:
 * `@deepseek-ai/dsh-agent`'s typert wiring resolves an agent FROM a
 * `SessionId`) and the explicit session id, accepted under both the dsh
 * spelling (`sessionID`) and the rolebox spelling (`sessionId`) — and ignore
 * everything else. The `agent.id` fallback makes the REAL harness assembly
 * context (`{ agent, scope }`, built by `assembleContextFor` in
 * `@deepseek-ai/dsh-agent` — no separate session field) resolve per-session.
 */
export type DshSystemPromptContext = {
  /** The model-facing agent the prompt is being composed for. */
  agent?: { id?: string } | null;
  /** Session id, dsh spelling. */
  sessionID?: string;
  /** Session id, rolebox spelling. */
  sessionId?: string;
  [key: string]: unknown;
};

/** A named, ordered section of the model-facing system prompt. */
export type DshSystemPromptSection = {
  name: string;
  order: number;
  /** Render the section body for a context; `''` drops the section. */
  text: (ctx: DshSystemPromptContext) => string;
};

/** A named, ordered context contribution (same shape as a section). */
export type DshSystemPromptContextEntry = {
  name: string;
  order: number;
  text: (ctx: DshSystemPromptContext) => string;
};

/**
 * The dsh system-prompt registry seam this adapter registers into
 * (structural subset of the `@deepseek-ai/dsh-system-prompt` service; the
 * real service keys contributions by `name`, so re-registering a name
 * replaces the previous entry). Both methods return the disposer that
 * removes the contribution.
 */
export type DshSystemPromptRegistry = {
  section(entry: DshSystemPromptSection): () => void;
  context(entry: DshSystemPromptContextEntry): () => void;
};

// ── Adapter implementation ──────────────────────────────────────────────────

/** Options for constructing a DshSystemPromptAdapter. */
export interface DshSystemPromptAdapterOptions {
  /** Registry holding all resolved agent definitions (roles + subagents). */
  registrar: DshAgentRegistrar;
  /**
   * Shared per-session active-role holder (the {@link DshRoleSwitcher}'s
   * `activeRole`). Read at render time so a switch reaches the next model
   * turn.
   */
  activeRole: ActiveRoleRef;
  /** Role id → resolved functions (the module-level `roleFunctionsMap`). */
  roleFunctionsMap: Map<string, ResolvedFunction[]>;
  /**
   * The rolebox directory. Carried for parity with the spawn-time context
   * injection options and reserved for a future SYNCHRONOUS memory injector;
   * the current providers never read it (memory is async — see the module
   * docstring).
   */
  directory: string;
}

/**
 * Registers rolebox's session-level system-prompt contributions into the dsh
 * system-prompt registry, so the model-facing prompt carries the ACTIVE
 * role's system prompt (the `rolebox:role` section) and its
 * available-functions block (the `rolebox:context` context entry) — the
 * session-level counterpart of the registrar's spawn-time injection.
 */
export class DshSystemPromptAdapter {
  private readonly registrar: DshAgentRegistrar;
  private readonly activeRole: ActiveRoleRef;
  private readonly roleFunctionsMap: Map<string, ResolvedFunction[]>;
  private readonly directory: string;
  /** Registry disposers returned by `section()`/`context()` — released by `dispose()`. */
  private readonly disposers: Array<() => void> = [];
  private readonly _log;

  /**
   * @param options - See {@link DshSystemPromptAdapterOptions}.
   */
  constructor(options: DshSystemPromptAdapterOptions) {
    this.registrar = options.registrar;
    this.activeRole = options.activeRole;
    this.roleFunctionsMap = options.roleFunctionsMap;
    this.directory = options.directory;
    this._log = createSubLogger("dsh-system-prompt");
  }

  /**
   * Register the `rolebox:role` section and the `rolebox:context` context
   * entry into the registry.
   *
   * Each disposer returned by the registry is collected and released by
   * {@link dispose}. The real registry keys contributions by name, so a
   * second `register()` on the same registry replaces the previous entries
   * of the same name (standard registry semantics).
   *
   * @param registry - The structural dsh system-prompt registry seam.
   */
  register(registry: DshSystemPromptRegistry): void {
    this.disposers.push(
      registry.section({
        name: "rolebox:role",
        order: 50,
        text: (ctx) => resolveActiveRolePrompt(ctx, this.registrar, this.activeRole),
      }),
      registry.context({
        name: "rolebox:context",
        order: 0,
        text: (ctx) => buildContextBlock(ctx, this.activeRole, this.roleFunctionsMap),
      }),
    );
  }

  /**
   * Remove every registered contribution from the dsh registry.
   * Idempotent — safe to call multiple times.
   */
  dispose(): void {
    const disposers = this.disposers.splice(0);
    for (const disposer of disposers) {
      try {
        disposer();
      } catch (err) {
        this._log.debug("dsh system-prompt disposer failed", {
          error: formatError(err),
        });
      }
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the session id from a provider context.
 *
 * Acceptance order: the explicit dsh spelling (`sessionID`), the rolebox
 * spelling (`sessionId`), then — matching the REAL harness assembly context
 * (`{ agent, scope }` from `@deepseek-ai/dsh-agent`'s `assembleContextFor`,
 * where the model-facing agent IS the session) — the agent's own `id`.
 */
function resolveSessionId(ctx: DshSystemPromptContext): string | undefined {
  if (typeof ctx.sessionID === "string") return ctx.sessionID;
  if (typeof ctx.sessionId === "string") return ctx.sessionId;
  if (typeof ctx.agent?.id === "string") return ctx.agent.id;
  return undefined;
}

/**
 * Resolve the ACTIVE role's full systemPrompt for a provider context.
 *
 * Resolution chain — every missing link yields `''`, which the registry's
 * `renderPrompt` drops:
 *   1. `ctx.agent?.id` — there IS a model-facing agent on the context
 *   2. a session id on the context — dsh `sessionID`, rolebox `sessionId`,
 *      or (the real harness context `{ agent, scope }`, where the agent is
 *      the session) the agent's own `id`
 *   3. `activeRole.get(sessionId)` — a role is active for that session
 *   4. `registrar.getRegisteredAgents()` lookup — the active id resolves to
 *      a registered definition
 *
 * @returns The active role definition's full `systemPrompt`, or `''` when
 *          no role is active (base-agent behavior).
 */
function resolveActiveRolePrompt(
  ctx: DshSystemPromptContext,
  registrar: DshAgentRegistrar,
  activeRole: ActiveRoleRef,
): string {
  if (!ctx.agent?.id) return "";
  const sessionId = resolveSessionId(ctx);
  if (!sessionId) return "";
  const activeId = activeRole.get(sessionId);
  if (!activeId) return "";
  const definition = registrar
    .getRegisteredAgents()
    .find((a) => a.id === activeId);
  return definition?.systemPrompt ?? "";
}

/**
 * Resolve the active role's available-functions block for a provider
 * context — the session-level analog of the spawn-time contextProvider in
 * `src/dsh-plugin.ts:386-393`.
 *
 * Returns `''` when no role is active for the session or the role has no
 * resolved functions (the block builder itself returns `''` for an empty
 * list, so `renderPrompt` drops the contribution either way).
 */
function buildContextBlock(
  ctx: DshSystemPromptContext,
  activeRole: ActiveRoleRef,
  roleFunctionsMap: Map<string, ResolvedFunction[]>,
): string {
  const sessionId = resolveSessionId(ctx);
  if (!sessionId) return "";
  const activeId = activeRole.get(sessionId);
  if (!activeId) return "";
  const functions = roleFunctionsMap.get(activeId);
  if (!functions || functions.length === 0) return "";
  return buildAvailableFunctionsBlock(functions);
}
