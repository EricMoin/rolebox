import { describe, it, expect } from "bun:test";
import { registerObserveHandler, runCustomObserve } from "../../src/function/observe";
import { functionRuntime } from "../../src/function/runtime-state";
import type { ResolvedFunction } from "../../src/types";

describe("Observe Events Open Registry", () => {
  it("registerObserveHandler registers a custom event handler", () => {
    let invoked = false;
    registerObserveHandler("my_custom_event", (_ctx, _spec) => {
      invoked = true;
      return [];
    });

    const fn: ResolvedFunction = {
      name: "test-fn",
      description: "test",
      content: "",
      filePath: "/tmp/test.md",
      source: "built-in" as any,
      observe: [{ on: "my_custom_event", inject: "test" }],
    };

    functionRuntime.init("observe-test", "test-fn", 1);
    const result = runCustomObserve({
      sessionID: "observe-test",
      eventName: "my_custom_event",
      activeFns: [fn],
    });

    expect(invoked).toBe(true);
    expect(result).toEqual([]);
  });

  it("runCustomObserve returns empty array for unregistered event", () => {
    const result = runCustomObserve({
      sessionID: "test",
      eventName: "nonexistent_event",
      activeFns: [],
    });
    expect(result).toEqual([]);
  });
});
