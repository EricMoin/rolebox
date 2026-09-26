/**
 * Canonical tool context for invoking the hashline tools from tests.
 *
 * `CanonicalToolDef.execute` takes TWO parameters — the zod-derived args and a
 * `CanonicalToolContext` (src/platform/types.ts, `CanonicalToolDef.execute`),
 * and both are required. The hashline tools read `context.directory` /
 * `context.worktree` through `resolveHashlinePath` (src/hashline/path-resolve.ts)
 * to resolve a model-supplied relative `filePath` against the session workspace
 * instead of the host process cwd.
 *
 * These suites build their fixtures inside a per-test temp directory and pass
 * absolute paths, so `directory` is the temp directory that actually holds the
 * file under test. Passing it keeps the resolution base honest even though an
 * absolute path passes through `resolveHashlinePath` unchanged.
 */
import type { CanonicalToolContext } from "../../../src/platform/types.ts";
import { createHashlineEditTool } from "../../../src/hashline/index.ts";

export function makeToolContext(directory: string): CanonicalToolContext {
  return {
    sessionID: "test-session",
    messageID: "test-message",
    agent: "test-agent",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    async ask() {},
  };
}

/**
 * The element shape the hashline edit tool's `files[].edits` array actually
 * requires, DERIVED from the tool definition rather than hand-written: the
 * platform adapters validate raw args with `z.object(def.args)` and hand the
 * PARSED data to `execute` (src/platform/adapters/dsh/tool-factory.ts), so
 * `op` is always present at the tool boundary even though the schema declares
 * `.default("replace")`. Deriving it keeps a test fixture from drifting back
 * out of sync with the schema the platform enforces.
 */
export type HashlineEdit =
  Parameters<ReturnType<typeof createHashlineEditTool>["execute"]>[0]["files"][number]["edits"][number];
