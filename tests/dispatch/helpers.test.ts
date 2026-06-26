import { describe, it, expect } from "bun:test";
import { makeTask, createMockClient, parentContext } from "./helpers";

describe("makeTask", () => {
  it("returns default values", () => {
    const task = makeTask();
    expect(task.id).toBe("bg_test123");
    expect(task.status).toBe("pending");
    expect(task.agent).toBe("test-agent");
    expect(task.sessionId).toBe("ses_abc");
    expect(task.parentSessionId).toBe("ses_parent");
    expect(task.prompt).toBe("do something");
    expect(task.startedAt).toBeInstanceOf(Date);
    expect(task.progress).toEqual({
      lastUpdate: expect.any(Date),
      toolCalls: 0,
    });
  });

  it("accepts partial overrides", () => {
    const task = makeTask({ status: "completed", agent: "specialist" });
    expect(task.status).toBe("completed");
    expect(task.agent).toBe("specialist");
    expect(task.id).toBe("bg_test123");
    expect(task.prompt).toBe("do something");
  });
});

describe("createMockClient", () => {
  it("returns a client with default mocked session.create", async () => {
    const client = createMockClient();
    const result = await client.session.create({} as any);
    expect(result).toEqual({
      data: { id: "test-session-1" },
      error: undefined,
    });
  });

  it("accepts overrides for session methods", async () => {
    const client = createMockClient({
      sessionCreate: () =>
        Promise.resolve({ data: { id: "custom-id" }, error: undefined }),
    });
    const result = await client.session.create({} as any);
    expect(result).toEqual({
      data: { id: "custom-id" },
      error: undefined,
    });
  });
});

describe("parentContext", () => {
  it("returns default parent context", () => {
    const ctx = parentContext();
    expect(ctx).toEqual({
      sessionID: "parent-session-1",
      agent: "parent-agent",
      directory: "/tmp/test",
    });
  });

  it("accepts overrides", () => {
    const ctx = parentContext({ sessionID: "custom-parent" });
    expect(ctx.sessionID).toBe("custom-parent");
    expect(ctx.agent).toBe("parent-agent");
  });
});
