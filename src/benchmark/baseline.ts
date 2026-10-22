import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createDatabaseSync, type DatabaseDriver } from "../memory/db-driver.ts";
import { benchmarkRecordDigest } from "./compare.ts";
import { parseBenchmarkRunRecord } from "./report.ts";
import type { BenchmarkRunRecord } from "./types.ts";

export interface BenchmarkBaselineInfo {
  name: string;
  recordDigest: string;
  runId: string;
  suiteId: string;
  suiteDigest: string;
  roleDigest: string;
  setAt: string;
  revision: number;
}

export interface BenchmarkBaseline extends BenchmarkBaselineInfo {
  record: BenchmarkRunRecord;
}

const baselineName = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const selection = `SELECT h.name, h.record_digest, h.set_at, r.body,
  (SELECT COUNT(*) FROM history previous WHERE previous.name = h.name AND previous.seq <= h.seq) AS revision
  FROM history h LEFT JOIN records r ON r.digest = h.record_digest`;

function validateName(name: string): void {
  if (typeof name !== "string" || !baselineName.test(name)) throw new Error("Invalid benchmark baseline name");
}

function completeRecord(value: unknown): BenchmarkRunRecord {
  const record = parseBenchmarkRunRecord(value);
  if (record.status !== "completed") throw new Error("A benchmark baseline requires a complete scored run");
  return record;
}

function readBaseline(value: unknown): BenchmarkBaseline {
  try {
    if (!value || typeof value !== "object") throw new Error();
    const row = value as Record<string, unknown>;
    if (typeof row.name !== "string" || !baselineName.test(row.name)
      || typeof row.record_digest !== "string" || !/^[0-9a-f]{64}$/.test(row.record_digest)
      || typeof row.set_at !== "string" || new Date(row.set_at).toISOString() !== row.set_at
      || typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 1
      || typeof row.body !== "string") throw new Error();
    const record = completeRecord(JSON.parse(row.body));
    if (benchmarkRecordDigest(record) !== row.record_digest) throw new Error();
    return {
      name: row.name, recordDigest: row.record_digest, runId: record.id, suiteId: record.suiteId,
      suiteDigest: record.suiteDigest, roleDigest: record.roleDigest, setAt: row.set_at, revision: row.revision, record,
    };
  } catch {
    throw new Error("Benchmark baseline storage is corrupt or unsupported");
  }
}

function information(baseline: BenchmarkBaseline): BenchmarkBaselineInfo {
  const { record: _, ...info } = baseline;
  return info;
}

export class BenchmarkBaselineStore {
  private readonly db: DatabaseDriver;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = createDatabaseSync(join(directory, "baselines.sqlite"));
    try {
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      this.db.exec(`CREATE TABLE IF NOT EXISTS records (digest TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS history (seq INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
          record_digest TEXT NOT NULL REFERENCES records(digest), set_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS baseline_history_name_seq ON history (name, seq);`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  set(name: string, value: BenchmarkRunRecord): BenchmarkBaseline {
    validateName(name);
    const record = completeRecord(value);
    const digest = benchmarkRecordDigest(record);
    return this.db.transaction(() => {
      this.db.run("INSERT INTO records (digest, body) VALUES (?, ?) ON CONFLICT(digest) DO NOTHING", digest, JSON.stringify(record));
      this.db.run("INSERT INTO history (name, record_digest, set_at) VALUES (?, ?, ?)", name, digest, new Date().toISOString());
      return this.get(name);
    })();
  }

  get(name: string): BenchmarkBaseline {
    validateName(name);
    const row = this.db.query(`${selection} WHERE h.name = ? ORDER BY h.seq DESC LIMIT 1`).get(name);
    if (!row) throw new Error("Benchmark baseline was not found");
    return readBaseline(row);
  }

  list(): BenchmarkBaselineInfo[] {
    return this.db.query(`${selection} WHERE h.seq = (SELECT MAX(latest.seq) FROM history latest WHERE latest.name = h.name)
      ORDER BY h.name`).all().map(row => information(readBaseline(row)));
  }

  history(name: string): BenchmarkBaselineInfo[] {
    validateName(name);
    return this.db.query(`${selection} WHERE h.name = ? ORDER BY h.seq`).all(name).map(row => information(readBaseline(row)));
  }

  close(): void { this.db.close(); }
}
