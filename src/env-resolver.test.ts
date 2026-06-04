import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resolveEnvVars, resolveEnvVarsDeep } from "./env-resolver";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_PATH = process.env.PATH;

beforeEach(() => {
  process.env.HOME = ORIGINAL_HOME;
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.TEST_VAR;
  delete process.env.ANOTHER_VAR;
  delete process.env.SPECIAL_1;
});

afterEach(() => {
  process.env.HOME = ORIGINAL_HOME;
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.TEST_VAR;
  delete process.env.ANOTHER_VAR;
  delete process.env.SPECIAL_1;
});

describe("resolveEnvVars", () => {
  it("replaces a single env var with its value", () => {
    const result = resolveEnvVars("{env:HOME}");
    expect(result).toBe(ORIGINAL_HOME);
  });

  it("replaces multiple env vars in one string", () => {
    process.env.TEST_VAR = "test_value";
    const result = resolveEnvVars("echo {env:HOME} and {env:TEST_VAR}");
    expect(result).toBe(`echo ${ORIGINAL_HOME} and test_value`);
  });

  it("leaves missing env var placeholder as-is and warns", () => {
    const warn = mock();
    console.warn = warn;

    const result = resolveEnvVars("path/{env:NONEXISTENT_VAR_12345}");

    expect(result).toBe("path/{env:NONEXISTENT_VAR_12345}");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("NONEXISTENT_VAR_12345");
  });

  it("resolves var at start of string", () => {
    process.env.TEST_VAR = "prefix";
    const result = resolveEnvVars("{env:TEST_VAR}/suffix");
    expect(result).toBe("prefix/suffix");
  });

  it("resolves var at middle of string", () => {
    process.env.TEST_VAR = "mid";
    const result = resolveEnvVars("before/{env:TEST_VAR}/after");
    expect(result).toBe("before/mid/after");
  });

  it("resolves var at end of string", () => {
    process.env.TEST_VAR = "trailing";
    const result = resolveEnvVars("value:{env:TEST_VAR}");
    expect(result).toBe("value:trailing");
  });

  it("passes through a string with no env vars unchanged", () => {
    const result = resolveEnvVars("just a regular string with no placeholders");
    expect(result).toBe("just a regular string with no placeholders");
  });

  it("handles empty string", () => {
    const result = resolveEnvVars("");
    expect(result).toBe("");
  });

  it("handles var names with underscores and digits", () => {
    process.env.SPECIAL_1 = "found";
    const result = resolveEnvVars("{env:SPECIAL_1}");
    expect(result).toBe("found");
  });

  it("does NOT support nested env var references", () => {
    const result = resolveEnvVars("{env:{env:HOME}}");
    expect(result).toBe("{env:{env:HOME}}");
  });

  it("does NOT support default value syntax", () => {
    const result = resolveEnvVars("{env:X:-default}");
    expect(result).toBe("{env:X:-default}");
  });
});

describe("resolveEnvVarsDeep", () => {
  it("resolves env vars in a flat object", () => {
    const obj = { home: "{env:HOME}", path: "{env:PATH}" };
    const result = resolveEnvVarsDeep(obj) as Record<string, string>;
    expect(result.home).toBe(ORIGINAL_HOME);
    expect(result.path).toBe(ORIGINAL_PATH);
  });

  it("resolves env vars in nested objects", () => {
    const obj = { outer: { inner: "{env:HOME}" }, sibling: "static" };
    const result = resolveEnvVarsDeep(obj) as Record<string, unknown>;
    expect((result.outer as Record<string, string>).inner).toBe(ORIGINAL_HOME);
    expect((result as Record<string, string>).sibling).toBe("static");
  });

  it("resolves env vars in arrays of strings", () => {
    process.env.TEST_VAR = "array_val";
    const arr = ["{env:HOME}", "{env:TEST_VAR}", "plain"];
    const result = resolveEnvVarsDeep(arr) as string[];
    expect(result[0]).toBe(ORIGINAL_HOME);
    expect(result[1]).toBe("array_val");
    expect(result[2]).toBe("plain");
  });

  it("resolves env vars in nested arrays within objects", () => {
    process.env.TEST_VAR = "nested_array";
    const obj = { list: ["{env:HOME}", "{env:TEST_VAR}"] };
    const result = resolveEnvVarsDeep(obj) as Record<string, string[]>;
    expect(result.list[0]).toBe(ORIGINAL_HOME);
    expect(result.list[1]).toBe("nested_array");
  });

  it("passes through objects with no env vars", () => {
    const obj = { a: 1, b: true, c: null, d: "hello" };
    const result = resolveEnvVarsDeep(obj) as Record<string, unknown>;
    expect(result.a).toBe(1);
    expect(result.b).toBe(true);
    expect(result.c).toBeNull();
    expect(result.d).toBe("hello");
  });

  it("handles null and undefined values", () => {
    expect(resolveEnvVarsDeep(null)).toBeNull();
    expect(resolveEnvVarsDeep(undefined)).toBeUndefined();
  });

  it("handles numeric and boolean primitives unchanged", () => {
    expect(resolveEnvVarsDeep(42)).toBe(42);
    expect(resolveEnvVarsDeep(true)).toBe(true);
    expect(resolveEnvVarsDeep(false)).toBe(false);
  });

  it("handles empty object and empty array", () => {
    expect(resolveEnvVarsDeep({})).toEqual({});
    expect(resolveEnvVarsDeep([])).toEqual([]);
  });

  it("keeps missing env var placeholder in deep resolve", () => {
    const warn = mock();
    console.warn = warn;

    const obj = { x: "{env:MISSING_VAR_DEEP}" };
    const result = resolveEnvVarsDeep(obj) as Record<string, string>;
    expect(result.x).toBe("{env:MISSING_VAR_DEEP}");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
