import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BenchmarkStore, readBenchmarkRun } from "../../src/benchmark/store.ts";
import type { BenchmarkRunRecord, BenchmarkTrial } from "../../src/benchmark/types.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("benchmark durable records", () => {
  it("retains committed trials after an interrupted run and rejects duplicate settlement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bench-store-test-")); roots.push(directory);
    const run: BenchmarkRunRecord = { schemaVersion: 1, id: "run", suiteId: "suite", suiteDigest: "a".repeat(64), roleDigest: "b".repeat(64), startedAt: new Date().toISOString(), status: "running", isolation: "trusted-process", plannedTrials: 1, caseIds: ["case"], repetitions: 1, trials: [] };
    const trial: BenchmarkTrial = { id: "0", caseId: "case", repetition: 0, grade: { verdict: "unscored", assertions: [] }, result: { protocolVersion: 1, status: "infra_error", output: "", usage: { inputTokens: null, outputTokens: null, costUsd: null, source: "unavailable" }, durationMs: 0, terminationConfirmed: true } };
    const store = new BenchmarkStore(directory);
    try { store.create(run); store.recordTrial(run.id, trial); expect(() => store.recordTrial(run.id, trial)).toThrow(); }
    finally { store.close(); }
    const recovered = readBenchmarkRun(directory);
    expect(recovered.status).toBe("incomplete");
    expect(recovered.trials).toEqual([trial]);
  });
});
