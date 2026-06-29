import { describe, it, expect, beforeEach } from "bun:test";
import { functionRuntime } from "../src/function/runtime-state.ts";
import type { ResolvedFunction } from "../src/types.ts";

function makeFn(overrides: Partial<ResolvedFunction> = {}): ResolvedFunction {
  return {
    name: "testFn",
    description: "test function",
    content: "# test\n",
    filePath: "/tmp/fake/testFn.md",
    source: "role-local",
    ...overrides,
  };
}

let runMessageObserve: (opts: {
  sessionID: string;
  activeFns: ResolvedFunction[];
}) => string[];
let runActivateObserve: (opts: {
  sessionID: string;
  activeFns: ResolvedFunction[];
}) => string[];

beforeEach(async () => {
  functionRuntime.clearSession("test-sid");
  const mod = await import("../src/function/observe.ts");
  runMessageObserve = mod.runMessageObserve;
  runActivateObserve = mod.runActivateObserve;
});

describe("runMessageObserve", () => {
  it("on:message inject returns injected string", () => {
    const fn = makeFn({
      name: "classifier",
      observe: [{ on: "message", inject: "classify: DIRECT|chancellor|jinyiwei" }],
    });
    functionRuntime.init("test-sid", "classifier", 1);

    const result = runMessageObserve({
      sessionID: "test-sid",
      activeFns: [fn],
    });

    expect(result).toEqual(["classify: DIRECT|chancellor|jinyiwei"]);
  });

  it("on:message set_evidence marks evidenceObserved", () => {
    const fn = makeFn({
      name: "evidencer",
      observe: [{ on: "message", set_evidence: "message_observed" }],
    });
    functionRuntime.init("test-sid", "evidencer", 1);

    runMessageObserve({
      sessionID: "test-sid",
      activeFns: [fn],
    });

    const st = functionRuntime.get("test-sid", "evidencer");
    expect(st).toBeDefined();
    expect(st!.evidenceObserved["message_observed"]).toBe(true);
  });

  it("non-message observe spec returns empty injects", () => {
    const fn = makeFn({
      name: "tool-only",
      observe: [{ on: "tool_after", tool: "todowrite" }],
    });
    functionRuntime.init("test-sid", "tool-only", 1);

    const result = runMessageObserve({
      sessionID: "test-sid",
      activeFns: [fn],
    });

    expect(result).toEqual([]);
  });

  it("when guard false skips inject", () => {
    const fn = makeFn({
      name: "guarded",
      observe: [
        { on: "message", when: "user_approval", inject: "SHOULD_NOT_APPEAR" },
      ],
    });
    functionRuntime.init("test-sid", "guarded", 1);

    const result = runMessageObserve({
      sessionID: "test-sid",
      activeFns: [fn],
    });

    expect(result).toEqual([]);
  });

  it("when guard true adds inject", () => {
    const fn = makeFn({
      name: "guarded2",
      observe: [
        { on: "message", when: "turn_count(0)", inject: "SHOULD_APPEAR" },
      ],
    });
    functionRuntime.init("test-sid", "guarded2", 1);

    const result = runMessageObserve({
      sessionID: "test-sid",
      activeFns: [fn],
    });

    expect(result).toEqual(["SHOULD_APPEAR"]);
  });

  it("collects injects from multiple active functions", () => {
    const fn1 = makeFn({
      name: "fn1",
      observe: [{ on: "message", inject: "inject-1" }],
    });
    const fn2 = makeFn({
      name: "fn2",
      observe: [{ on: "message", inject: "inject-2" }],
    });
    functionRuntime.init("test-sid", "fn1", 1);
    functionRuntime.init("test-sid", "fn2", 1);

    const result = runMessageObserve({
      sessionID: "test-sid",
      activeFns: [fn1, fn2],
    });

    expect(result).toEqual(["inject-1", "inject-2"]);
  });

  it("skips functions with no runtime state", () => {
    const fn = makeFn({
      name: "inactive",
      observe: [{ on: "message", inject: "SHOULD_NOT_APPEAR" }],
    });

    const result = runMessageObserve({
      sessionID: "test-sid",
      activeFns: [fn],
    });

    expect(result).toEqual([]);
  });
});

describe("runActivateObserve", () => {
  it("on:activate inject returns injected string", () => {
    const fn = makeFn({
      name: "greeter",
      observe: [{ on: "activate", inject: "welcome" }],
    });
    functionRuntime.init("test-sid", "greeter", 1);

    const result = runActivateObserve({
      sessionID: "test-sid",
      activeFns: [fn],
    });

    expect(result).toEqual(["welcome"]);
  });

  it("non-activate observe spec returns empty injects", () => {
    const fn = makeFn({
      name: "msg-only",
      observe: [{ on: "message", inject: "hello" }],
    });
    functionRuntime.init("test-sid", "msg-only", 1);

    const result = runActivateObserve({
      sessionID: "test-sid",
      activeFns: [fn],
    });

    expect(result).toEqual([]);
  });

  it("collects injects from multiple active functions", () => {
    const fn1 = makeFn({
      name: "a1",
      observe: [{ on: "activate", inject: "a-inject-1" }],
    });
    const fn2 = makeFn({
      name: "a2",
      observe: [{ on: "activate", inject: "a-inject-2" }],
    });
    functionRuntime.init("test-sid", "a1", 1);
    functionRuntime.init("test-sid", "a2", 1);

    const result = runActivateObserve({
      sessionID: "test-sid",
      activeFns: [fn1, fn2],
    });

    expect(result).toEqual(["a-inject-1", "a-inject-2"]);
  });

  it("skips functions with no runtime state", () => {
    const fn = makeFn({
      name: "inactive-a",
      observe: [{ on: "activate", inject: "SHOULD_NOT_APPEAR" }],
    });

    const result = runActivateObserve({
      sessionID: "test-sid",
      activeFns: [fn],
    });

    expect(result).toEqual([]);
  });
});
