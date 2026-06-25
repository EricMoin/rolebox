import { describe, it, expect } from "bun:test";
import { parseFunctionActivation } from "../src/function-parser";
import type { FunctionCall } from "../src/function-parser";

describe("parseFunctionActivation", () => {
  it("extracts single function from start", () => {
    const result = parseFunctionActivation("|plan| build a REST API");
    expect(result.functions).toEqual(["plan"]);
    expect(result.cleanedText).toBe("build a REST API");
  });

  it("parses consecutive function names correctly", () => {
    const result = parseFunctionActivation("|plan|review| check");
    expect(result.functions).toEqual(["plan", "review"]);
    expect(result.cleanedText).toBe("check");
  });

  it("parses three consecutive functions", () => {
    const result = parseFunctionActivation("|plan|execute|review| do it");
    expect(result.functions).toEqual(["plan", "execute", "review"]);
    expect(result.cleanedText).toBe("do it");
  });

  it("ignores mid-sentence pipes (no activation)", () => {
    const result = parseFunctionActivation("hello |plan| world");
    expect(result.functions).toEqual([]);
    expect(result.cleanedText).toBe("hello |plan| world");
  });

  it("returns empty for empty string", () => {
    const result = parseFunctionActivation("");
    expect(result.functions).toEqual([]);
    expect(result.cleanedText).toBe("");
  });

  it("rejects empty pipes", () => {
    const result = parseFunctionActivation("|| empty");
    expect(result.functions).toEqual([]);
    expect(result.cleanedText).toBe("|| empty");
  });

  it("rejects uppercase function names", () => {
    const result = parseFunctionActivation("|Plan| X");
    expect(result.functions).toEqual([]);
    expect(result.cleanedText).toBe("|Plan| X");
  });

  it("allows hyphenated function names", () => {
    const result = parseFunctionActivation("|my-custom-plan| text");
    expect(result.functions).toEqual(["my-custom-plan"]);
    expect(result.cleanedText).toBe("text");
  });

  it("handles no space after pipe", () => {
    const result = parseFunctionActivation("|plan|text");
    expect(result.functions).toEqual(["plan"]);
    expect(result.cleanedText).toBe("text");
  });

  it("handles only pipes with no text", () => {
    const result = parseFunctionActivation("|plan|");
    expect(result.functions).toEqual(["plan"]);
    expect(result.cleanedText).toBe("");
  });

  it("rejects names starting with numbers", () => {
    const result = parseFunctionActivation("|1plan| text");
    expect(result.functions).toEqual([]);
    expect(result.cleanedText).toBe("|1plan| text");
  });

  it("trims leading whitespace after consuming pipes", () => {
    const result = parseFunctionActivation("|plan|   spaced text");
    expect(result.functions).toEqual(["plan"]);
    expect(result.cleanedText).toBe("spaced text");
  });

  it("returns empty calls array for plain functions", () => {
    const result = parseFunctionActivation("|plan| do it");
    expect(result.calls).toEqual([{ name: "plan", args: {} }]);
  });
});

describe("parseFunctionActivation — parameterized", () => {
  it("parses colon positional args: |review:security|", () => {
    const result = parseFunctionActivation("|review:security| check code");
    expect(result.functions).toEqual(["review"]);
    expect(result.calls[0].name).toBe("review");
    expect(result.calls[0].args).toEqual({ _0: "security" });
    expect(result.cleanedText).toBe("check code");
  });

  it("parses multiple positional args: |review:security,strict|", () => {
    const result = parseFunctionActivation("|review:security,strict| go");
    expect(result.functions).toEqual(["review"]);
    expect(result.calls[0].args).toEqual({ _0: "security", _1: "strict" });
    expect(result.cleanedText).toBe("go");
  });

  it("parses key=value args: |review focus=security|", () => {
    const result = parseFunctionActivation("|review focus=security| go");
    expect(result.functions).toEqual(["review"]);
    expect(result.calls[0].args).toEqual({ focus: "security" });
    expect(result.cleanedText).toBe("go");
  });

  it("parses multiple key=value args", () => {
    const result = parseFunctionActivation("|review focus=security severity=strict| go");
    expect(result.functions).toEqual(["review"]);
    expect(result.calls[0].args).toEqual({ focus: "security", severity: "strict" });
  });

  it("parses quoted values: |review focus=\"all areas\"|", () => {
    const result = parseFunctionActivation('|review focus="all areas"| go');
    expect(result.calls[0].args).toEqual({ focus: "all areas" });
  });

  it("mixes plain and parameterized: |plan|review:security|", () => {
    const result = parseFunctionActivation("|plan|review:security| go");
    expect(result.functions).toEqual(["plan", "review"]);
    expect(result.calls[0]).toEqual({ name: "plan", args: {} });
    expect(result.calls[1]).toEqual({ name: "review", args: { _0: "security" } });
  });

  it("handles parameterized function with no trailing text", () => {
    const result = parseFunctionActivation("|review:perf|");
    expect(result.functions).toEqual(["review"]);
    expect(result.calls[0].args).toEqual({ _0: "perf" });
    expect(result.cleanedText).toBe("");
  });
});
