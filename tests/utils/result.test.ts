import { describe, it, expect } from "bun:test";
import { err, isErr, isOk, ok, type Result } from "../../src/utils/result.ts";

describe("result", () => {
  it("ok() is the unit success arm", () => {
    const result = ok();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the success arm");
    expect(result.value).toBeUndefined();
  });

  it("ok(value) carries the value", () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the success arm");
    expect(result.value).toBe(42);
  });

  it("err(error) carries the error", () => {
    const result = err("boom");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the failure arm");
    expect(result.error).toBe("boom");
  });

  it("isOk narrows both arms at runtime", () => {
    const success: Result<number, string> = ok(1);
    const failure: Result<number, string> = err("nope");
    expect(isOk(success)).toBe(true);
    expect(isOk(failure)).toBe(false);
    if (isOk(failure)) throw new Error("expected the failure arm");
    expect(failure.error).toBe("nope");
  });

  it("isErr narrows both arms at runtime", () => {
    const success: Result<number, string> = ok(1);
    const failure: Result<number, string> = err("nope");
    expect(isErr(success)).toBe(false);
    expect(isErr(failure)).toBe(true);
    if (isErr(success)) throw new Error("expected the success arm");
    expect(success.value).toBe(1);
  });

  it("rejects the pre-migration loose verdict shapes", () => {
    // @ts-expect-error a success arm cannot carry an error
    const okWithError: Result<void, string> = { ok: true, error: "boom" };
    // @ts-expect-error a failure arm cannot omit the error
    const errWithoutError: Result<void, string> = { ok: false };
    // @ts-expect-error the pre-migration loose verdict is no longer representable
    const looseVerdict: Result<void, string> = { valid: false, reason: "x" };
    void okWithError;
    void errWithoutError;
    void looseVerdict;
  });
});
