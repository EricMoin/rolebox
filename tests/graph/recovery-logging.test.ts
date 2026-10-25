import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyGraphControl } from "../../src/graph/control/application.ts";
import { OutcomeHost, type OutcomeHostOptions } from "../../src/graph/host/outcome-host.ts";
import type { OutcomeDispatchRequest, OutcomeExecutionProbe } from "../../src/graph/outcome/dispatch-effects.ts";
import { dispatchEffectKeyOf, dispatchIdempotencyKeyOf } from "../../src/graph/outcome/dispatch-effects.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { GRAPH_STORE_TABLES } from "../../src/graph/store/schema.ts";
import { buildDeclaredOutcomeGraph, persistDeclaredGraph } from "../../src/graph/tools/declare-graph.ts";
import { __resetLoggingForTest, configureLogging } from "../../src/log/index.ts";
import { createMemorySink, type MemorySink } from "../../src/log/sinks/memory.ts";
import { DshOutcomeDelivery } from "../../src/platform/adapters/dsh/outcome-dispatch.ts";
import type { DshSessionEventLike } from "../../src/platform/adapters/dsh/session.ts";
import { beginLogTest, endLogTest } from "../helpers/log.ts";
import { AUTHORIZED, EMPTY_VALIDATORS, GRAPH_ID, naturalDeclaration, plainDeclaration } from "./helpers/host-graph-fixture.ts";
import { removeTempTrees } from "./helpers/temp-dirs.ts";

const roots: string[] = [];
const hosts: OutcomeHost[] = [];
const deliveries: OutcomeDispatchRequest[] = [];
let logState: { env: Record<string, string | undefined>; dir: string };
let memory: MemorySink;

function resetCapture(): void {
  __resetLoggingForTest();
  memory = createMemorySink();
  configureLogging({ level: "debug", sinks: [memory] });
}

beforeEach(() => {
  logState = beginLogTest();
  resetCapture();
  deliveries.splice(0);
});

afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
  endLogTest(logState);
  removeTempTrees(roots);
});

type Ports = Pick<OutcomeHostOptions, "query" | "observeExecution" | "derivedOutcomeOf" | "cancelExecution">;

function open(root: string, ports: Ports = {}, confirm = true): OutcomeHost {
  let host: OutcomeHost;
  host = OutcomeHost.open({
    workspaceDir: root, storeRoot: root, declareInvocationIdentity: false,
    validators: EMPTY_VALIDATORS, completionPolicies: AUTHORIZED,
    observeExecution: () => ({ kind: "running" }),
    ...ports,
    deliver: (request, effect) => {
      deliveries.push(request);
      if (confirm) host.confirmExecution(effect, { executionId: "worker:" + request.attemptId });
    },
  });
  hosts.push(host);
  return host;
}

function fixture(natural = true): string {
  const root = mkdtempSync(join(tmpdir(), "recovery-logging-"));
  roots.push(root);
  const declaration = natural ? naturalDeclaration() : { ...plainDeclaration(), name: GRAPH_ID };
  declaration.nodes = declaration.nodes.slice(0, 1);
  declaration.edges = [];
  persistDeclaredGraph(buildDeclaredOutcomeGraph({ declaration, completionPolicies: AUTHORIZED }), root);
  return root;
}

async function start(host: OutcomeHost, parent = "parent"): Promise<void> {
  expect((await host.startDeclaredGraph(GRAPH_ID, { sessionId: parent, agent: "declarer" })).kind).toBe("started");
}

function control(root: string, command: "cancel" | "retry"): void {
  const store = GraphStore.openFile(root);
  try {
    const request = { graphId: GRAPH_ID, principal: { sessionId: "parent" }, reason: "operator decision", at: Date.now() };
    const result = command === "cancel"
      ? applyGraphControl(store, { ...request, command: "cancel" })
      : applyGraphControl(store, { ...request, command: "retry" });
    expect(result.kind).toBe("applied");
  } finally { store.close(); }
}

function aggregate() {
  const records = memory.records().filter(record => record.code === "sweep.summary" || record.code === "sweep.attention");
  expect(records).toHaveLength(1);
  const record = records[0];
  if (record === undefined) throw new Error("recovery did not log its aggregate report");
  return record;
}

it("lets I/O callbacks run between graphs in a recovery sweep", async () => {
  const root = fixture();
  for (let i = 0; i < 12; i++) {
    const declaration = { ...plainDeclaration(), name: "history-" + i.toString().padStart(2, "0") };
    declaration.nodes = declaration.nodes.slice(0, 1);
    declaration.edges = [];
    persistDeclaredGraph(buildDeclaredOutcomeGraph({ declaration, completionPolicies: AUTHORIZED }), root);
  }
  const host = open(root);
  const startGraph = host.startDeclaredGraph.bind(host);
  let visits = 0;
  let callbacks = 0;
  const starts = vi.spyOn(host, "startDeclaredGraph").mockImplementation((...args) => {
    expect(callbacks).toBe(visits);
    visits++;
    setImmediate(() => { callbacks++; });
    return startGraph(...args);
  });
  try {
    const report = await host.recoverDeclaredGraphs();
    expect(report.started).toHaveLength(13);
    expect(visits).toBe(13);
    expect(callbacks).toBeGreaterThanOrEqual(12);
  } finally { starts.mockRestore(); }
});

it("logs normal startup and a running execution once at info", async () => {
  const root = fixture();
  const report = await open(root).recoverDeclaredGraphs();
  expect(report.started).toHaveLength(1);
  expect(report.awaitingCompletion.map(entry => entry.status)).toEqual(["running"]);
  expect(report.effectRefusals).toEqual([]);
  expect(aggregate()).toMatchObject({ code: "sweep.summary", level: "info", fields: {
    started: report.started, awaiting: [GRAPH_ID + ":work#1:running"],
  } });
});

it("logs completed recovery and an already complete graph at info", async () => {
  const root = fixture();
  const host = open(root, { observeExecution: () => ({ kind: "completed" }) });
  const report = await host.recoverDeclaredGraphs();
  expect(report.completed).toEqual([GRAPH_ID + ":work#1:accepted"]);
  expect(aggregate()).toMatchObject({ code: "sweep.summary", level: "info" });
  host.close();
  resetCapture();
  const resumed = await open(root).recoverDeclaredGraphs();
  expect(resumed.resumed).toEqual([GRAPH_ID + ":complete"]);
  expect(aggregate()).toMatchObject({ code: "sweep.summary", level: "info" });
});

it("warns for a persisted declaration-driven stop with no in-flight work or refusals", async () => {
  const root = mkdtempSync(join(tmpdir(), "recovery-stopped-"));
  roots.push(root);
  persistDeclaredGraph(buildDeclaredOutcomeGraph({ declaration: {
    version: 3, name: GRAPH_ID,
    nodes: [
      { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }, { id: "abandoned" }] },
      { id: "ship", agent: "agent.ship", prompt: "Ship the result.", outcomes: [{ id: "delivered" }] },
    ],
    edges: [{ from: "work", to: "ship", outcome: "done" }],
  } }), root);
  const host = open(root, { derivedOutcomeOf: () => ({ kind: "declared", outcomeId: "abandoned",
    derivation: { eventIndex: 1, turnIndex: 1 } }) });
  await start(host);
  expect((await host.settleFinishedAttempt(GRAPH_ID, "work#1")).kind).toBe("settled");
  host.close();
  resetCapture();
  const report = await open(root).recoverDeclaredGraphs();
  expect(report.resumed).toEqual([GRAPH_ID + ":stopped"]);
  expect(report.awaitingCompletion).toEqual([]);
  expect(report.effectRefusals).toEqual([]);
  expect(report.controlled).toEqual([]);
  expect(report.stopped).toEqual([GRAPH_ID + ":unreachable-pending-node"]);
  expect(aggregate()).toMatchObject({ code: "sweep.attention", level: "warn", fields: { stopped: report.stopped } });
});

it("logs an explicit stop and a confirmed cancellation at info without priming the stopped run", async () => {
  const root = fixture();
  const probes: OutcomeExecutionProbe[] = [];
  const host = open(root, { query: { lookup: () => ({ kind: "unknown", reason: "not listed" }),
    prime: async entries => { probes.push(...entries); } },
    cancelExecution: { cancel: async () => ({ kind: "confirmed", reason: "worker stopped" }) },
  });
  await start(host);
  control(root, "cancel");
  const report = await host.recoverDeclaredGraphs();
  expect(report.controlled).toEqual([GRAPH_ID + ":cancel"]);
  expect(report.stopped).toEqual([]);
  expect(report.effectRefusals.map(entry => entry.code)).toEqual(["control-stopped"]);
  expect(report.cancellations.map(entry => entry.state)).toEqual(["confirmed"]);
  expect(probes).toEqual([]);
  expect(aggregate()).toMatchObject({ code: "sweep.summary", level: "info" });
});

for (const state of ["requested", "unsupported"] as const) {
  it("warns when a stopped run's cancellation is " + state, async () => {
    const root = fixture();
    const host = open(root, { cancelExecution: { cancel: async () => ({ kind: state, reason: "unconfirmed cancellation" }) } });
    await start(host);
    control(root, "cancel");
    const report = await host.recoverDeclaredGraphs();
    expect(report.cancellations.map(entry => entry.state)).toEqual([state]);
    expect(aggregate()).toMatchObject({ code: "sweep.attention", level: "warn", fields: {
      cancellations: [GRAPH_ID + ":work#1:" + state],
    } });
  });
}

it("warns for an unconfirmed stopped execution while skipping platform priming", async () => {
  const root = fixture();
  const probes: OutcomeExecutionProbe[] = [];
  const host = open(root, { query: { lookup: () => ({ kind: "unknown", reason: "not listed" }),
    prime: async entries => { probes.push(...entries); } } }, false);
  await start(host);
  control(root, "cancel");
  const report = await host.recoverDeclaredGraphs();
  expect(report.unconfirmedExecutions.map(entry => entry.state)).toEqual(["creating"]);
  expect(probes).toEqual([]);
  expect(aggregate()).toMatchObject({ code: "sweep.attention", level: "warn", fields: {
    unconfirmed: [GRAPH_ID + ":work#1:creating"],
  } });
});

it("keeps repeated unknown execution warnings visible without throttling", async () => {
  const root = fixture();
  const host = open(root, { observeExecution: () => ({ kind: "unknown", reason: "execution unavailable" }) });
  const first = await host.recoverDeclaredGraphs();
  expect(first.awaitingCompletion.map(entry => entry.status)).toEqual(["unknown"]);
  expect(first.effectRefusals.map(entry => entry.code)).toContain("completion-unsettled");
  expect(aggregate()).toMatchObject({ code: "sweep.attention", level: "warn" });
  await host.recoverDeclaredGraphs();
  expect(memory.records().filter(record => record.code === "sweep.attention")).toHaveLength(2);
});

it("warns for a failed attempt without labelling the whole run as controlled", async () => {
  const root = fixture();
  const host = open(root, { observeExecution: () => ({ kind: "failed", reason: "execution failed" }) });
  await start(host);
  const report = await host.recoverDeclaredGraphs();
  expect(report.failedAttempts).toEqual([GRAPH_ID + ":work:work#1:failure"]);
  expect(report.controlled).toEqual([]);
  expect(aggregate()).toMatchObject({ code: "sweep.attention", level: "warn", fields: { failedAttempts: report.failedAttempts } });
});

it("warns when a stored graph is refused", async () => {
  const root = fixture();
  const store = GraphStore.openFile(root);
  try { store.run(`UPDATE ${GRAPH_STORE_TABLES.definitions} SET plan = '{}' WHERE graph_id = ?`, GRAPH_ID); }
  finally { store.close(); }
  const report = await open(root).recoverDeclaredGraphs();
  expect(report.refused).toHaveLength(1);
  expect(aggregate()).toMatchObject({ code: "sweep.attention", level: "warn", fields: { refused: report.refused } });
});

it("honours an owed reexecution without priming old effects and launches the new run", async () => {
  const root = fixture();
  const probes: OutcomeExecutionProbe[] = [];
  const host = open(root, { query: { lookup: () => ({ kind: "unknown", reason: "not listed" }),
    prime: async entries => { probes.push(...entries); } },
    cancelExecution: { cancel: async () => ({ kind: "confirmed", reason: "worker stopped" }) },
  });
  await start(host);
  control(root, "cancel");
  await host.deliverCancelIntents(GRAPH_ID);
  control(root, "retry");
  const report = await host.recoverDeclaredGraphs();
  expect(report.reexecuted).toHaveLength(1);
  expect(deliveries.map(request => request.attemptId)).toEqual(["work#1", "work#2"]);
  expect(probes).toEqual([]);
});

function terminalEvents(label: string, outcomeId = "done"): readonly DshSessionEventLike[] {
  return [
    { type: "subagent/descriptor", time: 1, data: { version: 2, mode: "one-shot", label } },
    { type: "turn/start", time: 2, data: { turn: 1 } },
    { type: "assistant/message", time: 3, data: { turn: 1, step: 1,
      message: { content: [{ type: "text", text: "```json\n" + JSON.stringify({ outcome_id: outcomeId }) + "\n```" }] }, stream: [] } },
    { type: "turn/end", time: 4, data: { reason: { kind: "completed" } } },
  ];
}

it("reports a declaration-driven stop produced by terminal child recovery in the same sweep", async () => {
  const root = mkdtempSync(join(tmpdir(), "recovery-new-stop-"));
  roots.push(root);
  persistDeclaredGraph(buildDeclaredOutcomeGraph({ declaration: {
    version: 3, name: GRAPH_ID,
    nodes: [
      { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }, { id: "abandoned" }] },
      { id: "ship", agent: "agent.ship", prompt: "Ship the result.", outcomes: [{ id: "delivered" }] },
    ],
    edges: [{ from: "work", to: "ship", outcome: "done" }],
  } }), root);
  const adapter = new DshOutcomeDelivery({
    subagents: { registerProvider: () => () => {}, getProvider: () => undefined, list: () => [],
      startActivation: async () => { throw new Error("recovery must not create another child"); } },
    readExecutionEvents: async () => terminalEvents(dispatchIdempotencyKeyOf(dispatchEffectKeyOf(GRAPH_ID, "work#1")), "abandoned"),
    onSettled: () => {}, onStartFailed: () => {},
  });
  const host = open(root, { query: adapter.executionQuery, observeExecution: adapter.observeExecution,
    derivedOutcomeOf: adapter.derivedOutcomeOf });
  try {
    await start(host);
    resetCapture();
    const report = await host.recoverDeclaredGraphs();
    expect(report.completed).toEqual([GRAPH_ID + ":work#1:derived"]);
    expect(report.effectRefusals).toEqual([]);
    expect(report.awaitingCompletion).toEqual([]);
    expect(report.controlled).toEqual([]);
    expect(report.stopped).toEqual([GRAPH_ID + ":unreachable-pending-node"]);
    expect(aggregate()).toMatchObject({ code: "sweep.attention", level: "warn", fields: { stopped: report.stopped } });
    resetCapture();
    expect((await host.recoverDeclaredGraphs()).stopped).toEqual(report.stopped);
  } finally { adapter.close(); }
});

for (const child of ["matching", "foreign", "missing"] as const) {
  it("recovers a confirmed child after its parent disappears with child evidence: " + child, async () => {
    const root = fixture(false);
    const first = open(root);
    await start(first, "removed-parent");
    first.close();
    const reads: string[] = [];
    let listings = 0;
    let creates = 0;
    const effect = dispatchEffectKeyOf(GRAPH_ID, "work#1");
    const adapter = new DshOutcomeDelivery({
      subagents: { registerProvider: () => () => {}, getProvider: () => undefined, list: () => [],
        startActivation: async () => { throw new Error("recovery must not create another child"); },
        listChildren: async () => { listings++; throw new Error("parent session no longer exists"); } },
      readExecutionEvents: async id => { reads.push(id); return child === "missing" ? undefined :
        terminalEvents(child === "matching" ? dispatchIdempotencyKeyOf(effect) : "other/dispatch:work#1"); },
      onSettled: () => {}, onStartFailed: () => {},
    });
    const restarted = OutcomeHost.open({ workspaceDir: root, storeRoot: root, declareInvocationIdentity: false,
      validators: EMPTY_VALIDATORS, deliver: () => { creates++; }, query: adapter.executionQuery,
      observeExecution: adapter.observeExecution, derivedOutcomeOf: adapter.derivedOutcomeOf,
    });
    hosts.push(restarted);
    try {
      resetCapture();
      const report = await restarted.recoverDeclaredGraphs();
      expect(reads).toEqual(["worker:work#1"]);
      expect(listings).toBe(0);
      expect(creates).toBe(0);
      if (child === "matching") {
        expect(report.completed).toEqual([GRAPH_ID + ":work#1:derived"]);
        expect(report.effectRefusals.map(entry => entry.code)).toEqual(["credential-reissue-forbidden"]);
        expect(aggregate()).toMatchObject({ code: "sweep.attention", level: "warn" });
      } else {
        expect(report.completed).toEqual([]);
        expect(report.awaitingCompletion.map(entry => entry.status)).toEqual(["unknown"]);
        expect(aggregate()).toMatchObject({ code: "sweep.attention", level: "warn" });
      }
    } finally { adapter.close(); }
  });
}

it("keeps an unbound dispatch unknown when its parent is missing and never creates another worker", async () => {
  const root = fixture(false);
  const first = open(root, {}, false);
  await start(first, "removed-parent");
  first.close();
  let listings = 0;
  let reads = 0;
  let creates = 0;
  const adapter = new DshOutcomeDelivery({
    subagents: { registerProvider: () => () => {}, getProvider: () => undefined, list: () => [],
      startActivation: async () => { throw new Error("recovery must not create another child"); },
      listChildren: async () => { listings++; throw new Error("parent session no longer exists"); } },
    readExecutionEvents: async () => { reads++; return []; }, onSettled: () => {}, onStartFailed: () => {},
  });
  const restarted = OutcomeHost.open({ workspaceDir: root, storeRoot: root, declareInvocationIdentity: false,
    validators: EMPTY_VALIDATORS, deliver: () => { creates++; }, query: adapter.executionQuery,
    observeExecution: adapter.observeExecution, derivedOutcomeOf: adapter.derivedOutcomeOf,
  });
  hosts.push(restarted);
  try {
    resetCapture();
    const report = await restarted.recoverDeclaredGraphs();
    expect(listings).toBe(1);
    expect(reads).toBe(0);
    expect(creates).toBe(0);
    expect(report.completed).toEqual([]);
    expect(report.effectRefusals.length).toBeGreaterThan(0);
    expect(aggregate()).toMatchObject({ code: "sweep.attention", level: "warn" });
  } finally { adapter.close(); }
});

it("does not prime a mismatched execution row as the dispatch's confirmed binding", async () => {
  const root = fixture();
  const probes: OutcomeExecutionProbe[] = [];
  const host = open(root, { query: { lookup: () => ({ kind: "unknown", reason: "not listed" }),
    prime: async entries => { probes.push(...entries); } } });
  await start(host);
  const store = GraphStore.openFile(root);
  try { store.run(`UPDATE ${GRAPH_STORE_TABLES.executions} SET attempt_id = 'other#1' WHERE graph_id = ?`, GRAPH_ID); }
  finally { store.close(); }
  await host.recoverDeclaredGraphs();
  expect(probes).toHaveLength(1);
  expect(probes[0]?.execution).toBeUndefined();
});
