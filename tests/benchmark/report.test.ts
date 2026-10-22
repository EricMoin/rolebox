import { describe, expect, it } from "bun:test";
import { parseBenchmarkRunRecord, renderBenchmarkHtml, summarizeBenchmarkRun } from "../../src/benchmark/report.ts";
import type { BenchmarkRunRecord, BenchmarkTrial } from "../../src/benchmark/types.ts";

function trial(caseId: string, repetition: number, pass: boolean): BenchmarkTrial {
  return {
    id: `${caseId}-${repetition}`, caseId, repetition,
    result: { protocolVersion: 1, status: "completed", output: pass ? "hello" : "other", terminationConfirmed: true, durationMs: 10,
      activation: { roleId: "example-role", provider: "example-provider", model: "model-name", promptDigest: "c".repeat(64) },
      usage: { inputTokens: null, outputTokens: null, costUsd: null, source: "unavailable" } },
    grade: { verdict: pass ? "pass" : "fail", assertions: [{ kind: "equals", passed: pass }] },
  };
}

function record(trials: BenchmarkTrial[], overrides: Partial<BenchmarkRunRecord> = {}): BenchmarkRunRecord {
  return { schemaVersion: 1, id: "run-1", suiteId: "example", suiteDigest: "suite-digest", roleDigest: "role-digest", startedAt: "2026-10-22T00:00:00.000Z", completedAt: "2026-10-22T00:00:01.000Z", status: "completed", isolation: "trusted-process", plannedTrials: 4, caseIds: ["one", "two"], repetitions: 2, trials, ...overrides };
}

describe("benchmark reports", () => {
  it("computes success across the complete case plan", () => {
    const summary = summarizeBenchmarkRun(record([trial("one", 1, true), trial("one", 2, true), trial("two", 1, true), trial("two", 2, false)]));
    expect(summary.successRate).toBe(0.75);
    expect(summary.coverage).toBe(1);
    expect(summary.cases.map((item) => item.successRate)).toEqual([1, 0.5]);
    expect(summary.validTrials).toBe(4);
    expect(summary.missingTrials).toBe(0);
  });

  it("uses equal case weighting for observations and refuses an overall score with missing trials", () => {
    const summary = summarizeBenchmarkRun(record([trial("one", 1, true), trial("one", 2, true), trial("two", 1, false)], { status: "incomplete" }));
    expect(summary.observedCaseSuccessRate).toBe(0.5);
    expect(summary.successRate).toBeNull();
    expect(summary.coverage).toBe(0.75);
    expect(summary.missingTrials).toBe(1);
  });

  it("shows entirely missing cases and does not turn infrastructure errors into semantic failures", () => {
    const broken = trial("one", 1, true);
    broken.result.status = "infra_error";
    const summary = summarizeBenchmarkRun(record([broken], { status: "incomplete" }));
    expect(summary.cases[1]).toMatchObject({ caseId: "two", plannedTrials: 2, trials: 0, successRate: null });
    expect(summary.unscoredTrials).toBe(1);
    expect(summary.failedTrials).toBe(0);
    expect(summary.validTrials).toBe(0);
    expect(summary.successRate).toBeNull();
    expect(summary.observedCaseSuccessRate).toBeNull();
    expect(summary.statuses.infra_error).toBe(1);
  });

  it("counts task timeout as failure and ignores an inconsistent pass grade", () => {
    const timedOut = trial("one", 1, true);
    timedOut.result.status = "task_timeout";
    const summary = summarizeBenchmarkRun(record([timedOut], { caseIds: ["one"], repetitions: 1, plannedTrials: 1 }));
    expect(summary.failedTrials).toBe(1);
    expect(summary.successRate).toBe(0);
  });

  it("counts task failure as zero and shows the effective runtime versions", () => {
    const failed = trial("one", 0, true);
    failed.result.status = "task_failure";
    failed.result.runtime = { dshVersion: "0.2.1-example", roleboxVersion: "2.0.0" };
    failed.grade = { verdict: "fail", assertions: [] };
    const run = record([failed], { caseIds: ["one"], repetitions: 1, plannedTrials: 1 });
    const summary = summarizeBenchmarkRun(run);
    expect(summary.successRate).toBe(0);
    expect(summary.statuses.task_failure).toBe(1);
    expect(renderBenchmarkHtml(run)).toContain("Runtime: dsh 0.2.1-example; rolebox 2.0.0");
  });

  it("keeps missing usage unknown and labels partial totals", () => {
    const known = trial("one", 1, true);
    known.result.usage = { source: "host", inputTokens: 12, outputTokens: 0, costUsd: null };
    const summary = summarizeBenchmarkRun(record([known, trial("one", 2, false)], { status: "incomplete" }));
    expect(summary.usage.inputTokens).toEqual({ observed: 12, knownTrials: 1, unknownTrials: 3, complete: false });
    expect(summary.usage.outputTokens.observed).toBe(0);
    expect(summary.usage.costUsd).toEqual({ observed: null, knownTrials: 0, unknownTrials: 4, complete: false });
    expect(renderBenchmarkHtml(record([known], { status: "incomplete" }))).toContain("12 observed (partial)");
  });

  it("does not claim zero usage from a run with no observations", () => {
    const summary = summarizeBenchmarkRun(record([], { status: "running" }));
    expect(summary.usage.inputTokens.observed).toBeNull();
    expect(summary.usage.costUsd.observed).toBeNull();
    expect(summary.usage.costUsd.complete).toBe(false);
  });

  it("escapes titles, case IDs, outputs and diagnostics in standalone HTML", () => {
    const hostile = trial("<script>alert(1)</script>", 1, false);
    hostile.result.output = '<img src=x onerror="alert(2)"> & text';
    hostile.result.diagnostic = "</pre><script>alert('3')</script>";
    const html = renderBenchmarkHtml(record([hostile], { suiteId: "<unsafe>", caseIds: [hostile.caseId], repetitions: 1, plannedTrials: 1 }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;unsafe&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(2)&quot;&gt; &amp; text");
    expect(html).toContain("Content-Security-Policy");
  });
});

describe("benchmark result validation", () => {
  function validRecord(): BenchmarkRunRecord {
    return record([trial("one", 0, true)], { caseIds: ["one"], repetitions: 1, plannedTrials: 1, suiteDigest: "a".repeat(64), roleDigest: "b".repeat(64) });
  }

  it("accepts a complete result and partially observed interrupted records", () => {
    expect(parseBenchmarkRunRecord(validRecord())).toEqual(validRecord());
    const interrupted = { ...validRecord(), status: "incomplete", trials: [], completedAt: undefined };
    expect(parseBenchmarkRunRecord(interrupted).status).toBe("incomplete");
    const failed = validRecord();
    failed.trials[0]!.result.status = "task_failure";
    failed.trials[0]!.result.runtime = { dshVersion: "0.2.1-example", roleboxVersion: "2.0.0" };
    failed.trials[0]!.grade = { verdict: "fail", assertions: [] };
    expect(parseBenchmarkRunRecord(failed).trials[0]!.result.runtime).toEqual(failed.trials[0]!.result.runtime);
  });

  it("rejects unknown schemas and invalid measured quantities", () => {
    expect(() => parseBenchmarkRunRecord({ ...validRecord(), schemaVersion: 2 })).toThrow("schema");
    const corrupt = validRecord();
    corrupt.trials[0]!.result.usage.costUsd = -1;
    expect(() => parseBenchmarkRunRecord(corrupt)).toThrow("schema");
    corrupt.trials[0]!.result.usage.costUsd = 0;
    expect(() => parseBenchmarkRunRecord(corrupt)).toThrow("usage provenance");
  });

  it("rejects duplicate, out-of-range or unplanned trial identities", () => {
    const duplicate = validRecord();
    duplicate.trials.push({ ...duplicate.trials[0]!, id: "another" });
    expect(() => parseBenchmarkRunRecord(duplicate)).toThrow("duplicate or unplanned");
    const range = validRecord();
    range.trials[0]!.repetition = 1;
    expect(() => parseBenchmarkRunRecord(range)).toThrow("duplicate or unplanned");
    const unplanned = validRecord();
    unplanned.trials[0]!.caseId = "other";
    expect(() => parseBenchmarkRunRecord(unplanned)).toThrow("duplicate or unplanned");
    expect(() => parseBenchmarkRunRecord({ ...validRecord(), plannedTrials: 2 })).toThrow("inconsistent trial plan");
  });

  it("rejects contradictory grades and false completion claims", () => {
    const changed = validRecord();
    changed.trials[0]!.grade.assertions[0]!.passed = false;
    expect(() => parseBenchmarkRunRecord(changed)).toThrow("inconsistent assertion grade");
    const infra = validRecord();
    infra.trials[0]!.result.status = "infra_error";
    expect(() => parseBenchmarkRunRecord(infra)).toThrow("inconsistent with execution status");
    expect(() => parseBenchmarkRunRecord({ ...validRecord(), trials: [] })).toThrow("claims completion");
    const unconfirmed = validRecord();
    unconfirmed.trials[0]!.result.status = "task_timeout";
    unconfirmed.trials[0]!.result.terminationConfirmed = false;
    unconfirmed.trials[0]!.grade = { verdict: "fail", assertions: [] };
    expect(() => parseBenchmarkRunRecord(unconfirmed)).toThrow("claims completion");
    const missingActivation = validRecord();
    delete missingActivation.trials[0]!.result.activation;
    expect(() => parseBenchmarkRunRecord(missingActivation)).toThrow("without activation evidence");
  });
});

describe("benchmark workspace result evidence", () => {
  function workspaceRecord(): BenchmarkRunRecord {
    const value = trial("repair", 0, true);
    value.workspace = {
      fixtureDigest: "d".repeat(64), resultDigest: "e".repeat(64), artifactDirectory: `artifacts/${value.id}/workspace`,
      changes: [
        { path: "src/sum.mjs", kind: "modified", beforeDigest: "1".repeat(64), afterDigest: "2".repeat(64),
          beforeText: "export const sum = () => -1;", afterText: "export const sum = () => 0;",
          beforeExecutable: false, afterExecutable: true, contentOmitted: false },
        { path: "result.bin", kind: "added", beforeDigest: null, afterDigest: "3".repeat(64),
          beforeText: null, afterText: null, beforeExecutable: null, afterExecutable: false, contentOmitted: true },
        { path: "obsolete.txt", kind: "deleted", beforeDigest: "4".repeat(64), afterDigest: null,
          beforeText: "obsolete", afterText: null, beforeExecutable: false, afterExecutable: null, contentOmitted: false },
      ],
    };
    value.grade = { verdict: "pass", terminationConfirmed: true, assertions: [
      { kind: "file_exists", path: "src/sum.mjs", passed: true },
      { kind: "file_equals", path: "src/sum.mjs", passed: true },
      { kind: "file_contains", path: "src/sum.mjs", passed: true },
      { kind: "command", passed: true, command: { status: "completed", exitCode: 0, stdout: "All checks passed",
        stderr: "", durationMs: 12, terminationConfirmed: true, truncated: false } },
    ] };
    return record([value], { caseIds: ["repair"], repetitions: 1, plannedTrials: 1,
      suiteDigest: "a".repeat(64), roleDigest: "b".repeat(64) });
  }

  it("preserves file changes and command evidence through validation and offline HTML", () => {
    const original = workspaceRecord();
    const parsed = parseBenchmarkRunRecord(JSON.parse(JSON.stringify(original)));
    expect(parsed).toEqual(original);
    expect(summarizeBenchmarkRun(parsed)).toMatchObject({ successRate: 1, coverage: 1, passedTrials: 1, unscoredTrials: 0 });
    const html = renderBenchmarkHtml(parsed);
    expect(html).toContain("Workspace changes");
    expect(html).toContain("artifacts/repair-0/workspace");
    expect(html).toContain("src/sum.mjs · modified");
    expect(html).toContain("result.bin · added");
    expect(html).toContain("obsolete.txt · deleted");
    expect(html).toContain("Executable: false → true");
    expect(html).toContain("export const sum = () =&gt; -1;");
    expect(html).toContain("export const sum = () =&gt; 0;");
    expect(html).toContain("Binary or oversized content omitted");
    expect(html).toContain("Command: completed; exit code: 0; 12 ms; cleanup confirmed: yes");
    expect(html).toContain("All checks passed");
  });

  it("rejects missing or misplaced assertion evidence", () => {
    const mutations: Array<(value: BenchmarkTrial) => void> = [
      value => { delete value.grade.assertions[0]!.path; },
      value => { delete value.grade.assertions[3]!.command; },
      value => { value.grade.assertions[0]!.command = value.grade.assertions[3]!.command; },
      value => { value.grade.assertions[3]!.path = "src/sum.mjs"; },
      value => { value.grade.assertions[0]!.path = "../outside"; },
      value => { value.grade.assertions[3]!.command!.exitCode = null; },
      value => { value.grade.assertions[3]!.command!.status = "timeout"; },
      value => { value.grade.assertions[3]!.command!.terminationConfirmed = false; },
    ];
    for (const mutate of mutations) {
      const run = workspaceRecord();
      mutate(run.trials[0]!);
      expect(() => parseBenchmarkRunRecord(run)).toThrow();
    }
  });

  it("requires captured workspace evidence for file and command grades", () => {
    for (const kind of ["file_exists", "command"] as const) {
      const run = workspaceRecord();
      const value = run.trials[0]!;
      value.grade.assertions = value.grade.assertions.filter(assertion => assertion.kind === kind);
      delete value.workspace;
      expect(() => parseBenchmarkRunRecord(run)).toThrow();
    }
  });

  it("refuses workspace evidence from failed or unconfirmed model executions", () => {
    const failed = workspaceRecord();
    failed.trials[0]!.result.status = "task_failure";
    failed.trials[0]!.grade = { verdict: "fail", assertions: [] };
    expect(() => parseBenchmarkRunRecord(failed)).toThrow();
    const unconfirmed = workspaceRecord();
    unconfirmed.status = "incomplete";
    unconfirmed.trials[0]!.result.terminationConfirmed = false;
    unconfirmed.trials[0]!.grade = { verdict: "unscored", assertions: [] };
    expect(() => parseBenchmarkRunRecord(unconfirmed)).toThrow();
  });

  it("rejects contradictory workspace identity and file states", () => {
    const mutations: Array<(value: BenchmarkTrial) => void> = [
      value => { value.workspace!.artifactDirectory = "artifacts/another-trial/workspace"; },
      value => { value.workspace!.artifactDirectory = "../workspace"; },
      value => { value.workspace!.changes.push({ ...value.workspace!.changes[0]! }); },
      value => { value.workspace!.changes[0]!.path = "../../outside"; },
      value => { value.workspace!.changes[0]!.kind = "added"; },
      value => { value.workspace!.changes[0]!.beforeExecutable = null; },
      value => { value.workspace!.changes[0]!.afterExecutable = null; },
      value => { value.workspace!.changes[1]!.beforeText = "unexpected prior content"; },
      value => { value.workspace!.changes[2]!.afterExecutable = false; },
    ];
    for (const mutate of mutations) {
      const run = workspaceRecord();
      mutate(run.trials[0]!);
      expect(() => parseBenchmarkRunRecord(run)).toThrow();
    }
  });

  it("keeps grader errors unscored even after successful model execution", () => {
    for (const confirmed of [true, false]) {
      const run = workspaceRecord();
      run.status = "incomplete";
      const value = run.trials[0]!;
      value.grade.verdict = "unscored";
      value.grade.error = confirmed ? "The checker could not start" : "Checker cleanup could not be confirmed";
      value.grade.terminationConfirmed = confirmed;
      const command = value.grade.assertions[3]!;
      command.passed = false;
      Object.assign(command.command!, { status: "error", exitCode: null, terminationConfirmed: confirmed });
      const parsed = parseBenchmarkRunRecord(run);
      expect(summarizeBenchmarkRun(parsed)).toMatchObject({ successRate: null, observedCaseSuccessRate: null,
        coverage: 0, validTrials: 0, failedTrials: 0, unscoredTrials: 1, statuses: { completed: 1 } });
      expect(renderBenchmarkHtml(parsed)).toContain("Grading error (unscored)");
      expect(() => parseBenchmarkRunRecord({ ...run, status: "completed" })).toThrow("claims completion");
      value.grade.verdict = "fail";
      expect(() => parseBenchmarkRunRecord(run)).toThrow("grading errors must remain unscored");
    }
  });

  it("scores a confirmed command timeout as failure without inventing a model failure", () => {
    const run = workspaceRecord();
    const value = run.trials[0]!;
    value.grade.verdict = "fail";
    value.grade.assertions[3]!.passed = false;
    Object.assign(value.grade.assertions[3]!.command!, { status: "timeout", exitCode: null, truncated: true });
    const parsed = parseBenchmarkRunRecord(run);
    expect(summarizeBenchmarkRun(parsed)).toMatchObject({ successRate: 0, coverage: 1, failedTrials: 1,
      unscoredTrials: 0, statuses: { completed: 1, task_timeout: 0 } });
    const html = renderBenchmarkHtml(parsed);
    expect(html).toContain("Command: timeout; exit code: unavailable");
    expect(html).toContain("output truncated");
  });

  it("escapes file paths, before/after content, and grader output and errors", () => {
    const run = workspaceRecord();
    run.status = "incomplete";
    const value = run.trials[0]!;
    const path = 'src/<img onerror="alert(1)">.mjs';
    value.workspace!.changes[0]!.path = path;
    value.workspace!.changes[0]!.beforeText = "</pre><script>alert('before')</script>";
    value.workspace!.changes[0]!.afterText = '<svg onload="alert(2)"> & result';
    value.grade.assertions[0]!.path = path;
    value.grade.verdict = "unscored";
    value.grade.error = "<script>alert('grader')</script>";
    const command = value.grade.assertions[3]!;
    command.passed = false;
    Object.assign(command.command!, { status: "error", exitCode: null,
      stdout: '<img src=x onerror="alert(3)">', stderr: "</pre><script>alert('stderr')</script>" });
    const html = renderBenchmarkHtml(parseBenchmarkRunRecord(run));
    for (const raw of ["<img", "<script", "<svg"]) expect(html).not.toContain(raw);
    expect(html).toContain("src/&lt;img onerror=&quot;alert(1)&quot;&gt;.mjs");
    expect(html).toContain("&lt;/pre&gt;&lt;script&gt;alert(&#39;before&#39;)&lt;/script&gt;");
    expect(html).toContain("&lt;svg onload=&quot;alert(2)&quot;&gt; &amp; result");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(3)&quot;&gt;");
    expect(html).toContain("&lt;/pre&gt;&lt;script&gt;alert(&#39;stderr&#39;)&lt;/script&gt;");
    expect(html).toContain("Grading error (unscored): &lt;script&gt;alert(&#39;grader&#39;)&lt;/script&gt;");
  });
});
