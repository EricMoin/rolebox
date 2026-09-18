import { describe, it, expect } from "bun:test";
import { errorText } from "../../src/utils/error-text.ts";

const UNPRINTABLE = "<unprintable thrown value>";

describe("errorText", () => {
  it("uses the message of an Error", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText(new TypeError("bad type"))).toBe("bad type");
    expect(errorText(new RangeError("out of range"))).toBe("out of range");
  });

  it("prefers the message over the name of a subclassed error", () => {
    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "CustomError";
      }
    }
    expect(errorText(new CustomError("custom failure"))).toBe("custom failure");
  });

  it("falls back to the error name when the message is empty", () => {
    expect(errorText(new Error())).toBe("Error");
    expect(errorText(new RangeError())).toBe("RangeError");
    expect(errorText(Object.assign(new Error(""), { name: "CustomError" }))).toBe(
      "CustomError",
    );
  });

  it("falls back to the name when message is not a string", () => {
    expect(errorText(Object.assign(new Error("boom"), { message: 7 }))).toBe("Error");
  });

  it("handles an object inheriting Error.prototype but carrying no fields", () => {
    const anonymous: Error = Object.setPrototypeOf({}, Error.prototype);
    expect(anonymous instanceof Error).toBe(true);
    expect(errorText(anonymous)).toBe("Error");
  });

  it("stringifies non-Error values", () => {
    expect(errorText("boom")).toBe("boom");
    expect(errorText("")).toBe("");
    expect(errorText(42)).toBe("42");
    expect(errorText(0)).toBe("0");
    expect(errorText(-1)).toBe("-1");
    expect(errorText(NaN)).toBe("NaN");
    expect(errorText(false)).toBe("false");
    expect(errorText(true)).toBe("true");
    expect(errorText(undefined)).toBe("undefined");
    expect(errorText(null)).toBe("null");
    expect(errorText(10n)).toBe("10");
    expect(errorText([1, 2])).toBe("1,2");
    expect(errorText({})).toBe("[object Object]");
  });

  it("uses a custom toString", () => {
    expect(errorText({ toString: () => "custom failure" })).toBe("custom failure");
  });

  it("does not special-case a plain object with name and message", () => {
    const errorLike = {
      name: "Error",
      message: "boom",
      toString: () => "Error: boom",
    };
    expect(errorText(errorLike)).toBe("Error: boom");
  });

  it("answers the placeholder for a thrown symbol", () => {
    expect(errorText(Symbol("boom"))).toBe(UNPRINTABLE);
  });

  it("answers the placeholder for a value with no primitive conversion", () => {
    expect(errorText(Object.create(null))).toBe(UNPRINTABLE);
    expect(errorText(Object.create(Object.create(null)))).toBe(UNPRINTABLE);
  });

  it("answers the placeholder when a conversion throws", () => {
    const throwingToString = {
      toString: () => {
        throw new Error("nope");
      },
    };
    const throwingPrimitive = {
      [Symbol.toPrimitive]: () => {
        throw new Error("nope");
      },
    };
    expect(errorText(throwingToString)).toBe(UNPRINTABLE);
    expect(errorText(throwingPrimitive)).toBe(UNPRINTABLE);
  });

  it("answers the placeholder when reading a field throws", () => {
    const throwingMessage = Object.defineProperty(new Error(), "message", {
      get() {
        throw new Error("getter exploded");
      },
    });
    expect(errorText(throwingMessage)).toBe(UNPRINTABLE);
  });

  it("never throws, whatever was thrown", () => {
    const throwingMessage = Object.defineProperty(new Error(), "message", {
      get() {
        throw new Error("getter exploded");
      },
    });
    const throwingProxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("trap");
        },
      },
    );
    const values: unknown[] = [
      null,
      undefined,
      0,
      1,
      -1,
      NaN,
      "",
      "boom",
      true,
      false,
      10n,
      Symbol("s"),
      Object.create(null),
      {},
      [],
      () => {},
      new Error("x"),
      throwingMessage,
      throwingProxy,
    ];
    for (const value of values) {
      let text = "";
      expect(() => {
        text = errorText(value);
      }).not.toThrow();
      // The only guarantee is a string: "" and [] stringify to "".
      expect(typeof text).toBe("string");
    }
  });
});
