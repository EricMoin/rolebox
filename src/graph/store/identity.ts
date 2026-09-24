import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseDriver } from "../../memory/db-driver.ts";
import { GraphStoreFormatError } from "./errors.ts";
import { GRAPH_STORE_FORMAT_VERSION, GRAPH_STORE_TABLES } from "./schema.ts";

export const GRAPH_STORE_IDENTITY_FILE = "graph-store.identity";

export function storeIdentityPath(filePath: string): string {
  return join(dirname(filePath), GRAPH_STORE_IDENTITY_FILE);
}

export function identityRefusal(filePath: string, reason: string): GraphStoreFormatError {
  return new GraphStoreFormatError("store-identity", filePath,
    `graph-store: ${reason}; restore the database and its matching identity binding before resuming`,
    undefined, GRAPH_STORE_FORMAT_VERSION);
}

/** The marker contains storage identity only; SQLite owns all execution state. */
export function initializeStoreIdentity(filePath: string): string {
  const storeId = randomUUID();
  const marker = storeIdentityPath(filePath);
  let fd: number;
  try {
    fd = openSync(marker, "wx", 0o600);
  } catch {
    throw identityRefusal(filePath, "initialization already claimed; the existing binding must not be replaced");
  }
  try {
    writeFileSync(fd, JSON.stringify({ version: 1, storeId }) + "\n");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const directory = openSync(dirname(marker), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
  return storeId;
}

export function readStoreIdentity(filePath: string): string {
  try {
    const value = JSON.parse(readFileSync(storeIdentityPath(filePath), "utf8"));
    if (value?.version === 1 && typeof value.storeId === "string" &&
      /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.storeId) &&
      Object.keys(value).length === 2) return value.storeId;
  } catch { /* A missing or interrupted binding is not a fresh workspace. */ }
  throw identityRefusal(filePath, "storage identity binding is missing or malformed");
}

export function verifyStoreIdentity(db: DatabaseDriver, filePath: string): void {
  if (filePath === ":memory:") return;
  const expected = readStoreIdentity(filePath);
  const row = db.query(`SELECT store_id FROM ${GRAPH_STORE_TABLES.meta} WHERE id = 1`).get();
  if (typeof row !== "object" || row === null || !("store_id" in row) || row.store_id !== expected) {
    throw identityRefusal(filePath, "database identity does not match the workspace binding");
  }
}
