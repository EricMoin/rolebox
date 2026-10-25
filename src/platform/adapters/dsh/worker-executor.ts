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

/** Resolve executor plugins through the host loader so its Cordis and SDK instances stay aligned. */
export async function loadDshWorkerExecutorFactory(context: { get(name: string): unknown }): Promise<DshWorkerExecutorFactory> {
  const loader = context.get("loader") as { import?(name: string): Promise<unknown> } | undefined;
  if (!loader?.import) throw new Error("Scoped graph worker executors require the dsh plugin loader");
  const [native, pipeline] = await Promise.all([
    loader.import("@deepseek-ai/dsh-tool-executor-native") as Promise<{ NativeToolExecutor: new (context: unknown) => DshWorkerToolExecutor }>,
    loader.import("@deepseek-ai/dsh-tools/pipeline") as Promise<{ ToolExecutionPipeline: new (context: unknown) => WorkerPipeline }>,
  ]);
  return agent => {
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
}
