import { spawnProcessSync } from "../../scripts/node-process.ts";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutcomeHost, type OutcomeWorkerPrincipal, type OutcomeWorkerToolGrant } from "../../src/graph/host/outcome-host.ts";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { dispatchEffectKeyOf, type OutcomeDispatchRequest } from "../../src/graph/outcome/dispatch-effects.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { readStoredDefinition, readStoredRunStateOf } from "../../src/graph/persistence/declared-record.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { loadGraphStoreSync } from "../../src/graph/store/load.ts";
import { storeIdentityPath } from "../../src/graph/store/identity.ts";
import { GRAPH_STORE_TABLES as tables, graphStoreFilePath } from "../../src/graph/store/schema.ts";
import { buildDeclaredOutcomeGraph, persistDeclaredGraph } from "../../src/graph/tools/declare-graph.ts";
import { createDatabaseSync } from "../../src/memory/db-driver.ts";
import { removeTempTrees } from "./helpers/temp-dirs.ts";
import { attemptStoreEntryRemoval } from "./helpers/vanish-store.ts";

const directories: string[] = [];
const hosts: OutcomeHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
  removeTempTrees(directories);
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "worker-read-model-"));
  directories.push(path);
  return path;
}

function declaration(name: string): GraphDeclarationV3 {
  return { version: 3, name, nodes: [
    { id: "granted", agent: "worker", prompt: "Read documents.", outcomes: [{ id: "done" }],
      tools: ["docs_*"], toolPresentation: { mode: "discover", preload: ["docs_read"] } },
    { id: "baseline", agent: "worker", prompt: "Submit the result.", outcomes: [{ id: "done" }] },
    { id: "other", agent: "worker", prompt: "Read images.", outcomes: [{ id: "done" }], tools: ["images_read"] },
  ], edges: [] };
}

function open(root: string, dispatched: OutcomeDispatchRequest[] = []): OutcomeHost {
  let host: OutcomeHost;
  host = OutcomeHost.open({ workspaceDir: root, storeRoot: root,
    declareInvocationIdentity: false, workerSessionOf: execution => execution.executionId,
    validators: createValidatorRegistry([]), deliver: (request, effect) => {
      dispatched.push(request);
      host.confirmExecution(effect, { executionId: "worker:" + request.attemptId });
    },
  });
  hosts.push(host);
  return host;
}

async function fixture() {
  const root = directory();
  const graphId = "worker-read-model";
  persistDeclaredGraph(buildDeclaredOutcomeGraph({ declaration: declaration(graphId) }), root);
  const dispatched: OutcomeDispatchRequest[] = [];
  const first = open(root, dispatched);
  expect((await first.startDeclaredGraph(graphId, { sessionId: "parent", agent: "parent" })).kind).toBe("started");
  const request = dispatched.find(entry => entry.nodeId === "granted")!;
  const principal: OutcomeWorkerPrincipal = { graphId, attemptId: request.attemptId,
    executionId: "worker:" + request.attemptId, workerSessionId: "worker:" + request.attemptId };
  return { root, graphId, first, dispatched, request, principal, reader: open(root) };
}

function mutate(root: string, write: (store: GraphStore) => void): void {
  const store = GraphStore.openFile(root);
  try { write(store); } finally { store.close(); }
}

const expectedGrant = { declaredTools: ["docs_*"], toolPresentation: { mode: "discover", preload: ["docs_read"] } } satisfies OutcomeWorkerToolGrant;

it("indexes all worker identities once per committed revision and caches both grant fields", async () => {
  const fx = await fixture();
  for (let i = 0; i < 30; i++) {
    const graphId = "historical-" + String(i).padStart(2, "0");
    persistDeclaredGraph(buildDeclaredOutcomeGraph({ declaration: declaration(graphId) }), fx.root);
    mutate(fx.root, store => {
      for (let attempt = 0; attempt < 10; attempt++) {
        store.run(`INSERT INTO ${tables.executions}
          (graph_id, effect_id, attempt_id, state, owner_id, owner_generation, execution_id, claimed_at, updated_at)
          VALUES (?, ?, ?, 'created', 'owner', 1, ?, 1, 1)`, graphId, "dispatch:" + attempt, String(attempt), "historical:" + i + ":" + attempt);
        store.run(`INSERT INTO ${tables.acceptedEvents} VALUES (?, ?, 'submission', 'revision', 'done', 1)`, graphId, String(attempt));
      }
    });
  }
  const bulk = vi.spyOn(GraphStore.prototype, "readWorkerExecutions");
  const execution = vi.spyOn(GraphStore.prototype, "readExecution");
  const definitions = vi.spyOn(GraphStore.prototype, "readDefinition");
  const pending = vi.spyOn(GraphStore.prototype, "pendingEffects");
  const accepted = vi.spyOn(GraphStore.prototype, "acceptedEvents");
  const inventory = vi.spyOn(GraphStore.prototype, "definitionGraphIds");
  try {
    for (let i = 0; i < 100; i++) {
      expect(fx.reader.workerPrincipalOf("unrelated:" + i)).toBeUndefined();
      expect(fx.reader.workerPrincipalOf(fx.principal.workerSessionId)).toEqual(fx.principal);
      expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
      expect(fx.reader.workerDeclaredToolsOf(fx.principal)).toEqual(expectedGrant.declaredTools);
      expect(fx.reader.workerToolPresentationOf(fx.principal)).toEqual(expectedGrant.toolPresentation);
    }
    expect(bulk).toHaveBeenCalledTimes(1);
    expect(execution).toHaveBeenCalledTimes(1);
    expect(definitions).toHaveBeenCalledTimes(1);
    expect(pending).toHaveBeenCalledTimes(1);
    expect(accepted).not.toHaveBeenCalled();
    expect(inventory).not.toHaveBeenCalled();
    const baseline = fx.dispatched.find(entry => entry.nodeId === "baseline")!;
    const principal = fx.reader.workerPrincipalOf("worker:" + baseline.attemptId)!;
    const grant = fx.reader.workerToolGrantOf(principal);
    expect(grant).toEqual({});
    expect(fx.reader.workerToolGrantOf(principal)).toBe(grant);
    expect(definitions).toHaveBeenCalledTimes(1);
  } finally {
    for (const spy of [bulk, execution, definitions, pending, accepted, inventory]) spy.mockRestore();
  }
});

it("shares typed dispatch and recorded-state inputs across distinct workers of one graph", async () => {
  const fx = await fixture();
  const principals = fx.dispatched.map(request => ({ graphId: fx.graphId, attemptId: request.attemptId,
    executionId: "worker:" + request.attemptId, workerSessionId: "worker:" + request.attemptId }));
  const pending = vi.spyOn(GraphStore.prototype, "pendingEffects");
  const state = vi.spyOn(GraphStore.prototype, "readGraphState");
  const definitions = vi.spyOn(GraphStore.prototype, "readDefinition");
  try {
    for (const principal of principals) fx.reader.workerToolGrantOf(principal);
    expect(pending).toHaveBeenCalledTimes(1);
    expect(state).not.toHaveBeenCalled();
    expect(definitions).toHaveBeenCalledTimes(1);
    mutate(fx.root, store => {
      store.run(`UPDATE ${tables.pendingEffects} SET status = 'done' WHERE graph_id = ?`, fx.graphId);
    });
    pending.mockClear();
    state.mockClear();
    definitions.mockClear();
    const grants = principals.map(principal => fx.reader.workerToolGrantOf(principal));
    expect(grants[fx.dispatched.findIndex(request => request.nodeId === "granted")]).toEqual(expectedGrant);
    expect(grants[fx.dispatched.findIndex(request => request.nodeId === "baseline")]).toEqual({});
    expect(pending).toHaveBeenCalledTimes(1);
    expect(state).toHaveBeenCalledTimes(1);
    expect(definitions).toHaveBeenCalledTimes(1);
  } finally {
    for (const spy of [pending, state, definitions]) spy.mockRestore();
  }
});

it("invalidates a negative identity after a same-process writer commits and after an independent connection commits", async () => {
  const fx = await fixture();
  const session = "new-worker";
  expect(fx.reader.workerPrincipalOf(session)).toBeUndefined();
  mutate(fx.root, store => {
    store.run(`UPDATE ${tables.executions} SET execution_id = ? WHERE graph_id = ? AND attempt_id = ?`, session, fx.graphId, fx.request.attemptId);
  });
  expect(fx.reader.workerPrincipalOf(session)?.attemptId).toBe(fx.request.attemptId);
  expect(fx.reader.workerPrincipalOf(fx.principal.workerSessionId)).toBeUndefined();
  expect(fx.reader.workerPrincipalOf("external-worker")).toBeUndefined();
  // A file URL, never `new URL(...).pathname`: on Windows the pathname of a
  // file URL is "/D:/a/rolebox/…", which the child runtime cannot import (the
  // leading separator makes it root-relative on the current drive).
  const driverUrl = new URL("../../src/memory/db-driver.ts", import.meta.url).href;
  const child = spawnProcessSync([process.execPath, "-e", `
    import { createDatabaseSync } from ${JSON.stringify(driverUrl)};
    const db = createDatabaseSync(process.argv[1]);
    db.run("UPDATE host_dispatch_executions SET execution_id = ? WHERE graph_id = ? AND attempt_id = ?", "external-worker", process.argv[2], process.argv[3]);
    db.close();
  `, graphStoreFilePath(fx.root), fx.graphId, fx.request.attemptId]);
  expect(child.exitCode).toBe(0);
  expect(fx.reader.workerPrincipalOf("external-worker")?.attemptId).toBe(fx.request.attemptId);
  expect(fx.reader.workerPrincipalOf(session)).toBeUndefined();
});

it("refreshes dispatch, definition and state grants together after commits", async () => {
  const fx = await fixture();
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
  mutate(fx.root, store => {
    const effect = store.pendingEffects(fx.graphId).find(entry => entry.attemptId === fx.request.attemptId)!;
    store.run(`UPDATE ${tables.pendingEffects} SET payload = ? WHERE graph_id = ? AND effect_id = ?`,
      JSON.stringify({ ...(effect.payload as Record<string, unknown>), nodeId: "other" }), fx.graphId, effect.effectId);
  });
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual({ declaredTools: ["images_read"] });
  let savedDefinition = "";
  mutate(fx.root, store => {
    const row = store.readDefinition(fx.graphId)!;
    savedDefinition = JSON.stringify(row.plan);
    store.run(`UPDATE ${tables.definitions} SET plan = '{}' WHERE graph_id = ?`, fx.graphId);
  });
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual({});
  mutate(fx.root, store => {
    store.run(`UPDATE ${tables.definitions} SET plan = ? WHERE graph_id = ?`, savedDefinition, fx.graphId);
    store.run(`UPDATE ${tables.pendingEffects} SET status = 'done' WHERE graph_id = ?`, fx.graphId);
  });
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
  const definition = readStoredDefinition(fx.root, fx.graphId);
  if (definition.kind !== "ok") throw new Error("fixture definition missing");
  mutate(fx.root, store => {
    const reading = readStoredRunStateOf(store, definition.declared);
    if (reading.kind !== "recorded") throw new Error("fixture state missing");
    const state = store.readGraphState(fx.graphId)!;
    store.writeGraphState({ ...state, body: { ...reading.state, bodyVersion: 99 } });
  });
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual({});
});

it("does not publish uncommitted grant changes or keep grants after a rolled back read", async () => {
  const fx = await fixture();
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
  mutate(fx.root, store => {
    expect(() => store.transaction(() => {
      store.run(`UPDATE ${tables.definitions} SET plan = '{}' WHERE graph_id = ?`, fx.graphId);
      expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
      throw new Error("rollback fixture");
    })).toThrow("rollback fixture");
  });
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
});

it.each(["before", "after"] as const)("keeps worker identity when a writer commits %s the read transaction", async phase => {
  const fx = await fixture();
  const acquire = vi.spyOn(GraphStore, "acquireReadOnlyConnection");
  let driver: ReturnType<typeof createDatabaseSync>;
  try {
    expect(fx.reader.workerPrincipalOf(fx.principal.workerSessionId)).toEqual(fx.principal);
    expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
    const result = acquire.mock.results[0];
    if (result?.type !== "return") throw new Error("fixture connection missing");
    driver = result.value.connection.db;
  } finally { acquire.mockRestore(); }
  const writer = createDatabaseSync(graphStoreFilePath(fx.root));
  const effect = writer.query(`SELECT payload FROM ${tables.pendingEffects} WHERE graph_id = ? AND attempt_id = ?`)
    .get(fx.graphId, fx.request.attemptId) as { payload: string };
  const payload = JSON.stringify({ ...JSON.parse(effect.payload), nodeId: "other" });
  let armed = true;
  const commit = () => {
    if (!armed) return;
    armed = false;
    writer.run(`UPDATE ${tables.pendingEffects} SET payload = ? WHERE graph_id = ? AND attempt_id = ?`,
      payload, fx.graphId, fx.request.attemptId);
  };
  const transaction = driver.transaction.bind(driver);
  const hook = vi.spyOn(driver, "transaction").mockImplementation(<R>(read: () => R) => {
    const run = transaction(read);
    return () => {
      if (phase === "before") commit();
      const value = run();
      if (phase === "after") commit();
      return value;
    };
  });
  try {
    expect(fx.reader.workerPrincipalOf(fx.principal.workerSessionId)).toEqual(fx.principal);
    expect(armed).toBe(false);
    expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual({ declaredTools: ["images_read"] });
    expect(fx.reader.workerPrincipalOf(fx.principal.workerSessionId)).toEqual(fx.principal);
  } finally {
    hook.mockRestore();
    writer.close();
  }
});

it("retains locally confirmed identity while grants fail closed and retries after marker repair", async () => {
  const fx = await fixture();
  expect(fx.first.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
  expect(fx.reader.workerPrincipalOf(fx.principal.workerSessionId)).toEqual(fx.principal);
  const marker = storeIdentityPath(graphStoreFilePath(fx.root));
  const saved = readFileSync(marker);
  writeFileSync(marker, "{");
  expect(fx.first.workerPrincipalOf(fx.principal.workerSessionId)).toEqual(fx.principal);
  expect(fx.first.workerToolGrantOf(fx.principal)).toEqual({});
  expect(fx.reader.workerPrincipalOf(fx.principal.workerSessionId)).toBeUndefined();
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual({});
  writeFileSync(marker, saved);
  expect(fx.reader.workerPrincipalOf(fx.principal.workerSessionId)).toEqual(fx.principal);
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
});

it("revalidates schema changes before returning cached identities or grants", async () => {
  const fx = await fixture();
  expect(fx.reader.workerPrincipalOf(fx.principal.workerSessionId)).toEqual(fx.principal);
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
  const db = createDatabaseSync(graphStoreFilePath(fx.root));
  try { db.exec(`DROP TABLE ${tables.workerChannels}`); } finally { db.close(); }
  expect(fx.reader.workerPrincipalOf(fx.principal.workerSessionId)).toBeUndefined();
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual({});
});

it("does not retain cached grants when the database disappears", async () => {
  const fx = await fixture();
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
  const removal = attemptStoreEntryRemoval(fx.root);
  if (removal.removed) {
    expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual({});
    expect(fx.reader.workerPrincipalOf(fx.principal.workerSessionId)).toBeUndefined();
  } else {
    expect(removal.refusals.every(refusal => /^(EBUSY|EPERM|EACCES)$/.test(refusal.code))).toBe(true);
    expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
  }
});

it("drops cached authorization for corrupt bytes and retries after a matching restore", async () => {
  const fx = await fixture();
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
  const file = graphStoreFilePath(fx.root);
  const saved = readFileSync(file);
  writeFileSync(file, "not a database");
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual({});
  expect(fx.reader.workerPrincipalOf(fx.principal.workerSessionId)).toBeUndefined();
  writeFileSync(file, saved);
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
});

it("refuses raw in-place writes during a read snapshot", async () => {
  const fx = await fixture();
  const file = graphStoreFilePath(fx.root);
  const saved = readFileSync(file);
  const loaded = loadGraphStoreSync(fx.root);
  if (loaded.kind !== "valid") throw new Error("fixture store missing");
  try {
    expect(() => loaded.value.readOnlySnapshot(() => {
      writeFileSync(file, saved);
      return "stale grant";
    })).toThrow("changed during its read snapshot");
  } finally { loaded.value.close(); }
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
});

it("drops the old inode and reopens a valid replacement on the following read", async () => {
  const fx = await fixture();
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
  const file = graphStoreFilePath(fx.root);
  const saved = readFileSync(file);
  const removal = attemptStoreEntryRemoval(fx.root);
  if (!removal.removed) {
    expect(removal.refusals.every(refusal => /^(EBUSY|EPERM|EACCES)$/.test(refusal.code))).toBe(true);
    return;
  }
  writeFileSync(file, saved);
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual({});
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
});

it("refuses a same-inode database with another identity and recovers after restoration", async () => {
  const fx = await fixture();
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
  const other = directory();
  GraphStore.openFile(other).close();
  const file = graphStoreFilePath(fx.root);
  const saved = readFileSync(file);
  const inode = statSync(file).ino;
  const replacement = readFileSync(graphStoreFilePath(other));
  saved.copy(replacement, 24, 24, 28);
  saved.copy(replacement, 92, 92, 96);
  writeFileSync(file, replacement);
  expect(statSync(file).ino).toBe(inode);
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual({});
  expect(fx.reader.workerPrincipalOf(fx.principal.workerSessionId)).toBeUndefined();
  writeFileSync(file, saved);
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
});

it("reopens a fenced shared reader while another host retains the old connection", async () => {
  const fx = await fixture();
  const stale = open(fx.root);
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
  expect(stale.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
  const other = directory();
  GraphStore.openFile(other).close();
  const file = graphStoreFilePath(fx.root);
  const saved = readFileSync(file);
  const replacement = readFileSync(graphStoreFilePath(other));
  saved.copy(replacement, 24, 24, 28);
  saved.copy(replacement, 92, 92, 96);
  writeFileSync(file, replacement);
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual({});
  writeFileSync(file, saved);
  const acquire = vi.spyOn(GraphStore, "acquireReadOnlyConnection");
  try {
    expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
    const first = acquire.mock.results[0];
    if (first?.type !== "return") throw new Error("fixture connection missing");
    stale.close();
    expect(open(fx.root).workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
    const second = acquire.mock.results[1];
    if (second?.type !== "return") throw new Error("fixture connection missing");
    expect(second.value.connection).toBe(first.value.connection);
  } finally { acquire.mockRestore(); }
});

it("lets a cold host replace a stale pooled reader without waiting for its old owner", async () => {
  const fx = await fixture();
  expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
  const cold = open(fx.root);
  const nextHost = open(fx.root);
  const file = graphStoreFilePath(fx.root);
  const saved = readFileSync(file);
  const removal = attemptStoreEntryRemoval(fx.root);
  if (!removal.removed) {
    expect(removal.refusals.every(refusal => /^(EBUSY|EPERM|EACCES)$/.test(refusal.code))).toBe(true);
    return;
  }
  writeFileSync(file, saved);
  const acquire = vi.spyOn(GraphStore, "acquireReadOnlyConnection");
  try {
    expect(cold.workerToolGrantOf(fx.principal)).toEqual({});
    expect(cold.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
    const fresh = acquire.mock.results[1];
    if (fresh?.type !== "return") throw new Error("fixture fresh connection missing");
    fx.reader.close();
    expect(nextHost.workerToolGrantOf(fx.principal)).toEqual(expectedGrant);
    const next = acquire.mock.results[2];
    if (next?.type !== "return") throw new Error("fixture shared connection missing");
    expect(next.value.connection).toBe(fresh.value.connection);
  } finally { acquire.mockRestore(); }
});

it("releases its retained read-only connection and does not reopen after close", async () => {
  const fx = await fixture();
  const acquire = vi.spyOn(GraphStore, "acquireReadOnlyConnection");
  try {
    expect(fx.reader.workerPrincipalOf(fx.principal.workerSessionId)).toEqual(fx.principal);
    expect(acquire).toHaveBeenCalledTimes(1);
    const result = acquire.mock.results[0];
    if (result?.type !== "return") throw new Error("fixture read-only connection missing");
    const close = vi.spyOn(result.value.connection.db, "close");
    try {
      fx.reader.close();
      expect(close).toHaveBeenCalledTimes(1);
      expect(fx.reader.workerPrincipalOf(fx.principal.workerSessionId)).toBeUndefined();
      expect(fx.reader.workerToolGrantOf(fx.principal)).toEqual({});
      expect(acquire).toHaveBeenCalledTimes(1);
    } finally { close.mockRestore(); }
  } finally { acquire.mockRestore(); }
});

it("bulk identity reads preserve current-run, accepted-history and deterministic first-match semantics", async () => {
  const fx = await fixture();
  mutate(fx.root, store => {
    const current = store.runs.readRun(fx.graphId)!;
    store.run(`UPDATE ${tables.pendingEffects} SET status = 'done' WHERE graph_id = ?`, fx.graphId);
    store.run(`INSERT INTO ${tables.acceptedEvents} VALUES (?, ?, 'submission', ?, 'done', 1)`, fx.graphId, fx.request.attemptId, current.planRevision);
    store.run(`INSERT INTO ${tables.runs} (graph_id, run_id, run_seq, plan_revision, started_at) VALUES (?, 'next-run', ?, ?, 2)`,
      fx.graphId, current.runSeq + 1, current.planRevision);
    store.run(`UPDATE ${tables.pendingEffects} SET status = 'pending' WHERE graph_id = ? AND attempt_id != ?`, fx.graphId, fx.request.attemptId);
  });
  expect(fx.reader.workerPrincipalOf(fx.principal.workerSessionId)).toEqual(fx.principal);
  for (const request of fx.dispatched.filter(entry => entry.nodeId !== "granted")) {
    expect(fx.reader.workerPrincipalOf("worker:" + request.attemptId)).toBeUndefined();
  }
  mutate(fx.root, store => {
    store.run(`DELETE FROM ${tables.runs} WHERE graph_id = ?`, fx.graphId);
    store.run(`UPDATE ${tables.executions} SET execution_id = 'shared-worker' WHERE graph_id = ?`, fx.graphId);
    store.run(`UPDATE ${tables.pendingEffects} SET created_at = CASE WHEN attempt_id = ? THEN 2 ELSE 1 END WHERE graph_id = ?`, fx.request.attemptId, fx.graphId);
  });
  const expected = fx.dispatched.filter(entry => entry.nodeId !== "granted").sort((a, b) =>
    dispatchEffectKeyOf(fx.graphId, a.attemptId).effectId.localeCompare(dispatchEffectKeyOf(fx.graphId, b.attemptId).effectId))[0]!;
  expect(fx.reader.workerPrincipalOf("shared-worker")?.attemptId).toBe(expected.attemptId);
});

it("bulk execution reads use the same strict row decoder as direct reads", async () => {
  const fx = await fixture();
  mutate(fx.root, store => {
    store.run("PRAGMA ignore_check_constraints = ON");
    try {
      store.run(`UPDATE ${tables.executions} SET owner_generation = 0 WHERE graph_id = ?`, fx.graphId);
    } finally { store.run("PRAGMA ignore_check_constraints = OFF"); }
    expect(() => store.readExecution(dispatchEffectKeyOf(fx.graphId, fx.request.attemptId))).toThrow("claim generation");
    expect(() => store.readWorkerExecutions()).toThrow("claim generation");
  });
  expect(fx.reader.workerPrincipalOf(fx.principal.workerSessionId)).toBeUndefined();
});
