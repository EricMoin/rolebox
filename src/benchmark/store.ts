import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDatabaseSync, type DatabaseDriver } from "../memory/db-driver.ts";
import type { BenchmarkRunRecord, BenchmarkTrial } from "./types.ts";
import { parseBenchmarkRunRecord } from "./report.ts";

export class BenchmarkStore {
  private readonly db: DatabaseDriver;

  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = createDatabaseSync(join(directory, "benchmark.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.db.exec("CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS trials (run_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (run_id, id));");
  }

  create(record: BenchmarkRunRecord): void {
    this.db.run("INSERT INTO runs (id, body) VALUES (?, ?)", record.id, JSON.stringify(record));
  }

  recordTrial(runId: string, trial: BenchmarkTrial): void {
    this.db.run("INSERT INTO trials (run_id, id, body) VALUES (?, ?, ?)", runId, trial.id, JSON.stringify(trial));
  }

  finish(record: BenchmarkRunRecord): void {
    this.db.transaction(() => {
      this.db.run("UPDATE runs SET body = ? WHERE id = ?", JSON.stringify({ ...record, trials: [] }), record.id);
    })();
    const temp = join(this.directory, ".run.json.tmp");
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, join(this.directory, "run.json"));
  }

  close(): void { this.db.close(); }
}

export function readBenchmarkRun(directory: string): BenchmarkRunRecord {
  const db = createDatabaseSync(join(directory, "benchmark.sqlite"), { readonly: true });
  try {
    const rows = db.query("SELECT body FROM runs").all() as Array<{ body: string }>;
    if (rows.length !== 1) throw new Error("Expected exactly one benchmark run");
    const run = JSON.parse(rows[0].body) as BenchmarkRunRecord;
    run.trials = (db.query("SELECT body FROM trials WHERE run_id = ? ORDER BY id").all(run.id) as Array<{ body: string }>).map(row => JSON.parse(row.body) as BenchmarkTrial);
    if (run.schemaVersion !== 1 || !Array.isArray(run.caseIds) || !Number.isInteger(run.plannedTrials)) throw new Error("Unsupported benchmark result schema");
    if (run.status === "running") run.status = "incomplete";
    return parseBenchmarkRunRecord(run);
  } finally { db.close(); }
}
