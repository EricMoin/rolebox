import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutcomeHost } from "../../src/graph/host/outcome-host.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../../src/graph/tools/index.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/dispatch-effects.ts";
import type { CanonicalToolContext, CanonicalToolDef } from "../../src/platform/types.ts";
import { compileGraph } from "../../src/graph/compiler/compile.ts";
import { createPersistedCompiledPlan, declaredNodeTools } from "../../src/graph/compiler/plan.ts";
import { parseGraphDeclarationV3 } from "../../src/graph/compiler/parse-declaration-v3.ts";
import { inheritedWorkerTaskTools } from "../../src/graph/domain/worker-tools.ts";
import { removeTempTrees } from "./helpers/temp-dirs.ts";

const directories: string[] = [];
afterEach(() => removeTempTrees(directories));

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "worker-inheritance-"));
  directories.push(directory);
  const dispatched: OutcomeDispatchRequest[] = [];
  let inherited = ["docs_read", "docs_search"];
  let unavailable = false;
  let host: OutcomeHost;
  const open = () => OutcomeHost.open({
    workspaceDir: directory, storeRoot: join(directory, "store"), declareInvocationIdentity: false,
    validators: createValidatorRegistry([]), workerSessionOf: execution => execution.executionId,
    defaultWorkerToolPresentation: { mode: "discover" },
    workerTaskToolsOf: invocation => {
      expect(invocation.sessionId).toBe("parent");
      if (unavailable) throw new Error("Parent authorization unavailable");
      return inherited;
    },
    deliver: (request, effect) => {
      dispatched.push(request);
      host.confirmExecution(effect, { executionId: request.attemptId });
    },
  });
  host = open();
  const context = (sessionID: string): CanonicalToolContext => ({
    sessionID, messageID: "message", agent: "worker", directory, worktree: directory,
    abort: new AbortController().signal, metadata: () => {}, ask: async () => {},
  });
  const tools = host.bindTools(createOutcomeGraphTools(createGraphToolSet({ stateDir: directory,
    credentialIsolation: host.credentialIsolation, hostIdentity: host.workerIdentity,
    outcomeDispatch: host.dispatch, outcomeValidators: createValidatorRegistry([]), outcomeArtifactRoot: directory,
  })));
  await tools.graph_declare.execute({ declaration: { version: 3, name: "inheritance", nodes: [
    { id: "inherit", agent: "worker", prompt: "Inspect", outcomes: [{ id: "done" }] },
    { id: "narrow", agent: "worker", prompt: "Inspect", outcomes: [{ id: "done" }], tools: ["docs_read"] },
    { id: "empty", agent: "worker", prompt: "Inspect", outcomes: [{ id: "done" }], tools: [] },
    { id: "attempt-expand", agent: "worker", prompt: "Inspect", outcomes: [{ id: "done" }], tools: ["docs_*", "private_lookup", "rb_*", "dispatch"] },
  ], edges: [] } }, context("parent"));
  expect((await host.startDeclaredGraph("inheritance", { sessionId: "parent", agent: "parent-role" })).kind).toBe("started");
  const names = ["docs_read", "docs_search", "private_lookup", "graph_control", "rb_graph_control", "dispatch",
    "rb_dispatch", "dispatch_output", "loop_start", "team_create", "rb_team_create", "task", "task_retry", "session_fork"];
  const definitions: Record<string, CanonicalToolDef> = Object.fromEntries(names.map(name => [name, {
    description: name, args: {}, execute: async () => `${name} ran`,
  }]));
  const call = (node: string, name: string) => {
    const request = dispatched.find(request => request.nodeId === node)!;
    return host.bindTools(definitions)[name]!.execute({}, context(request.attemptId));
  };
  return { dispatched, call, names,
    revoke: () => { inherited = ["docs_read"]; },
    unavailable: () => { unavailable = true; },
    restart: () => { host.close(); host = open(); },
    close: () => host.close(),
  };
}

describe("inherited worker task tools", () => {
  it("inherits parent tools, narrows explicit lists and preserves an empty restriction after restart", async () => {
    const f = await fixture();
    try {
      expect(f.dispatched).toHaveLength(4);
      expect(f.dispatched.every(request => request.toolPresentation?.mode === "discover")).toBe(true);
      expect(f.dispatched.every(request => request.inheritedTools?.join(",") === "docs_read,docs_search")).toBe(true);
      for (let pass = 0; pass < 2; pass++) {
        expect(await f.call("inherit", "docs_search")).toBe("docs_search ran");
        expect(await f.call("narrow", "docs_read")).toBe("docs_read ran");
        expect(JSON.parse(String(await f.call("narrow", "docs_search")))).toMatchObject({ refused: true });
        expect(JSON.parse(String(await f.call("empty", "docs_read")))).toMatchObject({ refused: true });
        expect(JSON.parse(String(await f.call("attempt-expand", "private_lookup")))).toMatchObject({ refused: true });
        for (const name of f.names.slice(3)) {
          expect(JSON.parse(String(await f.call("attempt-expand", name)))).toMatchObject({ code: "worker-tool-forbidden" });
        }
        if (pass === 0) f.restart();
      }
    } finally { f.close(); }
  });

  it("rechecks parent authorization and refuses tools when its resolver fails", async () => {
    const f = await fixture();
    try {
      expect(await f.call("inherit", "docs_search")).toBe("docs_search ran");
      f.revoke();
      expect(JSON.parse(String(await f.call("inherit", "docs_search")))).toMatchObject({ refused: true });
      f.unavailable();
      expect(JSON.parse(String(await f.call("inherit", "docs_read")))).toMatchObject({ refused: true });
    } finally { f.close(); }
  });

  it("compiles and persists an empty restriction separately from inheritance", () => {
    const parsed = parseGraphDeclarationV3({ version: 3, name: "empty-tools", nodes: [
      { id: "worker", agent: "worker", prompt: "Inspect", tools: [], outcomes: [{ id: "done" }] },
    ], edges: [] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("Fixture declaration must parse");
    const compiled = compileGraph(parsed.declaration);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error("Fixture declaration must compile");
    expect(declaredNodeTools(createPersistedCompiledPlan(compiled.plan), "worker")).toEqual([]);
  });

  it("inherits exact role rules over prefix rules without inheriting dispatch capabilities", () => {
    expect(inheritedWorkerTaskTools(["docs_read", "docs_write", "browse_open", "rb_browse_open", "dispatch", "graph_control", "team_create"],
      { "docs_*": false, docs_read: true, "browse_*": false })).toEqual(["docs_read"]);
  });
});
