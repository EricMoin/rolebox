/**
 * OS-level system adapter — the ONE detection seam and the descriptor registry.
 *
 * `currentPlatform()` is the only place rolebox reads `process.platform` for OS
 * facts (with a test-only override, {@link setPlatformForTest}); `getSystem()`
 * maps it to a descriptor from {@link SYSTEM_REGISTRY}. Consumers therefore read
 * one per-OS fact set instead of branching on `process.platform` themselves.
 *
 * An UNLISTED platform — `aix`, `freebsd`, `openbsd`, `sunos`, `android`, ... —
 * resolves to the `posix` descriptor: it carries POSIX-family facts under its own
 * id and label, so nothing silently pretends to be Linux and diagnostics can tell
 * which system actually answered.
 */

import { posixDescriptor, SYSTEM_REGISTRY } from "./descriptors.ts";
import type { DisposablePaths, SystemDescriptor } from "./types.ts";

export type { DisposablePaths, SystemDescriptor, SystemId } from "./types.ts";
export { SYSTEM_REGISTRY } from "./descriptors.ts";

let platformOverride: string | undefined;

/** Resolve the current platform. Defaults to `process.platform`. */
export function currentPlatform(): string {
  return platformOverride ?? process.platform;
}

/** Test-only seam. Pass `undefined` to restore the real platform. */
export function setPlatformForTest(platform: string | undefined): void {
  platformOverride = platform;
}

/**
 * Resolve the descriptor for a platform id (a `process.platform` value).
 *
 * Never throws: a platform rolebox does not declare answers the `posix`
 * descriptor rather than failing a command path or claiming to be Linux.
 */
export function detectSystem(platform: string): SystemDescriptor {
  return SYSTEM_REGISTRY.find(system => system.id === platform) ?? posixDescriptor;
}

/** The descriptor for the platform this process runs on. */
export function getSystem(): SystemDescriptor {
  return detectSystem(currentPlatform());
}

// Placeholder paths for the one introspection below: only the KEY SET of a
// descriptor's environment matters here, never a value.
const NAME_PROBE: DisposablePaths = { home: "~", config: "~/.config", cache: "~/.cache", temp: "~", env: {} };

/**
 * The disposable variables a system really sets, as model-facing text.
 *
 * Derived from the descriptor's own {@link SystemDescriptor.disposableEnvironment}
 * output rather than written out by hand, so the promise made to a worker cannot
 * drift from the environment the runner applies.
 */
export function disposableEnvironmentHint(system: SystemDescriptor = getSystem()): string {
  const names = Object.keys(system.disposableEnvironment(NAME_PROBE));
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
