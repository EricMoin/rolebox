import { createHash } from "node:crypto";
import { parseBenchmarkRunRecord, summarizeBenchmarkRun, type BenchmarkCaseSummary, type BenchmarkRunSummary, type BenchmarkUsageSummary } from "./report.ts";
import type { BenchmarkRunRecord } from "./types.ts";

export interface BenchmarkComparisonSide {
  runId: string;
  recordDigest: string;
  suiteId: string;
  suiteDigest: string;
  roleDigest: string;
  startedAt: string;
  status: BenchmarkRunRecord["status"];
  summary: BenchmarkRunSummary;
}

export interface BenchmarkCaseComparison {
  caseId: string;
  baseline: BenchmarkCaseSummary | null;
  candidate: BenchmarkCaseSummary | null;
  successRateDelta: number | null;
  change: "improved" | "regressed" | "unchanged" | "not_compared";
}

export interface BenchmarkUsageComparison {
  baseline: BenchmarkUsageSummary;
  candidate: BenchmarkUsageSummary;
  delta: number | null;
}

export interface BenchmarkDurationSummary {
  observedTrials: number;
  complete: boolean;
  meanMs: number | null;
  medianMs: number | null;
  minMs: number | null;
  maxMs: number | null;
}

export interface BenchmarkComparison {
  schemaVersion: 1;
  mode: "historical";
  comparable: boolean;
  compatibility: { status: "comparable" | "incompatible" | "unverified"; reasons: string[] };
  complete: boolean;
  baseline: BenchmarkComparisonSide;
  candidate: BenchmarkComparisonSide;
  successRateDelta: number | null;
  cases: BenchmarkCaseComparison[];
  usage: Record<"inputTokens" | "outputTokens" | "costUsd", BenchmarkUsageComparison>;
  duration: {
    baseline: BenchmarkDurationSummary;
    candidate: BenchmarkDurationSummary;
    meanMsDelta: number | null;
    medianMsDelta: number | null;
  };
  warnings: string[];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function benchmarkRecordDigest(record: BenchmarkRunRecord): string {
  const validated = parseBenchmarkRunRecord(record);
  validated.caseIds.sort(compareStrings);
  validated.trials.sort((left, right) => compareStrings(left.caseId, right.caseId)
    || left.repetition - right.repetition || compareStrings(left.id, right.id));
  return createHash("sha256").update(canonical(validated)).digest("hex");
}

function side(record: BenchmarkRunRecord): BenchmarkComparisonSide {
  const summary = summarizeBenchmarkRun(record);
  for (const item of Object.values(summary.usage)) {
    if (item.observed !== null && !Number.isFinite(item.observed)) {
      throw new Error("Benchmark usage totals exceed the supported numeric range");
    }
  }
  return {
    runId: record.id, recordDigest: benchmarkRecordDigest(record), suiteId: record.suiteId,
    suiteDigest: record.suiteDigest, roleDigest: record.roleDigest, startedAt: record.startedAt,
    status: record.status, summary,
  };
}

function duration(record: BenchmarkRunRecord, complete: boolean): BenchmarkDurationSummary {
  const values = record.trials.map((trial) => trial.result.durationMs).sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  return {
    observedTrials: values.length, complete,
    meanMs: values.length ? values.reduce((mean, value, index) => mean + (value - mean) / (index + 1), 0) : null,
    medianMs: values.length ? values.length % 2 ? values[middle]! : values[middle - 1]! / 2 + values[middle]! / 2 : null,
    minMs: values[0] ?? null, maxMs: values[values.length - 1] ?? null,
  };
}

function compatibility(baseline: BenchmarkRunRecord, candidate: BenchmarkRunRecord): BenchmarkComparison["compatibility"] {
  const incompatible: string[] = [];
  const unverified: string[] = [];
  if (baseline.suiteId !== candidate.suiteId || baseline.suiteDigest !== candidate.suiteDigest) {
    incompatible.push("Suite identity or frozen non-role conditions differ.");
  }
  if (baseline.isolation !== candidate.isolation) incompatible.push("Execution isolation differs.");
  if (baseline.repetitions !== candidate.repetitions || baseline.plannedTrials !== candidate.plannedTrials
    || canonical([...baseline.caseIds].sort(compareStrings)) !== canonical([...candidate.caseIds].sort(compareStrings))) {
    incompatible.push("Case plans or repetition counts differ.");
  }
  const runtimes: Set<string>[] = [];
  const routes: Set<string>[] = [];
  for (const [label, record] of [["Baseline", baseline], ["Candidate", candidate]] as const) {
    const runtime = new Set(record.trials.flatMap((trial) => trial.result.runtime ? [canonical(trial.result.runtime)] : []));
    const route = new Set(record.trials.flatMap((trial) => trial.result.activation
      ? [canonical({ provider: trial.result.activation.provider, model: trial.result.activation.model })] : []));
    runtimes.push(runtime);
    routes.push(route);
    if (runtime.size > 1) incompatible.push(`${label} contains mixed runtime versions.`);
    if (route.size > 1) incompatible.push(`${label} contains mixed observed provider or model routes.`);
    if (!record.trials.length || record.trials.some((trial) => !trial.result.runtime)) {
      unverified.push(`${label} has missing runtime version evidence.`);
    }
    if (!route.size) unverified.push(`${label} has no observed provider or model route.`);
  }
  if (runtimes[0]!.size === 1 && runtimes[1]!.size === 1 && [...runtimes[0]!][0] !== [...runtimes[1]!][0]) {
    incompatible.push("Recorded dsh or rolebox runtime versions differ.");
  }
  if (routes[0]!.size === 1 && routes[1]!.size === 1 && [...routes[0]!][0] !== [...routes[1]!][0]) {
    incompatible.push("Observed provider or model routes differ.");
  }
  return {
    status: incompatible.length ? "incompatible" : unverified.length ? "unverified" : "comparable",
    reasons: [...incompatible, ...unverified],
  };
}

export function compareBenchmarkRuns(baselineRecord: BenchmarkRunRecord, candidateRecord: BenchmarkRunRecord): BenchmarkComparison {
  const baselineRun = parseBenchmarkRunRecord(baselineRecord);
  const candidateRun = parseBenchmarkRunRecord(candidateRecord);
  const baseline = side(baselineRun);
  const candidate = side(candidateRun);
  const conditions = compatibility(baselineRun, candidateRun);
  const comparable = conditions.status === "comparable";
  const complete = baseline.summary.successRate !== null && candidate.summary.successRate !== null;
  const canCompare = comparable && complete;
  const baselineCases = new Map(baseline.summary.cases.map((item) => [item.caseId, item]));
  const candidateCases = new Map(candidate.summary.cases.map((item) => [item.caseId, item]));
  const caseIds = [...new Set([...baselineRun.caseIds, ...candidateRun.caseIds])].sort(compareStrings);
  const cases: BenchmarkCaseComparison[] = caseIds.map((caseId) => {
    const before = baselineCases.get(caseId) ?? null;
    const after = candidateCases.get(caseId) ?? null;
    const delta = canCompare && before && after && before.successRate !== null && after.successRate !== null
      ? after.successRate - before.successRate : null;
    return {
      caseId, baseline: before, candidate: after, successRateDelta: delta,
      change: delta === null ? "not_compared" : delta > 0 ? "improved" : delta < 0 ? "regressed" : "unchanged",
    };
  });
  function usage(key: "inputTokens" | "outputTokens" | "costUsd"): BenchmarkUsageComparison {
    const before = baseline.summary.usage[key];
    const after = candidate.summary.usage[key];
    return { baseline: before, candidate: after, delta: canCompare && before.complete && after.complete
      && before.observed !== null && after.observed !== null ? after.observed - before.observed : null };
  }
  const beforeDuration = duration(baselineRun, baseline.summary.successRate !== null);
  const afterDuration = duration(candidateRun, candidate.summary.successRate !== null);
  const warnings = [
    "Historical results are descriptive observations, not a fresh paired experiment, causal evidence, a significance test, or a CI regression gate.",
    "Matching recorded conditions do not freeze server-side models, external services, environment variable values, or the complete host and plugin dependency tree.",
    "Durations include host startup, task execution, and cleanup for all recorded trials, including failures and timeouts; faster failures do not demonstrate improved quality.",
  ];
  if (!complete) warnings.push("At least one run is incomplete. Observed scores and partial usage totals must not be treated as overall comparison results.");
  if (!comparable) warnings.push("Comparison deltas are unavailable until recorded conditions are verified as compatible.");
  if (baseline.roleDigest === candidate.roleDigest) warnings.push("Both runs use the same role digest; differences represent repeated observations of the same role revision.");
  if (baseline.runId === candidate.runId && baseline.recordDigest !== candidate.recordDigest) {
    warnings.push("The same run ID has different record contents; record digests identify the exact observations used here.");
  }
  return {
    schemaVersion: 1, mode: "historical", comparable, compatibility: conditions, complete, baseline, candidate,
    successRateDelta: canCompare ? candidate.summary.successRate! - baseline.summary.successRate! : null,
    cases, usage: { inputTokens: usage("inputTokens"), outputTokens: usage("outputTokens"), costUsd: usage("costUsd") },
    duration: { baseline: beforeDuration, candidate: afterDuration,
      meanMsDelta: canCompare ? afterDuration.meanMs! - beforeDuration.meanMs! : null,
      medianMsDelta: canCompare ? afterDuration.medianMs! - beforeDuration.medianMs! : null },
    warnings,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function number(value: number | null): string {
  return value === null ? "Unavailable" : value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function percent(value: number | null): string {
  return value === null ? "Unavailable" : `${(value * 100).toFixed(1)}%`;
}

function percentagePoints(value: number | null): string {
  return value === null ? "Unavailable" : `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)} pp`;
}

function renderSide(side: BenchmarkComparisonSide, title: string): string {
  const summary = side.summary;
  return `<section><h2>${title}</h2><p>Run <code>${escapeHtml(side.runId)}</code> · ${escapeHtml(side.status)} · ${escapeHtml(side.startedAt)}</p>
<dl><dt>Suite</dt><dd>${escapeHtml(side.suiteId)}</dd><dt>Record digest</dt><dd><code>${escapeHtml(side.recordDigest)}</code></dd>
<dt>Suite digest</dt><dd><code>${escapeHtml(side.suiteDigest)}</code></dd><dt>Role digest</dt><dd><code>${escapeHtml(side.roleDigest)}</code></dd>
<dt>Overall success</dt><dd>${percent(summary.successRate)}</dd><dt>Observed case success</dt><dd>${percent(summary.observedCaseSuccessRate)}${summary.successRate === null ? " (partial observations)" : ""}</dd>
<dt>Scored coverage</dt><dd>${summary.validTrials}/${summary.plannedTrials}; ${summary.unscoredTrials} unscored; ${summary.missingTrials} missing</dd>
<dt>Execution states</dt><dd>${Object.entries(summary.statuses).map(([status, count]) => `${escapeHtml(status)}: ${count}`).join("; ")}</dd></dl></section>`;
}

function renderUsage(value: BenchmarkUsageSummary): string {
  return `${number(value.observed)}${value.complete ? "" : " (partial or missing)"}; ${value.knownTrials} known, ${value.unknownTrials} unknown`;
}

function renderDuration(value: BenchmarkDurationSummary): string {
  return `${value.observedTrials} observed${value.complete ? "" : " (partial)"}; mean ${number(value.meanMs)} ms; median ${number(value.medianMs)} ms; range ${number(value.minMs)}–${number(value.maxMs)} ms`;
}

function renderCase(value: BenchmarkCaseSummary | null): string {
  return value ? `${percent(value.successRate)} (${value.passed}/${value.passed + value.failed} scored passed; ${value.trials}/${value.plannedTrials} recorded)` : "Unavailable";
}

export function renderBenchmarkComparisonHtml(comparison: BenchmarkComparison): string {
  const caseRows = comparison.cases.map((item) => `<tr><td>${escapeHtml(item.caseId)}</td><td>${renderCase(item.baseline)}</td><td>${renderCase(item.candidate)}</td><td>${percentagePoints(item.successRateDelta)}</td><td>${item.change === "not_compared" ? "Not compared" : escapeHtml(item.change)}</td></tr>`).join("\n");
  const usageRows = Object.entries(comparison.usage).map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${renderUsage(value.baseline)}</td><td>${renderUsage(value.candidate)}</td><td>${number(value.delta)}</td></tr>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Historical benchmark comparison</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:1100px;margin:3rem auto;padding:0 1.5rem;color:#182030;background:#fafbfc}h1,h2{line-height:1.2}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{text-align:left;padding:.5rem;border-bottom:1px solid #ccd2dc}dt{font-weight:600}dd{margin:0 0 .75rem}code{overflow-wrap:anywhere}.runs{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:2rem}</style></head><body>
<h1>Historical benchmark comparison</h1><p>Conditions: ${escapeHtml(comparison.compatibility.status)}. Both runs complete: ${comparison.complete ? "yes" : "no"}.</p>
<p>Overall task success change (candidate − baseline, equal weight per case): <strong>${percentagePoints(comparison.successRateDelta)}</strong>.</p>
<ul>${comparison.compatibility.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}${comparison.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>
<div class="runs">${renderSide(comparison.baseline, "Baseline")}${renderSide(comparison.candidate, "Candidate")}</div>
<h2>Cases</h2><p>Side scores are observed pass rates; deltas require two complete runs with verified compatible conditions.</p><table><thead><tr><th>Case</th><th>Baseline</th><th>Candidate</th><th>Change</th><th>Observation</th></tr></thead><tbody>${caseRows}</tbody></table>
<h2>Usage totals</h2><p>A delta requires complete observations for that metric on both sides.</p><table><thead><tr><th>Metric</th><th>Baseline</th><th>Candidate</th><th>Candidate − baseline</th></tr></thead><tbody>${usageRows}</tbody></table>
<h2>Worker durations</h2><p>Baseline: ${renderDuration(comparison.duration.baseline)}.</p><p>Candidate: ${renderDuration(comparison.duration.candidate)}.</p><p>Mean change: ${number(comparison.duration.meanMsDelta)} ms; median change: ${number(comparison.duration.medianMsDelta)} ms.</p>
</body></html>`;
}
