import { describe, it, expect, afterEach } from "bun:test";
import {
  createInteractiveTerminalTool,
  decodeKeystrokeEscapes,
} from "../src/terminal/interactive-terminal-tool";
import { __resetForTests } from "../src/terminal/session-registry";
import { TerminalScreen } from "../src/terminal/screen-buffer";
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

    const read = await tool.execute(
      { action: "read", id, wait_ms: 200, strip_ansi: false },
      c,
    );
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

  it("sends named keys via `keys` and `<...>` tokens in data", async () => {
    const tool = createInteractiveTerminalTool();
    const c = ctx();
    const opened = await tool.execute({ action: "open", command: "cat", backend: "pipe" }, c);
    const { id } = JSON.parse(textOf(opened)) as { id: string };

    // <tab> in data + keys ["ctrl+a"] with no auto newline (keys present).
    const wrote = await tool.execute(
      { action: "write", id, data: "X<tab>Y", keys: ["ctrl+a"] },
      c,
    );
    expect(textOf(wrote)).toContain("wrote 4 char(s)"); // X \t Y \x01

    const read = await tool.execute(
      { action: "read", id, until: "X\tY", timeout_ms: 4000, strip_ansi: false },
      c,
    );
    expect(textOf(read)).toContain("X\tY\u0001");
    await tool.execute({ action: "close", id }, c);
  });

  it("rejects unknown key names", async () => {
    const tool = createInteractiveTerminalTool();
    const c = ctx();
    const opened = await tool.execute({ action: "open", command: "cat", backend: "pipe" }, c);
    const { id } = JSON.parse(textOf(opened)) as { id: string };
    await expect(
      tool.execute({ action: "write", id, keys: ["bogus-key"] }, c),
    ).rejects.toThrow(/Unknown key/);
    await tool.execute({ action: "close", id }, c);
  });

  it("reports until-timeout honestly instead of returning silently", async () => {
    const tool = createInteractiveTerminalTool();
    const c = ctx();
    const opened = await tool.execute({ action: "open", command: "cat", backend: "pipe" }, c);
    const { id } = JSON.parse(textOf(opened)) as { id: string };

    const read = (await tool.execute(
      { action: "read", id, until: "WILL_NEVER_MATCH", timeout_ms: 1200 },
      c,
    )) as { output: string; metadata: Record<string, unknown> };
    expect(read.output).toContain("TIMEOUT");
    expect(read.metadata.matched).toBe(false);
    expect(read.metadata.timedOut).toBe(true);
    await tool.execute({ action: "close", id }, c);
  });

  it("fails open fast with a clear error for a nonexistent command", async () => {
    const tool = createInteractiveTerminalTool();
    const c = ctx();
    await expect(
      tool.execute(
        { action: "open", command: "definitely-not-a-real-cmd-xyz", backend: "pipe" },
        c,
      ),
    ).rejects.toThrow(/Failed to start/);
    // No zombie session must remain registered.
    const listed = JSON.parse(textOf(await tool.execute({ action: "list" }, c))) as unknown[];
    expect(listed.length).toBe(0);
  });

  it("surfaces process exit in read output", async () => {
    const tool = createInteractiveTerminalTool();
    const c = ctx();
    const opened = await tool.execute(
      { action: "open", command: "echo done", shell: true, backend: "pipe" },
      c,
    );
    const { id } = JSON.parse(textOf(opened)) as { id: string };
    const read = (await tool.execute(
      { action: "read", id, from_start: true, wait_ms: 100, timeout_ms: 3000 },
      c,
    )) as { output: string; metadata: Record<string, unknown> };
    expect(read.output).toContain("done");
    expect(read.metadata.alive).toBe(false);
    await tool.execute({ action: "close", id }, c);
  });

  it("honors a caller-requested session id", async () => {
    const tool = createInteractiveTerminalTool();
    const c = ctx();
    const opened = await tool.execute(
      { action: "open", command: "cat", backend: "pipe", id: "my-repl" },
      c,
    );
    const { id } = JSON.parse(textOf(opened)) as { id: string };
    expect(id).toBe("my-repl");
    await tool.execute({ action: "close", id }, c);
  });

  it("emulates Ctrl-D as EOF on the pipe backend", async () => {
    const tool = createInteractiveTerminalTool();
    const c = ctx();
    const opened = await tool.execute({ action: "open", command: "cat", backend: "pipe" }, c);
    const { id } = JSON.parse(textOf(opened)) as { id: string };

    await tool.execute({ action: "write", id, data: "bye" }, c);
    await tool.execute({ action: "write", id, keys: ["ctrl+d"] }, c);
    const read = (await tool.execute(
      { action: "read", id, until: "process exited", timeout_ms: 5000, from_start: true },
      c,
    )) as { output: string; metadata: Record<string, unknown> };
    expect(read.output).toContain("bye");
    expect(read.metadata.alive).toBe(false);
    await tool.execute({ action: "close", id }, c);
  });

  it("rejects screen mode on the pipe backend with a clear error", async () => {
    const tool = createInteractiveTerminalTool();
    const c = ctx();
    const opened = await tool.execute({ action: "open", command: "cat", backend: "pipe" }, c);
    const { id } = JSON.parse(textOf(opened)) as { id: string };
    await expect(
      tool.execute({ action: "read", id, mode: "screen" }, c),
    ).rejects.toThrow(/pipe backend/);
    await tool.execute({ action: "close", id }, c);
  });
});

describe("decodeKeystrokeEscapes", () => {
  it("decodes hex, C-style, and named-key escapes", () => {
    expect(decodeKeystrokeEscapes("\\u000d")).toBe("\r");
    expect(decodeKeystrokeEscapes("\\x1b")).toBe("\u001b");
    expect(decodeKeystrokeEscapes("\\r\\n\\t\\e")).toBe("\r\n\t\u001b");
    expect(decodeKeystrokeEscapes("a<enter>b")).toBe("a\rb");
    expect(decodeKeystrokeEscapes("<ctrl+c>")).toBe("\u0003");
    expect(decodeKeystrokeEscapes("<up><down>")).toBe("\u001b[A\u001b[B");
    expect(decodeKeystrokeEscapes("<alt+x>")).toBe("\u001bx");
  });

  it("passes through text that is not a well-formed escape", () => {
    expect(decodeKeystrokeEscapes("a < b > c")).toBe("a < b > c");
    expect(decodeKeystrokeEscapes("<notakey>")).toBe("<notakey>");
    expect(decodeKeystrokeEscapes("C:\\path\\uxx")).toBe("C:\\path\\uxx");
    expect(decodeKeystrokeEscapes("x < y")).toBe("x < y");
  });
});

describe("TerminalScreen (VT100 emulator)", () => {
  it("renders plain text with line feeds", () => {
    const s = new TerminalScreen({ cols: 20, rows: 5 });
    s.feed("hello\r\nworld");
    expect(s.snapshot()).toBe("hello\nworld");
  });

  it("handles cursor addressing and in-place repaints", () => {
    const s = new TerminalScreen({ cols: 20, rows: 5 });
    s.feed("AAAA");
    s.feed("\u001b[1;1H"); // home
    s.feed("BB");
    expect(s.snapshot()).toBe("BBAA");
  });

  it("handles erase display and erase line", () => {
    const s = new TerminalScreen({ cols: 10, rows: 3 });
    s.feed("111\r\n222\r\n333");
    s.feed("\u001b[2;1H\u001b[K"); // clear line 2
    expect(s.snapshot()).toBe("111\n\n333");
    s.feed("\u001b[2J");
    expect(s.snapshot()).toBe("");
  });

  it("supports the alternate screen (TUI enter/leave)", () => {
    const s = new TerminalScreen({ cols: 20, rows: 4 });
    s.feed("shell prompt");
    s.feed("\u001b[?1049h"); // enter alt screen
    expect(s.altActive).toBe(true);
    s.feed("TUI CONTENT");
    expect(s.snapshot()).toContain("TUI CONTENT");
    expect(s.snapshot()).not.toContain("shell prompt");
    s.feed("\u001b[?1049l"); // leave
    expect(s.altActive).toBe(false);
    expect(s.snapshot()).toContain("shell prompt");
  });

  it("scrolls when writing past the last row", () => {
    const s = new TerminalScreen({ cols: 10, rows: 3 });
    s.feed("1\r\n2\r\n3\r\n4");
    expect(s.snapshot()).toBe("2\n3\n4");
  });

  it("renders wide (CJK) characters with correct width", () => {
    const s = new TerminalScreen({ cols: 10, rows: 2 });
    s.feed("你好ab");
    expect(s.snapshot()).toBe("你好ab");
  });

  it("answers cursor-position queries (DSR 6)", () => {
    const replies: string[] = [];
    const s = new TerminalScreen({ cols: 20, rows: 5, respond: (d) => replies.push(d) });
    s.feed("ab\u001b[6n");
    expect(replies).toEqual(["\u001b[1;3R"]);
  });

  it("skips OSC title sequences without corrupting output", () => {
    const s = new TerminalScreen({ cols: 20, rows: 2 });
    s.feed("\u001b]0;window title\u0007visible");
    expect(s.snapshot()).toBe("visible");
  });

  it("survives sequences split across feed() chunks", () => {
    const s = new TerminalScreen({ cols: 20, rows: 3 });
    s.feed("AB\u001b[");
    s.feed("1;1");
    s.feed("HZ");
    expect(s.snapshot()).toBe("ZB");
  });

  it("counts paint operations for TUI detection", () => {
    const s = new TerminalScreen({ cols: 20, rows: 5 });
    expect(s.paintOps).toBe(0);
    for (let i = 0; i < 5; i++) s.feed("\u001b[1;1H\u001b[2J");
    expect(s.paintOps).toBeGreaterThanOrEqual(10);
  });

  it("resize preserves content within the new bounds", () => {
    const s = new TerminalScreen({ cols: 10, rows: 4 });
    s.feed("abcdef");
    s.resize(4, 2);
    expect(s.cols).toBe(4);
    expect(s.snapshot()).toBe("abcd");
    s.resize(12, 5);
    s.feed("\u001b[2;1Hxyz");
    expect(s.snapshot()).toBe("abcd\nxyz");
  });
});
