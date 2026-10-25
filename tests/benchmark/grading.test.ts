import { describe, expect, it } from "vitest";
import { gradeBenchmarkResult } from "../../src/benchmark/grading.ts";
import type { BenchmarkCase, BenchmarkWorkerResult } from "../../src/benchmark/types.ts";

const item: BenchmarkCase = { id: "one", prompt: "Reply hello", assertions: [{ kind: "equals", value: "hello" }, { kind: "contains", value: "ell" }] };
const result: BenchmarkWorkerResult = {
  protocolVersion: 1, status: "completed", output: "hello", durationMs: 10, terminationConfirmed: true,
  usage: { inputTokens: null, outputTokens: null, costUsd: null, source: "unavailable" },
};

describe("benchmark grading", () => {
  it("requires every exact and substring assertion to pass without silent trimming", () => {
    expect(gradeBenchmarkResult(item, result)).toEqual({ verdict: "pass", assertions: [{ kind: "equals", passed: true }, { kind: "contains", passed: true }] });
    expect(gradeBenchmarkResult(item, { ...result, output: "hello\n" })).toEqual({ verdict: "fail", assertions: [{ kind: "equals", passed: false }, { kind: "contains", passed: true }] });
  });

  it("counts task timeout as failure even if partial text meets every assertion", () => {
    expect(gradeBenchmarkResult(item, { ...result, status: "task_timeout" })).toEqual({ verdict: "fail", assertions: [] });
  });

  it("counts a host-confirmed task failure as failure without scoring partial text", () => {
    expect(gradeBenchmarkResult(item, { ...result, status: "task_failure" })).toEqual({ verdict: "fail", assertions: [] });
  });

  it("does not score infrastructure failures, invalid targets, cancellation or unconfirmed completion", () => {
    for (const status of ["infra_error", "invalid", "cancelled"] as const) {
      expect(gradeBenchmarkResult(item, { ...result, status })).toEqual({ verdict: "unscored", assertions: [] });
    }
    expect(gradeBenchmarkResult(item, { ...result, terminationConfirmed: false }).verdict).toBe("unscored");
  });

  it("can assert deliberate empty output and does not pass an empty assertion set", () => {
    expect(gradeBenchmarkResult({ ...item, assertions: [{ kind: "equals", value: "" }] }, { ...result, output: "" }).verdict).toBe("pass");
    expect(gradeBenchmarkResult({ ...item, assertions: [] }, result).verdict).toBe("fail");
  });

  it("does not silently score workspace assertions through the text-only API", () => {
    const grade = gradeBenchmarkResult({ ...item, assertions: [{ kind: "file_exists", path: "result.txt" }] }, result);
    expect(grade.verdict).toBe("unscored");
    expect(grade.assertions).toEqual([]);
    expect(grade.error).toContain("workspace grading");
  });
});
