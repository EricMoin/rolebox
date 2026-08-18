/**
 * Pi Child-Process Mode Guard — `src/platform/adapters/pi/child-mode.ts`
 * (subtask S2)
 *
 * A Pi subagent runs as a spawned child Pi process (`process-session.ts`):
 * the parent seeds the child with its full agent id via the
 * `ROLEBOX_ACTIVE_AGENT` env var and delivers the dispatch prompt through
 * `--append-system-prompt`. The child boots the same extension entry point
 * (`pi-extension.ts`) as the parent, so without a guard it would re-run the
 * parent-side prompt/function machinery on top of the appended prompt —
 * re-processing user messages through `handleChatMessage`, re-injecting
 * available_roles / loop_tool / available_functions into system prompts,
 * and re-wiring loop lifecycle events.
 *
 * `isPiChildProcess()` detects that mode: true when
 * `env.ROLEBOX_ACTIVE_AGENT` is a non-empty (trimmed) string. The
 * extension uses it to skip only the parent-side wiring (chat activation,
 * system-prompt injection, loop lifecycle) while keeping everything a
 * nested dispatch needs — tool registration, dispatchManager, the hook
 * pipeline, event wiring, `resources_discover`, LSP managers, and
 * `activeAgent` seeding.
 *
 * `resolveChildDispatchStoreDir()` (subtask S5) additionally isolates the
 * child's dispatch state store: a spawned child must not share the host's
 * `.rolebox/state` directory, so it is handed a per-process temp store
 * (`<tmpdir>/rolebox-dispatch/<pid>`) instead of the workspace path.
 *
 * @module
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Detect whether the current Pi process is a spawned subagent child.
 *
 * @param env - Environment map to inspect (defaults to `process.env`).
 * @returns `true` when `env.ROLEBOX_ACTIVE_AGENT` is a non-empty string
 *          after trimming — i.e. the process was seeded with an agent id
 *          by its parent.
 */
export function isPiChildProcess(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const agent = env.ROLEBOX_ACTIVE_AGENT;
  return typeof agent === "string" && agent.trim().length > 0;
}

/**
 * Resolve the dispatch state store directory for the current Pi process.
 *
 * The DispatchManager persists task results / checkpoints / progress under
 * `storeDirectory` (see `src/dispatch/factory.ts`). A spawned Pi subagent
 * child boots the same extension entry point as its parent, so without
 * isolation both processes would write `.rolebox/state` into the same
 * workspace — host and child dispatch state would collide (the child
 * materializing results via `writeResultSidecar` would stomp the parent's
 * state and vice versa). Children therefore get a per-process temp store
 * keyed by pid (`<tmpdir>/rolebox-dispatch/<pid>`); the host (non-child)
 * process keeps the workspace path (`process.cwd()`), matching opencode
 * (`ctx.directory`) and dsh.
 *
 * @param pid - Process id that keys the child store directory.
 * @param isChild - Whether the process runs in child-process mode
 *                  (`isPiChildProcess()`).
 * @returns The store directory to hand to `createDispatchManager`.
 */
export function resolveChildDispatchStoreDir(
  pid: number,
  isChild: boolean,
): string {
  if (!isChild) return process.cwd();
  return join(tmpdir(), "rolebox-dispatch", String(pid));
}
