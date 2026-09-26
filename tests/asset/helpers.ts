/**
 * Shared fixtures for the tests/asset suite.
 */

import type { CanonicalToolContext } from "../../src/platform/types.ts";

/**
 * Build a canonical tool context for calling a `defineTool` tool directly.
 *
 * `defineTool()` declares `execute(args: z.infer<Args>, context:
 * CanonicalToolContext)` — src/platform/ports/tool-factory.ts:48 — so every
 * call site owes a context, even for the asset tools, whose `execute(input)`
 * implementations simply ignore it. The values here are inert placeholders;
 * no asset tool reads any field.
 */
export function makeToolContext(
  overrides: Partial<CanonicalToolContext> = {},
): CanonicalToolContext {
  return {
    sessionID: "test-session",
    messageID: "test-message",
    agent: "test-agent",
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
    ...overrides,
  };
}
