/**
 * THE WORKER GRAPH-TOOL FACES ARE ONE CLOSED VOCABULARY, TYPED (F-06).
 *
 * WHAT THIS FILE PINS. Four faces spell out which graph tools their caller may
 * invoke — the in-process worker boundary, the remote worker channel, the Pi
 * worker process's registration and the dsh execution guard — and they do not
 * share one membership. Each was a bare string literal, so `includes`/`has`
 * accepted any string and a rename or a new tool changed no face's compile.
 * They are now lists of `GraphToolName` (`src/graph/host/tool-binding.ts`):
 *
 * 1. THE TYPE-LEVEL CONTRACT. `HOST_FACE`, `DSH_FACE` and `CHANNEL_FACE` below
 *    are typed `readonly GraphToolName[]`, and `OUT_OF_VOCABULARY_IS_REJECTED`
 *    stops compiling the day a name outside the shipped vocabulary type-checks
 *    as one. The authority is `bun run typecheck:tests`; a bare-string face
 *    cannot come back without failing it.
 * 2. THE MEMBERSHIP DECISION, asserted per face. The in-process boundary grants
 *    exactly the delivery channel; dsh adds its own command entry; the remote
 *    channel exposes the two authoritative-store readers. The DIVERGENCE IS
 *    DELIBERATE AND RECORDED, not unified: narrowing the remote channel would
 *    withdraw a capability the audit did not authorize changing, and widening
 *    the in-process face would hand a worker the readers §3.3 reserves to the
 *    declaring principal.
 * 3. THE ONE DECLARATION. The Pi worker process registers exactly the channel's
 *    list, driven through the production `registerPiGraphWorker` rather than
 *    compared by reading the source.
 *
 * AND F-29. The notification capture must not build a durable notification from
 * a graph whose invocation origin the store lists but cannot answer: the spread
 * of `undefined` is legal JavaScript, so the missing origin used to produce a
 * persisted record whose required `sessionId` was absent. The last case drives
 * that path through the production capture and asserts the outcome.
 *
 * STRENGTH: pure unit plus one store-backed capture. No host SDK runs. Every
 * store root lives under the OS temp directory and is removed.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GRAPH_TOOL_NAMES,
  isGraphToolName,
  WORKER_GRANTED_GRAPH_TOOLS,
  type GraphToolName,
} from "../../src/graph/host/tool-binding.ts";
import { WORKER_CHANNEL_GRAPH_TOOLS } from "../../src/graph/application/worker-channel.ts";
import { GraphApplication } from "../../src/graph/application/graph-application.ts";
import type { GraphNotification } from "../../src/graph/application/graph-notifications.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { GRAPH_STORE_TABLES } from "../../src/graph/store/schema.ts";
import type {
  OutcomeDispatchEffectKey,
  OutcomeDispatchRequest,
} from "../../src/graph/outcome/dispatch-effects.ts";
import type { CanonicalToolContext } from "../../src/platform/types.ts";
import {
  DSH_GRAPH_WORKER_GRANT,
  DSH_GRAPH_WORKER_TOOLS,
} from "../../src/platform/adapters/dsh/graph-worker.ts";
import { registerPiGraphWorker } from "../../src/platform/adapters/pi/graph-worker.ts";
import {
  __resetLoggingForTest,
  configureLogging,
  type LogRecord,
} from "../../src/log/index.ts";
import { createMemorySink, type MemorySink } from "../../src/log/sinks/memory.ts";
import { beginLogTest, endLogTest } from "../helpers/log.ts";
import { naturalDeclaration, POLICY_BODY, POLICY_ID } from "./helpers/host-graph-fixture.ts";

// ── The type-level pins (authority: `bun run typecheck:tests`) ───────────────
//
// Each face must be a `readonly GraphToolName[]`: the day one of them goes back
// to `readonly string[]`, these annotations stop compiling. They are read by the
// cases below, so they are live values, not decoration.

const HOST_FACE: readonly GraphToolName[] = WORKER_GRANTED_GRAPH_TOOLS;
const DSH_FACE: readonly GraphToolName[] = DSH_GRAPH_WORKER_GRANT;
const CHANNEL_FACE: readonly GraphToolName[] = WORKER_CHANNEL_GRAPH_TOOLS;

/**
 * A name outside the shipped vocabulary must NOT be one. The condition is
 * `false` while `GraphToolName` is closed; widening it (to `string`, say) makes
 * the condition `true` and the initialiser above stops compiling.
 */
const OUT_OF_VOCABULARY_IS_REJECTED: "graph_not_shipped" extends GraphToolName ? false : true = true;

/** Every vocabulary member resolves through the narrowing the faces use. */
const VOCABULARY_RESOLVES_THROUGH_THE_GUARD: readonly GraphToolName[] =
  GRAPH_TOOL_NAMES.filter((name) => isGraphToolName(name));

describe("the worker graph-tool faces", () => {
  it("answers membership by narrowing into one closed vocabulary", () => {
    expect(GRAPH_TOOL_NAMES.length).toBe(6);
    expect([...VOCABULARY_RESOLVES_THROUGH_THE_GUARD]).toEqual([...GRAPH_TOOL_NAMES]);
    expect(isGraphToolName("graph_not_shipped")).toBe(false);
    expect(isGraphToolName("graph_submit_outcome_extra")).toBe(false);
    expect(isGraphToolName("")).toBe(false);
    // The compile-time pin, exercised so it cannot be dropped as dead code.
    expect(OUT_OF_VOCABULARY_IS_REJECTED).toBe(true);
  });

  it("pins each face's membership, including the documented divergence", () => {
    // THE IN-PROCESS BOUNDARY: the delivery channel, and nothing else. The
    // authoritative-store readers belong to the declaring/operating principal.
    expect([...HOST_FACE]).toEqual(["graph_submit_outcome"]);
    expect(HOST_FACE.length).toBe(1);
    // DSH: the same delivery channel plus this host's own worker command entry.
    expect([...DSH_FACE]).toEqual(["graph_submit_outcome", "graph_worker_exec"]);
    expect(DSH_FACE.length).toBe(2);
    // THE EXPORTED dsh BINDING IS THE TYPED GRANT — one array, widened only for
    // the callers that compare it against a name they know as a `string`.
    expect([...DSH_GRAPH_WORKER_TOOLS]).toEqual([...DSH_GRAPH_WORKER_GRANT]);
    // THE REMOTE CHANNEL: the delivery channel plus the two store readers.
    expect([...CHANNEL_FACE]).toEqual(["graph_submit_outcome", "graph_status", "graph_audit"]);
    expect(CHANNEL_FACE.length).toBe(3);
    // THE DIVERGENCE, stated as the contract instead of left implicit: the
    // channel exposes the readers the in-process face refuses, and that is the
    // recorded clarification item rather than a silent unification.
    for (const reader of ["graph_status", "graph_audit"] as const) {
      expect(WORKER_GRANTED_GRAPH_TOOLS).not.toContain(reader);
      expect(WORKER_CHANNEL_GRAPH_TOOLS).toContain(reader);
    }
  });

  it("registers exactly the channel's face in the Pi worker process", () => {
    const names: string[] = [];
    const pi = {
      registerTool(tool: unknown): void {
        if (typeof tool === "object" && tool !== null && "name" in tool && typeof tool.name === "string") {
          names.push(tool.name);
        }
      },
    };
    process.env.ROLEBOX_GRAPH_WORKER_ENDPOINT = "http://127.0.0.1:1/invoke";
    process.env.ROLEBOX_GRAPH_WORKER_TOKEN = "test-worker-token";
    try {
      expect(registerPiGraphWorker(pi)).toBe(true);
    } finally {
      delete process.env.ROLEBOX_GRAPH_WORKER_ENDPOINT;
      delete process.env.ROLEBOX_GRAPH_WORKER_TOKEN;
      delete process.env.ROLEBOX_GRAPH_WORKER_ROUTE;
    }
    expect(names.sort()).toEqual([...WORKER_CHANNEL_GRAPH_TOOLS].sort());
  });
});

describe("the notification capture with a listed graph and no origin row (F-29)", () => {
  const roots: string[] = [];
  let logState: { env: Record<string, string | undefined>; dir: string };
  let memory: MemorySink;

  beforeEach(() => {
    logState = beginLogTest();
    memory = createMemorySink({ capacity: 64 });
    configureLogging({ sinks: [memory], level: "debug" });
  });

  afterEach(() => {
    endLogTest(logState);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** The captured records of one registered event code. */
  const records = (code: string): LogRecord[] =>
    memory.records().filter((record) => record.code === code);

  it("refuses to build a notice from a missing origin, reports it, and persists nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "worker-face-guards-"));
    roots.push(root);
    const storeRoot = join(root, "store");
    const now = Date.now();
    // THE NOTICE THIS CASE WOULD OTHERWISE CARRY: the same declaration and
    // settlement `tests/graph/application/graph-notifications.test.ts` drives to
    // a `complete` notification, so the capture under test really has a notice
    // to build rather than an empty run.
    const delivered: GraphNotification[] = [];
    const requests: { request: OutcomeDispatchRequest; effect: OutcomeDispatchEffectKey }[] = [];
    const app = GraphApplication.open({
      workspaceDir: root,
      storeRoot,
      env: {
        ROLEBOX_GRAPH_COMPLETION_POLICIES: JSON.stringify({
          declare: [{ id: POLICY_ID, revision: "1", body: POLICY_BODY }],
          authorize: [POLICY_ID + "@1"],
        }),
        ROLEBOX_GRAPH_APPROVAL_POLICY: JSON.stringify({
          id: "review-policy",
          revision: "1",
          rules: [{ graphId: "flow", nodeId: "work", approverSessions: ["reviewer"] }],
        }),
      },
      declareInvocationIdentity: false,
      workerSessionOf: (execution) => execution.executionId,
      observeExecution: () => ({ kind: "completed" }),
      deliver: (request, effect) => { requests.push({ request, effect }); },
      notifications: {
        clock: () => now,
        send: async (notification) => { delivered.push(notification); return true; },
      },
    });
    // The capture under test is this application's own; an application
    // opened without notification options has none, and the case refuses to
    // read one as if it were there.
    const notifications = app.notifications;
    if (notifications === undefined) throw new Error("this application was opened with no notification owner");
    const tools = app.createTools();
    const call = async (name: string, args: Record<string, unknown>, sessionID = "parent") => {
      const context: CanonicalToolContext = {
        sessionID, messageID: "message", agent: "orchestrator",
        directory: root, worktree: root, abort: new AbortController().signal,
        metadata() {}, async ask() {},
      };
      return JSON.parse(String(await tools[name].execute(args, context)));
    };
    const declare = () => call("graph_declare", {
      declaration: {
        version: 3, name: "flow", nodes: [
          { id: "work", agent: "worker", prompt: "Work", outcomes: [{ id: "done" }] },
          { id: "review", agent: "reviewer", prompt: "Review", outcomes: [{ id: "done" }] },
        ], edges: [{ from: "work", to: "review", outcome: "done" }],
      },
    });
    const settle = async (index: number) => {
      const { request, effect } = requests[index];
      const child = `worker-${index}`;
      app.host.confirmExecution(effect, { executionId: child });
      const args = {
        graph_id: "flow", node_id: request.nodeId, outcome_id: "done",
        credential: request.credential,
      };
      expect((await call("graph_submit_outcome", args, child)).decision).toBe("accepted");
    };

    // THE DIVERGENCE THE STORE'S OWN INVARIANT FORBIDS: the origin list answers
    // `flow` while the origin read answers nothing. The read is left honest while
    // the graph is declared and its first node settles, so the harness is real,
    // and is hidden only for the settlement that produces the terminal notice.
    const original = GraphStore.prototype.readInvocationOrigin;
    let originVisible = true;
    GraphStore.prototype.readInvocationOrigin = function (graphId: string) {
      return originVisible ? original.call(this, graphId) : undefined;
    };
    try {
      expect((await declare()).start.kind).toBe("started");
      await settle(0);
      originVisible = false;
      await settle(1);
      await notifications.flush();
      await notifications.flush();
    } finally {
      GraphStore.prototype.readInvocationOrigin = original;
      app.close();
    }

    // NO MALFORMED RECORD REACHES THE TRANSPORT, and none is persisted: the
    // spread of `undefined` is legal JavaScript, so before the guard this list
    // held a `complete` notification with no `sessionId` at all.
    expect(delivered).toEqual([]);
    const inspect = GraphStore.openFile(storeRoot);
    try {
      expect(
        inspect.all(
          `SELECT effect_id FROM ${GRAPH_STORE_TABLES.pendingEffects} WHERE kind = ?`,
          "graph-notification",
        ),
      ).toEqual([]);
    } finally {
      inspect.close();
    }

    // THE SKIP IS OBSERVABLE, not silent: the event the unreadable-view path
    // already emits names the graph, once for the stretch rather than per pass.
    const reported = records("notifications.source-unreadable");
    expect(reported.length).toBe(1);
    expect(reported[0]?.scope).toEqual({ graphId: "flow" });
  });
});
