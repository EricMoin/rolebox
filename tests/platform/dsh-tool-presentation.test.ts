import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { DshToolFactory } from "../../src/platform/adapters/dsh/tool-factory.ts";
import { defineTool } from "../../src/platform/ports/tool-factory.ts";
import { createInteractiveTerminalTool } from "../../src/terminal/interactive-terminal-tool.ts";
import { __resetForTests } from "../../src/terminal/session-registry.ts";

describe("DSH presentation metadata with the installed tool runtime", () => {
  let ctx: Context;
  const cleanups: Array<() => void | Promise<void>> = [];

  beforeEach(async () => {
    ctx = new Context();
    for (const plugin of [SystemPrompt, ToolRuntime]) {
      const fiber = await ctx.plugin(plugin, {});
      cleanups.push(() => fiber.dispose());
    }
  });

  afterEach(async () => {
    __resetForTests();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function register(compiled: unknown) {
    const def = compiled as ToolDefinition;
    cleanups.push(ctx.tools.register(def));
    return def;
  }

  it.each(["interactive_terminal", "web_fetch"])(
    "accepts plain-text %s results without display metadata",
    async name => {
      const compiled = new DshToolFactory().compileAll({
        [name]: defineTool({
          description: "Plain-text result fixture",
          args: {},
          async execute() { return "done"; },
        }),
      });
      const def = register(compiled[name]);

      const result = await ctx.tools.execute({
        name,
        callId: "call-plain" as ToolCallId,
        arguments: {},
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        isError: false,
        value: "done",
        content: [{ type: "text", text: "done" }],
        meta: null,
      });
      expect(def.presentResult!({}, result)).toBeUndefined();
    },
  );

  it("accepts every interactive terminal action and argument corrections", async () => {
    const compiled = new DshToolFactory().compileAll({
      interactive_terminal: createInteractiveTerminalTool(),
    });
    const def = register(compiled.interactive_terminal);

    // Without an agent, the adapter uses callId as the terminal owner.
    const call = (args: Record<string, unknown>) => ctx.tools.execute({
      name: "interactive_terminal",
      callId: "terminal-owner" as ToolCallId,
      arguments: args,
      signal: new AbortController().signal,
    });
    const opened = await call({
      action: "open",
      command: process.execPath,
      args: ["-e", "process.stdin.pipe(process.stdout)"],
      backend: "pipe",
    });
    expect(opened.isError).toBe(false);
    if (opened.isError) throw new Error(opened.error.message);
    const { id } = JSON.parse((opened.value as { output: string }).output) as { id: string };

    const written = await call({ action: "write", id, data: "hello" });
    const read = await call({ action: "read", id, until: "hello", timeout_ms: 4000 });
    const idleRead = await call({ action: "read", id });
    const resized = await call({ action: "resize", id, cols: 100, rows: 30 });
    const listed = await call({ action: "list" });
    const closed = await call({ action: "close", id });
    const correction = await call({});

    for (const result of [opened, written, read, idleRead, resized, listed, closed, correction]) {
      expect(result.isError, JSON.stringify(result.content)).toBe(false);
    }
    expect(opened.meta).toMatchObject({ metadata: { id, backend: "pipe", alive: true } });
    expect(read.meta).toMatchObject({ metadata: { id, matched: true, timedOut: false } });
    expect(read.content).toEqual([{ type: "text", text: expect.stringContaining("hello") }]);
    expect(idleRead.meta).toMatchObject({ metadata: { matched: null, exitCode: null } });
    expect(def.presentResult!({}, read)).toEqual({ card: "generic", title: `terminal ${id} output` });
    for (const result of [written, resized, closed, correction]) expect(result.meta).toBeNull();
    expect(correction.content).toEqual([{ type: "text", text: expect.stringContaining("action") }]);
  });
});
