import type { ApprovalPolicy } from "../policy/approval-policy.ts";
import type { ControlCommandName } from "../ledger/types.ts";
import {
  applyGraphControl,
  type GraphControlResult,
} from "../control/application.ts";
import {
  type GraphControlRefused,
  approvalRequestSpecAbsentRefusal,
  missingRetryCapabilityRefusal,
  nodeScopedCommandMissingNodeRefusal,
  refuse,
  runWideCommandNamedNodeRefusal,
} from "../control/command-context.ts";
import { approvalSpecProblem } from "../control/approval.ts";
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
 * The refusal a raise whose specification is present but HALF missing is
 * answered with.
 *
 * `approval-command.ts` states this sentence inside its own transaction, where
 * it judges a request it could build; the tool entry applies the SAME rule when
 * a caller supplied only half of the specification — the shape the handler's
 * union cannot carry — so the code, the path and the wording are the handler's,
 * taken from {@link approvalSpecProblem} and wrapped exactly as the handler
 * wraps them.
 *
 * THE CALLER HAS ALREADY ESTABLISHED THAT ONE HALF IS MISSING, which is what
 * the rule names; a specification the rule PASSES would mean the shape rule and
 * the specification rule disagreed, and that is thrown rather than answered with
 * a fabricated refusal.
 */
function halfApprovalSpecRefusal(
  graphId: string,
  spec: Record<string, unknown>,
  at: number,
): GraphControlRefused {
  const problem = approvalSpecProblem(spec, at);
  if (problem === undefined) {
    throw new Error(
      "graph-control: an approval specification missing one half was not refused",
    );
  }
  return refuse(
    graphId,
    "approval-request-malformed",
    "$.approval",
    "graph-control refused [approval-request-malformed]: " + problem + " — nothing was written",
  );
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
    const principal =
      invokingSessionId === undefined || invokingSessionId.length === 0
        ? undefined
        : Object.freeze({
          sessionId: invokingSessionId,
          ...(agent === undefined || agent.length === 0 ? {} : { agentId: agent }),
        });
    const base = {
      graphId,
      reason: args.reason,
      principal,
      at: deps.now ?? Date.now(),
      approvalPolicy: deps.approvalPolicy,
    };
    // THE COMMAND DECIDES THE ARM. `GraphControlRequest` is a discriminated
    // union whose arms carry each handler's own call-shape rule: a node-scoped
    // command REQUIRES its node, a run-wide one FORBIDS one, a `retry` REQUIRES
    // the credential-isolation capability it mints with, and a raise REQUIRES
    // the approver and deadline it pauses on. This entry therefore applies those
    // rules HERE — answering each refused call-shape with the handler's own
    // refusal value — instead of building a request the handler would refuse.
    // Everything that depends on the store (the principal check, the graph, its
    // declaration, the authorization and the run) still runs inside
    // `applyGraphControl`, in the order it always did.
    switch (args.command) {
      case "cancel":
        if (args.node_id !== undefined || args.attempt_id !== undefined) {
          return runWideCommandNamedNodeRefusal(graphId, "cancel");
        }
        return applyGraphControl(store, { ...base, command: "cancel" });
      case "budget-stop":
        if (args.node_id !== undefined || args.attempt_id !== undefined) {
          return runWideCommandNamedNodeRefusal(graphId, "budget-stop");
        }
        return applyGraphControl(store, { ...base, command: "budget-stop" });
      case "failure": {
        const nodeId = args.node_id;
        if (nodeId === undefined) return nodeScopedCommandMissingNodeRefusal(graphId, "failure");
        return applyGraphControl(store, {
          ...base,
          command: "failure",
          nodeId,
          ...(args.attempt_id === undefined ? {} : { attemptId: args.attempt_id }),
        });
      }
      case "timeout": {
        const nodeId = args.node_id;
        if (nodeId === undefined) return nodeScopedCommandMissingNodeRefusal(graphId, "timeout");
        return applyGraphControl(store, {
          ...base,
          command: "timeout",
          nodeId,
          ...(args.attempt_id === undefined ? {} : { attemptId: args.attempt_id }),
        });
      }
      case "approve": {
        const nodeId = args.node_id;
        if (nodeId === undefined) return nodeScopedCommandMissingNodeRefusal(graphId, "approve");
        return applyGraphControl(store, {
          ...base,
          command: "approve",
          nodeId,
          ...(args.attempt_id === undefined ? {} : { attemptId: args.attempt_id }),
        });
      }
      case "reject": {
        const nodeId = args.node_id;
        if (nodeId === undefined) return nodeScopedCommandMissingNodeRefusal(graphId, "reject");
        return applyGraphControl(store, {
          ...base,
          command: "reject",
          nodeId,
          ...(args.attempt_id === undefined ? {} : { attemptId: args.attempt_id }),
        });
      }
      case "retry": {
        const nodeId = args.node_id;
        // THE RUN-SCOPED FORM NAMES NO NODE, so no node is resolved and no
        // credential is minted: the handler orders the re-execution before it
        // reads a capability, and a run-scoped retry that names an attempt is
        // still answered by the handler's own refusal.
        if (nodeId === undefined) {
          return applyGraphControl(store, {
            ...base,
            command: "retry",
            ...(args.attempt_id === undefined ? {} : { attemptId: args.attempt_id }),
          });
        }
        const capability = deps.credentialIsolation;
        if (capability === undefined) return missingRetryCapabilityRefusal(graphId);
        return applyGraphControl(store, {
          ...base,
          command: "retry",
          nodeId,
          ...(args.attempt_id === undefined ? {} : { attemptId: args.attempt_id }),
          retry: Object.freeze({
            credentialIsolation: capability,
            ...(deps.mintCredential === undefined
              ? {}
              : { mintCredential: deps.mintCredential }),
          }),
        });
      }
      case "approval-request": {
        const nodeId = args.node_id;
        if (nodeId === undefined) {
          return nodeScopedCommandMissingNodeRefusal(graphId, "approval-request");
        }
        const approverSessionId = args.approver_session_id;
        const expiresAt = args.expires_at;
        // WHAT AN APPROVAL REQUEST MUST CARRY. Passed through verbatim, never
        // inferred: no default approver, no default deadline. A raise that
        // carried NEITHER is refused by name here; one that carried only HALF
        // cannot build the arm the handler's union requires, so the handler's own
        // `approvalSpecProblem` names the missing half — the same refusal, from
        // the same rule, with the present half handed over as it arrived.
        if (approverSessionId === undefined && expiresAt === undefined) {
          return approvalRequestSpecAbsentRefusal(graphId);
        }
        // THE RAISE ARM IS BUILT ONLY WHEN BOTH HALVES ARE THERE. A present half
        // is never padded with an empty approver or a zero deadline: the absent
        // one is what the refusal must name, and a fabricated value would hide
        // it.
        if (approverSessionId === undefined || expiresAt === undefined) {
          return halfApprovalSpecRefusal(
            graphId,
            {
              ...(approverSessionId === undefined ? {} : { approverSessionId }),
              ...(expiresAt === undefined ? {} : { expiresAt }),
            },
            base.at,
          );
        }
        return applyGraphControl(store, {
          ...base,
          command: "approval-request",
          nodeId,
          approval: Object.freeze({ approverSessionId, expiresAt }),
          ...(args.attempt_id === undefined ? {} : { attemptId: args.attempt_id }),
        });
      }
      default: {
        const unhandled: never = args.command;
        throw new Error("graph-control: unsupported command " + String(unhandled));
      }
    }
  } finally {
    store.close();
  }
}
