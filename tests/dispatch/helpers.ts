import { mock } from "bun:test";
import type { ISessionClient } from "../../src/platform/ports/session-client.ts";
import type { Message, MessageInfo, SessionInfo, SessionStatus } from "../../src/session/types.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";

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
    // Required DispatchTask fields the helper used to omit: `depth` (0 =
    // direct dispatch) and `priority` (0 = normal). Both were `undefined` at
    // runtime while the return type claimed `number`.
    depth: 0,
    status: "pending" as const,
    agent: "test-agent",
    prompt: "do something",
    description: "test task",
    startedAt: new Date(),
    progress: { lastUpdate: new Date(), toolCalls: 0 },
    priority: 0,
    ...overrides,
  };
}

/** The options `ISessionClient.prompt(id, options)` accepts. */
type PromptOptions = Parameters<ISessionClient["prompt"]>[1];

/**
 * The SDK-format call a `prompt`/`promptAsync` invocation is forwarded to
 * `sessionPromptAsync` overrides as: `{ path: { id }, body: <options> }`.
 * Mirrors the object built in the `prompt:` mock below.
 */
export interface PromptAsyncSdkCall {
  path: { id: string };
  body: PromptOptions;
}

/**
 * Creates a complete `SessionInfo` for testing.
 *
 * `ISessionClient.create` is declared `Promise<SessionInfo | null>`, so a
 * default returning only `{ id }` would make this mock violate the interface
 * it claims to implement — and a test asserting the full object would be
 * asserting a shape production never returns.
 */
export function makeSessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "test-session-1",
    projectID: "test-project",
    directory: "/tmp/test",
    title: "test session",
    version: "1.0.0",
    time: { created: 0, updated: 0 },
    ...overrides,
  };
}

/**
 * Creates a complete `Message` for testing.
 *
 * `ISessionClient.messages` is declared `Promise<Message[]>`, and `Message`
 * requires a full `MessageInfo` (`id`, `sessionID`, `time`, ...) plus parts
 * that satisfy `Part`. A bare `{ info: { role }, parts: [{ type, text }] }`
 * literal does not — which is why the mock could not be typed before.
 */
export function makeMessage(
  role: MessageInfo["role"] = "assistant",
  text = "done",
): Message {
  return {
    info: {
      id: "msg_test_1",
      sessionID: "test-session-1",
      role,
      time: { created: 0 },
    },
    parts: [
      {
        id: "prt_test_1",
        sessionID: "test-session-1",
        messageID: "msg_test_1",
        type: "text",
        text,
      },
    ],
  };
}

/** Creates a valid `SessionStatus` (the `idle` variant). */
export function makeIdleStatus(): SessionStatus {
  return { type: "idle" };
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
  sessionPromptAsync?: (call: PromptAsyncSdkCall) => unknown;
  sessionPromptSync?: () => unknown;
  sessionMessages?: () => unknown;
  sessionStatus?: () => unknown;
  sessionAbort?: () => unknown;
  sessionGet?: (id: string) => unknown;
  sessionList?: () => unknown;
  sessionChildren?: () => unknown;
  sessionTodo?: () => unknown;
  sessionDiff?: () => unknown;
  sessionFork?: () => unknown;
}): ISessionClient {
  return {
    create: mock(
      overrides?.sessionCreate ?? (() => Promise.resolve(makeSessionInfo())),
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
      overrides?.sessionGet
        ? (id: string) => overrides!.sessionGet!(id)
        : ((_id: string) => Promise.resolve(makeSessionInfo())),
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
