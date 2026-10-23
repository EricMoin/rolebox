/**
 * DSH computer tools are registered globally. A monotonic registry guard applies
 * the acting role's explicit restrictions before each execution, including
 * collision-renamed tools. Hosts without a guard cannot enforce those settings
 * and therefore do not register the family.
 */

import type { ResolvedRole } from "../../../types.ts";
import {
  decideComputerToolGrant,
  isComputerToolName,
} from "../../../loader/computer-grants.ts";
import { createSubLogger } from "../../../logger.ts";

const log = createSubLogger("dsh-computer-use-policy");

/**
 * The execution view a guard receives — the structural subset of the harness
 * `ToolExecution` this policy reads (`@deepseek-ai/dsh-tools`
 * `lib/types/index.d.ts:261-266` extends `ToolExecutionInput`, whose `name` is
 * at `:203` and `agent` at `:210`).
 *
 * Mirrored locally (never value-imported) exactly like
 * `DshGraphWorkerRegistry` in graph-worker.ts, so this adapter stays SDK-free.
 */
export interface DshToolGuardExecution {
  readonly name: string;
  readonly agent?: {
    readonly id?: string;
    readonly session?: { readonly id?: string };
  };
}

/**
 * The guard registration seam (`ctx.tools.guard`), mirrored structurally from
 * `DshGraphWorkerRegistry.guard` (src/platform/adapters/dsh/graph-worker.ts) so
 * the two policies read the host the same way. Optional by design: a host
 * generation (or a test double) without it means "cannot enforce", which this
 * policy treats as a refusal, never as an open door.
 */
export interface DshToolGuardRegistry {
  guard?(
    guard: (execution: DshToolGuardExecution) => string | undefined,
  ): (() => void) | undefined;
}

/** What {@link installDshComputerUsePolicy} decided, and why. */
export interface DshComputerUsePolicy {
  /** The resolved global gate this policy was installed with. */
  readonly gateEnabled: boolean;
  /** A monotonic guard is installed and will enforce role restrictions. */
  readonly guardInstalled: boolean;
  /**
   * Whether the caller may register the `computer_*` family. TRUE only when the
   * gate is on AND the guard is installed — never when either is missing.
   */
  readonly allowRegistration: boolean;
  /** One line stating the outcome and its reason. */
  readonly reason: string;
  /** Release the guard (no-op when none was installed). */
  dispose(): void;
}

/**
 * Whether the explicit gate admits a tool name at REGISTRATION time.
 *
 * Checked independently of — and BEFORE — any namespace filter: dsh profiles
 * commonly set `enabledNamespaces: ["*"]`, which matches the `computer_`
 * namespace prefix like any other, so the wildcard must never be able to turn
 * screen control on. Only the resolved gate can.
 *
 * @param name - The canonical tool name about to be registered.
 * @param gateEnabled - The resolved global gate.
 */
export function isComputerUseRegistrationAllowed(
  name: string,
  gateEnabled: boolean,
): boolean {
  return !isComputerToolName(name) || gateEnabled;
}

/** Resolve the session id a guard execution belongs to (graph-worker.ts:222-226 pattern). */
export function dshGuardSessionId(execution: DshToolGuardExecution): string {
  return execution.agent?.session?.id ?? execution.agent?.id ?? "";
}

/**
 * Install the boot-time computer-use guard.
 *
 * @param options.tools - The host tool registry (`ctx.tools`), read for `guard`.
 * @param options.enabled - The resolved global gate; `false` installs nothing.
 * @param options.activeRoleOf - rolebox's own per-session active-role lookup
 *   (`ActiveRoleRef.get`); `null` means the base agent.
 * @param options.roles - The CURRENT resolved roles, read at CALL time so a
 *   role reload is observed without reinstalling the guard.
 */
export function installDshComputerUsePolicy(options: {
  tools: DshToolGuardRegistry;
  enabled: boolean;
  activeRoleOf(sessionId: string): string | null;
  /** When supplied, this resolver owns identity, including a null base-agent result. */
  roleOfExecution?(execution: DshToolGuardExecution): string | null | undefined;
  /** Resolve names registered under a collision alias back to their canonical name. */
  canonicalToolNameOf?(name: string): string | undefined;
  roles(): readonly ResolvedRole[];
}): DshComputerUsePolicy {
  if (!options.enabled) {
    return {
      gateEnabled: false,
      guardInstalled: false,
      allowRegistration: false,
      reason:
        "computer use is disabled (the global gate resolved off), so no computer_* tool is registered " +
        "and no guard is installed.",
      dispose() {},
    };
  }

  if (typeof options.tools.guard !== "function") {
    // ONE explicit reason, and nothing registered: this host cannot enforce the
    // per-role grant, so it does not get an ungoverned screen-control surface.
    const reason =
      "this dsh host exposes no ctx.tools.guard, so rolebox cannot deny computer_* calls for a role " +
      "that disables them; the computer_* family is NOT registered (fail closed).";
    log.warn("computer use refused on this host", { reason });
    return {
      gateEnabled: true,
      guardInstalled: false,
      allowRegistration: false,
      reason,
      dispose() {},
    };
  }

  const disposer = options.tools.guard((execution) => {
    const toolName = options.canonicalToolNameOf?.(execution.name) ?? execution.name;
    if (!isComputerToolName(toolName)) return undefined;
    const decision = decideComputerToolGrant({
      toolName,
      roleId: options.roleOfExecution ? options.roleOfExecution(execution)
        : options.activeRoleOf(dshGuardSessionId(execution)),
      roles: options.roles(),
    });
    return decision.granted ? undefined : decision.reason;
  });

  if (typeof disposer !== "function") {
    const reason =
      "ctx.tools.guard returned no disposer on this dsh host, so the computer-use guard could not be " +
      "owned; the computer_* family is NOT registered (fail closed).";
    log.warn("computer use refused on this host", { reason });
    return {
      gateEnabled: true,
      guardInstalled: false,
      allowRegistration: false,
      reason,
      dispose() {},
    };
  }

  const reason =
    "computer use is enabled and the per-role guard is installed on ctx.tools.guard: a computer_* call " +
    "is allowed unless the acting role disables it in role.yaml tools:.";
  log.info("computer use guard installed");
  return {
    gateEnabled: true,
    guardInstalled: true,
    allowRegistration: true,
    reason,
    dispose: disposer,
  };
}
