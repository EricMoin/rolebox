/**
 * Cross-process worker for the P4.3 STOP-RECOVERY evidence (G4, R5).
 *
 * WHY THIS FILE EXISTS. The P4.3 gap analysis confirmed R5 is implemented, but
 * its RECOVERABILITY was proven only by a throwaway probe run inside ONE
 * process. A stop that a fresh process cannot read and recover from is not
 * recoverable: this worker is spawned with Bun.spawn(process.execPath, ...) and
 * the DECIDING and the HONOURING halves run in different OS processes that never
 * share memory.
 *
 *   bun tests/graph/helpers/stop-recovery-xproc-worker.ts --mode <mode> ...
 *
 * Modes:
 *   - stop-cap      declares the capped loop, starts it, drives it through the
 *                   shipped submission ingress until the DECLARED cap stops the
 *                   run (loop-exhausted), reports the persisted stop, and EXITS.
 *   - stop-stalled  the same, for the loop whose DECLARED progress policy
 *                   soft-exits on a repeated revision (progress-stalled).
 *   - recover       a FRESH host over the same store root, which applies the
 *                   shipped run-scoped `retry` through graph_control, lets the
 *                   installed follow-up mint and start the successor run, and
 *                   reports both runs as the STORE answers them.
 *
 * Every mode prints exactly ONE JSON line on stdout — {"pid":n,"ok":true,...} on
 * success, {"pid":n,"ok":false,...} plus a non-zero exit on failure.
 *
 * PRIVACY. Store roots live under the OS temp directory; reports carry attempt
 * ids, status tokens and reason codes only — never a credential value, a real
 * home-directory path or a session transcript.
 */

import { mkdirSync } from "node:fs";

import type { GraphDeclarationV3 } from "../../../src/graph/compiler/declaration-v3.ts";
import { OutcomeHost, withCancelDelivery } from "../../../src/graph/host/outcome-host.ts";
import type { OutcomeDispatchRequest } from "../../../src/graph/outcome/dispatch-effects.ts";
import { createValidatorRegistry } from "../../../src/graph/outcome/validators.ts";
import { GraphStore } from "../../../src/graph/store/graph-store.ts";
import { createGraphToolSet } from "../../../src/graph/tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../../../src/graph/tools/index.ts";
import type {
  CanonicalToolContext,
  CanonicalToolDef,
} from "../../../src/platform/types.ts";

/** The graph stopped by its DECLARED cap. */
export const STOP_RECOVERY_CAP_GRAPH = "p43.stop-recovery.cap";

/** The graph stopped by its DECLARED progress policy. */
export const STOP_RECOVERY_STALLED_GRAPH = "p43.stop-recovery.stalled";

/** The session that declares every fixture graph and is allowed to control it. */
export const STOP_RECOVERY_DECLARER = "session.stop-recovery-xproc";

/** A fixed epoch-ms instant, passed to every process, so nothing reads a clock. */
export const STOP_RECOVERY_AT = 1_700_000_000_000;

/** The loop both fixtures run: work -> review -> (revise) -> work. */
function loopDeclaration(options: {
  readonly name: string;
  readonly maxTraversals: number;
  readonly maxUnchanged?: number;
}): GraphDeclarationV3 {
  return {
    version: 3,
    name: options.name,
    nodes: [
      { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
      {
        id: "review",
        agent: "agent.review",
        prompt: "Review the work.",
        outcomes: [{ id: "revise" }, { id: "approve" }],
      },
    ],
    edges: [
      { from: "work", to: "review", outcome: "done" },
      { from: "review", to: "work", outcome: "revise" },
    ],
    loop_groups: [
      {
        id: "revise-loop",
        nodes: ["work", "review"],
        max_traversals: options.maxTraversals,
        continuation_outcome: "revise",
        exit_outcome: "approve",
        ...(options.maxUnchanged === undefined
          ? {}
          : {
              progress: {
                evaluator: "revision-token",
                version: 1,
                subject: "revision",
                max_unchanged: options.maxUnchanged,
              },
            }),
      },
    ],
  };
}

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

/** The value of --name, or undefined. */
function arg(name: string): string | undefined {
  const index = argv.indexOf("--" + name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** The value of --name, refused when absent or empty. */
function required(name: string): string {
  const value = arg(name);
  if (value === undefined || value.length === 0) {
    throw new Error("stop-recovery-xproc-worker: --" + name + " is required");
  }
  return value;
}

/** The epoch-ms instant this process uses for every write. */
function instant(): number {
  const raw = arg("now");
  const value = raw === undefined ? STOP_RECOVERY_AT : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("stop-recovery-xproc-worker: --now must be epoch milliseconds");
  }
  return value;
}

/** One field of an unknown JSON value, or undefined. */
function fieldOf(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[field];
}

/** One field of an unknown JSON value when it is a non-empty string. */
function stringOf(value: unknown, field: string): string | undefined {
  const found = fieldOf(value, field);
  return typeof found === "string" && found.length > 0 ? found : undefined;
}

// ── The shipped assembly ────────────────────────────────────────────────────

interface Opened {
  readonly host: OutcomeHost;
  readonly tools: Record<string, CanonicalToolDef>;
  readonly delivered: OutcomeDispatchRequest[];
  readonly workspaceDir: string;
}

/** Open a REAL host over the store root and bind the SHIPPED tool set. */
function openHost(storeRoot: string, workspaceDir: string): Opened {
  mkdirSync(storeRoot, { recursive: true });
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
  const toolset = createGraphToolSet({
    stateDir: workspaceDir,
    credentialIsolation: opened.credentialIsolation,
    hostIdentity: opened.workerIdentity,
    outcomeDispatch: opened.dispatch,
    outcomeValidators: createValidatorRegistry([]),
    outcomeArtifactRoot: workspaceDir,
    outcomeMintCredential: (binding) => "credential:" + binding.attemptId,
  });
  // The wrapper both shipped entries install, so an applied control command
  // really hands its follow-up to the platform inside the tool call.
  const tools = opened.bindTools(withCancelDelivery(createOutcomeGraphTools(toolset), opened));
  return { host: opened, tools, delivered, workspaceDir };
}

/** The one shipped tool this worker needs, or a fixture error. */
function toolOf(opened: Opened, name: string): CanonicalToolDef {
  const found = opened.tools[name];
  if (found === undefined) {
    throw new Error("stop-recovery-xproc-worker: the shipped " + name + " tool is absent");
  }
  return found;
}

// ── The seed modes ──────────────────────────────────────────────────────────

/**
 * Declare, start, then drive the loop until the DECLARED limit stops the run —
 * and exit. The stop is committed by the acceptance that triggers it, so the
 * next process reads it from the store and nothing else.
 */
async function stopRun(
  storeRoot: string,
  workspaceDir: string,
  declaration: GraphDeclarationV3,
  roundPayload: unknown,
): Promise<void> {
  const graphId = declaration.name;
  const opened = openHost(storeRoot, workspaceDir);
  try {
    const declare = toolOf(opened, "graph_declare");
    const submit = toolOf(opened, "graph_submit_outcome");
    const declared = String(
      await declare.execute(
        { declaration },
        makeContext(STOP_RECOVERY_DECLARER, "agent.declarer", workspaceDir),
      ),
    );
    if (declared.includes("graph_declare failed:")) {
      throw new Error("stop-recovery-xproc-worker: graph_declare refused the declaration");
    }
    const started = await opened.host.startDeclaredGraph(graphId, {
      sessionId: STOP_RECOVERY_DECLARER,
      agent: "agent.declarer",
    });
    if (started.kind !== "started") {
      throw new Error("stop-recovery-xproc-worker: the graph did not start (" + started.kind + ")");
    }
    // The CURRENT attempt of one node: the last request the platform was handed
    // for it. The ids are deterministic, but the binding is what settles.
    const currentAttemptOf = (nodeId: string): OutcomeDispatchRequest => {
      const found = [...opened.delivered].reverse().find((request) => request.nodeId === nodeId);
      if (found === undefined) {
        throw new Error("stop-recovery-xproc-worker: no dispatch for node " + nodeId);
      }
      return found;
    };
    const settle = async (nodeId: string, outcomeId: string): Promise<Record<string, unknown>> => {
      const request = currentAttemptOf(nodeId);
      const args: Record<string, unknown> = {
        graph_id: graphId,
        node_id: nodeId,
        outcome_id: outcomeId,
        credential: request.credential,
      };
      if (roundPayload !== undefined) args.data = roundPayload;
      const raw = String(
        await submit.execute(
          args,
          makeContext(childSessionOf(request.attemptId), "agent." + nodeId, workspaceDir),
        ),
      );
      const answer = JSON.parse(raw) as Record<string, unknown>;
      if (answer.decision !== "accepted") {
        throw new Error(
          "stop-recovery-xproc-worker: " + nodeId + "/" + outcomeId + " was " +
            JSON.stringify(answer.refusals ?? answer.decision) + " (attempt " + request.attemptId + ")",
        );
      }
      return answer;
    };

    // ROUND 1 is admitted; the round that would exceed the declared limit is
    // the one that stops the run.
    await settle("work", "done");
    await settle("review", "revise");
    await settle("work", "done");
    const stopping = await settle("review", "revise");
    const stop = fieldOf(stopping, "stop");
    const stopReason = stringOf(stop, "reason");

    const store = GraphStore.openFile(storeRoot);
    try {
      const record = store.readGraphState(graphId);
      const body = fieldOf(record, "body");
      report({
        mode: "stop",
        graphId,
        runId: record?.runId,
        phase: stringOf(body, "phase"),
        stopReason,
        stopAttempt: stringOf(stop, "attemptId"),
        settled: opened.delivered.map((request) => request.attemptId),
      });
    } finally {
      store.close();
    }
  } finally {
    opened.host.close();
  }
}

// ── The recovery mode ───────────────────────────────────────────────────────

/**
 * A FRESH process over the same store root: apply the shipped run-scoped retry
 * and report what the STORE says about both runs afterwards. This process never
 * saw the stopping one's memory.
 */
async function recover(storeRoot: string, workspaceDir: string, graphId: string): Promise<void> {
  const opened = openHost(storeRoot, workspaceDir);
  try {
    const control = toolOf(opened, "graph_control");
    const raw = String(
      await control.execute(
        {
          graph_id: graphId,
          command: "retry",
          reason: "recover the stopped run as a new run",
        },
        makeContext(STOP_RECOVERY_DECLARER, "agent.declarer", workspaceDir),
      ),
    );
    if (raw.startsWith("graph_control failed:")) {
      throw new Error("stop-recovery-xproc-worker: graph_control failed: " + raw);
    }
    const answer = JSON.parse(raw) as Record<string, unknown>;
    const reexecution = fieldOf(answer, "reexecution");
    const order = fieldOf(reexecution, "order");

    const store = GraphStore.openFile(storeRoot);
    try {
      const current = store.readGraphState(graphId);
      const successorRunId =
        stringOf(order, "successorRunId") ?? stringOf(current, "runId") ?? "";
      const fromRunId = stringOf(reexecution, "fromRunId") ?? "";
      const successorBody = fieldOf(store.readGraphStateOf(graphId, successorRunId), "body");
      const supersededBody = fieldOf(store.readGraphStateOf(graphId, fromRunId), "body");
      const stop = fieldOf(supersededBody, "stop");
      const successorNodes = fieldOf(successorBody, "nodes");
      const entryAttempt = Array.isArray(successorNodes)
        ? successorNodes
            .map((node) => fieldOf(node, "attemptId"))
            .find((attemptId) => typeof attemptId === "string")
        : undefined;
      report({
        mode: "recover",
        graphId,
        kind: stringOf(answer, "kind"),
        scope: stringOf(answer, "scope"),
        refusal: Array.isArray(answer.refusals)
          ? answer.refusals.map((refusal) => fieldOf(refusal, "code")).join(",")
          : undefined,
        fromRunId,
        successorRunId,
        successorPhase: stringOf(successorBody, "phase"),
        successorHasStop: fieldOf(successorBody, "stop") !== undefined,
        successorEntryAttempt: entryAttempt,
        supersededRunId: fromRunId,
        supersededPhase: stringOf(supersededBody, "phase"),
        supersededStopReason: stringOf(stop, "reason"),
        delivered: opened.delivered.map((request) => request.attemptId),
      });
    } finally {
      store.close();
    }
  } finally {
    opened.host.close();
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
  if (mode === "stop-cap") {
    await stopRun(
      storeRoot,
      workspaceDir,
      loopDeclaration({ name: STOP_RECOVERY_CAP_GRAPH, maxTraversals: 1 }),
      undefined,
    );
    return;
  }
  if (mode === "stop-stalled") {
    await stopRun(
      storeRoot,
      workspaceDir,
      loopDeclaration({
        name: STOP_RECOVERY_STALLED_GRAPH,
        maxTraversals: 20,
        maxUnchanged: 1,
      }),
      { revision: "r1" },
    );
    return;
  }
  if (mode === "recover") {
    await recover(storeRoot, workspaceDir, required("graph"));
    return;
  }
  throw new Error("stop-recovery-xproc-worker: unknown --mode " + JSON.stringify(mode));
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
