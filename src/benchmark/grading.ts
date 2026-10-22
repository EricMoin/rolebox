import type { BenchmarkCase, BenchmarkGrade, BenchmarkWorkerResult } from "./types.ts";

export function gradeBenchmarkResult(item: BenchmarkCase, result: BenchmarkWorkerResult): BenchmarkGrade {
  if (result.status === "task_timeout" || result.status === "task_failure") return { verdict: "fail", assertions: [] };
  if (result.status !== "completed" || !result.terminationConfirmed) return { verdict: "unscored", assertions: [] };
  const assertions = item.assertions.map((assertion) => {
    let passed: boolean;
    switch (assertion.kind) {
      case "equals": passed = result.output === assertion.value; break;
      case "contains": passed = result.output.includes(assertion.value); break;
    }
    return { kind: assertion.kind, passed };
  });
  return { verdict: assertions.length > 0 && assertions.every((assertion) => assertion.passed) ? "pass" : "fail", assertions };
}
