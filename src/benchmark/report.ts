import { z } from "zod";
import type { BenchmarkGrade, BenchmarkRunRecord, BenchmarkTrial, BenchmarkUsage, BenchmarkWorkerResult } from "./types.ts";
import { safeBenchmarkRelativePath } from "./workspace.ts";

const recordName = z.string().min(1).max(128);
const quantity = z.number().finite().nonnegative();
const usageSchema = z.object({
  inputTokens: quantity.int().nullable(), outputTokens: quantity.int().nullable(), costUsd: quantity.nullable(),
  source: z.enum(["host", "unavailable"]),
}).strict();
const safePath = z.string().max(4096).refine(safeBenchmarkRelativePath);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const assertionResultSchema = z.object({
  kind: z.enum(["equals", "contains", "file_exists", "file_equals", "file_contains", "command"]), passed: z.boolean(), path: safePath.optional(),
  command: z.object({ status: z.enum(["completed", "timeout", "error", "cancelled"]), exitCode: z.number().int().min(0).max(255).nullable(),
    stdout: z.string().max(16_384), stderr: z.string().max(16_384), durationMs: quantity,
    terminationConfirmed: z.boolean(), truncated: z.boolean() }).strict().optional(),
}).strict();
const workspaceSchema = z.object({
  fixtureDigest: digest, resultDigest: digest, artifactDirectory: safePath,
  changes: z.array(z.object({ path: safePath, kind: z.enum(["added", "modified", "deleted"]),
    beforeDigest: digest.nullable(), afterDigest: digest.nullable(), beforeText: z.string().max(16_384).nullable(), afterText: z.string().max(16_384).nullable(),
    beforeExecutable: z.boolean().nullable(), afterExecutable: z.boolean().nullable(), contentOmitted: z.boolean() }).strict()).max(2_000),
}).strict();
const runSchema = z.object({
  schemaVersion: z.literal(1), id: recordName, suiteId: recordName,
  suiteDigest: z.string().regex(/^[0-9a-f]{64}$/), roleDigest: z.string().regex(/^[0-9a-f]{64}$/),
  startedAt: z.string().datetime(), completedAt: z.string().datetime().optional(),
  status: z.enum(["running", "completed", "incomplete"]), isolation: z.literal("trusted-process"),
  plannedTrials: z.number().int().min(1).max(20_000),
  caseIds: z.array(recordName).min(1).max(1_000), repetitions: z.number().int().min(1).max(20),
  trials: z.array(z.object({
    id: recordName, caseId: recordName, repetition: z.number().int().nonnegative(),
    result: z.object({
      protocolVersion: z.literal(1), status: z.enum(["completed", "task_failure", "task_timeout", "infra_error", "invalid", "cancelled"]),
      output: z.string().max(4_194_304),
      activation: z.object({ roleId: recordName, provider: z.string().min(1).max(4_096), model: z.string().min(1).max(4_096), promptDigest: z.string().regex(/^[0-9a-f]{64}$/) }).strict().optional(),
      runtime: z.object({ dshVersion: recordName, roleboxVersion: recordName }).strict().optional(),
      usage: usageSchema, durationMs: quantity, terminationConfirmed: z.boolean(), diagnostic: z.string().max(65_536).optional(),
    }).strict(),
    grade: z.object({ verdict: z.enum(["pass", "fail", "unscored"]), assertions: z.array(assertionResultSchema).max(64),
      error: z.string().min(1).max(4096).optional(), terminationConfirmed: z.boolean().optional() }).strict(),
    workspace: workspaceSchema.optional(),
  }).strict()).max(20_000),
}).strict();

export function parseBenchmarkRunRecord(value: unknown): BenchmarkRunRecord {
  const parsed = runSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid or unsupported benchmark result schema");
  const run = parsed.data;
  const caseIds = new Set(run.caseIds);
  if (caseIds.size !== run.caseIds.length || run.plannedTrials !== run.caseIds.length * run.repetitions) {
    throw new Error("Benchmark result has an inconsistent trial plan");
  }
  const trialIds = new Set<string>();
  const trialKeys = new Set<string>();
  for (const trial of run.trials) {
    const key = JSON.stringify([trial.caseId, trial.repetition]);
    if (!caseIds.has(trial.caseId) || trial.repetition >= run.repetitions || trialIds.has(trial.id) || trialKeys.has(key)) {
      throw new Error("Benchmark result has duplicate or unplanned trials");
    }
    trialIds.add(trial.id);
    trialKeys.add(key);
    const { result, grade } = trial;
    if (grade.assertions.some(assertion => assertion.kind.startsWith("file_") || assertion.kind === "command") && !trial.workspace) {
      throw new Error("Benchmark workspace assertions require captured workspace evidence");
    }
    for (const assertion of grade.assertions) {
      if (assertion.kind.startsWith("file_") !== (assertion.path !== undefined)
        || (assertion.kind === "command") !== (assertion.command !== undefined)) throw new Error("Benchmark assertion evidence does not match its kind");
      const command = assertion.command;
      if (command && ((command.status !== "completed" && assertion.passed)
        || (command.status === "completed" && command.exitCode === null)
        || (["error", "cancelled"].includes(command.status) && !grade.error)
        || (!command.terminationConfirmed && grade.terminationConfirmed !== false))) throw new Error("Benchmark command grading evidence is inconsistent");
    }
    if (trial.workspace) {
      if (result.status !== "completed" || !result.terminationConfirmed) throw new Error("Benchmark workspace evidence requires confirmed task completion");
      if (trial.workspace.artifactDirectory !== `artifacts/${trial.id}/workspace`
        || new Set(trial.workspace.changes.map(change => change.path)).size !== trial.workspace.changes.length) throw new Error("Benchmark workspace evidence has invalid identity");
      for (const change of trial.workspace.changes) {
        if ((change.kind === "added") !== (change.beforeDigest === null)
          || (change.kind === "deleted") !== (change.afterDigest === null)
          || (change.beforeDigest === null) !== (change.beforeExecutable === null)
          || (change.afterDigest === null) !== (change.afterExecutable === null)
          || (change.beforeDigest === null && (change.beforeText !== null || change.beforeExecutable !== null))
          || (change.afterDigest === null && (change.afterText !== null || change.afterExecutable !== null))) throw new Error("Benchmark workspace change evidence is inconsistent");
      }
    }
    if (result.status === "completed" && !result.activation) {
      throw new Error("Benchmark result claims completion without activation evidence");
    }
    if (result.usage.source === "unavailable" && [result.usage.inputTokens, result.usage.outputTokens, result.usage.costUsd].some((quantity) => quantity !== null)) {
      throw new Error("Benchmark result has inconsistent usage provenance");
    }
    if (grade.error !== undefined || grade.terminationConfirmed === false) {
      if (!grade.error || grade.verdict !== "unscored") throw new Error("Benchmark grading errors must remain unscored");
    } else if (result.status === "completed" && result.terminationConfirmed) {
      if (!grade.assertions.length || grade.verdict !== (grade.assertions.every((assertion) => assertion.passed) ? "pass" : "fail")) {
        throw new Error("Benchmark result has an inconsistent assertion grade");
      }
    } else if (grade.assertions.length || grade.verdict !== (["task_timeout", "task_failure"].includes(result.status) ? "fail" : "unscored")) {
      throw new Error("Benchmark result has a grade inconsistent with execution status");
    }
  }
  if (run.status === "completed" && (run.trials.length !== run.plannedTrials || run.trials.some((trial) => trial.grade.verdict === "unscored" || trial.grade.terminationConfirmed === false || !trial.result.terminationConfirmed) || !run.completedAt)) {
    throw new Error("Benchmark result claims completion without complete scored observations");
  }
  return run;
}

export interface BenchmarkCaseSummary {
  caseId: string;
  plannedTrials: number;
  trials: number;
  passed: number;
  failed: number;
  unscored: number;
  successRate: number | null;
}

export interface BenchmarkUsageSummary {
  observed: number | null;
  knownTrials: number;
  unknownTrials: number;
  complete: boolean;
}

export interface BenchmarkRunSummary {
  plannedTrials: number;
  recordedTrials: number;
  validTrials: number;
  passedTrials: number;
  failedTrials: number;
  unscoredTrials: number;
  missingTrials: number;
  coverage: number;
  successRate: number | null;
  observedCaseSuccessRate: number | null;
  statuses: Record<BenchmarkWorkerResult["status"], number>;
  cases: BenchmarkCaseSummary[];
  usage: Record<"inputTokens" | "outputTokens" | "costUsd", BenchmarkUsageSummary>;
}

function usageSummary(run: BenchmarkRunRecord, key: "inputTokens" | "outputTokens" | "costUsd"): BenchmarkUsageSummary {
  const known = run.trials.map((trial) => trial.result.usage)
    .filter((usage): usage is BenchmarkUsage & Record<typeof key, number> =>
      usage.source === "host" && typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key]! >= 0);
  const unknownTrials = Math.max(run.plannedTrials, run.trials.length) - known.length;
  return {
    observed: known.length ? known.reduce((sum, usage) => sum + usage[key], 0) : null,
    knownTrials: known.length,
    unknownTrials,
    complete: run.status === "completed" && unknownTrials === 0,
  };
}

function verdict(trial: BenchmarkTrial): "pass" | "fail" | "unscored" {
  if (trial.grade.error || trial.grade.terminationConfirmed === false) return "unscored";
  if (trial.result.status === "task_timeout" || trial.result.status === "task_failure") return "fail";
  if (trial.result.status !== "completed" || !trial.result.terminationConfirmed) return "unscored";
  return trial.grade.verdict;
}

export function summarizeBenchmarkRun(run: BenchmarkRunRecord): BenchmarkRunSummary {
  const statuses: BenchmarkRunSummary["statuses"] = { completed: 0, task_failure: 0, task_timeout: 0, infra_error: 0, invalid: 0, cancelled: 0 };
  const byCase = new Map<string, BenchmarkCaseSummary>(run.caseIds.map((caseId) => [caseId, {
    caseId, plannedTrials: run.repetitions, trials: 0, passed: 0, failed: 0, unscored: 0, successRate: null,
  }]));
  for (const trial of run.trials) {
    statuses[trial.result.status] += 1;
    const item = byCase.get(trial.caseId);
    if (!item) throw new Error("Benchmark run contains a trial outside its case plan");
    item.trials += 1;
    const grade = verdict(trial);
    if (grade === "pass") item.passed += 1;
    else if (grade === "fail") item.failed += 1;
    else item.unscored += 1;
    byCase.set(trial.caseId, item);
  }
  const cases = [...byCase.values()];
  for (const item of cases) item.successRate = item.passed + item.failed ? item.passed / (item.passed + item.failed) : null;
  const scoredCases = cases.filter((item) => item.successRate !== null);
  const observedCaseSuccessRate = scoredCases.length ? scoredCases.reduce((sum, item) => sum + item.successRate!, 0) / scoredCases.length : null;
  const passedTrials = cases.reduce((sum, item) => sum + item.passed, 0);
  const failedTrials = cases.reduce((sum, item) => sum + item.failed, 0);
  const validTrials = passedTrials + failedTrials;
  const missingTrials = Math.max(0, run.plannedTrials - run.trials.length);
  const complete = run.status === "completed" && run.plannedTrials > 0 && validTrials === run.plannedTrials
    && run.trials.length === run.plannedTrials && cases.every((item) => item.trials === item.plannedTrials)
    && run.trials.every((trial) => trial.result.terminationConfirmed && trial.grade.terminationConfirmed !== false);
  return {
    plannedTrials: run.plannedTrials,
    recordedTrials: run.trials.length,
    validTrials,
    passedTrials,
    failedTrials,
    unscoredTrials: run.trials.length - validTrials,
    missingTrials,
    coverage: run.plannedTrials > 0 ? Math.min(1, validTrials / run.plannedTrials) : 0,
    successRate: complete ? observedCaseSuccessRate : null,
    observedCaseSuccessRate,
    statuses,
    cases,
    usage: {
      inputTokens: usageSummary(run, "inputTokens"),
      outputTokens: usageSummary(run, "outputTokens"),
      costUsd: usageSummary(run, "costUsd"),
    },
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function percent(value: number | null): string {
  return value === null ? "Unknown" : `${(value * 100).toFixed(1)}%`;
}

function renderUsage(summary: BenchmarkUsageSummary): string {
  if (summary.observed === null) return `Unknown (${summary.unknownTrials} trials without observations)`;
  return `${summary.observed.toLocaleString("en-US", { maximumFractionDigits: 6 })}${summary.complete ? "" : " observed (partial)"}; ${summary.knownTrials} known, ${summary.unknownTrials} unknown`;
}

function renderGrade(grade: BenchmarkGrade): string {
  return `${grade.error ? `<p>Grading error (unscored): ${escapeHtml(grade.error)}</p>` : ""}${grade.assertions.map(assertion => {
    const command = assertion.command;
    return `<div><p>${escapeHtml(assertion.kind)}${assertion.path ? ` · ${escapeHtml(assertion.path)}` : ""}: ${assertion.passed ? "pass" : "fail"}</p>${command ?
      `<p>Command: ${escapeHtml(command.status)}; exit code: ${command.exitCode ?? "unavailable"}; ${command.durationMs} ms; cleanup confirmed: ${command.terminationConfirmed ? "yes" : "no"}${command.truncated ? "; output truncated" : ""}</p><pre>${escapeHtml(command.stdout)}</pre><pre>${escapeHtml(command.stderr)}</pre>` : ""}</div>`;
  }).join("")}`;
}

function renderWorkspace(trial: BenchmarkTrial): string {
  const workspace = trial.workspace;
  if (!workspace) return "";
  return `<h3>Workspace changes</h3><p>Artifacts: <code>${escapeHtml(workspace.artifactDirectory)}</code></p><p>Fixture ${escapeHtml(workspace.fixtureDigest)}; result ${escapeHtml(workspace.resultDigest)}</p>${workspace.changes.length ? workspace.changes.map(change =>
    `<details><summary>${escapeHtml(change.path)} · ${escapeHtml(change.kind)}</summary><p>Executable: ${change.beforeExecutable ?? "absent"} → ${change.afterExecutable ?? "absent"}</p>${change.contentOmitted ? "<p>Binary or oversized content omitted from this preview; inspect the saved files.</p>" : ""}<h4>Before</h4><pre>${escapeHtml(change.beforeText ?? "(no text preview)")}</pre><h4>After</h4><pre>${escapeHtml(change.afterText ?? "(no text preview)")}</pre></details>`).join("") : "<p>No file changes.</p>"}`;
}

export function renderBenchmarkHtml(run: BenchmarkRunRecord): string {
  const summary = summarizeBenchmarkRun(run);
  const caseRows = summary.cases.map((item) => `<tr><td>${escapeHtml(item.caseId)}</td><td>${item.trials}</td><td>${item.passed}</td><td>${item.failed}</td><td>${item.unscored}</td><td>${percent(item.successRate)}</td></tr>`).join("\n");
  const trials = run.trials.map((trial) => `<details><summary>${escapeHtml(trial.caseId)} · repetition ${trial.repetition + 1} · ${escapeHtml(trial.result.status)} · ${verdict(trial)}</summary>
<p>Termination confirmed: ${trial.result.terminationConfirmed ? "yes" : "no"}; duration: ${trial.result.durationMs} ms</p>
${trial.result.runtime ? `<p>Runtime: dsh ${escapeHtml(trial.result.runtime.dshVersion)}; rolebox ${escapeHtml(trial.result.runtime.roleboxVersion)}</p>` : "<p>Runtime versions: unknown</p>"}
${trial.result.diagnostic ? `<p>${escapeHtml(trial.result.diagnostic)}</p>` : ""}<pre>${escapeHtml(trial.result.output)}</pre>${renderGrade(trial.grade)}${renderWorkspace(trial)}</details>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(run.suiteId)} benchmark</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:1100px;margin:3rem auto;padding:0 1.5rem;color:#182030;background:#fafbfc}h1,h2{line-height:1.2}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{text-align:left;padding:.5rem;border-bottom:1px solid #ccd2dc}dt{font-weight:600}dd{margin:0 0 .75rem}details{border:1px solid #ccd2dc;border-radius:6px;padding:.75rem;margin:.75rem 0}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f0f2f5;padding:1rem}code{overflow-wrap:anywhere}</style></head><body>
<h1>${escapeHtml(run.suiteId)}</h1><p>Run <code>${escapeHtml(run.id)}</code> · ${escapeHtml(run.status)} · trusted process isolation</p>
<p>Started ${escapeHtml(run.startedAt)}${run.completedAt ? `; completed ${escapeHtml(run.completedAt)}` : ""}. Local plugins and tools execute with the current user's operating-system permissions.</p>
<dl><dt>Task success (equal weight per case)</dt><dd>${percent(summary.successRate)}</dd><dt>Observed case success</dt><dd>${percent(summary.observedCaseSuccessRate)}${summary.successRate === null ? " — incomplete observations; not an overall result" : ""}</dd>
<dt>Coverage</dt><dd>${summary.validTrials}/${summary.plannedTrials} scored (${percent(summary.coverage)}); ${summary.unscoredTrials} unscored; ${summary.missingTrials} missing</dd>
<dt>Execution states</dt><dd>${Object.entries(summary.statuses).map(([status, count]) => `${status}: ${count}`).join("; ")}</dd>
<dt>Input tokens</dt><dd>${renderUsage(summary.usage.inputTokens)}</dd><dt>Output tokens</dt><dd>${renderUsage(summary.usage.outputTokens)}</dd><dt>Cost (USD)</dt><dd>${renderUsage(summary.usage.costUsd)}</dd>
<dt>Suite digest</dt><dd><code>${escapeHtml(run.suiteDigest)}</code></dd><dt>Role digest</dt><dd><code>${escapeHtml(run.roleDigest)}</code></dd></dl>
<h2>Cases</h2><table><thead><tr><th>Case</th><th>Trials</th><th>Passed</th><th>Failed</th><th>Unscored</th><th>Observed success</th></tr></thead><tbody>${caseRows}</tbody></table>
<h2>Trial evidence</h2>${trials}</body></html>`;
}
