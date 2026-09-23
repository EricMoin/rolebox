/**
 * Cross-process worker fixture for the P2 restart-recovery evidence.
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * WHY THIS FILE EXISTS. Plan §4: "真实宿主重启测试不能仅关闭再打开同一个内存对象；
 * 至少用子进程退出与重新启动驱动边界" — a restart test must be driven by a REAL
 * process boundary, not by closing and reopening an object in one process. The
 * parent (`tests/graph/host-restart-cross-process.test.ts`) therefore spawns
 * THIS file with `Bun.spawn(process.execPath, …)`, exactly as
 * `tests/graph/helpers/graph-store-xproc-worker.ts` does for the store races:
 * every mode opens its OWN connection to the workspace's ONE store file, and a
 * "restart" is a genuinely different OS process that has never seen the
 * dispatching process's memory.
 *
 *     bun tests/graph/helpers/host-restart-xproc-worker.ts --mode <mode> ...
 *
 * Every mode prints exactly ONE JSON line on stdout — `{"pid":n,"ok":true,...}`
 * on success, `{"pid":n,"ok":false,...}` plus a non-zero exit on failure — and
 * the parent enforces its own deadline and kills a worker that overruns.
 *
 * COORDINATION IS A MARKER FILE. `--mode dispatch` writes
 * `dispatched-<attempt>.marker` AFTER the platform execution was confirmed, and
 * the parent writes nothing: it only waits for that file, so the recovery
 * process cannot start before the dispatch process finished. No sleeps decide
 * an outcome.
 *
 * PRIVACY. This fixture receives store roots under the OS temp directory,
 * graph/attempt ids minted by the test, and one platform execution id. It never
 * prints a credential VALUE, a real home-directory path or a session
 * transcript: the report carries attempt ids, counts, booleans and status
 * tokens only — never a value the vault holds.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../../src/graph/compiler/declaration-v3.ts";
import { OutcomeHost } from "../../../src/graph/host/outcome-host.ts";
import { HostExecutionIndex } from "../../../src/graph/host/execution-index.ts";
import { SqliteAcceptanceLedger } from "../../../src/graph/ledger/sqlite-ledger.ts";
import { dispatchEffectKeyOf } from "../../../src/graph/outcome/dispatch-effects.ts";
import { buildDeclaredOutcomeGraph, persistDeclaredGraph } from "../../../src/graph/tools/declare-graph.ts";
import {
  completionPolicyRefOf,
  createCompletionPolicyRegistry,
  type CompletionPolicyBody,
} from "../../../src/graph/policy/completion-policy.ts";

// ── The one graph this fixture drives ───────────────────────────────────────

/** The graph every case uses: ONE node that completes naturally. */
export const XPROC_GRAPH_ID = "graph.restart-xproc";

/** The host's authorization of that node's natural completion (D6). */
export const XPROC_POLICY_ID = "policy.restart-xproc";
export const XPROC_POLICY_REVISION = "1";

const XPROC_POLICY_BODY: CompletionPolicyBody = {
  version: 1,
  default: "ungranted",
  rules: [
    { graphId: XPROC_GRAPH_ID, nodeId: "work", outcome: "done", decision: "allow" },
  ],
};

/** The completion policies a host must install to run the graph at all. */
export const XPROC_POLICIES = createCompletionPolicyRegistry({
  policies: [
    {
      ref: completionPolicyRefOf({
        id: XPROC_POLICY_ID,
        revision: XPROC_POLICY_REVISION,
        body: XPROC_POLICY_BODY,
      }),
      body: XPROC_POLICY_BODY,
    },
  ],
});

/** The declaration the parent persists before any worker runs. */
export function xprocDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: XPROC_GRAPH_ID,
    nodes: [
      {
        id: "work",
        agent: "agent.work",
        prompt: "Do the work.",
        outcomes: [{ id: "done" }],
        completion: { mode: "natural", outcome: "done" },
      },
    ],
    edges: [],
    completion_policy: { id: XPROC_POLICY_ID, revision: XPROC_POLICY_REVISION },
  };
}

/** Persist the graph into `storeRoot` — the parent's job, before the workers. */
export function persistXprocGraph(storeRoot: string): void {
  const persisted = persistDeclaredGraph(
    buildDeclaredOutcomeGraph({
      declaration: xprocDeclaration(),
      completionPolicies: XPROC_POLICIES,
    }),
    storeRoot,
  );
  if (!persisted) {
    throw new Error("host-restart-xproc-worker: the fixture graph could not be persisted");
  }
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
    throw new Error("host-restart-xproc-worker: --" + name + " is required");
  }
  return value;
}

// ── Output ──────────────────────────────────────────────────────────────────

/** Print the one JSON result line. `pid` is the parent's evidence of a REAL process. */
function emit(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ pid: process.pid, ...payload }) + "\n");
}

/** One attempt's recorded position, read from the store with a fresh connection. */
interface RecordReading {
  readonly phase: string | null;
  readonly status: string | null;
  readonly attemptId: string | null;
  readonly outcomeId: string | null;
  readonly credentialDigest: string | null;
  readonly events: number;
  readonly pendingEffects: readonly string[];
  readonly graphId: string | null;
}

async function readRecord(storeRoot: string, graphId: string): Promise<RecordReading> {
  const ledger = await SqliteAcceptanceLedger.create(storeRoot);
  try {
    const record = ledger.readGraphState(graphId);
    const body =
      typeof record?.body === "object" && record.body !== null
        ? (record.body as Record<string, unknown>)
        : undefined;
    const entries = Array.isArray(body?.["nodes"]) ? (body["nodes"] as unknown[]) : [];
    let node: Record<string, unknown> | undefined;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      if ((entry as Record<string, unknown>)["nodeId"] === "work") {
        node = entry as Record<string, unknown>;
        break;
      }
    }
    const text = (value: unknown): string | null =>
      typeof value === "string" && value.length > 0 ? value : null;
    return {
      phase: text(body?.["phase"]),
      status: text(node?.["status"]),
      attemptId: text(node?.["attemptId"]),
      outcomeId: text(node?.["outcomeId"]),
      credentialDigest: text(node?.["attemptCredentialDigest"]),
      events: ledger.acceptedEvents(graphId).length,
      pendingEffects: ledger
        .pendingEffects(graphId)
        .map((effect) => effect.effectId + "@" + effect.status),
      graphId: text(body?.["graphId"]),
    };
  } finally {
    ledger.close();
  }
}

/** The host's own execution row for one attempt, as JSON-safe facts. */
function readExecutionRow(storeRoot: string, graphId: string, attemptId: string) {
  const index = HostExecutionIndex.open({ root: storeRoot });
  try {
    const row = index.read(dispatchEffectKeyOf(graphId, attemptId));
    if (row === undefined) return null;
    return {
      state: row.state,
      attemptId: row.attemptId,
      executionId: row.execution?.executionId ?? null,
      taskId: row.execution?.taskId ?? null,
      generation: row.generation,
    };
  } finally {
    index.close();
  }
}

// ── Modes ───────────────────────────────────────────────────────────────────

interface ModeOutcome {
  readonly [key: string]: unknown;
}

/**
 * `--mode dispatch`: give the graph its FIRST execution, confirm the platform's
 * real execution id, and leave. Nothing about this process survives except the
 * rows it wrote.
 */
async function modeDispatch(): Promise<ModeOutcome> {
  const storeRoot = required("root");
  const workspaceDir = required("workspace");
  const graphId = required("graph");
  const executionId = required("execution");
  const markerDir = required("marker-dir");
  const delivered: string[] = [];
  const host = OutcomeHost.open({
    workspaceDir,
    storeRoot,
    deliver: (request) => {
      delivered.push(request.attemptId);
    },
    declareInvocationIdentity: false,
    completionPolicies: XPROC_POLICIES,
  });
  try {
    const started = await host.startDeclaredGraph(graphId, {
      sessionId: "session.restart-xproc",
      agent: "agent.declarer",
    });
    if (started.kind !== "started") {
      throw new Error("the fixture graph was not started: " + started.kind);
    }
    const attemptId = "work#1";
    const confirmed = host.confirmExecution(
      dispatchEffectKeyOf(graphId, attemptId),
      { executionId },
    );
    if (!confirmed) throw new Error("the platform execution was not confirmed");
    // THE VALUE IS NOT RETAINED, and this process is the only one that ever had
    // it. The recovery process cannot resolve it, which is the whole point.
    const retained =
      host.credentials.durableRecord({ graphId, nodeId: "work", attemptId }) === "retained";
    const resolvable =
      host.credentials.resolve({ graphId, nodeId: "work", attemptId }) !== undefined;
    const marker = join(markerDir, "dispatched-" + attemptId + ".marker");
    writeFileSync(marker, JSON.stringify({ attemptId, executionId }));
    return {
      delivered,
      retained,
      resolvable,
      executionRow: readExecutionRow(storeRoot, graphId, attemptId),
      record: await readRecord(storeRoot, graphId),
    };
  } finally {
    host.close();
  }
}

/**
 * `--mode recover`: a FRESH process runs the boot sweep over the same root.
 *
 * `--observe terminal` installs the platform observation port and answers
 * `terminal` for the confirmed execution; `--observe running` installs it and
 * answers `running` (the execution has not finished yet — the sweep must report
 * it as AWAITED, naming the platform's execution id, and must not settle it);
 * `--observe none` installs none, which is the shipped adapter's position today.
 */
async function modeRecover(): Promise<ModeOutcome> {
  const storeRoot = required("root");
  const workspaceDir = required("workspace");
  const graphId = required("graph");
  const observe = required("observe");
  const delivered: string[] = [];
  const host = OutcomeHost.open({
    workspaceDir,
    storeRoot,
    deliver: (request) => {
      delivered.push(request.attemptId);
    },
    declareInvocationIdentity: false,
    completionPolicies: XPROC_POLICIES,
    ...(observe === "terminal"
      ? { observeExecution: () => Object.freeze({ kind: "terminal" as const }) }
      : observe === "running"
        ? { observeExecution: () => Object.freeze({ kind: "running" as const }) }
        : {}),
  });
  try {
    const report = await host.recoverDeclaredGraphs();
    return {
      delivered,
      started: report.started,
      resumed: report.resumed,
      refused: report.refused,
      completed: report.completed,
      divergences: report.divergences.length,
      effectRefusals: report.effectRefusals.map(
        (refusal) => refusal.graphId + ":" + refusal.code,
      ),
      storeBlocked: report.storeBlocked ?? null,
      // THE LISTENING INVENTORY (P2 item 6): every confirmed execution the
      // sweep is still waiting on, named by the platform's own id — what a host
      // adapter re-subscribes to after the dispatching process exited.
      awaitingCompletion: report.awaitingCompletion.map((entry) => ({
        graphId: entry.graphId,
        nodeId: entry.nodeId,
        attemptId: entry.attemptId,
        executionId: entry.executionId,
        status: entry.status,
      })),
      record: await readRecord(storeRoot, graphId),
      executionRow: readExecutionRow(storeRoot, graphId, "work#1"),
    };
  } finally {
    host.close();
  }
}

/**
 * `--mode complete`: a FRESH process settles one attempt's completion directly,
 * with NO observation port — the binding must come from the durable record, and
 * the completion must be authenticated by the confirmed execution.
 */
async function modeComplete(): Promise<ModeOutcome> {
  const storeRoot = required("root");
  const workspaceDir = required("workspace");
  const graphId = required("graph");
  const attemptId = required("attempt");
  const delivered: string[] = [];
  const host = OutcomeHost.open({
    workspaceDir,
    storeRoot,
    deliver: (request) => {
      delivered.push(request.attemptId);
    },
    declareInvocationIdentity: false,
    completionPolicies: XPROC_POLICIES,
  });
  try {
    const report = await host.complete(graphId, attemptId);
    return {
      delivered,
      kind: report.kind,
      nodeId: report.kind === "unbound" ? null : report.nodeId,
      settlementKind: report.kind === "settled" ? report.settlement.kind : null,
      replayed:
        report.kind === "settled" && report.settlement.kind === "accepted"
          ? report.settlement.replayed
          : null,
      record: await readRecord(storeRoot, graphId),
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
    case "recover":
      outcome = await modeRecover();
      break;
    case "complete":
      outcome = await modeComplete();
      break;
    default:
      throw new Error("host-restart-xproc-worker: unknown --mode " + JSON.stringify(mode));
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
