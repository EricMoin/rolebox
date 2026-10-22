import type { BenchmarkCase, BenchmarkGrade, BenchmarkWorkerResult } from "./types.ts";
import { runBenchmarkCommand, type BenchmarkCommandInput } from "./command-grader.ts";

export function gradeBenchmarkResult(item: BenchmarkCase, result: BenchmarkWorkerResult): BenchmarkGrade {
  if (result.status === "task_timeout" || result.status === "task_failure") return { verdict: "fail", assertions: [] };
  if (result.status !== "completed" || !result.terminationConfirmed) return { verdict: "unscored", assertions: [] };
  if (item.assertions.some(assertion => assertion.kind !== "equals" && assertion.kind !== "contains")) {
    return { verdict: "unscored", assertions: [], error: "Workspace assertions require workspace grading." };
  }
  const assertions = item.assertions.map((assertion) => {
    let passed = false;
    switch (assertion.kind) {
      case "equals": passed = result.output === assertion.value; break;
      case "contains": passed = result.output.includes(assertion.value); break;
    }
    return { kind: assertion.kind, passed };
  });
  return { verdict: assertions.length > 0 && assertions.every((assertion) => assertion.passed) ? "pass" : "fail", assertions };
}

function decodeText(content: string): string | undefined {
  const bytes = Buffer.from(content, "base64");
  if (bytes.toString("base64") !== content) return;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) ? undefined : text;
  }
  catch { return; }
}

export async function gradeBenchmarkWorkspace(item: BenchmarkCase, result: BenchmarkWorkerResult,
  input: BenchmarkCommandInput): Promise<BenchmarkGrade> {
  if (result.status !== "completed" || !result.terminationConfirmed) return gradeBenchmarkResult(item, result);
  const files = new Map(input.workspace.files.map(file => [file.path, file]));
  const assertions: BenchmarkGrade["assertions"] = [];
  for (const assertion of item.assertions) {
    if (input.signal?.aborted) {
      return { verdict: "unscored", assertions, error: "The benchmark grader was cancelled.", terminationConfirmed: true };
    }
    switch (assertion.kind) {
      case "equals": assertions.push({ kind: assertion.kind, passed: result.output === assertion.value }); break;
      case "contains": assertions.push({ kind: assertion.kind, passed: result.output.includes(assertion.value) }); break;
      case "file_exists": assertions.push({ kind: assertion.kind, path: assertion.path, passed: files.has(assertion.path) }); break;
      case "file_equals":
      case "file_contains": {
        const file = files.get(assertion.path);
        const text = file ? decodeText(file.content) : undefined;
        const passed = text !== undefined && (assertion.kind === "file_equals" ? text === assertion.value : text.includes(assertion.value));
        assertions.push({ kind: assertion.kind, path: assertion.path, passed });
        break;
      }
      case "command": {
        const outcome = await runBenchmarkCommand(assertion, input);
        assertions.push(outcome.assertion);
        if (outcome.error || !outcome.terminationConfirmed) {
          return { verdict: "unscored", assertions, error: outcome.error ?? "The benchmark grader did not confirm termination.",
            terminationConfirmed: outcome.terminationConfirmed };
        }
        break;
      }
    }
  }
  return { verdict: assertions.length > 0 && assertions.every(assertion => assertion.passed) ? "pass" : "fail",
    assertions, terminationConfirmed: true };
}
