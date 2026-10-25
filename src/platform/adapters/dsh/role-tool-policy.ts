/**
 * DSH tool families are registered globally. A monotonic registry guard applies
 * the acting role's explicit restrictions before each execution, including
 * collision-renamed tools. Hosts without a guard cannot enforce those settings
 * and therefore do not register the family.
 *
 * The `computer_*` and `browse_*` families share ONE installer: the gates and
 * the grant decisions differ, the enforcement — and what happens when the host
 * exposes no guard — must not. Each family keeps its own logger, labeling and
 * vocabulary, so a refusal names the family it refused.
 */

import type { ResolvedRole } from "../../../types.ts";
import {
  COMPUTER_TOOL_WILDCARD,
  decideComputerToolGrant,
  isComputerToolName,
} from "../../../loader/computer-grants.ts";
import {
  BROWSE_TOOL_WILDCARD,
  decideBrowseToolGrant,
  isBrowseToolName,
} from "../../../loader/browse-grants.ts";
import { createSubLogger } from "../../../logger.ts";

const computerLog = createSubLogger("dsh-computer-use-policy");
const browseLog = createSubLogger("dsh-browse-use-policy");

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

/** What one family installer decided, and why. */
export interface DshToolFamilyPolicy {
  /** The resolved global gate this policy was installed with. */
  readonly gateEnabled: boolean;
  /** A monotonic guard is installed and will enforce role restrictions. */
  readonly guardInstalled: boolean;
  /**
   * Whether the caller may register the family. TRUE only when the gate is on
   * AND the guard is installed — never when either is missing.
   */
  readonly allowRegistration: boolean;
  /** One line stating the outcome and its reason. */
  readonly reason: string;
  /** Release the guard (no-op when none was installed). */
  dispose(): void;
}

/** The computer-use policy — the shared family shape, under its own name. */
export type DshComputerUsePolicy = DshToolFamilyPolicy;
/** The browse policy — the same contract, for the `browse_*` family. */
export type DshBrowseUsePolicy = DshToolFamilyPolicy;

/** One grant decision, as the shared installer reads it. */
export interface DshFamilyGrant {
  readonly granted: boolean;
  readonly reason?: string;
}

/** The per-role inputs every family installer enforces. */
export interface DshToolFamilyPolicyOptions {
  /** The host tool registry (`ctx.tools`), read for `guard`. */
  tools: DshToolGuardRegistry;
  /** The resolved global gate; `false` installs nothing. */
  enabled: boolean;
  /** rolebox's own per-session active-role lookup (`ActiveRoleRef.get`). */
  activeRoleOf(sessionId: string): string | null;
  /** When supplied, this resolver owns identity, including a null base-agent result. */
  roleOfExecution?(execution: DshToolGuardExecution): string | null | undefined;
  /** Resolve names registered under a collision alias back to their canonical name. */
  canonicalToolNameOf?(name: string): string | undefined;
  /** The CURRENT resolved roles, read at CALL time so a reload is observed. */
  roles(): readonly ResolvedRole[];
}

/** The logger surface a family installer uses. */
interface DshPolicyLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  info(message: string): void;
}

/** Everything that differs between two families sharing this enforcement. */
interface DshToolFamilySpec {
  /** Label used in the disabled/installed reasons ("computer use"). */
  readonly label: string;
  /** The family wildcard used in reasons ("computer_*"). */
  readonly wildcard: string;
  /** Hyphenated label used when the guard could not be owned ("computer-use"). */
  readonly guardLabel: string;
  /** Whether a tool name belongs to this family (prefix, so future members count). */
  isFamilyToolName(name: string): boolean;
  /** The family's own role-grant decision. */
  decide(input: { toolName: string; roleId: string | null | undefined; roles: readonly ResolvedRole[] }): DshFamilyGrant;
  readonly log: DshPolicyLogger;
}

/**
 * Whether the explicit gate admits a tool name at REGISTRATION time.
 *
 * Checked independently of — and BEFORE — any namespace filter: dsh profiles
 * commonly set `enabledNamespaces: ["*"]`, which matches the family's namespace
 * prefix like any other, so the wildcard must never be able to enable a family
 * the gate refused. Only the resolved gate can.
 */
function isFamilyRegistrationAllowed(
  name: string,
  gateEnabled: boolean,
  isFamilyToolName: (candidate: string) => boolean,
): boolean {
  return !isFamilyToolName(name) || gateEnabled;
}

/**
 * Whether the explicit computer-use gate admits a tool name at REGISTRATION
 * time. See {@link isFamilyRegistrationAllowed}.
 *
 * @param name - The canonical tool name about to be registered.
 * @param gateEnabled - The resolved global gate.
 */
export function isComputerUseRegistrationAllowed(name: string, gateEnabled: boolean): boolean {
  return isFamilyRegistrationAllowed(name, gateEnabled, isComputerToolName);
}

/**
 * Whether the explicit browse gate admits a tool name at REGISTRATION time.
 * Same rule as the computer family: the gate is checked before, and
 * independently of, `enabledNamespaces`.
 *
 * @param name - The canonical tool name about to be registered.
 * @param gateEnabled - The resolved global gate.
 */
export function isBrowseUseRegistrationAllowed(name: string, gateEnabled: boolean): boolean {
  return isFamilyRegistrationAllowed(name, gateEnabled, isBrowseToolName);
}

/** Resolve the session id a guard execution belongs to (graph-worker.ts:222-226 pattern). */
export function dshGuardSessionId(execution: DshToolGuardExecution): string {
  return execution.agent?.session?.id ?? execution.agent?.id ?? "";
}

/** The shared fail-closed installer both families go through. */
function installDshToolFamilyPolicy(
  options: DshToolFamilyPolicyOptions,
  family: DshToolFamilySpec,
): DshToolFamilyPolicy {
  const { label, wildcard, guardLabel, log } = family;

  if (!options.enabled) {
    return {
      gateEnabled: false,
      guardInstalled: false,
      allowRegistration: false,
      reason:
        `${label} is disabled (the global gate resolved off), so no ${wildcard} tool is registered ` +
        "and no guard is installed.",
      dispose() {},
    };
  }

  if (typeof options.tools.guard !== "function") {
    // ONE explicit reason, and nothing registered: this host cannot enforce the
    // per-role grant, so it does not get an ungoverned autonomous surface.
    const reason =
      `this dsh host exposes no ctx.tools.guard, so rolebox cannot deny ${wildcard} calls for a role ` +
      `that disables them; the ${wildcard} family is NOT registered (fail closed).`;
    log.warn(`${label} refused on this host`, { reason });
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
    if (!family.isFamilyToolName(toolName)) return undefined;
    const decision = family.decide({
      toolName,
      roleId: options.roleOfExecution ? options.roleOfExecution(execution)
        : options.activeRoleOf(dshGuardSessionId(execution)),
      roles: options.roles(),
    });
    return decision.granted ? undefined : decision.reason;
  });

  if (typeof disposer !== "function") {
    const reason =
      `ctx.tools.guard returned no disposer on this dsh host, so the ${guardLabel} guard could not be ` +
      `owned; the ${wildcard} family is NOT registered (fail closed).`;
    log.warn(`${label} refused on this host`, { reason });
    return {
      gateEnabled: true,
      guardInstalled: false,
      allowRegistration: false,
      reason,
      dispose() {},
    };
  }

  const reason =
    `${label} is enabled and the per-role guard is installed on ctx.tools.guard: a ${wildcard} call ` +
    "is allowed unless the acting role disables it in role.yaml tools:.";
  log.info(`${label} guard installed`);
  return {
    gateEnabled: true,
    guardInstalled: true,
    allowRegistration: true,
    reason,
    dispose: disposer,
  };
}

/** The computer family's spec — the wording this policy shipped with. */
const COMPUTER_FAMILY: DshToolFamilySpec = {
  label: "computer use",
  wildcard: COMPUTER_TOOL_WILDCARD,
  guardLabel: "computer-use",
  isFamilyToolName: isComputerToolName,
  decide: decideComputerToolGrant,
  log: computerLog,
};

/** The browse family's spec — identical enforcement, its own words. */
const BROWSE_FAMILY: DshToolFamilySpec = {
  label: "browse use",
  wildcard: BROWSE_TOOL_WILDCARD,
  guardLabel: "browse-use",
  isFamilyToolName: isBrowseToolName,
  decide: decideBrowseToolGrant,
  log: browseLog,
};

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
export function installDshComputerUsePolicy(
  options: DshToolFamilyPolicyOptions,
): DshComputerUsePolicy {
  return installDshToolFamilyPolicy(options, COMPUTER_FAMILY);
}

/**
 * Install the boot-time browse guard — the same fail-closed contract as
 * {@link installDshComputerUsePolicy}, for the `browse_*` family.
 */
export function installDshBrowseUsePolicy(
  options: DshToolFamilyPolicyOptions,
): DshBrowseUsePolicy {
  return installDshToolFamilyPolicy(options, BROWSE_FAMILY);
}
