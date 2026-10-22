export type BenchmarkAssertion =
  | { kind: "equals" | "contains"; value: string }
  | { kind: "file_exists"; path: string }
  | { kind: "file_equals" | "file_contains"; path: string; value: string }
  | { kind: "command"; argv: string[]; timeoutMs: number; expectedExitCode: number };

export interface BenchmarkFileSnapshot {
  digest: string;
  files: Array<{ path: string; content: string; executable: boolean }>;
}

export interface BenchmarkWorkspaceInput {
  fixture: BenchmarkFileSnapshot;
  checks?: BenchmarkFileSnapshot;
}

export interface BenchmarkWorkspaceEvidence {
  fixtureDigest: string;
  resultDigest: string;
  artifactDirectory: string;
  changes: Array<{
    path: string;
    kind: "added" | "modified" | "deleted";
    beforeDigest: string | null;
    afterDigest: string | null;
    beforeText: string | null;
    afterText: string | null;
    beforeExecutable: boolean | null;
    afterExecutable: boolean | null;
    contentOmitted: boolean;
  }>;
}

export interface BenchmarkCase {
  id: string;
  prompt: string;
  assertions: BenchmarkAssertion[];
  workspace?: { fixture: string; checks?: string };
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
  workspaces?: Record<string, BenchmarkWorkspaceInput>;
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
  workspaceTask?: boolean;
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
  assertions: Array<{
    kind: BenchmarkAssertion["kind"];
    passed: boolean;
    path?: string;
    command?: {
      status: "completed" | "timeout" | "error" | "cancelled";
      exitCode: number | null;
      stdout: string;
      stderr: string;
      durationMs: number;
      terminationConfirmed: boolean;
      truncated: boolean;
    };
  }>;
  error?: string;
  terminationConfirmed?: boolean;
}

export interface BenchmarkTrial {
  id: string;
  caseId: string;
  repetition: number;
  result: BenchmarkWorkerResult;
  grade: BenchmarkGrade;
  workspace?: BenchmarkWorkspaceEvidence;
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
