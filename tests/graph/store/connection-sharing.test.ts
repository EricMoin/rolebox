import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../../src/graph/store/graph-store.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("graph store connection sharing", () => {
  it("shares a read transaction between concurrent read-only openers", async () => {
    const root = mkdtempSync(join(tmpdir(), "graph-connections-"));
    roots.push(root);
    const writer = GraphStore.openFile(root);
    writer.runs.mintRun({ graphId: "graph", runId: "run", planRevision: "plan", startedAt: 1 });
    writer.close();
    const borrowed = await Promise.all([
      GraphStore.acquireReadOnlyConnectionAsync(writer.path),
      GraphStore.acquireReadOnlyConnectionAsync(writer.path),
    ]);
    const [first, second] = borrowed.map(({ connection, key }) =>
      GraphStore.openReadOnlyVerified(connection, key, writer.path),
    );
    if (first === undefined || second === undefined) throw new Error("Missing read handles");
    try {
      first.run("BEGIN");
      try {
        expect(first.runs.readRun("graph")?.runId).toBe("run");
        expect(() => second.run("BEGIN")).toThrow("within a transaction");
        expect(second.runs.readRun("graph")?.runId).toBe("run");
      } finally {
        first.run("ROLLBACK");
      }
      first.close();
      expect(second.runs.readRun("graph")?.runId).toBe("run");
    } finally {
      first.close();
      second.close();
      writer.close();
    }
  });

  it.each(["async", "sync"] as const)("shares uncommitted writes with a racing %s opener", async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "graph-connections-"));
    roots.push(root);
    GraphStore.openFile(root).close();
    const pending = GraphStore.openFileAsync(root);
    const second = mode === "async" ? await GraphStore.openFileAsync(root) : GraphStore.openFile(root);
    const first = await pending;
    try {
      const rollback = new Error("rollback probe");
      expect(() => first.transaction(() => {
        first.runs.mintRun({ graphId: "graph", runId: "run", planRevision: "plan", startedAt: 1 });
        expect(second.runs.readRun("graph")?.runId).toBe("run");
        throw rollback;
      })).toThrow(rollback);
      expect(first.runs.readRun("graph")).toBeUndefined();
      expect(second.runs.readRun("graph")).toBeUndefined();
      first.close();
      second.runs.mintRun({ graphId: "graph", runId: "later", planRevision: "plan", startedAt: 2 });
      expect(second.runs.readRun("graph")?.runId).toBe("later");
    } finally {
      first.close();
      second.close();
    }
  });
});
