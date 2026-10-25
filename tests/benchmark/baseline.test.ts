import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BenchmarkBaselineStore } from "../../src/benchmark/baseline.ts";
import { benchmarkRecordDigest } from "../../src/benchmark/compare.ts";
import { BenchmarkStore, readBenchmarkRun } from "../../src/benchmark/store.ts";
import type { BenchmarkRunRecord } from "../../src/benchmark/types.ts";
import { createDatabaseSync } from "../../src/memory/db-driver.ts";

const roots: string[] = [];
const stores: BenchmarkBaselineStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ directory: string; store: BenchmarkBaselineStore }> {
  const directory = await mkdtemp(join(tmpdir(), "bench-baseline-test-"));
  roots.push(directory);
  const store = new BenchmarkBaselineStore(directory);
  stores.push(store);
  return { directory, store };
}

function run(id = "run"): BenchmarkRunRecord {
  return {
    schemaVersion: 1, id, suiteId: "suite", suiteDigest: "a".repeat(64), roleDigest: "b".repeat(64),
    startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z", status: "completed",
    isolation: "trusted-process", plannedTrials: 1, caseIds: ["case"], repetitions: 1,
    trials: [{
      id: "0", caseId: "case", repetition: 0,
      result: {
        protocolVersion: 1, status: "completed", output: "READY", durationMs: 1, terminationConfirmed: true,
        activation: { roleId: "role", provider: "example-provider", model: "model-name", promptDigest: "c".repeat(64) },
        usage: { inputTokens: null, outputTokens: null, costUsd: null, source: "unavailable" },
      },
      grade: { verdict: "pass", assertions: [{ kind: "equals", passed: true }] },
    }],
  };
}

describe("benchmark baseline snapshots", () => {
  it("retains revision history and selects the latest snapshot independently for each name", async () => {
    const { directory, store } = await fixture();
    expect(store.list()).toEqual([]);
    const first = store.set("quality", run("first"));
    store.set("another", run("separate"));
    const second = store.set("quality", run("second"));
    const third = store.set("quality", run("second"));
    expect([first.revision, second.revision, third.revision]).toEqual([1, 2, 3]);
    expect(store.get("quality").runId).toBe("second");
    expect(store.history("quality").map(item => item.runId)).toEqual(["first", "second", "second"]);
    expect(store.list().map(item => [item.name, item.revision])).toEqual([["another", 1], ["quality", 3]]);
    expect(store.list().every(item => !("record" in item))).toBe(true);
    const db = createDatabaseSync(join(directory, "baselines.sqlite"), { readonly: true });
    try {
      expect(db.query("SELECT COUNT(*) AS count FROM records").get()).toEqual({ count: 3 });
      expect(db.query("SELECT COUNT(*) AS count FROM history").get()).toEqual({ count: 4 });
    } finally { db.close(); }
    const reopened = new BenchmarkBaselineStore(directory);
    try { expect(reopened.get("quality")).toEqual(third); }
    finally { reopened.close(); }
  });

  it("keeps its snapshot after source mutation and deletion and returns independent objects", async () => {
    const { directory, store } = await fixture();
    const source = new BenchmarkStore(join(directory, "source"));
    const original = run();
    try {
      source.create(original);
      source.recordTrial(original.id, original.trials[0]!);
      source.finish(original);
    } finally { source.close(); }
    const input = readBenchmarkRun(join(directory, "source"));
    const saved = store.set("quality", input);
    expect(saved.recordDigest).toBe(benchmarkRecordDigest(original));
    input.trials[0]!.result.output = "changed input";
    saved.record.trials[0]!.result.output = "changed return";
    await rm(join(directory, "source"), { recursive: true });
    expect(store.get("quality").record).toEqual(original);
    const returned = store.get("quality");
    returned.record.caseIds.push("extra");
    expect(store.get("quality").record).toEqual(original);
  });

  it("accepts complete scored failures and missing runtime metadata", async () => {
    const { store } = await fixture();
    for (const status of ["task_failure", "task_timeout"] as const) {
      const record = run(status);
      record.trials[0]!.result.status = status;
      record.trials[0]!.grade = { verdict: "fail", assertions: [] };
      delete record.trials[0]!.result.activation;
      expect(store.set(status, record).record).toEqual(record);
    }
    const failedAssertion = run("failed-assertion");
    failedAssertion.trials[0]!.grade = { verdict: "fail", assertions: [{ kind: "equals", passed: false }] };
    expect(store.set("failed_assertion", failedAssertion).record).toEqual(failedAssertion);
  });

  it("validates names for all named operations without creating a revision", async () => {
    const { store } = await fixture();
    for (const name of ["", ".", "../quality", "with space", "a.b", "-quality", "a".repeat(65)]) {
      expect(() => store.set(name, run())).toThrow("Invalid benchmark baseline name");
      expect(() => store.get(name)).toThrow("Invalid benchmark baseline name");
      expect(() => store.history(name)).toThrow("Invalid benchmark baseline name");
    }
    expect(store.list()).toEqual([]);
    expect(store.history("missing")).toEqual([]);
    expect(() => store.get("missing")).toThrow("not found");
    expect(store.set("A1_test-name", run()).name).toBe("A1_test-name");
  });

  it("rejects unfinished, missing, unscored, and unconfirmed observations", async () => {
    const { store } = await fixture();
    const variants: BenchmarkRunRecord[] = [];
    const running = run(); running.status = "running"; variants.push(running);
    const incomplete = run(); incomplete.status = "incomplete"; variants.push(incomplete);
    const missing = run(); missing.trials = []; variants.push(missing);
    const unscored = run();
    unscored.trials[0]!.result.status = "infra_error";
    unscored.trials[0]!.grade = { verdict: "unscored", assertions: [] };
    variants.push(unscored);
    const unconfirmed = run(); unconfirmed.trials[0]!.result.terminationConfirmed = false; variants.push(unconfirmed);
    const unfinished = run(); delete unfinished.completedAt; variants.push(unfinished);
    for (const value of variants) expect(() => store.set("quality", value)).toThrow();
    expect(store.list()).toEqual([]);
    expect(store.history("quality")).toEqual([]);
  });

  it("detects altered snapshot contents on every read and rolls back reuse of corrupt content", async () => {
    const { directory, store } = await fixture();
    const original = run();
    const saved = store.set("quality", original);
    const tampered = run(); tampered.trials[0]!.result.output = "different evidence";
    const db = createDatabaseSync(join(directory, "baselines.sqlite"));
    try {
      db.run("UPDATE records SET body = ? WHERE digest = ?", JSON.stringify(tampered), saved.recordDigest);
      expect(() => store.get("quality")).toThrow("corrupt");
      expect(() => store.list()).toThrow("corrupt");
      expect(() => store.history("quality")).toThrow("corrupt");
      expect(() => store.set("quality", original)).toThrow("corrupt");
      expect(db.query("SELECT COUNT(*) AS count FROM history").get()).toEqual({ count: 1 });
    } finally { db.close(); }
  });

  it("rejects missing, malformed, and schema-invalid stored records", async () => {
    const { directory, store } = await fixture();
    const saved = store.set("quality", run());
    const db = createDatabaseSync(join(directory, "baselines.sqlite"));
    try {
      for (const body of ["{", JSON.stringify({})]) {
        db.run("UPDATE records SET body = ? WHERE digest = ?", body, saved.recordDigest);
        expect(() => store.get("quality")).toThrow("corrupt");
      }
      db.exec("PRAGMA foreign_keys = OFF");
      db.run("DELETE FROM records WHERE digest = ?", saved.recordDigest);
      expect(() => store.get("quality")).toThrow("corrupt");
      expect(() => store.list()).toThrow("corrupt");
      expect(() => store.history("quality")).toThrow("corrupt");
    } finally { db.close(); }
  });
});
