/**
 * Cross-process worker for the P3 item 3 APPROVAL restart evidence.
 *
 * WHY THIS FILE EXISTS. Plan §4 (P3) requires every control command to be covered
 * through "重启后继续" (continue after restart), and §5 A12 requires a persisted
 * request to stay READABLE and ACTIONABLE across one. The in-process cases in
 * approval-lifecycle.test.ts replace the store OBJECT inside one process — the
 * same memory — so they are not a process boundary. This worker is spawned with
 * `Bun.spawn(process.execPath, …)` by
 * tests/graph/approval-restart-cross-process.test.ts: the pause is RAISED in one OS
 * process, the decision is taken in a SECOND that has never seen its memory, and a
 * THIRD re-reads the outcome and is answered the replay.
 *
 *     bun tests/graph/helpers/approval-restart-xproc-worker.ts --mode <mode> ...
 *
 * Modes:
 *   - `raise`   raises a pending approval request through the SHIPPED control entry
 *                (the same function graph_control calls), names the approver and the
 *                deadline it was given, and EXITS — the crash window a restart
 *                leaves behind.
 *   - `approve` opens a fresh connection to the same store, DECIDES the pending
 *                request through the shipped entry as the named approver, and
 *                reports the row it left behind.
 *   - `read`    reports the persisted request row and the durable counts, so a
 *                later process's view is evidence rather than an inference.
 *
 * Every mode prints exactly ONE JSON line on stdout — `{"pid":n,"ok":true,…}` on
 * success, `{"pid":n,"ok":false,…}` plus a non-zero exit on failure.
 *
 * PRIVACY. This fixture receives a store root under the OS temp directory, the
 * deterministic ids the graph mints, and the session ids the case names. It never
 * prints a credential VALUE, a real home-directory path or a session transcript:
 * the report carries ids, status tokens, counts and booleans only.
 */

import { GraphStore } from "../../../src/graph/store/graph-store.ts";
import type { GraphControlEntryArgs } from "../../../src/graph/tools/control-entry.ts";
import { runGraphControlEntry } from "../../../src/graph/tools/control-entry.ts";

/** The one graph this fixture drives: a single entry node. */
export const APPROVAL_RESTART_GRAPH = "approval.restart-xproc";

/** The session that declares the graph and is therefore allowed to control it. */
export const APPROVAL_RESTART_DECLARER = "session.declarer-xproc";

/** The session every request this fixture raises NAMES as its approver. */
export const APPROVAL_RESTART_APPROVER = "session.approver-xproc";

/** A fixed epoch-ms instant, passed to every process, so nothing reads a clock. */
export const APPROVAL_RESTART_AT = 1_700_000_000_000;

/** The deadline the raising process records: one second after the raise. */
export const APPROVAL_RESTART_DEADLINE = APPROVAL_RESTART_AT + 1_000;

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
    throw new Error("approval-restart-xproc-worker: --" + name + " is required");
  }
  return value;
}

/** The epoch-ms instant this process stamps its command with. */
function instant(): number {
  const raw = arg("now");
  const value = raw === undefined ? APPROVAL_RESTART_AT : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("approval-restart-xproc-worker: --now must be epoch milliseconds");
  }
  return value;
}

/** Print the ONE report line this worker's parent parses. */
function report(fields: Readonly<Record<string, unknown>>): void {
  console.log(JSON.stringify({ pid: process.pid, ok: true, ...fields }));
}

/** Run one command through the SHIPPED control entry, as the tool face does. */
function control(
  storeRoot: string,
  args: GraphControlEntryArgs,
  sessionID: string,
  agent: string,
  now: number,
): Record<string, unknown> {
  const result = runGraphControlEntry(
    { storeDirectory: storeRoot, now },
    args,
    sessionID,
    agent,
  );
  return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
}

/** The request row one connection reads, or `undefined`. */
function readRow(
  storeRoot: string,
  graphId: string,
  attemptId: string,
): Record<string, unknown> | undefined {
  const store = GraphStore.openFile(storeRoot);
  try {
    const row = store.approvals.readApprovalRequest(graphId, attemptId);
    return row === undefined
      ? undefined
      : (JSON.parse(JSON.stringify(row)) as Record<string, unknown>);
  } finally {
    store.close();
  }
}

// ── Modes ───────────────────────────────────────────────────────────────────

/** Raise the durable pause and exit. */
function raise(storeRoot: string, graphId: string, attemptId: string): void {
  const now = instant();
  const answer = control(
    storeRoot,
    {
      graph_id: graphId,
      command: "approval-request",
      node_id: "work",
      attempt_id: attemptId,
      reason: "hold the work for a human sign-off",
      approver_session_id: APPROVAL_RESTART_APPROVER,
      expires_at: APPROVAL_RESTART_DEADLINE,
    },
    APPROVAL_RESTART_DECLARER,
    "agent.declarer",
    now,
  );
  const approval = answer["approval"] as { readonly request?: Record<string, unknown> } | undefined;
  report({
    mode: "raise",
    kind: answer["kind"],
    status: approval?.request?.["status"],
    attemptId: approval?.request?.["attemptId"],
    approverSessionId: approval?.request?.["approverSessionId"],
    expiresAt: approval?.request?.["expiresAt"],
  });
}

/** Decide the pending request as the named approver. */
function approve(storeRoot: string, graphId: string, attemptId: string): void {
  const now = instant();
  const answer = control(
    storeRoot,
    {
      graph_id: graphId,
      command: "approve",
      node_id: "work",
      attempt_id: attemptId,
      reason: arg("reason") ?? "reviewed and signed off",
    },
    APPROVAL_RESTART_APPROVER,
    "agent.approver",
    now,
  );
  const approval = answer["approval"] as
    | { readonly request?: Record<string, unknown>; readonly replayed?: boolean }
    | undefined;
  const refusals = answer["refusals"] as readonly { readonly code?: string }[] | undefined;
  report({
    mode: "approve",
    kind: answer["kind"],
    refusalCode: refusals?.[0]?.code,
    status: approval?.request?.["status"],
    replayed: approval?.replayed,
    decidedAt: approval?.request?.["decidedAt"],
    decisionReason: approval?.request?.["decisionReason"],
    decidedBy: (approval?.request?.["decidedBy"] as { readonly sessionId?: string } | undefined)
      ?.sessionId,
  });
}

/** Report the persisted row and the durable counts a later process sees. */
function read(storeRoot: string, graphId: string, attemptId: string): void {
  const row = readRow(storeRoot, graphId, attemptId);
  const store = GraphStore.openFile(storeRoot);
  try {
    const decisions = store.runs.controlDecisions(graphId);
    report({
      mode: "read",
      status: row?.["status"],
      attemptId: row?.["attemptId"],
      approverSessionId: row?.["approverSessionId"],
      decidedAt: row?.["decidedAt"],
      decisionReason: row?.["decisionReason"],
      decidedBy: (row?.["decidedBy"] as { readonly sessionId?: string } | undefined)?.sessionId,
      requests: store.approvals.approvalRequestsOf(graphId).length,
      decisionCommands: decisions.map((decision) => decision.command).sort(),
      acceptedEvents: store.acceptedEvents(graphId).length,
      receipts:
        (store.all(
          "SELECT COUNT(*) AS n FROM ledger_receipts WHERE graph_id = ?",
          graphId,
        )[0]?.["n"] as number) ?? -1,
    });
  } finally {
    store.close();
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

function main(): void {
  const mode = required("mode");
  const storeRoot = required("root");
  const graphId = required("graph");
  const attemptId = required("attempt");
  if (mode === "raise") {
    raise(storeRoot, graphId, attemptId);
    return;
  }
  if (mode === "approve") {
    approve(storeRoot, graphId, attemptId);
    return;
  }
  if (mode === "read") {
    read(storeRoot, graphId, attemptId);
    return;
  }
  throw new Error("approval-restart-xproc-worker: unknown --mode " + JSON.stringify(mode));
}

if (import.meta.main) {
  try {
    main();
  } catch (error: unknown) {
    console.log(
      JSON.stringify({
        pid: process.pid,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}
