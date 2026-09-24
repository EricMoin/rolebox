import type { ApprovalPolicy } from "../policy/approval-policy.ts";
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
  readonly approvalPolicy?: ApprovalPolicy;
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
      approvalPolicy: deps.approvalPolicy,
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
