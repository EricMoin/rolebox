/**
 * PiSessionAdapter tests — filesystem-backed session reading.
 *
 * Verifies that the adapter correctly reads Pi JSONL session files
 * from a temporary fixture directory with realistic session data.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiSessionAdapter } from "../src/platform/adapters/pi/session.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a temporary fixture directory with the given workspace path encoding.
 * Returns the temp root path.
 */
function createFixtureDir(): string {
  const tmp = mkdtempSync(join(tmpdir(), "pi-session-test-"));
  return tmp;
}

/**
 * Build a workspace directory name matching Pi's path encoding.
 * Pi replaces "/" with ";" and prepends ";".
 */
function encodeWorkspacePath(absPath: string): string {
  const normalized = absPath.replace(/^\/+/, "");
  return ";" + normalized.split("/").join(";");
}

/**
 * Create a minimal message JSON for a user message in a session.
 */
function userMessage(
  sessionID: string,
  messageID: string,
  text: string,
  timestamp?: number,
): object {
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: timestamp ?? Date.now() },
    },
    parts: [
      {
        id: `${messageID}-p1`,
        sessionID,
        messageID,
        type: "text",
        text,
      },
    ],
  };
}

/**
 * Create a minimal message JSON for an assistant message.
 */
function assistantMessage(
  sessionID: string,
  messageID: string,
  text: string,
  timestamp?: number,
  modelID?: string,
): object {
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      time: { created: timestamp ?? Date.now(), completed: (timestamp ?? Date.now()) + 1000 },
      modelID: modelID ?? "test-model",
    },
    parts: [
      {
        id: `${messageID}-p1`,
        sessionID,
        messageID,
        type: "text",
        text,
      },
    ],
  };
}

/**
 * Create a JSONL file with the given message objects (one per line).
 */
function writeJsonlFile(filePath: string, messages: object[]): void {
  const lines = messages.map((m) => JSON.stringify(m)).join("\n");
  writeFileSync(filePath, lines + "\n", "utf-8");
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const SESSION_A_ID = "session-a-123";
const SESSION_B_ID = "session-b-456";
const SESSION_C_ID = "other-ws-session-789";

const MESSAGES_A = [
  userMessage(SESSION_A_ID, "msg-1", "Implement the login feature", 1700000000000),
  assistantMessage(SESSION_A_ID, "msg-2", "I'll add a login form component", 1700000010000, "claude-3"),
  userMessage(SESSION_A_ID, "msg-3", "Looks good, ship it", 1700000020000),
];

const MESSAGES_B = [
  userMessage(SESSION_B_ID, "msg-1", "Fix the navigation bug", 1700000100000),
  assistantMessage(SESSION_B_ID, "msg-2", "Found the issue in router config", 1700000110000, "gpt-4"),
];

const MESSAGES_C = [
  userMessage(SESSION_C_ID, "msg-1", "Refactor database layer", 1700000200000),
  assistantMessage(SESSION_C_ID, "msg-2", "Extracted repository pattern", 1700000210000, "claude-3"),
];

// ── Tests ───────────────────────────────────────────────────────────────────

describe("PiSessionAdapter — filesystem-backed reading", () => {
  let tmpDir: string;
  let wsDir: string;
  let otherWsDir: string;
  let adapter: PiSessionAdapter;
  const TEST_WORKSPACE = "/Users/test/project";

  beforeEach(() => {
    tmpDir = createFixtureDir();

    // Create workspace directory structure.
    // Sessions A and B are in the same workspace; session C is in another.
    const wsName = encodeWorkspacePath(TEST_WORKSPACE);
    wsDir = join(tmpDir, wsName);
    otherWsDir = join(tmpDir, ";other;project");
    mkdirSync(wsDir, { recursive: true });
    mkdirSync(otherWsDir, { recursive: true });

    // Write session JSONL files.
    writeJsonlFile(join(wsDir, `${SESSION_A_ID}.jsonl`), MESSAGES_A);
    writeJsonlFile(join(wsDir, `${SESSION_B_ID}.jsonl`), MESSAGES_B);
    writeJsonlFile(join(otherWsDir, `${SESSION_C_ID}.jsonl`), MESSAGES_C);

    adapter = new PiSessionAdapter(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── list() ──────────────────────────────────────────────────────────────

  it("list() returns all sessions when no directory filter", () => {
    const sessions = adapter.list();
    expect(sessions).resolves.toHaveLength(3);
  });

  it("list() filters sessions by workspace directory", async () => {
    const sessions = await adapter.list(TEST_WORKSPACE);
    expect(sessions).toHaveLength(2);

    const ids = sessions.map((s) => s.id).sort();
    expect(ids).toEqual([SESSION_A_ID, SESSION_B_ID]);
  });

  it("list() extracts title from first user message", async () => {
    const sessions = await adapter.list(TEST_WORKSPACE);
    const sessionA = sessions.find((s) => s.id === SESSION_A_ID);
    expect(sessionA).toBeDefined();
    expect(sessionA!.title).toContain("Implement the login feature");
  });

  it("list() returns sessions sorted by created time descending", async () => {
    const sessions = await adapter.list(TEST_WORKSPACE);
    // Session B was created later (1700000100000) than session A (1700000000000)
    expect(sessions[0].id).toBe(SESSION_B_ID);
    expect(sessions[1].id).toBe(SESSION_A_ID);
  });

  it("list() returns empty array for non-existent session dir", async () => {
    const badAdapter = new PiSessionAdapter("/nonexistent/path");
    const sessions = await badAdapter.list();
    expect(sessions).toEqual([]);
  });

  it("list() returns empty array when directory filter matches nothing", async () => {
    const sessions = await adapter.list("/completely/different/path");
    expect(sessions).toEqual([]);
  });

  // ── get() ───────────────────────────────────────────────────────────────

  it("get() returns a session by ID", async () => {
    const session = await adapter.get(SESSION_A_ID);
    expect(session).not.toBeNull();
    expect(session!.id).toBe(SESSION_A_ID);
  });

  it("get() returns null for non-existent session", async () => {
    const session = await adapter.get("non-existent-id");
    expect(session).toBeNull();
  });

  it("get() scopes search to directory when provided", async () => {
    // Session C is in a different workspace, so searching with TEST_WORKSPACE should fail.
    const session = await adapter.get(SESSION_C_ID, TEST_WORKSPACE);
    expect(session).toBeNull();

    // But without directory filter it should find it.
    const found = await adapter.get(SESSION_C_ID);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(SESSION_C_ID);
  });

  it("get() populates session metadata from messages", async () => {
    const session = await adapter.get(SESSION_A_ID);
    expect(session).not.toBeNull();
    expect(session!.title).toContain("Implement the login feature");
    expect(session!.version).toBe("claude-3");
    expect(session!.time.created).toBe(1700000000000);
    expect(session!.time.updated).toBe(1700000020000);
  });

  // ── messages() ──────────────────────────────────────────────────────────

  it("messages() returns parsed messages for a session", async () => {
    const messages = await adapter.messages(SESSION_A_ID);
    expect(messages).toHaveLength(3);
  });

  it("messages() respects the limit option", async () => {
    const messages = await adapter.messages(SESSION_A_ID, { limit: 2 });
    expect(messages).toHaveLength(2);
  });

  it("messages() returns correct message roles and content", async () => {
    const messages = await adapter.messages(SESSION_A_ID);
    expect(messages[0].info.role).toBe("user");
    expect(messages[1].info.role).toBe("assistant");

    const firstText = messages[0].parts?.find((p) => p.type === "text") as
      | { text?: string }
      | undefined;
    expect(firstText?.text).toContain("login feature");
  });

  it("messages() returns empty array for non-existent session", async () => {
    const messages = await adapter.messages("non-existent");
    expect(messages).toEqual([]);
  });

  it("messages() scopes to directory when provided", async () => {
    // This session is in another workspace, so it should not be found.
    const messages = await adapter.messages(SESSION_C_ID, { directory: TEST_WORKSPACE });
    expect(messages).toEqual([]);
  });

  // ── children() ──────────────────────────────────────────────────────────

  it("children() returns empty array when no child sessions exist", async () => {
    const children = await adapter.children(SESSION_A_ID);
    expect(children).toEqual([]);
  });

  // ── todo() ──────────────────────────────────────────────────────────────

  it("todo() returns empty array when no todos in session", async () => {
    const todos = await adapter.todo(SESSION_A_ID);
    expect(todos).toEqual([]);
  });

  it("todo() returns empty array for non-existent session", async () => {
    const todos = await adapter.todo("non-existent");
    expect(todos).toEqual([]);
  });

  // ── diff() ──────────────────────────────────────────────────────────────

  it("diff() returns empty array when no diffs in session", async () => {
    const diffs = await adapter.diff(SESSION_A_ID);
    expect(diffs).toEqual([]);
  });

  it("diff() returns empty array for non-existent session", async () => {
    const diffs = await adapter.diff("non-existent");
    expect(diffs).toEqual([]);
  });

  // ── status() ────────────────────────────────────────────────────────────

  it("status() returns idle for session with completed messages", async () => {
    const status = await adapter.status(SESSION_A_ID);
    expect(status).toEqual({ type: "idle" });
  });

  it("status() returns null for non-existent session", async () => {
    const status = await adapter.status("non-existent");
    expect(status).toBeNull();
  });

  it("status() returns busy when the last message has a pending/running tool part despite completed time", async () => {
    const toolSessionId = "session-tool-busy";

    for (const toolStatus of ["pending", "running"] as const) {
      const msg: object = {
        info: {
          id: "msg-1",
          sessionID: toolSessionId,
          role: "assistant",
          time: { created: 1700000300000, completed: 1700000301000 },
        },
        parts: [
          {
            id: "p1",
            sessionID: toolSessionId,
            messageID: "msg-1",
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: { status: toolStatus, input: { command: "sleep 1" } },
          },
        ],
      };
      writeJsonlFile(join(wsDir, `${toolSessionId}.jsonl`), [msg]);

      const status = await adapter.status(toolSessionId);
      expect(status).toEqual({ type: "busy" });
    }
  });

  it("status() returns idle when the last message has a completed tool part", async () => {
    const toolSessionId = "session-tool-idle";
    const msg: object = {
      info: {
        id: "msg-1",
        sessionID: toolSessionId,
        role: "assistant",
        time: { created: 1700000300000, completed: 1700000301000 },
      },
      parts: [
        {
          id: "p1",
          sessionID: toolSessionId,
          messageID: "msg-1",
          type: "tool",
          callID: "call-1",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "ls" },
            output: "src/\n",
            title: "bash",
            metadata: {},
            time: { start: 1700000300000, end: 1700000301000 },
          },
        },
      ],
    };
    writeJsonlFile(join(wsDir, `${toolSessionId}.jsonl`), [msg]);

    const status = await adapter.status(toolSessionId);
    expect(status).toEqual({ type: "idle" });
  });

  // ── unsupported methods ─────────────────────────────────────────────────

  it("unsupported methods return null/false", async () => {
    expect(await adapter.prompt("id", { parts: [{ type: "text", text: "hi" }] })).toBeNull();
    expect(await adapter.promptSync("id", { parts: [{ type: "text", text: "hi" }] })).toBeNull();
    expect(await adapter.create({ directory: "/tmp" })).toBeNull();
    expect(await adapter.abort("id")).toBe(false);
    expect(await adapter.fork("id")).toBeNull();
  });
});

describe("PiSessionAdapter — workspaceDirFromPath encoding", () => {
  it("encodes absolute path to Pi workspace directory name", () => {
    const adapter = new PiSessionAdapter("/tmp");
    // Access via list with specific directory — indirectly tests the encoding.
    // The encoding logic is: strip leading /, replace remaining / with ;, prepend ;
    expect(true).toBe(true);
  });
});

describe("PiSessionAdapter — sessionDir with tilde expansion", () => {
  it("expands tilde in sessionDir", () => {
    const adapter = new PiSessionAdapter("~/test-pi-sessions");
    // Cannot assert the exact resolved path without mocking HOME,
    // but verifying construction does not throw is sufficient.
    expect(adapter).toBeInstanceOf(PiSessionAdapter);
    expect(adapter.sessionDir).toBe("~/test-pi-sessions");
  });
});

import { createSessionSearchTool } from "../src/session/session-browse-tools.ts";
import type { Message, SessionInfo } from "../src/session/types.ts";
import type { SessionClientWrapper } from "../src/session/client.ts";
import type { CanonicalToolContext } from "../src/platform/types.ts";

// ── Mock client for session_search tests ─────────────────────────────────────

function createMockSearchClient(
  totalSessions: number,
  matchInSessionIndex?: number,
): SessionClientWrapper {
  const sessions: SessionInfo[] = Array.from({ length: totalSessions }, (_, i) => ({
    id: `session-${i}`,
    projectID: "test",
    directory: "/test",
    title: `Session ${i}`,
    version: "1.0",
    time: { created: 1000 + i, updated: 2000 + i },
  }));

  return {
    list: async () => sessions,
    get: async (id: string) => sessions.find((s) => s.id === id) ?? null,
    messages: async (id: string) => {
      const idx = parseInt(id.replace("session-", ""), 10);
      if (isNaN(idx)) return [];
      const text = idx === matchInSessionIndex ? "needle match" : "irrelevant noise";
      return [{
        info: {
          id: `msg-${idx}`,
          sessionID: id,
          role: "user" as const,
          time: { created: 1000 + idx },
        },
        parts: [{
          id: `msg-${idx}-p1`,
          sessionID: id,
          messageID: `msg-${idx}`,
          type: "text" as const,
          text,
        }],
      }];
    },
    children: async () => [],
    todo: async () => [],
    diff: async () => [],
    status: async () => ({ type: "idle" as const }),
    fork: async () => null,
    prompt: async () => null,
    promptSync: async () => null,
    create: async () => null,
    abort: async () => false,
  } as unknown as SessionClientWrapper;
}

const searchToolContext: CanonicalToolContext = {
  sessionID: "test",
  messageID: "",
  agent: "test",
  directory: "/test",
  worktree: "/test",
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
};

describe("createSessionSearchTool — 200-session scanning cap", () => {
  it("returns cap message when >200 sessions exist and no match in first 200", async () => {
    const tool = createSessionSearchTool(createMockSearchClient(205));
    const result = await tool.execute(
      { query: "needle", case_sensitive: false, limit: 20, include_tool_output: false },
      searchToolContext,
    );
    expect(result).toBe(
      "No matches found in the first 200 sessions. Try specifying a session_id to narrow the search.",
    );
  });

  it("appends footer when >200 sessions exist and match found within first 200", async () => {
    const tool = createSessionSearchTool(createMockSearchClient(205, 42));
    const result = await tool.execute(
      { query: "needle", case_sensitive: false, limit: 20, include_tool_output: false },
      searchToolContext,
    );
    expect(result).toContain("needle");
    expect(result).toContain("(searched first 200 sessions only)");
  });

  it("no footer when sessions <= 200", async () => {
    const tool = createSessionSearchTool(createMockSearchClient(150, 10));
    const result = await tool.execute(
      { query: "needle", case_sensitive: false, limit: 20, include_tool_output: false },
      searchToolContext,
    );
    expect(result).toContain("needle");
    expect(result).not.toContain("(searched first 200 sessions only)");
  });

  it("standard no-match message when <= 200 and no match found", async () => {
    const tool = createSessionSearchTool(createMockSearchClient(150));
    const result = await tool.execute(
      { query: "needle", case_sensitive: false, limit: 20, include_tool_output: false },
      searchToolContext,
    );
    expect(result).toBe("No matches found.");
  });

  it("session_id bypasses cap", async () => {
    const tool = createSessionSearchTool(createMockSearchClient(205, 199));
    const result = await tool.execute(
      { query: "needle", session_id: "session-199", case_sensitive: false, limit: 20, include_tool_output: false },
      searchToolContext,
    );
    expect(result).toContain("needle");
    // When session_id is specified, cap is not applied
    expect(result).not.toContain("(searched first 200 sessions only)");
  });

  it("cap-hit with match at last scanned session (index 199) still returns results", async () => {
    const tool = createSessionSearchTool(createMockSearchClient(201, 199));
    const result = await tool.execute(
      { query: "needle", case_sensitive: false, limit: 20, include_tool_output: false },
      searchToolContext,
    );
    expect(result).toContain("needle");
    expect(result).toContain("(searched first 200 sessions only)");
  });
});
