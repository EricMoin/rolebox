import type { DshGraphWorkerRegistry, DshWorkerAgent, DshWorkerToolSchema } from "./graph-worker.ts";
import type { DshToolDefinition } from "./tool-factory.ts";

export type DshWorkerToolExecution = Parameters<NonNullable<DshGraphWorkerRegistry["execute"]>>[0];

export interface DshWorkerToolExecutor {
  describe(tools: readonly DshToolDefinition[]): { schemas: readonly DshWorkerToolSchema[]; knownNames?: readonly string[] };
  execute(input: unknown): Promise<unknown>;
}

export type DshWorkerExecutorFactory = (agent: DshWorkerAgent) => {
  executor: DshWorkerToolExecutor;
  invoke(execution: DshWorkerToolExecution): Promise<unknown>;
};

interface PipelineOutcome { kind: "post-result" | "final-result"; result: unknown }
interface WorkerPipeline {
  prepare(input: DshWorkerToolExecution): Promise<{ exec: unknown } & ({ kind: "dispatch" } | PipelineOutcome)>;
  dispatch(exec: unknown): Promise<PipelineOutcome>;
  complete(exec: unknown, outcome: PipelineOutcome): Promise<unknown>;
}

export interface DshWorkerExecutorContext {
  get(name: string): unknown;
  inject?(services: string[], callback: (context: DshWorkerExecutorContext) => Promise<void>): PromiseLike<unknown>;
}

/** Resolve executor plugins through the host loader so its Cordis and SDK instances stay aligned. */
export async function loadDshWorkerExecutorFactory(context: DshWorkerExecutorContext): Promise<DshWorkerExecutorFactory> {
  if (!context.get("loader") || !context.inject) throw new Error("Scoped graph worker executors require the dsh plugin loader and service injection");
  let factory: DshWorkerExecutorFactory | undefined;
  await context.inject(["loader"], async injected => {
    const loader = injected.get("loader") as { import(name: string): Promise<unknown> };
    const [native, pipeline] = await Promise.all([
      loader.import("@deepseek-ai/dsh-tool-executor-native") as Promise<{ NativeToolExecutor: new (context: unknown) => DshWorkerToolExecutor }>,
      loader.import("@deepseek-ai/dsh-tools/pipeline") as Promise<{ ToolExecutionPipeline: new (context: unknown) => WorkerPipeline }>,
    ]);
    factory = agent => {
      const executor = new native.NativeToolExecutor(agent.ctx);
      const invocation = new pipeline.ToolExecutionPipeline(agent.ctx);
      return {
        executor,
        async invoke(execution) {
          const prepared = await invocation.prepare(execution);
          const outcome = prepared.kind === "dispatch" ? await invocation.dispatch(prepared.exec) : prepared;
          return invocation.complete(prepared.exec, outcome);
        },
      };
    };
  });
  if (!factory) throw new Error("The dsh plugin loader did not activate for graph worker executors");
  return factory;
}
