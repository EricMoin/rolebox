/**
 * Cross-process fixture for the P2 part 2 WORKER TOOL FACE (A21 / plan §3.3).
 *
 * Version: 1.0
 * Date: 2026-09-24
 *
 * WHY THIS FILE EXISTS. The boundary's durable half is a reading of the
 * workspace's one store: which child session the host created an attempt's
 * execution for. A second host object in one process shares the module-level
 * connection map and this process's memory, so the honest strength for "a
 * RESTARTED host still refuses the worker" is a REAL process boundary. The
 * parent (`tests/graph/worker-tool-face-cross-process.test.ts`) therefore
 * spawns THIS file with `Bun.spawn(process.execPath, …)`, exactly as
 * `helpers/host-restart-xproc-worker.ts` does for restart recovery: every mode
 * opens its OWN connection to the store file and has never seen the other
 * process's memory.
 *
 *     bun tests/graph/helpers/worker-face-xproc-worker.ts --mode <mode> ...
 *
 *   --mode dispatch  the dispatching process: start the declared graph, confirm
 *                    the platform's execution for each attempt, let the WORKER
 *                    of `alpha#1` settle its own attempt through the bound face,
 *                    write the barrier marker, and exit. The credential VALUE
 *                    never leaves this process and is never printed.
 *   --mode face      a FRESH process that never dispatched or confirmed
 *                    anything: judge the same session ids through the bound
 *                    face and report only the machine-readable outcome.
 *
 * Every mode prints exactly ONE JSON line on stdout — `{"pid":n,"ok":true,…}` on
 * success, `{"pid":n,"ok":false,…}` plus a non-zero exit on failure.
 *
 * PRIVACY. The store root lives under the OS temp directory; the report carries
 * attempt ids, a stable refusal code, counts and booleans only. It never prints
 * a credential VALUE, a real home-directory path or a session transcript.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../../src/graph/compiler/declaration-v3.ts";
import {
  OutcomeHost,
  WORKER_TOOL_FORBIDDEN_CODE,
} from "../../../src/graph/host/outcome-host.ts";
import type { OutcomeDispatchRequest } from "../../../src/graph/outcome/dispatch-effects.ts";
import { createValidatorRegistry } from "../../../src/graph/outcome/validators.ts";
import { readStoredDefinition } from "../../../src/graph/persistence/declared-record.ts";
import {
  buildDeclaredOutcomeGraph,
  persistDeclaredGraph,
} from "../../../src/graph/tools/declare-graph.ts";
import { createGraphToolSet } from "../../../src/graph/tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../../../src/graph/tools/index.ts";
import type {
  CanonicalToolContext,
  CanonicalToolDef,
} from "../../../src/platform/types.ts";

// ── The one graph this fixture drives ───────────────────────────────────────

/** The graph every case uses: TWO entry nodes, so two attempts are live at once. */
export const XPROC_FACE_GRAPH_ID = "graph.worker-face-xproc";

/** The attempt the dispatching process settles, and the one it leaves open. */
export const XPROC_FACE_SETTLED_ATTEMPT = "alpha#1";
export const XPROC_FACE_OPEN_ATTEMPT = "beta#2";

/** A graph no attempt belongs to: the declaration a worker must not land. */
export const XPROC_FACE_OTHER_ID = "graph.worker-face-xproc-other";

/** The declaration the parent persists before any child runs. */
export function workerFaceDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: XPROC_FACE_GRAPH_ID,
    nodes: [
      { id: "alpha", agent: "agent.alpha", prompt: "Do alpha.", outcomes: [{ id: "done" }] },
      { id: "beta", agent: "agent.beta", prompt: "Do beta.", outcomes: [{ id: "done" }] },
    ],
    edges: [],
  };
}

/** The declaration a worker tries to persist — it must never land. */
export function workerFaceOtherDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: XPROC_FACE_OTHER_ID,
    nodes: [
      { id: "only", agent: "agent.other", prompt: "Do the other.", outcomes: [{ id: "done" }] },
    ],
    edges: [],
  };
}

/** Persist the fixture graph into `storeRoot` — the parent's job, before the children. */
export function persistWorkerFaceGraph(storeRoot: string): void {
  const persisted = persistDeclaredGraph(
    buildDeclaredOutcomeGraph({ declaration: workerFaceDeclaration() }),
    storeRoot,
  );
  if (!persisted) {
    throw new Error("worker-face-xproc-worker: the fixture graph could not be persisted");
  }
}

/** The child session the platform "created" for one attempt (the dsh mapping). */
export function childSessionOf(attemptId: string): string {
  return "child-session:" + attemptId;
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
    throw new Error("worker-face-xproc-worker: --" + name + " is required");
  }
  return value;
}

// ── Output ──────────────────────────────────────────────────────────────────

/** Print the one JSON result line. `pid` is the parent's evidence of a REAL process. */
function emit(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ pid: process.pid, ...payload }) + "\n");
}

// ── Shared assembly ─────────────────────────────────────────────────────────

const EMPTY_VALIDATORS = createValidatorRegistry([]);

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

/** What one tool call answered, reduced to the facts a report may carry. */
interface CallReport {
  readonly refused: boolean;
  readonly code: string | null;
  readonly tool: string | null;
  readonly attempt_id: string | null;
  readonly granted_tools: readonly string[] | null;
  /** Whether the answer leaks the store root (a refusal must not). */
  readonly leaks_store_root: boolean;
}

/** Parse one tool answer as either the boundary's refusal or a body that ran. */
function reportCall(raw: string, storeRoot: string): CallReport {
  const text = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      refused: false,
      code: null,
      tool: null,
      attempt_id: null,
      granted_tools: null,
      leaks_store_root: raw.includes(storeRoot),
    };
  }
  const body =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const granted = Array.isArray(body["granted_tools"])
    ? body["granted_tools"].filter((entry): entry is string => typeof entry === "string")
    : null;
  return {
    refused: body["refused"] === true && body["code"] === WORKER_TOOL_FORBIDDEN_CODE,
    code: text(body["code"]),
    tool: text(body["tool"]),
    attempt_id: text(body["attempt_id"]),
    granted_tools: granted,
    leaks_store_root: raw.includes(storeRoot),
  };
}

/** One node of a parsed `graph_status` body: its id and its durable status. */
interface StatusNodeReport {
  readonly node_id: string;
  readonly status: string;
}

/**
 * What one tool answer answered as a POSITIVE body — the declarer's control.
 *
 * `parsed` is true only when the answer is a JSON OBJECT: a body answer is one
 * and an error string is not (`src/graph/tools/index.ts` renders a failed
 * `graph_status` as the plain text `graph_status failed: …`). The parsed
 * graph id and node statuses are what an error string cannot satisfy — unlike
 * {@link reportCall}'s `refused: false`, which ANY answer that is not the
 * boundary's own refusal gets, a body that never ran included.
 */
interface BodyReport {
  readonly refused: boolean;
  readonly parsed: boolean;
  readonly graph_id: string | null;
  readonly nodes: readonly StatusNodeReport[] | null;
  readonly leaks_store_root: boolean;
}

/** Parse one tool answer as the positive body it either is or is not. */
function reportBody(raw: string, storeRoot: string): BodyReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const body =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  const nodes =
    body !== null && Array.isArray(body["nodes"])
      ? body["nodes"].flatMap((entry): readonly StatusNodeReport[] => {
          if (typeof entry !== "object" || entry === null) return [];
          const node = entry as Record<string, unknown>;
          return typeof node["node_id"] === "string" && typeof node["status"] === "string"
            ? [{ node_id: node["node_id"], status: node["status"] }]
            : [];
        })
      : null;
  return {
    refused:
      body !== null && body["refused"] === true && body["code"] === WORKER_TOOL_FORBIDDEN_CODE,
    parsed: body !== null,
    graph_id: body !== null && typeof body["graph_id"] === "string" ? body["graph_id"] : null,
    nodes,
    leaks_store_root: raw.includes(storeRoot),
  };
}

/**
 * The host and the bound face both modes use, assembled exactly as the entries
 * assemble it: the shipped `declareInvocationIdentity: false` +
 * `workerSessionOf` decision, the delivery seam, and `OutcomeHost.bindTools`
 * over `createOutcomeGraphTools`.
 */
function openFace(
  workspaceDir: string,
  storeRoot: string,
  onDispatch?: (request: OutcomeDispatchRequest) => void,
): {
  readonly host: OutcomeHost;
  readonly tools: Record<string, CanonicalToolDef>;
} {
  let host: OutcomeHost | undefined;
  const opened = OutcomeHost.open({
    workspaceDir,
    storeRoot,
    deliver: (request, effect) => {
      onDispatch?.(request);
      // The platform names the execution it created; the host records the fact.
      host?.confirmExecution(effect, { executionId: childSessionOf(request.attemptId) });
    },
    validators: EMPTY_VALIDATORS,
    declareInvocationIdentity: false,
    workerSessionOf: (execution) => execution.executionId,
  });
  host = opened;
  const toolset = createGraphToolSet({
    stateDir: workspaceDir,
    credentialIsolation: opened.credentialIsolation,
    hostIdentity: opened.workerIdentity,
    outcomeDispatch: opened.dispatch,
    outcomeValidators: EMPTY_VALIDATORS,
    outcomeArtifactRoot: workspaceDir,
  });
  return { host: opened, tools: opened.bindTools(createOutcomeGraphTools(toolset)) };
}

// ── Modes ───────────────────────────────────────────────────────────────────

interface ModeOutcome {
  readonly [key: string]: unknown;
}

/** The acting agent for one attempt's worker session. */
function agentOf(attemptId: string): string {
  const nodeId = attemptId.split("#")[0];
  return "agent." + (nodeId === undefined || nodeId.length === 0 ? "worker" : nodeId);
}

/**
 * `--mode dispatch`: give the graph its executions, confirm the platform's own
 * id for each (the host fact the boundary is derived from), settle `alpha#1`
 * through its OWN worker's granted call, and leave. Nothing about this process
 * survives except the rows it wrote; the credential value is used in-process
 * and printed nowhere.
 */
async function modeDispatch(): Promise<ModeOutcome> {
  const storeRoot = required("root");
  const workspaceDir = required("workspace");
  const markerDir = required("marker-dir");
  const graphId = XPROC_FACE_GRAPH_ID;
  const dispatched: OutcomeDispatchRequest[] = [];
  const { host, tools } = openFace(workspaceDir, storeRoot, (request) => {
    dispatched.push(request);
  });
  try {
    const started = await host.startDeclaredGraph(graphId, {
      sessionId: "session.declarer",
      agent: "agent.declarer",
    });
    if (started.kind !== "started") {
      throw new Error(
        "worker-face-xproc-worker: the fixture graph did not start (" + started.kind + ")",
      );
    }
    const settled = dispatched.find(
      (request) => request.attemptId === XPROC_FACE_SETTLED_ATTEMPT,
    );
    if (settled === undefined) {
      throw new Error("worker-face-xproc-worker: the settled attempt was never dispatched");
    }
    const submit = tools["graph_submit_outcome"];
    if (submit === undefined) {
      throw new Error("worker-face-xproc-worker: the face has no graph_submit_outcome");
    }
    const raw = String(
      await submit.execute(
        {
          graph_id: graphId,
          node_id: "alpha",
          outcome_id: "done",
          credential: settled.credential,
        },
        makeContext(childSessionOf(XPROC_FACE_SETTLED_ATTEMPT), "agent.alpha", workspaceDir),
      ),
    );
    const decision = (JSON.parse(raw) as { decision?: string }).decision ?? null;
    // The barrier: the parent waits for this file, so the judging process cannot
    // start before the settlement is durable.
    writeFileSync(
      join(markerDir, "settled-" + XPROC_FACE_SETTLED_ATTEMPT + ".marker"),
      JSON.stringify({ attemptId: XPROC_FACE_SETTLED_ATTEMPT }),
    );
    return { delivered: dispatched.map((request) => request.attemptId), decision };
  } finally {
    host.close();
  }
}

/**
 * `--mode face`: a FRESH process judges the same session ids through the bound
 * face. It never dispatched, never confirmed and holds no credential: whatever
 * it knows about a worker comes from the durable execution row. It reports the
 * refusal of the SETTLED attempt's worker (whose effect is no longer pending),
 * of the still-open attempt's worker, and that the declaring session still gets
 * the face: its `scope: "persisted"` answer is reported PARSED (graph id, node
 * ids and durable node statuses), not as a refusal boolean an error string
 * could satisfy — plus whether the refused declaration landed anywhere.
 */
async function modeFace(): Promise<ModeOutcome> {
  const storeRoot = required("root");
  const workspaceDir = required("workspace");
  const graphId = XPROC_FACE_GRAPH_ID;
  const { host, tools } = openFace(workspaceDir, storeRoot);
  try {
    const workerContext = (attemptId: string): CanonicalToolContext =>
      makeContext(childSessionOf(attemptId), agentOf(attemptId), workspaceDir);
    const call = async (
      tool: string,
      args: Record<string, unknown>,
      context: CanonicalToolContext,
    ): Promise<CallReport> => {
      const def = tools[tool];
      if (def === undefined) throw new Error("worker-face-xproc-worker: no tool " + tool);
      return reportCall(String(await def.execute(args, context)), storeRoot);
    };
    // The declarer's leg is judged as a BODY: it must parse, not merely avoid
    // the boundary's refusal.
    const callBody = async (
      tool: string,
      args: Record<string, unknown>,
      context: CanonicalToolContext,
    ): Promise<BodyReport> => {
      const def = tools[tool];
      if (def === undefined) throw new Error("worker-face-xproc-worker: no tool " + tool);
      return reportBody(String(await def.execute(args, context)), storeRoot);
    };

    const settledStatus = await call(
      "graph_status",
      { graph_id: graphId, format: "json" },
      workerContext(XPROC_FACE_SETTLED_ATTEMPT),
    );
    const settledAudit = await call(
      "graph_audit",
      {},
      workerContext(XPROC_FACE_SETTLED_ATTEMPT),
    );
    const openStatus = await call(
      "graph_status",
      { graph_id: graphId, format: "json" },
      workerContext(XPROC_FACE_OPEN_ATTEMPT),
    );
    const workerDeclare = await call(
      "graph_declare",
      { declaration: workerFaceOtherDeclaration() },
      workerContext(XPROC_FACE_SETTLED_ATTEMPT),
    );
    // The DECLARER's positive control. This process never called
    // `graph_declare`, so a session-scope query answers the plain-text error
    // `graph "…" is not a declared graph in this process` — an answer the old
    // `refused: false` check accepted. `scope: "persisted"` reads the graph
    // the OTHER process declared from the store, and the report carries the
    // parsed graph id and the durable node position, which an error string has
    // none of.
    const declarerStatus = await callBody(
      "graph_status",
      { graph_id: graphId, format: "json", scope: "persisted" },
      makeContext("session.declarer", "agent.declarer", workspaceDir),
    );
    return {
      settled: { status: settledStatus, audit: settledAudit },
      open: { status: openStatus },
      worker_declare: workerDeclare,
      // The refused declaration must not have landed: the pre-body refusal.
      declared_other: readStoredDefinition(storeRoot, XPROC_FACE_OTHER_ID).kind,
      declarer: {
        refused: declarerStatus.refused,
        parsed: declarerStatus.parsed,
        graph_id: declarerStatus.graph_id,
        nodes: declarerStatus.nodes,
        leaks_store_root: declarerStatus.leaks_store_root,
      },
    };
  } finally {
    host.close();
  }
}

// ── Entry ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mode = required("mode");
  let outcome: ModeOutcome;
  switch (mode) {
    case "dispatch":
      outcome = await modeDispatch();
      break;
    case "face":
      outcome = await modeFace();
      break;
    default:
      throw new Error("worker-face-xproc-worker: unknown --mode " + JSON.stringify(mode));
  }
  emit({ ok: true, mode, ...outcome });
}

// Imported by the parent for its fixtures; only run when executed as a script.
if (import.meta.main) {
  main().catch((error: unknown) => {
    emit({
      ok: false,
      mode: arg("mode") ?? "unknown",
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
