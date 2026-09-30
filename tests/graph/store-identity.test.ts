import { afterEach, expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStoreFormatError } from "../../src/graph/store/errors.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { loadGraphStoreSync } from "../../src/graph/store/load.ts";
import { GRAPH_STORE_FORMAT_VERSION, GRAPH_STORE_TABLES, graphStoreFilePath } from "../../src/graph/store/schema.ts";
import { initializeStoreIdentity, readStoreIdentity, storeIdentityPath } from "../../src/graph/store/identity.ts";
import { createDatabaseSync } from "../../src/memory/db-driver.ts";
import { setPlatformForTest } from "../../src/platform/system/index.ts";
import { attemptStoreEntryRemoval, attemptStoreRootMoveAside } from "./helpers/vanish-store.ts";

/** SQLite's own file magic, the first 16 bytes of every database file. */
const SQLITE_MAGIC = "SQLite format 3\u0000";

const roots: string[] = [];
function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "graph-identity-"));
  roots.push(directory);
  return directory;
}
afterEach(() => { for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }); });

/**
 * The refusal an open call throws, narrowed to the stable typed facts.
 * GraphStoreFormatProblem documents its identifiers as stable and its wording as
 * not API, so the message is deliberately not asserted: a message substring can
 * match a temporary PATH instead of the refusal (a darwin mkdtempSync root
 * contains the letters of "older"), which is exactly what made the old assertion
 * pass on one platform and fail on another.
 */
function refusalOf(open: () => unknown): GraphStoreFormatError {
  try {
    open();
  } catch (error) {
    if (error instanceof GraphStoreFormatError) return error;
    throw error;
  }
  throw new Error("expected the open to refuse, but it returned a store");
}

it("classifies a real older metadata layout as unsupported without adding a binding", () => {
  const directory = root();
  const file = graphStoreFilePath(directory);
  const database = createDatabaseSync(file);
  database.exec(`CREATE TABLE ${GRAPH_STORE_TABLES.meta} (id INTEGER PRIMARY KEY, format_version INTEGER NOT NULL)`);
  database.run(`INSERT INTO ${GRAPH_STORE_TABLES.meta} VALUES (1, 7)`);
  database.close();
  expect(loadGraphStoreSync(directory).kind).toBe("unsupported");
  const refusal = refusalOf(() => GraphStore.openFile(directory));
  expect(refusal.problem).toBe("older-format");
  expect(refusal.found).toBe(7);
  expect(refusal.supported).toBe(GRAPH_STORE_FORMAT_VERSION);
  expect(existsSync(storeIdentityPath(file))).toBe(false);
});

it("initializes a matching database identity and a marker containing no execution data", () => {
  const directory = root();
  const store = GraphStore.openFile(directory);
  try {
    const marker = JSON.parse(readFileSync(storeIdentityPath(graphStoreFilePath(directory)), "utf8"));
    expect(Object.keys(marker).sort()).toEqual(["storeId", "version"]);
    expect(store.get(`SELECT store_id FROM ${GRAPH_STORE_TABLES.meta}`)).toEqual({ store_id: marker.storeId });
  } finally { store.close(); }
  const loaded = loadGraphStoreSync(directory);
  expect(loaded.kind).toBe("valid");
  if (loaded.kind === "valid") loaded.value.close();
});

it("refuses a missing bound database on both read and write opens without recreating it", async () => {
  const directory = root();
  const store = GraphStore.openFile(directory);
  const file = graphStoreFilePath(directory);
  store.close();
  rmSync(file);
  expect(loadGraphStoreSync(directory).kind).toBe("corrupt");
  expect(() => GraphStore.openFile(directory)).toThrow("bound database is missing");
  await expect(GraphStore.openFileAsync(directory)).rejects.toThrow("bound database is missing");
  expect(existsSync(file)).toBe(false);
});

it("refuses interrupted initialization instead of silently completing a new store", () => {
  const directory = root();
  const file = graphStoreFilePath(directory);
  initializeStoreIdentity(file);
  expect(() => GraphStore.openFile(directory)).toThrow("initialization was interrupted");
  expect(existsSync(file)).toBe(false);
  writeFileSync(file, "");
  expect(() => GraphStore.openFile(directory)).toThrow("ZERO BYTES");
  expect(readFileSync(file).byteLength).toBe(0);
});

it("accepts a matching restored backup and refuses a database from another identity", () => {
  const directory = root();
  const other = root();
  const store = GraphStore.openFile(directory);
  store.close();
  const second = GraphStore.openFile(other);
  second.close();
  const file = graphStoreFilePath(directory);
  const backup = join(directory, "backup.sqlite");
  copyFileSync(file, backup);
  copyFileSync(graphStoreFilePath(other), file);
  expect(loadGraphStoreSync(directory).kind).toBe("corrupt");
  expect(() => GraphStore.openFile(directory)).toThrow("does not match");
  copyFileSync(backup, file);
  const restored = GraphStore.openFile(directory);
  restored.close();
});

it("refuses missing or malformed markers and fences an already open handle", () => {
  const directory = root();
  const store = GraphStore.openFile(directory);
  const file = graphStoreFilePath(directory);
  const marker = storeIdentityPath(file);
  const storeId = readStoreIdentity(file);
  try {
    const saved = readFileSync(marker);
    writeFileSync(marker, "{");
    expect(() => store.get("SELECT 1")).toThrow("missing or malformed");
    expect(loadGraphStoreSync(directory).kind).toBe("corrupt");
    rmSync(marker);
    expect(() => GraphStore.openFile(directory)).toThrow("missing or malformed");
    writeFileSync(marker, saved);
    // Can this platform make an OPEN database's path disappear? The POSIX family
    // unlinks it under the handle; windows-latest refuses the unlink (`EBUSY`)
    // and the move of the entry (`EPERM`) — the CI finding helpers/vanish-store.ts
    // records. The helper reports which happened, and each platform asserts the
    // truth it can have.
    const removal = attemptStoreEntryRemoval(directory);
    if (removal.removed) {
      expect(() => store.get("SELECT 1")).toThrow("disappeared");
      expect(() => GraphStore.openFile(directory)).toThrow("bound database is missing");
    } else {
      // The refusal is the OS's, reported with its own errno — not this helper
      // giving up — and it changed nothing: the open store keeps serving and
      // raises NO false fence, and the authoritative file is still the database
      // that holds this store's records.
      expect(removal.refusals.map(refusal => refusal.operation)).toEqual(["unlink", "rename-entry"]);
      for (const refusal of removal.refusals) {
        expect(refusal.code, refusal.operation).toMatch(/^(EBUSY|EPERM|EACCES)$/);
      }
      expect(() => store.get("SELECT 1")).not.toThrow();
      expect(store.get(`SELECT store_id FROM ${GRAPH_STORE_TABLES.meta} WHERE id = 1`)).toEqual({ store_id: storeId });
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file).subarray(0, 16).toString("latin1")).toBe(SQLITE_MAGIC);
      // The refusal was the open handle's, not the path's: with the store closed
      // the very same removal is permitted, and the next open refuses the bound
      // database it can no longer find.
      store.close();
      expect(attemptStoreEntryRemoval(directory).removed).toBe(true);
      expect(() => GraphStore.openFile(directory)).toThrow("bound database is missing");
    }
  } finally { store.close(); }
});

/**
 * The ROOT-move mechanism: where the platform lets it run, and the refusal where
 * it does not.
 *
 * A store root has no open handle of its own, so the POSIX family moves the whole
 * root while the database inside stays open — the path the store was opened over
 * disappears and the store fences. windows-latest REFUSES that move while the
 * store is open (`EPERM: operation not permitted, rename '<root>' ->
 * '<aside>\<name>'`, run 36673190424), so on that family the same test asserts
 * the truth the refusal leaves behind: the root, its marker and its database are
 * untouched and the open store keeps serving instead of raising a false fence —
 * and the very same move is permitted, and the next open refuses, once the store
 * is closed. Neither branch is a weakened claim: each is what the platform really
 * does with an open database's path.
 */
it("fences the store when the open database's root can be moved aside, and keeps serving when the platform refuses", () => {
  const directory = root();
  const store = GraphStore.openFile(directory);
  const file = graphStoreFilePath(directory);
  const storeId = readStoreIdentity(file);
  try {
    const attempt = attemptStoreRootMoveAside(directory);
    if (attempt.removed) {
      const moved = attempt.movedTo ?? "";
      expect(moved).not.toBe("");
      expect(existsSync(moved)).toBe(true);
      expect(existsSync(file)).toBe(false);
      // The marker stays behind, which is what makes the recreated root still this
      // store's directory rather than a new one.
      expect(existsSync(storeIdentityPath(file))).toBe(true);
      expect(() => store.get("SELECT 1")).toThrow("disappeared");
      expect(() => GraphStore.openFile(directory)).toThrow("bound database is missing");
    } else {
      expect(attempt.refusals.map(refusal => refusal.operation)).toEqual(["rename-root"]);
      for (const refusal of attempt.refusals) {
        expect(refusal.code, refusal.operation).toMatch(/^(EBUSY|EPERM|EACCES)$/);
      }
      // Nothing moved: the root, its marker and its database are where they were,
      // and the open store still reads the records it holds.
      expect(existsSync(file)).toBe(true);
      expect(existsSync(storeIdentityPath(file))).toBe(true);
      expect(() => store.get("SELECT 1")).not.toThrow();
      expect(store.get(`SELECT store_id FROM ${GRAPH_STORE_TABLES.meta} WHERE id = 1`)).toEqual({ store_id: storeId });
      expect(readFileSync(file).subarray(0, 16).toString("latin1")).toBe(SQLITE_MAGIC);
      // The refusal was the open handle's, not the directory's: with the store
      // closed the very same move succeeds and the next open refuses the database
      // the recreated root no longer holds.
      store.close();
      const afterClose = attemptStoreRootMoveAside(directory);
      expect(afterClose.removed).toBe(true);
      expect(existsSync(file)).toBe(false);
      expect(() => GraphStore.openFile(directory)).toThrow("bound database is missing");
    }
  } finally { store.close(); }
});

/**
 * Simulation, not a Windows execution: this host cannot run win32, so the win32
 * descriptor is selected through the platform seam and the open is exercised
 * here. The point is that the durability step Windows cannot perform is the one
 * the store now skips — an unguarded directory fsync would make every store open
 * fail on Windows, which is what the CI windows-latest lane reported.
 */
it("simulates the Windows path: a win32 host initializes, verifies and reuses one store id", () => {
  const directory = root();
  const file = graphStoreFilePath(directory);
  setPlatformForTest("win32");
  try {
    const first = GraphStore.openFile(directory);
    const storeId = readStoreIdentity(file);
    try {
      expect(existsSync(storeIdentityPath(file))).toBe(true);
      expect(first.get(`SELECT store_id FROM ${GRAPH_STORE_TABLES.meta}`)).toEqual({ store_id: storeId });
    } finally { first.close(); }
    const second = GraphStore.openFile(directory);
    try {
      expect(readStoreIdentity(file)).toBe(storeId);
      expect(second.get(`SELECT store_id FROM ${GRAPH_STORE_TABLES.meta}`)).toEqual({ store_id: storeId });
    } finally { second.close(); }
    const loaded = loadGraphStoreSync(directory);
    expect(loaded.kind).toBe("valid");
    if (loaded.kind === "valid") loaded.value.close();
  } finally { setPlatformForTest(undefined); }
});
