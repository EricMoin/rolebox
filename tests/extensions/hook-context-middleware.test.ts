import { describe, it, expect } from "bun:test";
import type { HookContext, PromptBlock, DispatchSnapshot } from "../../src/hooks/custom/types.ts";

describe("HookContext Middleware Interface", () => {
  it("HookContext has optional middleware methods", () => {
    const ctx: HookContext = {
      hookName: "test",
      config: undefined,
      inject: () => {},
      log: {} as any,
    };

    expect(ctx.replaceBlock).toBeUndefined();
    expect(ctx.removeBlock).toBeUndefined();
    expect(ctx.getBlocks).toBeUndefined();
    expect(ctx.getFunctionState).toBeUndefined();
    expect(ctx.getDispatchState).toBeUndefined();
    // HookContext declares no getGraphState and nothing under src/ provides or
    // reads one (src/hooks/custom/registry.ts:enrichContext sets exactly
    // getFunctionState, getDispatchState and getBlocks), so the member is
    // asserted absent through `in` rather than read off the type.
    expect("getGraphState" in ctx).toBe(false);
    expect(ctx.skip).toBeUndefined();
    expect(ctx.retry).toBeUndefined();
  });

  it("PromptBlock type has tag and content fields", () => {
    const block: PromptBlock = { tag: "available_skills", content: "<available_skills>...</available_skills>" };
    expect(block.tag).toBe("available_skills");
    expect(block.content).toContain("available_skills");
  });

  it("DispatchSnapshot type has activeTaskCount and tasks", () => {
    const snapshot: DispatchSnapshot = {
      activeTaskCount: 2,
      tasks: [
        { id: "task1", status: "running", subagent: "worker-1" },
      ],
    };
    expect(snapshot.activeTaskCount).toBe(2);
    expect(snapshot.tasks.length).toBe(1);
    expect(snapshot.tasks[0].subagent).toBe("worker-1");
  });

  it("HookContext can be enriched with middleware methods", () => {
    const ctx: HookContext = {
      hookName: "test",
      config: undefined,
      inject: () => {},
      log: {} as any,
      skip: () => {},
      retry: () => {},
      getBlocks: () => [],
      replaceBlock: () => {},
      removeBlock: () => {},
      getFunctionState: () => undefined,
      getDispatchState: () => undefined,
    };

    expect(typeof ctx.skip).toBe("function");
    expect(typeof ctx.retry).toBe("function");
    expect(typeof ctx.getBlocks).toBe("function");
    expect(typeof ctx.replaceBlock).toBe("function");
    expect(typeof ctx.removeBlock).toBe("function");
  });
});
