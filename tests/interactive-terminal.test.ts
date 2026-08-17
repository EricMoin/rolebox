import { describe, it, expect, afterEach } from "bun:test";
import { createInteractiveTerminalTool } from "../src/terminal/interactive-terminal-tool";
import { __resetForTests } from "../src/terminal/session-registry";
import type { CanonicalToolContext } from "../src/platform/types";

function ctx(sessionID = "test-session"): CanonicalToolContext {
  return {
    sessionID,
    messageID: "m1",
    agent: "test",
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  };
}

function textOf(r: unknown): string {
  return typeof r === "string" ? r : (r as { output: string }).output;
}

describe("interactive_terminal tool", () => {
  afterEach(() => __resetForTests());

  it("open → write → read → close round-trip against `cat`", async () => {
    const tool = createInteractiveTerminalTool();
    const c = ctx();

    const opened = await tool.execute({ action: "open", command: "cat", backend: "pipe" }, c);
    const openInfo = JSON.parse(textOf(opened)) as { id: string; backend: string; alive: boolean };
    expect(openInfo.id).toMatch(/^term_/);
    expect(openInfo.alive).toBe(true);

    const wrote = await tool.execute({ action: "write", id: openInfo.id, data: "hello world" }, c);
    expect(textOf(wrote)).toContain("wrote");

    const read = await tool.execute(
      { action: "read", id: openInfo.id, until: "hello", timeout_ms: 4000 },
      c,
    );
    expect(textOf(read)).toContain("hello world");

    const closed = await tool.execute({ action: "close", id: openInfo.id }, c);
    expect(textOf(closed)).toContain("closed");
  });

  it("list reflects open then closed sessions", async () => {
    const tool = createInteractiveTerminalTool();
    const c = ctx();

    const opened = await tool.execute({ action: "open", command: "cat", backend: "pipe" }, c);
    const { id } = JSON.parse(textOf(opened)) as { id: string };

    const listed = JSON.parse(textOf(await tool.execute({ action: "list" }, c))) as unknown[];
    expect(listed.length).toBe(1);

    await tool.execute({ action: "close", id }, c);
    const after = JSON.parse(textOf(await tool.execute({ action: "list" }, c))) as unknown[];
    expect(after.length).toBe(0);
  });

  it("captures output of a shell one-liner", async () => {
    const tool = createInteractiveTerminalTool();
    const c = ctx();

    const opened = await tool.execute(
      { action: "open", command: "printf 'ready\\n'; cat", shell: true, backend: "pipe" },
      c,
    );
    const { id } = JSON.parse(textOf(opened)) as { id: string };

    const read = await tool.execute(
      { action: "read", id, until: "ready", timeout_ms: 4000, from_start: true },
      c,
    );
    expect(textOf(read)).toContain("ready");

    await tool.execute({ action: "close", id }, c);
  });

  it("decodes \\uXXXX keystroke escapes on write (Ctrl-C / ESC)", async () => {
    const tool = createInteractiveTerminalTool();
    const c = ctx();

    const opened = await tool.execute({ action: "open", command: "cat", backend: "pipe" }, c);
    const { id } = JSON.parse(textOf(opened)) as { id: string };

    // \u0003 (Ctrl-C) and \u001b (ESC) must be decoded to real control bytes.
    const wrote = await tool.execute(
      { action: "write", id, data: "A\\u0003B\\u001bC", append_newline: false },
      c,
    );
    expect(textOf(wrote)).toContain("wrote 5 char(s)"); // 5 = A + ^C + B + ESC + C

    const read = await tool.execute({ action: "read", id, wait_ms: 200 }, c);
    const out = textOf(read);
    expect(out).toContain("A");
    expect(out).toContain("\u0003"); // real Ctrl-C byte echoed back by cat
    expect(out).toContain("B");
    expect(out).toContain("\u001b"); // real ESC byte echoed back by cat
    expect(out).toContain("C");

    await tool.execute({ action: "close", id }, c);
  });

  it("enforces owner isolation across sessions", async () => {
    const tool = createInteractiveTerminalTool();
    const owner = ctx("owner-A");
    const opened = await tool.execute({ action: "open", command: "cat", backend: "pipe" }, owner);
    const { id } = JSON.parse(textOf(opened)) as { id: string };

    const intruder = ctx("owner-B");
    await expect(tool.execute({ action: "read", id }, intruder)).rejects.toThrow(/not owned/);

    await tool.execute({ action: "close", id }, owner);
  });

  it("blocks open when the permission gate rejects", async () => {
    const tool = createInteractiveTerminalTool();
    const c = ctx();
    c.ask = async () => {
      throw new Error("denied by policy");
    };
    const res = await tool.execute({ action: "open", command: "cat", backend: "pipe" }, c);
    expect(textOf(res)).toContain("denied");
  });
});
