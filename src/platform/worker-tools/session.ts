import { declaredToolsAllow } from "../../graph/host/tool-binding.ts";
import { executeWorkerCode } from "./code.ts";
import type {
  WorkerCodeOptions, WorkerCodeResult, WorkerToolDescriptor, WorkerToolPage,
  WorkerToolQuery, WorkerToolSessionOptions,
} from "./types.ts";

export class WorkerToolAccessError extends Error {
  override readonly name = "WorkerToolAccessError";
}

export class WorkerToolSession {
  readonly presentation: WorkerToolSessionOptions["presentation"];
  readonly #options: WorkerToolSessionOptions;

  constructor(options: WorkerToolSessionOptions) {
    this.#options = {
      ...options,
      allowedTools: typeof options.allowedTools === "function" || options.allowedTools === undefined
        ? options.allowedTools : [...options.allowedTools],
    };
    this.presentation = Object.freeze({ ...options.presentation,
      ...(options.presentation.preload ? { preload: Object.freeze([...options.presentation.preload]) } : {}),
    });
  }

  async #grants(): Promise<readonly string[] | undefined> {
    return typeof this.#options.allowedTools === "function" ? this.#options.allowedTools() : this.#options.allowedTools;
  }

  async #catalog(): Promise<WorkerToolDescriptor[]> {
    this.#options.signal?.throwIfAborted();
    const registered = await this.#options.registry.list();
    const allowed = await this.#grants();
    this.#options.signal?.throwIfAborted();
    const byName = new Map<string, WorkerToolDescriptor>();
    const duplicates = new Set<string>();
    for (const tool of registered) {
      if (typeof tool.name !== "string" || !declaredToolsAllow(tool.name, allowed)) continue;
      if (byName.has(tool.name)) duplicates.add(tool.name);
      else byName.set(tool.name, tool);
    }
    // An ambiguous registry entry cannot safely describe the implementation invoked by name.
    for (const name of duplicates) byName.delete(name);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async list(query: WorkerToolQuery = {}): Promise<WorkerToolPage> {
    const offset = boundedInteger(query.offset ?? 0, 0, Number.MAX_SAFE_INTEGER, "offset");
    const limit = boundedInteger(query.limit ?? 20, 1, 100, "limit");
    const terms = (query.query ?? "").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const tools = (await this.#catalog()).filter(tool => {
      if (query.source !== undefined && tool.source !== query.source) return false;
      const text = `${tool.name} ${tool.description} ${tool.source ?? ""}`.toLocaleLowerCase();
      return terms.every(term => text.includes(term));
    });
    const page = tools.slice(offset, offset + limit).map(({ name, description, source }) => ({
      name, description, ...(source === undefined ? {} : { source }),
    }));
    return {
      tools: page, offset, total: tools.length,
      ...(offset + page.length < tools.length ? { nextOffset: offset + page.length } : {}),
    };
  }

  async describe(name: string, options: { activate?: boolean } = {}): Promise<WorkerToolDescriptor> {
    const descriptor = (await this.#catalog()).find(tool => tool.name === name);
    if (!descriptor) throw new WorkerToolAccessError(`Tool ${name} is unavailable or not authorized for this worker`);
    if ((options.activate ?? true) && this.presentation.mode === "discover") {
      await this.#options.activate?.([descriptor]);
    }
    return descriptor;
  }

  async call(name: string, args: Record<string, unknown>, options: { signal?: AbortSignal } = {}): Promise<unknown> {
    if (args === null || typeof args !== "object" || Array.isArray(args)) throw new TypeError("Tool arguments must be an object");
    const signal = combinedSignal(this.#options.signal, options.signal);
    signal.throwIfAborted();
    await this.describe(name, { activate: false });
    if (!declaredToolsAllow(name, await this.#grants())) {
      throw new WorkerToolAccessError(`Tool ${name} is unavailable or not authorized for this worker`);
    }
    signal.throwIfAborted();
    return this.#options.registry.invoke(name, args, { signal });
  }

  async runCode(source: string, options: WorkerCodeOptions = {}): Promise<WorkerCodeResult> {
    if (this.presentation.mode !== "code") throw new WorkerToolAccessError("Code execution is not enabled for this worker");
    return executeWorkerCode(this, source, {
      ...options, signal: combinedSignal(this.#options.signal, options.signal),
    });
  }
}

export function createWorkerToolSession(options: WorkerToolSessionOptions): WorkerToolSession {
  return new WorkerToolSession(options);
}

export function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function combinedSignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return present.length ? AbortSignal.any(present) : new AbortController().signal;
}
