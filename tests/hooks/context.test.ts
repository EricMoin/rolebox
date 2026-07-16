import { describe, it, expect, mock } from "bun:test";
import { appendCorrection, collectAllFunctions, fetchLastAssistantText } from "../../src/hooks/context.ts";
import type { ISessionClient } from "../../src/platform/ports/session-client.ts";
import type { ResolvedFunction } from "../../src/types.ts";

// ── appendCorrection ─────────────────────────────────────────────────────────

describe("appendCorrection", () => {
  it("creates a new entry for an unknown sessionID", () => {
    const corrections = new Map<string, string>();
    appendCorrection(corrections, "sess-1", "first correction");
    expect(corrections.get("sess-1")).toBe("first correction");
  });

  it("appends to an existing entry with a newline separator", () => {
    const corrections = new Map<string, string>();
    corrections.set("sess-1", "first correction");
    appendCorrection(corrections, "sess-1", "second correction");
    expect(corrections.get("sess-1")).toBe("first correction\nsecond correction");
  });

  it("handles multiple sessions independently", () => {
    const corrections = new Map<string, string>();
    appendCorrection(corrections, "sess-a", "for A");
    appendCorrection(corrections, "sess-b", "for B");
    appendCorrection(corrections, "sess-a", "also for A");
    expect(corrections.get("sess-a")).toBe("for A\nalso for A");
    expect(corrections.get("sess-b")).toBe("for B");
  });

  it("handles empty text gracefully", () => {
    const corrections = new Map<string, string>();
    appendCorrection(corrections, "sess-1", "first");
    expect(corrections.get("sess-1")).toBe("first");
    appendCorrection(corrections, "sess-1", "");
    // Empty string still appends with newline when existing is truthy
    expect(corrections.get("sess-1")).toBe("first\n");
  });
});

// ── collectAllFunctions ──────────────────────────────────────────────────────

describe("collectAllFunctions", () => {
  it("returns an empty array for an empty map", () => {
    const map = new Map<string, ResolvedFunction[]>();
    expect(collectAllFunctions(map)).toEqual([]);
  });

  it("collects functions from all roles in the map", () => {
    const fn1 = { name: "fn1" } as ResolvedFunction;
    const fn2 = { name: "fn2" } as ResolvedFunction;
    const fn3 = { name: "fn3" } as ResolvedFunction;

    const map = new Map<string, ResolvedFunction[]>([
      ["role-a", [fn1]],
      ["role-b", [fn2, fn3]],
    ]);

    const result = collectAllFunctions(map);
    expect(result).toHaveLength(3);
    expect(result).toContain(fn1);
    expect(result).toContain(fn2);
    expect(result).toContain(fn3);
  });

  it("handles roles with empty function arrays", () => {
    const fn1 = { name: "fn1" } as ResolvedFunction;
    const map = new Map<string, ResolvedFunction[]>([
      ["role-a", []],
      ["role-b", [fn1]],
    ]);
    expect(collectAllFunctions(map)).toHaveLength(1);
  });

  it("preserves function order within each role", () => {
    const fns = [
      { name: "a" } as ResolvedFunction,
      { name: "b" } as ResolvedFunction,
      { name: "c" } as ResolvedFunction,
    ];
    const map = new Map([["role", fns]]);
    const result = collectAllFunctions(map);
    expect(result[0].name).toBe("a");
    expect(result[1].name).toBe("b");
    expect(result[2].name).toBe("c");
  });
});

// ── fetchLastAssistantText ───────────────────────────────────────────────────

describe("fetchLastAssistantText", () => {
  it("returns null when messages returns an empty array", async () => {
    const client: ISessionClient = {
      messages: mock(() => Promise.resolve([])),
    } as unknown as ISessionClient;
    const result = await fetchLastAssistantText(client, "sess-1");
    expect(result).toBeNull();
  });

  it("returns the text from the last assistant message", async () => {
    const client: ISessionClient = {
      messages: mock(() =>
        Promise.resolve([
          { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
          { info: { role: "assistant" }, parts: [{ type: "text", text: "I am an assistant" }] },
        ]),
      ),
    } as unknown as ISessionClient;
    const result = await fetchLastAssistantText(client, "sess-1");
    expect(result).toBe("I am an assistant");
  });

  it("skips user messages and finds the latest assistant message", async () => {
    const client: ISessionClient = {
      messages: mock(() =>
        Promise.resolve([
          { info: { role: "assistant" }, parts: [{ type: "text", text: "first reply" }] },
          { info: { role: "user" }, parts: [{ type: "text", text: "follow up" }] },
        ]),
      ),
    } as unknown as ISessionClient;
    const result = await fetchLastAssistantText(client, "sess-1");
    expect(result).toBe("first reply");
  });

  it("merges multiple text parts in the last assistant message", async () => {
    const client: ISessionClient = {
      messages: mock(() =>
        Promise.resolve([
          {
            info: { role: "assistant" },
            parts: [
              { type: "text", text: "Part A " },
              { type: "tool_use", name: "bash" },
              { type: "text", text: "Part B" },
            ],
          },
        ]),
      ),
    } as unknown as ISessionClient;
    const result = await fetchLastAssistantText(client, "sess-1");
    expect(result).toBe("Part A Part B");
  });

  it("returns null when no assistant messages exist", async () => {
    const client: ISessionClient = {
      messages: mock(() =>
        Promise.resolve([
          { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
          { info: { role: "user" }, parts: [{ type: "text", text: "again" }] },
        ]),
      ),
    } as unknown as ISessionClient;
    const result = await fetchLastAssistantText(client, "sess-1");
    expect(result).toBeNull();
  });

  it("returns null when messages promise rejects", async () => {
    const client: ISessionClient = {
      messages: mock(() => Promise.reject(new Error("network error"))),
    } as unknown as ISessionClient;
    const result = await fetchLastAssistantText(client, "sess-1");
    expect(result).toBeNull();
  });

  it("returns null when messages returns null", async () => {
    const client: ISessionClient = {
      messages: mock(() => Promise.resolve(null)),
    } as unknown as ISessionClient;
    const result = await fetchLastAssistantText(client, "sess-1");
    expect(result).toBeNull();
  });
});
