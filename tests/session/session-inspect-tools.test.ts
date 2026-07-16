import { describe, it, expect } from "bun:test";
import {
  createSessionReadTool,
  createSessionInfoTool,
  createSessionDiffTool,
  createSessionForkTool,
} from "../../src/session/session-inspect-tools.ts";
import type { SessionClientWrapper } from "../../src/session/client.ts";
import { createMockClient } from "../dispatch/helpers.ts";

/** Helper to cast mock ISessionClient to SessionClientWrapper. */
function mockClient(overrides?: Parameters<typeof createMockClient>[0]): SessionClientWrapper {
  return createMockClient(overrides) as unknown as SessionClientWrapper;
}

const defaultCtx = {
  sessionID: "ses_test",
  agent: "test-agent",
  directory: "/tmp",
} as never;

function makeSession(opts: {
  id: string;
  title?: string;
  created?: number;
  updated?: number;
  projectID?: string;
  directory?: string;
  parentID?: string;
  version?: string;
}) {
  return {
    id: opts.id,
    projectID: opts.projectID ?? "proj1",
    directory: opts.directory ?? "/tmp",
    title: opts.title ?? "Test Session",
    version: opts.version ?? "1",
    parentID: opts.parentID,
    time: {
      created: opts.created ?? 1000,
      updated: opts.updated ?? 2000,
    },
  };
}

describe("createSessionReadTool", () => {
  const defaultArgs = { session_id: "ses_1", include_todos: false, include_thinking: false, include_tool_results: false, offset: 0 };

  it('returns "Session not found" when session does not exist', async () => {
    const tool = createSessionReadTool(mockClient({ sessionGet: () => Promise.resolve(null) }));
    const result = await tool.execute(defaultArgs as never, defaultCtx);
    expect(result).toBe("Session not found: ses_1");
  });

  it('returns "has no messages" for empty session', async () => {
    const tool = createSessionReadTool(mockClient({
      sessionGet: () => Promise.resolve(makeSession({ id: "ses_1", title: "Empty" })),
      sessionMessages: () => Promise.resolve([]),
    }));
    const result = (await tool.execute(defaultArgs as never, defaultCtx)) as string;
    expect(result).toContain("Empty");
    expect(result).toContain("has no messages");
  });

  it("renders header with session information", async () => {
    const tool = createSessionReadTool(mockClient({
      sessionGet: () => Promise.resolve(makeSession({ id: "ses_1", title: "My Session", created: 1000, updated: 2000 })),
      sessionMessages: () => Promise.resolve([
        { info: { id: "msg_1", sessionID: "ses_1", role: "user" as const, time: { created: 1500 } }, parts: [] },
      ]),
    }));
    const result = (await tool.execute(defaultArgs as never, defaultCtx)) as string;
    expect(result).toContain("Session: My Session");
    expect(result).toContain("ID: ses_1");
    expect(result).toContain("Created: 1970-01-01 00:00:01");
    expect(result).toContain("Updated: 1970-01-01 00:00:02");
    expect(result).toContain("Duration: 1s");
  });

  it("includes todo section when include_todos is true", async () => {
    const tool = createSessionReadTool(mockClient({
      sessionGet: () => Promise.resolve(makeSession({ id: "ses_1" })),
      sessionMessages: () => Promise.resolve([
        { info: { id: "msg_1", sessionID: "ses_1", role: "user" as const, time: { created: 1500 } }, parts: [] },
      ]),
      sessionTodo: () => Promise.resolve([
        { content: "Task A", status: "completed", priority: "high", id: "1" },
      ]),
    }));
    const result = (await tool.execute({ ...defaultArgs, include_todos: true } as never, defaultCtx)) as string;
    expect(result).toContain("### Todos");
    expect(result).toContain("Task A");
  });

  it("applies offset to messages", async () => {
    const tool = createSessionReadTool(mockClient({
      sessionGet: () => Promise.resolve(makeSession({ id: "ses_1" })),
      sessionMessages: () => Promise.resolve([
        { info: { id: "msg_1", sessionID: "ses_1", role: "user" as const, time: { created: 0 } }, parts: [{ id: "p1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "First" }] },
        { info: { id: "msg_2", sessionID: "ses_1", role: "user" as const, time: { created: 100 } }, parts: [{ id: "p2", sessionID: "ses_1", messageID: "msg_2", type: "text", text: "Second" }] },
      ]),
    }));
    const result = (await tool.execute({ ...defaultArgs, offset: 1 } as never, defaultCtx)) as string;
    expect(result).toContain("[Message 2]");
    expect(result).not.toContain("[Message 1]");
  });
});

describe("createSessionInfoTool", () => {
  const args = { session_id: "ses_1" };

  it('returns "Session not found" when session does not exist', async () => {
    const tool = createSessionInfoTool(mockClient({ sessionGet: () => Promise.resolve(null) }));
    const result = await tool.execute(args as never, defaultCtx);
    expect(result).toBe("Session not found: ses_1");
  });

  it("renders comprehensive session info", async () => {
    const tool = createSessionInfoTool(mockClient({
      sessionGet: () => Promise.resolve(makeSession({ id: "ses_1", title: "Info Session", created: 1000, updated: 2000, projectID: "my-project", parentID: "parent_1" })),
      sessionMessages: () => Promise.resolve([
        {
          info: {
            id: "msg_1", sessionID: "ses_1", role: "assistant" as const,
            modelID: "gpt-4", providerID: "openai", cost: 0.005,
            tokens: { input: 200, output: 100, reasoning: 20, cache: { read: 10, write: 5 } },
            time: { created: 1500 },
          },
          parts: [],
        },
      ]),
      sessionChildren: () => Promise.resolve([makeSession({ id: "child_1", title: "Child" })]),
      sessionTodo: () => Promise.resolve([
        { content: "Task A", status: "completed", priority: "high", id: "1" },
      ]),
      sessionStatus: () => Promise.resolve(null),
    }));
    const result = (await tool.execute(args as never, defaultCtx)) as string;
    expect(result).toContain("Session: Info Session");
    expect(result).toContain("**ID:** ses_1");
    expect(result).toContain("**Project:** my-project");
    expect(result).toContain("**Parent Session:** parent_1");
    expect(result).toContain("**Messages:** 1");
    expect(result).toContain("**Children:** 1");
    expect(result).toContain("Total Cost: $0.005000");
    expect(result).toContain("openai/gpt-4: 1 messages");
  });

  it("shows todo progress when todos exist", async () => {
    const tool = createSessionInfoTool(mockClient({
      sessionGet: () => Promise.resolve(makeSession({ id: "ses_1", title: "Todos" })),
      sessionMessages: () => Promise.resolve([]),
      sessionChildren: () => Promise.resolve([]),
      sessionTodo: () => Promise.resolve([
        { content: "Done", status: "completed", priority: "high", id: "1" },
        { content: "Doing", status: "in_progress", priority: "medium", id: "2" },
        { content: "Pending", status: "pending", priority: "low", id: "3" },
      ]),
      sessionStatus: () => Promise.resolve(null),
    }));
    const result = (await tool.execute(args as never, defaultCtx)) as string;
    expect(result).toContain("Todo Progress");
    expect(result).toContain("1 completed, 1 in progress, 1 pending");
  });

  it("renders summary when available", async () => {
    const sessionWithSummary = makeSession({ id: "ses_1", title: "Summary" }) as Record<string, unknown>;
    (sessionWithSummary as Record<string, unknown>).summary = { additions: 10, deletions: 5, files: 3, diffs: [] };
    const tool = createSessionInfoTool(mockClient({
      sessionGet: () => Promise.resolve(sessionWithSummary),
      sessionMessages: () => Promise.resolve([]),
      sessionChildren: () => Promise.resolve([]),
      sessionTodo: () => Promise.resolve([]),
      sessionStatus: () => Promise.resolve(null),
    }));
    const result = (await tool.execute(args as never, defaultCtx)) as string;
    expect(result).toContain("Summary:");
    expect(result).toContain("+10 / -5 across 3 files");
  });
});

describe("createSessionDiffTool", () => {
  const args = { session_id: "ses_1" };

  it('returns "No file changes" when no diffs exist', async () => {
    const tool = createSessionDiffTool(mockClient({ sessionDiff: () => Promise.resolve([]) }));
    const result = (await tool.execute(args as never, defaultCtx)) as string;
    expect(result).toBe("No file changes in this session.");
  });

  it("renders diffs when present", async () => {
    const tool = createSessionDiffTool(mockClient({
      sessionDiff: () => Promise.resolve([
        { file: "src/a.ts", before: "old", after: "new", additions: 1, deletions: 1 },
      ]),
    }));
    const result = (await tool.execute(args as never, defaultCtx)) as string;
    expect(result).toContain("Files changed: 1");
    expect(result).toContain("--- a/src/a.ts");
    expect(result).toContain("-old");
    expect(result).toContain("+new");
  });

  it("passes message_id when provided", async () => {
    let capturedOpts: unknown = null;
    const tool = createSessionDiffTool(mockClient({
      sessionDiff: ((id: string, opts?: { directory?: string; messageID?: string }) => {
        capturedOpts = opts;
        return Promise.resolve([]);
      }) as () => unknown,
    }));
    await tool.execute({ session_id: "ses_1", message_id: "msg_5" } as never, defaultCtx);
    expect(capturedOpts).toHaveProperty("messageID", "msg_5");
  });
});

describe("createSessionForkTool", () => {
  const args = { session_id: "ses_1" };

  it('returns error message when session not found', async () => {
    const tool = createSessionForkTool(mockClient({ sessionGet: () => Promise.resolve(null) }));
    const result = await tool.execute(args as never, defaultCtx);
    expect(result).toBe("Session not found: ses_1");
  });

  it('returns failure message when fork returns null', async () => {
    const tool = createSessionForkTool(mockClient({
      sessionGet: () => Promise.resolve(makeSession({ id: "ses_1" })),
      sessionFork: () => Promise.resolve(null),
    }));
    const result = (await tool.execute(args as never, defaultCtx)) as string;
    expect(result).toContain("Failed to fork session");
  });

  it("returns success message with original and new session info", async () => {
    const forkedSession = makeSession({ id: "forked_1", title: "Forked Session", created: 3000 });
    const tool = createSessionForkTool(mockClient({
      sessionGet: () => Promise.resolve(makeSession({ id: "ses_1", title: "Original" })),
      sessionFork: () => Promise.resolve(forkedSession),
    }));
    const result = (await tool.execute(args as never, defaultCtx)) as string;
    expect(result).toContain("Session Forked Successfully");
    expect(result).toContain("**Original Session:** Original (ses_1)");
    expect(result).toContain("**New Session:** Forked Session (forked_1)");
    expect(result).toContain("**Forked at:** latest message");
  });

  it("includes fork message ID when provided", async () => {
    const tool = createSessionForkTool(mockClient({
      sessionGet: () => Promise.resolve(makeSession({ id: "ses_1", title: "Original" })),
      sessionFork: () => Promise.resolve(makeSession({ id: "forked_1", title: "Forked" })),
    }));
    const result = (await tool.execute({ session_id: "ses_1", message_id: "msg_3" } as never, defaultCtx)) as string;
    expect(result).toContain("Forked at message");
  });
});
