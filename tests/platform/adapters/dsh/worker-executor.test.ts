import { Context, Service } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { loadDshWorkerExecutorFactory, type DshWorkerExecutorFactory } from "../../../../src/platform/adapters/dsh/worker-executor.ts";

class ExecutorLoader extends Service {
  readonly imports: string[] = [];
  constructor(ctx: Context, private readonly fail = false) { super(ctx, "loader"); }
  async import(name: string) {
    Reflect.get(this.ctx, "loader");
    this.imports.push(name);
    if (this.fail) throw new Error("Executor import fixture failed");
    return name.endsWith("native") ? { NativeToolExecutor: class {
      describe() { return { schemas: [] }; }
      async execute() { return {}; }
    } } : { ToolExecutionPipeline: class {} };
  }
}

describe("DSH worker executor loading", () => {
  it("loads through an injected child of a plugin that does not require Loader", async () => {
    const ctx = new Context();
    const loader = new ExecutorLoader(ctx);
    let factory: DshWorkerExecutorFactory | undefined;
    try {
      const fiber = ctx.plugin({ async apply(owner: Context) {
        factory = await loadDshWorkerExecutorFactory(owner);
      } });
      await fiber.await();
      expect(factory).toBeTypeOf("function");
      expect(loader.imports).toEqual(["@deepseek-ai/dsh-tool-executor-native", "@deepseek-ai/dsh-tools/pipeline"]);
    } finally { await ctx.fiber.dispose(); }
  });

  it("propagates a loader import rejection through plugin activation", async () => {
    const ctx = new Context();
    new ExecutorLoader(ctx, true);
    try {
      const fiber = ctx.plugin({ async apply(owner: Context) {
        await loadDshWorkerExecutorFactory(owner);
      } });
      await expect(fiber.await()).rejects.toThrow("Executor import fixture failed");
    } finally { await ctx.fiber.dispose(); }
  });

  it("refuses a modern host without the plugin loader", async () => {
    await expect(loadDshWorkerExecutorFactory({ get: () => undefined })).rejects.toThrow("plugin loader");
  });
});
