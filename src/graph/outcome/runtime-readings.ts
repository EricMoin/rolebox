import { errorText } from "../../utils/error-text.ts";
import type { OutcomeDispatchTarget } from "./dispatch-effects.ts";
import type {
  OutcomeGraphPhase,
  OutcomeGraphState,
  OutcomeNodeState,
} from "./graph-state.ts";
import { hostDerivedSubmissionId } from "./host-derived.ts";
import { readResolvedInputs, type ResolvedInput } from "./inputs.ts";
import { naturalCompletionSubmissionId } from "./natural-completion.ts";
import { proposalDigest, readOutcomeProposal } from "./proposal.ts";
import { describeValue } from "./runtime-refusals.ts";
import type {
  HostCompletionFact,
  OutcomeArmedNode,
  OutcomeRuntimeRefusal,
} from "./runtime-contract.ts";

/**
 * Which trusted channel settles one attempt.
 *
 * A CLOSED, runtime-owned vocabulary. It is never read from a proposal or a
 * delivery: `submit` is the worker's claimed outcome, `settleNatural` is the
 * attempt's completion fact, and `settleHostDerivedCompletion` is the outcome
 * the worker's own LAST TURN declared, read and delivered by the host after the
 * execution ended without one. Each entry point labels its own settlements, and
 * the label reaches the durable record through the submission KEY (the natural
 * channel derives a `natural-completion:` key and the host-derived channel a
 * `host-derived:` key, neither of which the ordinary ingress can mint), so a
 * caller cannot claim another channel's provenance.
 */
export type SettlementSource = "submission" | "natural-completion" | "host-derived";

/**
 * Every in-flight attempt a submission can actually settle, plus a per-attempt
 * refusal for each in-flight attempt it cannot.
 *
 * An attempt whose persisted entry carries no credential (a body version that
 * predates credentials) is NOT reported as armed: recovery must refuse it, not
 * offer it as a node awaiting an outcome, because no submission can ever settle
 * it. It is reported in `refusals` instead, with the field that is missing.
 *
 * The credential ITSELF is never part of either report — the armed entry names
 * the node and attempt only, so a recovery report never becomes a second
 * distribution channel for the capability.
 */
export function armedReading(state: OutcomeGraphState): {
  readonly armed: readonly OutcomeArmedNode[];
  readonly refusals: readonly OutcomeRuntimeRefusal[];
} {
  const armed: OutcomeArmedNode[] = [];
  const refusals: OutcomeRuntimeRefusal[] = [];
  state.nodes.forEach((node, index) => {
    if (node.status !== "dispatched" || node.attemptId === undefined) return;
    if (node.attemptCredentialDigest === undefined) {
      refusals.push({
        code: "credential-missing",
        path: "$.nodes[" + index + "].attemptCredentialDigest",
        message:
          "outcome-runtime: node " +
          JSON.stringify(node.nodeId) +
          " is recorded as in flight on attempt " +
          JSON.stringify(node.attemptId) +
          " but its persisted state entry carries no attempt-credential digest — " +
          "so no submission can settle it and it is reported as refused rather than armed",
      });
      return;
    }
    armed.push(Object.freeze({ nodeId: node.nodeId, attemptId: node.attemptId }));
  });
  return {
    armed: Object.freeze(armed),
    refusals: Object.freeze(refusals),
  };
}

/**
 * The run identity minted for one graph's execution.
 *
 * DERIVED, NOT RANDOM, so the same (graph, decision time) always names the same
 * run and a test can predict it. Uniqueness is per graph — the run row's key —
 * and the graph id is part of the value so an id in a report is readable. A
 * RE-EXECUTION uses {@link reexecutionRunIdentityOf} instead, which adds the
 * run's own sequence so a successor can never collide with the id a first run
 * derived from the same instant.
 */
export function runIdentityOf(graphId: string, startedAt: number): string {
  return graphId + "@" + String(startedAt);
}

/**
 * The run identity minted for one RE-EXECUTION of a graph.
 *
 * DERIVED, NOT RANDOM, like {@link runIdentityOf}, and it carries the run's own
 * sequence so two re-executions decided at the same millisecond cannot collide:
 * `run_seq` is unique within a graph by the store's own key, so the id a
 * successor proposes is unique by construction rather than by retry.
 */
export function reexecutionRunIdentityOf(
  graphId: string,
  startedAt: number,
  runSeq: number,
): string {
  return graphId + "@" + String(startedAt) + "+" + String(runSeq);
}

/** The two facts a re-execution needs from a snapshot it may not be able to verify. */
interface RawRunPosition {
  readonly phase: OutcomeGraphPhase;
  readonly attemptSeq: number;
}

/**
 * Read one state body's PHASE and ATTEMPT COUNTER without verifying it against a
 * plan.
 *
 * WHY A DEFENSIVE READ IS REQUIRED HERE. Re-executing a graph is exactly the
 * operation that may run a CHANGED plan revision, and a snapshot of an earlier
 * revision cannot be verified against this plan's contracts or topology — the
 * strict reader would refuse it. These two facts are the exception: the phase
 * says whether the run is over, and the counter says where the graph-wide
 * attempt sequence stands. Both are read as VALUES, with a shape check, and
 * anything else about the body is ignored rather than trusted: nothing here
 * decides what the old run meant, and a body that does not carry them refuses
 * the re-execution instead of guessing a counter (a guessed one could mint an
 * attempt id an earlier run already used).
 */
export function rawRunPositionOf(body: unknown): RawRunPosition | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const phase = record["phase"];
  const attemptSeq = record["attemptSeq"];
  if (phase !== "ready" && phase !== "executing" && phase !== "complete" && phase !== "stopped") {
    return undefined;
  }
  if (
    typeof attemptSeq !== "number" ||
    !Number.isSafeInteger(attemptSeq) ||
    attemptSeq < 0
  ) {
    return undefined;
  }
  return Object.freeze({ phase, attemptSeq });
}

/**
 * Internal: a re-execution whose conditional write did not land.
 *
 * Thrown INSIDE the minting transaction so the whole transaction rolls back —
 * the run row, the order's successor link and every effect it wrote — and caught
 * by {@link OutcomeGraphRuntime.reexecute}, which reports the race as a value.
 * It carries no message a caller sees verbatim: the refusal's own wording is the
 * report.
 */
export class ReexecutionRacedError extends Error {
  constructor(readonly step: string) {
    super(step);
    this.name = "ReexecutionRacedError";
  }
}

/** The state's progress for one node, when that node is currently in flight. */
export function dispatchedNodeOf(
  state: OutcomeGraphState,
  nodeId: string,
): OutcomeNodeState | undefined {
  const node = stateNodeOf(state, nodeId);
  return node?.status === "dispatched" ? node : undefined;
}

/**
 * The state's entry for one node, whatever its status.
 *
 * Recovery needs the settled case too: an effect whose attempt has settled is
 * COMPLETE, and reporting it as "the state does not record that attempt as in
 * flight" would turn a finished dispatch into a disagreement.
 */
export function stateNodeOf(
  state: OutcomeGraphState,
  nodeId: string,
): OutcomeNodeState | undefined {
  for (const node of state.nodes) {
    if (node.nodeId === nodeId) return node;
  }
  return undefined;
}

/** What reading a raw host-completion delivery produced. */
type HostCompletionFactReading =
  | { readonly kind: "ok"; readonly fact: HostCompletionFact }
  | { readonly kind: "malformed"; readonly issues: readonly OutcomeRuntimeRefusal[] };

/**
 * Read an untrusted value as a {@link HostCompletionFact}.
 *
 * TOTAL, and CLOSED exactly like the bearer channel's envelope
 * (`natural-completion.ts`): the three fields must be non-empty strings and any
 * other key is refused BY NAME — an `outcomeId`, a payload or an evidence list
 * offered alongside a completion fact is not dropped, because a completion that
 * could carry a result would be a second submission channel. A property read
 * that throws (an accessor, a hostile Proxy) is contained as one more malformed
 * issue rather than escaping.
 */
export function readHostCompletionFact(value: unknown): HostCompletionFactReading {
  const issues: OutcomeRuntimeRefusal[] = [];
  const malformed = (path: string, message: string): void => {
    issues.push({ code: "malformed-host-completion", path, message });
  };
  try {
    if (!isRecord(value)) {
      return {
        kind: "malformed",
        issues: [
          {
            code: "malformed-host-completion",
            path: "$",
            message:
              "a host-completion delivery is a record of { nodeId, attemptId, executionId }, " +
              "received " +
              describeValue(value),
          },
        ],
      };
    }
    for (const key of Object.keys(value)) {
      if (key !== "nodeId" && key !== "attemptId" && key !== "executionId") {
        malformed(
          "$." + key,
          "unknown key " +
          JSON.stringify(key) +
          " — a host-completion delivery carries only the node, the attempt and the host " +
          "execution that finished, and an unrecognized field is refused rather than " +
          "dropped: a completion fact is not a submission and has no channel for an outcome, " +
          "a payload or evidence",
        );
      }
    }
    // Read each field EXACTLY ONCE into a local, so an accessor-backed record
    // cannot answer one value to the check and another to the construction.
    const nodeId = nonEmptyString(value.nodeId);
    if (nodeId === undefined) {
      malformed(
        "$.nodeId",
        "nodeId is " + describeValue(value.nodeId) + ", not a non-empty node id",
      );
    }
    const attemptId = nonEmptyString(value.attemptId);
    if (attemptId === undefined) {
      malformed(
        "$.attemptId",
        "attemptId is " + describeValue(value.attemptId) + ", not a non-empty attempt id",
      );
    }
    const executionId = nonEmptyString(value.executionId);
    if (executionId === undefined) {
      malformed(
        "$.executionId",
        "executionId is " +
        describeValue(value.executionId) +
        ", not the non-empty host execution id the platform named",
      );
    }
    if (nodeId === undefined || attemptId === undefined || executionId === undefined) {
      return { kind: "malformed", issues };
    }
    return {
      kind: "ok",
      fact: Object.freeze({ nodeId, attemptId, executionId }),
    };
  } catch (error) {
    return {
      kind: "malformed",
      issues: [
        {
          code: "malformed-host-completion",
          path: "$",
          message:
            "the host-completion delivery could not be read (" + errorText(error) + ")",
        },
      ],
    };
  }
}

/** What reading a persisted dispatch-effect payload produced. */
type DispatchPayloadReading =
  | { readonly kind: "ok"; readonly target: OutcomeDispatchTarget }
  | { readonly kind: "malformed"; readonly message: string };

/**
 * Read one dispatch effect's persisted payload as a dispatch TARGET.
 *
 * The payload is JSON the ledger stored verbatim, so it is UNTRUSTED here
 * even though this runtime wrote it: the graph and plan revision it names must
 * be this runtime's own, every field must be a non-empty string, and anything
 * else is a malformed effect that is REPORTED rather than launched at a
 * guessed target. A payload that carries a `credential` key is malformed too:
 * the credential is never persisted on an effect, so one there means the row
 * was written by something that is not this runtime.
 */
export function readDispatchRequest(
  payload: unknown,
  graphId: string,
  planRevision: string,
): DispatchPayloadReading {
  if (!isRecord(payload)) {
    return {
      kind: "malformed",
      message:
        "a dispatch effect payload is " +
        describeValue(payload) +
        ", not a dispatch request record",
    };
  }
  const namedGraph = nonEmptyString(payload.graphId);
  if (namedGraph !== graphId) {
    return {
      kind: "malformed",
      message:
        "dispatch request names graph " +
        describeValue(payload.graphId) +
        ", not " +
        JSON.stringify(graphId),
    };
  }
  const namedRevision = nonEmptyString(payload.planRevision);
  if (namedRevision !== planRevision) {
    return {
      kind: "malformed",
      message:
        "dispatch request names plan revision " +
        describeValue(payload.planRevision) +
        ", not " +
        JSON.stringify(planRevision),
    };
  }
  if (payload.credential !== undefined) {
    return {
      kind: "malformed",
      message:
        "a dispatch effect payload carries a credential — this runtime never persists one on an " +
        "effect, so the row was not written by this runtime and is not launched",
    };
  }
  const nodeId = nonEmptyString(payload.nodeId);
  const attemptId = nonEmptyString(payload.attemptId);
  const agent = nonEmptyString(payload.agent);
  const prompt = nonEmptyString(payload.prompt);
  if (
    nodeId === undefined ||
    attemptId === undefined ||
    agent === undefined ||
    prompt === undefined
  ) {
    return {
      kind: "malformed",
      message:
        "a dispatch request carries a node, attempt, agent and prompt that are not all " +
        "non-empty strings",
    };
  }
  // THE BOUND INPUT VIEW IS DECODED WITH THE STATE READER'S OWN RULES (D6), so a
  // body the state accepts is exactly a payload this accepts. ABSENT is read as
  // absent — a row written before this build bound inputs — and a row that
  // carries a malformed one is REPORTED rather than launched at a guessed view.
  let inputs: readonly ResolvedInput[] | undefined;
  if (payload.inputs !== undefined) {
    const reading = readResolvedInputs(payload.inputs, "$.inputs");
    if (reading.kind === "malformed") {
      return { kind: "malformed", message: reading.message };
    }
    inputs = reading.entries;
  }
  return {
    kind: "ok",
    target: Object.freeze({
      graphId,
      planRevision,
      nodeId,
      attemptId,
      agent,
      prompt,
      ...(inputs === undefined ? {} : { inputs }),
    }),
  };
}

/** A non-empty string, or `undefined` — the dispatch payload's field rule. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Whether a value is a non-array record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The submission id of one proposal: its canonical content digest, in the
 * namespace of the channel that settled.
 *
 * CONTENT-ADDRESSED on purpose. One logical submission is one proposal content
 * for one attempt, so a retried submission derives the SAME key and the ledger
 * replays the persisted decision instead of writing a second receipt. The
 * NAMESPACE is the provenance: the ordinary ingress always derives
 * `submission:<digest>`, the natural-completion channel derives
 * `natural-completion:<digest>` (see `natural-completion.ts`) and the
 * host-derived channel derives `host-derived:<digest>` (see `host-derived.ts`),
 * so the persisted receipt and accepted event say which channel committed. The
 * three namespaces cannot collide, and a proposal's content cannot choose one —
 * only the runtime's own `source` can.
 *
 * A proposal that cannot be digested at all gets a placeholder key: the digest
 * failure is the acceptance core's refusal to report, and nothing is written
 * under either key.
 */
export function submissionIdOf(proposal: unknown, source: SettlementSource): string {
  const reading = readOutcomeProposal(proposal);
  if (reading.kind !== "ok") return "unclaimed-submission";
  try {
    const digest = proposalDigest(reading.proposal);
    if (source === "natural-completion") return naturalCompletionSubmissionId(digest);
    if (source === "host-derived") return hostDerivedSubmissionId(digest);
    return "submission:" + digest;
  } catch {
    return "unrepresentable-submission";
  }
}
