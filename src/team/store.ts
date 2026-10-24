import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDatabaseSync, type DatabaseDriver } from "../memory/db-driver.ts";
import { getSystem } from "../platform/system/index.ts";
import type { TeamState } from "./types.ts";

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const reservedId = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const stagingDirectory = /^\.team-create-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function validateId(id: string): void {
  if (typeof id !== "string" || !safeId.test(id) || reservedId.test(id)) throw new Error("Invalid team ID");
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function corrupt(cause?: unknown): Error {
  return new Error("Team storage is corrupt or unsupported", { cause });
}

function parseState(value: unknown, id: string): TeamState {
  if (!object(value)) throw corrupt();
  if (value.version !== 1) throw new Error("Unsupported team state version");
  if (value.id !== id || !nonempty(value.name) || !nonempty(value.goal)
    || !nonempty(value.ownerSessionId) || !nonempty(value.ownerRoleId) || !nonempty(value.platformId)
    || !["active", "paused", "deleted"].includes(value.status as string)
    || !integer(value.createdAt) || !integer(value.nextSeq, 1) || !integer(value.maxTurns, 1) || !integer(value.turns)
    || !Array.isArray(value.members) || !Array.isArray(value.events) || !Array.isArray(value.tasks)) throw corrupt();
  if (value.control !== undefined && (!object(value.control) || !nonempty(value.control.id)
    || !integer(value.control.ownerPid, 1) || !nonempty(value.control.ownerId))) throw corrupt();

  const memberIds = new Set<string>();
  for (const member of value.members) {
    if (!object(member) || !nonempty(member.id) || memberIds.has(member.id) || !nonempty(member.roleId)
      || !optionalString(member.sessionId) || !["active", "removed"].includes(member.status as string)
      || typeof member.managed !== "boolean" || !integer(member.cursor) || member.cursor >= value.nextSeq
      || !optionalString(member.lastTurnId) || !optionalString(member.error)) throw corrupt();
    memberIds.add(member.id);
    if (member.delivery !== undefined) {
      const delivery = member.delivery;
      if (!object(delivery) || !nonempty(delivery.id) || !integer(delivery.throughSeq)
        || delivery.throughSeq >= value.nextSeq || !integer(delivery.startedAt) || !integer(delivery.ownerPid, 1)
        || !nonempty(delivery.ownerId) || !Array.isArray(delivery.baselineMessageIds)
        || !delivery.baselineMessageIds.every(nonempty) || !optionalString(delivery.promptId)) throw corrupt();
    }
  }

  const eventIds = new Set<string>();
  let previousSeq = 0;
  for (const event of value.events) {
    if (!object(event) || !integer(event.seq, 1) || event.seq <= previousSeq || event.seq >= value.nextSeq
      || !nonempty(event.id) || eventIds.has(event.id) || !nonempty(event.type) || !nonempty(event.sender)
      || typeof event.content !== "string" || !optionalString(event.recipient) || !optionalString(event.taskId)
      || !integer(event.at) || typeof event.wake !== "boolean") throw corrupt();
    previousSeq = event.seq;
    eventIds.add(event.id);
  }

  const taskIds = new Set<string>();
  for (const task of value.tasks) {
    if (!object(task) || !nonempty(task.id) || taskIds.has(task.id) || !nonempty(task.description)
      || !["offered", "claimed", "completed"].includes(task.status as string) || !optionalString(task.owner)
      || (task.leaseUntil !== undefined && !integer(task.leaseUntil)) || !optionalString(task.result)) throw corrupt();
    taskIds.add(task.id);
  }
  return value as unknown as TeamState;
}

function encodeState(state: TeamState, id: string): string {
  parseState(state, id);
  const body = JSON.stringify(state);
  parseState(JSON.parse(body), id);
  return body;
}

function readState(db: DatabaseDriver, id: string): TeamState {
  let rows: unknown[];
  try { rows = db.query("SELECT id, state FROM team_state").all(); }
  catch (error) { throw corrupt(error); }
  if (rows.length !== 1 || !object(rows[0]) || rows[0].id !== 1 || typeof rows[0].state !== "string") throw corrupt();
  let value: unknown;
  try { value = JSON.parse(rows[0].state); }
  catch (error) { throw corrupt(error); }
  return parseState(value, id);
}

function rollback(db: DatabaseDriver, error: unknown): never {
  try { db.exec("ROLLBACK"); }
  catch (rollbackError) { throw new AggregateError([error, rollbackError], "Team transaction and rollback failed"); }
  throw error;
}

function assertMissing(path: string): void {
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("Team already exists");
}

function syncDirectory(path: string): void {
  if (!getSystem().canSyncDirectoryEntries) return;
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

export class TeamStore {
  private readonly directory: string;
  private readonly connections = new Map<string, DatabaseDriver>();
  private scheduler?: DatabaseDriver;
  private closed = false;

  constructor(directory: string) {
    const path = resolve(directory);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    this.directory = realpathSync(path);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Team store is closed");
  }

  private connect(path: string): DatabaseDriver {
    const db = createDatabaseSync(path);
    try { db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;"); }
    catch (error) {
      db.close();
      throw corrupt(error);
    }
    return db;
  }

  private connection(id: string): DatabaseDriver {
    this.assertOpen();
    validateId(id);
    const directory = join(this.directory, id);
    let stat;
    try { stat = lstatSync(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Team was not found");
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe team directory");
    const path = join(directory, "team.sqlite");
    try {
      const file = lstatSync(path);
      if (!file.isFile() || file.isSymbolicLink()) throw new Error("Unsafe team database path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw corrupt(error);
      throw error;
    }
    let db = this.connections.get(id);
    if (!db) {
      db = this.connect(path);
      this.connections.set(id, db);
    }
    return db;
  }

  private schedulerConnection(): DatabaseDriver {
    this.assertOpen();
    const path = join(this.directory, "scheduler.sqlite");
    try { closeSync(openSync(path, "wx", 0o600)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe team scheduler path");
    if (this.scheduler) return this.scheduler;
    const db = this.connect(path);
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const version = db.query("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
        const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
        if (version?.user_version === 0 && tables.length === 0) {
          db.exec("CREATE TABLE session_leases (session_key TEXT PRIMARY KEY NOT NULL, delivery_id TEXT NOT NULL); PRAGMA user_version = 1;");
        } else if (version?.user_version !== 1 || tables.length !== 1 || !object(tables[0]) || tables[0].name !== "session_leases") {
          throw corrupt();
        }
        db.exec("COMMIT");
      } catch (error) { rollback(db, error); }
      this.scheduler = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  acquireSession(sessionKey: string, deliveryId: string): boolean {
    if (!nonempty(sessionKey) || !nonempty(deliveryId)) throw new Error("Invalid team session lease identity");
    const db = this.schedulerConnection();
    db.exec("BEGIN IMMEDIATE");
    try {
      const lease = db.query("SELECT delivery_id FROM session_leases WHERE session_key = ?").get(sessionKey);
      if (lease !== undefined && lease !== null) {
        if (!object(lease) || !nonempty(lease.delivery_id)) throw corrupt();
        // Read team state only while holding this lock; callers acquire it outside team update callbacks.
        if (lease.delivery_id !== deliveryId && this.list().some(team => team.members.some(member => member.delivery?.id === lease.delivery_id))) {
          db.exec("COMMIT");
          return false;
        }
      }
      db.run("INSERT INTO session_leases (session_key, delivery_id) VALUES (?, ?) ON CONFLICT(session_key) DO UPDATE SET delivery_id = excluded.delivery_id", sessionKey, deliveryId);
      db.exec("COMMIT");
      return true;
    } catch (error) { return rollback(db, error); }
  }

  releaseSession(sessionKey: string, deliveryId: string): void {
    if (!nonempty(sessionKey) || !nonempty(deliveryId)) throw new Error("Invalid team session lease identity");
    this.schedulerConnection().run("DELETE FROM session_leases WHERE session_key = ? AND delivery_id = ?", sessionKey, deliveryId);
  }

  create(state: TeamState): void {
    this.assertOpen();
    validateId(state.id);
    const body = encodeState(state, state.id);
    const directory = join(this.directory, state.id);
    assertMissing(directory);
    const staging = join(this.directory, `.team-create-${randomUUID()}`);
    mkdirSync(staging, { mode: 0o700 });
    let db: DatabaseDriver | undefined;
    try {
      const path = join(staging, "team.sqlite");
      closeSync(openSync(path, "wx", 0o600));
      db = this.connect(path);
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("CREATE TABLE team_state (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)");
        db.run("INSERT INTO team_state (id, state) VALUES (1, ?)", body);
        db.exec("COMMIT");
      } catch (error) { rollback(db, error); }
      db.close();
      db = undefined;
      syncDirectory(staging);
      assertMissing(directory);
      try { renameSync(staging, directory); }
      catch (error) {
        if (["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new Error("Team already exists");
        throw error;
      }
      syncDirectory(this.directory);
    } catch (error) {
      db?.close();
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  read(id: string): TeamState {
    return readState(this.connection(id), id);
  }

  list(): TeamState[] {
    this.assertOpen();
    const states: TeamState[] = [];
    for (const entry of readdirSync(this.directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error("Unsafe team directory");
      if (entry.isDirectory() && stagingDirectory.test(entry.name)) continue;
      if (entry.isDirectory()) states.push(this.read(entry.name));
    }
    return states;
  }

  update<T>(id: string, mutate: (state: TeamState) => T): T {
    const db = this.connection(id);
    db.exec("BEGIN IMMEDIATE");
    try {
      const state = readState(db, id);
      const result = mutate(state);
      if (result !== null && (typeof result === "object" || typeof result === "function")
        && typeof (result as { then?: unknown }).then === "function") throw new Error("Team updates must be synchronous");
      db.run("UPDATE team_state SET state = ? WHERE id = 1", encodeState(state, id));
      db.exec("COMMIT");
      return result;
    } catch (error) { return rollback(db, error); }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const failures: unknown[] = [];
    for (const db of [...this.connections.values(), ...(this.scheduler ? [this.scheduler] : [])]) {
      try { db.close(); }
      catch (error) { failures.push(error); }
    }
    this.connections.clear();
    this.scheduler = undefined;
    if (failures.length) throw new AggregateError(failures, "Failed to close team storage");
  }
}
