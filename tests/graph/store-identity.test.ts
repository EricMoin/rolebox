import { afterEach, expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { loadGraphStoreSync } from "../../src/graph/store/load.ts";
import { GRAPH_STORE_TABLES, graphStoreFilePath } from "../../src/graph/store/schema.ts";
import { initializeStoreIdentity, storeIdentityPath } from "../../src/graph/store/identity.ts";
import { createDatabaseSync } from "../../src/memory/db-driver.ts";

const roots: string[] = [];
function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "graph-identity-"));
  roots.push(directory);
  return directory;
}
afterEach(() => { for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it("classifies a real older metadata layout as unsupported without adding a binding", () => {
  const directory = root();
  const file = graphStoreFilePath(directory);
  const database = createDatabaseSync(file);
  database.exec(`CREATE TABLE ${GRAPH_STORE_TABLES.meta} (id INTEGER PRIMARY KEY, format_version INTEGER NOT NULL)`);
  database.run(`INSERT INTO ${GRAPH_STORE_TABLES.meta} VALUES (1, 7)`);
  database.close();
  expect(loadGraphStoreSync(directory).kind).toBe("unsupported");
  expect(() => GraphStore.openFile(directory)).toThrow("older");
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
