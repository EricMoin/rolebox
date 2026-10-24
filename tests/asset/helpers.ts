/**
 * Shared fixtures for the tests/asset suite.
 */

import type { CanonicalToolContext } from "../../src/platform/types.ts";

/** Supply an owning role id when exercising private subagent assets. */
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
