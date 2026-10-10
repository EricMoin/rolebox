/**
 * node-tool-grants — the v3 node field `tools?: string[]` (plan §3.3 / A21).
 *
 * THE CLAIM THIS FILE PROVES. A declared graph node may be granted HOST tools
 * beyond the two-tool worker baseline, declared in the v3 graph declaration; an
 * undeclared node keeps exactly today's restriction (default deny). The grant is
 * resolved from the HOST's own binding of the executing node and is added to the
 * baseline only for that node's worker, so a declarer or an unrelated session is
 * unaffected.
 *
 * WHAT IS COVERED, AND HOW:
 *   (a) the FRONT-END: `tools: ["computer_*"]` is accepted (trimmed, unique,
 *       sorted) and the closed grammar refuses an unknown key, a blank entry, a
 *       non-string entry, more than 32 entries, an empty array and a non-array;
 *   (b) the DEFAULT: a node that declares nothing is refused a computer tool,
 *       asserted THROUGH the shipped face (`OutcomeHost.bindTools`);
 *   (c) the GRANT: a node that declares `computer_*` may call a `computer_`
 *       tool while every other name stays refused; an exact declared name
 *       admits exactly that name;
 *   (d) the NON-WORKER: the declaring session and an unrelated session are
 *       unaffected by the boundary;
 *   (e) the PLAN: the compiled and PERSISTED plan carries the field for the
 *       nodes that declared it and carries nothing for the others.
 *
 * The behaviour cases drive the shipped assembly over a real store — the same
 * `createGraphToolSet` + `OutcomeHost` + `bindTools` the dsh and Pi entries
 * call — and the two synthetic host tools stand in for the computer-use tools
 * another module owns (they are FIXTURES here, never imports of that module).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileGraph } from "../../src/graph/compiler/compile.ts";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import {
  createPersistedCompiledPlan,
  declaredNodeTools,
} from "../../src/graph/compiler/plan.ts";
import {
  parseGraphDeclarationV3,
  type DeclarationV3ErrorCode,
} from "../../src/graph/compiler/parse-declaration-v3.ts";
import {
  OutcomeHost,
  WORKER_GRANTED_GRAPH_TOOLS,
  WORKER_TOOL_FORBIDDEN_CODE,
} from "../../src/graph/host/outcome-host.ts";
import {
  declaredToolAllows,
  declaredToolsAllow,
} from "../../src/graph/host/tool-binding.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/dispatch-effects.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { readStoredDefinition } from "../../src/graph/persistence/declared-record.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../../src/graph/tools/index.ts";
import {
  installDshGraphWorkerBoundary,
  type DshGraphWorkerRegistry,
} from "../../src/platform/adapters/dsh/graph-worker.ts";
import { resolveDshWorkerToolAllowList } from "../../src/platform/adapters/dsh/outcome-dispatch.ts";
import { prepareDshGraphWorkerPrompt } from "../../src/platform/adapters/dsh/worker-prompt.ts";
import { buildGraphWorkerToolGrantBlock } from "../../src/prompt/graph-worker.ts";
import type { CanonicalToolContext, CanonicalToolDef } from "../../src/platform/types.ts";
import type { ResolvedRole } from "../../src/types.ts";
import { removeTempTrees } from "./helpers/temp-dirs.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const EMPTY_VALIDATORS = createValidatorRegistry([]);

/** The synthetic HOST tools a declared node may be granted. */
const HOST_TOOLS = ["computer_screenshot", "computer_click", "browser_open"] as const;

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  removeTempTrees(tmpDirs);
});

/** A canonical tool context, as a platform hands one to a tool call. */
function makeContext(sessionID: string, agent: string, directory: string): CanonicalToolContext {
  return {
    sessionID,
    messageID: "m1",
    agent,
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

/** The child session the platform "created" for one attempt (the dsh mapping). */
function childSessionOf(attemptId: string): string {
  return "child-session:" + attemptId;
}

/** One synthetic host tool that says it ran. */
function hostTool(name: string): CanonicalToolDef {
  return {
    description: "Synthetic host tool " + name,
    args: {},
    async execute() {
      return name + " ran";
    },
  };
}

// ── (a) The front-end ───────────────────────────────────────────────────────

/** A one-or-more node declaration with `extra` merged into its first node. */
function declarationWith(extra: Record<string, unknown>, nodeCount = 1): unknown {
  const nodes: unknown[] = [];
  for (let index = 0; index < nodeCount; index++) {
    nodes.push({
      id: "alpha" + (index === 0 ? "" : String(index)),
      agent: "agent.alpha",
      prompt: "Do alpha.",
      outcomes: [{ id: "done" }],
      ...(index === 0 ? extra : {}),
    });
  }
  return { version: 3, name: "node-tool-grants.grammar", nodes, edges: [] };
}

describe("the v3 node `tools` grammar", () => {
  it("accepts a trailing-star prefix and normalizes the retained set", () => {
    const parsed = parseGraphDeclarationV3(
      declarationWith({ tools: [" computer_b ", "computer_a", "computer_a", "computer_*"] }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Trimmed, de-duplicated and sorted: the retained value IS the grant the
    // boundary matches on, so two spellings of one node compare equal.
    expect(parsed.declaration.nodes[0].tools).toEqual([
      "computer_*",
      "computer_a",
      "computer_b",
    ]);
  });

  it("keeps an absent field ABSENT, which is what the baseline default rests on", () => {
    const parsed = parseGraphDeclarationV3(declarationWith({}));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect("tools" in parsed.declaration.nodes[0]).toBe(false);
  });

  it("accepts exactly 32 entries and refuses 33", () => {
    const names = (count: number) => Array.from({ length: count }, (_, i) => "tool_" + i);
    expect(parseGraphDeclarationV3(declarationWith({ tools: names(32) })).ok).toBe(true);
    const tooMany = parseGraphDeclarationV3(declarationWith({ tools: names(33) }));
    expect(tooMany.ok).toBe(false);
    if (tooMany.ok) return;
    expect(tooMany.errors.map((entry) => entry.code)).toContain("invalid-value");
    expect(tooMany.errors[0].path).toBe("$.nodes[0].tools");
  });

  it("refuses an empty array, a blank entry, a non-string entry and a non-array", () => {
    const cases: Array<{ readonly extra: Record<string, unknown>; readonly code: DeclarationV3ErrorCode; readonly path: string }> = [
      { extra: { tools: [] }, code: "invalid-value", path: "$.nodes[0].tools" },
      { extra: { tools: ["   "] }, code: "invalid-value", path: "$.nodes[0].tools[0]" },
      { extra: { tools: ["computer_*", 7] }, code: "wrong-type", path: "$.nodes[0].tools[1]" },
      { extra: { tools: "computer_*" }, code: "wrong-type", path: "$.nodes[0].tools" },
    ];
    for (const entry of cases) {
      const parsed = parseGraphDeclarationV3(declarationWith(entry.extra));
      expect(parsed.ok, JSON.stringify(entry.extra)).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.errors.map((issue) => issue.code)).toContain(entry.code);
      expect(parsed.errors.map((issue) => issue.path)).toContain(entry.path);
    }
  });

  it("refuses an unknown node key instead of ignoring it (the grammar stays closed)", () => {
    const parsed = parseGraphDeclarationV3(declarationWith({ toools: ["computer_*"] }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.map((issue) => issue.code)).toContain("unknown-key");
    expect(parsed.errors.map((issue) => issue.path)).toContain("$.nodes[0].toools");
  });
});

// ── (e) The compiled and persisted plan ─────────────────────────────────────

describe("the compiled plan carries the declared grant", () => {
  const DECLARED: GraphDeclarationV3 = {
    version: 3,
    name: "node-tool-grants.plan",
    nodes: [
      {
        id: "alpha",
        agent: "agent.alpha",
        prompt: "Do alpha.",
        outcomes: [{ id: "done" }],
        tools: ["computer_*"],
      },
      { id: "beta", agent: "agent.beta", prompt: "Do beta.", outcomes: [{ id: "done" }] },
    ],
    edges: [],
  };

  it("preserves the field per node, and preserves ABSENCE for the others", () => {
    const compiled = compileGraph(DECLARED);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const alpha = compiled.plan.nodes.find((node) => node.id === "alpha");
    const beta = compiled.plan.nodes.find((node) => node.id === "beta");
    expect(alpha?.tools).toEqual(["computer_*"]);
    expect(beta !== undefined && "tools" in beta).toBe(false);
  });

  it("survives the persisted (JSON) round trip and the defensive plan reader", () => {
    const compiled = compileGraph(DECLARED);
    if (!compiled.ok) throw new Error("fixture: the declaration did not compile");
    const record = createPersistedCompiledPlan(compiled.plan);
    const reread: unknown = JSON.parse(JSON.stringify(record));
    expect(declaredNodeTools(reread, "alpha")).toEqual(["computer_*"]);
    expect(declaredNodeTools(reread, "beta")).toBeUndefined();
    expect(declaredNodeTools(reread, "missing")).toBeUndefined();
    expect(declaredNodeTools(null, "alpha")).toBeUndefined();
    expect(declaredNodeTools({ nodes: [{ id: "alpha", tools: [1] }] }, "alpha")).toBeUndefined();
  });
});

// ── The matcher itself ──────────────────────────────────────────────────────

describe("the declared-grant matcher", () => {
  it("admits an exact name or a trailing-star prefix, and nothing else", () => {
    expect(declaredToolAllows("computer_screenshot", "computer_screenshot")).toBe(true);
    expect(declaredToolAllows("computer_screenshot", "computer_click")).toBe(false);
    expect(declaredToolAllows("computer_*", "computer_click")).toBe(true);
    expect(declaredToolAllows("computer_*", "browser_open")).toBe(false);
    // A bare star has no stem to name, so it admits nothing rather than
    // granting the whole host tool surface.
    expect(declaredToolAllows("*", "computer_click")).toBe(false);
  });

  it("is fail-closed for an absent or empty grant", () => {
    expect(declaredToolsAllow("computer_click", undefined)).toBe(false);
    expect(declaredToolsAllow("computer_click", [])).toBe(false);
    expect(declaredToolsAllow("computer_click", ["computer_*"])).toBe(true);
  });
});

// ── The shipped face over a real store: (b), (c) and (d) ────────────────────

/**
 * Three entry nodes in one graph: `alpha` declares the prefix `computer_*`,
 * `beta` declares nothing (the baseline default), and `gamma` declares the
 * exact name `computer_screenshot`. One start dispatches all three, so one host
 * holds three bound workers — the population a widened grant could leak across.
 */
const GRANTS: GraphDeclarationV3 = {
  version: 3,
  name: "node-tool-grants.fan-out",
  nodes: [
    {
      id: "alpha",
      agent: "agent.alpha",
      prompt: "Do alpha.",
      outcomes: [{ id: "done" }],
      tools: ["computer_*"],
    },
    { id: "beta", agent: "agent.beta", prompt: "Do beta.", outcomes: [{ id: "done" }] },
    {
      id: "gamma",
      agent: "agent.gamma",
      prompt: "Do gamma.",
      outcomes: [{ id: "done" }],
      tools: ["computer_screenshot"],
    },
  ],
  edges: [],
};

interface GrantFixture {
  readonly dir: string;
  readonly storeRoot: string;
  readonly graphId: string;
  readonly host: OutcomeHost;
  readonly dispatched: readonly OutcomeDispatchRequest[];
  readonly tools: Record<string, CanonicalToolDef>;
  readonly call: (tool: string, sessionID: string, agent: string) => Promise<string>;
}

/**
 * One host over an EXISTING store root, with the shipped face bound to it and
 * the synthetic host tools in the face.
 *
 * Separate from {@link openGrantFixture} so a case can open a SECOND host over
 * the store a first host already declared and dispatched into: the durable half
 * of the worker binding and of the declared grant.
 */
function bindGrantHost(
  dir: string,
  storeRoot: string,
): {
  readonly host: OutcomeHost;
  readonly dispatched: OutcomeDispatchRequest[];
  readonly tools: Record<string, CanonicalToolDef>;
  readonly call: (tool: string, sessionID: string, agent: string) => Promise<string>;
} {
  const dispatched: OutcomeDispatchRequest[] = [];
  let host: OutcomeHost | undefined;
  const opened = OutcomeHost.open({
    workspaceDir: dir,
    storeRoot,
    deliver: (request, effect) => {
      dispatched.push(request);
      host?.confirmExecution(effect, { executionId: childSessionOf(request.attemptId) });
    },
    validators: EMPTY_VALIDATORS,
    declareInvocationIdentity: false,
    workerSessionOf: (execution) => execution.executionId,
  });
  host = opened;
  const toolset = createGraphToolSet({
    stateDir: dir,
    credentialIsolation: opened.credentialIsolation,
    hostIdentity: opened.workerIdentity,
    outcomeDispatch: opened.dispatch,
    outcomeValidators: EMPTY_VALIDATORS,
    outcomeArtifactRoot: dir,
  });
  const face: Record<string, CanonicalToolDef> = {
    ...createOutcomeGraphTools(toolset),
  };
  for (const name of HOST_TOOLS) face[name] = hostTool(name);
  const tools = opened.bindTools(face);
  return {
    host: opened,
    dispatched,
    tools,
    call: async (tool, sessionID, agent) => {
      const def = tools[tool];
      if (def === undefined) throw new Error("fixture: no tool " + tool);
      return String(await def.execute({}, makeContext(sessionID, agent, dir)));
    },
  };
}

/** The shipped host assembly over a REAL declared graph, plus host tools. */
async function openGrantFixture(): Promise<GrantFixture> {
  const dir = makeTmpDir("node-tool-grants-");
  const storeRoot = join(dir, "host-store");
  mkdirSync(storeRoot, { recursive: true });
  const bound = bindGrantHost(dir, storeRoot);
  const declarer = makeContext("session-declarer", "agent.declarer", dir);
  const declared = String(await bound.tools.graph_declare.execute({ declaration: GRANTS }, declarer));
  if (declared.includes("graph_declare failed:")) {
    throw new Error("fixture: graph_declare refused the declaration: " + declared);
  }
  const started = await bound.host.startDeclaredGraph(GRANTS.name, {
    sessionId: "session-declarer",
    agent: "agent.declarer",
  });
  if (started.kind !== "started") {
    throw new Error("fixture: the graph did not start (" + started.kind + ")");
  }
  return { dir, storeRoot, graphId: GRANTS.name, ...bound };
}

/** One parsed worker refusal, as the boundary renders it. */
interface WorkerToolRefusal {
  readonly refused?: boolean;
  readonly code?: string;
  readonly tool?: string;
  readonly granted_tools?: readonly string[];
}

describe("a dispatched worker's granted host tools", () => {
  it("(c) allows a declared prefix or exact name, and (b) refuses an undeclared node", async () => {
    const fixture = await openGrantFixture();
    try {
      expect(fixture.dispatched.map((request) => request.attemptId)).toEqual([
        "alpha#1",
        "beta#2",
        "gamma#3",
      ]);

      // (c) alpha declares `computer_*`: a computer_ tool runs…
      expect(await fixture.call("computer_screenshot", childSessionOf("alpha#1"), "agent.alpha"))
        .toBe("computer_screenshot ran");
      // …while a name outside the declared prefix is refused BY THE BOUNDARY,
      // and the refusal names the face it judged: the baseline plus alpha's own
      // declared grant.
      const refused = JSON.parse(
        await fixture.call("browser_open", childSessionOf("alpha#1"), "agent.alpha"),
      ) as WorkerToolRefusal;
      expect(refused.refused).toBe(true);
      expect(refused.code).toBe(WORKER_TOOL_FORBIDDEN_CODE);
      expect(refused.tool).toBe("browser_open");
      expect(refused.granted_tools).toEqual([...WORKER_GRANTED_GRAPH_TOOLS, "computer_*"]);

      // (b) beta declares NOTHING: the baseline default stands, and the refusal
      // carries exactly the baseline grant.
      const baseline = JSON.parse(
        await fixture.call("computer_screenshot", childSessionOf("beta#2"), "agent.beta"),
      ) as WorkerToolRefusal;
      expect(baseline.refused).toBe(true);
      expect(baseline.code).toBe(WORKER_TOOL_FORBIDDEN_CODE);
      expect(baseline.granted_tools).toEqual([...WORKER_GRANTED_GRAPH_TOOLS]);

      // gamma declares the EXACT name: it admits that name and no sibling.
      expect(await fixture.call("computer_screenshot", childSessionOf("gamma#3"), "agent.gamma"))
        .toBe("computer_screenshot ran");
      const sibling = JSON.parse(
        await fixture.call("computer_click", childSessionOf("gamma#3"), "agent.gamma"),
      ) as WorkerToolRefusal;
      expect(sibling.refused).toBe(true);
      expect(sibling.granted_tools).toEqual([
        ...WORKER_GRANTED_GRAPH_TOOLS,
        "computer_screenshot",
      ]);
    } finally {
      fixture.host.close();
    }
  });

  it("keeps the graph face unchanged for a node that declares host tools", async () => {
    const fixture = await openGrantFixture();
    try {
      // The declared names are HOST tools, never graph tools: alpha's extra
      // grant does not widen one graph entry.
      const refused = JSON.parse(
        await fixture.call("graph_status", childSessionOf("alpha#1"), "agent.alpha"),
      ) as WorkerToolRefusal;
      expect(refused.refused).toBe(true);
      expect(refused.code).toBe(WORKER_TOOL_FORBIDDEN_CODE);
      expect(await fixture.call("graph_submit_outcome", childSessionOf("alpha#1"), "agent.alpha"))
        .not.toContain(WORKER_TOOL_FORBIDDEN_CODE);
    } finally {
      fixture.host.close();
    }
  });

  it("(d) leaves the declaring session and an unrelated session unaffected", async () => {
    const fixture = await openGrantFixture();
    try {
      expect(await fixture.call("computer_screenshot", "session-declarer", "agent.declarer"))
        .toBe("computer_screenshot ran");
      expect(await fixture.call("browser_open", "session-declarer", "agent.declarer"))
        .toBe("browser_open ran");
      expect(await fixture.call("computer_click", "session-unrelated", "agent.unrelated"))
        .toBe("computer_click ran");
    } finally {
      fixture.host.close();
    }
  });

  it("(e) resolves the grant from the durable record in a FRESH host", async () => {
    const fixture = await openGrantFixture();
    const { dir, storeRoot } = fixture;
    fixture.host.close();
    // A host that never dispatched these attempts and holds no process cache:
    // it still binds alpha's worker from the durable execution row, and still
    // reads alpha's grant from the persisted definition.
    const second = bindGrantHost(dir, storeRoot);
    try {
      expect(await second.call("computer_screenshot", childSessionOf("alpha#1"), "agent.alpha"))
        .toBe("computer_screenshot ran");
      const refused = JSON.parse(
        await second.call("browser_open", childSessionOf("alpha#1"), "agent.alpha"),
      ) as WorkerToolRefusal;
      expect(refused.refused).toBe(true);
      const baseline = JSON.parse(
        await second.call("computer_screenshot", childSessionOf("beta#2"), "agent.beta"),
      ) as WorkerToolRefusal;
      expect(baseline.refused).toBe(true);
    } finally {
      second.host.close();
    }
  });

  it("(e) persists the grant in the graph's own definition", async () => {
    const fixture = await openGrantFixture();
    try {
      const reading = readStoredDefinition(fixture.storeRoot, fixture.graphId);
      expect(reading.kind).toBe("ok");
      if (reading.kind !== "ok") return;
      expect(declaredNodeTools(reading.declared.plan, "alpha")).toEqual(["computer_*"]);
      expect(declaredNodeTools(reading.declared.plan, "beta")).toBeUndefined();
      expect(declaredNodeTools(reading.declared.plan, "gamma")).toEqual(["computer_screenshot"]);
    } finally {
      fixture.host.close();
    }
  });
});

// ── The dsh execution guard ─────────────────────────────────────────────────

interface FakeWorkerAgent {
  readonly id: string;
  readonly session: { readonly id: string; readonly events: readonly unknown[] };
  readonly ctx: { readonly tools: { presentAs(mode: "native"): () => void } };
}

function fakeAgent(id: string): FakeWorkerAgent {
  return {
    id,
    session: { id, events: [] },
    ctx: { tools: { presentAs: () => () => {} } },
  };
}

const PRINCIPAL = {
  graphId: "node-tool-grants.guard",
  attemptId: "guard#1",
  executionId: "exec-1",
  workerSessionId: "worker-session",
};

function dshGuardBoundary(host: Record<string, unknown>): {
  readonly guard: (execution: { readonly name: string; readonly agent?: FakeWorkerAgent }) => string | undefined;
  readonly prepare: (agent: FakeWorkerAgent) => void;
  readonly dispose: () => void;
} {
  let guard: ((execution: { readonly name: string; readonly agent?: FakeWorkerAgent }) => string | undefined) | undefined;
  const registry: DshGraphWorkerRegistry = {
    guard: (callback) => {
      guard = callback as typeof guard;
      return () => {
        guard = undefined;
      };
    },
  };
  const boundary = installDshGraphWorkerBoundary(host as never, registry, () => undefined);
  return {
    guard: (execution) => guard!(execution),
    prepare: (agent) => boundary.prepare(agent as never),
    dispose: () => boundary.dispose(),
  };
}

describe("the dsh execution guard", () => {
  it("grants the baseline plus the executing node's declared tools", () => {
    const boundary = dshGuardBoundary({
      workerPrincipalOf: (sessionId: string) =>
        sessionId === PRINCIPAL.workerSessionId ? PRINCIPAL : undefined,
      workerDeclaredToolsOf: () => ["computer_*"],
    });
    const worker = fakeAgent(PRINCIPAL.workerSessionId);
    boundary.prepare(worker);
    try {
      expect(boundary.guard({ name: "graph_worker_exec", agent: worker })).toBeUndefined();
      expect(boundary.guard({ name: "graph_submit_outcome", agent: worker })).toBeUndefined();
      expect(boundary.guard({ name: "computer_screenshot", agent: worker })).toBeUndefined();
      expect(boundary.guard({ name: "browser_open", agent: worker })).toContain(
        "Graph workers may only",
      );
      // A session this host did NOT bind as a worker is unaffected.
      expect(boundary.guard({ name: "browser_open", agent: fakeAgent("session-unrelated") }))
        .toBeUndefined();
    } finally {
      boundary.dispose();
    }
  });

  it("never allows on uncertainty: missing, throwing and malformed lookups stay baseline", () => {
    const scenarios: Array<Record<string, unknown>> = [
      { workerPrincipalOf: (sessionId: string) => (sessionId === PRINCIPAL.workerSessionId ? PRINCIPAL : undefined) },
      {
        workerPrincipalOf: (sessionId: string) => (sessionId === PRINCIPAL.workerSessionId ? PRINCIPAL : undefined),
        workerDeclaredToolsOf: () => {
          throw new Error("the store could not be read");
        },
      },
      {
        workerPrincipalOf: (sessionId: string) => (sessionId === PRINCIPAL.workerSessionId ? PRINCIPAL : undefined),
        workerDeclaredToolsOf: () => "computer_*",
      },
    ];
    for (const host of scenarios) {
      const boundary = dshGuardBoundary(host);
      const worker = fakeAgent(PRINCIPAL.workerSessionId);
      boundary.prepare(worker);
      try {
        expect(boundary.guard({ name: "computer_screenshot", agent: worker })).toContain(
          "Graph workers may only",
        );
        expect(boundary.guard({ name: "graph_submit_outcome", agent: worker })).toBeUndefined();
      } finally {
        boundary.dispose();
      }
    }
  });
});

// ── The worker prompt ───────────────────────────────────────────────────────

const WORKER_ROLE: ResolvedRole = {
  id: "planner",
  config: { name: "Planner", description: "Plans", prompt: "You are the planner." },
  prompt: "Legacy rendered prompt",
  skills: [],
  references: [],
  functions: [],
  subagents: [],
};

describe("the worker prompt states the node's grant", () => {
  it("states the declared list when the node declares one", () => {
    const block = buildGraphWorkerToolGrantBlock(["computer_*"]);
    expect(block).toContain("computer_*");
    expect(block).toContain("graph_submit_outcome");
    expect(block).toContain("graph_worker_exec");
  });

  it("states the baseline restriction when the field is absent or empty", () => {
    for (const declared of [undefined, [] as string[]]) {
      const block = buildGraphWorkerToolGrantBlock(declared);
      expect(block).toContain("declares no extra host tools");
      expect(block).toContain("worker baseline");
      expect(block).not.toContain("computer_*");
    }
  });

  it("reaches the assembled dsh worker prompt for a declaring node", () => {
    const workspace = makeTmpDir("node-tool-grants-workspace-");
    const boundary = {
      kind: "confined",
      mode: "workspace-write",
      workspaceRoot: "/workspace/example",
    } as const;
    const declared = prepareDshGraphWorkerPrompt(
      [WORKER_ROLE],
      WORKER_ROLE.id,
      makeTmpDir("node-tool-grants-prompt-"),
      workspace,
      boundary,
      ["computer_*"],
    );
    expect(declared).toContain("this node declares the host tools computer_*");
    expect(declared).toContain(
      "Your tools are graph_worker_exec, graph_submit_outcome and the host tools this node declares.",
    );
    const baseline = prepareDshGraphWorkerPrompt(
      [WORKER_ROLE],
      WORKER_ROLE.id,
      makeTmpDir("node-tool-grants-prompt-"),
      workspace,
      boundary,
    );
    expect(baseline).toContain("this node declares no extra host tools");
    expect(baseline).toContain("Your tools are graph_worker_exec and graph_submit_outcome.");
  });
});

// ── A declared grant never re-opens the graph face ──────────────────────────
//
// ITEM 2 OF THE r3 REVIEW. The declared-grant matcher is consulted for EVERY
// name the boundary judges, and a bound worker's calls include the graph face
// itself. `tools: ["graph_*"]` therefore used to admit `graph_control` and
// `graph_declare` — the exact invariant the module states it holds
// (`tool-binding.ts` "THE GRAPH FACE ... STAYS STATIC"). These cases drive the
// SHIPPED face over a real store, so the refusal is the one a worker actually
// receives, not a matcher unit test.

/**
 * Three entry nodes whose grants name the graph face: `face` declares the whole
 * namespace with the wildcard, `status` names one graph tool exactly, and
 * `mixed` declares a graph grant AND a real host tool. The last one is what
 * proves the fix is a NARROWING and not a blanket refusal of declared grants.
 */
const GRAPH_FACE_GRANTS: GraphDeclarationV3 = {
  version: 3,
  name: "node-tool-grants.graph-face",
  nodes: [
    {
      id: "face",
      agent: "agent.face",
      prompt: "Do face.",
      outcomes: [{ id: "done" }],
      tools: ["graph_*"],
    },
    {
      id: "status",
      agent: "agent.status",
      prompt: "Do status.",
      outcomes: [{ id: "done" }],
      tools: ["graph_status"],
    },
    {
      id: "mixed",
      agent: "agent.mixed",
      prompt: "Do mixed.",
      outcomes: [{ id: "done" }],
      tools: ["computer_*", "graph_*"],
    },
  ],
  edges: [],
};

/** The shipped face + host tools over a real store holding GRAPH_FACE_GRANTS. */
async function openGraphFaceFixture(): Promise<GrantFixture> {
  const dir = makeTmpDir("node-tool-grants-face-");
  const storeRoot = join(dir, "host-store");
  mkdirSync(storeRoot, { recursive: true });
  const bound = bindGrantHost(dir, storeRoot);
  const declarer = makeContext("session-declarer", "agent.declarer", dir);
  const declared = String(
    await bound.tools.graph_declare.execute({ declaration: GRAPH_FACE_GRANTS }, declarer),
  );
  if (declared.includes("graph_declare failed:")) {
    throw new Error("fixture: graph_declare refused the declaration: " + declared);
  }
  const started = await bound.host.startDeclaredGraph(GRAPH_FACE_GRANTS.name, {
    sessionId: "session-declarer",
    agent: "agent.declarer",
  });
  if (started.kind !== "started") {
    throw new Error("fixture: the graph did not start (" + started.kind + ")");
  }
  return { dir, storeRoot, graphId: GRAPH_FACE_GRANTS.name, ...bound };
}

describe("a declared grant never re-opens the graph face", () => {
  it("refuses graph_status and graph_control to a worker of a node that declares them", async () => {
    const fixture = await openGraphFaceFixture();
    try {
      const attemptOf = (nodeId: string): string =>
        fixture.dispatched.find((request) => request.nodeId === nodeId)!.attemptId;
      // Every request carries ITS node's declared list (dispatch order is the
      // plan's, not this assertion's).
      expect(
        Object.fromEntries(
          fixture.dispatched.map((request) => [request.nodeId, request.declaredTools]),
        ),
      ).toEqual({
        face: ["graph_*"],
        status: ["graph_status"],
        mixed: ["computer_*", "graph_*"],
      });

      for (const nodeId of ["face", "status", "mixed"]) {
        for (const tool of ["graph_status", "graph_control", "graph_declare"]) {
          const refused = JSON.parse(
            await fixture.call(tool, childSessionOf(attemptOf(nodeId)), "agent." + nodeId),
          ) as WorkerToolRefusal;
          expect(refused.refused, `${nodeId} -> ${tool}`).toBe(true);
          expect(refused.code).toBe(WORKER_TOOL_FORBIDDEN_CODE);
          expect(refused.tool).toBe(tool);
        }
      }

      // The graph-facing entries are NOT reported as granted either: the
      // refusal names the face the worker actually holds, plus the declared
      // entries that can admit a host tool.
      const faceRefusal = JSON.parse(
        await fixture.call(
          "graph_status",
          childSessionOf(attemptOf("face")),
          "agent.face",
        ),
      ) as WorkerToolRefusal;
      expect(faceRefusal.granted_tools).toEqual([...WORKER_GRANTED_GRAPH_TOOLS]);
      const mixedRefusal = JSON.parse(
        await fixture.call(
          "graph_status",
          childSessionOf(attemptOf("mixed")),
          "agent.mixed",
        ),
      ) as WorkerToolRefusal;
      expect(mixedRefusal.granted_tools).toEqual([
        ...WORKER_GRANTED_GRAPH_TOOLS,
        "computer_*",
      ]);
    } finally {
      fixture.host.close();
    }
  });

  it("still allows the declared HOST tool of a node that also declares the graph face", async () => {
    const fixture = await openGraphFaceFixture();
    try {
      const attemptId = fixture.dispatched.find((request) => request.nodeId === "mixed")!.attemptId;
      expect(await fixture.call("computer_screenshot", childSessionOf(attemptId), "agent.mixed"))
        .toBe("computer_screenshot ran");
      // …and the name the node did NOT declare stays refused for that worker.
      const refused = JSON.parse(
        await fixture.call("browser_open", childSessionOf(attemptId), "agent.mixed"),
      ) as WorkerToolRefusal;
      expect(refused.refused).toBe(true);
      // The declaring session itself keeps the whole face: the rule only ever
      // applies to a session the host bound as a worker.
      expect(await fixture.call("graph_control", "session-declarer", "agent.declarer"))
        .not.toContain(WORKER_TOOL_FORBIDDEN_CODE);
    } finally {
      fixture.host.close();
    }
  });

  it("keeps the graph face out of the START allow-list too (the delivery half)", () => {
    // The same rule decides the start request's filter
    // (resolveDshWorkerToolAllowList consults the one matcher): a `graph_*`
    // declaration adds nothing there either, so the prompt, the filter and the
    // refusal cannot disagree.
    const allow = resolveDshWorkerToolAllowList({
      baseline: ["graph_submit_outcome"],
      declared: ["graph_*"],
      candidates: ["graph_status", "graph_control", "graph_declare", "graph_submit_outcome"],
      isRegistered: () => true,
    });
    expect(allow).toEqual(["graph_submit_outcome"]);
  });
});
