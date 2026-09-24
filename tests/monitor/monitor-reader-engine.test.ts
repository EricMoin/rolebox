import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphApplication } from "../../src/graph/application/graph-application.ts";
import { graphStoreRoot, graphStoreFilePath } from "../../src/graph/store/schema.ts";
import { readEngineGraphs } from "../../src/cli/commands/monitor/monitor-reader-engine.ts";
import { queryGraphs } from "../../src/graph/query/graph-query.ts";

let root: string;
let data: string;
let before: string | undefined;
let app: GraphApplication | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "monitor-v3-"));
  data = join(root, "data"); before = process.env.ROLEBOX_DATA_DIR; process.env.ROLEBOX_DATA_DIR = data;
});
afterEach(() => {
  app?.close(); app = undefined;
  if (before === undefined) delete process.env.ROLEBOX_DATA_DIR; else process.env.ROLEBOX_DATA_DIR = before;
  rmSync(root, { recursive: true, force: true });
});
const stateDir = () => join(root, ".rolebox", "state");
function open() {
  app = GraphApplication.open({ workspaceDir: root, storeRoot: graphStoreRoot(data, root), env: {}, deliver() {} });
  return app;
}
const declaration = (name: string) => ({ version: 3, name, nodes: [{ id: "work", agent: "worker", prompt: "Work", outcomes: [{ id: "done" }] }], edges: [] });

describe("native graph monitor", () => {
  it("does not initialize a missing store or decode retired workspace JSON", () => {
    expect(readEngineGraphs(stateDir())).toEqual([]);
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(join(stateDir(), "engine-old.json"), '{"version":2,"graphId":"old","phase":"executing"}');
    expect(readEngineGraphs(stateDir())).toEqual([]);
  });
  it("uses the shipped user-level store and shares complete native records with tools and audit", async () => {
    const application = open();
    await application.tools.graph_declare_and_start({ declaration: declaration("visible") }, "parent");
    const snapshots = readEngineGraphs(stateDir());
    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0]!;
    const graph = queryGraphs(graphStoreRoot(data, root)).graphs[0]!;
    expect(snapshot.graph).toEqual(graph);
    expect(snapshot.phase).toBe("executing");
    expect(snapshot.nodes[0]?.status).toBe("running");
    expect(snapshot.budget.sessionsSpawned).toBe(1);
    expect(snapshot.updatedAt).toBe(new Date(snapshot.updatedAtMs).toISOString());
    expect((await application.tools.graph_audit()).entries[0]?.graph).toEqual(graph);
  });
  it("reports a stop alongside still-dispatched attempts, rather than showing an executing run", async () => {
    const application = open();
    await application.tools.graph_declare_and_start({ declaration: declaration("stopped") }, "parent");
    expect(application.tools.graph_control({ graph_id: "stopped", command: "failure", node_id: "work", reason: "worker failed" }, "parent").kind).toBe("applied");
    const snapshot = readEngineGraphs(stateDir())[0]!;
    expect(snapshot.phase).toBe("stopped");
    expect(snapshot.nodes[0]?.errorReason).toBe("worker failed");
    expect(snapshot.graph?.current?.control?.command).toBe("failure");
  });
  it("reports unreadable authoritative storage rather than an empty healthy monitor", () => {
    const directory = graphStoreRoot(data, root);
    mkdirSync(directory, { recursive: true });
    writeFileSync(graphStoreFilePath(directory), "");
    expect(() => readEngineGraphs(stateDir())).toThrow("corrupt");
  });
  it("keeps multiple declarations and unstarted plans visible", () => {
    const application = open();
    application.tools.graph_declare({ declaration: declaration("one") });
    application.tools.graph_declare({ declaration: declaration("two") });
    const snapshots = readEngineGraphs(stateDir());
    expect(snapshots.map((item) => item.graphId).sort()).toEqual(["one", "two"]);
    expect(snapshots.every((item) => item.phase === "idle" && item.graph?.phase === "ready")).toBe(true);
    expect(snapshots.every((item) => item.nodes[0]?.dispatchTaskId === undefined)).toBe(true);
  });
});
