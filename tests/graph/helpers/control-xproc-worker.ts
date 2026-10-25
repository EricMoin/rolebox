
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../../src/graph/compiler/declaration-v3.ts";
import { OutcomeHost } from "../../../src/graph/host/outcome-host.ts";
import type { OutcomeDispatchRequest } from "../../../src/graph/outcome/dispatch-effects.ts";
import { createValidatorRegistry } from "../../../src/graph/outcome/validators.ts";
import { GraphStore } from "../../../src/graph/store/graph-store.ts";
import { GRAPH_STORE_TABLES } from "../../../src/graph/store/schema.ts";
import { createGraphToolSet } from "../../../src/graph/tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../../../src/graph/tools/index.ts";
import type {
  CanonicalToolContext,
  CanonicalToolDef,
} from "../../../src/platform/types.ts";

/** The graph every case drives: work -> review, so an acceptance arms a successor. */
export const XPROC_CONTROL_GRAPH_ID = "control.xproc-restart";

/** The marker the child writes before it exits: its pid and its own durable reading. */
export const CONTROL_REPORT_MARKER = "control-report.marker";

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
    throw new Error("control-xproc-worker: --" + name + " is required");
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

// ── The durable reading the child leaves behind ─────────────────────────────

/** What the child read back with a FRESH connection before it exited. */
interface ChildReading {
  /** `effectId=status` for every UNSETTLED effect of the graph. */
  readonly effects: readonly string[];
  /** `attemptId=state` for every unsettled DISPATCH effect's execution row. */
  readonly executions: readonly string[];
  readonly events: number;
  readonly receipts: number;
}

function readDurable(storeRoot: string, graphId: string): ChildReading {
  const store = GraphStore.openFile(storeRoot);
  try {
    const effects = store.pendingEffects(graphId);
    return {
      effects: effects.map((effect) => effect.effectId + "=" + effect.status),
      executions: effects
        .filter((effect) => effect.kind === "dispatch")
        .map((effect) => {
          const row = store.readExecution({
            graphId,
            effectId: effect.effectId,
            attemptId: effect.attemptId,
          });
          return effect.attemptId + "=" + (row?.state ?? "none");
        }),
      events: store.acceptedEvents(graphId).length,
      receipts: store.all(
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

// ── The run ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dir = required("dir");
  const storeRoot = required("store");
  const graphId = required("graph");
  const command = required("command");
  if (command !== "failure" && command !== "timeout") {
    throw new Error(
      "control-xproc-worker: --command must be failure or timeout, got " +
        JSON.stringify(command),
    );
  }

  const dispatches: OutcomeDispatchRequest[] = [];
  const opened = OutcomeHost.open({
    workspaceDir: dir,
    storeRoot,
    deliver: (request, _effect) => {
      // THE PLATFORM NEVER CONFIRMS. The create is handed over and the answer is
      // unknown, so the host's execution row stays `creating`: an external task
      // that may exist and that a later process must still see.
      dispatches.push(request);
    },
    validators: EMPTY_VALIDATORS,
    declareInvocationIdentity: false,
    workerSessionOf: (execution) => execution.executionId,
  });
  const toolset = createGraphToolSet({
    stateDir: dir,
    credentialIsolation: opened.credentialIsolation,
    hostIdentity: opened.workerIdentity,
    outcomeDispatch: opened.dispatch,
    outcomeValidators: EMPTY_VALIDATORS,
    outcomeArtifactRoot: dir,
  });
  const tools: Record<string, CanonicalToolDef> = opened.bindTools(
    createOutcomeGraphTools(toolset),
  );
  try {
    const declared = String(
      await tools.graph_declare.execute(
        { declaration: declarationFor(graphId) },
        contextOf(dir),
      ),
    );
    if (declared.includes("graph_declare failed:")) {
      throw new Error(
        "control-xproc-worker: graph_declare refused the declaration: " + declared,
      );
    }
    const started = await opened.startDeclaredGraph(graphId, {
      sessionId: "session.declarer",
      agent: "agent.declarer",
    });
    if (started.kind !== "started") {
      throw new Error("control-xproc-worker: the graph did not start (" + started.kind + ")");
    }
  } catch (error) {
    opened.close();
    throw error;
  }

  // THE TRUSTED COMMAND. Its tool body records the decision on the ATTEMPT and
  // claims NO run control fact (`failure`/`timeout` are node-scoped); nothing
  // here confirms the create, so the external task the stop leaves behind is
  // UNCONFIRMED.
  const raw = String(
    await tools.graph_control.execute(
      {
        graph_id: graphId,
        command,
        node_id: "work",
        reason: "the host reported the " + command + " of work",
      },
      contextOf(dir),
    ),
  );
  if (raw.startsWith("graph_control failed:")) {
    opened.close();
    throw new Error("control-xproc-worker: graph_control failed: " + raw);
  }

  const reading = readDurable(storeRoot, graphId);
  writeFileSync(
    join(dir, CONTROL_REPORT_MARKER),
    JSON.stringify({
      pid: process.pid,
      graphId,
      command,
      answer: JSON.parse(raw),
      ...reading,
    }),
  );
  opened.close();
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(
      "control-xproc-worker: " +
        (error instanceof Error ? error.name + ": " + error.message : String(error)) +
        "\n",
    );
    process.exit(1);
  });
}
