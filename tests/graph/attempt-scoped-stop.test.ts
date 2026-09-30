/**
 * P3 item 1 — A STOPPING CONTROL DECISION IS ATTEMPT-SCOPED.
 *
 * WHAT THIS FILE PROVES BY BEHAVIOUR, through the SHIPPED assembly (a real
 * `OutcomeHost`, the workspace's one SQLite store, the real `createGraphToolSet`
 * and the real `graph_control` / `graph_submit_outcome` tools bound by
 * `OutcomeHost.bindTools`):
 *
 * - a node-scoped `failure` (and `timeout`) records its decision on the ONE
 *   attempt it names and claims NO run control fact: the persisted phase is
 *   still `executing`, the attempt's effect is failed and its budget
 *   reservation released, and a SIBLING still settles and arms its successor —
 *   every assertion reads the durable rows back with a FRESH connection;
 * - the stopped attempt accepts NOTHING: a late submission is refused with the
 *   named `attempt-stopped` refusal, in BOTH directions of the race — a decision
 *   that committed before the submission, and one that commits while the
 *   submission's declared gate runs (a REAL second OS process, spawned
 *   synchronously from inside the gate) — and the store's own receipt INSERT
 *   refuses the same batch;
 * - the attempt is carried forward only by a node-scoped `retry` of its node,
 *   which is APPLIED after a `failure` (the engine's one resolution path) and
 *   mints a SUCCESSOR attempt with a NEW credential that can settle;
 * - a `cancel` and a `budget-stop` still end the RUN: they claim the run's
 *   control fact, a later submission still answers `control-stopped`, and a
 *   node-scoped retry is still refused `run-stopped`;
 * - an approval request never pauses a stopped attempt (`attempt-stopped`), so no
 *   pause lands on an execution that could never settle, while a sibling is
 *   still pausable;
 * - the RUN's control fact and the ATTEMPT's stopping decision are read in
 *   SEPARATE, non-transactional steps, so a run-wide `cancel` that commits
 *   BETWEEN them — a REAL second OS process committing from the state read — is
 *   answered `control-stopped` (the run-level code and message, never a claim
 *   that the run still executes), while a node-scoped `failure` committed in the
 *   same window is still answered `attempt-stopped`; neither writes anything;
 * - recovery refuses to (re-)LAUNCH an effect whose attempt carries a stopping
 *   decision: an attempt-scoped stop leaves the run live, so the boot sweep
 *   reaches the stopped attempt's unsettled effect, and on a substrate whose
 *   query PROVES absence that is exactly the window that would create the
 *   execution again. The sibling in the same window IS launched.
 *
 * STRENGTH: adapter + real store, process-level, with one REAL cross-process
 * race (a `bun` child process with its own store connection). No real dsh/Pi SDK
 * runs in this environment, so nothing here is real-host evidence.
 */

import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { removeTempTrees } from "./helpers/temp-dirs.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { OutcomeHost, withCancelDelivery } from "../../src/graph/host/outcome-host.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import type { CommitResult } from "../../src/graph/ledger/types.ts";
import { STOPPING_CONTROL_COMMANDS } from "../../src/graph/ledger/types.ts";
import type {
  OutcomeDispatchEffectKey,
  OutcomeDispatchRequest,
} from "../../src/graph/outcome/dispatch-effects.ts";
import {
  createValidatorRegistry,
  type ValidatorImplementation,
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
import { approvalPolicyFor } from "./helpers/approval-policy.ts";

setDefaultTimeout(30_000);

// ── Fixtures ────────────────────────────────────────────────────────────────

/** The one instant every command in this file is stamped with. */
const AT = 1_700_000_000_000;

/** The instant the cross-process racer stamps its decision with. */
const RACE_AT = AT + 1_000;

/** The approval deadline: arithmetic on {@link AT}, never a race with a clock. */
const DEADLINE = AT + 600_000;

const DECLARER = "session.declarer";
const APPROVER = "session.approver";

/** The gate the inverse-race declaration names on `work`'s accepted outcome. */
const INVERSE_RACE_GATE = "gate.attempt-stop.inverse-race";

/**
 * TWO ENTRY NODES AND ONE SUCCESSOR: one start leaves BOTH entry attempts in
 * flight at once (attempt ids are GRAPH-scoped sequences, so they read
 * `alpha#1` and `beta#2`), and `beta`'s accepted `done` arms `gamma#3` — so a
 * stopping decision on `alpha` can be shown to leave a sibling's settlement and
 * its successor arming untouched.
 */
const FAN_OUT: GraphDeclarationV3 = {
  version: 3,
  name: "attempt-stop.fan-out",
  nodes: [
    { id: "alpha", agent: "agent.alpha", prompt: "Do alpha.", outcomes: [{ id: "done" }] },
    { id: "beta", agent: "agent.beta", prompt: "Do beta.", outcomes: [{ id: "done" }] },
    {
      id: "gamma",
      agent: "agent.gamma",
      prompt: "Consume beta.",
      inputs: [{ from: "beta", outcome: "done" }],
      outcomes: [{ id: "done" }],
    },
  ],
  edges: [{ from: "beta", to: "gamma", outcome: "done" }],
};

/**
 * ONE node whose accepted outcome sits behind a DECLARED GATE, which is what
 * opens the inverse-race window: acceptance gates run OUTSIDE the acceptance
 * transaction, so the gate's own implementation can have a REAL second process
 * commit a stopping decision between the run path's pre-transaction check and
 * its acceptance transaction.
 */
const GATED: GraphDeclarationV3 = {
  version: 3,
  name: "attempt-stop.inverse-race",
  nodes: [
    {
      id: "work",
      agent: "agent.work",
      prompt: "Do the work.",
      outcomes: [
        { id: "done", acceptance: [{ validator: INVERSE_RACE_GATE, version: 1 }] },
      ],
    },
  ],
  edges: [],
};

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  // Release the fixture's stores, then remove each tree ONCE — a removal that
  // throws must not leave the directory queued for the next sweep.
  removeTempTrees(tmpDirs);
});

/** The child session the platform "created" for one attempt (the dsh mapping). */
function childSessionOf(attemptId: string): string {
  return "child-session:" + attemptId;
}

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

interface Fixture {
  readonly dir: string;
  readonly storeRoot: string;
  readonly host: OutcomeHost;
  readonly toolset: GraphToolSet;
  readonly tools: Record<string, CanonicalToolDef>;
  /** Every create this fixture's host was ASKED to perform, in order. */
  readonly createCalls: OutcomeDispatchRequest[];
  /** Every create that RETURNED (a delivery the platform accepted). */
  readonly dispatched: OutcomeDispatchRequest[];
  readonly graphId: string;
  readonly contextOf: (sessionID: string, agent: string) => CanonicalToolContext;
  /** Report every execution the platform holds as FAILED from now on. */
  readonly failExecutions: () => void;
  /** The error a start that could not launch its first effect threw, if any. */
  readonly startFailure: string | undefined;
}

/**
 * One shipped host assembly over a REAL declared and started graph.
 *
 * `deliverThrowsFor` reproduces the commit-then-crash window honestly: the
 * transaction that arms an attempt COMMITTED, and the synchronous delivery
 * refused, so the attempt's effect is a durable `pending` row nobody ever
 * created. `queryProvesAbsence` installs a platform port that can PROVE no
 * execution exists for such an effect — the answer that lets a recovery create
 * it again.
 */
async function openFixture(
  declaration: GraphDeclarationV3,
  options: {
    readonly gate?: {
      readonly validator: string;
      readonly version: number;
      readonly implementation: ValidatorImplementation;
    };
    readonly approvalPolicy?: boolean;
    readonly deliverThrowsFor?: (request: OutcomeDispatchRequest) => boolean;
    readonly queryProvesAbsence?: boolean;
  } = {},
): Promise<Fixture> {
  const dir = makeTmpDir("attempt-scoped-stop-");
  const storeRoot = join(dir, "host-store");
  // The host's vault writes under its root, so the root exists before the open.
  mkdirSync(storeRoot, { recursive: true });
  const validators =
    options.gate === undefined
      ? createValidatorRegistry([])
      : createValidatorRegistry([
          {
            id: options.gate.validator,
            version: options.gate.version,
            implementation: options.gate.implementation,
          },
        ]);
  const createCalls: OutcomeDispatchRequest[] = [];
  const dispatched: OutcomeDispatchRequest[] = [];
  let executionsFailed = false;
  let host: OutcomeHost | undefined;
  const opened = OutcomeHost.open({
    workspaceDir: dir,
    storeRoot,
    deliver: (request, effect) => {
      createCalls.push(request);
      if (options.deliverThrowsFor?.(request) === true) {
        // THE SYNCHRONOUS DELIVERY REFUSAL: the platform received nothing, so
        // the host may create this effect again later — which is exactly why
        // the recovery below is reached for a `pending` row.
        throw new Error("fixture: the platform refused the delivery for " + request.attemptId);
      }
      dispatched.push(request);
      // The platform names the execution it created; the host records the fact.
      host?.confirmExecution(effect, { executionId: childSessionOf(request.attemptId) });
    },
    validators,
    declareInvocationIdentity: false,
    workerSessionOf: (execution) => execution.executionId,
    clock: () => AT,
    observeExecution: () =>
      executionsFailed
        ? { kind: "failed" as const, reason: "the platform reported the execution failed" }
        : { kind: "running" as const },
    ...(options.queryProvesAbsence === true
      ? {
          query: {
            // A substrate that can PROVE an execution it never created does not
            // exist. It answers `absent` for every effect it was asked about; a
            // local `created` row still wins in the host's own join, so only an
            // effect this host never completed is released for a create.
            lookup: () => ({ kind: "absent" as const }),
          },
        }
      : {}),
  });
  host = opened;
  const toolset = createGraphToolSet({
    stateDir: dir,
    credentialIsolation: opened.credentialIsolation,
    hostIdentity: opened.workerIdentity,
    outcomeDispatch: opened.dispatch,
    outcomeValidators: validators,
    outcomeArtifactRoot: dir,
    outcomeNow: AT,
    ...(options.approvalPolicy === true
      ? { approvalPolicy: approvalPolicyFor(declaration.name, APPROVER) }
      : {}),
  });
  const fixture: Fixture = {
    dir,
    storeRoot,
    host: opened,
    toolset,
    // THE SHIPPED WRAPPING ORDER (GraphApplication's own): the control tool is
    // wrapped for cancel delivery and for the RETRY follow-up — an applied retry
    // hands its successor's pending effect to the run path — and the whole face
    // is then bound to the host's worker boundary.
    tools: opened.bindTools(withCancelDelivery(createOutcomeGraphTools(toolset), opened)),
    createCalls,
    dispatched,
    graphId: declaration.name,
    contextOf: (sessionID, agent) => makeContext(sessionID, agent, dir),
    failExecutions: () => {
      executionsFailed = true;
    },
    startFailure: undefined,
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
      fixture.contextOf(DECLARER, "agent.declarer"),
    ),
  );
  if (declared.includes("graph_declare failed:")) {
    throw new Error("fixture: graph_declare refused the declaration: " + declared);
  }
  try {
    const started = await opened.startDeclaredGraph(declaration.name, {
      sessionId: DECLARER,
      agent: "agent.declarer",
    });
    if (started.kind !== "started") {
      throw new Error("fixture: the graph did not start (" + started.kind + ")");
    }
  } catch (error) {
    if (options.deliverThrowsFor === undefined) throw error;
    // THE CRASH WINDOW, REPRODUCED HONESTLY: the arming transaction committed
    // and the delivery refused, so the fixture reports the throw instead of
    // pretending the start succeeded.
    (fixture as { startFailure: string | undefined }).startFailure = String(error);
  }
  return fixture;
}

/** What one control answer carries, as the tool renders it. */
interface ControlAnswer {
  readonly kind?: "applied" | "refused";
  readonly command?: string;
  readonly scope?: "attempt" | "run";
  readonly runId?: string;
  readonly runControl?: { readonly command: string; readonly reason: string } | undefined;
  readonly decided?: readonly {
    readonly nodeId: string;
    readonly attemptId: string;
    readonly replayed: boolean;
    readonly decision: { readonly command: string; readonly reason: string };
  }[];
  readonly minted?: readonly {
    readonly nodeId: string;
    readonly attemptId: string;
    readonly attemptSeq: number;
  }[];
  readonly refusals?: readonly {
    readonly code: string;
    readonly path: string;
    readonly message: string;
  }[];
}

/** What one submission answer carries, as the tool renders it. */
interface SubmitAnswer {
  readonly decision?: "accepted" | "rejected";
  readonly verdict?: string;
  readonly verdict_reason?: string;
  readonly attempt_id?: string;
  readonly refusals: readonly { readonly code: string; readonly message: string }[];
}

/** Call the SHIPPED `graph_control` tool and parse its JSON answer. */
async function control(
  fixture: Fixture,
  args: Record<string, unknown>,
  sessionID = DECLARER,
  agent = "agent.declarer",
): Promise<ControlAnswer> {
  const raw = String(
    await fixture.tools.graph_control.execute(args, fixture.contextOf(sessionID, agent)),
  );
  if (raw.startsWith("graph_control failed:")) {
    throw new Error("fixture: graph_control failed: " + raw);
  }
  return JSON.parse(raw) as ControlAnswer;
}

/** Submit one attempt's outcome through the SHIPPED ingress and parse it. */
async function submit(
  fixture: Fixture,
  nodeId: string,
  outcomeId: string,
  credential: string,
  sessionID: string,
): Promise<SubmitAnswer> {
  const raw = String(
    await fixture.tools.graph_submit_outcome.execute(
      { graph_id: fixture.graphId, node_id: nodeId, outcome_id: outcomeId, credential },
      fixture.contextOf(sessionID, "agent." + nodeId),
    ),
  );
  if (raw.startsWith("graph_submit_outcome failed:")) {
    throw new Error("fixture: graph_submit_outcome failed: " + raw);
  }
  return JSON.parse(raw) as SubmitAnswer;
}

/**
 * The attempt id ONE node was armed with, derived from the delivery.
 *
 * ATTEMPT IDS ARE GRAPH-SCOPED SEQUENCES: the second entry node of a fan-out is
 * armed with the sequence that follows the first (`beta#2` when `alpha` took
 * `#1`), so a test that hardcoded a per-node sequence would be asserting the
 * numbering and not the rule.
 */
function attemptIdOf(fixture: Fixture, nodeId: string): string {
  const request = fixture.dispatched.find((candidate) => candidate.nodeId === nodeId);
  if (request === undefined) throw new Error("fixture: no delivery for node " + nodeId);
  return request.attemptId;
}

/** The credential one DELIVERED attempt was handed (never printed by a test). */
function credentialOf(fixture: Fixture, attemptId: string): string {
  const request = fixture.dispatched.find((candidate) => candidate.attemptId === attemptId);
  if (request === undefined) {
    throw new Error("fixture: no delivery for attempt " + attemptId);
  }
  return request.credential;
}

/** Read one graph's rows with a FRESH connection, exactly as a reader would. */
function withStore<T>(fixture: Fixture, read: (store: GraphStore) => T): T {
  const store = GraphStore.openFile(fixture.storeRoot);
  try {
    return read(store);
  } finally {
    store.close();
  }
}

interface StateBody {
  readonly phase: unknown;
  readonly nodes: readonly Record<string, unknown>[];
}

/** The persisted state body of one graph, read with a fresh connection. */
function readState(fixture: Fixture): StateBody {
  return withStore(fixture, (store) => {
    const record = store.readGraphState(fixture.graphId);
    const body =
      typeof record?.body === "object" && record.body !== null
        ? (record.body as Record<string, unknown>)
        : undefined;
    return {
      phase: body?.["phase"],
      nodes: Array.isArray(body?.["nodes"])
        ? (body["nodes"] as readonly Record<string, unknown>[])
        : [],
    };
  });
}

/** The persisted entry of one node. */
function nodeEntry(state: StateBody, nodeId: string): Record<string, unknown> {
  const entry = state.nodes.find((node) => node["nodeId"] === nodeId);
  if (entry === undefined) throw new Error("fixture: no persisted entry for node " + nodeId);
  return entry;
}

/** The run-level control fact of one graph, or `undefined`. */
function runControl(fixture: Fixture) {
  return withStore(fixture, (store) => store.runs.readRunControl(fixture.graphId));
}

/** Every control decision of the graph's CURRENT run, in decision order. */
function decisions(fixture: Fixture) {
  return withStore(fixture, (store) => store.runs.controlDecisions(fixture.graphId));
}

/** The decision one attempt carries, or a fixture error when it carries none. */
function decisionOf(fixture: Fixture, attemptId: string): {
  readonly attemptId: string;
  readonly command: string;
  readonly reason: string;
} {
  const decision = decisions(fixture).find((entry) => entry.attemptId === attemptId);
  if (decision === undefined) throw new Error("fixture: no decision for " + attemptId);
  return decision;
}

/** The durable status of one attempt's dispatch effect. */
function effectStatusOf(fixture: Fixture, attemptId: string): unknown {
  return withStore(fixture, (store) => {
    const row = store.all(
      `SELECT status FROM ${GRAPH_STORE_TABLES.pendingEffects}
        WHERE graph_id = ? AND attempt_id = ?`,
      fixture.graphId,
      attemptId,
    )[0];
    return row?.["status"];
  });
}

/** The durable status of one attempt's budget reservation. */
function reservationStatusOf(fixture: Fixture, attemptId: string): unknown {
  return withStore(
    fixture,
    (store) =>
      store.budget
        .reservationsOf(fixture.graphId)
        .find((entry) => entry.attemptId === attemptId)?.status,
  );
}

/** How many receipts one graph holds. */
function receiptsOf(fixture: Fixture): number {
  return withStore(fixture, (store) => {
    const row = store.all(
      `SELECT COUNT(*) AS n FROM ${GRAPH_STORE_TABLES.receipts} WHERE graph_id = ?`,
      fixture.graphId,
    )[0];
    return Number(row?.["n"] ?? 0);
  });
}

// ── The inverse race: a decision that commits while a gate runs ─────────────

/** The absolute URL of the store module the cross-process racer imports. */
const STORE_MODULE_URL = new URL(
  "../../src/graph/store/graph-store.ts",
  import.meta.url,
).href;

/** What the cross-process racer reported. */
interface RaceReport {
  readonly ok: boolean;
  readonly verdict?: string;
  readonly runId?: string;
  /** The RUN FACT the second process left standing, or `undefined`. */
  readonly runControl?: string;
  readonly error?: string;
}

/**
 * Record ONE ATTEMPT-SCOPED stopping decision from a REAL second OS process.
 *
 * WHY SYNCHRONOUS AND WHY A SECOND PROCESS. The acceptance gate runs outside the
 * acceptance transaction, so the only place a test can commit a decision INSIDE
 * that window is a validator — and validation is synchronous by contract.
 * `Bun.spawnSync` starts a second `bun` process with its OWN connection to the
 * same store, which commits the decision before this submission's transaction
 * opens: exactly the interleaving the run path's pre-transaction check cannot
 * see. The racer writes the DECISION ONLY — no run control fact — because that is
 * what an attempt-scoped stop is: the run keeps executing.
 */
function applyAttemptStopFromAnotherProcess(options: {
  readonly dir: string;
  readonly storeRoot: string;
  readonly graphId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly reason: string;
}): RaceReport {
  const script = [
    "// Generated by tests/graph/attempt-scoped-stop.test.ts — a REAL second",
    "// process racing an attempt-scoped stop against an in-flight submission.",
    `import { GraphStore } from ${JSON.stringify(STORE_MODULE_URL)};`,
    `const cfg = ${JSON.stringify(options)};`,
    "const store = GraphStore.openFile(cfg.storeRoot);",
    "try {",
    "  const run = store.runs.readRun(cfg.graphId);",
    "  if (run === undefined) throw new Error('the store holds no run identity');",
    "  const verdict = store.runs.writeControlDecision({",
    "    decision: {",
    "      graphId: cfg.graphId, runId: run.runId, nodeId: cfg.nodeId,",
    "      attemptId: cfg.attemptId, command: 'failure', reason: cfg.reason,",
    `      decidedAt: ${String(RACE_AT)}, decidedBy: { sessionId: ${JSON.stringify(DECLARER)} },`,
    "    },",
    "    // NO runControl: a node-scoped stop ends ONE attempt, not the run.",
    "  });",
    "  console.log(JSON.stringify({ ok: true, verdict: verdict.kind, runId: run.runId }));",
    "} catch (error) {",
    "  console.log(JSON.stringify({ ok: false, error: String(error) }));",
    "} finally {",
    "  store.close();",
    "}",
  ].join("\n");
  const scriptPath = join(options.dir, "attempt-stop-racer.ts");
  writeFileSync(scriptPath, script);
  const result = Bun.spawnSync([process.execPath, scriptPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("{"))
    .pop();
  if (line === undefined) {
    throw new Error(
      "fixture: the racer printed no JSON result (exit " +
        String(result.exitCode) +
        ", stderr: " +
        new TextDecoder().decode(result.stderr).trim() +
        ")",
    );
  }
  return JSON.parse(line) as RaceReport;
}

/**
 * Record ONE stopping command from a REAL second OS process — `cancel` (the
 * decision AND the run fact it claims, in the ONE boundary
 * `writeControlDecision` opens) or a node-scoped `failure` (the decision alone).
 *
 * WHY THE SAME WRITE AS THE CONTROL ENTRY. `applyStopCommand` records exactly
 * this for every attempt a command names — a decision per attempt, and, for a
 * run-wide command only, the run fact claimed in the same transaction — so a
 * second process performing the same write is the same durable effect rather
 * than a simulation of it. It is a second PROCESS because the window this test
 * injects is a read inside the run path, which is synchronous by contract: the
 * only place a command can commit inside it is outside this process, exactly
 * like the attempt-scoped racer above.
 */
function applyControlFromAnotherProcess(options: {
  readonly dir: string;
  readonly storeRoot: string;
  readonly graphId: string;
  readonly command: "cancel" | "failure";
  readonly targets: readonly {
    readonly nodeId: string;
    readonly attemptId: string;
  }[];
  readonly reason: string;
}): RaceReport {
  const script = [
    "// Generated by tests/graph/attempt-scoped-stop.test.ts — a REAL second",
    "// process committing a stopping command inside the run path's read window.",
    `import { GraphStore } from ${JSON.stringify(STORE_MODULE_URL)};`,
    `const cfg = ${JSON.stringify(options)};`,
    "const store = GraphStore.openFile(cfg.storeRoot);",
    "try {",
    "  const run = store.runs.readRun(cfg.graphId);",
    "  if (run === undefined) throw new Error('the store holds no run identity');",
    "  const fact = {",
    "    graphId: cfg.graphId, runId: run.runId, command: cfg.command,",
    "    reason: cfg.reason,",
    `    decidedAt: ${String(RACE_AT)}, decidedBy: { sessionId: ${JSON.stringify(DECLARER)} },`,
    "  };",
    "  const verdicts = [];",
    "  for (const target of cfg.targets) {",
    "    const verdict = store.runs.writeControlDecision({",
    "      decision: { ...fact, nodeId: target.nodeId, attemptId: target.attemptId },",
    "      // THE SCOPE PREDICATE `applyStopCommand` APPLIES: only a run-wide",
    "      // command claims the run's control fact; a node-scoped stop records",
    "      // its decision on the attempt it names and claims nothing else.",
    "      ...(cfg.command === 'cancel' ? { runControl: fact } : {}),",
    "    });",
    "    verdicts.push(verdict.kind);",
    "  }",
    "  console.log(JSON.stringify({",
    "    ok: true, verdict: verdicts.join(','), runId: run.runId,",
    "    runControl: store.runs.readRunControl(cfg.graphId)?.command,",
    "  }));",
    "} catch (error) {",
    "  console.log(JSON.stringify({ ok: false, error: String(error) }));",
    "} finally {",
    "  store.close();",
    "}",
  ].join("\n");
  const scriptPath = join(options.dir, "run-wide-stop-racer.ts");
  writeFileSync(scriptPath, script);
  const result = Bun.spawnSync([process.execPath, scriptPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("{"))
    .pop();
  if (line === undefined) {
    throw new Error(
      "fixture: the stopping racer printed no JSON result (exit " +
        String(result.exitCode) +
        ", stderr: " +
        new TextDecoder().decode(result.stderr).trim() +
        ")",
    );
  }
  return JSON.parse(line) as RaceReport;
}

/** What one injected window did: whether it opened, and what stands after it. */
interface WindowInjection {
  /** True once the second process committed its command inside the window. */
  fired: boolean;
  /** What the second process reported, when it ran. */
  report?: RaceReport;
}

/**
 * INSTALL THE WINDOW: let a stopping command commit BETWEEN the run path's read
 * of the RUN's control fact and its read of the ATTEMPT's stopping decision.
 *
 * HOW THE TWO READS ARE TOLD APART. The runtime reads the run fact through the
 * port it holds — `ledger.runs.readRunControl`, the store's own method — and the
 * attempt's decision only after it has read the graph state
 * (`OutcomeGraphRuntime.submit`). That state read is ALSO what the ingress
 * performs BEFORE the acceptance core (the worker-context check), so the window
 * is not "the first state read": it is the first state read AFTER the run fact
 * was read. The two prototypes below implement exactly that boundary, and the
 * window REPORTS what it did, so a test proves the window opened instead of
 * assuming it.
 *
 * The patches are process-wide while installed, so a caller restores them in a
 * `finally`; the fixture's own reads happen outside that span.
 */
function installControlWindow(
  fixture: Fixture,
  options: {
    readonly command: "cancel" | "failure";
    readonly reason: string;
    readonly targets: readonly {
      readonly nodeId: string;
      readonly attemptId: string;
    }[];
  },
): { readonly injection: WindowInjection; readonly restore: () => void } {
  const injection: WindowInjection = { fired: false };
  const storePrototype = GraphStore.prototype;
  const ledgerPrototype = SqliteAcceptanceLedger.prototype;
  const originalReadRunControl = storePrototype.readRunControl;
  const originalReadGraphState = ledgerPrototype.readGraphState;
  let runFactRead = false;
  storePrototype.readRunControl = function (this: GraphStore, graphId: string) {
    const control = originalReadRunControl.call(this, graphId);
    if (graphId === fixture.graphId) runFactRead = true;
    return control;
  };
  ledgerPrototype.readGraphState = function (
    this: SqliteAcceptanceLedger,
    graphId: string,
  ) {
    if (runFactRead && !injection.fired && graphId === fixture.graphId) {
      // Marked BEFORE the child runs: a refusal from the racer is REPORTED by
      // the assertion below, never retried on a later read.
      injection.fired = true;
      runFactRead = false;
      injection.report = applyControlFromAnotherProcess({
        dir: fixture.dir,
        storeRoot: fixture.storeRoot,
        graphId: fixture.graphId,
        command: options.command,
        targets: options.targets,
        reason: options.reason,
      });
    }
    return originalReadGraphState.call(this, graphId);
  };
  return {
    injection,
    restore: () => {
      storePrototype.readRunControl = originalReadRunControl;
      ledgerPrototype.readGraphState = originalReadGraphState;
    },
  };
}

/**
 * INSTALL THE STORE-LEVEL WINDOW: let a run-wide command commit BETWEEN
 * `LedgerTables.commitAccepted`'s read of the RUN's control fact and its read of
 * the ATTEMPT's stopping decision.
 *
 * WHY IT IS A SECOND INSTALLER. The two windows are different code paths and
 * they must be closed independently: the runtime classifies its own refusal
 * before it ever reaches the store, while `commitAccepted` classifies the batch
 * from the facts IT reads (the fast path, and the re-read that explains a
 * guarded write). Both read the same two rows through the store's own methods,
 * so both are injected the same way: `readRunControl` first, then the stopping
 * decision, with the command committed in between by a REAL second process.
 */
function installStoreControlWindow(
  fixture: Fixture,
  options: {
    readonly reason: string;
    readonly targets: readonly {
      readonly nodeId: string;
      readonly attemptId: string;
    }[];
  },
): { readonly injection: WindowInjection; readonly restore: () => void } {
  const injection: WindowInjection = { fired: false };
  const storePrototype = GraphStore.prototype;
  const originalReadRunControl = storePrototype.readRunControl;
  const originalReadStoppingDecision = storePrototype.readStoppingDecision;
  let runFactRead = false;
  storePrototype.readRunControl = function (this: GraphStore, graphId: string) {
    const control = originalReadRunControl.call(this, graphId);
    if (graphId === fixture.graphId) runFactRead = true;
    return control;
  };
  storePrototype.readStoppingDecision = function (
    this: GraphStore,
    graphId: string,
    attemptId: string,
  ) {
    if (runFactRead && !injection.fired && graphId === fixture.graphId) {
      injection.fired = true;
      runFactRead = false;
      injection.report = applyControlFromAnotherProcess({
        dir: fixture.dir,
        storeRoot: fixture.storeRoot,
        graphId: fixture.graphId,
        command: "cancel",
        targets: options.targets,
        reason: options.reason,
      });
    }
    return originalReadStoppingDecision.call(this, graphId, attemptId);
  };
  return {
    injection,
    restore: () => {
      storePrototype.readRunControl = originalReadRunControl;
      storePrototype.readStoppingDecision = originalReadStoppingDecision;
    },
  };
}

// ── CHANGE A: a node-scoped stop claims no run control fact ─────────────────

describe("graph_control — a stopping decision is ATTEMPT-scoped", () => {
  it("records a failure on ONE attempt, leaves the run unclaimed and fails only that effect", async () => {
    const fixture = await openFixture(FAN_OUT);
    try {
      const alpha = attemptIdOf(fixture, "alpha");
      const beta = attemptIdOf(fixture, "beta");
      // The platform reports ALPHA's execution as failed; the HOST applies
      // the trusted `failure` with its own authority (a host failure report is
      // corroborated against the attempt's durable execution binding).
      fixture.failExecutions();
      const applied = await fixture.host.failObservedExecution(
        fixture.graphId,
        "alpha",
        alpha,
      );
      expect(applied?.kind).toBe("applied");
      if (applied?.kind !== "applied") throw new Error("fixture: the failure was not applied");
      expect(applied.command).toBe("failure");
      expect(applied.decided?.map((entry) => entry.attemptId)).toEqual([alpha]);
      expect(applied.scope).toBe("attempt");
      // THE RUN HOLDS NO CONTROL FACT. The command ended ONE attempt; claiming
      // the run would make the SIBLING attempt unsettleable for a stop nobody
      // issued.
      expect(applied.runControl).toBeUndefined();
      expect(runControl(fixture)).toBeUndefined();

      // THE ATTEMPT'S DECISION EXISTS, and it is the durable record of the stop.
      expect(decisions(fixture).map((entry) => [entry.attemptId, entry.command])).toEqual([
        [alpha, "failure"],
      ]);

      // THE EFFECT IS FAILED AND THE RESERVATION RELEASED, while the sibling's
      // own claim stands exactly as it was.
      expect(effectStatusOf(fixture, alpha)).toBe("failed");
      expect(effectStatusOf(fixture, beta)).toBe("started");
      expect(reservationStatusOf(fixture, alpha)).toBe("released");
      expect(reservationStatusOf(fixture, beta)).toBe("reserved");

      // THE RUN KEEPS EXECUTING: the persisted phase is untouched, and the
      // stopped attempt is still the node's in-flight attempt (the stop is a
      // decision, not a state transition).
      const state = readState(fixture);
      expect(state.phase).toBe("executing");
      expect(nodeEntry(state, "alpha")).toMatchObject({
        status: "dispatched",
        attemptId: alpha,
      });
      expect(nodeEntry(state, "beta")).toMatchObject({
        status: "dispatched",
        attemptId: beta,
      });

      // AND THE STORE ITSELF REFUSES A BATCH FOR THE STOPPED ATTEMPT: the guard
      // is structural, so no caller of the store API can land a result for it.
      const verdict = withStore(fixture, (store) =>
        store.commitAccepted({
          receipt: {
            graphId: fixture.graphId,
            attemptId: alpha,
            submissionId: "submission:stopped-attempt",
            planRevision: "plan.attempt-stop",
            proposalDigest: "digest:stopped-attempt",
            decision: "accepted",
            committedAt: AT,
          },
          acceptedEvent: {
            graphId: fixture.graphId,
            attemptId: alpha,
            submissionId: "submission:stopped-attempt",
            planRevision: "plan.attempt-stop",
            outcomeId: "done",
            acceptedAt: AT,
          },
        }),
      );
      expect(verdict.kind).toBe("attempt-stopped");
      if (verdict.kind !== "attempt-stopped") {
        throw new Error("fixture: expected the attempt-stop verdict");
      }
      expect(verdict.decision.command).toBe("failure");
      expect(receiptsOf(fixture)).toBe(0);
      expect(withStore(fixture, (store) => store.acceptedEvents(fixture.graphId))).toEqual([]);
    } finally {
      fixture.host.close();
    }
  });

  it("still settles a sibling, arms its successor and refuses the stopped attempt by name", async () => {
    const fixture = await openFixture(FAN_OUT);
    try {
      const alpha = attemptIdOf(fixture, "alpha");
      const beta = attemptIdOf(fixture, "beta");
      // A PRINCIPAL-ISSUED failure, with no host failure report: the decision is
      // recorded and NOTHING else is touched — not the effect, not the run.
      const stopped = await control(fixture, {
        graph_id: fixture.graphId,
        command: "failure",
        node_id: "alpha",
        reason: "the alpha worker died",
      });
      expect(stopped.kind).toBe("applied");
      expect(stopped.scope).toBe("attempt");
      expect(stopped.runControl).toBeUndefined();
      expect(runControl(fixture)).toBeUndefined();

      // THE SIBLING STILL SETTLES, and its accepted outcome ARMS ITS SUCCESSOR.
      const sibling = await submit(
        fixture,
        "beta",
        "done",
        credentialOf(fixture, beta),
        childSessionOf(beta),
      );
      expect(sibling.refusals).toEqual([]);
      expect(sibling.decision).toBe("accepted");
      const gamma = fixture.dispatched.find((request) => request.nodeId === "gamma")?.attemptId;
      expect(gamma?.startsWith("gamma#")).toBe(true);
      if (gamma === undefined) throw new Error("fixture: no successor delivery for gamma");
      expect(effectStatusOf(fixture, gamma)).toBe("started");
      // The run still holds NO control fact after a settlement.
      expect(runControl(fixture)).toBeUndefined();
      expect(readState(fixture).phase).toBe("executing");

      // THE STOPPED ATTEMPT ACCEPTS NOTHING, and the refusal says which command
      // stopped it and that the run itself continues.
      const late = await submit(
        fixture,
        "alpha",
        "done",
        credentialOf(fixture, alpha),
        childSessionOf(alpha),
      );
      expect(late.decision).toBeUndefined();
      expect(late.refusals[0]?.code).toBe("attempt-stopped");
      expect(late.refusals[0]?.message).toContain("failure");
      expect(late.refusals[0]?.message).toContain("NOT stopped");
      expect(receiptsOf(fixture)).toBe(1);
    } finally {
      fixture.host.close();
    }
  });

  it("treats timeout exactly like failure: one attempt stopped, the run still executing", async () => {
    const fixture = await openFixture(FAN_OUT);
    try {
      const alpha = attemptIdOf(fixture, "alpha");
      const beta = attemptIdOf(fixture, "beta");
      const timedOut = await control(fixture, {
        graph_id: fixture.graphId,
        command: "timeout",
        node_id: "alpha",
        reason: "the alpha worker exceeded its time",
      });
      expect(timedOut.kind).toBe("applied");
      expect(timedOut.scope).toBe("attempt");
      expect(timedOut.runControl).toBeUndefined();
      expect(runControl(fixture)).toBeUndefined();
      expect(decisionOf(fixture, alpha).command).toBe("timeout");
      expect(readState(fixture).phase).toBe("executing");

      const late = await submit(
        fixture,
        "alpha",
        "done",
        credentialOf(fixture, alpha),
        childSessionOf(alpha),
      );
      expect(late.refusals[0]?.code).toBe("attempt-stopped");
      expect(late.refusals[0]?.message).toContain("timeout");

      // A SIBLING IS UNAFFECTED, exactly as with a failure.
      const sibling = await submit(
        fixture,
        "beta",
        "done",
        credentialOf(fixture, beta),
        childSessionOf(beta),
      );
      expect(sibling.decision).toBe("accepted");
    } finally {
      fixture.host.close();
    }
  });

  // ── CHANGE B: the engine's one resolution path ────────────────────────────

  it("applies a node-scoped retry of the stopped node and mints a successor with a new credential", async () => {
    const fixture = await openFixture(FAN_OUT);
    try {
      const alpha = attemptIdOf(fixture, "alpha");
      const oldCredential = credentialOf(fixture, alpha);
      const stopped = await control(fixture, {
        graph_id: fixture.graphId,
        command: "failure",
        node_id: "alpha",
        reason: "the alpha worker died",
      });
      expect(stopped.kind).toBe("applied");

      // RETRY IS THE RESOLUTION PATH: the run holds no control fact, so the
      // node-scoped retry is APPLIED and supersedes the stopped attempt.
      const retried = await control(fixture, {
        graph_id: fixture.graphId,
        command: "retry",
        node_id: "alpha",
        reason: "run alpha again",
      });
      expect(retried.kind).toBe("applied");
      const successorAttemptId = retried.minted?.[0]?.attemptId;
      expect(successorAttemptId?.startsWith("alpha#")).toBe(true);
      expect(retried.runControl).toBeUndefined();
      expect(runControl(fixture)).toBeUndefined();
      // BOTH DECISIONS STAND: the stop on the superseded attempt and the retry
      // recorded BESIDE it — one attempt, one STOPPING fact, plus its successor.
      expect(decisions(fixture).map((entry) => [entry.attemptId, entry.command])).toEqual([
        [alpha, "failure"],
        [alpha, "retry"],
      ]);

      // THE SUCCESSOR IS DELIVERED, WITH A NEW CREDENTIAL, and it can settle:
      // the stop poisoned one attempt, not the node.
      const successor = fixture.dispatched.find(
        (request) => request.attemptId === successorAttemptId,
      );
      expect(successor).toBeDefined();
      if (successor === undefined || successorAttemptId === undefined) {
        throw new Error("fixture: no successor delivery");
      }
      expect(successor.credential).not.toBe(oldCredential);
      const settled = await submit(
        fixture,
        "alpha",
        "done",
        successor.credential,
        childSessionOf(successorAttemptId),
      );
      expect(settled.refusals).toEqual([]);
      expect(settled.decision).toBe("accepted");
    } finally {
      fixture.host.close();
    }
  });

  it("still answers attempt-superseded for a retry-superseded attempt", async () => {
    const fixture = await openFixture(FAN_OUT);
    try {
      const alpha = attemptIdOf(fixture, "alpha");
      const retried = await control(fixture, {
        graph_id: fixture.graphId,
        command: "retry",
        node_id: "alpha",
        reason: "supersede the stale worker",
      });
      expect(retried.kind).toBe("applied");
      const successorAttemptId = retried.minted?.[0]?.attemptId;
      expect(successorAttemptId?.startsWith("alpha#")).toBe(true);

      // THE ATTEMPT-STOP GUARD DOES NOT SHADOW THE SUPERSESSION RULE: the batch
      // for the superseded attempt is refused with the retry's own verdict.
      const verdict = withStore(fixture, (store) =>
        store.commitAccepted({
          receipt: {
            graphId: fixture.graphId,
            attemptId: alpha,
            submissionId: "submission:superseded-race",
            planRevision: "plan.attempt-stop",
            proposalDigest: "digest:superseded-race",
            decision: "accepted",
            committedAt: AT,
          },
          acceptedEvent: {
            graphId: fixture.graphId,
            attemptId: alpha,
            submissionId: "submission:superseded-race",
            planRevision: "plan.attempt-stop",
            outcomeId: "done",
            acceptedAt: AT,
          },
        }),
      );
      expect(verdict.kind).toBe("superseded");
      if (verdict.kind !== "superseded") throw new Error("fixture: expected superseded");
      expect(verdict.decision.successorAttemptId).toBe(successorAttemptId);
      expect(withStore(fixture, (store) => store.acceptedEvents(fixture.graphId))).toEqual([]);

      // AND THE CLASSIFICATION ITSELF IS THE STATED SET: a `retry` is a
      // SUCCESSOR command recorded beside a stop, never a stopping one.
      expect([...STOPPING_CONTROL_COMMANDS]).toEqual([
        "failure",
        "timeout",
        "cancel",
        "budget-stop",
      ]);
    } finally {
      fixture.host.close();
    }
  });

  // ── CHANGE C: no pause may land on a stopped attempt ──────────────────────

  it("refuses to pause a stopped attempt, while a live sibling is still pausable", async () => {
    const fixture = await openFixture(FAN_OUT, { approvalPolicy: true });
    try {
      const beta = attemptIdOf(fixture, "beta");
      const stopped = await control(fixture, {
        graph_id: fixture.graphId,
        command: "failure",
        node_id: "alpha",
        reason: "the alpha worker died",
      });
      expect(stopped.kind).toBe("applied");

      const refused = await control(fixture, {
        graph_id: fixture.graphId,
        command: "approval-request",
        node_id: "alpha",
        reason: "hold the work for sign-off",
        approver_session_id: APPROVER,
        expires_at: DEADLINE,
      });
      expect(refused.kind).toBe("refused");
      expect(refused.refusals?.[0]?.code).toBe("attempt-stopped");
      expect(refused.refusals?.[0]?.message).toContain("failure");

      // THE CHECK IS ATTEMPT-SCOPED: the live sibling is paused normally, so the
      // refusal above is about the stopped attempt and not about the run.
      const raised = await control(fixture, {
        graph_id: fixture.graphId,
        command: "approval-request",
        node_id: "beta",
        reason: "hold the work for sign-off",
        approver_session_id: APPROVER,
        expires_at: DEADLINE,
      });
      expect(raised.kind).toBe("applied");
      expect(
        withStore(fixture, (store) => store.approvals.approvalRequestsOf(fixture.graphId)).map(
          (request) => [request.attemptId, request.status],
        ),
      ).toEqual([[beta, "pending"]]);
    } finally {
      fixture.host.close();
    }
  });

  // ── CHANGE A end-to-end: run-wide commands keep their own rule ────────────

  it("keeps cancel and budget-stop run-wide: they claim the run and still answer control-stopped", async () => {
    const cancelled = await openFixture(FAN_OUT);
    try {
      const alpha = attemptIdOf(cancelled, "alpha");
      const beta = attemptIdOf(cancelled, "beta");
      const applied = await control(cancelled, {
        graph_id: cancelled.graphId,
        command: "cancel",
        reason: "stop the whole run",
      });
      expect(applied.kind).toBe("applied");
      expect(applied.scope).toBe("run");
      expect(applied.runControl?.command).toBe("cancel");
      expect(runControl(cancelled)?.command).toBe("cancel");
      expect(decisions(cancelled).map((entry) => entry.attemptId)).toEqual([alpha, beta]);

      // A SUBMISSION TO A CONTROLLED RUN STILL ANSWERS `control-stopped` — the
      // run-wide code keeps its own name, and never becomes `attempt-stopped`.
      const held = await submit(
        cancelled,
        "alpha",
        "done",
        credentialOf(cancelled, alpha),
        childSessionOf(alpha),
      );
      expect(held.decision).toBeUndefined();
      expect(held.refusals[0]?.code).toBe("control-stopped");

      // AND THE ENGINE'S EXISTING REFUSAL FOR A NODE-SCOPED RETRY OF A STOPPED
      // RUN IS UNCHANGED.
      const retried = await control(cancelled, {
        graph_id: cancelled.graphId,
        command: "retry",
        node_id: "alpha",
        reason: "after the stop",
      });
      expect(retried.kind).toBe("refused");
      expect(retried.refusals?.[0]?.code).toBe("run-stopped");
    } finally {
      cancelled.host.close();
    }

    const budgetStopped = await openFixture(FAN_OUT);
    try {
      const beta = attemptIdOf(budgetStopped, "beta");
      const applied = await control(budgetStopped, {
        graph_id: budgetStopped.graphId,
        command: "budget-stop",
        reason: "the declared budget is spent",
      });
      expect(applied.kind).toBe("applied");
      expect(applied.scope).toBe("run");
      expect(applied.runControl?.command).toBe("budget-stop");
      expect(runControl(budgetStopped)?.command).toBe("budget-stop");
      expect(decisions(budgetStopped).map((entry) => entry.command)).toEqual([
        "budget-stop",
        "budget-stop",
      ]);

      const held = await submit(
        budgetStopped,
        "beta",
        "done",
        credentialOf(budgetStopped, beta),
        childSessionOf(beta),
      );
      expect(held.decision).toBeUndefined();
      expect(held.refusals[0]?.code).toBe("control-stopped");
    } finally {
      budgetStopped.host.close();
    }
  });
});

// ── The inverse race: a decision that commits while a gate runs ─────────────

describe("attempt-scoped stop — the inverse race", () => {
  it("refuses the in-flight submission with attempt-stopped and writes no success", async () => {
    // The gate needs the fixture's store root, and the fixture needs the gate to
    // build its host: the holder is filled as soon as the fixture exists, and the
    // implementation runs only when a submission is validated.
    const race: { fixture?: Fixture; report?: RaceReport } = {};
    const fixture = await openFixture(GATED, {
      gate: {
        validator: INVERSE_RACE_GATE,
        version: 1,
        implementation: (request) => {
          const opened = race.fixture;
          if (opened === undefined) {
            throw new Error("fixture: the inverse-race fixture was not bound before the gate ran");
          }
          const report = applyAttemptStopFromAnotherProcess({
            dir: opened.dir,
            storeRoot: opened.storeRoot,
            graphId: request.identity.graphId,
            nodeId: "work",
            attemptId: request.identity.attemptId,
            reason: "the worker process died while the gate was running",
          });
          race.report = report;
          if (report.verdict !== "recorded") {
            throw new Error(
              "fixture: the second process did not record the stop: " + JSON.stringify(report),
            );
          }
          return { kind: "pass" };
        },
      },
    });
    race.fixture = fixture;
    try {
      const work = attemptIdOf(fixture, "work");
      const answer = await submit(
        fixture,
        "work",
        "done",
        credentialOf(fixture, work),
        childSessionOf(work),
      );
      // THE INVERSE RACE. The stopping decision committed while the gate ran —
      // AFTER the run path's pre-transaction read and BEFORE its acceptance
      // transaction — and the answer is the attempt-scoped refusal, never a
      // business success and never `control-stopped` (the run is still live).
      expect(answer.decision).toBeUndefined();
      expect(answer.refusals[0]?.code).toBe("attempt-stopped");
      expect(answer.refusals[0]?.message).toContain("failure");
      expect(race.report?.verdict).toBe("recorded");

      // THE DURABLE ROWS: the decision stands, the run holds NO control fact,
      // and nothing was accepted.
      expect(decisions(fixture).map((entry) => [entry.attemptId, entry.command])).toEqual([
        [work, "failure"],
      ]);
      expect(runControl(fixture)).toBeUndefined();
      expect(receiptsOf(fixture)).toBe(0);
      expect(withStore(fixture, (store) => store.acceptedEvents(fixture.graphId))).toEqual([]);
      expect(nodeEntry(readState(fixture), "work")).toMatchObject({
        status: "dispatched",
        attemptId: work,
      });
      expect(readState(fixture).phase).toBe("executing");
    } finally {
      fixture.host.close();
    }
  });
});

// ── The launch decision: a stopped attempt is never (re-)launched ───────────

describe("attempt-scoped stop — the launch decision", () => {
  it("never (re-)launches a stopped attempt's effect, while the sibling in the same window is launched", async () => {
    const fixture = await openFixture(FAN_OUT, {
      // The commit-then-crash window: the arming transaction committed and the
      // synchronous delivery for `alpha` refused, so BOTH entry attempts'
      // effects are durable `pending` rows nobody created.
      deliverThrowsFor: (request) => request.nodeId === "alpha",
      // And the platform can PROVE no execution exists for such an effect,
      // which is the answer that releases the create right again.
      queryProvesAbsence: true,
    });
    try {
      expect(fixture.startFailure).toBeDefined();
      const alpha = fixture.createCalls[0]?.attemptId;
      expect(alpha?.startsWith("alpha#")).toBe(true);
      if (alpha === undefined) throw new Error("fixture: the start attempted no create");
      // The sibling entry node's attempt id is the NEXT graph-scoped sequence:
      // the failed start never delivered it, so it is derived from the plan's
      // node order rather than from a delivery.
      const beta = "beta#" + String(Number(alpha.slice("alpha#".length)) + 1);
      expect(fixture.createCalls.map((request) => request.attemptId)).toEqual([alpha]);
      expect(effectStatusOf(fixture, alpha)).toBe("pending");
      expect(effectStatusOf(fixture, beta)).toBe("pending");

      // THE STOP IS ATTEMPT-SCOPED: the run holds no control fact, so the boot
      // sweep below really does reach the stopped attempt's unsettled effect.
      const stopped = await control(fixture, {
        graph_id: fixture.graphId,
        command: "failure",
        node_id: "alpha",
        reason: "the alpha worker died",
      });
      expect(stopped.kind).toBe("applied");
      expect(runControl(fixture)).toBeUndefined();

      const resumed = await fixture.host.startDeclaredGraph(fixture.graphId, {
        sessionId: DECLARER,
        agent: "agent.declarer",
      });
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") throw new Error("fixture: the sweep was refused");

      // THE STOPPED ATTEMPT IS NOT (RE-)LAUNCHED: exactly one create was ever
      // attempted for it, its effect stays `pending` and VISIBLE, and the sweep
      // reports the named refusal instead of hiding the work.
      expect(resumed.refusals.map((entry) => entry.code)).toEqual(["attempt-stopped"]);
      expect(
        fixture.createCalls.filter((request) => request.attemptId === alpha),
      ).toHaveLength(1);
      expect(effectStatusOf(fixture, alpha)).toBe("pending");

      // AND THE SIBLING IN THE SAME WINDOW IS LAUNCHED: the recovery is not
      // disabled wholesale, only the stopped attempt is held back.
      expect(resumed.dispatched.map((request) => request.attemptId)).toEqual([beta]);
      expect(effectStatusOf(fixture, beta)).toBe("started");
    } finally {
      fixture.host.close();
    }
  });
});

// ── The window between the two reads: which fact is read LAST decides ───────

describe("stopping control — the window between the run fact and the decision", () => {
  it("answers control-stopped when a run-wide cancel commits inside the window, and writes nothing", async () => {
    const fixture = await openFixture(FAN_OUT);
    try {
      const alpha = attemptIdOf(fixture, "alpha");
      const beta = attemptIdOf(fixture, "beta");
      const credential = credentialOf(fixture, alpha);
      // Everything this submission could write, as it stands BEFORE the call.
      const before = readState(fixture);
      const effectBefore = effectStatusOf(fixture, alpha);
      const reservationBefore = reservationStatusOf(fixture, alpha);
      const window = installControlWindow(fixture, {
        command: "cancel",
        reason: "the operator cancelled the run while the submission was being decided",
        targets: [
          { nodeId: "alpha", attemptId: alpha },
          { nodeId: "beta", attemptId: beta },
        ],
      });
      let answer: SubmitAnswer;
      try {
        answer = await submit(fixture, "alpha", "done", credential, childSessionOf(alpha));
      } finally {
        window.restore();
      }

      // THE WINDOW REALLY OPENED: the run fact was read (and found unclaimed)
      // BEFORE the second process committed — the first read of a submission
      // whose answer would be `control-stopped` anyway proves nothing — and the
      // command committed BEFORE this submission read the attempt's decision.
      expect(window.injection.fired).toBe(true);
      expect(window.injection.report?.ok).toBe(true);
      expect(window.injection.report?.verdict).toBe("recorded,recorded");
      expect(window.injection.report?.runControl).toBe("cancel");

      // THE CALLER IS TOLD THE TRUTH. The RUN stands stopped, so the refusal is
      // the RUN-LEVEL one: `control-stopped`, naming the command that stopped
      // it. `attempt-stopped` would be a false statement about the run — its
      // text says the run itself is not stopped and its siblings still settle.
      expect(answer.decision).toBeUndefined();
      expect(answer.refusals[0]?.code).toBe("control-stopped");
      expect(answer.refusals[0]?.message).toContain("cancel");

      // AND NOTHING WAS WRITTEN FOR THE ATTEMPT: no receipt, no accepted event,
      // no accepted result, and the state, the effect and the budget
      // reservation are exactly what they were before the call.
      expect(receiptsOf(fixture)).toBe(0);
      expect(withStore(fixture, (store) => store.acceptedEvents(fixture.graphId))).toEqual([]);
      expect(
        withStore(fixture, (store) => store.readAcceptedResult(fixture.graphId, alpha)),
      ).toBeUndefined();
      expect(readState(fixture)).toEqual(before);
      expect(effectStatusOf(fixture, alpha)).toBe(effectBefore);
      expect(reservationStatusOf(fixture, alpha)).toBe(reservationBefore);

      // THE FACTS THAT STAND: the run-wide command claimed the run's control
      // fact and left its decision on BOTH in-flight attempts.
      expect(runControl(fixture)?.command).toBe("cancel");
      expect(
        decisions(fixture)
          .map((entry) => entry.attemptId + ":" + entry.command)
          .sort(),
      ).toEqual([alpha + ":cancel", beta + ":cancel"].sort());
    } finally {
      fixture.host.close();
    }
  });

  it("still answers attempt-stopped when a node-scoped failure commits inside the same window", async () => {
    const fixture = await openFixture(FAN_OUT);
    try {
      const alpha = attemptIdOf(fixture, "alpha");
      const credential = credentialOf(fixture, alpha);
      const before = readState(fixture);
      const window = installControlWindow(fixture, {
        command: "failure",
        reason: "the alpha worker died while the submission was being decided",
        targets: [{ nodeId: "alpha", attemptId: alpha }],
      });
      let answer: SubmitAnswer;
      try {
        answer = await submit(fixture, "alpha", "done", credential, childSessionOf(alpha));
      } finally {
        window.restore();
      }

      // THE SAME WINDOW, THE OTHER SCOPE: a `failure` claims no run fact, so the
      // classification must NOT have become run-level. The code is
      // `attempt-stopped`, the run keeps executing, and nothing was written.
      expect(window.injection.fired).toBe(true);
      expect(window.injection.report?.ok).toBe(true);
      expect(window.injection.report?.verdict).toBe("recorded");
      expect(window.injection.report?.runControl).toBeUndefined();

      expect(answer.decision).toBeUndefined();
      expect(answer.refusals[0]?.code).toBe("attempt-stopped");
      expect(answer.refusals[0]?.message).toContain("NOT stopped");
      expect(runControl(fixture)).toBeUndefined();
      expect(receiptsOf(fixture)).toBe(0);
      expect(withStore(fixture, (store) => store.acceptedEvents(fixture.graphId))).toEqual([]);
      expect(readState(fixture)).toEqual(before);
      expect(decisions(fixture).map((entry) => entry.attemptId + ":" + entry.command)).toEqual([
        alpha + ":failure",
      ]);
    } finally {
      fixture.host.close();
    }
  });
  it("answers controlled at the LEDGER when a run-wide cancel commits inside the store's own window", async () => {
    const fixture = await openFixture(FAN_OUT);
    try {
      const alpha = attemptIdOf(fixture, "alpha");
      const beta = attemptIdOf(fixture, "beta");
      const before = readState(fixture);
      const window = installStoreControlWindow(fixture, {
        reason: "the operator cancelled the run while the batch was being classified",
        targets: [
          { nodeId: "alpha", attemptId: alpha },
          { nodeId: "beta", attemptId: beta },
        ],
      });
      let verdict: CommitResult;
      try {
        verdict = withStore(fixture, (store) =>
          store.commitAccepted({
            receipt: {
              graphId: fixture.graphId,
              attemptId: alpha,
              submissionId: "submission:window",
              planRevision: "plan.attempt-stop",
              proposalDigest: "digest:window",
              decision: "accepted",
              committedAt: AT,
            },
            acceptedEvent: {
              graphId: fixture.graphId,
              attemptId: alpha,
              submissionId: "submission:window",
              planRevision: "plan.attempt-stop",
              outcomeId: "done",
              acceptedAt: AT,
            },
          }),
        );
      } finally {
        window.restore();
      }

      // THE WINDOW REALLY OPENED at the ledger's own boundary: the run fact was
      // read (and found unclaimed) before the second process committed.
      expect(window.injection.fired).toBe(true);
      expect(window.injection.report?.ok).toBe(true);
      expect(window.injection.report?.runControl).toBe("cancel");

      // THE VERDICT AGREES WITH THE FACT THAT STANDS. The batch is refused by
      // the RUN's stop — `controlled`, naming `cancel` — never `attempt-stopped`
      // with a reason that says the run's other attempts keep executing.
      expect(verdict.kind).toBe("controlled");
      if (verdict.kind !== "controlled") {
        throw new Error("fixture: expected the run-control verdict, got " + verdict.kind);
      }
      expect(verdict.control.command).toBe("cancel");

      // AND NOTHING LANDED: the whole batch was refused, so there is no receipt,
      // no accepted event and no state change.
      expect(receiptsOf(fixture)).toBe(0);
      expect(withStore(fixture, (store) => store.acceptedEvents(fixture.graphId))).toEqual([]);
      expect(readState(fixture)).toEqual(before);
      expect(runControl(fixture)?.command).toBe("cancel");
    } finally {
      fixture.host.close();
    }
  });
});
