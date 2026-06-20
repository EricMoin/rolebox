import { describe, it, expect } from "bun:test";
import { parseFunctionActivation } from "./function-parser";

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
});
