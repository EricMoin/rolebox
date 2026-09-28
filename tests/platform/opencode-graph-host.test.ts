/// <reference types="bun-types" />

/**
 * opencode family — the host capability layer behind the declared-graph tool face.
 *
 * WHAT THIS FILE PROVES, AND HOW. Every case drives a REAL
 * `OpencodeGraphHost` — a real `GraphApplication`, a real `OutcomeHost`, a real
 * SQLite acceptance ledger under a temp-dir store root — over a FAKE session
 * port, so the declared-graph path runs END TO END WITH NO LLM: a graph is
 * declared through the shipped `graph_declare` tool from a parent session, the
 * delivery creates a worker session and hands it the attempt prompt (the ONE
 * channel the credential travels over), and the WORKER SESSION settles its own
 * attempt through `graph_submit_outcome`. The authoritative answer is then read
 * back through `graph_status`.
 *
 * THE v2 SHAPES THIS FILE RELIES ON ARE THE INSTALLED 2.0.18 DECLARATIONS:
 *  - `SessionDomain = Pick<SessionApi, "create" | ... | "wait" | "context"> & {
 *    hook }` (node_modules/@opencode/plugin/dist/promise/session.d.ts:143-145)
 *    — `wait` is the v2 plugin's turn-end signal and has NO v1 counterpart in
 *    `ISessionClient` (src/platform/ports/session-client.ts:19-113);
 *  - `SessionWaitInput = { sessionID }` / `SessionWaitOutput = void`
 *    (node_modules/@opencode/client/dist/effect/api/api.d.ts:367-371) — what a
 *    wait resolves to, and why a resolved wait may never be read as an outcome;
 *  - the canonical `SessionStatus` union (src/session/types.ts:141-150), which
 *    the observation port projects onto idle / busy / retry.
 *
 * NOTHING HERE TOUCHES THE REAL USER DATA DIR: `ROLEBOX_DATA_DIR` is pointed at
 * a temp dir in `beforeEach` and restored in `afterEach`, every host is closed
 * before its temp dir is removed, and the store root each host opens is
 * `graphStoreRoot(getDataDir(), workspace)` — the host's OWN root, deliberately
 * outside the workspace (src/graph/store/schema.ts:58-60). CI asserts a clean
 * tree, so nothing outside those temp dirs is written.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getDataDir } from "../../src/cli/paths.ts";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import type { OutcomeExecutionCancelProbe } from "../../src/graph/outcome/cancel.ts";
import type { OutcomeHostAwaitingCompletion } from "../../src/graph/host/outcome-host.ts";
import {
  WORKER_GRANTED_GRAPH_TOOLS,
  WORKER_TOOL_FORBIDDEN_CODE,
} from "../../src/graph/host/tool-binding.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import {
  GRAPH_STORE_TABLES,
  graphStoreFilePath,
  graphStoreRoot,
} from "../../src/graph/store/schema.ts";
import {
  OpencodeGraphHost,
  openOpencodeGraphHost,
  opencodeGraphSessionPort,
  opencodeSessionStatusState,
  type OpencodeGraphSessionPort,
  type OpencodeGraphSessionReading,
} from "../../src/platform/adapters/opencode/graph-host.ts";
import type { SessionStatus } from "../../src/session/types.ts";
import { openOpencode2GraphHost } from "../../src/platform/adapters/opencode2/index.ts";
import type { ISessionClient } from "../../src/platform/ports/session-client.ts";
import type { CanonicalToolContext, CanonicalToolDef } from "../../src/platform/types.ts";

// ── Declarations ────────────────────────────────────────────────────────────

const SINGLE_NAME = "opencode.host.single";

/** The one-entry node the delivery test settles: explicit completion, a budget. */
const SINGLE: GraphDeclarationV3 = {
  version: 3,
  name: SINGLE_NAME,
  nodes: [
    {
      id: "solo",
      agent: "agent.worker",
      prompt: "Do the one thing.",
      outcomes: [{ id: "done" }, { id: "failed" }],
      completion: { mode: "explicit" },
      budget: { timeout_ms: 60_000 },
    },
  ],
  edges: [],
};

/** A second graph the WORKER must not be able to declare. */
const OTHER: GraphDeclarationV3 = {
  version: 3,
  name: "opencode.host.other",
  nodes: [
    {
      id: "only",
      agent: "agent.other",
      prompt: "Do the other thing.",
      outcomes: [{ id: "done" }],
      completion: { mode: "explicit" },
    },
  ],
  edges: [],
};

// ── Temp dirs ───────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
const hosts: OpencodeGraphHost[] = [];
let previousDataDir: string | undefined;

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  previousDataDir = process.env.ROLEBOX_DATA_DIR;
  process.env.ROLEBOX_DATA_DIR = makeTmpDir("opencode-graph-host-data-");
});

afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
  if (previousDataDir === undefined) delete process.env.ROLEBOX_DATA_DIR;
  else process.env.ROLEBOX_DATA_DIR = previousDataDir;
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── The session double ──────────────────────────────────────────────────────

/** A prompt one fake session received. */
interface DeliveredPrompt {
  readonly sessionID: string;
  readonly text: string;
  readonly agent?: string;
}

interface FakeSessionOptions {
  /** Omit the port's `wait` (a host with no turn-end call at all). */
  readonly noWait?: boolean;
  /** Omit the port's `status` (a host with no live status read). */
  readonly noStatus?: boolean;
  /** Omit the port's `interrupt` (a host that cannot stop a turn). */
  readonly noInterrupt?: boolean;
  /**
   * The reading this fake answers, defaults to an idle state with no outcome.
   *
   * It is the port's OWN shape (`OpencodeGraphSessionReading`): a state, and —
   * on a platform that records one — the session's terminal outcome.
   */
  readonly status?: (sessionID: string) => Promise<OpencodeGraphSessionReading | null>;
  /** The interrupt answer, defaults to `true`. */
  readonly interrupt?: (sessionID: string) => Promise<boolean>;
  /** The create answer, defaults to one fresh session id per call. */
  readonly create?: (input: { directory: string; agent?: string }) => Promise<{ id: string } | null>;
}

interface FakeSession {
  readonly port: OpencodeGraphSessionPort;
  /** Every deliver prompt this session received, in order. */
  readonly prompts: DeliveredPrompt[];
  /** Every create call, in order. */
  readonly createCalls: Array<{ directory: string; agent?: string }>;
  /** Every interrupt this session was asked for. */
  readonly interrupted: string[];
  /** Resolve every armed wait for one session (the platform's turn-end signal). */
  endTurn(sessionID: string): void;
}

let sessionCounter = 0;

function makeSession(options: FakeSessionOptions = {}): FakeSession {
  sessionCounter += 1;
  const prompts: DeliveredPrompt[] = [];
  const createCalls: Array<{ directory: string; agent?: string }> = [];
  const interrupted: string[] = [];
  const waits: Array<{ sessionID: string; resolve: () => void }> = [];
  const defaultId = "ses_worker_" + String(sessionCounter);
  const create = options.create;
  const status = options.status;
  const interrupt = options.interrupt;
  const port: OpencodeGraphSessionPort = {
    create: async (input) => {
      createCalls.push(input);
      if (create !== undefined) return create(input);
      return { id: defaultId };
    },
    prompt: async (input) => {
      prompts.push(
        input.agent === undefined
          ? { sessionID: input.sessionID, text: input.text }
          : { sessionID: input.sessionID, text: input.text, agent: input.agent },
      );
      return true;
    },
    // The wait resolves ONLY when a case ends the turn: a fake that resolved on
    // its own would be a fabricated end signal.
    ...(options.noWait === true
      ? {}
      : {
          wait: (input: { sessionID: string }) =>
            new Promise<void>((resolve) => {
              waits.push({ sessionID: input.sessionID, resolve });
            }),
        }),
    ...(options.noStatus === true
      ? {}
      : {
          status: (input: { sessionID: string }) =>
            status === undefined
              ? Promise.resolve<OpencodeGraphSessionReading>({ state: "idle" })
              : status(input.sessionID),
        }),
    ...(options.noInterrupt === true
      ? {}
      : {
          interrupt: (input: { sessionID: string }) => {
            interrupted.push(input.sessionID);
            return interrupt === undefined ? Promise.resolve(true) : interrupt(input.sessionID);
          },
        }),
  };
  return {
    port,
    prompts,
    createCalls,
    interrupted,
    endTurn(sessionID: string): void {
      for (const wait of waits.splice(0)) {
        if (wait.sessionID === sessionID) wait.resolve();
        else waits.push(wait);
      }
    },
  };
}

// ── Tool driving ────────────────────────────────────────────────────────────

/** A canonical tool context, as a platform hands one to a tool call. */
function makeContext(
  sessionID: string,
  agent: string,
  directory: string,
): CanonicalToolContext {
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

/** Call one tool and return its raw (string) result. */
async function callTool(
  tools: Record<string, CanonicalToolDef>,
  name: string,
  args: Record<string, unknown>,
  context: CanonicalToolContext,
): Promise<string> {
  const def = tools[name];
  if (def === undefined) throw new Error("fixture: no tool " + name);
  return String(await def.execute(args, context));
}

/**
 * One `graph_status format=json` reading, as much of it as these cases read.
 *
 * THE RENDERED SNAPSHOT RENAMES `nodeId` TO `node_id`
 * (src/graph/query/render.ts:70) — the node's other fields, `attempts` and the
 * run keep their own spelling, so this view copies the renderer's, not the
 * query layer's.
 */
interface StatusReading {
  readonly phase: string;
  readonly nodes: ReadonlyArray<{
    readonly node_id: string;
    readonly status: string;
    readonly attemptId?: string;
    readonly outcomeId?: string;
  }>;
  /** Every effect of the current run that has not settled (render.ts:78). */
  readonly unsettled_effects?: ReadonlyArray<{
    readonly effectId: string;
    readonly status: string;
  }>;
  /**
   * The run's recorded control decisions — a node-scoped `failure` recorded on
   * an attempt is visible here, which is how these cases read "the attempt was
   * reported as a failed execution" WITHOUT touching private host state.
   */
  readonly decisions?: ReadonlyArray<{
    readonly nodeId: string;
    readonly attemptId: string;
    readonly command: string;
    readonly reason: string;
  }>;
}

async function readStatus(
  tools: Record<string, CanonicalToolDef>,
  graphId: string,
  context: CanonicalToolContext,
): Promise<StatusReading> {
  return JSON.parse(
    await callTool(tools, "graph_status", { graph_id: graphId, format: "json" }, context),
  ) as StatusReading;
}

/**
 * Poll `graph_status` until it shows what a platform signal is supposed to have
 * caused. The settlement paths are asynchronous, so the reading is POLLED for
 * (bounded, never slept on) instead of asserted on a guess.
 */
async function waitForStatus(
  predicate: (reading: StatusReading) => boolean,
  tools: Record<string, CanonicalToolDef>,
  graphId: string,
  context: CanonicalToolContext,
  label: string,
): Promise<StatusReading> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const reading = await readStatus(tools, graphId, context);
    if (predicate(reading)) return reading;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("fixture: timed out waiting for " + label);
}

function nodeOf(reading: StatusReading, nodeId: string): StatusReading["nodes"][number] {
  const found = reading.nodes.find((node) => node.node_id === nodeId);
  if (found === undefined) throw new Error("fixture: no status entry for node " + nodeId);
  return found;
}

/** Poll a predicate that a platform signal settles asynchronously. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("fixture: timed out waiting for " + label);
}

/** Let every microtask/macrotask a settlement started run to completion. */
function settleWindow(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

// ── Host fixtures ───────────────────────────────────────────────────────────

function track(host: OpencodeGraphHost): OpencodeGraphHost {
  hosts.push(host);
  return host;
}

/** One host over a fresh workspace and the host-owned store root for it. */
function openHost(
  session: FakeSession,
  options: {
    workspace?: string;
    sessionEndFeed?: boolean;
    /** The declaring session's wake-up channel. Absent → the host installs none. */
    notifyClient?: Pick<ISessionClient, "prompt">;
    /** Whether this port's read names a terminal outcome (the v2 shape). */
    sessionOutcomeRead?: boolean;
  } = {},
): { readonly host: OpencodeGraphHost; readonly workspace: string } {
  const workspace = options.workspace ?? makeTmpDir("opencode-graph-ws-");
  const host = track(
    openOpencodeGraphHost({
      workspaceDir: workspace,
      storeRoot: graphStoreRoot(getDataDir(), workspace),
      session: session.port,
      env: {},
      ...(options.sessionEndFeed === true ? { sessionEndFeed: true } : {}),
      ...(options.notifyClient === undefined ? {} : { notifyClient: options.notifyClient }),
      ...(options.sessionOutcomeRead === true ? { sessionOutcomeRead: true } : {}),
    }),
  );
  return { host, workspace };
}

/** What one delivered attempt handed its worker. */
interface Delivery {
  readonly graphId: string;
  readonly workerSession: string;
  readonly credential: string;
  readonly text: string;
}

/**
 * Declare a graph from a PARENT session and wait for its delivery to be
 * prompted, returning the worker session and the credential the prompt carried.
 */
async function declareAndDeliver(
  host: OpencodeGraphHost,
  session: FakeSession,
  workspace: string,
  declaration: GraphDeclarationV3 = SINGLE,
): Promise<Delivery> {
  const tools = host.createTools();
  const parent = makeContext("session-parent", "agent.parent", workspace);
  const declared = JSON.parse(
    await callTool(tools, "graph_declare", { declaration }, parent),
  ) as { persisted: boolean; start: { kind: string }; graph_id: string };
  expect(declared.persisted).toBe(true);
  expect(declared.start.kind).toBe("started");
  await waitFor(() => session.prompts.length === 1, "the delivery prompt for " + declaration.name);
  const prompt = session.prompts[0];
  if (prompt === undefined) throw new Error("fixture: no prompt was delivered");
  const credential = /credential: (\S+)/.exec(prompt.text)?.[1];
  if (credential === undefined) {
    throw new Error("fixture: the delivery prompt carried no credential");
  }
  return { graphId: declared.graph_id, workerSession: prompt.sessionID, credential, text: prompt.text };
}

/**
 * Settle the delivered single-node attempt with `done`, FROM THE WORKER SESSION,
 * carrying back the credential the delivery prompt handed it.
 */
async function submitDone(
  tools: Record<string, CanonicalToolDef>,
  delivery: Delivery,
  workspace: string,
): Promise<{ readonly decision: string; readonly verdict: string; readonly settled_nodes?: readonly string[] }> {
  return JSON.parse(
    await callTool(
      tools,
      "graph_submit_outcome",
      {
        graph_id: delivery.graphId,
        node_id: "solo",
        outcome_id: "done",
        credential: delivery.credential,
      },
      makeContext(delivery.workerSession, "agent.worker", workspace),
    ),
  ) as { decision: string; verdict: string; settled_nodes?: readonly string[] };
}

/** One attempt the sweep would await, for the watch port. */
function awaiting(executionId: string): OutcomeHostAwaitingCompletion {
  return {
    graphId: SINGLE_NAME,
    nodeId: "solo",
    attemptId: "solo#1",
    executionId,
    status: "unknown",
    reason: "the sweep could not ask the platform",
  };
}

/** One cancel probe for an attempt the host may or may not be able to name. */
function cancelProbe(executionId?: string): OutcomeExecutionCancelProbe {
  return {
    effect: { graphId: SINGLE_NAME, effectId: "dispatch:solo#1", attemptId: "solo#1" },
    nodeId: "solo",
    reason: "the operator asked for a stop",
    ...(executionId === undefined ? {} : { execution: { executionId } }),
  };
}

// ── The tool face ───────────────────────────────────────────────────────────

describe("opencode graph host — the declared-graph tool face", () => {
  it("registers exactly the five declared-graph tools", () => {
    const { host } = openHost(makeSession(), { sessionEndFeed: true });
    expect(Object.keys(host.createTools()).sort()).toEqual([
      "graph_audit",
      "graph_control",
      "graph_declare",
      "graph_status",
      "graph_submit_outcome",
    ]);
  });

  it("settles a real single-node graph end to end with no LLM", async () => {
    const session = makeSession();
    const { host, workspace } = openHost(session, { sessionEndFeed: true });
    const tools = host.createTools();
    const parent = makeContext("session-parent", "agent.parent", workspace);

    const delivery = await declareAndDeliver(host, session, workspace);
    expect(delivery.graphId).toBe(SINGLE_NAME);
    // THE PROMPT IS THE DELIVERY'S OWN RENDER: the plan prompt plus the attempt
    // handoff (src/graph/host/delivery.ts:14-43), and the credential travels
    // ONLY here.
    expect(delivery.text).toContain("Do the one thing.");
    expect(delivery.text).toContain("[rolebox outcome protocol — attempt handoff]");
    expect(delivery.text).toContain("solo");
    // The delivery asked the port to create the worker in THIS workspace, and
    // the session the platform named is the one the host confirmed.
    expect(session.createCalls).toEqual([{ directory: workspace, agent: "agent.worker" }]);
    expect(host.observeExecution({ executionId: delivery.workerSession }).kind).toBe("running");

    // The worker session submits its own attempt's outcome, carrying back the
    // credential its delivery prompt handed it.
    const submitted = JSON.parse(
      await callTool(
        tools,
        "graph_submit_outcome",
        {
          graph_id: delivery.graphId,
          node_id: "solo",
          outcome_id: "done",
          credential: delivery.credential,
        },
        makeContext(delivery.workerSession, "agent.worker", workspace),
      ),
    ) as { decision: string; verdict: string; attempt_id: string; settled_nodes?: readonly string[] };
    expect(submitted.decision).toBe("accepted");
    expect(submitted.verdict).toBe("committed");
    expect(submitted.settled_nodes).toEqual(["solo"]);

    const status = await readStatus(tools, delivery.graphId, parent);
    const solo = nodeOf(status, "solo");
    expect(solo.status).toBe("settled");
    expect(solo.outcomeId).toBe("done");
    expect(status.phase).toBe("complete");
    // The credential is not echoed back by the status surface either.
    expect(JSON.stringify(status)).not.toContain(delivery.credential);
  });

  it("settles the same way through the v2 factory and its own store root", async () => {
    const workspace = makeTmpDir("opencode-graph-v2-ws-");
    const client = makeV2Client();
    const host = track(
      openOpencode2GraphHost({
        directory: workspace,
        client: client.client,
        wait: client.wait,
        env: {},
      }),
    );
    const tools = host.createTools();
    const parent = makeContext("session-parent", "agent.parent", workspace);
    const declared = JSON.parse(
      await callTool(tools, "graph_declare", { declaration: SINGLE }, parent),
    ) as { persisted: boolean; start: { kind: string }; graph_id: string };
    expect(declared.persisted).toBe(true);
    await waitFor(() => client.prompts.length === 1, "the v2 delivery prompt");
    const prompt = client.prompts[0];
    if (prompt === undefined) throw new Error("fixture: no v2 prompt was delivered");
    // THE STORE ROOT IS THE HOST'S OWN, under the data dir and outside the
    // workspace — the graph the v2 entry declares lives there.
    const storeRoot = graphStoreRoot(getDataDir(), workspace);
    expect(existsSync(graphStoreFilePath(storeRoot))).toBe(true);
    expect(storeRoot.startsWith(workspace)).toBe(false);
    // The v2 completion channel is the platform's own wait plus the event feed,
    // and the observation read is the (degraded, always-null) v2 status.
    const notes = host.platformNotes.join(" | ");
    expect(notes).toContain("session wait");
    expect(notes).toContain("session status");
    expect(notes).toContain("cancel port: installed");

    const credential = /credential: (\S+)/.exec(prompt.text)?.[1];
    if (credential === undefined) throw new Error("fixture: the v2 prompt carried no credential");
    const submitted = JSON.parse(
      await callTool(
        tools,
        "graph_submit_outcome",
        { graph_id: declared.graph_id, node_id: "solo", outcome_id: "done", credential },
        makeContext(client.sessions[0] ?? "", "agent.worker", workspace),
      ),
    ) as { decision: string };
    expect(submitted.decision).toBe("accepted");
  });
});

// ── The worker boundary ─────────────────────────────────────────────────────

describe("opencode graph host — the dispatched worker's graph face", () => {
  it("refuses the declarer entries for the bound worker and grants graph_submit_outcome", async () => {
    const session = makeSession();
    const { host, workspace } = openHost(session, { sessionEndFeed: true });
    const tools = host.createTools();
    const delivery = await declareAndDeliver(host, session, workspace);
    const worker = makeContext(delivery.workerSession, "agent.worker", workspace);
    const parent = makeContext("session-parent", "agent.parent", workspace);

    // THE WORKER'S WHOLE GRAPH FACE IS `graph_submit_outcome`: the host bound
    // this session as the attempt's worker, so declaring and controlling are
    // refused BEFORE the tool body runs.
    const refusedDeclare = JSON.parse(
      await callTool(tools, "graph_declare", { declaration: OTHER }, worker),
    ) as { refused?: boolean; code?: string; tool?: string; granted_tools?: readonly string[] };
    expect(refusedDeclare.refused).toBe(true);
    expect(refusedDeclare.code).toBe(WORKER_TOOL_FORBIDDEN_CODE);
    expect(refusedDeclare.tool).toBe("graph_declare");
    expect(refusedDeclare.granted_tools).toEqual([...WORKER_GRANTED_GRAPH_TOOLS]);

    const refusedControl = JSON.parse(
      await callTool(
        tools,
        "graph_control",
        { graph_id: delivery.graphId, command: "cancel", reason: "the worker tried" },
        worker,
      ),
    ) as { refused?: boolean; code?: string; tool?: string };
    expect(refusedControl.refused).toBe(true);
    expect(refusedControl.code).toBe(WORKER_TOOL_FORBIDDEN_CODE);
    expect(refusedControl.tool).toBe("graph_control");

    // The SAME boundary refuses the worker's status read, and the refused
    // declaration wrote nothing: the declarer's own inventory does not list the
    // graph the worker tried to declare.
    const refusedStatus = JSON.parse(
      await callTool(tools, "graph_status", { graph_id: OTHER.name, format: "json" }, worker),
    ) as { refused?: boolean; code?: string };
    expect(refusedStatus.refused).toBe(true);
    expect(refusedStatus.code).toBe(WORKER_TOOL_FORBIDDEN_CODE);
    const inventory = JSON.parse(
      await callTool(tools, "graph_status", { scope: "all", format: "json" }, parent),
    ) as { graphs: ReadonlyArray<{ graph_id: string }> };
    expect(inventory.graphs.map((graph) => graph.graph_id)).toEqual([SINGLE_NAME]);

    // graph_submit_outcome is NOT refused for the worker: a bogus credential is
    // answered by the submission ingress, never by the worker boundary.
    const submission = await callTool(
      tools,
      "graph_submit_outcome",
      { graph_id: delivery.graphId, node_id: "solo", outcome_id: "done", credential: "not-the-credential" },
      worker,
    );
    expect(submission).not.toContain(WORKER_TOOL_FORBIDDEN_CODE);

    // THE PARENT'S OWN FACE STILL PASSES, with the same tool and a real graph.
    const parentDeclare = JSON.parse(
      await callTool(tools, "graph_declare", { declaration: OTHER }, parent),
    ) as { persisted: boolean; start: { kind: string } };
    expect(parentDeclare.persisted).toBe(true);
    expect(parentDeclare.start.kind).toBe("started");
  });
});

// ── Ends are not completions ────────────────────────────────────────────────

describe("opencode graph host — an end is never a completion", () => {
  it("records a wait-reported end and settles nothing through it", async () => {
    const session = makeSession();
    const { host, workspace } = openHost(session, { sessionEndFeed: true });
    const tools = host.createTools();
    const parent = makeContext("session-parent", "agent.parent", workspace);
    const delivery = await declareAndDeliver(host, session, workspace);

    // The platform's own wait is the completion channel this host armed; the
    // watch port answers `watching` because there IS something to look at.
    expect(host.watchCompletion(awaiting(delivery.workerSession), () => {})).toBe("watching");
    session.endTurn(delivery.workerSession);
    await waitFor(
      () => host.observeExecution({ executionId: delivery.workerSession }).kind === "completed",
      "the wait-reported end",
    );
    await settleWindow();

    // AN END IS NOT AN OUTCOME: no submission arrived, so the plan settled
    // nothing and the node is still dispatched.
    const status = await readStatus(tools, delivery.graphId, parent);
    expect(nodeOf(status, "solo").status).toBe("dispatched");
    expect(nodeOf(status, "solo").outcomeId).toBeUndefined();
    expect(status.phase).not.toBe("complete");
  });

  it("answers an errored end with failure and never a successful settlement", async () => {
    const session = makeSession();
    const { host, workspace } = openHost(session, { sessionEndFeed: true });
    const tools = host.createTools();
    const parent = makeContext("session-parent", "agent.parent", workspace);
    const delivery = await declareAndDeliver(host, session, workspace);

    host.noteSessionEnded(delivery.workerSession, "errored");
    const observation = host.observeExecution({ executionId: delivery.workerSession });
    expect(observation.kind).toBe("failed");
    if (observation.kind !== "failed") throw new Error("fixture: expected a failed reading");
    expect(observation.reason).toContain("session.error");

    // The completion bridge this end triggers cannot round it into an outcome.
    // `kind: "settled"` only means the bridge HANDED the completion fact over
    // (src/graph/host/completion-bridge.ts:167-172); the settlement's own answer
    // is the plan's, and an explicit-completion node pins no natural mapping, so
    // it is REFUSED and nothing is written. The same call is asked directly here
    // so the report is deterministic.
    const report = await host.host.complete(delivery.graphId, "solo#1");
    if (report.kind !== "settled") {
      throw new Error("fixture: the bridge did not hand the completion over (" + report.kind + ")");
    }
    expect(report.settlement.kind).toBe("refused");
    await settleWindow();

    const status = await readStatus(tools, delivery.graphId, parent);
    expect(nodeOf(status, "solo").status).toBe("dispatched");
    expect(nodeOf(status, "solo").outcomeId).toBeUndefined();
  });
});

// ── Explicit degradation ────────────────────────────────────────────────────

describe("opencode graph host — explicit degradation", () => {
  it("answers unsupported, unknown and never completed when the platform cannot tell", async () => {
    const session = makeSession({ noWait: true, noStatus: true, noInterrupt: true });
    const { host } = openHost(session, { sessionEndFeed: false });

    // No wait and no session-end feed: nothing can watch this execution.
    expect(host.watchCompletion(awaiting("ses_unwatched"), () => {})).toBe("unsupported");
    // No status call at all: the read names the missing call.
    const unknown = host.observeExecution({ executionId: "ses_unread" });
    expect(unknown.kind).toBe("unknown");
    if (unknown.kind !== "unknown") throw new Error("fixture: expected an unknown reading");
    expect(unknown.reason).toContain("no session status read");

    // The notes say which capabilities were degraded, one line each.
    const notes = host.platformNotes.join(" | ");
    expect(notes).toContain("completion channel: NONE");
    expect(notes).toContain("observeExecution read: none");
    expect(notes).toContain("cancel port: NOT installed");
  });

  it("keeps an event-fed host watching when it has no wait call", () => {
    const { host } = openHost(makeSession({ noWait: true }), { sessionEndFeed: true });
    expect(host.watchCompletion(awaiting("ses_event_fed"), () => {})).toBe("watching");
    // An end already recorded is answered `watching` and the callback is
    // delivered on a microtask, not synchronously.
    const seen: string[] = [];
    host.noteSessionEnded("ses_event_fed", "ended");
    expect(host.watchCompletion(awaiting("ses_event_fed"), () => seen.push("ended"))).toBe("watching");
    expect(seen).toEqual([]);
    return Promise.resolve().then(() => {
      expect(seen).toEqual(["ended"]);
    });
  });

  it("never rounds an idle session into a completion", async () => {
    const session = makeSession({ status: () => Promise.resolve({ state: "idle" }) });
    const { host } = openHost(session, { sessionEndFeed: true });
    // The first question starts the read (this port is synchronous, the read is
    // not) and answers `unknown` — never `completed`.
    expect(host.observeExecution({ executionId: "ses_idle" }).kind).toBe("unknown");
    await settleWindow();
    const reading = host.observeExecution({ executionId: "ses_idle" });
    expect(reading.kind).toBe("unknown");
    if (reading.kind !== "unknown") throw new Error("fixture: expected an unknown reading");
    expect(reading.reason).toContain("idle");
    expect(reading.reason).toContain("NOT that the attempt reached a declared outcome");
  });

  it("reports a busy status as running and a missing status as unknown", async () => {
    const busy = openHost(makeSession({ status: () => Promise.resolve({ state: "busy" }) }), { sessionEndFeed: true });
    expect(busy.host.observeExecution({ executionId: "ses_busy" }).kind).toBe("unknown");
    await settleWindow();
    expect(busy.host.observeExecution({ executionId: "ses_busy" }).kind).toBe("running");

    const retry = openHost(makeSession({ status: () => Promise.resolve({ state: "retry" }) }), { sessionEndFeed: true });
    await settleWindow();
    await settleWindow();
    retry.host.observeExecution({ executionId: "ses_retry" });
    await settleWindow();
    expect(retry.host.observeExecution({ executionId: "ses_retry" }).kind).toBe("running");

    const absent = openHost(makeSession({ status: () => Promise.resolve(null) }), { sessionEndFeed: true });
    await settleWindow();
    absent.host.observeExecution({ executionId: "ses_absent" });
    await settleWindow();
    const reading = absent.host.observeExecution({ executionId: "ses_absent" });
    expect(reading.kind).toBe("unknown");
    if (reading.kind !== "unknown") throw new Error("fixture: expected an unknown reading");
    expect(reading.reason).toContain("names no status");
  });

  it("carries the thrown text of a failed status read and settles nothing", async () => {
    const throwing = openHost(
      makeSession({
        status: () => {
          throw new Error("the status surface is gone");
        },
      }),
      { sessionEndFeed: true },
    );
    const thrown = throwing.host.observeExecution({ executionId: "ses_throwing" });
    expect(thrown.kind).toBe("unknown");
    if (thrown.kind !== "unknown") throw new Error("fixture: expected an unknown reading");
    expect(thrown.reason).toContain("the status surface is gone");

    const rejecting = openHost(
      makeSession({ status: () => Promise.reject(new Error("the status read exploded")) }),
      { sessionEndFeed: true },
    );
    expect(rejecting.host.observeExecution({ executionId: "ses_rejecting" }).kind).toBe("unknown");
    await settleWindow();
    const rejected = rejecting.host.observeExecution({ executionId: "ses_rejecting" });
    expect(rejected.kind).toBe("unknown");
    if (rejected.kind !== "unknown") throw new Error("fixture: expected an unknown reading");
    expect(rejected.reason).toContain("the status read exploded");
  });
});

// ── The session's own reading ───────────────────────────────────────────────

/**
 * The v1 shape the graph host's port actually reads: the canonical
 * `SessionStatus` map behind `ISessionClient.status`
 * (src/session/types.ts:141-150). Only the member this case reaches is
 * implemented, and the cast is the same documented crossing the other partial
 * fixtures in this file make.
 */
function makeV1StatusClient(status: () => Promise<SessionStatus | null>): ISessionClient {
  return { status } as unknown as ISessionClient;
}

describe("opencode graph host — a session's own activity state and outcome", () => {
  it("reads a FRESH busy/retry event state as running where no read names a state", () => {
    const { host } = openHost(makeSession({ status: () => Promise.resolve(null) }), {
      sessionEndFeed: true,
    });
    // BEFORE: the read names no state and no event has arrived, so the host
    // cannot tell — `unknown`, never `running` and never `completed`.
    const before = host.observeExecution({ executionId: "ses_event_state" });
    expect(before.kind).toBe("unknown");

    host.noteSessionStatus("ses_event_state", "busy");
    const busy = host.observeExecution({ executionId: "ses_event_state" });
    expect(busy.kind).toBe("running");

    host.noteSessionStatus("ses_event_state", "retry");
    const retry = host.observeExecution({ executionId: "ses_event_state" });
    expect(retry.kind).toBe("running");
    console.log(
      "observeExecution — event state: before=" + before.kind + " busy=" + busy.kind + " retry=" + retry.kind,
    );
  });

  it("never rounds an idle EVENT state into a completion", () => {
    const { host } = openHost(makeSession({ status: () => Promise.resolve(null) }), {
      sessionEndFeed: true,
    });
    host.noteSessionStatus("ses_event_idle", "idle");
    const reading = host.observeExecution({ executionId: "ses_event_idle" });
    console.log("observeExecution — idle event state: " + reading.kind);
    expect(reading.kind).toBe("unknown");
    if (reading.kind !== "unknown") throw new Error("fixture: expected an unknown reading");
    expect(reading.reason).toContain("idle");
    expect(reading.reason).toContain("NOT that the attempt reached a declared outcome");
  });

  it("reads the session's terminal outcome: succeeded completes, failed and interrupted fail", async () => {
    const succeeded = openHost(
      makeSession({ status: () => Promise.resolve({ state: "idle", outcome: "succeeded" }) }),
      { sessionEndFeed: true },
    );
    // The port is synchronous and the read is not: the FIRST question starts it
    // and answers `unknown`, which is why the reading is asked for again.
    expect(succeeded.host.observeExecution({ executionId: "ses_succeeded" }).kind).toBe("unknown");
    await settleWindow();
    const completed = succeeded.host.observeExecution({ executionId: "ses_succeeded" });

    const failed = openHost(
      makeSession({ status: () => Promise.resolve({ state: "idle", outcome: "failed" }) }),
      { sessionEndFeed: true },
    );
    failed.host.observeExecution({ executionId: "ses_failed" });
    await settleWindow();
    const failure = failed.host.observeExecution({ executionId: "ses_failed" });

    const interrupted = openHost(
      makeSession({ status: () => Promise.resolve({ state: "idle", outcome: "interrupted" }) }),
      { sessionEndFeed: true },
    );
    interrupted.host.observeExecution({ executionId: "ses_interrupted" });
    await settleWindow();
    const stopped = interrupted.host.observeExecution({ executionId: "ses_interrupted" });

    console.log(
      "observeExecution — terminal outcome: succeeded=" +
        completed.kind +
        " failed=" +
        failure.kind +
        " interrupted=" +
        stopped.kind,
    );
    expect(completed.kind).toBe("completed");
    expect(failure.kind).toBe("failed");
    expect(stopped.kind).toBe("failed");
    if (failure.kind !== "failed" || stopped.kind !== "failed") {
      throw new Error("fixture: expected two failed readings");
    }
    // THE PLATFORM'S OWN WORD IS CARRIED, and a failure is never a settlement.
    expect(failure.reason).toContain("failed");
    expect(stopped.reason).toContain("interrupted");
    expect(stopped.reason).not.toContain("settled");
  });

  it("reports a session that ends with a failing outcome as a FAILED attempt", async () => {
    const session = makeSession({
      status: () => Promise.resolve({ state: "idle", outcome: "failed" }),
    });
    const { host, workspace } = openHost(session, {
      sessionEndFeed: true,
      sessionOutcomeRead: true,
    });
    const tools = host.createTools();
    const parent = makeContext("session-parent", "agent.parent", workspace);
    const delivery = await declareAndDeliver(host, session, workspace);
    // The platform's reading is a FAILURE, not a completion — idle alone would
    // be neither.
    expect(host.observeExecution({ executionId: delivery.workerSession }).kind).not.toBe("completed");

    host.noteSessionEnded(delivery.workerSession, "ended");

    // THE CONTROL-VISIBLE FACT: a `failure` decision recorded on THIS attempt,
    // carrying the platform's own word. Nothing here is read off private state.
    const decided = await waitForStatus(
      (reading) => (reading.decisions ?? []).some((decision) => decision.command === "failure"),
      tools,
      delivery.graphId,
      parent,
      "the failure decision for the ended session",
    );
    const decision = (decided.decisions ?? []).find((entry) => entry.command === "failure");
    if (decision === undefined) throw new Error("fixture: no failure decision was recorded");
    console.log(
      "graph_status decision after a failed outcome end: " + JSON.stringify(decision),
    );
    expect(decision.nodeId).toBe("solo");
    expect(decision.attemptId).toBe("solo#1");
    expect(decision.reason).toContain("failed");
    // A FAILED ATTEMPT IS NOT A SETTLED NODE: the failure ends the attempt and
    // the node stays visible, with no outcome ever invented for it.
    expect(nodeOf(decided, "solo").status).toBe("dispatched");
    expect(nodeOf(decided, "solo").outcomeId).toBeUndefined();
    // The dispatch effect was CLAIMED by the failure instead of being left for a
    // completion that never came.
    expect((decided.unsettled_effects ?? []).map((effect) => effect.effectId)).not.toContain(
      "dispatch:solo#1",
    );
  });

  it("keeps the completion path — and records no failure — for a normal end", async () => {
    const session = makeSession();
    const { host, workspace } = openHost(session, {
      sessionEndFeed: true,
      sessionOutcomeRead: true,
    });
    const tools = host.createTools();
    const parent = makeContext("session-parent", "agent.parent", workspace);
    const delivery = await declareAndDeliver(host, session, workspace);

    // THE PLATFORM'S OWN TURN-END SIGNAL (v2's `ctx.session.wait`), not a
    // synthesized end.
    session.endTurn(delivery.workerSession);
    await waitFor(
      () => host.observeExecution({ executionId: delivery.workerSession }).kind === "completed",
      "the observed end",
    );
    await settleWindow();

    const status = await readStatus(tools, delivery.graphId, parent);
    console.log(
      "graph_status after a normal end: decisions=" +
        JSON.stringify(status.decisions ?? []) +
        " effects=" +
        JSON.stringify((status.unsettled_effects ?? []).map((effect) => effect.effectId)),
    );
    // NO FAILURE DECISION: the end went down the completion path, whose result is
    // the PLAN's — an explicit-completion node refuses it (pinned by the cases
    // above), so nothing is settled and nothing is invented.
    expect((status.decisions ?? []).filter((entry) => entry.command === "failure")).toEqual([]);
    expect(nodeOf(status, "solo").status).toBe("dispatched");
    expect(nodeOf(status, "solo").outcomeId).toBeUndefined();
    // The dispatch effect is still awaiting a settlement nobody claimed.
    expect((status.unsettled_effects ?? []).map((effect) => effect.effectId)).toContain(
      "dispatch:solo#1",
    );
  });

  it("keeps v1 state-only: a canonical status yields a state and never an outcome", async () => {
    // THE v1 SDK's `Session` HAS NO TERMINAL OUTCOME
    // (node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:465-492 — id,
    // projectID, directory, parentID, summary, share, title, version, time,
    // revert), so v1 stays state-only and nothing here invents an outcome.
    const port = opencodeGraphSessionPort(
      makeV1StatusClient(() => Promise.resolve<SessionStatus>({ type: "busy" })),
    );
    const reading = await port.status?.({ sessionID: "ses_v1" });
    console.log("v1 port reading: " + JSON.stringify(reading));
    expect(reading).toEqual({ state: "busy" });
    expect(reading !== null && reading !== undefined && "outcome" in reading).toBe(false);

    // THE ONE READER BOTH ENTRIES SHARE reads v1's own payload shape
    // (`properties.status` = `{ type: "busy" } | { type: "retry", … } |
    // { type: "idle" }`, …/sdk/dist/gen/types.gen.d.ts:406-412) and ignores
    // anything else, so an unrecognised state changes nothing.
    expect(opencodeSessionStatusState({ type: "idle" })).toBe("idle");
    expect(opencodeSessionStatusState({ type: "retry", attempt: 1, message: "m", next: 2 })).toBe(
      "retry",
    );
    expect(opencodeSessionStatusState({ type: "something-new" })).toBeUndefined();
    expect(opencodeSessionStatusState(undefined)).toBeUndefined();

    // AND THE HOST READS THAT STATE AS RUNNING — never `completed`, which no v1
    // read could justify.
    const { host } = openHost(makeSession({ status: () => Promise.resolve(reading ?? null) }), {
      sessionEndFeed: true,
    });
    host.observeExecution({ executionId: "ses_v1" });
    await settleWindow();
    const observed = host.observeExecution({ executionId: "ses_v1" });
    console.log("v1 observeExecution with a busy status: " + observed.kind);
    console.log("v1 platformNotes (observation): " + host.platformNotes[1]);
    expect(observed.kind).toBe("running");
    expect(host.platformNotes.join(" | ")).toContain("no terminal-outcome read is installed");
  });
});

// ── Cancel ──────────────────────────────────────────────────────────────────

describe("opencode graph host — a cancel is requested, never confirmed", () => {
  it("answers unsupported when there is no interrupt or no execution to name", async () => {
    const { host } = openHost(makeSession({ noInterrupt: true }), { sessionEndFeed: true });
    const noInterrupt = await host.cancelExecution.cancel(cancelProbe("ses_worker"));
    expect(noInterrupt.kind).toBe("unsupported");
    expect(noInterrupt.reason).toContain("no interrupt call");
    // Nothing is addressable without a confirmed execution.
    const noExecution = await host.cancelExecution.cancel(cancelProbe());
    expect(noExecution.kind).toBe("unsupported");
    expect(noExecution.reason).toContain("no confirmed session");
  });

  it("answers unsupported when the platform reported nothing stopped", async () => {
    const session = makeSession({ interrupt: () => Promise.resolve(false) });
    const { host } = openHost(session, { sessionEndFeed: true });
    const answer = await host.cancelExecution.cancel(cancelProbe("ses_worker"));
    expect(answer.kind).toBe("unsupported");
    expect(answer.reason).toContain("was NOT stopped");
    expect(session.interrupted).toEqual(["ses_worker"]);
  });

  it("answers requested — never confirmed — when the platform accepted the interrupt", async () => {
    const session = makeSession({ interrupt: () => Promise.resolve(true) });
    const { host } = openHost(session, { sessionEndFeed: true });
    const answer = await host.cancelExecution.cancel(cancelProbe("ses_worker"));
    expect(answer.kind).toBe("requested");
    expect(answer.reason).toContain("transition and not a substantiated state");
    expect(session.interrupted).toEqual(["ses_worker"]);
  });

  it("answers unsupported with the thrown text when the interrupt throws", async () => {
    const session = makeSession({
      interrupt: () => Promise.reject(new Error("the control plane is unreachable")),
    });
    const { host } = openHost(session, { sessionEndFeed: true });
    const answer = await host.cancelExecution.cancel(cancelProbe("ses_worker"));
    expect(answer.kind).toBe("unsupported");
    expect(answer.reason).toContain("the control plane is unreachable");
  });
});

// ── A delivery that created nothing ─────────────────────────────────────────

describe("opencode graph host — a failed delivery settles nothing", () => {
  it("keeps the attempt unsettled and visible when create answers null", async () => {
    const session = makeSession({ create: () => Promise.resolve(null) });
    const { host, workspace } = openHost(session, { sessionEndFeed: true });
    const tools = host.createTools();
    const parent = makeContext("session-parent", "agent.parent", workspace);
    const declared = JSON.parse(
      await callTool(tools, "graph_declare", { declaration: SINGLE }, parent),
    ) as { persisted: boolean; start: { kind: string }; graph_id: string };
    expect(declared.start.kind).toBe("started");
    await waitFor(() => session.createCalls.length === 1, "the create attempt");
    await settleWindow();

    // Nothing was created, so nothing was prompted and nothing confirmed.
    expect(session.prompts).toEqual([]);
    const status = await readStatus(tools, declared.graph_id, parent);
    expect(nodeOf(status, "solo").status).not.toBe("settled");
    expect(nodeOf(status, "solo").outcomeId).toBeUndefined();
    // The effect stays VISIBLE and unsettled: `reportDeliveryFailure` keeps the
    // create right (it proves nothing about whether the platform created one).
    expect(
      (status.unsettled_effects ?? []).map((effect) => effect.effectId),
    ).toContain("dispatch:solo#1");
  });

  it("keeps the attempt unsettled and visible when create rejects", async () => {
    const session = makeSession({
      create: () => Promise.reject(new Error("the transport is down")),
    });
    const { host, workspace } = openHost(session, { sessionEndFeed: true });
    const tools = host.createTools();
    const parent = makeContext("session-parent", "agent.parent", workspace);
    const declared = JSON.parse(
      await callTool(tools, "graph_declare", { declaration: SINGLE }, parent),
    ) as { start: { kind: string }; graph_id: string };
    expect(declared.start.kind).toBe("started");
    await waitFor(() => session.createCalls.length === 1, "the rejected create");
    await settleWindow();

    expect(session.prompts).toEqual([]);
    const status = await readStatus(tools, declared.graph_id, parent);
    expect(nodeOf(status, "solo").status).not.toBe("settled");
    expect(
      (status.unsettled_effects ?? []).map((effect) => effect.effectId),
    ).toContain("dispatch:solo#1");
  });
});

// ── The declaring session's wake-up channel ─────────────────────────────────

/** One prompt the wake-up channel received — the run-notification itself. */
interface NotifiedPrompt {
  readonly sessionID: string;
  readonly text: string;
  readonly agent?: string;
  readonly noReply?: boolean;
}

interface FakeNotifyClient {
  /** The `Pick<ISessionClient, "prompt">` the host installs the channel over. */
  readonly client: Pick<ISessionClient, "prompt">;
  /** Every prompt this channel was asked for, in order. */
  readonly prompts: NotifiedPrompt[];
}

/**
 * The declaring session's wake-up channel, as BOTH entries supply one: the
 * shipped `createGraphNotificationSender` (src/platform/graph-notifications.ts:4-17)
 * calls `prompt(sessionId, { parts, noReply: false })` and reads
 * `result !== null` as delivered, so a recording prompt is the whole observation
 * this channel needs.
 *
 * `result` defaults to an accepted prompt; `null` is the platform REJECTING the
 * send — the answer the sender must report as `false` so the effect is retried.
 */
function makeNotifyClient(result: { id: string } | null = { id: "inbox_1" }): FakeNotifyClient {
  const prompts: NotifiedPrompt[] = [];
  return {
    prompts,
    client: {
      prompt: async (id, options) => {
        prompts.push({
          sessionID: id,
          text: options.parts.map((part) => part.text).join("\n"),
          ...(options.agent === undefined ? {} : { agent: options.agent }),
          ...(options.noReply === undefined ? {} : { noReply: options.noReply }),
        });
        return result;
      },
    },
  };
}

/** One durable `graph-notification` effect row, as the host's store holds it. */
interface NotificationEffect {
  readonly graph_id: string;
  readonly effect_id: string;
  readonly status: string;
  readonly payload: string;
}

/**
 * The notification effects the host's own engine wrote, read from the
 * host-owned store (the same shared connection the host and the engine hold).
 *
 * `status` IS THE DELIVERY ANSWER: `done` only after the channel's `send`
 * answered true (`delivered ? "done" : "pending"`,
 * src/graph/application/graph-notifications.ts:276-278), `pending` while a
 * rejected send waits for its retry, with `payload.attempts` counting the tries.
 */
function notificationEffects(workspace: string): NotificationEffect[] {
  const store = GraphStore.openFile(graphStoreRoot(getDataDir(), workspace));
  try {
    return store.all(
      `SELECT graph_id, effect_id, status, payload FROM ${GRAPH_STORE_TABLES.pendingEffects} WHERE kind = 'graph-notification'`,
    ) as unknown as NotificationEffect[];
  } finally {
    store.close();
  }
}

/** The one notification effect a case produced. */
function notificationEffect(workspace: string): NotificationEffect {
  const effects = notificationEffects(workspace);
  if (effects.length !== 1) {
    throw new Error("fixture: expected exactly one notification effect, saw " + String(effects.length));
  }
  return effects[0]!;
}

describe("opencode graph host — the declaring session's wake-up channel", () => {
  it("wakes the DECLARING session with the shipped graph-complete push", async () => {
    const session = makeSession();
    const notify = makeNotifyClient();
    const { host, workspace } = openHost(session, {
      sessionEndFeed: true,
      notifyClient: notify.client,
    });
    const tools = host.createTools();
    const parent = makeContext("session-parent", "agent.parent", workspace);

    // THE CHANNEL IS INSTALLED because the entry supplied a wake-up client, and
    // the host says so in its notes (the fourth line).
    expect(host.application.notifications).toBeDefined();
    expect(host.platformNotes).toHaveLength(4);
    expect(host.platformNotes[3]!).toContain("notification channel: installed");

    const delivery = await declareAndDeliver(host, session, workspace);
    // NOTHING IS PUSHED WHILE THE RUN IS MERELY EXECUTING: the channel speaks at
    // a terminal or attention state, not on every store transaction.
    expect(notify.prompts).toEqual([]);

    const submitted = await submitDone(tools, delivery, workspace);
    expect(submitted.decision).toBe("accepted");
    expect(submitted.verdict).toBe("committed");

    // THE FLUSH IS ASYNCHRONOUS — the run's own completion transaction arms it —
    // so the push is POLLED for with a bounded wait, never slept on.
    await waitFor(() => notify.prompts.length === 1, "the graph-complete push");
    const push = notify.prompts[0]!;
    // The DECLARING session is the target, and the payload is the shipped
    // `<system-reminder>[GRAPH COMPLETE] …</system-reminder>` render.
    expect(push.sessionID).toBe("session-parent");
    expect(push.noReply).toBe(false);
    expect(push.text).toContain("[GRAPH COMPLETE]");
    expect(push.text).toContain(delivery.graphId);
    expect(push.text).toContain("graph_status");
    expect(push.text).toContain("<system-reminder>");
    // NOTHING IS SENT TO THE WORKER SESSION: its delivery prompt travelled the
    // SESSION PORT (the one channel the credential travels over), and the worker
    // was handed exactly that one prompt.
    expect(notify.prompts.map((prompt) => prompt.sessionID)).not.toContain(delivery.workerSession);
    expect(session.prompts.map((prompt) => prompt.sessionID)).toEqual([delivery.workerSession]);

    // THE SEND'S OWN ANSWER: a non-null prompt is `true`, and that is what marks
    // the durable effect `done` after ONE attempt.
    await waitFor(
      () => notificationEffects(workspace).some((effect) => effect.status === "done"),
      "the delivered notification effect",
    );
    const effect = notificationEffect(workspace);
    expect(effect.graph_id).toBe(delivery.graphId);
    expect(JSON.parse(effect.payload).attempts).toBe(1);

    // THE WAKE-UP PAYLOAD, printed: this is what the declaring main agent reads.
    console.log(
      "opencode graph notification text:",
      push.text.replace(/\n/g, " ⏎ ").slice(0, 600),
    );
  });

  it("keeps a REJECTED send pending and retryable without breaking the run or the turn", async () => {
    const session = makeSession();
    // THE PLATFORM REFUSES THE SEND: `prompt` answers null.
    const notify = makeNotifyClient(null);
    const { host, workspace } = openHost(session, {
      sessionEndFeed: true,
      notifyClient: notify.client,
    });
    const tools = host.createTools();
    const parent = makeContext("session-parent", "agent.parent", workspace);
    const delivery = await declareAndDeliver(host, session, workspace);

    // The run itself is untouched by the channel: it completes as it always did.
    const submitted = await submitDone(tools, delivery, workspace);
    expect(submitted.verdict).toBe("committed");

    await waitFor(() => notify.prompts.length >= 1, "the first (rejected) delivery attempt");
    await settleWindow();

    // NOT REPORTED AS DELIVERED: the effect is still `pending`, carries its
    // attempt count and a future retry instant — the sender answered false and
    // the engine did NOT hot-loop on it.
    const effect = notificationEffect(workspace);
    expect(effect.status).toBe("pending");
    const state = JSON.parse(effect.payload) as { attempts: number; retryAt: number };
    expect(state.attempts).toBe(1);
    expect(state.retryAt).toBeGreaterThan(0);
    expect(notify.prompts).toHaveLength(1);

    // NO CRASH AND NO DIFFERENT SETTLEMENT: the run is complete, the host is
    // still usable, and awaiting the engine again neither throws nor re-sends.
    const status = await readStatus(tools, delivery.graphId, parent);
    expect(status.phase).toBe("complete");
    expect(nodeOf(status, "solo").outcomeId).toBe("done");
    expect(host.application.notifications).toBeDefined();
    await host.application.notifications!.flush();
    expect(notify.prompts).toHaveLength(1);
    expect(notificationEffect(workspace).status).toBe("pending");
  });

  it("works with NO wake-up channel and reports the channel as not installed", async () => {
    const session = makeSession();
    // NO `notifyClient`: the host installs no notification channel and still runs.
    const { host, workspace } = openHost(session, { sessionEndFeed: true });
    expect(host.application.notifications).toBeUndefined();

    // FOUR notes, the first three unchanged and in their own order.
    expect(host.platformNotes).toHaveLength(4);
    expect(host.platformNotes[0]!).toContain("completion channel:");
    expect(host.platformNotes[1]!).toContain("observeExecution read:");
    expect(host.platformNotes[2]!).toContain("cancel port:");
    expect(host.platformNotes[3]!).toContain("notification channel: not installed");
    expect(host.platformNotes[3]!).toContain(
      "so a declared graph's terminal state is only visible through graph_status",
    );

    // The absent channel changes nothing about the run: the same graph settles
    // end to end, and no notification effect is ever written.
    const tools = host.createTools();
    const parent = makeContext("session-parent", "agent.parent", workspace);
    const delivery = await declareAndDeliver(host, session, workspace);
    const submitted = await submitDone(tools, delivery, workspace);
    expect(submitted.verdict).toBe("committed");
    const status = await readStatus(tools, delivery.graphId, parent);
    expect(status.phase).toBe("complete");
    expect(notificationEffects(workspace)).toEqual([]);
  });

  it("targets the DECLARING session even when another session merely reads graph_status", async () => {
    const session = makeSession();
    const notify = makeNotifyClient();
    const { host, workspace } = openHost(session, {
      sessionEndFeed: true,
      notifyClient: notify.client,
    });
    const tools = host.createTools();
    const delivery = await declareAndDeliver(host, session, workspace);

    // A THIRD session — neither the declarer nor the dispatched worker — READS
    // the run. The notification target is the graph's recorded invocation origin,
    // so a read can never move it.
    const observer = makeContext("session-observer", "agent.observer", workspace);
    const reading = await readStatus(tools, delivery.graphId, observer);
    expect(reading.phase).not.toBe("complete");
    expect(nodeOf(reading, "solo").status).toBe("dispatched");

    const submitted = await submitDone(tools, delivery, workspace);
    expect(submitted.verdict).toBe("committed");

    await waitFor(() => notify.prompts.length === 1, "the declaring session's push");
    expect(notify.prompts[0]!.sessionID).toBe("session-parent");
    expect(notify.prompts.map((prompt) => prompt.sessionID)).not.toContain("session-observer");
    expect(notify.prompts.map((prompt) => prompt.sessionID)).not.toContain(delivery.workerSession);
    expect(notify.prompts[0]!.text).toContain("[GRAPH COMPLETE]");
  });
});

// ── The v2 session double ───────────────────────────────────────────────────

/**
 * An `ISessionClient` as the v2 entry's adapter implements it: `status` answers
 * null (the documented v2 degradation) and `abort` is the platform interrupt.
 * The REAL `Opencode2SessionAdapter` is covered by
 * tests/platform/opencode2-session.test.ts; this double exists so the v2
 * factory's own wiring (store root, wait passthrough, event feed) is exercised.
 */
function makeV2Client(): {
  readonly client: ISessionClient;
  readonly wait: (input: { sessionID: string }) => Promise<void>;
  readonly prompts: DeliveredPrompt[];
  readonly sessions: string[];
} {
  const prompts: DeliveredPrompt[] = [];
  const sessions: string[] = [];
  const client: ISessionClient = {
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(null),
    messages: () => Promise.resolve([]),
    children: () => Promise.resolve([]),
    todo: () => Promise.resolve([]),
    diff: () => Promise.resolve([]),
    fork: () => Promise.resolve(null),
    status: () => Promise.resolve(null),
    prompt: (id, options) => {
      prompts.push({
        sessionID: id,
        text: options.parts.map((part) => part.text).join("\n"),
        ...(options.agent === undefined ? {} : { agent: options.agent }),
      });
      return Promise.resolve({ id: "inbox_1" });
    },
    promptSync: () => Promise.resolve(null),
    create: (options) => {
      const id = "ses_v2_" + String(sessions.length + 1);
      sessions.push(id);
      return Promise.resolve({
        id,
        projectID: "project",
        directory: options.directory,
        title: "v2 worker",
        version: "1",
        time: { created: 0, updated: 0 },
      });
    },
    abort: () => Promise.resolve(true),
  };
  return {
    client,
    // The v2 turn-end signal, armed by the delivery and resolved by nothing in
    // this case: a wait that resolved on its own would fabricate an end.
    wait: () => new Promise<void>(() => {}),
    prompts,
    sessions,
  };
}
