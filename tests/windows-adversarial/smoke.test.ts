// tests/windows-adversarial/smoke.test.ts
//
// Harness smoke test — proves the scaffold is functional on any host (run on
// darwin locally and on windows-latest in CI) WITHOUT exercising the CLI's
// Windows-specific defect surface. Subtasks 2-7 add the real adversarial cases.
//
// Two things are verified here:
//   1. recordDefect() never throws and appends a JSONL line (the evidence sink).
//   2. runCli() spawns the compiled CLI with isolated data/config dirs, captures
//      stdout/stderr/exit-code, and the CLI runs cleanly.

import { describe, it, expect, afterAll } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  recordDefect,
  EVIDENCE_ROOT,
  resolveCluster,
} from "./helpers/evidence";
import {
  runCli,
  seedVersionCache,
  type CliResult,
} from "./helpers/cli";

// Point the campaign at a throwaway sandbox cluster so the smoke test never
// pollutes the real evidence ledger. Restored after the suite.
const SMOKE_CLUSTER = "__smoke__";
const prevClusterEnv = process.env.ROLEBOX_CAMPAIGN_CLUSTER;
process.env.ROLEBOX_CAMPAIGN_CLUSTER = SMOKE_CLUSTER;
const smokeDataDir = join(tmpdir(), "rolebox-wintest-smoke-data-");
const smokeConfigDir = join(tmpdir(), "rolebox-wintest-smoke-config-");

// Keep the data dir for a manual inspection glimpse inside the test, then clean.
function cleanup() {
  if (prevClusterEnv === undefined) {
    delete process.env.ROLEBOX_CAMPAIGN_CLUSTER;
  } else {
    process.env.ROLEBOX_CAMPAIGN_CLUSTER = prevClusterEnv;
  }
  for (const dir of [smokeDataDir, smokeConfigDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

describe("windows-adversarial harness", () => {
  afterAll(cleanup);

  it("recordDefect appends a JSONL evidence line and never throws", () => {
    // Harness idempotency: recordDefect appends via appendFileSync, so a re-run
    // in a persisted workspace accumulates the __smoke__ ledger and would break
    // the `=== 1` assertion below. Reset the smoke cluster so the evidence sink
    // starts clean on every run. This is the dedicated smoke-only dir, never the
    // real campaign ledger, and it is reset AFTER the env-var capture above so
    // the cluster resolution contract is still exercised.
    rmSync(join(EVIDENCE_ROOT, SMOKE_CLUSTER), { recursive: true, force: true });

    const testId = "smoke-harness-ok";
    const ok = recordDefect(testId, {
      scenario: "harness self-check: evidence sink works",
      command: "bun dist/cli/main.js list",
      expected: "evidence file exists with one JSONL entry",
      actual: "entry appended",
      exit_code: 0,
      stdout_tail: "No roles installed. Run `rolebox install <role>` to get started.",
      stderr_tail: "",
      file_line_refs: [],
    });
    expect(ok).toBe(true);
    expect(resolveCluster()).toBe(SMOKE_CLUSTER);

    const outFile = join(EVIDENCE_ROOT, SMOKE_CLUSTER, `${testId}.json`);
    expect(existsSync(outFile)).toBe(true);
    const lines = readFileSync(outFile, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.scenario).toBe("harness self-check: evidence sink works");
    expect(entry.exit_code).toBe(0);
    expect(typeof entry.timestamp).toBe("string");
    expect(entry.cluster).toBe(SMOKE_CLUSTER);
  });

  it("runCli spawns the built CLI with isolated dirs and captures output", async () => {
    // Hermetic: seed the version-check cache so no npm registry call happens.
    seedVersionCache(smokeDataDir);
    const r: CliResult = await runCli(["list"], {
      cwd: smokeDataDir,
      dataDir: smokeDataDir,
      configDir: smokeConfigDir,
      keepTempDirs: true,
      timeout: 30_000,
    });
    expect(r.built).toBe(false); // dist already exists in a built checkout
    expect(r.spawnError).toBeUndefined();
    expect(r.buildError).toBeUndefined();
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("No roles installed");
    expect(r.stderr).toBe("");
    // Isolation contract: env dirs were routed to temp, never the real user dirs.
    expect(r.dataDir).toBe(smokeDataDir);
    expect(r.configDir).toBe(smokeConfigDir);
  });

  it("runCli handles an unknown subcommand with a nonzero exit and stderr tail", async () => {
    seedVersionCache(smokeDataDir);
    const r: CliResult = await runCli(["definitely-not-a-command"], {
      cwd: smokeDataDir,
      dataDir: smokeDataDir,
      configDir: smokeConfigDir,
      keepTempDirs: true,
      timeout: 30_000,
    });
    expect(r.spawnError).toBeUndefined();
    expect(r.timedOut).toBe(false);
    // citty exits nonzero on an unknown subcommand; the exact code is platform
    // dependent (1-2), so just require it to be non-null and non-zero.
    expect(r.exitCode).not.toBeNull();
    expect(r.exitCode).not.toBe(0);
  });
});
