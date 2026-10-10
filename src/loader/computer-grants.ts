/**
 * Computer-use grants — the one place rolebox decides whether a ROLE may drive
 * the user's screen.
 *
 * The `computer_*` family (`src/computer/tools.ts`) differs in kind from every
 * other rolebox tool: it synthesizes real mouse and keyboard input on the
 * user's live desktop. It is therefore OFF unless the acting role explicitly
 * grants it, and the grant is a role.yaml declaration — never a default:
 *
 *   tools:
 *     computer_screenshot: true    # one tool, by exact name
 *     computer_*: true             # the whole family
 *
 * An absent `tools:` map, a `false` value, an unrelated key, or the bare
 * opencode-style `"*": true` wildcard all mean NO grant. That last one is
 * deliberate: `"*"` is a generic "everything else" allowance, and the one
 * capability that must never be inherited from a generic allowance is control
 * of the user's screen. The documented grants above are the whole vocabulary.
 *
 * This module owns both halves of the decision so the dsh guard, the Pi
 * interceptor and the opencode agent-config emission cannot drift apart:
 *
 *   - {@link roleGrantsComputerTool} reads one role's `tools:` map;
 *   - {@link decideComputerToolGrant} resolves the ACTING role for a session
 *     and answers a grant/denial pair whose reason names the role and the
 *     missing grant.
 *
 * The GLOBAL gate (whether the host enables the family at all) lives beside it
 * in `computer-use-gate.ts`: a role grant can never turn the family on by
 * itself — the gate AND the grant are both required.
 *
 * @module
 */

import type { ResolvedRole } from "../types.ts";

/**
 * The seven computer-use tool names, in registration order.
 *
 * Kept here (the loader owns role policy) instead of importing
 * `src/computer/tools.ts`: the gate must be evaluable by a host that never
 * loads the computer driver stack, and the drift guard is a test that compares
 * this list against `Object.keys(createComputerTools())` (tests/computer-use-gate.test.ts).
 */
export const COMPUTER_TOOL_NAMES = [
  "computer_screenshot",
  "computer_windows",
  "computer_click",
  "computer_move",
  "computer_type",
  "computer_key",
  "computer_permissions",
] as const;

/** One member of the family. */
export type ComputerToolName = (typeof COMPUTER_TOOL_NAMES)[number];

/** The tool-name prefix every member of the family shares. */
export const COMPUTER_TOOL_PREFIX = "computer_";

/**
 * The wildcard key a role.yaml `tools:` map uses to grant the whole family.
 * This is the ONLY wildcard that grants computer use.
 */
export const COMPUTER_TOOL_WILDCARD = "computer_*";

/**
 * Whether a tool name belongs to the computer-use family.
 *
 * PREFIX-based, not membership-based: the registration gate must cover every
 * current and future `computer_*` name (including one a role's grant map could
 * not have named), so a name can never slip past the gate by being new.
 */
export function isComputerToolName(name: string): boolean {
  return name.startsWith(COMPUTER_TOOL_PREFIX);
}

/** Whether `name` is one of the seven registered family members. */
export function isRegisteredComputerToolName(name: string): name is ComputerToolName {
  return (COMPUTER_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Whether a role's `tools:` map grants ONE computer-use tool.
 *
 * Grants are exact (`computer_screenshot: true`) or the family wildcard
 * (`computer_*: true`); every other key — `"*"`, a namespace prefix, a `false`
 * value — is not a grant.
 *
 * @param tools - The role's raw `tools:` map (undefined when the role declares none).
 * @param toolName - The computer-use tool name to look up.
 */
export function roleGrantsComputerTool(
  tools: Record<string, boolean> | undefined,
  toolName: string,
): boolean {
  if (tools === undefined) return false;
  if (tools[toolName] === true) return true;
  return tools[COMPUTER_TOOL_WILDCARD] === true;
}

/** The grant a denial tells the operator to add, for one tool name. */
export function computerToolGrantHint(toolName: string): string {
  return `add "${toolName}: true" or "${COMPUTER_TOOL_WILDCARD}: true" to the role's role.yaml tools: map`;
}

/**
 * One grant decision for a computer-use call.
 *
 * `granted: false` ALWAYS carries the model/host-facing reason, naming the
 * acting role (or the base agent) and the missing grant — a denial that does
 * not say what to add is not actionable.
 */
export type ComputerGrantDecision =
  | { readonly granted: true }
  | { readonly granted: false; readonly reason: string };

/**
 * Resolve whether the acting role for a session grants one computer-use tool.
 *
 * @param input.toolName - The `computer_*` tool being called.
 * @param input.roleId - The session's active role id, or `null`/`undefined`
 *   when no rolebox role is active (the base agent).
 * @param input.roles - The CURRENT resolved roles (read at call time so a role
 *   reload is observed).
 */
export function decideComputerToolGrant(input: {
  toolName: string;
  roleId: string | null | undefined;
  roles: readonly ResolvedRole[];
}): ComputerGrantDecision {
  const { toolName, roleId, roles } = input;
  if (roleId === null || roleId === undefined || roleId.length === 0) {
    return {
      granted: false,
      reason:
        `Computer use denied: this session has no active rolebox role (the base agent), ` +
        `and "${toolName}" requires an explicit grant — ${computerToolGrantHint(toolName)} ` +
        `and activate that role for this session.`,
    };
  }
  const role = roles.find((candidate) => candidate.id === roleId);
  if (role === undefined) {
    return {
      granted: false,
      reason:
        `Computer use denied for role "${roleId}": the role is not in the resolved role set, ` +
        `so it holds no grant for "${toolName}" — ${computerToolGrantHint(toolName)}.`,
    };
  }
  if (!roleGrantsComputerTool(role.config.tools, toolName)) {
    return {
      granted: false,
      reason:
        `Computer use denied for role "${roleId}": its role.yaml tools: map does not grant ` +
        `"${toolName}" — ${computerToolGrantHint(toolName)}.`,
    };
  }
  return { granted: true };
}
