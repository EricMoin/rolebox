import { spawn } from "node:child_process";
import { WORKER_CODE_BOOTSTRAP } from "./code-worker.ts";
import type { WorkerToolSession } from "./session.ts";
import type { WorkerCodeOptions, WorkerCodeResult, WorkerToolQuery } from "./types.ts";

const MAX_SOURCE_BYTES = 65_536;
const MAX_RESULT_BYTES = 1_048_576;
const MAX_TRANSPORT_BYTES = 8_388_608;
const MAX_ARGUMENT_BYTES = 262_144;
const MAX_CALLS = 100;
const MAX_TIMEOUT_MS = 120_000;
const CANCELLATION_GRACE_MS = 1_000;

export class WorkerCodeError extends Error {
  override readonly name = "WorkerCodeError";
  constructor(readonly code: "timeout" | "cancelled" | "budget" | "execution", message: string, readonly pendingCalls = 0) {
    super(message);
  }
}

/** The script process has a hard deadline; host calls receive cancellation and a bounded grace period. */
export async function executeWorkerCode(session: WorkerToolSession, source: string, options: WorkerCodeOptions): Promise<WorkerCodeResult> {
  const timeoutMs = integerLimit(options.timeoutMs ?? 30_000, MAX_TIMEOUT_MS, "timeoutMs");
  const maxResultBytes = integerLimit(options.maxResultBytes ?? MAX_RESULT_BYTES, MAX_RESULT_BYTES, "maxResultBytes");
  const maxCalls = integerLimit(options.maxCalls ?? MAX_CALLS, MAX_CALLS, "maxCalls");
  if (typeof source !== "string") throw new TypeError("Code source must be a string");
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) throw new WorkerCodeError("budget", "Code source exceeds 65536 bytes");
  if (options.signal?.aborted) throw new WorkerCodeError("cancelled", "Code execution was cancelled");
  const controller = new AbortController();
  const runtimeFlags = process.versions.bun ? [] : ["--experimental-vm-modules", "--max-old-space-size=64"];
  const worker = spawn(process.execPath, [...runtimeFlags, "--eval", WORKER_CODE_BOOTSTRAP], {
    env: {},
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "json",
  });
  const stopped = new Promise<void>(resolve => worker.once("close", () => resolve()));
  return new Promise<WorkerCodeResult>((resolve, reject) => {
    let settled = false;
    let calls = 0;
    let resultBytes = 0;
    let transportBytes = 0;
    const emitted: unknown[] = [];
    const activeIds = new Set<number>();
    const inFlight = new Set<Promise<void>>();
    const timer = setTimeout(() => finish(new WorkerCodeError("timeout", `Code execution exceeded ${timeoutMs}ms and was stopped`)), timeoutMs);
    const abort = () => finish(new WorkerCodeError("cancelled", "Code execution was cancelled and stopped"));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    function finish(error?: Error, result?: WorkerCodeResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      const finalError = error ?? (inFlight.size
        ? new WorkerCodeError("execution", "Code returned before awaiting all host calls; those calls were cancelled") : undefined);
      controller.abort();
      worker.kill("SIGKILL");
      void Promise.all([stopped, drain()]).then(([, pendingCalls]) => {
        if (pendingCalls) {
          const code = finalError instanceof WorkerCodeError ? finalError.code : "execution";
          reject(new WorkerCodeError(code,
            `${finalError?.message ?? "Code execution stopped"}; ${pendingCalls} host call(s) have not settled after ${CANCELLATION_GRACE_MS}ms of cancellation and may still be running`, pendingCalls));
        } else if (finalError) reject(finalError);
        else resolve(result!);
      }, reject);
    }

    function drain(): Promise<number> {
      if (!inFlight.size) return Promise.resolve(0);
      return new Promise(resolve => {
        const grace = setTimeout(() => resolve(inFlight.size), CANCELLATION_GRACE_MS);
        void Promise.allSettled([...inFlight]).then(() => { clearTimeout(grace); resolve(0); });
      });
    }

    function send(message: unknown): void {
      worker.send(message as object, error => {
        if (error && !settled) finish(new WorkerCodeError("execution", error.message));
      });
    }

    function accountOutput(value: unknown): void {
      resultBytes += jsonBytes(value);
      if (resultBytes > maxResultBytes) throw new WorkerCodeError("budget", "Code output exceeds the result byte budget");
    }

    async function request(message: Record<string, unknown>): Promise<void> {
      const id = message.id;
      if (!Number.isSafeInteger(id) || typeof id !== "number" || id < 1 || activeIds.has(id)) {
        finish(new WorkerCodeError("execution", "Invalid code worker request"));
        return;
      }
      activeIds.add(id);
      try {
        if (++calls > maxCalls) throw new WorkerCodeError("budget", `Code execution exceeds ${maxCalls} broker calls`);
        const payload = record(message.payload);
        if (jsonBytes(payload) > MAX_ARGUMENT_BYTES) throw new WorkerCodeError("budget", "Tool arguments exceed the byte budget");
        let value: unknown;
        switch (message.operation) {
          case "call":
            if (typeof payload.name !== "string") throw new TypeError("Tool name must be a string");
            value = await session.call(payload.name, record(payload.args), { signal: controller.signal });
            break;
          case "list":
            value = await session.list(payload as WorkerToolQuery);
            break;
          case "describe":
            if (typeof payload.name !== "string") throw new TypeError("Tool name must be a string");
            value = await session.describe(payload.name, { activate: false });
            break;
          default:
            throw new TypeError("Unknown worker broker operation");
        }
        if (settled) return;
        transportBytes += jsonBytes(value);
        if (transportBytes > MAX_TRANSPORT_BYTES) throw new WorkerCodeError("budget", "Tool results exceed the execution transport byte budget");
        send({ id, value });
      } catch (error) {
        if (settled) return;
        if (error instanceof WorkerCodeError) finish(error);
        else send({ id, error: error instanceof Error ? error.message : String(error) });
      } finally {
        activeIds.delete(id);
      }
    }

    worker.on("message", (message: unknown) => {
      if (settled) return;
      try {
        const data = record(message);
        switch (data.type) {
          case "request": {
            const operation = request(data).catch(error => finish(error instanceof Error ? error : new Error(String(error))));
            inFlight.add(operation);
            void operation.then(() => inFlight.delete(operation));
            break;
          }
          case "emit": accountOutput(data.value); emitted.push(data.value); break;
          case "done": accountOutput(data.value); finish(undefined, { value: data.value, emitted, calls }); break;
          case "failure": finish(new WorkerCodeError("execution", typeof data.error === "string" ? data.error : "Code execution failed")); break;
          default: finish(new WorkerCodeError("execution", "Invalid code worker message"));
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    worker.on("error", error => finish(new WorkerCodeError("execution", error instanceof Error ? error.message : String(error))));
    worker.on("exit", code => {
      if (!settled) finish(new WorkerCodeError("execution", `Code worker exited before returning a result (${code})`));
    });
    const unexpectedOutput = () => finish(new WorkerCodeError("execution", "Code output must use emit() or return"));
    worker.stdout?.on("data", unexpectedOutput);
    worker.stderr?.on("data", unexpectedOutput);
    if (!settled) send({ source, maxResultBytes });
  });
}

function jsonBytes(value: unknown): number {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); }
  catch { throw new TypeError("Worker values must be JSON serializable"); }
  return Buffer.byteLength(encoded ?? "null");
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Worker request must be an object");
  return value as Record<string, unknown>;
}

function integerLimit(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(`${name} must be an integer between 1 and ${maximum}`);
  return value;
}
