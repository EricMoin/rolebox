import { describe, it, expect } from "bun:test";
import { SessionClientWrapper } from "../../src/session/client.ts";
import { OpencodeSessionAdapter } from "../../src/platform/adapters/opencode/session.ts";
import { createMockClient } from "../dispatch/helpers.ts";

describe("SessionClientWrapper", () => {
  it("is an alias for OpencodeSessionAdapter", () => {
    expect(SessionClientWrapper).toBe(OpencodeSessionAdapter);
  });
});

describe("ISessionClient interface (via mock)", () => {
  it("create — returns a new session", async () => {
    const client = createMockClient();
    const result = await client.create({ directory: "/tmp", agent: "test" });
    expect(result).toEqual({ id: "test-session-1" });
  });

  it("create — accepts parentID", async () => {
    const client = createMockClient({
      sessionCreate: () => Promise.resolve({ id: "child-session" }),
    });
    const result = await client.create({ directory: "/tmp", parentID: "parent_1" });
    expect(result).toEqual({ id: "child-session" });
  });

  it("get — retrieves a session by ID", async () => {
    const client = createMockClient();
    const result = await client.get("ses_1", "/tmp");
    expect(result).toEqual({ id: "test-session-1" });
  });

  it("get — returns null when session not found", async () => {
    const client = createMockClient({
      sessionGet: () => Promise.resolve(null),
    });
    const result = await client.get("nonexistent", "/tmp");
    expect(result).toBeNull();
  });

  it("list — returns sessions", async () => {
    const client = createMockClient({
      sessionList: () => Promise.resolve([
        { id: "ses_1", projectID: "p1", directory: "/tmp", title: "S1", version: "1", time: { created: 0, updated: 0 } },
      ]),
    });
    const result = await client.list("/tmp");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("ses_1");
  });

  it("list — returns empty array when no sessions", async () => {
    const client = createMockClient({
      sessionList: () => Promise.resolve([]),
    });
    const result = await client.list("/tmp");
    expect(result).toEqual([]);
  });

  it("abort — acknowledges abort and returns true", async () => {
    const client = createMockClient();
    const result = await client.abort("ses_1");
    expect(result).toBe(true);
  });

  it("abort — returns false on failure", async () => {
    const client = createMockClient({
      sessionAbort: () => Promise.resolve(false),
    });
    const result = await client.abort("ses_fail");
    expect(result).toBe(false);
  });

  describe("prompt distribution", () => {
    it("prompt — returns prompt result ID", async () => {
      const client = createMockClient({
        sessionPromptAsync: () => Promise.resolve({ id: "prompt_1" }),
      });
      const result = await client.prompt("ses_1", {
        parts: [{ type: "text", text: "Hello" }],
      });
      expect(result).toEqual({ id: "prompt_1" });
    });

    it("prompt — sends parts and options", async () => {
      const captured: unknown[] = [];
      const client = createMockClient({
        sessionPromptAsync: (sdkCall: unknown) => {
          captured.push(sdkCall);
          return Promise.resolve({ id: "prompt_1" });
        },
      });
      const client2 = client as unknown as {
        prompt: (id: string, opts: { parts: Array<{ type: string; text: string }>; agent?: string }) => Promise<unknown>;
      };
      await client2.prompt("ses_1", {
        parts: [{ type: "text", text: "Please work" }],
        agent: "worker",
      });
      // The mock adapter wraps the call — verify the arguments were forwarded
      expect(captured.length).toBe(1);
    });

    it("promptSync — returns response parts", async () => {
      const client = createMockClient({
        sessionPrompt: () => Promise.resolve({
          parts: [{ type: "text" as const, text: "Response" }],
        }),
      });
      const result = await client.promptSync("ses_1", {
        parts: [{ type: "text", text: "Do something" }],
      });
      expect(result).toEqual({
        parts: [{ type: "text", text: "Response" }],
      });
    });

    it("promptSync — returns null on failure", async () => {
      const client = createMockClient({
        sessionPrompt: () => Promise.resolve(null),
      });
      const result = await client.promptSync("ses_1", {
        parts: [{ type: "text", text: "Fail" }],
      });
      expect(result).toBeNull();
    });
  });

  describe("session data retrieval", () => {
    it("messages — returns messages for a session", async () => {
      const client = createMockClient({
        sessionMessages: () => Promise.resolve([
          {
            info: { id: "msg_1", sessionID: "ses_1", role: "user" as const, time: { created: 0 } },
            parts: [],
          },
        ]),
      });
      const result = await client.messages("ses_1", { directory: "/tmp" });
      expect(result).toHaveLength(1);
      expect(result[0].info.id).toBe("msg_1");
    });

    it("messages — returns empty array for session with no messages", async () => {
      const client = createMockClient({
        sessionMessages: () => Promise.resolve([]),
      });
      const result = await client.messages("ses_empty", { directory: "/tmp" });
      expect(result).toEqual([]);
    });

    it("children — returns child sessions", async () => {
      const client = createMockClient({
        sessionChildren: () => Promise.resolve([
          { id: "child_1", projectID: "p1", directory: "/tmp", title: "Child", version: "1", time: { created: 0, updated: 0 } },
        ]),
      });
      const result = await client.children("ses_1", "/tmp");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("child_1");
    });

    it("children — returns empty array when no children", async () => {
      const client = createMockClient({
        sessionChildren: () => Promise.resolve([]),
      });
      const result = await client.children("ses_1", "/tmp");
      expect(result).toEqual([]);
    });

    it("todo — returns todo items", async () => {
      const client = createMockClient({
        sessionTodo: () => Promise.resolve([
          { content: "Task", status: "pending", priority: "high", id: "1" },
        ]),
      });
      const result = await client.todo("ses_1", "/tmp");
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("Task");
    });

    it("todo — returns empty array when no todos", async () => {
      const client = createMockClient({
        sessionTodo: () => Promise.resolve([]),
      });
      const result = await client.todo("ses_1", "/tmp");
      expect(result).toEqual([]);
    });

    it("diff — returns file diffs", async () => {
      const client = createMockClient({
        sessionDiff: () => Promise.resolve([
          { file: "src/a.ts", before: "old", after: "new", additions: 1, deletions: 1 },
        ]),
      });
      const result = await client.diff("ses_1", { directory: "/tmp" });
      expect(result).toHaveLength(1);
      expect(result[0].file).toBe("src/a.ts");
    });

    it("diff — returns empty array when no changes", async () => {
      const client = createMockClient({
        sessionDiff: () => Promise.resolve([]),
      });
      const result = await client.diff("ses_1", { directory: "/tmp" });
      expect(result).toEqual([]);
    });

    it("status — returns session status", async () => {
      const client = createMockClient({
        sessionStatus: () => Promise.resolve({ type: "idle" }),
      });
      const result = await client.status("ses_1", "/tmp");
      expect(result).toEqual({ type: "idle" });
    });

    it("status — returns null when not found", async () => {
      const client = createMockClient({
        sessionStatus: () => Promise.resolve(null),
      });
      const result = await client.status("nonexistent", "/tmp");
      expect(result).toBeNull();
    });

    it("fork — creates a fork of a session", async () => {
      const forkedSession = {
        id: "forked_1", projectID: "p1", directory: "/tmp",
        title: "Forked", version: "1",
        time: { created: 2000, updated: 2000 },
      };
      const client = createMockClient({
        sessionFork: () => Promise.resolve(forkedSession),
      });
      const result = await client.fork("ses_1", { directory: "/tmp" });
      expect(result).toEqual(forkedSession);
    });

    it("fork — returns null on failure", async () => {
      const client = createMockClient({
        sessionFork: () => Promise.resolve(null),
      });
      const result = await client.fork("ses_invalid", { directory: "/tmp" });
      expect(result).toBeNull();
    });
  });
});
