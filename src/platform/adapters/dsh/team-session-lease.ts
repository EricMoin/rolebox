import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDatabaseSync, type DatabaseDriver } from "../../../memory/db-driver.ts";

const owners = new Set<string>();

interface Lease {
  owner_pid: number;
  owner_id: string;
}

function readLease(value: unknown): Lease | undefined {
  if (value === undefined || value === null) return undefined;
  const row = value as Partial<Lease>;
  if (!Number.isSafeInteger(row.owner_pid) || (row.owner_pid ?? 0) < 1 || typeof row.owner_id !== "string" || !row.owner_id) {
    throw new Error("DSH team session lease storage is corrupt or unsupported");
  }
  return row as Lease;
}

function live(lease: Lease): boolean {
  if (lease.owner_pid === process.pid) return owners.has(lease.owner_id);
  try { process.kill(lease.owner_pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function validateSessionId(id: string): void {
  if (typeof id !== "string" || !id) throw new Error("Invalid DSH team session identity");
}

export class DshTeamSessionLease {
  private readonly db: DatabaseDriver;
  private readonly ownerId = randomUUID();
  private closed = false;

  constructor(directory: string) {
    const root = join(resolve(directory), ".rolebox", "team-sessions");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = join(root, "leases.sqlite");
    try { closeSync(openSync(path, "wx", 0o600)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe DSH team session lease path");
    this.db = createDatabaseSync(path);
    try {
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
      this.transaction(() => {
        const version = this.db.query("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
        const tables = this.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
        if (version?.user_version === 0 && tables.length === 0) {
          this.db.exec("CREATE TABLE peer_leases (session_id TEXT PRIMARY KEY NOT NULL, owner_pid INTEGER NOT NULL, owner_id TEXT NOT NULL); PRAGMA user_version = 1;");
        } else if (version?.user_version !== 1 || tables.length !== 1 || tables[0]?.name !== "peer_leases") {
          throw new Error("DSH team session lease storage is corrupt or unsupported");
        }
      });
      owners.add(this.ownerId);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("DSH team session lease is closed");
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "DSH team session lease rollback failed"); }
      throw error;
    }
  }

  acquire(sessionId: string): boolean {
    this.assertOpen();
    validateSessionId(sessionId);
    return this.transaction(() => {
      const lease = readLease(this.db.query("SELECT owner_pid, owner_id FROM peer_leases WHERE session_id = ?").get(sessionId));
      if (lease && lease.owner_id !== this.ownerId && live(lease)) return false;
      this.db.run("INSERT INTO peer_leases (session_id, owner_pid, owner_id) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET owner_pid = excluded.owner_pid, owner_id = excluded.owner_id", sessionId, process.pid, this.ownerId);
      return true;
    });
  }

  isOwnedElsewhere(sessionId: string): boolean {
    this.assertOpen();
    validateSessionId(sessionId);
    const lease = readLease(this.db.query("SELECT owner_pid, owner_id FROM peer_leases WHERE session_id = ?").get(sessionId));
    return lease !== undefined && lease.owner_id !== this.ownerId && live(lease);
  }

  release(sessionId: string): void {
    this.assertOpen();
    validateSessionId(sessionId);
    this.db.run("DELETE FROM peer_leases WHERE session_id = ? AND owner_pid = ? AND owner_id = ?", sessionId, process.pid, this.ownerId);
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.db.run("DELETE FROM peer_leases WHERE owner_pid = ? AND owner_id = ?", process.pid, this.ownerId); }
    finally {
      owners.delete(this.ownerId);
      this.db.close();
    }
  }
}
