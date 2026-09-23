/**
 * Cross-process worker for the P3 item 2 RETRY restart evidence.
 *
 * WHY THIS FILE EXISTS. Plan §4 (P3) requires every control command to be covered
 * through "重启后继续" (continue after restart), and §5 says a temporary probe can
 * never be the sole acceptance evidence. The tracked restart case in
 * `tests/graph/run-reexecution.test.ts` replaces the host OBJECT inside one
 * process — the same connection, the same memory — so it is not a process
 * boundary. This worker is spawned with `Bun.spawn(process.execPath, …)` by
 * `tests/graph/retry-restart-cross-process.test.ts`: the retry is DECIDED in one
 * OS process and honoured in another that has never seen its memory.
 *
 *     bun tests/graph/helpers/retry-restart-xproc-worker.ts --mode <mode> ...
 *
 * Modes:
 *   - `seed`   declares the fixture graph, starts it (attempt `work#1` is
 *              dispatched and confirmed), applies a NODE-SCOPED `retry` through
 *              the shipped control entry WITHOUT the host's follow-up, and
 *              EXITS — exactly the crash window a restart leaves behind.
 *   - `resume` opens a fresh host over the same store root and resumes the
 *              declared graph, reporting which attempt it delivered and whether
 *              the delivered credential matches the PERSISTED digest.
 *   - `order`  completes the first run through the shipped submission ingress and
 *              records a RUN-SCOPED `retry` order WITHOUT the follow-up that
 *              would mint the successor run: the terminal run is closed and its
 *              order is owed, which is the state the two racers below need.
 *   - `mint-race` reads the owed order and the current run, waits on the parent's
 *              barrier, then runs the two conditionals a re-execution is built
 *              from (`mintNextRun` + `markReexecutionExecuted`) in ONE
 *              transaction. Exactly one of two such processes can win; the loser
 *              names the conditional that refused it and writes nothing.
 *
 * Every mode prints exactly ONE JSON line on stdout — `{"pid":n,"ok":true,…}` on
 * success, `{"pid":n,"ok":false,…}` plus a non-zero exit on failure.
 *
 * PRIVACY. This fixture receives store roots under the OS temp directory, the
 * deterministic attempt ids the graph mints, and one declaring session id. It
 * never prints a credential VALUE, a real home-directory path or a session
 * transcript: the report carries ids, counts, booleans and the RESULT of the
 * digest comparison only.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../../src/graph/compiler/declaration-v3.ts";
import { OutcomeHost } from "../../../src/graph/host/outcome-host.ts";
import { attemptCredentialDigest } from "../../../src/graph/outcome/attempt-credential.ts";
import type { OutcomeDispatchRequest } from "../../../src/graph/outcome/dispatch-effects.ts";
import { SqliteAcceptanceLedger } from "../../../src/graph/ledger/sqlite-ledger.ts";
import { createValidatorRegistry } from "../../../src/graph/outcome/validators.ts";
import { GraphStore } from "../../../src/graph/store/graph-store.ts";
import { runGraphControlEntry } from "../../../src/graph/tools/control-entry.ts";
import { createGraphToolSet } from "../../../src/graph/tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../../../src/graph/tools/index.ts";
import type {
  CanonicalToolContext,
  CanonicalToolDef,
} from "../../../src/platform/types.ts";

/** The one graph this fixture drives: a single entry node. */
export const RETRY_RESTART_GRAPH = "retry.restart-xproc";

/** The session that declares the graph and is therefore allowed to control it. */
export const RETRY_RESTART_DECLARER = "session.declarer-xproc";

/** A fixed epoch-ms instant, passed to every process, so nothing reads a clock. */
export const RETRY_RESTART_AT = 1_700_000_000_000;

/** The declaration the seeding process persists. */
export function retryRestartDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: RETRY_RESTART_GRAPH,
    nodes: [
      { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
    ],
    edges: [],
  };
}

/**
 * A DETERMINISTIC credential source: the successor attempt's value is derived
 * from its attempt binding, so a test can compare a digest without ever printing
 * or asserting a secret.
 */
const credentialSource = (binding: { readonly attemptId: string }): string =>
  "credential:" + binding.attemptId;

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

// ── Argument access ─────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

/** The value of `--name`, or undefined. */
function arg(name: string): string | undefined {
  const index = argv.indexOf("--" + name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** The value of `--name`, refused when absent or empty. */
function required(name: string): string {
  const value = arg(name);
  if (value === undefined || value.length === 0) {
    throw new Error("retry-restart-xproc-worker: --" + name + " is required");
  }
  return value;
}

/** The epoch-ms instant this process uses for every write. */
function instant(): number {
  const raw = arg("now");
  const value = raw === undefined ? RETRY_RESTART_AT : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("retry-restart-xproc-worker: --now must be epoch milliseconds");
  }
  return value;
}

// ── The two modes ───────────────────────────────────────────────────────────

/**
 * Declare, start, then RETRY and exit — the retry is committed and its successor
 * effect is left for the next process.
 */
async function seed(storeRoot: string, workspaceDir: string): Promise<void> {
  mkdirSync(storeRoot, { recursive: true });
  const now = instant();
  const delivered: string[] = [];
  let host: OutcomeHost | undefined;
  const opened = OutcomeHost.open({
    workspaceDir,
    storeRoot,
    deliver: (request, effect) => {
      delivered.push(request.attemptId);
      host?.confirmExecution(effect, { executionId: childSessionOf(request.attemptId) });
    },
    validators: createValidatorRegistry([]),
    declareInvocationIdentity: false,
    workerSessionOf: (execution) => execution.executionId,
  });
  host = opened;
  try {
    const toolset = createGraphToolSet({
      stateDir: workspaceDir,
      credentialIsolation: opened.credentialIsolation,
      hostIdentity: opened.workerIdentity,
      outcomeDispatch: opened.dispatch,
      outcomeValidators: createValidatorRegistry([]),
      outcomeArtifactRoot: workspaceDir,
      outcomeMintCredential: credentialSource,
    });
    const tools: Record<string, CanonicalToolDef> = opened.bindTools(
      createOutcomeGraphTools(toolset),
    );
    const declare = tools["graph_declare"];
    if (declare === undefined) {
      throw new Error("retry-restart-xproc-worker: the shipped graph_declare tool is absent");
    }
    const declared = String(
      await declare.execute(
        { declaration: retryRestartDeclaration() },
        makeContext(RETRY_RESTART_DECLARER, "agent.declarer", workspaceDir),
      ),
    );
    if (declared.includes("graph_declare failed:")) {
      throw new Error("retry-restart-xproc-worker: graph_declare refused the declaration");
    }
    const started = await opened.startDeclaredGraph(RETRY_RESTART_GRAPH, {
      sessionId: RETRY_RESTART_DECLARER,
      agent: "agent.declarer",
    });
    if (started.kind !== "started") {
      throw new Error(
        "retry-restart-xproc-worker: the graph did not start (" + started.kind + ")",
      );
    }
    // THE CRASH WINDOW. The shipped control entry records the trusted retry —
    // decision, successor attempt, successor credential and successor effect —
    // and NOTHING honours it yet: the host's follow-up is deliberately not run,
    // so the successor's effect is still pending when this process exits.
    const retry = runGraphControlEntry(
      {
        storeDirectory: storeRoot,
        now: now + 1_000,
        credentialIsolation: opened.credentialIsolation,
        mintCredential: credentialSource,
      },
      {
        graph_id: RETRY_RESTART_GRAPH,
        command: "retry",
        node_id: "work",
        reason: "supersede before the crash",
      },
      RETRY_RESTART_DECLARER,
      "agent.declarer",
    );
    if (retry.kind !== "applied") {
      throw new Error(
        "retry-restart-xproc-worker: the retry was refused (" +
          retry.refusals.map((refusal) => refusal.code).join(",") +
          ")",
      );
    }
    report({
      mode: "seed",
      delivered,
      retryKind: retry.kind,
      retryScope: retry.scope,
      minted: retry.minted.map((attempt) => attempt.attemptId),
      runId: retry.runId,
    });
  } finally {
    opened.close();
  }
}

/** Resume the declared graph in a fresh process and report what it launched. */
async function resume(storeRoot: string, workspaceDir: string): Promise<void> {
  const delivered: OutcomeDispatchRequest[] = [];
  let host: OutcomeHost | undefined;
  const opened = OutcomeHost.open({
    workspaceDir,
    storeRoot,
    deliver: (request, effect) => {
      delivered.push(request);
      host?.confirmExecution(effect, { executionId: childSessionOf(request.attemptId) });
    },
    validators: createValidatorRegistry([]),
    declareInvocationIdentity: false,
    workerSessionOf: (execution) => execution.executionId,
  });
  host = opened;
  try {
    const resumed = await opened.startDeclaredGraph(RETRY_RESTART_GRAPH, {
      sessionId: RETRY_RESTART_DECLARER,
      agent: "agent.declarer",
    });
    if (resumed.kind !== "resumed") {
      throw new Error(
        "retry-restart-xproc-worker: the graph did not resume (" + resumed.kind + ")",
      );
    }
    // THE VALUE IS NEVER PRINTED. Every delivered credential must be the value
    // the PERSISTED state's digest was written for — that is the whole check.
    const credentialVerified = delivered.every(
      (request) => persistedDigestOf(storeRoot, request.attemptId) === attemptCredentialDigest(request.credential),
    );
    report({
      mode: "resume",
      resumedKind: resumed.kind,
      delivered: delivered.map((request) => request.attemptId),
      armed: resumed.armed.map((attempt) => attempt.attemptId),
      unsettled: resumed.unsettledEffects.map((effect) => effect.effectId).sort(),
      credentialVerified,
    });
  } finally {
    opened.close();
  }
}

/**
 * Complete the first run through the shipped ingress, then record a RUN-SCOPED
 * `retry` order WITHOUT honouring it: the successor run is left to the racers.
 */
async function order(storeRoot: string, workspaceDir: string): Promise<void> {
  mkdirSync(storeRoot, { recursive: true });
  const now = instant();
  const delivered: OutcomeDispatchRequest[] = [];
  let host: OutcomeHost | undefined;
  const opened = OutcomeHost.open({
    workspaceDir,
    storeRoot,
    deliver: (request, effect) => {
      delivered.push(request);
      host?.confirmExecution(effect, { executionId: childSessionOf(request.attemptId) });
    },
    validators: createValidatorRegistry([]),
    declareInvocationIdentity: false,
    workerSessionOf: (execution) => execution.executionId,
  });
  host = opened;
  try {
    const toolset = createGraphToolSet({
      stateDir: workspaceDir,
      credentialIsolation: opened.credentialIsolation,
      hostIdentity: opened.workerIdentity,
      outcomeDispatch: opened.dispatch,
      outcomeValidators: createValidatorRegistry([]),
      outcomeArtifactRoot: workspaceDir,
      outcomeMintCredential: credentialSource,
    });
    const tools: Record<string, CanonicalToolDef> = opened.bindTools(
      createOutcomeGraphTools(toolset),
    );
    const declare = tools["graph_declare"];
    const submit = tools["graph_submit_outcome"];
    if (declare === undefined || submit === undefined) {
      throw new Error("retry-restart-xproc-worker: the shipped tools are absent");
    }
    const declared = String(
      await declare.execute(
        { declaration: retryRestartDeclaration() },
        makeContext(RETRY_RESTART_DECLARER, "agent.declarer", workspaceDir),
      ),
    );
    if (declared.includes("graph_declare failed:")) {
      throw new Error("retry-restart-xproc-worker: graph_declare refused the declaration");
    }
    const started = await opened.startDeclaredGraph(RETRY_RESTART_GRAPH, {
      sessionId: RETRY_RESTART_DECLARER,
      agent: "agent.declarer",
    });
    if (started.kind !== "started") {
      throw new Error("retry-restart-xproc-worker: the graph did not start");
    }
    const first = delivered.find((request) => request.attemptId === "work#1");
    if (first === undefined) {
      throw new Error("retry-restart-xproc-worker: work#1 was never dispatched");
    }
    const settled = String(
      await submit.execute(
        {
          graph_id: RETRY_RESTART_GRAPH,
          node_id: "work",
          outcome_id: "done",
          credential: first.credential,
        },
        makeContext(childSessionOf("work#1"), "agent.work", workspaceDir),
      ),
    );
    if (!settled.includes('"accepted"')) {
      throw new Error("retry-restart-xproc-worker: work#1 did not settle");
    }
    // THE ORDER ONLY: no follow-up runs here, so run 1 is closed and NO successor
    // exists yet — exactly the crash window the two racers start from.
    const ordered = runGraphControlEntry(
      { storeDirectory: storeRoot, now: now + 1_000 },
      { graph_id: RETRY_RESTART_GRAPH, command: "retry", reason: "re-run the whole graph" },
      RETRY_RESTART_DECLARER,
      "agent.declarer",
    );
    if (ordered.kind !== "applied" || ordered.scope !== "run") {
      throw new Error(
        "retry-restart-xproc-worker: the run-scoped order was refused (" +
          (ordered.kind === "applied" ? ordered.scope : ordered.refusals[0]?.code ?? "unknown") +
          ")",
      );
    }
    report({
      mode: "order",
      settled: "work#1",
      orderRecorded: ordered.reexecution !== undefined,
      control: ordered.runControl?.command,
      successorRunId: ordered.reexecution?.order.successorRunId,
    });
  } finally {
    opened.close();
  }
}

/**
 * One side of a REAL two-process race for the successor run.
 *
 * Both processes read the SAME current run and the SAME owed order BEFORE the
 * barrier, then run the two conditionals a re-execution is built from in one
 * transaction: `mintNextRun` (conditional on the run it supersedes still being
 * current) and `markReexecutionExecuted` (conditional on the order being
 * unconsumed). Whichever commits first wins; the other is refused by the
 * conditional that no longer holds and writes NOTHING.
 */
async function mintRace(
  storeRoot: string,
  markerDir: string,
  id: string,
): Promise<void> {
  const now = instant();
  const ledger = await SqliteAcceptanceLedger.create(storeRoot);
  try {
    const current = ledger.runs.readRun(RETRY_RESTART_GRAPH);
    if (current === undefined) {
      throw new Error("retry-restart-xproc-worker: the graph holds no run");
    }
    const owed = ledger.runs.readReexecution(RETRY_RESTART_GRAPH, current.runId);
    if (owed === undefined) {
      throw new Error("retry-restart-xproc-worker: the run carries no re-execution order");
    }
    writeFileSync(join(markerDir, "ready-" + id + ".marker"), "");
    await waitForMarker(join(markerDir, "go.marker"));
    const successorRunId =
      RETRY_RESTART_GRAPH + "@" + String(now) + "+" + String(current.runSeq + 1);
    let won = false;
    let reason = "";
    try {
      ledger.runInTransaction((tx) => {
        const successor = tx.runs?.mintNextRun(
          {
            graphId: RETRY_RESTART_GRAPH,
            runId: successorRunId,
            startedAt: now,
            planRevision: current.planRevision,
          },
          current.runId,
        );
        if (successor === undefined) throw new Error("current-run-moved");
        const marked = tx.runs?.markReexecutionExecuted(
          RETRY_RESTART_GRAPH,
          current.runId,
          successorRunId,
          now,
        );
        if (marked !== true) throw new Error("order-already-consumed");
        won = true;
      });
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    report({
      mode: "mint-race",
      racer: id,
      won,
      reason,
      successorRunId: won ? successorRunId : undefined,
    });
  } finally {
    ledger.close();
  }
}

/** Wait for one barrier marker file, or fail with the path that never arrived. */
async function waitForMarker(path: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (existsSync(path)) return;
    if (Date.now() > deadline) {
      throw new Error("retry-restart-xproc-worker: the barrier marker never arrived: " + path);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/** The persisted credential digest of one attempt, read from the graph's state. */
function persistedDigestOf(storeRoot: string, attemptId: string): unknown {
  const store = GraphStore.openFile(storeRoot);
  try {
    const record = store.readGraphState(RETRY_RESTART_GRAPH);
    const body =
      typeof record?.body === "object" && record.body !== null
        ? (record.body as Record<string, unknown>)
        : {};
    const nodes = Array.isArray(body["nodes"])
      ? (body["nodes"] as readonly Record<string, unknown>[])
      : [];
    return nodes.find((node) => node["attemptId"] === attemptId)?.["attemptCredentialDigest"];
  } finally {
    store.close();
  }
}

/** Print the ONE report line this worker's parent parses. */
function report(fields: Readonly<Record<string, unknown>>): void {
  console.log(JSON.stringify({ pid: process.pid, ok: true, ...fields }));
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mode = required("mode");
  const storeRoot = required("root");
  const workspaceDir = required("workspace");
  if (mode === "seed") {
    await seed(storeRoot, workspaceDir);
    return;
  }
  if (mode === "resume") {
    await resume(storeRoot, workspaceDir);
    return;
  }
  if (mode === "order") {
    await order(storeRoot, workspaceDir);
    return;
  }
  if (mode === "mint-race") {
    await mintRace(storeRoot, required("marker-dir"), required("id"));
    return;
  }
  throw new Error("retry-restart-xproc-worker: unknown --mode " + JSON.stringify(mode));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.log(
      JSON.stringify({
        pid: process.pid,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  });
}
