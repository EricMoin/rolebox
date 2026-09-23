/**
 * P3 cancel — the durable intent, the platform delivery, and the two facts
 *
 * WHAT THIS FILE PROVES BY BEHAVIOUR.
 *
 * 1. `graph_control cancel` records the trusted decision AND the host records a
 *    cancel EFFECT, committed BEFORE the platform is asked anything, so a later
 *    process resumes with the intent visible — pinned by a second host instance
 *    over one store root AND by a REAL child process that dies inside the
 *    platform ask, whose `started` (requested, unconfirmed) request the next
 *    boot re-asks.
 * 2. `requested` and `confirmed` are different facts: only the platform's own
 *    substantiation writes `done` and only it is reported as confirmed. A
 *    platform that cannot answer leaves the execution VISIBLE and unsettled.
 * 3. The races resolve by stated rules: a completion that commits first keeps
 *    its accepted result and no cancel is recorded for it; a cancel that commits
 *    first stops the run, refuses the later submission before the acceptance
 *    core, and never arms the successor; a cancel that commits while an ARMED
 *    successor's create is still in flight names that successor as in-flight,
 *    leaves its execution visible and unsettled, and is delivered by the next
 *    window — never reported as cancelled on the cancel's own say-so; a repeated
 *    cancel replays the decision and never rewinds a confirmed effect.
 * 4. A cancelled run is never re-dispatched by the boot sweep, which instead
 *    DELIVERS the cancel intents a previous process left behind.
 *
 * THE ASSEMBLY IS THE SHIPPED ONE: a real `OutcomeHost` over the workspace's one
 * SQLite store, the real `createGraphToolSet`, and the `graph_control` tool of
 * `createOutcomeGraphTools` wired through the SAME `OutcomeHost.bindTools` +
 * `withCancelDelivery` pair both entries install. The platform is a fake cancel
 * port that answers from the test's script and reads the durable cancel effect
 * back INSIDE the ask — that read is what proves the intent was durable first.
 *
 * STRENGTH: adapter + real store, CROSS-PROCESS for three cases (a REAL child
 * process records the intent and dies at the platform ask; a REAL second process
 * commits a cancel inside a gated submission's window; a REAL second process
 * commits a cancel while an armed successor's create is in flight); the rest is
 * one process. No real dsh/Pi SDK runs in this environment, so nothing here is
 * real-host evidence.
 */

import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import {
  OutcomeHost,
  withCancelDelivery,
} from "../../src/graph/host/outcome-host.ts";
import {
  cancelEffectIdOf,
  type OutcomeExecutionCancelAnswer,
  type OutcomeExecutionCancelProbe,
  type OutcomeExecutionCancellation,
} from "../../src/graph/outcome/cancel.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/dispatch-effects.ts";
import {
  createValidatorRegistry,
  type ValidatorImplementation,
  type ValidatorRegistry,
} from "../../src/graph/outcome/validators.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { GRAPH_STORE_TABLES } from "../../src/graph/store/schema.ts";
import {
  createGraphToolSet,
  type GraphToolSet,
} from "../../src/graph/tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../../src/graph/tools/index.ts";
import type {
  CanonicalToolContext,
  CanonicalToolDef,
} from "../../src/platform/types.ts";
import {
  CANCEL_ASK_MARKER,
  CANCEL_DEATH_EXIT,
  XPROC_CANCEL_GRAPH_ID,
} from "./helpers/cancel-xproc-worker.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const EMPTY_VALIDATORS = createValidatorRegistry([]);

/** The checked-in host-level worker the mid-cancel crash case spawns. */
const CANCEL_XPROC_WORKER = fileURLToPath(
  new URL("./helpers/cancel-xproc-worker.ts", import.meta.url),
);

/** The checked-in STORE-level worker the inverse-race case spawns. */
const XPROC_WORKER = fileURLToPath(
  new URL("./helpers/graph-store-xproc-worker.ts", import.meta.url),
);

/** The one fixed instant the inverse-race worker stamps its decision with. */
const RACE_AT = 1_700_000_000_000;

/** The gate the inverse-race declaration names on `work`'s accepted outcome. */
const INVERSE_RACE_GATE = "gate.cancel-inverse-race";

/** One child process's deadline; a worker that overruns is killed. */
const CANCEL_CHILD_DEADLINE_MS = 30_000;

/**
 * THE HARNESS BUDGET MUST EXCEED THIS FILE'S OWN CHILD DEADLINE (the comment is
 * the same one `graph-store-cross-process.test.ts` carries). Bun's default is
 * 5000ms per test, so a child that was merely SLOW — spawn latency under load, a
 * `busy_timeout` wait on the shared store file — would have the CASE killed and
 * its own diagnosis never written. The budget below lets the child deadline fire
 * first, so what this file reports is always the cancel behaviour.
 */
setDefaultTimeout(CANCEL_CHILD_DEADLINE_MS + 15_000);

/** work -> review: an accepted outcome for `work` arms the `review` attempt. */
const CHAIN: GraphDeclarationV3 = {
  version: 3,
  name: "cancel.chain",
  nodes: [
    { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
    {
      id: "review",
      agent: "agent.review",
      prompt: "Review the work.",
      outcomes: [{ id: "approve" }],
    },
  ],
  edges: [{ from: "work", to: "review", outcome: "done" }],
};

/**
 * A SINGLE entry node: settling it completes the graph, so a cancel issued after
 * the completion finds NOTHING in flight — the case where the completion wins.
 */
const SOLO: GraphDeclarationV3 = {
  version: 3,
  name: "cancel.solo",
  nodes: [
    { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
  ],
  edges: [],
};

/**
 * Two ENTRY nodes: one start leaves TWO attempts in flight at once.
 *
 * The failure-then-cancel case needs both: the first attempt carries the
 * failure, and the second is the one a later cancel must still reach.
 */
const TWO_ENTRIES: GraphDeclarationV3 = {
  version: 3,
  name: "cancel.two-entries",
  nodes: [
    { id: "alpha", agent: "agent.alpha", prompt: "Do alpha.", outcomes: [{ id: "done" }] },
    { id: "beta", agent: "agent.beta", prompt: "Do beta.", outcomes: [{ id: "done" }] },
  ],
  edges: [],
};

/**
 * The same chain, with `work`'s accepted outcome behind a DECLARED GATE.
 *
 * The gate is what opens the inverse-race window: acceptance gates run OUTSIDE
 * the acceptance transaction, so the test's own implementation can have a REAL
 * second process commit a CANCEL between the run path's pre-transaction control
 * check and its acceptance transaction — the interleaving in which a stopped run
 * would otherwise still arm its successor.
 */
const GATED_CHAIN: GraphDeclarationV3 = {
  version: 3,
  name: "cancel.inverse-race",
  nodes: [
    {
      id: "work",
      agent: "agent.work",
      prompt: "Do the work.",
      outcomes: [
        { id: "done", acceptance: [{ validator: INVERSE_RACE_GATE, version: 1 }] },
      ],
    },
    {
      id: "review",
      agent: "agent.review",
      prompt: "Review the work.",
      outcomes: [{ id: "approve" }],
    },
  ],
  edges: [{ from: "work", to: "review", outcome: "done" }],
};

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

/** The child session the platform "created" for one attempt (the dsh mapping). */
function childSessionOf(attemptId: string): string {
  return "child-session:" + attemptId;
}

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

/** What the durable rows held at the moment the platform was asked. */
interface CancelAskReading {
  readonly attemptId: string;
  /** The cancel effect's status INSIDE the ask (undefined when none existed). */
  readonly effect: string | undefined;
  /** The run's control command INSIDE the ask. */
  readonly runCommand: string | undefined;
}

interface FakeCancelPort {
  readonly port: OutcomeExecutionCancellation;
  readonly asked: OutcomeExecutionCancelProbe[];
  readonly atAsk: CancelAskReading[];
  answer:
    | OutcomeExecutionCancelAnswer
    | ((probe: OutcomeExecutionCancelProbe) => OutcomeExecutionCancelAnswer);
}

/**
 * A platform cancel port that answers from the test's script and reads the
 * durable cancel effect back through a FRESH connection INSIDE the ask.
 */
function createFakeCancelPort(storeRoot: string): FakeCancelPort {
  const asked: OutcomeExecutionCancelProbe[] = [];
  const atAsk: CancelAskReading[] = [];
  const fake: FakeCancelPort = {
    asked,
    atAsk,
    answer: {
      kind: "requested",
      reason: "the fake platform took the request and cannot confirm it",
    },
    port: Object.freeze({
      cancel: async (probe: OutcomeExecutionCancelProbe) => {
        asked.push(probe);
        let effect: string | undefined;
        let runCommand: string | undefined;
        try {
          const store = GraphStore.openFile(storeRoot);
          try {
            effect = store
              .pendingEffects(probe.effect.graphId)
              .find((row) => row.effectId === cancelEffectIdOf(probe.effect.attemptId))
              ?.status;
            runCommand = store.runs.readRunControl(probe.effect.graphId)?.command;
          } finally {
            store.close();
          }
        } catch {
          // A store the fake cannot read is "no reading", never a guess.
        }
        atAsk.push(Object.freeze({ attemptId: probe.effect.attemptId, effect, runCommand }));
        return typeof fake.answer === "function" ? fake.answer(probe) : fake.answer;
      },
    }),
  };
  return fake;
}

/** One shipped host assembly over a given store root, with a scripted platform. */
async function openHost(options: {
  readonly dir: string;
  readonly storeRoot: string;
  readonly dispatches: OutcomeDispatchRequest[];
  readonly cancelPort?: OutcomeExecutionCancellation;
  readonly confirm?: boolean;
  /** Wire the cancel delivery into the tool face, as both shipped entries do. */
  readonly deliverOnControl?: boolean;
  /** The installed acceptance capabilities, when the fixture declares a gate. */
  readonly validators?: ValidatorRegistry;
  /**
   * Runs INSIDE the host's delivery of one dispatch, after the transaction that
   * committed it and BEFORE the create is acknowledged — the only window in
   * which a cancel can commit while an armed successor's execution does not yet
   * exist. The successor race uses it to commit the command from a REAL second
   * process exactly there.
   */
  readonly beforeCreateConfirmed?: (request: OutcomeDispatchRequest) => void;
}): Promise<{
  readonly host: OutcomeHost;
  readonly toolset: GraphToolSet;
  readonly tools: Record<string, CanonicalToolDef>;
}> {
  const confirm = options.confirm ?? true;
  const validators = options.validators ?? EMPTY_VALIDATORS;
  let host: OutcomeHost | undefined;
  const opened = OutcomeHost.open({
    workspaceDir: options.dir,
    storeRoot: options.storeRoot,
    deliver: (request, effect) => {
      options.dispatches.push(request);
      options.beforeCreateConfirmed?.(request);
      if (confirm) {
        host?.confirmExecution(effect, { executionId: childSessionOf(request.attemptId) });
      }
    },
    validators,
    declareInvocationIdentity: false,
    workerSessionOf: (execution) => execution.executionId,
    ...(options.cancelPort === undefined ? {} : { cancelExecution: options.cancelPort }),
  });
  host = opened;
  const toolset = createGraphToolSet({
    stateDir: options.dir,
    credentialIsolation: opened.credentialIsolation,
    hostIdentity: opened.workerIdentity,
    outcomeDispatch: opened.dispatch,
    outcomeValidators: validators,
    outcomeArtifactRoot: options.dir,
  });
  const raw = createOutcomeGraphTools(toolset);
  return {
    host: opened,
    toolset,
    tools: opened.bindTools(
      options.deliverOnControl === false ? raw : withCancelDelivery(raw, opened),
    ),
  };
}

interface CancelFixture {
  readonly dir: string;
  readonly storeRoot: string;
  readonly host: OutcomeHost;
  readonly toolset: GraphToolSet;
  readonly tools: Record<string, CanonicalToolDef>;
  readonly dispatches: OutcomeDispatchRequest[];
  readonly platform: FakeCancelPort;
  readonly graphId: string;
  readonly contextOf: (sessionID: string, agent: string) => CanonicalToolContext;
}

async function openCancelFixture(
  declaration: GraphDeclarationV3,
  options: {
    readonly confirm?: boolean;
    readonly deliverOnControl?: boolean;
    /**
     * One validator capability the declaration may name as an acceptance gate.
     * It is INSTALLED on both the host and the toolset, as the shipped assembly
     * does, and DECLARED to `graph_declare`, so the compiled plan is executable
     * rather than a draft (the same fixture `tests/graph/control-entry.test.ts`
     * uses for its inverse race).
     */
    readonly gate?: {
      readonly validator: string;
      readonly version: number;
      readonly implementation: ValidatorImplementation;
    };
    /** See {@link openHost}: the window between a committed dispatch and its create. */
    readonly beforeCreateConfirmed?: (request: OutcomeDispatchRequest) => void;
  } = {},
): Promise<CancelFixture> {
  const dir = makeTmpDir("cancel-delivery-");
  const storeRoot = join(dir, "host-store");
  mkdirSync(storeRoot, { recursive: true });
  const dispatches: OutcomeDispatchRequest[] = [];
  const platform = createFakeCancelPort(storeRoot);
  const validators: ValidatorRegistry =
    options.gate === undefined
      ? EMPTY_VALIDATORS
      : createValidatorRegistry([
          {
            id: options.gate.validator,
            version: options.gate.version,
            implementation: options.gate.implementation,
          },
        ]);
  const opened = await openHost({
    dir,
    storeRoot,
    dispatches,
    cancelPort: platform.port,
    validators,
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
    ...(options.deliverOnControl === undefined
      ? {}
      : { deliverOnControl: options.deliverOnControl }),
    ...(options.beforeCreateConfirmed === undefined
      ? {}
      : { beforeCreateConfirmed: options.beforeCreateConfirmed }),
  });
  const fixture: CancelFixture = {
    ...opened,
    dir,
    storeRoot,
    dispatches,
    platform,
    graphId: declaration.name,
    contextOf: (sessionID, agent) => makeContext(sessionID, agent, dir),
  };
  const declared = String(
    await fixture.tools.graph_declare.execute(
      {
        declaration,
        // A gated declaration is only executable when the caller declares the
        // capability it names; an undeclared gate compiles to a DRAFT and
        // `graph_declare` refuses it (never a runtime surprise).
        ...(options.gate === undefined
          ? {}
          : {
              supported_validators: [
                { validator: options.gate.validator, version: options.gate.version },
              ],
            }),
      },
      fixture.contextOf("session.declarer", "agent.declarer"),
    ),
  );
  if (declared.includes("graph_declare failed:")) {
    throw new Error("fixture: graph_declare refused the declaration: " + declared);
  }
  const started = await fixture.host.startDeclaredGraph(declaration.name, {
    sessionId: "session.declarer",
    agent: "agent.declarer",
  });
  if (started.kind !== "started") {
    throw new Error("fixture: the graph did not start (" + started.kind + ")");
  }
  return fixture;
}

// ── Reading the durable rows back ───────────────────────────────────────────

interface DurableRows {
  readonly run: { readonly runId: string } | undefined;
  readonly control: { readonly command: string; readonly reason: string } | undefined;
  readonly decisions: readonly {
    readonly nodeId: string;
    readonly attemptId: string;
    readonly command: string;
    readonly reason: string;
  }[];
  /** Every UNSETTLED effect (pending/started) of the graph. */
  readonly effects: readonly {
    readonly effectId: string;
    readonly attemptId: string;
    readonly kind: string;
    readonly status: string;
  }[];
  /** Every CANCEL effect row, whatever its status (a terminal row included). */
  readonly cancelEffects: readonly {
    readonly effectId: string;
    readonly status: string;
  }[];
  readonly events: readonly { readonly attemptId: string; readonly outcomeId: string }[];
  readonly receipts: number;
}

/** Read the durable rows of one graph with a FRESH connection. */
function readRowsAt(storeRoot: string, graphId: string): DurableRows {
  const store = GraphStore.openFile(storeRoot);
  try {
    return {
      run: store.runs.readRun(graphId),
      control: store.runs.readRunControl(graphId),
      decisions: store.runs.controlDecisions(graphId),
      effects: store.pendingEffects(graphId),
      cancelEffects: store
        .all(
          "SELECT effect_id, status FROM " +
            GRAPH_STORE_TABLES.pendingEffects +
            " WHERE graph_id = ? AND kind = 'cancel' ORDER BY effect_id",
          graphId,
        )
        .map((row) => ({
          effectId: String(row["effect_id"]),
          status: String(row["status"]),
        })),
      events: store.acceptedEvents(graphId),
      receipts:
        store.all(
          "SELECT COUNT(*) AS n FROM " +
            GRAPH_STORE_TABLES.receipts +
            " WHERE graph_id = ?",
          graphId,
        )[0]?.["n"] as number,
    };
  } finally {
    store.close();
  }
}

function readRows(fixture: CancelFixture): DurableRows {
  return readRowsAt(fixture.storeRoot, fixture.graphId);
}

function decisionOf(rows: DurableRows, attemptId: string): DurableRows["decisions"][number] {
  const decision = rows.decisions.find((entry) => entry.attemptId === attemptId);
  if (decision === undefined) throw new Error("fixture: no control decision for " + attemptId);
  return decision;
}

function cancelRowOf(
  rows: DurableRows,
  attemptId: string,
): DurableRows["cancelEffects"][number] | undefined {
  return rows.cancelEffects.find((row) => row.effectId === cancelEffectIdOf(attemptId));
}

/** The credential one dispatched attempt was handed (never printed by a test). */
function credentialOf(fixture: CancelFixture, nodeId: string): string {
  const request = fixture.dispatches.find((candidate) => candidate.nodeId === nodeId);
  if (request === undefined) throw new Error("fixture: no dispatch for node " + nodeId);
  return request.credential;
}

/** Call a bound `graph_control` tool and parse its JSON answer. */
async function controlWith(
  tools: Record<string, CanonicalToolDef>,
  contextOf: (sessionID: string, agent: string) => CanonicalToolContext,
  args: Record<string, unknown>,
  sessionID: string,
  agent = "agent.declarer",
): Promise<Record<string, unknown>> {
  const raw = String(await tools.graph_control.execute(args, contextOf(sessionID, agent)));
  if (raw.startsWith("graph_control failed:")) {
    throw new Error("fixture: graph_control failed: " + raw);
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

function control(
  fixture: CancelFixture,
  args: Record<string, unknown>,
  sessionID: string,
  agent = "agent.declarer",
): Promise<Record<string, unknown>> {
  return controlWith(fixture.tools, fixture.contextOf, args, sessionID, agent);
}

/** Submit `work`'s `done` outcome from the child session the platform created. */
async function submitWork(fixture: CancelFixture): Promise<Record<string, unknown>> {
  const raw = String(
    await fixture.tools.graph_submit_outcome.execute(
      {
        graph_id: fixture.graphId,
        node_id: "work",
        outcome_id: "done",
        credential: credentialOf(fixture, "work"),
      },
      fixture.contextOf(childSessionOf("work#1"), "agent.work"),
    ),
  );
  return JSON.parse(raw) as Record<string, unknown>;
}

/** The refusal codes of one tool answer. */
function refusalCodes(answer: Record<string, unknown>): readonly string[] {
  const refusals = answer["refusals"];
  if (!Array.isArray(refusals)) return [];
  return refusals.map((refusal) => String((refusal as { code?: unknown }).code));
}

/** The persisted state row of one graph, read with a FRESH connection. */
function readStateAt(
  storeRoot: string,
  graphId: string,
): { readonly nodes: readonly Record<string, unknown>[] } {
  const store = GraphStore.openFile(storeRoot);
  try {
    const record = store.readGraphState(graphId);
    const body =
      typeof record?.body === "object" && record.body !== null
        ? (record.body as Record<string, unknown>)
        : undefined;
    const nodes = Array.isArray(body?.["nodes"])
      ? (body["nodes"] as readonly Record<string, unknown>[])
      : [];
    return { nodes };
  } finally {
    store.close();
  }
}

/** The persisted entry of one node, or a fixture error. */
function nodeEntryOf(
  state: { readonly nodes: readonly Record<string, unknown>[] },
  nodeId: string,
): Record<string, unknown> {
  const entry = state.nodes.find((node) => node["nodeId"] === nodeId);
  if (entry === undefined) throw new Error("fixture: no persisted entry for node " + nodeId);
  return entry;
}

// ── The cross-process crash windows ─────────────────────────────────────────

/** What the shared store worker reported when it applied a cancel. */
interface ApplyCancelReport {
  readonly pid: number;
  readonly ok: boolean;
  readonly mode: string;
  readonly verdict?: string;
  readonly runId?: string;
  readonly command?: string;
  readonly nodeId?: string;
  readonly attemptId?: string;
  readonly error?: string;
}

/**
 * Apply ONE CANCEL through a REAL second OS process, SYNCHRONOUSLY.
 *
 * WHY SYNCHRONOUS. The acceptance gate runs outside the acceptance transaction,
 * so the only place a test can commit a command INSIDE that window is a
 * validator — and validation is synchronous by contract. `Bun.spawnSync` starts
 * a second bun process that opens the SAME store with its OWN connection and
 * commits the cancel before this submission's transaction opens: exactly the
 * interleaving the run path's pre-transaction control check cannot see.
 *
 * The command is applied through the STORE, not through a `graph_control` call:
 * the child holds no host and no platform context, and this case is about the
 * RACE, not the permission check (which has its own cases in the control suite).
 * The run identity is still the run path's own — the worker adopts the id the
 * store already holds.
 */
function applyCancelFromAnotherProcess(options: {
  readonly storeRoot: string;
  readonly graphId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly reason: string;
}): ApplyCancelReport {
  const result = Bun.spawnSync(
    [
      process.execPath,
      XPROC_WORKER,
      "--mode",
      "apply-control",
      "--root",
      options.storeRoot,
      "--graph",
      options.graphId,
      "--node",
      options.nodeId,
      "--attempt",
      options.attemptId,
      "--command",
      "cancel",
      "--reason",
      options.reason,
      "--at",
      String(RACE_AT),
      "--session",
      "session.declarer",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("{"))
    .pop();
  if (line === undefined) {
    throw new Error(
      "fixture: the cancel worker printed no JSON result (exit " +
        String(result.exitCode) +
        ", stderr: " +
        stderr.trim() +
        ")",
    );
  }
  return JSON.parse(line) as ApplyCancelReport;
}

/** The reading the dying child wrote from INSIDE its platform ask. */
interface CancelAskReadingOfChild {
  readonly pid: number;
  readonly attemptId: string;
  readonly effect: string | null;
  readonly runCommand: string | null;
}

/**
 * Run the recording worker as a REAL second OS process until it DIES at the
 * platform ask, and return the reading it wrote there.
 *
 * A worker that exits with anything but {@link CANCEL_DEATH_EXIT} is a fixture
 * failure, not a crash window, and is reported with its stderr; a worker that
 * overruns the deadline is killed and reported the same way, so a hang never
 * leaves the suite waiting on a process nothing will finish.
 */
async function runRecordingProcessUntilItDiesAtTheAsk(
  dir: string,
  storeRoot: string,
): Promise<CancelAskReadingOfChild> {
  const proc = Bun.spawn(
    [
      process.execPath,
      CANCEL_XPROC_WORKER,
      "--dir",
      dir,
      "--store",
      storeRoot,
      "--graph",
      XPROC_CANCEL_GRAPH_ID,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = Bun.readableStreamToText(proc.stdout);
  const stderr = Bun.readableStreamToText(proc.stderr);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, CANCEL_CHILD_DEADLINE_MS);
  const code = await proc.exited;
  clearTimeout(timer);
  const [out, err] = await Promise.all([stdout, stderr]);
  if (timedOut) {
    throw new Error(
      "fixture: the recording process did not exit within " +
        String(CANCEL_CHILD_DEADLINE_MS) +
        "ms and was killed — stdout: " +
        out.trim() +
        " stderr: " +
        err.trim(),
    );
  }
  if (code !== CANCEL_DEATH_EXIT) {
    throw new Error(
      "fixture: the recording process did not die at the platform ask (exit " +
        String(code) +
        ", stdout: " +
        out.trim() +
        " stderr: " +
        err.trim() +
        ")",
    );
  }
  return JSON.parse(
    readFileSync(join(dir, CANCEL_ASK_MARKER), "utf8"),
  ) as CancelAskReadingOfChild;
}

// ── The intent and the platform delivery ────────────────────────────────────

describe("graph_control cancel — the durable intent and the platform delivery", () => {
  it("records the intent before the platform is asked, and confirms only what the platform substantiated", async () => {
    const fixture = await openCancelFixture(CHAIN);
    try {
      fixture.platform.answer = {
        kind: "confirmed",
        reason:
          "the fake platform disposed run child-session:work#1 and observed stopReason 'aborted'",
      };

      const answer = await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "the operator stopped it" },
        "session.declarer",
      );
      expect(answer["kind"]).toBe("applied");
      expect((answer["runControl"] as { command?: string }).command).toBe("cancel");

      // ONE ask, for the execution the host recorded — and the durable intent was
      // ALREADY readable when the platform was asked: the run's control fact and a
      // started cancel effect, never a bare promise of one.
      expect(fixture.platform.asked).toHaveLength(1);
      const probe = fixture.platform.asked[0];
      expect(probe?.effect.effectId).toBe("dispatch:work#1");
      expect(probe?.nodeId).toBe("work");
      expect(probe?.execution?.executionId).toBe(childSessionOf("work#1"));
      expect(probe?.reason).toBe("the operator stopped it");
      expect(fixture.platform.atAsk).toEqual([
        { attemptId: "work#1", effect: "started", runCommand: "cancel" },
      ]);

      const rows = readRows(fixture);
      expect(rows.control?.command).toBe("cancel");
      expect(decisionOf(rows, "work#1").command).toBe("cancel");
      // CONFIRMED is a durable fact of its own: the cancel effect is `done`.
      expect(cancelRowOf(rows, "work#1")).toEqual({
        effectId: "cancel:work#1",
        status: "done",
      });
      // The dispatch effect is EXACTLY where the stop found it, and no business
      // success was written by the cancellation.
      expect(rows.effects.map((effect) => effect.effectId)).toEqual(["dispatch:work#1"]);
      expect(rows.events).toEqual([]);
      expect(rows.receipts).toBe(0);

      // A SECOND delivery re-reads the SAME durable fact and does not ask again.
      const replay = await fixture.host.deliverCancelIntents(fixture.graphId);
      expect(replay.entries).toHaveLength(1);
      expect(replay.entries[0]?.state).toBe("confirmed");
      expect(replay.entries[0]?.reason).toContain("previous delivery");
      expect(fixture.platform.asked).toHaveLength(1);
    } finally {
      fixture.host.close();
    }
  });

  it("never reports an unconfirmed cancel as cancelled, and asks again while it stays unconfirmed", async () => {
    const fixture = await openCancelFixture(CHAIN);
    try {
      fixture.platform.answer = {
        kind: "requested",
        reason: "the fake platform handed the dispose on and cannot confirm the run ended",
      };

      const answer = await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "stop it" },
        "session.declarer",
      );
      expect(answer["kind"]).toBe("applied");

      let rows = readRows(fixture);
      // REQUESTED, not confirmed: the effect stays started, so it stays in the
      // resume set and the graph keeps owing that external task.
      expect(cancelRowOf(rows, "work#1")).toEqual({
        effectId: "cancel:work#1",
        status: "started",
      });
      expect(rows.effects.map((effect) => effect.effectId).sort()).toEqual([
        "cancel:work#1",
        "dispatch:work#1",
      ]);
      expect(rows.events).toEqual([]);
      expect(rows.receipts).toBe(0);

      const again = await fixture.host.deliverCancelIntents(fixture.graphId);
      expect(again.entries[0]?.state).toBe("requested");
      expect(again.entries[0]?.reason).toContain("has NOT confirmed it");
      // An unconfirmed request is RE-ASKED; it is never rounded into a cancel.
      expect(fixture.platform.asked).toHaveLength(2);

      rows = readRows(fixture);
      expect(cancelRowOf(rows, "work#1")?.status).toBe("started");
    } finally {
      fixture.host.close();
    }
  });

  it("answers unsupported when the host cannot name an execution, and keeps it visible", async () => {
    // confirm: false leaves the create row `creating`: an external task may exist
    // although the platform never named it, so it can be asked about but not
    // addressed — and the answer must never be "cancelled".
    const fixture = await openCancelFixture(CHAIN, { confirm: false });
    try {
      fixture.platform.answer = (probe) =>
        probe.execution === undefined
          ? {
              kind: "unsupported",
              reason: "the host named no execution, so there is nothing to cancel",
            }
          : { kind: "confirmed", reason: "unreachable in this fixture" };

      const answer = await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "stop it" },
        "session.declarer",
      );
      expect(answer["kind"]).toBe("applied");
      expect(answer["unconfirmedExecutions"]).toHaveLength(1);

      expect(fixture.platform.asked).toHaveLength(1);
      expect(fixture.platform.asked[0]?.execution).toBeUndefined();
      const rows = readRows(fixture);
      expect(cancelRowOf(rows, "work#1")?.status).toBe("started");
      expect(rows.effects.find((effect) => effect.kind === "dispatch")?.status).toBe("started");
      expect(rows.events).toEqual([]);

      // The boot sweep keeps the unconfirmed execution visible AND names the
      // unconfirmed cancel; nothing became a completion.
      const report = await fixture.host.recoverDeclaredGraphs();
      expect(report.controlled).toEqual([fixture.graphId + ":cancel"]);
      expect(report.unconfirmedExecutions).toHaveLength(1);
      expect(report.unconfirmedExecutions[0]).toMatchObject({
        graphId: fixture.graphId,
        attemptId: "work#1",
        state: "creating",
      });
      expect(report.cancellations).toEqual([
        expect.objectContaining({ attemptId: "work#1", state: "unsupported" }),
      ]);
      expect(report.cancellations[0]?.reason).toContain(
        "offers no cancellation surface for this execution",
      );
    } finally {
      fixture.host.close();
    }
  });
});

// ── Deterministic races ─────────────────────────────────────────────────────

describe("graph_control cancel — deterministic races", () => {
  it("never re-labels an attempt that completed first: no cancel decision, effect or platform ask for it", async () => {
    // THE COMPLETION WINS THE ATTEMPT. SOLO has no successor, so once its single
    // entry settles there is nothing in flight: the run can still be stopped,
    // but the settled attempt is never re-labelled and its platform execution is
    // never cancelled.
    const fixture = await openCancelFixture(SOLO);
    try {
      const submitted = await submitWork(fixture);
      expect(submitted["decision"]).toBe("accepted");

      const late = await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "too late for the attempt" },
        "session.declarer",
      );
      expect(late["kind"]).toBe("applied");
      expect(late["decided"]).toEqual([]);
      expect(late["skipped"]).toEqual([]);

      // THE DELIVERY FOLLOWS A DURABLE PER-ATTEMPT DECISION ONLY: none was
      // recorded, so there was no intent to hand anywhere and the platform was
      // never asked about the settled attempt.
      expect(fixture.platform.asked).toEqual([]);

      const rows = readRows(fixture);
      expect(rows.decisions).toEqual([]);
      expect(rows.cancelEffects).toEqual([]);
      expect(rows.events.map((event) => event.outcomeId)).toEqual(["done"]);
      expect(rows.receipts).toBe(1);
      expect(rows.effects.map((effect) => effect.effectId)).toEqual([]);
      // The run's own stop fact is recorded — a cancel with nothing in flight is
      // still a stop — but it carries no attempt and no effect.
      expect(rows.control?.command).toBe("cancel");

      // The persisted node stays COMPLETED: the accepted result is the fact.
      const report = await fixture.host.recoverDeclaredGraphs();
      expect(report.controlled).toEqual([fixture.graphId + ":cancel"]);
      expect(report.cancellations).toEqual([]);
      expect(fixture.platform.asked).toEqual([]);
    } finally {
      fixture.host.close();
    }
  });

  it("stops the run when the cancel commits first, refuses the later submission, and arms no successor", async () => {
    const fixture = await openCancelFixture(CHAIN);
    try {
      fixture.platform.answer = {
        kind: "confirmed",
        reason: "the fake platform confirmed the abort",
      };
      const applied = await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "the operator stopped it" },
        "session.declarer",
      );
      expect(applied["kind"]).toBe("applied");
      const dispatchesBefore = fixture.dispatches.length;

      const refused = await submitWork(fixture);
      expect(refusalCodes(refused)).toEqual(["control-stopped"]);

      const rows = readRows(fixture);
      expect(rows.events).toEqual([]);
      expect(rows.receipts).toBe(0);
      expect(rows.control?.command).toBe("cancel");
      expect(cancelRowOf(rows, "work#1")?.status).toBe("done");
      expect(fixture.dispatches).toHaveLength(dispatchesBefore);

      // The boot sweep REPORTS the stop and never starts a new attempt — and it
      // delivers the confirmed cancel intents once, not once per boot.
      const report = await fixture.host.recoverDeclaredGraphs();
      expect(report.controlled).toEqual([fixture.graphId + ":cancel"]);
      expect(report.cancellations).toEqual([
        expect.objectContaining({ attemptId: "work#1", state: "confirmed" }),
      ]);
      expect(fixture.dispatches).toHaveLength(dispatchesBefore);
      expect(fixture.platform.asked).toHaveLength(1);

      const second = await fixture.host.recoverDeclaredGraphs();
      expect(second.controlled).toEqual([fixture.graphId + ":cancel"]);
      expect(fixture.dispatches).toHaveLength(dispatchesBefore);
      expect(fixture.platform.asked).toHaveLength(1);
    } finally {
      fixture.host.close();
    }
  });

  it("names an armed successor as in-flight when a cancel commits before its create is issued, and never reports it cancelled", async () => {
    // THE SUCCESSOR IS ARMED FIRST — the one interleaving the two stated rules
    // have to settle together. The acceptance transaction commits the dispatch
    // effect, the armed `review` entry and its credential, and only THEN does
    // `launchDispatches` issue the create. A cancel committing in that window
    // finds the successor DISPATCHED in the durable state, so by the one rule
    // ("whichever COMMITS first stands") it is an in-flight attempt the cancel
    // must name — never one it may re-label — while the create the acceptance
    // already committed is issued afterwards. The execution that produces is
    // NOT hidden and NOT reported as cancelled: its effect stays unsettled, and
    // the next delivery window turns the durable intent into the platform ask.
    const holder: { fixture?: CancelFixture } = {};
    const stopped: string[] = [];
    const fixture = await openCancelFixture(CHAIN, {
      beforeCreateConfirmed: (request) => {
        if (request.nodeId !== "review") return;
        const opened = holder.fixture;
        if (opened === undefined) {
          throw new Error("fixture: the successor's create ran before the fixture was bound");
        }
        const report = applyCancelFromAnotherProcess({
          storeRoot: opened.storeRoot,
          graphId: opened.graphId,
          nodeId: request.nodeId,
          attemptId: request.attemptId,
          reason: "the operator stopped the run while the successor was being armed",
        });
        if (!report.ok || report.verdict !== "recorded") {
          throw new Error("fixture: the cancel was not recorded: " + JSON.stringify(report));
        }
        stopped.push(request.attemptId);
      },
    });
    holder.fixture = fixture;
    try {
      fixture.platform.answer = {
        kind: "confirmed",
        reason: "the fake platform confirmed the abort",
      };

      const submitted = await submitWork(fixture);
      expect(submitted["decision"]).toBe("accepted");
      // The cancel committed for the attempt the acceptance armed, from a REAL
      // second process, before that attempt's create was acknowledged.
      expect(stopped).toEqual(["review#2"]);

      const rows = readRows(fixture);
      expect(rows.control?.command).toBe("cancel");
      expect(
        rows.decisions.map((decision) => decision.attemptId + ":" + decision.command),
      ).toEqual(["review#2:cancel"]);
      // NO business result exists for the stopped attempt, and the accepted
      // result the feeder committed is untouched.
      expect(rows.events.map((event) => event.attemptId)).toEqual(["work#1"]);
      expect(rows.receipts).toBe(1);
      // THE CREATE WAS ISSUED (the acceptance committed first) and its effect is
      // still UNSETTLED — the execution stays VISIBLE rather than being dropped
      // to make the stop look converged.
      expect(rows.effects.map((effect) => effect.effectId + ":" + effect.status)).toEqual([
        "dispatch:review#2:started",
      ]);
      // No delivery window has run yet, so no cancel effect exists: the durable
      // CONTROL DECISION is the intent, and it is already committed.
      expect(cancelRowOf(rows, "review#2")).toBeUndefined();

      // THE BOOT SWEEP reports the stop, dispatches NOTHING new, and hands the
      // durable intent over with the execution id the host now holds.
      const dispatchesBefore = fixture.dispatches.length;
      const report = await fixture.host.recoverDeclaredGraphs();
      expect(report.controlled).toEqual([fixture.graphId + ":cancel"]);
      expect(report.cancellations).toEqual([
        expect.objectContaining({ attemptId: "review#2", state: "confirmed" }),
      ]);
      expect(fixture.platform.asked).toHaveLength(1);
      expect(fixture.platform.asked[0]?.effect.attemptId).toBe("review#2");
      expect(fixture.platform.asked[0]?.execution?.executionId).toBe(childSessionOf("review#2"));
      expect(fixture.dispatches).toHaveLength(dispatchesBefore);
      const after = readRows(fixture);
      expect(cancelRowOf(after, "review#2")?.status).toBe("done");
      expect(after.events.map((event) => event.attemptId)).toEqual(["work#1"]);
      expect(after.control?.command).toBe("cancel");
    } finally {
      fixture.host.close();
    }
  });

  it("still delivers the cancel for the OTHER in-flight attempt after a failure already stopped the run", async () => {
    // TWO ENTRY ATTEMPTS, NEITHER CONFIRMED and neither settled. A `failure` on
    // alpha stops the run but leaves alpha's attempt DISPATCHED (by design), so a
    // later run-wide cancel must not be refused by the fact alpha already carries:
    // beta's external execution is the one the plan's cancel clause still owes.
    const fixture = await openCancelFixture(TWO_ENTRIES, { confirm: false });
    try {
      fixture.platform.answer = {
        kind: "confirmed",
        reason: "the fake platform confirmed the abort",
      };

      const failed = await control(
        fixture,
        {
          graph_id: fixture.graphId,
          command: "failure",
          node_id: "alpha",
          reason: "alpha's execution ended",
        },
        "session.declarer",
      );
      expect(failed["kind"]).toBe("applied");
      // A failure is NOT a cancel: nothing is handed to the platform.
      expect(fixture.platform.asked).toEqual([]);

      const cancelled = await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "stop the rest" },
        "session.declarer",
      );
      expect(cancelled["kind"]).toBe("applied");
      // The intent is recorded for the attempt that carries NO fact yet...
      expect(
        (cancelled["decided"] as readonly { readonly attemptId: string }[]).map(
          (entry) => entry.attemptId,
        ),
      ).toEqual(["beta#2"]);
      // ...and the failed one is a SKIPPED target, not an error.
      expect(
        (cancelled["skipped"] as readonly { readonly attemptId: string; readonly code?: string }[])[0],
      ).toMatchObject({ attemptId: "alpha#1", code: "control-already-decided" });
      expect((cancelled["runControl"] as { readonly command?: string }).command).toBe("failure");

      // THE PLATFORM ASK GOES TO BETA — the execution the stop still owes. Alpha
      // is never re-labelled and is never asked about.
      expect(fixture.platform.asked).toHaveLength(1);
      expect(fixture.platform.asked[0]?.effect.attemptId).toBe("beta#2");
      expect(fixture.platform.atAsk).toEqual([
        { attemptId: "beta#2", effect: "started", runCommand: "failure" },
      ]);

      const rows = readRows(fixture);
      expect(rows.control?.command).toBe("failure");
      expect(
        rows.decisions.map((decision) => decision.attemptId + ":" + decision.command).sort(),
      ).toEqual(["alpha#1:failure", "beta#2:cancel"]);
      expect(cancelRowOf(rows, "beta#2")).toEqual({ effectId: "cancel:beta#2", status: "done" });
      expect(cancelRowOf(rows, "alpha#1")).toBeUndefined();
      // No business success was written by either command.
      expect(rows.events).toEqual([]);
      expect(rows.receipts).toBe(0);
    } finally {
      fixture.host.close();
    }
  });

  it("refuses an in-flight submission when a cancel commits in ANOTHER PROCESS while its gate runs, and arms no successor", async () => {
    // The gate needs the fixture's store root, and the fixture needs the gate to
    // build its host: the holder is filled as soon as the fixture exists, and the
    // implementation runs only when a submission is validated.
    const race: { fixture?: CancelFixture; child?: ApplyCancelReport } = {};
    const fixture = await openCancelFixture(GATED_CHAIN, {
      gate: {
        validator: INVERSE_RACE_GATE,
        version: 1,
        implementation: (request) => {
          const opened = race.fixture;
          if (opened === undefined) {
            throw new Error("fixture: the inverse-race fixture was not bound before the gate ran");
          }
          const child = applyCancelFromAnotherProcess({
            storeRoot: opened.storeRoot,
            graphId: request.identity.graphId,
            nodeId: "work",
            attemptId: request.identity.attemptId,
            reason: "the operator stopped the run while the gate was running",
          });
          race.child = child;
          if (child.verdict !== "recorded") {
            throw new Error(
              "fixture: the second process did not record the cancel: " + JSON.stringify(child),
            );
          }
          return { kind: "pass" };
        },
      },
    });
    race.fixture = fixture;
    try {
      const dispatchesBefore = fixture.dispatches.length;
      const refused = await submitWork(fixture);

      // THE INVERSE RACE, FOR THE CANCEL COMMAND. The run's control fact
      // committed while the gate ran — AFTER the run path's pre-transaction
      // control check and BEFORE its acceptance transaction. Without the
      // in-transaction re-read the cancelled run would commit a business success
      // and arm `review`; the answer is the same named refusal a cancel that
      // commits before the gate produces.
      expect(refusalCodes(refused)).toEqual(["control-stopped"]);
      expect(race.child?.command).toBe("cancel");
      expect(race.child?.attemptId).toBe("work#1");

      const rows = readRows(fixture);
      expect(rows.control?.command).toBe("cancel");
      // The second process recorded the decision against THE RUN the run path
      // minted: it adopted the stored identity instead of minting a second one.
      expect(race.child?.runId).toBe(rows.run?.runId);
      expect(decisionOf(rows, "work#1").command).toBe("cancel");
      expect(rows.events).toEqual([]);
      expect(rows.receipts).toBe(0);

      // The successor was never armed and no new attempt was dispatched. The
      // intent is durable, but the refusal handed nothing to the platform: no
      // cancel effect exists yet and the platform was not asked.
      expect(fixture.dispatches).toHaveLength(dispatchesBefore);
      expect(
        nodeEntryOf(readStateAt(fixture.storeRoot, fixture.graphId), "review"),
      ).toMatchObject({ status: "pending" });
      expect(rows.cancelEffects).toEqual([]);
      expect(fixture.platform.asked).toEqual([]);

      // THE ROLLBACK LEFT NO TRACE OF THE SUCCESSOR. The join runs the reducer —
      // which mints `review`'s credential record inside the SAME transaction —
      // before the batch would be written, so a rule that merely DECLINED to
      // write the batch would still commit that minted record. The refusal
      // THROWS instead, so the only credential row the store holds is the one the
      // START transaction wrote for the attempt already in flight.
      const credentials = GraphStore.openFile(fixture.storeRoot);
      try {
        expect(
          credentials
            .all(
              "SELECT attempt_id FROM host_attempt_credentials WHERE graph_id = ? ORDER BY attempt_id",
              fixture.graphId,
            )
            .map((row) => row["attempt_id"]),
        ).toEqual(["work#1"]);
      } finally {
        credentials.close();
      }
    } finally {
      fixture.host.close();
    }
  });

  it("replays a repeated cancel and never rewinds the confirmed effect", async () => {
    const fixture = await openCancelFixture(CHAIN);
    try {
      fixture.platform.answer = {
        kind: "confirmed",
        reason: "the fake platform confirmed the abort",
      };
      const first = await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "first reason" },
        "session.declarer",
      );
      expect(first["kind"]).toBe("applied");

      const second = await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "second reason" },
        "session.declarer",
      );
      expect(second["kind"]).toBe("applied");
      const decided = second["decided"] as readonly { readonly replayed: boolean }[];
      expect(decided[0]?.replayed).toBe(true);
      // The run keeps the command that stopped it FIRST.
      expect((second["runControl"] as { reason?: string }).reason).toBe("first reason");

      // An already-confirmed cancel is not asked again: the platform is not
      // re-asked for a fact the store already holds.
      expect(fixture.platform.asked).toHaveLength(1);
      const rows = readRows(fixture);
      expect(rows.control?.reason).toBe("first reason");
      expect(cancelRowOf(rows, "work#1")?.status).toBe("done");
    } finally {
      fixture.host.close();
    }
  });

  it("never reads a terminal cancel effect this build does not write as a confirmation", async () => {
    const fixture = await openCancelFixture(CHAIN);
    try {
      fixture.platform.answer = {
        kind: "requested",
        reason: "the fake platform cannot confirm the run ended",
      };
      await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "stop it" },
        "session.declarer",
      );

      // A FOREIGN writer settles the cancel effect as `failed` — a state this
      // build never writes for a cancel.
      const store = GraphStore.openFile(fixture.storeRoot);
      try {
        const verdict = store.markEffectFailed(fixture.graphId, cancelEffectIdOf("work#1"));
        expect(verdict.kind).toBe("transitioned");
      } finally {
        store.close();
      }

      const report = await fixture.host.deliverCancelIntents(fixture.graphId);
      expect(report.entries).toHaveLength(1);
      // The platform is asked again (the external task may still run), the foreign
      // terminal row is NOT read as a confirmation, and it is reported by name.
      expect(fixture.platform.asked).toHaveLength(2);
      expect(report.entries[0]?.state).toBe("requested");
      expect(report.entries[0]?.reason).toContain("terminal 'failed'");

      const rows = readRows(fixture);
      expect(rows.cancelEffects).toEqual([{ effectId: "cancel:work#1", status: "failed" }]);
      expect(rows.effects.map((effect) => effect.effectId)).toEqual(["dispatch:work#1"]);
    } finally {
      fixture.host.close();
    }
  });
});

// ── A crash mid-cancel, and the worker boundary ─────────────────────────────

describe("graph_control cancel — the window before delivery, and the worker boundary", () => {
  it("resumes with the intent visible after the recording host instance ends before delivery, and delivers it on the next boot", async () => {
    const dir = makeTmpDir("cancel-restart-");
    const storeRoot = join(dir, "host-store");
    mkdirSync(storeRoot, { recursive: true });
    const contextOf = (sessionID: string, agent: string) => makeContext(sessionID, agent, dir);

    // INSTANCE A: no cancel port and no delivery wiring — the window between the
    // durable decision and the platform call, at the point a process would die.
    // The crash is NOT driven here: this case closes one host instance and opens
    // another over the same store root IN ONE PROCESS (the file header says so).
    // What it pins is the ORDER — the intent is durable before any platform call
    // and the next boot delivers it — not a process boundary.
    const firstDispatches: OutcomeDispatchRequest[] = [];
    const a = await openHost({ dir, storeRoot, dispatches: firstDispatches, deliverOnControl: false });
    try {
      const declared = String(
        await a.tools.graph_declare.execute({ declaration: CHAIN }, contextOf("session.declarer", "agent.declarer")),
      );
      expect(declared.includes("graph_declare failed:")).toBe(false);
      const started = await a.host.startDeclaredGraph(CHAIN.name, {
        sessionId: "session.declarer",
        agent: "agent.declarer",
      });
      expect(started.kind).toBe("started");

      const answer = await controlWith(
        a.tools,
        contextOf,
        { graph_id: CHAIN.name, command: "cancel", reason: "the operator stopped it" },
        "session.declarer",
      );
      expect(answer["kind"]).toBe("applied");

      // THE INTENT IS DURABLE...
      const rows = readRowsAt(storeRoot, CHAIN.name);
      expect(rows.control?.command).toBe("cancel");
      expect(decisionOf(rows, "work#1").command).toBe("cancel");
      // ...and NO cancel effect exists: this host never reached a platform.
      expect(rows.cancelEffects).toEqual([]);
      // The unconfirmed external task is still named by the run path's own answer.
      expect(answer["unsettledEffects"]).toBeDefined();
    } finally {
      a.host.close();
    }

    // INSTANCE B: the same store root, with the platform cancel port installed.
    const platform = createFakeCancelPort(storeRoot);
    platform.answer = {
      kind: "confirmed",
      reason: "the fake platform confirmed the abort after the restart",
    };
    const secondDispatches: OutcomeDispatchRequest[] = [];
    const b = await openHost({
      dir,
      storeRoot,
      dispatches: secondDispatches,
      cancelPort: platform.port,
    });
    try {
      const report = await b.host.recoverDeclaredGraphs();
      expect(report.controlled).toEqual([CHAIN.name + ":cancel"]);
      // The intent the previous host instance left behind is DELIVERED, and the
      // report says which fact the delivery established.
      expect(report.cancellations).toEqual([
        expect.objectContaining({ attemptId: "work#1", state: "confirmed" }),
      ]);
      expect(platform.asked).toHaveLength(1);
      expect(platform.asked[0]?.execution?.executionId).toBe(childSessionOf("work#1"));
      expect(platform.atAsk[0]).toEqual({
        attemptId: "work#1",
        effect: "started",
        runCommand: "cancel",
      });
      // The effect is confirmed now, and the cancelled run started NOTHING.
      expect(readRowsAt(storeRoot, CHAIN.name).cancelEffects).toEqual([
        { effectId: "cancel:work#1", status: "done" },
      ]);
      expect(secondDispatches).toEqual([]);

      // A SECOND boot re-reports the stop and asks nothing again.
      const secondBoot = await b.host.recoverDeclaredGraphs();
      expect(secondBoot.controlled).toEqual([CHAIN.name + ":cancel"]);
      expect(secondBoot.cancellations).toEqual([
        expect.objectContaining({ attemptId: "work#1", state: "confirmed" }),
      ]);
      expect(platform.asked).toHaveLength(1);
      expect(secondDispatches).toEqual([]);
    } finally {
      b.host.close();
    }
  });

  it("resumes with the intent visible after the recording PROCESS dies at the platform ask, and delivers it on the next boot", async () => {
    const dir = makeTmpDir("cancel-xproc-restart-");
    const storeRoot = join(dir, "host-store");
    mkdirSync(storeRoot, { recursive: true });

    // THE CHILD IS A REAL OS PROCESS. It declares the graph, starts it through
    // the shipped assembly, issues `graph_control cancel`, and exits from INSIDE
    // the cancel port — after the durable decision and the request transition,
    // before any platform answer. That is the crash window this case drives; the
    // case above closes one host instance and reopens another IN ONE PROCESS.
    const atAsk = await runRecordingProcessUntilItDiesAtTheAsk(dir, storeRoot);
    expect(atAsk.pid).not.toBe(process.pid);
    expect(atAsk).toMatchObject({
      attemptId: "work#1",
      effect: "started",
      runCommand: "cancel",
    });

    // WHAT THE DEAD PROCESS LEFT, read by a fresh connection: the trusted intent
    // AND an already-requested, unconfirmed cancel. Nothing was confirmed on its
    // behalf, nothing became a completion, and the dispatch effect is untouched.
    const afterDeath = readRowsAt(storeRoot, XPROC_CANCEL_GRAPH_ID);
    expect(afterDeath.control?.command).toBe("cancel");
    expect(decisionOf(afterDeath, "work#1").command).toBe("cancel");
    expect(afterDeath.cancelEffects).toEqual([
      { effectId: "cancel:work#1", status: "started" },
    ]);
    expect(afterDeath.events).toEqual([]);
    expect(afterDeath.receipts).toBe(0);
    expect(afterDeath.effects.map((effect) => effect.effectId).sort()).toEqual([
      "cancel:work#1",
      "dispatch:work#1",
    ]);

    // THE NEXT BOOT: the sweep reports the stop, RE-ASKS the unconfirmed cancel
    // through a port that confirms, and starts NOTHING.
    const platform = createFakeCancelPort(storeRoot);
    platform.answer = {
      kind: "confirmed",
      reason: "the fake platform confirmed the abort after the relaunch",
    };
    const dispatches: OutcomeDispatchRequest[] = [];
    const relaunched = await openHost({ dir, storeRoot, dispatches, cancelPort: platform.port });
    try {
      const report = await relaunched.host.recoverDeclaredGraphs();
      expect(report.controlled).toEqual([XPROC_CANCEL_GRAPH_ID + ":cancel"]);
      expect(report.cancellations).toEqual([
        expect.objectContaining({ attemptId: "work#1", state: "confirmed" }),
      ]);
      expect(platform.asked).toHaveLength(1);
      expect(platform.atAsk[0]).toEqual({
        attemptId: "work#1",
        effect: "started",
        runCommand: "cancel",
      });
      expect(dispatches).toEqual([]);
      expect(readRowsAt(storeRoot, XPROC_CANCEL_GRAPH_ID).cancelEffects).toEqual([
        { effectId: "cancel:work#1", status: "done" },
      ]);
    } finally {
      relaunched.host.close();
    }
  });

  it("refuses a dispatched worker's control call before the tool body, so it can trigger no delivery", async () => {
    const fixture = await openCancelFixture(CHAIN);
    try {
      const raw = String(
        await fixture.tools.graph_control.execute(
          { graph_id: fixture.graphId, command: "cancel", reason: "a worker tries to stop the graph" },
          fixture.contextOf(childSessionOf("work#1"), "agent.work"),
        ),
      );
      const refused = JSON.parse(raw) as { readonly refused?: boolean; readonly code?: string };
      expect(refused.refused).toBe(true);
      expect(refused.code).toBe("worker-tool-forbidden");

      expect(fixture.platform.asked).toEqual([]);
      const rows = readRows(fixture);
      expect(rows.decisions).toEqual([]);
      expect(rows.control).toBeUndefined();
      expect(rows.cancelEffects).toEqual([]);
    } finally {
      fixture.host.close();
    }
  });

  it("asks the platform nothing when an unauthorized caller's control command is refused", async () => {
    const fixture = await openCancelFixture(CHAIN);
    try {
      fixture.platform.answer = {
        kind: "requested",
        reason: "the fake platform took the request and cannot confirm it",
      };
      const applied = await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "the operator stopped it" },
        "session.declarer",
      );
      expect(applied["kind"]).toBe("applied");
      expect(fixture.platform.asked).toHaveLength(1);

      // A NON-DECLARER IS REFUSED BY THE SERVICE...
      const refused = await control(
        fixture,
        { graph_id: fixture.graphId, command: "cancel", reason: "not mine to stop" },
        "session.intruder",
      );
      expect(refused["kind"]).toBe("refused");
      expect(
        (refused["refusals"] as readonly { readonly code: string }[])[0]?.code,
      ).toBe("control-not-authorized");

      // ...AND THE PLATFORM IS NOT ASKED ON ITS BEHALF. Only an APPLIED control
      // answer carries an intent to deliver; a refusal must not let a caller who
      // does not own the graph make the host ask the platform to stop it.
      expect(fixture.platform.asked).toHaveLength(1);
      const rows = readRows(fixture);
      expect(rows.control?.reason).toBe("the operator stopped it");
      expect(rows.decisions).toHaveLength(1);
      expect(rows.cancelEffects).toEqual([
        { effectId: "cancel:work#1", status: "started" },
      ]);
      expect(rows.events).toEqual([]);
    } finally {
      fixture.host.close();
    }
  });
});
