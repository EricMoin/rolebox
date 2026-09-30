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
  const marker = storeIdentityPath(graphStoreFilePath(directory));
  try {
    const saved = readFileSync(marker);
    writeFileSync(marker, "{");
    expect(() => store.get("SELECT 1")).toThrow("missing or malformed");
    expect(loadGraphStoreSync(directory).kind).toBe("corrupt");
    rmSync(marker);
    expect(() => GraphStore.openFile(directory)).toThrow("missing or malformed");
    writeFileSync(marker, saved);
    rmSync(graphStoreFilePath(directory));
    expect(() => store.get("SELECT 1")).toThrow("disappeared");
    expect(() => GraphStore.openFile(directory)).toThrow("bound database is missing");
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
