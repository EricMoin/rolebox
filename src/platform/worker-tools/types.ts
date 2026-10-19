import type { WorkerToolPresentation } from "../../graph/domain/worker-tools.ts";

export type { WorkerToolPresentation } from "../../graph/domain/worker-tools.ts";
export type Awaitable<T> = T | Promise<T>;

export interface WorkerToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  source?: string;
}

export interface WorkerToolRegistry {
  list(): Awaitable<readonly WorkerToolDescriptor[]>;
  /** The adapter binds the original caller and runs its ordinary execution pipeline. */
  invoke(name: string, args: Record<string, unknown>, context: { signal: AbortSignal }): Promise<unknown>;
}

export interface WorkerToolSessionOptions {
  registry: WorkerToolRegistry;
  allowedTools: readonly string[] | (() => Awaitable<readonly string[]>);
  presentation: WorkerToolPresentation;
  signal?: AbortSignal;
  activate?: (descriptors: readonly WorkerToolDescriptor[]) => Awaitable<void>;
}

export interface WorkerToolQuery {
  query?: string;
  source?: string;
  offset?: number;
  limit?: number;
}

export type WorkerToolSummary = Pick<WorkerToolDescriptor, "name" | "description" | "source">;

export interface WorkerToolPage {
  tools: WorkerToolSummary[];
  offset: number;
  total: number;
  nextOffset?: number;
}

export interface WorkerCodeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  maxResultBytes?: number;
  maxCalls?: number;
}

export interface WorkerCodeResult {
  value: unknown;
  emitted: unknown[];
  calls: number;
}
