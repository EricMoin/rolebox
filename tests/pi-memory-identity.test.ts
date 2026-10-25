import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory/store.ts";
import { PiLightweightServiceStack } from "../src/platform/adapters/pi/service-stack.ts";
import { PiToolFactory } from "../src/platform/adapters/pi/tool-factory.ts";
import { defineTool } from "../src/platform/ports/tool-factory.ts";

interface CompiledTool {
  name: string;
  execute(callId: string, args: Record<string, unknown>, signal: AbortSignal, update: () => void, context: Record<string, unknown>): Promise<{ content: Array<{ type: string; text?: string }> }>;
}

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "rolebox-pi-memory-identity-")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

async function invoke(tool: CompiledTool, args: Record<string, unknown>, agent?: string): Promise<string> {
  const context = { cwd: directory, sessionManager: { getSessionId: () => "session-a" }, ...(agent === undefined ? {} : { agent }) };
  const result = await tool.execute("call", args, new AbortController().signal, () => {}, context);
  return result.content.map(block => block.text ?? "").join("\n");
}

describe("Pi memory role identity", () => {
  it("uses the active role for real tools when the Pi context has no agent", async () => {
    const tools = new Map<string, CompiledTool>();
    let activeRole = "role-a";
    const stack = new PiLightweightServiceStack(
      { registerTool: (tool: CompiledTool) => tools.set(tool.name, tool), on() {} }, [],
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, directory,
      undefined, undefined, () => activeRole,
    );
    await stack.init();
    const writeResult = await invoke(tools.get("memory_write")!, {
      title: "Remembered decision", content: "Verified project decision", scope: "role", category: "decision",
    });
    expect(writeResult).toStartWith("Memory written. ID: ");
    const id = writeResult.slice("Memory written. ID: ".length);
    expect(await invoke(tools.get("memory_read")!, { id })).toContain("Verified project decision");
    expect(await invoke(tools.get("memory_list")!, {})).toContain("Remembered decision");
    expect(await invoke(tools.get("memory_recall")!, { query: "Verified" })).toContain("Remembered decision");
    expect(await invoke(tools.get("memory_update")!, { id, content: "Updated project decision" })).toContain("updated");

    activeRole = "role-b";
    expect(await invoke(tools.get("memory_read")!, { id })).not.toContain("Updated project decision");
    expect(await invoke(tools.get("memory_list")!, {})).not.toContain("Remembered decision");
    expect(await invoke(tools.get("memory_read")!, { id }, "role-a")).toContain("Updated project decision");
    const store = await MemoryStore.create(directory);
    try {
      expect(store.read(id)?.role_id).toBe("role-a");
      expect(store.read(id)?.source_sessions).toEqual(["session-a"]);
    } finally {
      store.close();
    }
  });

  it("limits fallback to memory tools and context_assemble and preserves explicit identities", async () => {
    const seenSessions: string[] = [];
    const factory = new PiToolFactory(undefined, (sessionID) => { seenSessions.push(sessionID); return "active-role"; });
    const echo = defineTool({ description: "Report the acting role", args: {}, async execute(_input, context) { return context.agent ?? ""; } });
    const compiled = factory.compileAll({ memory_read: echo, context_assemble: echo, unrelated: echo }) as Record<string, CompiledTool>;
    expect(await invoke(compiled.memory_read, { id: "entry" }, "bound-worker")).toBe("bound-worker");
    expect(await invoke(compiled.context_assemble, { topic: "decision" })).toBe("active-role");
    expect(await invoke(compiled.unrelated, {})).toBe("");
    expect(seenSessions).toEqual(["session-a"]);
  });

  it("does not fabricate a role when no role is active", async () => {
    const tools = new Map<string, CompiledTool>();
    const stack = new PiLightweightServiceStack(
      { registerTool: (tool: CompiledTool) => tools.set(tool.name, tool), on() {} }, [],
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, directory,
      undefined, undefined, () => null,
    );
    await stack.init();
    expect(await invoke(tools.get("memory_write")!, {
      title: "No owner", content: "No role is active", scope: "role", category: "fact",
    })).toContain("Cannot write role-scoped memory");
  });
});
