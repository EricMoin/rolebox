/**
 * Graph v3 — the `graph_control` ENTRY: one explicit, permissioned command
 * (P3 item 1)
 *
 * Version: 1.0
 * Date: 2026-09-24
 *
 * THE ONE EXPLICIT CONTROL ENTRY POINT. Plan §4 P3: "统一控制入口使用明确的命令
 * 类型和权限" — one entry, explicit command types, and a permission check. This
 * module is the toolset-facing adapter of that entry: it resolves the
 * WORKSPACE'S ONE STORE (the same directory the declaration, the submission
 * ingress and the audit address), then hands the command to the trusted control
 * application service (`src/graph/control/application.ts`). It contains NO
 * control semantics of its own — it cannot apply a command, decide idempotency
 * or check a principal, and a defect here can only mis-address the store, which
 * the service then reports by name.
 *
 * WHAT THE CALLER MAY SAY. `graph_id`, one of the declared command names, an
 * optional node and attempt, and a reason. The PRINCIPAL is not an argument: it
 * is the session the platform attributed to THIS tool call, threaded by the
 * canonical facade exactly as the submission ingress threads its call session.
 * A worker's payload is therefore never authority, and there is no field a
 * caller could set to become someone else — or to infer a command from worker
 * data, which §3.4 forbids: the command is an explicit enum, and a shape the
 * command's own scope forbids (a node on a run-wide `cancel` or
 * `budget-stop`) is refused by name rather than reinterpreted.
 *
 * NO STORE IS EVER CREATED HERE. A workspace whose authoritative store is
 * ABSENT (or retired, or damaged, or of a format this build cannot read) is
 * refused as `store-unavailable`, never initialized: "no store" is not "a new
 * graph", and a control command must not be able to bring a store into
 * existence.
 */

import type { ControlCommandName } from "../ledger/types.ts";
import {
  applyGraphControl,
  type GraphControlResult,
} from "../control/application.ts";
import type { AttemptCredentialSource } from "../outcome/attempt-credential.ts";
import type { CredentialIsolationCapability } from "../outcome/credential-isolation.ts";
import { GraphStoreFormatError } from "../store/errors.ts";
import { readStoreDirectory } from "../store/format.ts";
import { GraphStore } from "../store/graph-store.ts";

/** Arguments the entry accepts. Nothing else on a caller's object is read. */
export interface GraphControlEntryArgs {
  readonly graph_id: string;
  readonly command: ControlCommandName;
  readonly node_id?: string;
  readonly attempt_id?: string;
  readonly reason: string;
  /**
   * The ONLY session that may decide this approval request (P3 item 3).
   * REQUIRED for `approval-request`: the declaring principal raises the pause and
   * NAMES who may answer it, so its own control authority never implies approval
   * authority. Never read from a worker's submission, and ignored by every other
   * command.
   */
  readonly approver_session_id?: string;
  /**
   * The epoch-millisecond instant the request stops being answerable at (P3 item
   * 3). REQUIRED for `approval-request`: a pause with no deadline is a strand, and
   * a deadline that has already passed is refused rather than stored. Ignored by
   * every other command.
   */
  readonly expires_at?: number;
}

/** What the entry needs to reach the workspace's one store. */
export interface GraphControlEntryDeps {
  /**
   * The directory holding the workspace's ONE graph store — resolved by the
   * toolset through the SAME function the declaration, the submission ingress
   * and the audit use, so one process can never address two stores.
   */
  readonly storeDirectory: string | undefined;
  /** Epoch-millisecond clock; defaults to `Date.now`. Time is an explicit input. */
  readonly now?: number;
  /**
   * The host's protected credential store, when this process has one.
   *
   * A retry MINTS a successor attempt, so it needs the same capability the run
   * path does: the value is adopted by the host's store inside the transaction
   * that records its digest. Absent, a retry is refused
   * `credential-isolation-unavailable` and nothing is written — the capability
   * is never a tool argument, exactly as it is not one anywhere else.
   */
  readonly credentialIsolation?: CredentialIsolationCapability;
  /** The minting source a retry uses; defaults to the platform CSPRNG. */
  readonly mintCredential?: AttemptCredentialSource;
}

/** One refusal as a value, in the service's own vocabulary. */
function refused(
  graphId: string,
  code: "store-unavailable",
  path: string,
  message: string,
): GraphControlResult {
  return Object.freeze({
    kind: "refused" as const,
    graphId,
    refusals: Object.freeze([Object.freeze({ code, path, message })]),
  });
}

/**
 * Run one command through the trusted control service.
 *
 * SYNCHRONOUS: the store's transaction boundary is synchronous, so the whole
 * command commits before this returns. The store handle is opened for the call
 * and closed in a `finally`, so a command never leaves a connection behind.
 */
export function runGraphControlEntry(
  deps: GraphControlEntryDeps,
  args: GraphControlEntryArgs,
  invokingSessionId: string | undefined,
  agent: string | undefined,
): GraphControlResult {
  const graphId = args.graph_id;
  const directory = deps.storeDirectory;
  if (directory === undefined) {
    return refused(
      graphId,
      "store-unavailable",
      "$.graph_id",
      "graph_control refused [store-unavailable]: this process resolves no graph store " +
        "directory (no host store root and no workspace state directory), so there is no " +
        "authoritative store a control command could be recorded in — nothing was written",
    );
  }
  const reading = readStoreDirectory(directory);
  if (reading.kind === "absent") {
    return refused(
      graphId,
      "store-unavailable",
      "$.graph_id",
      "graph_control refused [store-unavailable]: no graph store exists in this workspace " +
        "(" +
        reading.filePath +
        " is absent), so no graph is declared here and there is nothing to control — a " +
        "control command never initializes a store",
    );
  }

  let store: GraphStore;
  try {
    store = GraphStore.openFile(directory);
  } catch (error) {
    if (error instanceof GraphStoreFormatError) {
      return refused(
        graphId,
        "store-unavailable",
        "$.graph_id",
        "graph_control refused [store-unavailable]: the workspace's authoritative store " +
          "cannot be opened by this build (" +
          error.problem +
          "): " +
          error.message,
      );
    }
    throw error;
  }
  try {
    return applyGraphControl(store, {
      graphId,
      command: args.command,
      ...(args.node_id === undefined ? {} : { nodeId: args.node_id }),
      ...(args.attempt_id === undefined ? {} : { attemptId: args.attempt_id }),
      reason: args.reason,
      principal:
        invokingSessionId === undefined || invokingSessionId.length === 0
          ? undefined
          : Object.freeze({
              sessionId: invokingSessionId,
              ...(agent === undefined || agent.length === 0 ? {} : { agentId: agent }),
            }),
      at: deps.now ?? Date.now(),
      // WHAT AN APPROVAL REQUEST MUST CARRY. Passed through verbatim, never
      // inferred: no default approver, no default deadline. The service refuses
      // a raise that lacks either (or names a deadline already past) by name,
      // so "omitted" can never become "the declarer may decide".
      ...(args.approver_session_id === undefined && args.expires_at === undefined
        ? {}
        : {
            approval: Object.freeze({
              approverSessionId: args.approver_session_id ?? "",
              expiresAt: args.expires_at ?? 0,
            }),
          }),
      ...(deps.credentialIsolation === undefined
        ? {}
        : {
            retry: Object.freeze({
              credentialIsolation: deps.credentialIsolation,
              ...(deps.mintCredential === undefined
                ? {}
                : { mintCredential: deps.mintCredential }),
            }),
          }),
    });
  } finally {
    store.close();
  }
}
