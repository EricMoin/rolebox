import { describe, it, expect } from "bun:test";
import { isThenable } from "../../src/graph/engine/thenable.ts";

describe("isThenable", () => {
  it("accepts native promises", () => {
    expect(isThenable(Promise.resolve(1))).toBe(true);
    expect(isThenable(new Promise(() => {}))).toBe(true);
  });

  it("accepts any object with a then function", () => {
    expect(isThenable({ then: () => {} })).toBe(true);
    expect(isThenable({ then: async () => {} })).toBe(true);
  });

  it("accepts a callable carrying a then method", () => {
    const callable = Object.assign(() => {}, { then: () => {} });
    expect(isThenable(callable)).toBe(true);
  });

  it("accepts a class instance whose then is a method", () => {
    class Awaited {
      then(settle: () => void): void {
        settle();
      }
    }
    expect(isThenable(new Awaited())).toBe(true);
  });

  it("rejects a then that is not a function", () => {
    expect(isThenable({ then: 1 })).toBe(false);
    expect(isThenable({ then: "then" })).toBe(false);
    expect(isThenable({ then: null })).toBe(false);
    expect(isThenable({ then: undefined })).toBe(false);
    expect(isThenable({})).toBe(false);
  });

  it("rejects null, undefined and primitives without a property lookup", () => {
    // A property lookup on a primitive would throw; the predicate must not.
    const values: unknown[] = [
      null,
      undefined,
      0,
      1,
      "",
      "promise",
      true,
      Symbol("s"),
      10n,
    ];
    for (const value of values) {
      expect(isThenable(value)).toBe(false);
    }
  });

  it("rejects arrays and null-prototype objects", () => {
    expect(isThenable([])).toBe(false);
    expect(isThenable([{ then: () => {} }])).toBe(false);
    expect(isThenable(Object.create(null))).toBe(false);
  });

  it("narrows the value so it can be awaited", async () => {
    const value: unknown = Promise.resolve("done");
    if (!isThenable(value)) throw new Error("expected a thenable");
    await expect(Promise.resolve(value)).resolves.toBe("done");
  });
});
