/**
 * host-reader-gate — the HOST HALF of F-05 and F-03.
 *
 * THE RULE THIS FILE PINS: no host slice narrows a persisted JSON column
 * outside the module that owns its layout.
 *
 * 1. F-05 — the dispatch-request boundary. `PendingEffectRecord.payload` is
 *    `unknown`, and the runtime's own TOTAL reader (`readDispatchRequest`) is
 *    the module that owns its shape. The host used to hand-read only
 *    `attemptId`/`nodeId`, so a row the runtime's reader refuses — a payload
 *    naming another graph, another plan revision, carrying a `credential` the
 *    runtime never persists on an effect, or missing a non-empty field — was
 *    accepted as a dispatch target, and that `nodeId` became the binding a
 *    restarted worker's declared host-tool grant is resolved from. These cases
 *    tamper the ONE persisted payload, then open a SECOND host over the store
 *    the first host dispatched into (no process cache) and require the binding
 *    to come from the RECORDED RUN STATE instead of the refused payload.
 *
 * 2. F-03 — the recorded run state. `GraphStateRecord.body` is `unknown`, and
 *    its layout is versioned and owned by the state codec. The host used to
 *    hand-parse `nodes`/`attemptId`/`nodeId`, so a body the codec refuses was a
 *    SILENT miss: the completion bridge reported `unbound` with no refusal and
 *    no log for attempts the host really created. These cases require the
 *    codec's reader for a body it accepts and a REPORTED refusal for one it
 *    does not.
 *
 * COMPATIBILITY: every case that must keep working is asserted beside the case
 * that must now refuse. A payload the RUNTIME wrote and a run-state body a REAL
 * WRITER produced both still resolve the node, through the same public
 * `workerDeclaredToolsOf` a restarted host serves a worker with — and the two
 * nodes carry DIFFERENT grants (`computer_*` vs `browser_open`), so an answer
 * names which of the two sources produced the binding.
 *
 * PRIVACY: temp directories only; no case prints or asserts a credential VALUE
 * (the one credential-bearing fixture is a marker the ledger never wrote).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import type { PendingEffectRecord } from "../../src/graph/ledger/types.ts";
import { OutcomeHost } from "../../src/graph/host/outcome-host.ts";
import type { OutcomeWorkerPrincipal } from "../../src/graph/host/tool-binding.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/dispatch-effects.ts";
import type { OutcomeGraphState } from "../../src/graph/outcome/graph-state.ts";
import { readDispatchRequest } from "../../src/graph/outcome/runtime-readings.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import {
  readStoredDefinition,
  readStoredRunStateOf,
} from "../../src/graph/persistence/declared-record.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { GRAPH_STORE_TABLES } from "../../src/graph/store/schema.ts";
import {
  buildDeclaredOutcomeGraph,
  persistDeclaredGraph,
} from "../../src/graph/tools/declare-graph.ts";
import { configureLogging } from "../../src/log/index.ts";
import { createMemorySink, type MemorySink } from "../../src/log/sinks/memory.ts";
import type { LogRecord } from "../../src/log/types.ts";
import { beginLogTest, endLogTest } from "../helpers/log.ts";
import { removeTempTrees } from "./helpers/temp-dirs.ts";

// ── Fixture ─────────────────────────────────────────────────────────────────

const GRAPH_ID = "graph.host-reader-gate";
const EMPTY_VALIDATORS = createValidatorRegistry([]);

/** The node whose attempt the binding cases resolve. */
const WORK_NODE = "alpha";
/** The other node — the id a tampered payload falsely names. */
const OTHER_NODE = "beta";
/** The grant each node declares, so an answer names its source. */
const WORK_GRANT = "computer_*";
const OTHER_GRANT = "browser_open";

/** Two independent nodes, each declaring a DIFFERENT host-tool grant. */
const DECLARATION: GraphDeclarationV3 = {
  version: 3,
  name: GRAPH_ID,
  nodes: [
    {
      id: WORK_NODE,
      agent: "agent.alpha",
      prompt: "Do alpha.",
      outcomes: [{ id: "done" }],
      tools: [WORK_GRANT],
    },
    {
      id: OTHER_NODE,
      agent: "agent.beta",
      prompt: "Do beta.",
      outcomes: [{ id: "done" }],
      tools: [OTHER_GRANT],
    },
  ],
  edges: [],
};

const tmpDirs: string[] = [];

let logState: { env: Record<string, string | undefined>; dir: string };
let memory: MemorySink;

beforeEach(() => {
  logState = beginLogTest();
  memory = createMemorySink({ capacity: 64 });
  configureLogging({ sinks: [memory], level: "debug" });
});

afterEach(() => {
  endLogTest(logState);
  removeTempTrees(tmpDirs);
});

interface GateFixture {
  readonly dir: string;
  readonly storeRoot: string;
  readonly dispatched: readonly OutcomeDispatchRequest[];
  /** The attempt the fixture's first host dispatched for one node. */
  readonly attemptOf: (nodeId: string) => string;
}

/** The platform's own execution id for one attempt (the fixture's mapping). */
function executionIdOf(attemptId: string): string {
  return "exec:" + attemptId;
}

/** The worker principal a restarted host would serve for one attempt. */
function principalOf(attemptId: string): OutcomeWorkerPrincipal {
  return {
    graphId: GRAPH_ID,
    attemptId,
    executionId: executionIdOf(attemptId),
    workerSessionId: "worker:" + attemptId,
  };
}

/**
 * One host over an EXISTING store root, with the deliveries it was handed
 * recorded and the platform's execution confirmed for each.
 *
 * `durability: "file"` is deliberate: the durable half of the binding (the
 * execution row plus the dispatch effect) is the thing under test, so the host
 * must write it where a SECOND host — one that never dispatched these attempts
 * and holds no process cache — reads it back.
 */
function openGateHost(
  dir: string,
  storeRoot: string,
  dispatched: OutcomeDispatchRequest[],
): OutcomeHost {
  let host: OutcomeHost | undefined;
  const opened = OutcomeHost.open({
    workspaceDir: dir,
    storeRoot,
    durability: "file",
    declareInvocationIdentity: false,
    validators: EMPTY_VALIDATORS,
    deliver: (request, effect) => {
      dispatched.push(request);
      host?.confirmExecution(effect, { executionId: executionIdOf(request.attemptId) });
    },
  });
  host = opened;
  return opened;
}

/** Declare the fixture graph and dispatch every node from a FIRST host. */
async function dispatchFixture(prefix: string): Promise<GateFixture> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  const storeRoot = join(dir, "host-store");
  mkdirSync(storeRoot, { recursive: true });
  persistDeclaredGraph(buildDeclaredOutcomeGraph({ declaration: DECLARATION }), storeRoot);
  const dispatched: OutcomeDispatchRequest[] = [];
  const host = openGateHost(dir, storeRoot, dispatched);
  try {
    const started = await host.startDeclaredGraph(GRAPH_ID, {
      sessionId: "session-declarer",
      agent: "agent.declarer",
    });
    if (started.kind !== "started") {
      throw new Error("fixture: the graph did not start (" + started.kind + ")");
    }
  } finally {
    host.close();
  }
  return {
    dir,
    storeRoot,
    dispatched,
    attemptOf: (nodeId: string): string => {
      const request = dispatched.find((entry) => entry.nodeId === nodeId);
      if (request === undefined) {
        throw new Error("fixture: node " + nodeId + " was not dispatched");
      }
      return request.attemptId;
    },
  };
}

/** The plan revision the graph's OWN stored definition names. */
function storedPlanRevision(storeRoot: string): string {
  const reading = readStoredDefinition(storeRoot, GRAPH_ID);
  if (reading.kind !== "ok") {
    throw new Error("fixture: the stored definition is not readable");
  }
  return reading.declared.plan.planRevision;
}

/** The attempt's persisted dispatch effect, as the store lists it. */
function dispatchEffectOf(
  storeRoot: string,
  attemptId: string,
): PendingEffectRecord {
  const store = GraphStore.openFile(storeRoot);
  try {
    const effect = store
      .pendingEffects(GRAPH_ID)
      .find((entry) => entry.attemptId === attemptId);
    if (effect === undefined) {
      throw new Error("fixture: no pending dispatch effect for " + attemptId);
    }
    return effect;
  } finally {
    store.close();
  }
}

/** The attempt's persisted dispatch payload, read by ITS OWNING READER. */
function readPersistedPayload(
  storeRoot: string,
  attemptId: string,
): ReturnType<typeof readDispatchRequest> {
  return readDispatchRequest(dispatchEffectOf(storeRoot, attemptId).payload, {
    graphId: GRAPH_ID,
    planRevision: storedPlanRevision(storeRoot),
  });
}

/** One way a persisted payload stops being a dispatch request of this graph. */
type DispatchTamper = "foreign-graph" | "stale-revision" | "credential" | "missing-agent";

/** The offending field one tamper writes into the payload. */
function offendingField(
  tamper: DispatchTamper,
  planRevision: string,
): Record<string, unknown> {
  switch (tamper) {
    case "foreign-graph":
      return { graphId: "graph.somewhere-else" };
    case "stale-revision":
      return { planRevision: planRevision + "-stale" };
    case "credential":
      // The runtime NEVER persists a credential on an effect, so this marker is
      // proof the row was not written by the runtime (its VALUE is irrelevant).
      return { credential: "bearer-value-never-persisted" };
    case "missing-agent":
      return { agent: "" };
  }
}

/**
 * REPLACE one persisted dispatch payload with a row the runtime's own reader
 * REFUSES, while its `nodeId` still names the OTHER node.
 *
 * That is the shape the pre-fix host accepted: it checked only `attemptId` and a
 * non-empty `nodeId`, so the payload's id — and with it the OTHER node's
 * declared host-tool grant — became the worker's binding after a restart.
 */
function tamperDispatchPayload(
  storeRoot: string,
  attemptId: string,
  tamper: DispatchTamper,
): void {
  const effect = dispatchEffectOf(storeRoot, attemptId);
  const reading = readPersistedPayload(storeRoot, attemptId);
  if (reading.kind !== "ok") {
    throw new Error("fixture: the runtime's own payload is not readable");
  }
  const rewritten = {
    ...reading.target,
    nodeId: OTHER_NODE,
    ...offendingField(tamper, reading.target.planRevision),
  };
  const store = GraphStore.openFile(storeRoot);
  try {
    store.run(
      `UPDATE ${GRAPH_STORE_TABLES.pendingEffects} SET payload = ? WHERE graph_id = ? AND effect_id = ?`,
      JSON.stringify(rewritten),
      GRAPH_ID,
      effect.effectId,
    );
  } finally {
    store.close();
  }
}

/**
 * Close one attempt's dispatch effect, so the recorded RUN STATE is the only
 * remaining source that can name its node — the terminal half of
 * `durableBindingOf`.
 */
function retireDispatchEffect(storeRoot: string, attemptId: string): void {
  const store = GraphStore.openFile(storeRoot);
  try {
    store.run(
      `UPDATE ${GRAPH_STORE_TABLES.pendingEffects} SET status = 'done' WHERE graph_id = ? AND attempt_id = ?`,
      GRAPH_ID,
      attemptId,
    );
  } finally {
    store.close();
  }
}

/**
 * Rewrite the persisted run-state BODY with the caller's change, through the
 * store's typed writer — a real writer's own row, byte for byte, with one field
 * moved.
 */
function rewriteRecordedState(
  storeRoot: string,
  rewrite: (state: OutcomeGraphState) => unknown,
): void {
  const definition = readStoredDefinition(storeRoot, GRAPH_ID);
  if (definition.kind !== "ok") {
    throw new Error("fixture: the stored definition is not readable");
  }
  const store = GraphStore.openFile(storeRoot);
  try {
    const reading = readStoredRunStateOf(store, definition.declared);
    if (reading.kind !== "recorded") {
      throw new Error("fixture: the fixture has no recorded run state");
    }
    const record = store.readGraphState(GRAPH_ID);
    if (record === undefined) {
      throw new Error("fixture: the fixture has no run-state row");
    }
    store.writeGraphState({ ...record, body: rewrite(reading.state) });
  } finally {
    store.close();
  }
}

/** Every host-channel warning this file's report is expected to produce. */
function reportedRunStateRefusals(): readonly LogRecord[] {
  return memory
    .records()
    .filter(
      (record) =>
        record.channel === "graph:host" &&
        record.level === "warn" &&
        record.message.includes("recorded run state could not be read"),
    );
}

// ── F-05 — the dispatch request is read by its owning reader ────────────────

describe("F-05 — the persisted dispatch payload is read by readDispatchRequest", () => {
  it("still binds the node from a payload the RUNTIME wrote", async () => {
    const fixture = await dispatchFixture("host-reader-gate-ok-");
    const attemptId = fixture.attemptOf(WORK_NODE);
    // The row the run path wrote is a target of this graph, on this revision.
    expect(readPersistedPayload(fixture.storeRoot, attemptId).kind).toBe("ok");
    const restarted = openGateHost(fixture.dir, fixture.storeRoot, []);
    try {
      // The grant comes from the RECORDED node: `computer_*` is alpha's, so the
      // runtime-written payload still resolves the node a live dispatch used.
      expect(restarted.workerDeclaredToolsOf(principalOf(attemptId))).toEqual([WORK_GRANT]);
    } finally {
      restarted.close();
    }
  });

  for (const tamper of [
    "foreign-graph",
    "stale-revision",
    "credential",
    "missing-agent",
  ] as const) {
    it("refuses a " + tamper + " payload and never binds its nodeId", async () => {
      const fixture = await dispatchFixture("host-reader-gate-" + tamper + "-");
      const attemptId = fixture.attemptOf(WORK_NODE);
      tamperDispatchPayload(fixture.storeRoot, attemptId, tamper);
      // The OWNING reader refuses the rewritten row...
      expect(readPersistedPayload(fixture.storeRoot, attemptId).kind).toBe("malformed");

      const restarted = openGateHost(fixture.dir, fixture.storeRoot, []);
      try {
        // ...so its `nodeId` (beta, a different grant) is never the binding: the
        // recorded run state names alpha. A host that hand-read the payload
        // answered with beta's grant here.
        expect(restarted.workerDeclaredToolsOf(principalOf(attemptId))).toEqual([WORK_GRANT]);
      } finally {
        restarted.close();
      }
    });
  }
});

// ── F-03 — the recorded run state is read by the versioned state codec ──────

describe("F-03 — the recorded run state is read by the versioned state codec", () => {
  it("still binds the node from a body the codec accepts", async () => {
    const fixture = await dispatchFixture("host-reader-gate-state-ok-");
    const attemptId = fixture.attemptOf(WORK_NODE);
    // The terminal half: the effect is closed, so only the state can answer.
    retireDispatchEffect(fixture.storeRoot, attemptId);
    const restarted = openGateHost(fixture.dir, fixture.storeRoot, []);
    try {
      expect(restarted.workerDeclaredToolsOf(principalOf(attemptId))).toEqual([WORK_GRANT]);
    } finally {
      restarted.close();
    }
  });

  it("REPORTS a body written in another layout instead of a silent miss", async () => {
    const fixture = await dispatchFixture("host-reader-gate-state-version-");
    const attemptId = fixture.attemptOf(WORK_NODE);
    retireDispatchEffect(fixture.storeRoot, attemptId);
    // A body version this build has no reader for: the record and its node list
    // are still there, which is exactly what the pre-fix hand-parse read.
    rewriteRecordedState(fixture.storeRoot, (state) => ({ ...state, bodyVersion: 99 }));

    const restarted = openGateHost(fixture.dir, fixture.storeRoot, []);
    try {
      expect(restarted.workerDeclaredToolsOf(principalOf(attemptId))).toEqual([]);
    } finally {
      restarted.close();
    }
    const reported = reportedRunStateRefusals();
    expect(reported.length).toBe(1);
    const record = reported[0];
    expect(record?.scope).toEqual({ graphId: GRAPH_ID, attemptId });
    expect(String(record?.fields["reason"])).toContain("body version 99");
  });

  it("REPORTS a body whose node list moved, naming the attempt it could not bind", async () => {
    const fixture = await dispatchFixture("host-reader-gate-state-layout-");
    const attemptId = fixture.attemptOf(WORK_NODE);
    retireDispatchEffect(fixture.storeRoot, attemptId);
    // THE LAYOUT BUMP the hand-parse could not see: the nodes are still here,
    // under a key this build's reader does not know.
    rewriteRecordedState(fixture.storeRoot, (state) => {
      const { nodes, ...rest } = state;
      return { ...rest, nodeStates: nodes };
    });

    const restarted = openGateHost(fixture.dir, fixture.storeRoot, []);
    try {
      expect(restarted.workerDeclaredToolsOf(principalOf(attemptId))).toEqual([]);
    } finally {
      restarted.close();
    }
    const reported = reportedRunStateRefusals();
    expect(reported.length).toBe(1);
    expect(reported[0]?.scope).toEqual({ graphId: GRAPH_ID, attemptId });
    expect(String(reported[0]?.fields["reason"])).toContain("nodeStates");
  });
});
