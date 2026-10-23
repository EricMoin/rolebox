import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphApplication } from "../../src/graph/application/graph-application.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { buildDeclaredOutcomeGraph } from "../../src/graph/tools/declare-graph.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../../src/graph/tools/index.ts";
import { graphStoreFilePath } from "../../src/graph/store/schema.ts";
import { makeToolContext } from "../asset/helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function declaration(name: string, agent: string) {
  return { version: 3, name, nodes: [{ id: "work", agent, prompt: `Private workflow for ${agent}`, outcomes: [{ id: "done" }] }], edges: [] };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "graph-session-visibility-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const storeRoot = join(root, "store");
  const open = () => GraphApplication.open({ workspaceDir: root, storeRoot, env: {}, declareInvocationIdentity: false, deliver() {} });
  let app = open();
  let tools = app.createTools();
  cleanups.push(() => app.close());
  const call = (name: string, args: Record<string, unknown>, sessionID = "engineer-session") => tools[name]!.execute(args,
    makeToolContext({ sessionID, agent: sessionID, directory: root, worktree: root }));
  return {
    root, storeRoot, call,
    async populate() {
      await call("graph_declare", { declaration: declaration("engineer-graph", "engineer--worker") });
      await call("graph_declare", { declaration: declaration("designer-graph", "designer--private") }, "designer-session");
      app.tools.graph_declare({ declaration: declaration("unattributed-graph", "unattributed--private") });
    },
    reopen() { app.close(); app = open(); tools = app.createTools(); },
  };
}

describe("graph observation session ownership", () => {
  it("filters every status scope, history, grouping, exports, and audit totals before rendering", async () => {
    const f = fixture();
    await f.populate();
    for (const scope of [undefined, "session", "persisted", "all"]) {
      const output = String(await f.call("graph_status", { scope, format: "json", include_history: true, include_output: true }));
      expect(output).toContain("engineer--worker");
      expect(output).not.toContain("designer-graph");
      expect(output).not.toContain("designer--private");
      expect(output).not.toContain("unattributed");
      expect(JSON.parse(output).graphs).toHaveLength(1);
    }
    const designer = String(await f.call("graph_status", { scope: "all", format: "json" }, "designer-session"));
    expect(designer).toContain("designer--private");
    expect(designer).not.toContain("engineer--worker");
    const grouped = String(await f.call("graph_status", { scope: "all", group_by: "agent" }));
    expect(grouped).not.toContain("designer");
    const exportPath = join(f.root, "visible.json");
    await f.call("graph_status", { scope: "all", format: "json", export_path: exportPath });
    expect(readFileSync(exportPath, "utf8")).not.toContain("designer");
    const audit = JSON.parse(String(await f.call("graph_audit", {})));
    expect(audit.totals.graphs).toBe(1);
    expect(audit.entries.map((entry: { graphId: string }) => entry.graphId)).toEqual(["engineer-graph"]);
    expect(JSON.stringify(audit)).not.toContain("designer--private");
    expect(JSON.stringify(audit)).not.toContain("unattributed");
  });

  it("restores the same session's default view and preserves empty-session administrative inventory", async () => {
    const f = fixture();
    await f.populate();
    f.reopen();
    const owned = JSON.parse(String(await f.call("graph_status", { graph_id: "engineer-graph", format: "json" })));
    expect(owned.graph_id).toBe("engineer-graph");
    expect(owned.nodes[0].agent).toBe("engineer--worker");
    expect(JSON.parse(String(await f.call("graph_audit", {}))).totals.graphs).toBe(1);
    const fresh = JSON.parse(String(await f.call("graph_status", { scope: "all", format: "json" }, "new-session")));
    expect(fresh.graphs).toEqual([]);
    expect(fresh.refused).toEqual([]);
    const admin = JSON.parse(String(await f.call("graph_status", { scope: "all", format: "json" }, "")));
    expect(admin.graphs).toHaveLength(3);
    expect(JSON.parse(String(await f.call("graph_audit", {}, ""))).totals.graphs).toBe(3);
  });

  it("does not disclose foreign IDs through targeted errors, unreadable definitions, or retired metadata", async () => {
    const f = fixture();
    await f.populate();
    const malformed = buildDeclaredOutcomeGraph({ declaration: declaration("foreign-secret-definition", "designer--secret-child") });
    const store = GraphStore.openFile(f.storeRoot);
    try {
      store.writeDefinition({ graphId: "foreign-secret-row", declarationDigest: malformed.declarationDigest,
        planRevision: malformed.plan.planRevision, declaration: malformed.declaration, plan: malformed.record, recordedAt: 1 });
      store.recordInvocationOrigin("foreign-secret-row", { sessionId: "designer-session" }, 1);
    } finally { store.close(); }
    const retiredDirectory = join(f.root, ".rolebox", "state");
    mkdirSync(retiredDirectory, { recursive: true });
    writeFileSync(join(retiredDirectory, "engine-designer--retired.json"), "{}");
    for (const target of ["designer-graph", "foreign-secret-row", "missing-graph"]) {
      const output = String(await f.call("graph_status", { graph_id: target, scope: "all", format: "json" }));
      expect(output).toContain("Unknown graph");
      expect(output).not.toContain("designer");
      expect(output).not.toContain("foreign-secret");
    }
    const status = String(await f.call("graph_status", { scope: "all", format: "json" }));
    expect(status).not.toContain("foreign-secret");
    expect(JSON.parse(status).refused).toEqual([]);
    const audit = String(await f.call("graph_audit", {}));
    expect(audit).not.toContain("designer");
    expect(audit).not.toContain("foreign-secret");
    expect(JSON.parse(audit).totals.graphs).toBe(1);
    const admin = String(await f.call("graph_audit", {}, ""));
    expect(admin).toContain("foreign-secret-row");
    expect(admin).toContain("engine-designer--retired.json");
    expect(JSON.parse(admin).totals.graphs).toBe(4);
  });

  it("reports unreadable stores without exposing unowned diagnostic content", async () => {
    const root = mkdtempSync(join(tmpdir(), "graph-query-corrupt-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const storeRoot = join(root, ".rolebox", "state");
    mkdirSync(storeRoot, { recursive: true });
    writeFileSync(graphStoreFilePath(storeRoot), "foreign--secret-child");
    const tools = createOutcomeGraphTools(createGraphToolSet({ stateDir: root }));
    const context = makeToolContext({ sessionID: "engineer-session" });
    const status = String(await tools.graph_status.execute({ scope: "all" }, context));
    expect(status).toContain("Graph store unavailable for this session");
    expect(status).not.toContain("foreign--secret-child");
    const audit = JSON.parse(String(await tools.graph_audit.execute({}, context)));
    expect(audit.verdict).toBe("blocked");
    expect(audit.blockers[0].detail).toBe("Graph store unavailable for this session");
    expect(JSON.stringify(audit)).not.toContain("foreign--secret-child");
  });
});
