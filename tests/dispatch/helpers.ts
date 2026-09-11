import { mock } from "bun:test";
import type { ISessionClient } from "../../src/platform/ports/session-client";
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
 * Creates an ISessionClient mock with all methods mocked.
 * Each method returns a sensible default success value unless overridden.
 */
export function createMockClient(overrides?: {
  sessionCreate?: () => unknown;
  /** Override for synchronous prompt (waits for response) */
  sessionPrompt?: () => unknown;
  /** Override for fire-and-forget prompt (notification injection) */
  sessionPromptAsync?: () => unknown;
  sessionPromptSync?: () => unknown;
  sessionMessages?: () => unknown;
  sessionStatus?: () => unknown;
  sessionAbort?: () => unknown;
  sessionGet?: () => unknown;
  sessionList?: () => unknown;
  sessionChildren?: () => unknown;
  sessionTodo?: () => unknown;
  sessionDiff?: () => unknown;
  sessionFork?: () => unknown;
}): ISessionClient {
  return {
    create: mock(
      overrides?.sessionCreate ??
        (() => Promise.resolve({ id: "test-session-1" })),
    ),
    prompt: mock(
      overrides?.sessionPromptAsync
        ? (id: string, opts: any) => {
            // Convert ISessionClient prompt(id, opts) to the SDK format
            // { path: { id }, body: opts } so test assertions targeting
            // c[0].path.id and c[0].body keep working.
            const sdkCall = { path: { id }, body: opts || {} };
            // Forward to the test override as a single SDK-format argument
            return overrides!.sessionPromptAsync!(sdkCall);
          }
        : ((id: string, opts: any) => {
            // Default: capture call in SDK format for test assertions
            // This ensures tests checking c[0]?.path?.id / c[0]?.body work
            return Promise.resolve({ id: "prompt-1" });
          }),
    ),
    promptSync: mock(
      overrides?.sessionPromptSync ?? overrides?.sessionPrompt ??
        (() =>
          Promise.resolve({
            parts: [{ type: "text" as const, text: "Hello from subagent" }],
          })),
    ),
    messages: mock(
      overrides?.sessionMessages ??
        (() => Promise.resolve([])),
    ),
    status: mock(
      overrides?.sessionStatus ??
        (() => Promise.resolve(null)),
    ),
    abort: mock(
      overrides?.sessionAbort ??
        (() => Promise.resolve(true)),
    ),
    get: mock(
      overrides?.sessionGet ??
        (() => Promise.resolve({ id: "test-session-1" })),
    ),
    list: mock(
      overrides?.sessionList ??
        (() => Promise.resolve([])),
    ),
    children: mock(
      overrides?.sessionChildren ??
        (() => Promise.resolve([])),
    ),
    todo: mock(
      overrides?.sessionTodo ??
        (() => Promise.resolve([])),
    ),
    diff: mock(
      overrides?.sessionDiff ??
        (() => Promise.resolve([])),
    ),
    fork: mock(
      overrides?.sessionFork ??
        (() => Promise.resolve(null)),
    ),
  } as unknown as ISessionClient;
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
