/**
 * ActiveAgentRef — shared mutable holder for the Pi platform's "current agent".
 *
 * Pi is a single-agent harness: unlike opencode, it never populates the
 * `agent` field on a tool's execution context. Two independent Pi subsystems
 * need to agree on *which* rolebox agent is currently acting so that
 * dispatch's "direct child" gate can resolve the correct set of dispatchable
 * subagents:
 *
 *   1. The **role switcher** (`role-switcher.ts`) — when a user picks a
 *      primary role via `/role`, that role becomes the active agent for the
 *      interactive session.
 *   2. **Child processes** (`process-session.ts`) — when a subagent runs as a
 *      spawned Pi process, the process is seeded (via the
 *      `ROLEBOX_ACTIVE_AGENT` env var read in `pi-extension.ts`) with its own
 *      full agent id, so *its* dispatch tool can reach *its* children
 *      (nested dispatch).
 *
 * The dispatch tool reads this ref as a fallback whenever `context.agent` is
 * empty, which on Pi is always. opencode is unaffected because it populates
 * `context.agent` natively and never constructs this ref.
 *
 * @module
 */

/**
 * A minimal get/set holder for the currently active agent's full id.
 *
 * `null` means "base agent" (no rolebox role active) — in that state the
 * dispatch tool has no dispatchable children, matching the base-session UX.
 */
export interface ActiveAgentRef {
  /** Return the active agent full id, or `null` for the base agent. */
  get(): string | null;
  /** Set the active agent full id, or `null` to clear back to the base agent. */
  set(id: string | null): void;
}

/**
 * Create an {@link ActiveAgentRef} backed by a single closure variable.
 *
 * @param initial - Initial active agent id (e.g. seeded from an env var in a
 *                  spawned child process). Defaults to `null` (base agent).
 * @returns A fresh, independent ref.
 */
export function createActiveAgentRef(initial: string | null = null): ActiveAgentRef {
  let current = initial;
  return {
    get: () => current,
    set: (id: string | null) => {
      current = id;
    },
  };
}
