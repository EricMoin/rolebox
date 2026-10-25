import { afterEach, expect, it } from "vitest";
import { GraphStore } from "../../../src/graph/store/graph-store.ts";
import { GRAPH_STORE_TABLES as TABLES } from "../../../src/graph/store/schema.ts";

const stores: GraphStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture(): GraphStore {
  const store = GraphStore.openMemory();
  stores.push(store);
  return store;
}

it("shares one immutable dirty-graph snapshot and ignores no-op transactions", () => {
  const store = fixture();
  const before = store.all("SELECT type, name, sql FROM sqlite_master ORDER BY type, name");
  const first: (readonly string[])[] = [];
  const second: (readonly string[])[] = [];
  let commits = 0;
  store.observeTransactions({ beforeCommit: ids => first.push(ids), afterCommit: () => { commits++; } });
  store.observeTransactions({ beforeCommit: ids => second.push(ids), afterCommit() {} });
  store.transaction(() => {
    store.recordInvocationOrigin("z", { sessionId: "parent" }, 1);
    store.recordInvocationOrigin("a", { sessionId: "parent" }, 1);
  });
  expect(first).toEqual([["a", "z"]]);
  expect(second[0]).toBe(first[0]);
  expect(Object.isFrozen(first[0])).toBe(true);
  store.recordInvocationOrigin("a", { sessionId: "parent" }, 2);
  store.transaction(() => store.readInvocationOrigin("a"));
  expect(commits).toBe(1);
  expect(store.all("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")).toEqual(before);
});

it("retains raw local changes until capture and rolls back a refused capture", () => {
  const store = fixture();
  const captures: (readonly string[])[] = [];
  store.observeTransactions({ beforeCommit: ids => captures.push(ids), afterCommit() {} });
  store.run(`INSERT INTO ${TABLES.origins} VALUES ('raw', 'parent', NULL, 1)`);
  const refuse = store.observeTransactions({ beforeCommit() { throw new Error("refuse commit"); }, afterCommit() {} });
  expect(() => store.transaction(() => store.recordInvocationOrigin("rolled-back", { sessionId: "parent" }, 1)))
    .toThrow("refuse commit");
  refuse();
  expect(store.readInvocationOrigin("rolled-back")).toBeUndefined();
  store.transaction(() => {});
  store.transaction(() => {});
  expect(captures).toEqual([["raw", "rolled-back"], ["raw"]]);
});

it("tracks both graph ids of raw updates and every binding of an observation", () => {
  const store = fixture();
  const captures: (readonly string[])[] = [];
  store.observeTransactions({ beforeCommit: ids => captures.push(ids), afterCommit() {} });
  store.recordInvocationOrigin("old", { sessionId: "parent" }, 1);
  store.transaction(() => store.run(`UPDATE ${TABLES.origins} SET graph_id = 'new' WHERE graph_id = 'old'`));
  store.transaction(() => {
    for (const graph of ["first", "second"]) store.run(`INSERT INTO ${TABLES.executions}
      (graph_id, effect_id, attempt_id, state, owner_id, owner_generation, execution_id, claimed_at, updated_at)
      VALUES (?, 'dispatch:work#1', 'work#1', 'created', 'owner', 1, 'worker', 1, 1)`, graph);
  });
  store.rememberExecutionObservation("worker", { kind: "completed", reason: "Finished", observedAt: 2 });
  store.transaction(() => store.run(`UPDATE ${TABLES.executionObservations} SET reason = 'Updated' WHERE execution_id = 'worker'`));
  store.transaction(() => store.run(`DELETE FROM ${TABLES.executionObservations} WHERE execution_id = 'worker'`));
  store.transaction(() => store.run(`DELETE FROM ${TABLES.origins} WHERE graph_id = 'new'`));
  expect(captures).toEqual([["old"], ["new", "old"], ["first", "second"],
    ["first", "second"], ["first", "second"], ["first", "second"], ["new"]]);
});

it("reinstalls tracking after registration itself rolls back", () => {
  const store = fixture();
  const captures: (readonly string[])[] = [];
  expect(() => store.transaction(() => {
    store.observeTransactions({ beforeCommit: ids => captures.push(ids), afterCommit() {} });
    throw new Error("rollback registration");
  })).toThrow("rollback registration");
  store.recordInvocationOrigin("later", { sessionId: "parent" }, 1);
  expect(captures).toEqual([["later"]]);
});
