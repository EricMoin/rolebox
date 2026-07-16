import { describe, it, expect } from "bun:test";
import { createSessionListTool, createSessionSearchTool } from "../../src/session/session-browse-tools.ts";
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
}) {
  return {
    id: opts.id,
    projectID: opts.projectID ?? "proj1",
    directory: opts.directory ?? "/tmp",
    title: opts.title ?? "Test Session",
    version: "1",
    time: {
      created: opts.created ?? 1000,
      updated: opts.updated ?? 2000,
    },
  };
}

describe("createSessionListTool", () => {
  it('returns "No sessions found." when no sessions exist', async () => {
    const tool = createSessionListTool(mockClient({ sessionList: () => Promise.resolve([]) }));
    const result = await tool.execute({ limit: 20 } as never, defaultCtx);
    expect(result).toBe("No sessions found.");
  });

  it("renders a markdown table with sessions", async () => {
    const tool = createSessionListTool(mockClient({
      sessionList: () => Promise.resolve([makeSession({ id: "ses_1", title: "Session One" })]),
      sessionMessages: () => Promise.resolve([]),
    }));
    const result = await tool.execute({ limit: 20 } as never, defaultCtx);
    expect(result).toContain("Session One");
    expect(result).toContain("| Session ID | Title | Messages | Date Range | Duration |");
  });

  it("filters by from_date", async () => {
    const tool = createSessionListTool(mockClient({
      sessionList: () => Promise.resolve([
        makeSession({ id: "ses_1", title: "Old", created: 1000, updated: 1500 }),
        makeSession({ id: "ses_2", title: "New", created: 3000, updated: 3500 }),
      ]),
      sessionMessages: () => Promise.resolve([]),
    }));
    const result = (await tool.execute({ limit: 20, from_date: "1970-01-01T00:00:02Z" } as never, defaultCtx)) as string;
    expect(result).toContain("New");
    expect(result).not.toContain("Old");
  });

  it("filters by to_date", async () => {
    const tool = createSessionListTool(mockClient({
      sessionList: () => Promise.resolve([
        makeSession({ id: "ses_1", title: "Old", created: 1000, updated: 1500 }),
        makeSession({ id: "ses_2", title: "New", created: 3000, updated: 3500 }),
      ]),
      sessionMessages: () => Promise.resolve([]),
    }));
    const result = (await tool.execute({ limit: 20, to_date: "1970-01-01T00:00:02Z" } as never, defaultCtx)) as string;
    expect(result).toContain("Old");
    expect(result).not.toContain("New");
  });

  it("ignores invalid date filters", async () => {
    const tool = createSessionListTool(mockClient({
      sessionList: () => Promise.resolve([makeSession({ id: "ses_1", title: "Session" })]),
      sessionMessages: () => Promise.resolve([]),
    }));
    const result = (await tool.execute({ limit: 20, from_date: "not-a-date" } as never, defaultCtx)) as string;
    expect(result).toContain("Session");
  });

  it("respects limit parameter", async () => {
    const sessions = Array.from({ length: 10 }, (_, i) =>
      makeSession({ id: `ses_${i}`, title: `Session ${i}`, created: i * 1000 }),
    );
    const tool = createSessionListTool(mockClient({
      sessionList: () => Promise.resolve(sessions),
      sessionMessages: () => Promise.resolve([]),
    }));
    const result = (await tool.execute({ limit: 3 } as never, defaultCtx)) as string;
    const tableLines = result.split("\n").filter((l) => l.startsWith("| "));
    expect(tableLines.length).toBe(5); // header + separator + 3 data rows
  });

  it("sorts by updated time descending", async () => {
    const tool = createSessionListTool(mockClient({
      sessionList: () => Promise.resolve([
        makeSession({ id: "ses_1", title: "Older", created: 1000, updated: 1000 }),
        makeSession({ id: "ses_2", title: "Newer", created: 500, updated: 2000 }),
      ]),
      sessionMessages: () => Promise.resolve([]),
    }));
    const result = (await tool.execute({ limit: 20 } as never, defaultCtx)) as string;
    expect(result.indexOf("Newer")).toBeLessThan(result.indexOf("Older"));
  });

  it("handles project_path filter", async () => {
    let capturedDir: string | undefined;
    const tool = createSessionListTool(mockClient({
      sessionList: (dir?: string) => {
        capturedDir = dir;
        return Promise.resolve([]);
      },
    }));
    await tool.execute({ limit: 20, project_path: "/custom/path" } as never, defaultCtx);
    expect(capturedDir).toBe("/custom/path");
  });

  it("includes message counts from client", async () => {
    let capturedCounts = 0;
    const tool = createSessionListTool(mockClient({
      sessionList: () => Promise.resolve([makeSession({ id: "ses_1", title: "With Messages" })]),
      sessionMessages: () => {
        capturedCounts++;
        return Promise.resolve([
          { info: { id: "m1", sessionID: "ses_1", role: "user" as const, time: { created: 0 } }, parts: [] },
        ]);
      },
    }));
    const result = (await tool.execute({ limit: 20 } as never, defaultCtx)) as string;
    expect(result).toContain("1");
    expect(capturedCounts).toBeGreaterThan(0);
  });
});

describe("createSessionSearchTool", () => {
  const defaultSearchArgs = {
    query: "",
    case_sensitive: false,
    limit: 20,
    include_tool_output: false,
  };

  it('returns "No sessions found." when no sessions exist', async () => {
    const tool = createSessionSearchTool(mockClient({ sessionList: () => Promise.resolve([]) }));
    const result = await tool.execute({ ...defaultSearchArgs, query: "test" } as never, defaultCtx);
    expect(result).toBe("No sessions found.");
  });

  it("searches across all sessions and returns results", async () => {
    const tool = createSessionSearchTool(mockClient({
      sessionList: () => Promise.resolve([
        makeSession({ id: "ses_1", title: "Target Session" }),
        makeSession({ id: "ses_2", title: "Other Session" }),
      ]),
      sessionMessages: () => Promise.resolve([
        {
          info: { id: "msg_1", sessionID: "ses_1", role: "user" as const, time: { created: 0 } },
          parts: [{ id: "p1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "hello world" }],
        },
        {
          info: { id: "msg_2", sessionID: "ses_2", role: "user" as const, time: { created: 0 } },
          parts: [{ id: "p2", sessionID: "ses_2", messageID: "msg_2", type: "text", text: "no match here" }],
        },
      ]),
    }));
    const result = (await tool.execute({ ...defaultSearchArgs, query: "hello" } as never, defaultCtx)) as string;
    expect(result).toContain("Found");
    expect(result).toContain("hello");
    expect(result).toContain("Target Session");
  });

  it("searches within a specific session when session_id given", async () => {
    let getCalledWith = "";
    const tool = createSessionSearchTool(mockClient({
      sessionGet: ((id: string) => {
        getCalledWith = id;
        return Promise.resolve(makeSession({ id, title: "Specific" }));
      }) as () => unknown,
      sessionMessages: () => Promise.resolve([
        {
          info: { id: "msg_1", sessionID: "ses_specific", role: "user" as const, time: { created: 0 } },
          parts: [{ id: "p1", sessionID: "ses_specific", messageID: "msg_1", type: "text", text: "unique content" }],
        },
      ]),
    }));
    await tool.execute({ ...defaultSearchArgs, query: "unique", session_id: "ses_specific" } as never, defaultCtx);
    expect(getCalledWith).toBe("ses_specific");
  });

  it('returns "No sessions found." when session not found', async () => {
    const tool = createSessionSearchTool(mockClient({ sessionGet: () => Promise.resolve(null) }));
    const result = await tool.execute({ ...defaultSearchArgs, query: "anything", session_id: "nonexistent" } as never, defaultCtx);
    expect(result).toBe("No sessions found.");
  });

  it("respects case_sensitive option", async () => {
    const tool = createSessionSearchTool(mockClient({
      sessionList: () => Promise.resolve([makeSession({ id: "ses_1", title: "Test" })]),
      sessionMessages: () => Promise.resolve([
        {
          info: { id: "msg_1", sessionID: "ses_1", role: "user" as const, time: { created: 0 } },
          parts: [{ id: "p1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "UpperCase" }],
        },
      ]),
    }));
    const resultCase = await tool.execute({ ...defaultSearchArgs, query: "uppercase", case_sensitive: true } as never, defaultCtx);
    expect(resultCase).toBe("No matches found.");
    const resultNoCase = (await tool.execute({ ...defaultSearchArgs, query: "uppercase", case_sensitive: false } as never, defaultCtx)) as string;
    expect(resultNoCase).toContain("Found");
  });

  it("includes tool output when include_tool_output is true", async () => {
    const tool = createSessionSearchTool(mockClient({
      sessionList: () => Promise.resolve([makeSession({ id: "ses_1", title: "Tool Session" })]),
      sessionMessages: () => Promise.resolve([
        {
          info: { id: "msg_1", sessionID: "ses_1", role: "assistant" as const, modelID: "m", providerID: "p", time: { created: 0 } },
          parts: [{
            id: "p1", sessionID: "ses_1", messageID: "msg_1", type: "tool", callID: "c1", tool: "bash",
            state: { status: "completed" as const, input: {}, output: "toolOutputSecret", title: "Run", metadata: {}, time: { start: 0, end: 100 } },
          }],
        },
      ]),
    }));
    const result = (await tool.execute({ ...defaultSearchArgs, query: "toolOutputSecret", include_tool_output: true } as never, defaultCtx)) as string;
    expect(result).toContain("Found");
  });

  it("excludes tool output by default", async () => {
    const tool = createSessionSearchTool(mockClient({
      sessionList: () => Promise.resolve([makeSession({ id: "ses_1", title: "Tool Session" })]),
      sessionMessages: () => Promise.resolve([
        {
          info: { id: "msg_1", sessionID: "ses_1", role: "assistant" as const, modelID: "m", providerID: "p", time: { created: 0 } },
          parts: [{
            id: "p1", sessionID: "ses_1", messageID: "msg_1", type: "tool", callID: "c1", tool: "bash",
            state: { status: "completed" as const, input: {}, output: "hiddenOutput", title: "Run", metadata: {}, time: { start: 0, end: 100 } },
          }],
        },
      ]),
    }));
    const result = await tool.execute({ ...defaultSearchArgs, query: "hiddenOutput", include_tool_output: false } as never, defaultCtx);
    expect(result).toBe("No matches found.");
  });

  it("shows hint when cap hit (200+ sessions)", async () => {
    const manySessions = Array.from({ length: 250 }, (_, i) =>
      makeSession({ id: `ses_${i}`, title: `Session ${i}`, created: i * 1000 }),
    );
    const tool = createSessionSearchTool(mockClient({
      sessionList: () => Promise.resolve(manySessions),
      sessionMessages: () => Promise.resolve([
        {
          info: { id: "msg_1", sessionID: "ses_1", role: "user" as const, time: { created: 0 } },
          parts: [{ id: "p1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "hit" }],
        },
      ]),
    }));
    const result = (await tool.execute({ ...defaultSearchArgs, query: "hit" } as never, defaultCtx)) as string;
    expect(result).toContain("searched first 200 sessions only");
  });
});
