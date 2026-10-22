import { describe, expect, it } from "bun:test";
import { benchmarkRecordDigest, compareBenchmarkRuns, renderBenchmarkComparisonHtml } from "../../src/benchmark/compare.ts";
import type { BenchmarkRunRecord, BenchmarkTrial } from "../../src/benchmark/types.ts";

function trial(caseId: string, repetition: number, pass: boolean): BenchmarkTrial {
  return {
    id: `${caseId}-${repetition}`, caseId, repetition,
    result: {
      protocolVersion: 1, status: "completed", output: pass ? "expected" : "other", terminationConfirmed: true,
      durationMs: 10 + repetition * 10,
      activation: { roleId: "example-role", provider: "example-provider", model: "model-name", promptDigest: "c".repeat(64) },
      runtime: { dshVersion: "0.2.1-example", roleboxVersion: "2.0.0" },
      usage: { source: "host", inputTokens: 10, outputTokens: 0, costUsd: null },
    },
    grade: { verdict: pass ? "pass" : "fail", assertions: [{ kind: "equals", passed: pass }] },
  };
}

function run(id: string, outcomes = [true, false, false, false]): BenchmarkRunRecord {
  return {
    schemaVersion: 1, id, suiteId: "example", suiteDigest: "a".repeat(64), roleDigest: "b".repeat(64),
    startedAt: "2026-10-22T00:00:00.000Z", completedAt: "2026-10-22T00:00:01.000Z",
    status: "completed", isolation: "trusted-process", plannedTrials: 4, caseIds: ["one", "two"], repetitions: 2,
    trials: outcomes.map((pass, index) => trial(index < 2 ? "one" : "two", index % 2, pass)),
  };
}

function unscored(record: BenchmarkRunRecord, status: "infra_error" | "cancelled"): void {
  record.status = "incomplete";
  record.trials[0]!.result.status = status;
  record.trials[0]!.grade = { verdict: "unscored", assertions: [] };
}

describe("historical benchmark comparisons", () => {
  it("compares complete role revisions using equal case weighting and ratio deltas", () => {
    const baseline = run("baseline");
    const candidate = run("candidate", [true, true, true, false]);
    candidate.roleDigest = "d".repeat(64);
    candidate.trials.forEach((item) => { item.result.activation!.promptDigest = "e".repeat(64); });
    const comparison = compareBenchmarkRuns(baseline, candidate);
    expect(comparison).toMatchObject({ schemaVersion: 1, mode: "historical", comparable: true, complete: true, successRateDelta: 0.5 });
    expect(comparison.compatibility).toEqual({ status: "comparable", reasons: [] });
    expect(comparison.cases.map((item) => [item.caseId, item.successRateDelta, item.change])).toEqual([
      ["one", 0.5, "improved"], ["two", 0.5, "improved"],
    ]);
    expect(comparison.baseline.summary.successRate).toBe(0.25);
    expect(comparison.candidate.summary.successRate).toBe(0.75);
    expect(comparison.baseline.recordDigest).toBe(benchmarkRecordDigest(baseline));
    expect(comparison.warnings.join(" ")).toContain("not a fresh paired experiment");
    expect(comparison.warnings.join(" ")).toContain("environment variable values");
  });

  it("reports observed regression and unchanged cases without division by a zero baseline", () => {
    const baseline = run("baseline", [false, false, true, true]);
    const candidate = run("candidate", [false, false, false, false]);
    const result = compareBenchmarkRuns(baseline, candidate);
    expect(result.successRateDelta).toBe(-0.5);
    expect(result.cases.map((item) => item.change)).toEqual(["unchanged", "regressed"]);
    const fromZero = compareBenchmarkRuns(candidate, baseline);
    expect(fromZero.successRateDelta).toBe(0.5);
  });

  it("rejects a changed suite and also checks plans independently of a claimed suite digest", () => {
    const candidate = run("candidate");
    candidate.suiteDigest = "d".repeat(64);
    let result = compareBenchmarkRuns(run("baseline"), candidate);
    expect(result.compatibility.status).toBe("incompatible");
    expect(result.successRateDelta).toBeNull();
    expect(result.complete).toBe(true);
    expect(result.cases.every((item) => item.successRateDelta === null)).toBe(true);
    candidate.suiteDigest = "a".repeat(64);
    candidate.caseIds = ["one", "replacement"];
    candidate.trials.forEach((item) => { if (item.caseId === "two") item.caseId = "replacement"; });
    result = compareBenchmarkRuns(run("baseline"), candidate);
    expect(result.compatibility.reasons.join(" ")).toContain("Case plans");
    expect(result.cases.map((item) => item.caseId)).toEqual(["one", "replacement", "two"]);
    expect(result.cases[1]!.baseline).toBeNull();
    expect(result.cases[2]!.candidate).toBeNull();
  });

  it("rejects changed repetition counts and suite IDs", () => {
    const candidate = run("candidate");
    candidate.repetitions = 1;
    candidate.plannedTrials = 2;
    candidate.trials = candidate.trials.filter((item) => item.repetition === 0);
    expect(compareBenchmarkRuns(run("baseline"), candidate).compatibility.status).toBe("incompatible");
    const renamed = run("candidate");
    renamed.suiteId = "other";
    expect(compareBenchmarkRuns(run("baseline"), renamed).compatibility.status).toBe("incompatible");
  });

  it("treats legacy missing runtime evidence as unverified while retaining readable scores", () => {
    const baseline = run("baseline");
    baseline.trials.forEach((item) => { delete item.result.runtime; });
    const result = compareBenchmarkRuns(baseline, run("candidate"));
    expect(result.compatibility.status).toBe("unverified");
    expect(result.comparable).toBe(false);
    expect(result.complete).toBe(true);
    expect(result.baseline.summary.successRate).toBe(0.25);
    expect(result.successRateDelta).toBeNull();
    expect(result.usage.inputTokens.delta).toBeNull();
    expect(result.duration.meanMsDelta).toBeNull();
  });

  it("rejects mixed and changed runtime versions", () => {
    const candidate = run("candidate");
    candidate.trials[0]!.result.runtime!.dshVersion = "0.3.0";
    expect(compareBenchmarkRuns(run("baseline"), candidate).compatibility.reasons.join(" ")).toContain("mixed runtime");
    candidate.trials.forEach((item) => { item.result.runtime!.dshVersion = "0.3.0"; });
    expect(compareBenchmarkRuns(run("baseline"), candidate).compatibility.reasons.join(" ")).toContain("versions differ");
    candidate.trials.forEach((item) => { item.result.runtime!.dshVersion = "0.2.1-example"; item.result.runtime!.roleboxVersion = "2.1.0"; });
    expect(compareBenchmarkRuns(run("baseline"), candidate).compatibility.status).toBe("incompatible");
  });

  it("checks actual observed routing rather than trusting only the suite digest", () => {
    const candidate = run("candidate");
    candidate.trials[0]!.result.activation!.model = "other-model";
    expect(compareBenchmarkRuns(run("baseline"), candidate).compatibility.reasons.join(" ")).toContain("mixed observed");
    candidate.trials.forEach((item) => { item.result.activation!.model = "other-model"; });
    expect(compareBenchmarkRuns(run("baseline"), candidate).compatibility.reasons.join(" ")).toContain("routes differ");
    candidate.trials.forEach((item) => { item.result.activation!.model = "model-name"; item.result.activation!.provider = "other-provider"; });
    expect(compareBenchmarkRuns(run("baseline"), candidate).compatibility.status).toBe("incompatible");
  });

  it("keeps execution failures scored while refusing incomplete overall or case deltas", () => {
    const candidate = run("candidate", [true, true, true, true]);
    candidate.trials[0]!.result.status = "task_failure";
    candidate.trials[0]!.grade = { verdict: "fail", assertions: [] };
    candidate.trials[1]!.result.status = "task_timeout";
    candidate.trials[1]!.grade = { verdict: "fail", assertions: [] };
    expect(compareBenchmarkRuns(run("baseline"), candidate).candidate.summary.successRate).toBe(0.5);
    for (const status of ["infra_error", "cancelled"] as const) {
      const interrupted = structuredClone(candidate);
      unscored(interrupted, status);
      const result = compareBenchmarkRuns(run("baseline"), interrupted);
      expect(result.complete).toBe(false);
      expect(result.successRateDelta).toBeNull();
      expect(result.cases.every((item) => item.successRateDelta === null)).toBe(true);
      expect(result.candidate.summary.unscoredTrials).toBe(1);
    }
    const missing = structuredClone(candidate);
    missing.status = "incomplete";
    missing.trials.pop();
    const result = compareBenchmarkRuns(run("baseline"), missing);
    expect(result.candidate.summary.missingTrials).toBe(1);
    expect(result.successRateDelta).toBeNull();
    expect(result.duration.meanMsDelta).toBeNull();
  });

  it("does not verify an execution route when no model request was observed", () => {
    const candidate = run("candidate");
    candidate.trials.forEach((item) => {
      item.result.status = "task_timeout";
      delete item.result.activation;
      item.grade = { verdict: "fail", assertions: [] };
    });
    const result = compareBenchmarkRuns(run("baseline"), candidate);
    expect(result.complete).toBe(true);
    expect(result.compatibility.status).toBe("unverified");
    expect(result.compatibility.reasons.join(" ")).toContain("no observed provider");
  });

  it("requires complete observations independently for each usage metric and preserves known zero", () => {
    const candidate = run("candidate");
    candidate.trials.forEach((item) => { item.result.usage.inputTokens = 15; });
    let result = compareBenchmarkRuns(run("baseline"), candidate);
    expect(result.usage.inputTokens.delta).toBe(20);
    expect(result.usage.outputTokens.delta).toBe(0);
    expect(result.usage.costUsd.delta).toBeNull();
    expect(result.usage.costUsd.baseline.observed).toBeNull();
    candidate.trials[0]!.result.usage.inputTokens = null;
    result = compareBenchmarkRuns(run("baseline"), candidate);
    expect(result.usage.inputTokens.delta).toBeNull();
    expect(result.usage.inputTokens.candidate).toMatchObject({ observed: 45, knownTrials: 3, unknownTrials: 1, complete: false });
    expect(result.usage.outputTokens.delta).toBe(0);
    candidate.trials.forEach((item) => { item.result.usage = { source: "unavailable", inputTokens: null, outputTokens: null, costUsd: null }; });
    result = compareBenchmarkRuns(run("baseline"), candidate);
    expect(result.usage.inputTokens.candidate.observed).toBeNull();
    expect(result.usage.inputTokens.delta).toBeNull();
  });

  it("includes task timeouts and failures in descriptive worker durations", () => {
    const candidate = run("candidate");
    candidate.trials[0]!.result.durationMs = 100;
    candidate.trials[0]!.result.status = "task_timeout";
    candidate.trials[0]!.grade = { verdict: "fail", assertions: [] };
    const result = compareBenchmarkRuns(run("baseline"), candidate);
    expect(result.duration.baseline).toEqual({ observedTrials: 4, complete: true, meanMs: 15, medianMs: 15, minMs: 10, maxMs: 20 });
    expect(result.duration.candidate.meanMs).toBe(37.5);
    expect(result.duration.candidate.medianMs).toBe(20);
    expect(result.duration.meanMsDelta).toBe(22.5);
    expect(result.duration.medianMsDelta).toBe(5);
    expect(result.warnings.join(" ")).toContain("faster failures");
  });

  it("rejects malformed records and nonfinite aggregated usage", () => {
    const bad = run("candidate");
    bad.trials[0]!.grade.verdict = "fail";
    expect(() => compareBenchmarkRuns(run("baseline"), bad)).toThrow("assertion grade");
    const overflow = run("candidate");
    overflow.trials.forEach((item) => { item.result.usage.costUsd = Number.MAX_VALUE; });
    expect(() => compareBenchmarkRuns(run("baseline"), overflow)).toThrow("numeric range");
  });

  it("marks identical role revisions and distinguishes changed content under the same run ID", () => {
    const baseline = run("same");
    const candidate = run("same", [true, true, true, true]);
    const result = compareBenchmarkRuns(baseline, candidate);
    expect(result.warnings.join(" ")).toContain("same role digest");
    expect(result.warnings.join(" ")).toContain("same run ID has different");
    expect(result.baseline.recordDigest).not.toBe(result.candidate.recordDigest);
  });
});

describe("benchmark record identity", () => {
  it("ignores object, trial and case ordering without mutating the caller", () => {
    const original = run("example");
    const reordered = structuredClone(original);
    reordered.trials.reverse();
    reordered.caseIds.reverse();
    reordered.trials[0]!.result.runtime = { roleboxVersion: "2.0.0", dshVersion: "0.2.1-example" };
    const before = JSON.stringify(reordered);
    expect(benchmarkRecordDigest(reordered)).toBe(benchmarkRecordDigest(original));
    expect(JSON.stringify(reordered)).toBe(before);
    expect(compareBenchmarkRuns(original, reordered).compatibility.status).toBe("comparable");
  });

  it("binds all recorded evidence and normalizes optional undefined properties", () => {
    const original = run("example");
    const changed = structuredClone(original);
    changed.trials[0]!.result.output = "different evidence";
    expect(benchmarkRecordDigest(changed)).not.toBe(benchmarkRecordDigest(original));
    const optional = structuredClone(original);
    optional.trials[0]!.result.diagnostic = undefined;
    expect(benchmarkRecordDigest(optional)).toBe(benchmarkRecordDigest(original));
    expect(benchmarkRecordDigest(JSON.parse(JSON.stringify(optional)))).toBe(benchmarkRecordDigest(original));
  });
});

describe("historical comparison HTML", () => {
  it("renders percentage points, unavailable costs and evidence in offline HTML", () => {
    const comparison = compareBenchmarkRuns(run("baseline"), run("candidate", [true, true, true, false]));
    const html = renderBenchmarkComparisonHtml(comparison);
    expect(html).toContain("+50.0 pp");
    expect(html).toContain("costUsd");
    expect(html).toContain("Unavailable (partial or missing); 0 known, 4 unknown");
    expect(html).toContain(comparison.baseline.recordDigest);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("not a fresh paired experiment");
  });

  it("escapes all text derived from records and comparison diagnostics", () => {
    const baseline = run("<script>baseline</script>");
    const candidate = run("candidate");
    for (const record of [baseline, candidate]) {
      record.suiteId = "<img src=x>";
      record.caseIds[0] = "<svg onload=evil>";
      record.trials.forEach((item) => { if (item.caseId === "one") item.caseId = record.caseIds[0]!; });
    }
    const comparison = compareBenchmarkRuns(baseline, candidate);
    comparison.compatibility.reasons.push("<script>reason</script>");
    comparison.warnings.push("<script>warning</script>");
    const html = renderBenchmarkComparisonHtml(comparison);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<svg");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).toContain("&lt;script&gt;reason&lt;/script&gt;");
    expect(html).toContain("&lt;script&gt;warning&lt;/script&gt;");
  });
});
