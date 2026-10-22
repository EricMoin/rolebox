export interface BenchmarkAssertion {
  kind: "equals" | "contains";
  value: string;
}

export interface BenchmarkCase {
  id: string;
  prompt: string;
  assertions: BenchmarkAssertion[];
}

export interface BenchmarkHostPlugin {
  module: string;
  config: Record<string, unknown>;
  sourceDigest?: string;
}

export interface BenchmarkSuite {
  schemaVersion: 1;
  id: string;
  target: {
    host: "dsh";
    role: string;
    provider: string;
    model: string;
  };
  host: {
    moduleRoot?: string;
    plugins: BenchmarkHostPlugin[];
    env: string[];
  };
  dataset: string;
  run: {
    repetitions: number;
    concurrency: number;
    timeoutMs: number;
  };
}

export interface LoadedBenchmarkSuite {
  suite: BenchmarkSuite;
  directory: string;
  roleDirectory: string;
  cases: BenchmarkCase[];
  digest: string;
}

export interface BenchmarkUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  source: "host" | "unavailable";
}

export interface BenchmarkActivation {
  roleId: string;
  provider: string;
  model: string;
  promptDigest: string;
}

export interface BenchmarkWorkerRequest {
  protocolVersion: 1;
  workspace: string;
  rolesDirectory: string;
  roleId: string;
  provider: string;
  model: string;
  host: BenchmarkSuite["host"];
  prompt: string;
  timeoutMs: number;
}

export interface BenchmarkWorkerResult {
  protocolVersion: 1;
  status: "completed" | "task_failure" | "task_timeout" | "infra_error" | "invalid" | "cancelled";
  output: string;
  activation?: BenchmarkActivation;
  runtime?: { dshVersion: string; roleboxVersion: string };
  usage: BenchmarkUsage;
  durationMs: number;
  terminationConfirmed: boolean;
  diagnostic?: string;
}

export interface BenchmarkGrade {
  verdict: "pass" | "fail" | "unscored";
  assertions: Array<{ kind: BenchmarkAssertion["kind"]; passed: boolean }>;
}

export interface BenchmarkTrial {
  id: string;
  caseId: string;
  repetition: number;
  result: BenchmarkWorkerResult;
  grade: BenchmarkGrade;
}

export interface BenchmarkRunRecord {
  schemaVersion: 1;
  id: string;
  suiteId: string;
  suiteDigest: string;
  roleDigest: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "completed" | "incomplete";
  isolation: "trusted-process";
  plannedTrials: number;
  caseIds: string[];
  repetitions: number;
  trials: BenchmarkTrial[];
}
