/**
 * Pi tool-factory sessionID extraction regression test.
 *
 * Verifies that `PiToolFactory` resolves a STABLE session id from Pi's
 * tool-execute context.
 *
 * Pi's extension context (`ctx` passed to tool `execute`) does NOT expose a
 * direct `sessionID`/`sessionId` field — it carries `sessionManager` whose
 * `sessionId` is stable for the whole session. The previous implementation
 * fell back to `toolCallId` (unique per invocation), which broke owner-scoped
 * state across tool calls — e.g. `interactive_terminal` open→write failed
 * with "Terminal session ... is not owned by this session".
 *
 * @module
 */

import { describe, it, expect, afterEach } from "bun:test";
import { z } from "zod";
import { PiToolFactory } from "../src/platform/adapters/pi/tool-factory.ts";
import { defineTool } from "../src/platform/ports/tool-factory.ts";

function makeEchoTool() {
  return defineTool({
    description: "echo the sessionID back",
    args: { note: z.string().optional() },
    async execute(input, context) {
      return `sessionID=${context.sessionID}`;
    },
  });
}

async function invoke(
  factory: PiToolFactory,
  tool: ReturnType<typeof makeEchoTool>,
  ctx: Record<string, unknown>,
  toolCallId: string,
): Promise<string> {
  const compiled = factory.compileAll({ echo: tool })["echo"] as {
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (msg: string) => void,
      ctx: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
  };
  const res = await compiled.execute(toolCallId, {}, new AbortController().signal, () => {}, ctx);
  return res.content[0]!.text;
}

describe("PiToolFactory sessionID extraction", () => {
  afterEach(() => {});

  it("uses ctx.sessionManager.sessionId — stable across calls with different toolCallIds", async () => {
    const factory = new PiToolFactory();
    const tool = makeEchoTool();
    const ctx = { sessionManager: { getSessionId: () => "stable-session-42" } };

    const first = await invoke(factory, tool, ctx, "call-AAA");
    const second = await invoke(factory, tool, ctx, "call-BBB");
    expect(first).toBe("sessionID=stable-session-42");
    expect(second).toBe("sessionID=stable-session-42");
  });

  it("falls back to the sessionId property when getSessionId is absent", async () => {
    const factory = new PiToolFactory();
    const tool = makeEchoTool();
    const ctx = { sessionManager: { sessionId: "prop-session-7" } };
    const out = await invoke(factory, tool, ctx, "call-X");
    expect(out).toBe("sessionID=prop-session-7");
  });

  it("prefers an explicit sessionID field over sessionManager", async () => {
    const factory = new PiToolFactory();
    const tool = makeEchoTool();
    const ctx = {
      sessionID: "explicit-1",
      sessionManager: { sessionId: "sm-2" },
    };
    const out = await invoke(factory, tool, ctx, "call-1");
    expect(out).toBe("sessionID=explicit-1");
  });

  it("falls back to toolCallId only when no stable id is available", async () => {
    const factory = new PiToolFactory();
    const tool = makeEchoTool();
    const out = await invoke(factory, tool, {}, "fallback-call");
    expect(out).toBe("sessionID=fallback-call");
  });
});
