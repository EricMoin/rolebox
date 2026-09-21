/**
 * Single source of truth for the built-in recovery hook config keys.
 *
 * Every key here is consumed by exactly one built-in hook (or, for
 * `recovery`, by the master recovery switch). A `hooks.builtin` entry that
 * is not in this list has no effect — see
 * {@link findUnknownBuiltinConfigKeys}.
 *
 * @module recovery/builtin/keys
 */

/** Error-recovery hook keys — enabled by default. */
export const ERROR_RECOVERY_HOOK_KEYS = [
  "session_error",
  "edit_error",
  "json_error",
  "context_window",
  "empty_response",
] as const;

/** Guard hook keys — opt-in, disabled by default. */
export const GUARD_HOOK_KEYS = [
  "tool_pair_validation",
  "write_existing_file_guard",
  "bash_file_read_guard",
  "webfetch_redirect_guard",
] as const;

/** The config key of every built-in hook. */
export const BUILTIN_HOOK_KEYS = [
  ...ERROR_RECOVERY_HOOK_KEYS,
  ...GUARD_HOOK_KEYS,
] as const;

/** A `hooks.builtin` key that toggles one built-in hook. */
export type BuiltinHookKey = (typeof BUILTIN_HOOK_KEYS)[number];

/** Every recognised `hooks.builtin` key, including the `recovery` master switch. */
export const BUILTIN_CONFIG_KEYS = [...BUILTIN_HOOK_KEYS, "recovery"] as const;

/** Any recognised `hooks.builtin` key. */
export type BuiltinConfigKey = (typeof BUILTIN_CONFIG_KEYS)[number];

const KNOWN_BUILTIN_CONFIG_KEYS: ReadonlySet<string> = new Set(BUILTIN_CONFIG_KEYS);

/**
 * Find `hooks.builtin` keys that no built-in hook consumes.
 *
 * Unknown keys are reported (never removed) so a typo surfaces as a warning
 * instead of silently disabling a hook. Returned in the config's insertion
 * order.
 *
 * @param config - Merged `hooks.builtin` flags
 * @returns The unknown keys, in insertion order
 */
export function findUnknownBuiltinConfigKeys(
  config: Record<string, boolean>,
): string[] {
  const unknown: string[] = [];
  for (const key of Object.keys(config)) {
    if (!KNOWN_BUILTIN_CONFIG_KEYS.has(key)) unknown.push(key);
  }
  return unknown;
}
