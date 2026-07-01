import { mock } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { DispatchTask } from "../../src/dispatch/types";

/**
 * Creates a DispatchTask with sensible defaults for testing.
 * All fields can be overridden; unknown extra fields are accepted
 * to support optional future properties (e.g., continuationOf).
 */
export function makeTask(
  overrides: Partial<DispatchTask> & Record<string, unknown> = {},
): DispatchTask {
  return {
    id: "bg_test123",
    sessionId: "ses_abc",
    parentSessionId: "ses_parent",
    status: "pending" as const,
    agent: "test-agent",
    prompt: "do something",
    description: "test task",
    startedAt: new Date(),
    progress: { lastUpdate: new Date(), toolCalls: 0 },
    ...overrides,
  };
}

/**
 * Creates an OpencodeClient with all session methods mocked.
 * Each method returns a sensible default success value unless overridden.
 */
export function createMockClient(overrides?: {
  sessionCreate?: () => unknown;
  sessionPrompt?: () => unknown;
  sessionPromptAsync?: () => unknown;
  sessionMessages?: () => unknown;
  sessionStatus?: () => unknown;
  sessionAbort?: () => unknown;
  sessionGet?: () => unknown;
  sessionDelete?: () => unknown;
}): OpencodeClient {
  return {
    session: {
      create: mock(
        overrides?.sessionCreate ??
          (() =>
            Promise.resolve({
              data: { id: "test-session-1" },
              error: undefined,
            })),
      ),
      prompt: mock(
        overrides?.sessionPrompt ??
          (() =>
            Promise.resolve({
              data: {
                parts: [
                  { type: "text" as const, text: "Hello from subagent" },
                ],
              },
              error: undefined,
            })),
      ),
      promptAsync: mock(
        overrides?.sessionPromptAsync ??
          (() =>
            Promise.resolve({
              data: undefined,
              error: undefined,
            })),
      ),
      messages: mock(
        overrides?.sessionMessages ??
          (() =>
            Promise.resolve({
              data: [],
              error: undefined,
            })),
      ),
      status: mock(
        overrides?.sessionStatus ??
          (() =>
            Promise.resolve({
              data: {},
              error: undefined,
            })),
      ),
      abort: mock(
        overrides?.sessionAbort ??
          (() =>
            Promise.resolve({
              data: undefined,
              error: undefined,
            })),
      ),
      get: mock(
        overrides?.sessionGet ??
          (() =>
            Promise.resolve({
              data: { id: "test-session-1" },
              error: undefined,
            })),
      ),
      delete: mock(
        overrides?.sessionDelete ??
          (() =>
            Promise.resolve({
              data: true,
              error: undefined,
            })),
      ),
    },
  } as unknown as OpencodeClient;
}

/**
 * Returns a default parent context for tests.
 */
export function parentContext(overrides?: {
  sessionID?: string;
  agent?: string;
  directory?: string;
}): { sessionID: string; agent: string; directory: string } {
  return {
    sessionID: "parent-session-1",
    agent: "parent-agent",
    directory: "/tmp/test",
    ...overrides,
  };
}
