// tests/windows-adversarial/helpers/evidence.ts
//
// recordDefect(testId, detail) — append a structured defect entry for a found
// (or reproduced-and-unfixed) Windows CLI bug to the campaign evidence ledger.
//
// This file is the single sink that subtasks 2-7 write their findings to. It
// is deliberately lenient: it must NEVER throw. All filesystem access is
// wrapped in try/catch and failures are logged to stderr instead of
// propagated, so a storage hiccup can never crash the harness or mask a real
// CLI result.
//
// Evidence format: JSON Lines. Each call appends exactly one JSON object as a
// single line to:
//   <repoRoot>/.rolebox/evidence/windows-campaign/<cluster>/<test-id>.json
//
// The upstream CI step globs `.rolebox/evidence/**` and uploads it as the
// `evidence` artifact, so this path is what the campaign reads back. JSONL (not
// a single JSON array) is used on purpose: bun may run test files in separate
// processes concurrently, and an append is a single atomic write instead of a
// read-modify-write race.
//
// Cluster resolution: the `<cluster>` path segment comes from (highest
// precedence first):
//   1. detail.cluster
//   2. process.env.ROLEBOX_CAMPAIGN_CLUSTER
//   3. "default"
// Subtasks should pass a stable cluster (e.g. "path-traversal",
// "shell-injection", "env-isolation") so the evidence stays grouped.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// repoRoot = tests/windows-adversarial/helpers -> ../../.. = repo root.
const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HELPERS_DIR, "..", "..", "..");
export const EVIDENCE_ROOT = join(
  REPO_ROOT,
  ".rolebox",
  "evidence",
  "windows-campaign",
);

export interface DefectDetail {
  /** Human-readable scenario being exercised (e.g. "install with ../ traversal"). */
  scenario: string;
  /** The exact command line string the CLI was spawned with (see runCli's command field). */
  command: string;
  /** What a correct implementation should have done (the invariant that failed). */
  expected: string;
  /** What actually happened — the observed defect. */
  actual: string;
  /** Child process exit code, or null if the process never exited cleanly. */
  exit_code: number | null;
  /** Tail of captured stdout (last ~2000 chars). */
  stdout_tail: string;
  /** Tail of captured stderr (last ~2000 chars). */
  stderr_tail: string;
  /** File/line references in the repo, e.g. ["src/cli/paths.ts:72"]. */
  file_line_refs: string[];
  /** Optional cluster override; defaults to ROLEBOX_CAMPAIGN_CLUSTER, else "default". */
  cluster?: string;
}

/** The JSON record that gets appended as one line. */
export interface RecordedDefectLine {
  test_id: string;
  cluster: string;
  scenario: string;
  command: string;
  expected: string;
  actual: string;
  exit_code: number | null;
  stdout_tail: string;
  stderr_tail: string;
  file_line_refs: string[];
  timestamp: string;
}

/** Resolve which campaign cluster a defect belongs to. */
export function resolveCluster(detailCluster?: string): string {
  const chosen =
    detailCluster?.trim() ||
    process.env.ROLEBOX_CAMPAIGN_CLUSTER?.trim() ||
    "default";
  return chosen;
}

/**
 * Append one defect entry. NEVER throws — any fs error is logged to stderr and
 * the entry is dropped. Returns true on success, false on any failure.
 *
 * @param testId  A short, unique id for the defect (used as the filename and
 *                as the test_id field). Path separators are sanitized out so a
 *                defect id can never escape the evidence dir.
 * @param detail  The structured defect payload.
 */
export function recordDefect(testId: string, detail: DefectDetail): boolean {
  const cluster = resolveCluster(detail.cluster);
  const safeTestId = sanitizeSegment(testId);
  const outFile = join(EVIDENCE_ROOT, cluster, `${safeTestId}.json`);

  const line: RecordedDefectLine = {
    test_id: testId,
    cluster,
    scenario: detail.scenario,
    command: detail.command,
    expected: detail.expected,
    actual: detail.actual,
    exit_code: detail.exit_code ?? null,
    stdout_tail: detail.stdout_tail,
    stderr_tail: detail.stderr_tail,
    file_line_refs: detail.file_line_refs ?? [],
    timestamp: new Date().toISOString(),
  };

  try {
    mkdirSync(dirname(outFile), { recursive: true });
    appendFileSync(outFile, JSON.stringify(line) + "\n", "utf-8");
    return true;
  } catch (err) {
    // Never throw — log and drop. A storage error must not crash the harness.
    console.error(
      `[windows-adversarial:evidence] recordDefect(${JSON.stringify(testId)}) failed: ${String(err)}`,
    );
    return false;
  }
}

/** Collapse an arbitrary string into a safe, non-empty filename segment. */
function sanitizeSegment(value: string): string {
  // Strip any path separators and traversal dots first, then replace any other
  // non-safe character with "_". Guarantees a single, traversal-free segment.
  const scrubbed = value.replace(/[\\/]+/g, "_").replace(/^[.]+/g, "");
  const seg = scrubbed.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return seg || "defect";
}
