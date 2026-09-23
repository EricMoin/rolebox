/**
 * Cross-process worker fixture for the P3 CANCEL restart evidence.
 *
 * Version: 1.0
 * Date: 2026-09-24
 *
 * WHY THIS FILE EXISTS. The plan's §4 P3 cancel clause is "persist the cancel
 * INTENT ... a process that dies mid-cancel resumes with the intent visible",
 * and §5 forbids a temporary probe as the sole acceptance evidence. The tracked
 * single-process case opens a SECOND HOST INSTANCE over the same store root; it
 * proves the ordering but not a process boundary. This worker IS that boundary:
 * the parent test `tests/graph/cancel-delivery.test.ts` spawns THIS file as a
 * REAL separate OS process (`Bun.spawn(process.execPath, ...)`), it records the
 * trusted cancel decision through the SHIPPED assembly, and it then DIES AT THE
 * PLATFORM ASK — inside the cancel port, after the durable intent and after the
 * request transition, before any platform answer.
 *
 *     bun tests/graph/helpers/cancel-xproc-worker.ts --dir <workspace> --store <root> --graph <id>
 *
 * WHAT IT THEREFORE PINS. The child's own marker (written from inside the ask,
 * with a fresh connection) shows the cancel effect already `started` and the
 * run's control fact already `cancel` at the instant the platform was reached;
 * the child then exits with {@link CANCEL_DEATH_EXIT}. The parent reopens the
 * store with a fresh connection, sees the same rows, and relaunches a host whose
 * sweep REPORTS the stop and RE-ASKS the unconfirmed cancel. The crash window is
 * DRIVEN by a real process exit, not closed-and-reopened in one process.
 *
 * THE ASSEMBLY IS THE SHIPPED ONE: a real `OutcomeHost` over the workspace's one
 * SQLite store, the real `createGraphToolSet`, the `graph_control` tool of
 * `createOutcomeGraphTools`, and the very `OutcomeHost.bindTools` +
 * `withCancelDelivery` pair both entries install. The platform field is a cancel
 * port that reads the durable state and then kills this process.
 *
 * PRIVACY: this worker receives only a store root and a workspace directory
 * under the OS temp directory, plus graph/node/attempt ids minted by the test.
 * Its marker carries ids, statuses and its own pid — never a credential value,
 * a real home-directory path or a session transcript.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../../src/graph/compiler/declaration-v3.ts";
import { OutcomeHost, withCancelDelivery } from "../../../src/graph/host/outcome-host.ts";
import {
  cancelEffectIdOf,
  type OutcomeExecutionCancelAnswer,
  type OutcomeExecutionCancelProbe,
  type OutcomeExecutionCancellation,
} from "../../../src/graph/outcome/cancel.ts";
import type { OutcomeDispatchRequest } from "../../../src/graph/outcome/dispatch-effects.ts";
import { createValidatorRegistry } from "../../../src/graph/outcome/validators.ts";
import { GraphStore } from "../../../src/graph/store/graph-store.ts";
import { createGraphToolSet } from "../../../src/graph/tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../../../src/graph/tools/index.ts";
import type {
  CanonicalToolContext,
  CanonicalToolDef,
} from "../../../src/platform/types.ts";

/** The graph every case drives: work -> review, so an acceptance arms a successor. */
export const XPROC_CANCEL_GRAPH_ID = "cancel.xproc-restart";

/**
 * The exit status that says "this process died AT the platform ask".
 *
 * Chosen distinct from 0 so the parent can tell the intended crash window from
 * an accidental failure: a run that reaches the ask exits with exactly this
 * code, anything else is a fixture error and the parent says so.
 */
export const CANCEL_DEATH_EXIT = 7;

/** The marker the port writes from INSIDE the ask, before it exits. */
export const CANCEL_ASK_MARKER = "cancel-ask.marker";

const EMPTY_VALIDATORS = createValidatorRegistry([]);

// ── Argument access ─────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

/** The value of `--name`, or `undefined`. */
function arg(name: string): string | undefined {
  const index = argv.indexOf("--" + name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** The value of `--name`, refused when absent or empty. */
function required(name: string): string {
  const value = arg(name);
  if (value === undefined || value.length === 0) {
    throw new Error("cancel-xproc-worker: --" + name + " is required");
  }
  return value;
}

// ── The declaration ─────────────────────────────────────────────────────────

/** work -> review: an accepted outcome for `work` arms the `review` attempt. */
function declarationFor(graphId: string): GraphDeclarationV3 {
  return {
    version: 3,
    name: graphId,
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
}

/** A canonical tool context, as the platform hands one to a tool call. */
function contextOf(dir: string): CanonicalToolContext {
  return {
    sessionID: "session.declarer",
    messageID: "m1",
    agent: "agent.declarer",
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

// ── The run ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dir = required("dir");
  const storeRoot = required("store");
  const graphId = required("graph");

  /**
   * THE PORT THAT DIES AT THE ASK.
   *
   * It reads the durable state with a FRESH connection INSIDE the ask — the same
   * proof the in-process case makes, but from a process that is about to stop
   * existing — writes the reading to {@link CANCEL_ASK_MARKER}, and exits. What
   * the parent can therefore assert is not "the code intended to record first"
   * but "the store already held the intent and the started request at the moment
   * a REAL process reached the platform".
   */
  const dyingPort: OutcomeExecutionCancellation = Object.freeze({
    cancel: async (
      probe: OutcomeExecutionCancelProbe,
    ): Promise<OutcomeExecutionCancelAnswer> => {
      let effect: string | null = null;
      let runCommand: string | null = null;
      try {
        const store = GraphStore.openFile(storeRoot);
        try {
          effect =
            store
              .pendingEffects(probe.effect.graphId)
              .find((row) => row.effectId === cancelEffectIdOf(probe.effect.attemptId))
              ?.status ?? null;
          runCommand = store.runs.readRunControl(probe.effect.graphId)?.command ?? null;
        } finally {
          store.close();
        }
      } catch {
        // A store this dying process cannot read is "no reading", never a guess:
        // the parent asserts the durable rows itself afterwards.
      }
      writeFileSync(
        join(dir, CANCEL_ASK_MARKER),
        JSON.stringify({
          pid: process.pid,
          attemptId: probe.effect.attemptId,
          effect,
          runCommand,
        }),
      );
      process.exit(CANCEL_DEATH_EXIT);
      return { kind: "unsupported", reason: "unreachable: the process exits at the platform ask" };
    },
  });

  const dispatches: OutcomeDispatchRequest[] = [];
  let host: OutcomeHost | undefined;
  const opened = OutcomeHost.open({
    workspaceDir: dir,
    storeRoot,
    deliver: (request, effect) => {
      dispatches.push(request);
      // The platform names the execution it created; the host records the fact.
      host?.confirmExecution(effect, { executionId: "child-session:" + request.attemptId });
    },
    validators: EMPTY_VALIDATORS,
    declareInvocationIdentity: false,
    workerSessionOf: (execution) => execution.executionId,
    cancelExecution: dyingPort,
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
  const tools: Record<string, CanonicalToolDef> = opened.bindTools(
    withCancelDelivery(createOutcomeGraphTools(toolset), opened),
  );
  try {
    const declared = String(
      await tools.graph_declare.execute(
        { declaration: declarationFor(graphId) },
        contextOf(dir),
      ),
    );
    if (declared.includes("graph_declare failed:")) {
      throw new Error("cancel-xproc-worker: graph_declare refused the declaration: " + declared);
    }
    const started = await opened.startDeclaredGraph(graphId, {
      sessionId: "session.declarer",
      agent: "agent.declarer",
    });
    if (started.kind !== "started") {
      throw new Error("cancel-xproc-worker: the graph did not start (" + started.kind + ")");
    }
  } catch (error) {
    opened.close();
    throw error;
  }

  // THE CANCEL. Its tool body commits the trusted decision, and the wired
  // delivery records the cancel effect, moves it to `started`, and hands it to
  // the port above — which exits. A return here means the ask never happened.
  const answered = await tools.graph_control.execute(
    { graph_id: graphId, command: "cancel", reason: "the operator stopped it" },
    contextOf(dir),
  );
  opened.close();
  throw new Error(
    "cancel-xproc-worker: graph_control returned instead of dying at the platform ask: " +
      String(answered),
  );
}

// Imported by the parent for its fixtures; only run when executed as a script.
if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(
      "cancel-xproc-worker: " +
        (error instanceof Error ? error.name + ": " + error.message : String(error)) +
        "\n",
    );
    process.exit(1);
  });
}
