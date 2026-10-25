import { describe, expect, test } from "vitest";
import { createWorkerToolSession, type WorkerToolRegistry } from "../../../src/platform/worker-tools/index.ts";

const registry = (
  invoke: WorkerToolRegistry["invoke"],
  tools: readonly { name: string; description: string }[] = [
    { name: "service.query", description: "Query records" },
  ],
): WorkerToolRegistry => ({
  list: () => tools.map(tool => ({ ...tool, inputSchema: { type: "object" } })),
  invoke,
});

describe("worker code execution", () => {
  test("composes parallel calls, filters data, and emits lossless rich results", async () => {
    const native = { content: [{ type: "image", mimeType: "image/png", data: "cGl4ZWxz" }], data: [1, 2, 3] };
    const session = createWorkerToolSession({ registry: registry(async () => native), allowedTools: ["service.*"], presentation: { mode: "code" } });
    const result = await session.runCode(`
      const [first, second] = await Promise.all([tools.call('service.query', {}), tools['service.query']({})]);
      emit(first);
      return second.data.filter(value => value > 1);
    `);
    expect(result).toEqual({ value: [2, 3], emitted: [native], calls: 2 });
  });

  test("can discover schemas and handles ordinary host errors in code", async () => {
    const session = createWorkerToolSession({ registry: registry(async () => { throw new Error("upstream unavailable"); }), allowedTools: ["service.*"], presentation: { mode: "code" } });
    const result = await session.runCode(`
      const page = await tools.list({query:'records'});
      const schema = await tools.describe(page.tools[0].name);
      try { await tools.call(schema.name, {}); }
      catch (error) { return {message:error.message,schema:schema.inputSchema}; }
    `);
    expect(result).toEqual({ value: { message: "upstream unavailable", schema: { type: "object" } }, emitted: [], calls: 3 });
  });

  test("cannot call unauthorized or graph-control tools via code", async () => {
    let calls = 0;
    const session = createWorkerToolSession({ registry: registry(async () => { calls++; }), allowedTools: ["service.*", "graph_*"], presentation: { mode: "code" } });
    await expect(session.runCode("return await tools.call('graph_control', {});")).rejects.toThrow("not authorized");
    await expect(session.runCode("return await tools.call('secret_read', {});")).rejects.toThrow("not authorized");
    expect(calls).toBe(0);
  });

  test("terminates a CPU loop after an async continuation without blocking the host", async () => {
    const session = createWorkerToolSession({ registry: registry(async () => 1), allowedTools: ["service.*"], presentation: { mode: "code" } });
    let hostResponsive = false;
    const timer = setTimeout(() => { hostResponsive = true; }, 30);
    try { await expect(session.runCode("await Promise.resolve(); while (true) {}", { timeoutMs: 150 })).rejects.toThrow("exceeded 150ms"); }
    finally { clearTimeout(timer); }
    expect(hostResponsive).toBe(true);
    expect((await session.runCode("return 42")).value).toBe(42);
  });

  test("cancellation aborts in-flight host invocations and stops the execution", async () => {
    const controller = new AbortController();
    let hostCancelled = false;
    const session = createWorkerToolSession({
      registry: registry(async (_name, _args, { signal }) => {
        controller.abort();
        await new Promise<void>((resolve) => {
          if (signal.aborted) { hostCancelled = true; resolve(); }
          else signal.addEventListener("abort", () => { hostCancelled = true; resolve(); }, { once: true });
        });
        return "cancelled";
      }), allowedTools: ["service.*"], presentation: { mode: "code" },
    });
    await expect(session.runCode("return await tools.call('service.query', {})", { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(hostCancelled).toBe(true);
  });

  test("drains started host calls after stopping code and signalling cancellation", async () => {
    let hostSettled = false;
    const startSignal = () => {
      let mark: (() => void) | undefined;
      const promise = new Promise<void>(resolve => { mark = resolve; });
      return { promise, mark: () => mark?.() };
    };
    let queryStarted = startSignal();
    const session = createWorkerToolSession({
      registry: registry(async (name, _args, { signal }) => {
        if (name === "service.await-query") {
          // The code awaits this AFTER firing the un-awaited call, so the call has
          // provably reached the host before the code returns or enters its loop.
          await queryStarted.promise;
          return "started";
        }
        queryStarted.mark();
        await new Promise<void>(resolve => {
          const complete = () => { setTimeout(() => { hostSettled = true; resolve(); }, 30); };
          if (signal.aborted) complete();
          else signal.addEventListener("abort", complete, { once: true });
        });
        return "done";
      }, [
        { name: "service.query", description: "Query records" },
        { name: "service.await-query", description: "Wait for a query to start" },
      ]),
      allowedTools: ["service.*"],
      presentation: { mode: "code" },
    });
    await expect(session.runCode("tools.call('service.query', {}); await tools.call('service.await-query', {}); return 1")).rejects.toThrow("before awaiting all host calls");
    expect(hostSettled).toBe(true);
    hostSettled = false;
    queryStarted = startSignal();
    await expect(session.runCode("tools.call('service.query', {}); await tools.call('service.await-query', {}); while(true) {}", { timeoutMs: 100 })).rejects.toThrow('exceeded');
    expect(hostSettled).toBe(true);
  });

  test("bounds cancellation grace and reports a host call that ignores cancellation", async () => {
    let complete: ((value: unknown) => void) | undefined;
    const session = createWorkerToolSession({ registry: registry(async () => new Promise(resolve => { complete = resolve; })), allowedTools: ["service.*"], presentation: { mode: "code" } });
    const started = Date.now();
    try {
      await session.runCode("await tools.call('service.query', {})", {timeoutMs:100});
      throw new Error("expected timeout");
    } catch (error) {
      expect(error).toMatchObject({code:"timeout",pendingCalls:1});
      expect(String(error)).toContain("may still be running");
      expect(Date.now() - started).toBeLessThan(2500);
    } finally { complete?.("eventually completed"); }
  });

  test("enforces call, source, output and argument budgets", async () => {
    let invocations = 0;
    const session = createWorkerToolSession({ registry: registry(async () => { invocations++; return 1; }), allowedTools: ["service.*"], presentation: { mode: "code" } });
    await expect(session.runCode("await tools.call('service.query', {}); await tools.call('service.query', {});", { maxCalls: 1 })).rejects.toThrow("broker calls");
    expect(invocations).toBe(1);
    await expect(session.runCode(" ".repeat(65_537))).rejects.toThrow("source exceeds");
    await expect(session.runCode("return 'too much output'", { maxResultBytes: 4 })).rejects.toThrow("byte budget");
    await expect(session.runCode("return await tools.call('service.query', {data:'x'.repeat(262144)})")).rejects.toThrow("arguments exceed");
    expect(invocations).toBe(1);
  });

  test("keeps host prototypes and process APIs out of code, tool results and errors", async () => {
    const session = createWorkerToolSession({ registry: registry(async (_name, args) => {
      if (args.fail) throw new Error("host error");
      return { nested: { value: 1 } };
    }), allowedTools: ["service.*"], presentation: { mode: "code" } });
    const result = await session.runCode(`
      const attempted = [];
      const result = await tools.call('service.query', {});
      const escape = candidate => {
        try { candidate('return process')(); attempted.push('escaped'); }
        catch { attempted.push('blocked'); }
      };
      escape(tools.call.constructor);
      escape(emit.constructor);
      escape(result.constructor.constructor);
      escape(result.nested.constructor.constructor);
      try { await import('node:fs'); }
      catch(error) { escape(error.constructor.constructor); }
      try { await tools.call('service.query', {fail:true}); }
      catch(error) { escape(error.constructor.constructor); }
      return {attempted, bridge:typeof __workerBridge, process:typeof process, require:typeof require, fetch:typeof fetch};
    `);
    expect(result.value).toEqual({ attempted: ["blocked", "blocked", "blocked", "blocked", "blocked", "blocked"], bridge: "undefined", process: "undefined", require: "undefined", fetch: "undefined" });
  });

  test("error stacks do not expose host callback functions across VM realms", async () => {
    const session = createWorkerToolSession({ registry: registry(async () => { throw new Error("host failure"); }), allowedTools: ["service.*"], presentation: { mode: "code" } });
    const result = await session.runCode(`
      Error.prepareStackTrace = (_error, frames) => frames.map(frame => {
        const fn = frame.getFunction();
        if (!fn) return 'none';
        try { fn.constructor('return process')(); return 'escaped'; }
        catch { return 'blocked'; }
      });
      const stacks=[];
      try { await import('node:fs'); } catch(error) { stacks.push(error.stack); }
      try { await tools.call('service.query',{}); } catch(error) { stacks.push(error.stack); }
      return stacks;
    `);
    expect(result.value).toEqual(['Module imports are unavailable in worker code','host failure']);
  });

  test("completion never exposes host Promise callbacks to user code", async () => {
    const session = createWorkerToolSession({ registry: registry(async () => 1), allowedTools: ["service.*"], presentation: { mode: "code" } });
    const result = await session.runCode(`
      Promise.prototype.then = function(resolve) { return resolve.constructor('return process')().platform; };
      return 7;
    `);
    expect(result.value).toBe(7);
    const thenable = await session.runCode(`
      return { then(resolve) {
        try { resolve(resolve.constructor('return process')().platform); }
        catch { resolve('blocked'); }
      }};
    `);
    expect(thenable.value).toBe('blocked');
  });

  test("requires code mode and honors cancellation before starting", async () => {
    const session = createWorkerToolSession({ registry: registry(async () => 1), allowedTools: ["service.*"], presentation: { mode: "discover" } });
    await expect(session.runCode("return 1")).rejects.toThrow("not enabled");
    const codeSession = createWorkerToolSession({ registry: registry(async () => 1), allowedTools: ["service.*"], presentation: { mode: "code" } });
    await expect(codeSession.runCode("return 1", { signal: AbortSignal.abort() })).rejects.toThrow("cancelled");
  });
});
