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
