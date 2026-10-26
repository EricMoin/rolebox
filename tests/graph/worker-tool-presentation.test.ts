import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileGraph } from "../../src/graph/compiler/compile.ts";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { parseGraphDeclarationV3 } from "../../src/graph/compiler/parse-declaration-v3.ts";
import { createPersistedCompiledPlan, declaredNodeToolPresentation } from "../../src/graph/compiler/plan.ts";
import { OutcomeHost } from "../../src/graph/host/outcome-host.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/dispatch-effects.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../../src/graph/tools/index.ts";
import type { CanonicalToolContext, CanonicalToolDef } from "../../src/platform/types.ts";
import { removeTempTrees } from "./helpers/temp-dirs.ts";

const directories: string[] = [];
afterEach(() => removeTempTrees(directories));

function declaration(extra: Record<string, unknown> = {}): unknown {
  return { version: 3, name: "worker-presentation", nodes: [{
    id: "worker", agent: "worker", prompt: "Inspect documents.", outcomes: [{ id: "done" }],
    tools: ["docs_*"], ...extra,
  }], edges: [] };
}

describe("worker tool presentation declaration", () => {
  it("allows preloading inherited task tools and rejects orchestration entries", () => {
    expect(parseGraphDeclarationV3(declaration({ tools: undefined,
      toolPresentation: { mode: "discover", preload: ["docs_read"] } })).ok).toBe(true);
    for (const name of ["graph_control", "rb_graph_control", "dispatch", "rb_dispatch", "task", "team_create"]) {
      expect(parseGraphDeclarationV3(declaration({ tools: undefined,
        toolPresentation: { mode: "discover", preload: [name] } })).ok).toBe(false);
    }
  });

  it("normalizes and persists presentation without changing the tool grant", () => {
    const parsed = parseGraphDeclarationV3(declaration({ toolPresentation: { mode: "discover", preload: [" docs_read ", "docs_read"] } }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const compiled = compileGraph(parsed.declaration);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const persisted: unknown = JSON.parse(JSON.stringify(createPersistedCompiledPlan(compiled.plan)));
    expect(declaredNodeToolPresentation(persisted, "worker")).toEqual({ mode: "discover", preload: ["docs_read"] });
    expect(compiled.plan.nodes[0].tools).toEqual(["docs_*"]);
    expect(declaredNodeToolPresentation(persisted, "missing")).toBeUndefined();
  });

  it("preserves absence and includes a presentation change in the plan revision", () => {
    const native = compileGraph(declaration() as GraphDeclarationV3);
    const code = compileGraph(declaration({ toolPresentation: { mode: "code" } }) as GraphDeclarationV3);
    if (!native.ok || !code.ok) throw new Error("Fixture must compile");
    expect("toolPresentation" in native.plan.nodes[0]).toBe(false);
    expect(native.plan.planRevision).not.toBe(code.plan.planRevision);
  });

  it.each([
    null, "code", {}, { mode: "automatic" }, { mode: "native", grant: ["other"] },
    { mode: "discover", preload: "docs_read" }, { mode: "discover", preload: ["docs_*"] },
    { mode: "code", preload: ["graph_status"] }, { mode: "code", preload: ["billing_read"] },
    { mode: "discover", preload: [7] },
  ])("refuses invalid configuration %j in both authoring and direct compilation", toolPresentation => {
    expect(parseGraphDeclarationV3(declaration({ toolPresentation })).ok).toBe(false);
    expect(compileGraph(declaration({ toolPresentation }) as GraphDeclarationV3).ok).toBe(false);
  });

  it("fails closed when reading malformed stored presentation", () => {
    expect(declaredNodeToolPresentation({ nodes: [{ id: "worker", toolPresentation: { mode: "unknown" } }] }, "worker")).toBeUndefined();
    expect(declaredNodeToolPresentation({ nodes: [{ id: "worker", tools: [], toolPresentation: { mode: "code", preload: ["docs_read"] } }] }, "worker")).toBeUndefined();
  });
});

it("carries mode through dispatch and restart, granting only its capability entry points", async () => {
  const directory = mkdtempSync(join(tmpdir(), "worker-presentation-"));
  directories.push(directory);
  const storeRoot = join(directory, "store");
  mkdirSync(storeRoot);
  const dispatched: OutcomeDispatchRequest[] = [];
  const validators = createValidatorRegistry([]);
  let host: OutcomeHost;
  const open = () => OutcomeHost.open({
    workspaceDir: directory, storeRoot, validators, declareInvocationIdentity: false,
    workerSessionOf: execution => execution.executionId,
    deliver: (request, effect) => {
      dispatched.push(request);
      host.confirmExecution(effect, { executionId: `child:${request.attemptId}` });
    },
  });
  const context = (sessionID: string): CanonicalToolContext => ({
    sessionID, messageID: "message", agent: "worker", directory, worktree: directory,
    abort: new AbortController().signal, metadata: () => {}, ask: async () => {},
  });
  host = open();
  try {
    const toolset = createGraphToolSet({ stateDir: directory, credentialIsolation: host.credentialIsolation,
      hostIdentity: host.workerIdentity, outcomeDispatch: host.dispatch, outcomeValidators: validators, outcomeArtifactRoot: directory });
    const tools = host.bindTools(createOutcomeGraphTools(toolset));
    const graph = declaration() as GraphDeclarationV3;
    graph.nodes = [undefined, "native", "discover", "code"].map((mode, i) => ({
      ...graph.nodes[0], id: `worker${i}`, tools: ["docs_*", "graph_*"],
      ...(mode === undefined ? {} : { toolPresentation: { mode: mode as "native" | "discover" | "code" } }),
    }));
    await tools.graph_declare.execute({ declaration: graph }, context("parent"));
    const started = await host.startDeclaredGraph(graph.name, { sessionId: "parent", agent: "parent" });
    expect(started.kind).toBe("started");
    expect(dispatched).toHaveLength(4);
    expect(dispatched.map(request => request.toolPresentation?.mode)).toEqual([undefined, "native", "discover", "code"]);
    host.close();
    host = open();
    const entries: Record<string, CanonicalToolDef> = Object.fromEntries(
      ["graph_worker_tools", "graph_worker_code", "graph_status", "docs_read", "billing_read"].map(name => [name, {
        description: name, args: {}, execute: async () => "ran",
      }]),
    );
    const bound = host.bindTools(entries);
    for (const request of dispatched) {
      const child = context(`child:${request.attemptId}`);
      const principal = host.workerPrincipalOf(child.sessionID)!;
      expect(host.workerToolPresentationOf(principal)).toEqual(request.toolPresentation);
      const allowed = new Set(["docs_read", ...(request.toolPresentation?.mode === "discover" ? ["graph_worker_tools"] :
        request.toolPresentation?.mode === "code" ? ["graph_worker_tools", "graph_worker_code"] : [])]);
      for (const [name, tool] of Object.entries(bound)) {
        const result = String(await tool.execute({}, child));
        if (allowed.has(name)) expect(result).toBe("ran");
        else {
          const refusal = JSON.parse(result);
          expect(refusal.code).toBe("worker-tool-forbidden");
          if (request.toolPresentation?.mode === "code") expect(refusal.granted_tools).toContain("graph_worker_code");
          if (request.toolPresentation?.mode === "discover") expect(refusal.granted_tools).toContain("graph_worker_tools");
        }
      }
    }
  } finally { host.close(); }
});
