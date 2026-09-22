/**
 * Graph Execution Engine v2 — attempt credentials (stage D, decision 1)
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * The runtime-issued, attempt-scoped bearer credential an outcome-protocol
 * worker presents when it submits an outcome. The credential is MINTED HERE at
 * attempt creation by the runtime that owns the attempt — never supplied by a
 * worker and never derived from the node or attempt identity — and its BINDING
 * TUPLE is `graphId + nodeId + attemptId + planRevision + permission`.
 *
 * WHAT A BEARER CREDENTIAL PROVES, STATED HONESTLY. A high-entropy nonce
 * proves POSSESSION of that nonce: an agent that never received the attempt's
 * credential cannot guess it, and a credential issued for attempt A cannot be
 * re-aimed at attempt B because the runtime holds the binding, not the token
 * alone. It does NOT prove that the presenter is the original worker: anything
 * that can read the dispatch channel — a leaked transcript, a copied payload, a
 * process the worker handed its own state to — can present the same bearer token
 * and be indistinguishable from the worker. Establishing "the original worker
 * said this" needs a host identity or a signature over the submission, which
 * this protocol does not have and does not claim. A trusted host invocation
 * context (the invoking session or agent id) can only ADD a constraint on top:
 * a host that has one MAY require it to agree with the attempt's own dispatch
 * record. This build records no host context on an attempt, so it makes no such
 * claim, and the core below depends on no host and works without one.
 *
 * WHERE ISSUANCE AND STORAGE LIVE — A REQUIREMENT ON THE HOST, NOT A PROPERTY
 * OF THIS BUILD. Minting happens in the runtime process, and the bound nonce
 * lives in the graph-state row of the acceptance ledger under the configured
 * store root (`<stateDir>/.rolebox/state/graph-acceptance-ledger.sqlite`),
 * which only an acceptance transaction writes. The bearer guarantee above
 * PRESUPPOSES that this row is out of the dispatched worker's write scope: a
 * process that can write those bytes can read the nonce, rebind it to another
 * attempt and be accepted, and the protocol has nothing left to refuse it
 * with. The host must therefore keep the ledger where the worker cannot write
 * (a separate account, a read-only mount, or a worker with no file access to
 * it) and inject that root as the toolset's `stateDir`. THIS REPOSITORY'S
 * DEFAULT DOES NOT MEET THE REQUIREMENT: `stateDir` defaults to the
 * workspace, so the ledger sits under `<workspace>/.rolebox/state` inside the
 * tree a worker with ordinary file tools can read and rewrite. Nothing in this
 * module checks the boundary, so the credential's resistance to guessing and
 * to re-aiming is real but contingent on that deployment requirement.
 *
 * THE CREDENTIAL NAMES NOTHING. The run path resolves the attempt FROM the
 * persisted binding, refuses a credential that names no recorded attempt, and
 * never falls back to "the node's current attempt" — a caller may present a
 * credential, but cannot move it to another execution.
 *
 * Dependency leaf: the only import is `node:crypto`, so the state reader, the
 * run path and a test harness may depend on it without a cycle.
 */

import { randomBytes } from "node:crypto";

// ── The scope ───────────────────────────────────────────────────────────────

/**
 * The ONE permission an attempt credential is scoped to in this protocol:
 * submitting an outcome for the attempt it was issued for.
 *
 * It is a protocol constant rather than per-attempt data — no attempt can be
 * issued a wider scope today — and it is part of the binding tuple so a future
 * scope is a new binding, not a reinterpretation of an old credential.
 */
export const SUBMIT_OUTCOME_PERMISSION = "submit-outcome" as const;

/** The permission vocabulary of an attempt credential. */
export type AttemptPermission = typeof SUBMIT_OUTCOME_PERMISSION;

/**
 * The tuple a credential is bound to, exactly as the runtime computes it at
 * issuance. Every component is runtime provenance:
 *
 * - `graphId` and `planRevision` come from the compiled plan the runtime runs;
 * - `nodeId` and `attemptId` come from the attempt the runtime minted;
 * - `permission` is {@link SUBMIT_OUTCOME_PERMISSION}.
 *
 * The persisted state entry records the tuple by CONTAINING its parts: the body
 * carries `graphId` and `planRevision`, the entry carries `nodeId`,
 * `attemptId` and the nonce, and the permission is the protocol constant. A
 * submission is checked against the tuple the reader reconstructed from that
 * record — never against a tuple the caller supplied.
 */
export interface AttemptCredentialBinding {
  /** The graph the attempt belongs to. */
  readonly graphId: string;
  /** The plan node the attempt executes. */
  readonly nodeId: string;
  /** The runtime-minted attempt the credential names. */
  readonly attemptId: string;
  /** The plan revision the attempt is bound to. */
  readonly planRevision: string;
  /** The single permission the credential grants. */
  readonly permission: AttemptPermission;
}

/** The runtime-provenance part of a binding; the permission is implied. */
export interface AttemptIdentity {
  readonly graphId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly planRevision: string;
}

// ── Minting ─────────────────────────────────────────────────────────────────

/**
 * Where the nonce comes from. A source is a function of the binding, so a test
 * can derive a deterministic credential per attempt (and assert on it) while
 * the runtime injects the random source. The binding is passed because the
 * runtime, not the source, owns what the credential is bound to; a source that
 * ignores it still receives it.
 */
export type AttemptCredentialSource = (binding: AttemptCredentialBinding) => string;

/** The nonce size the runtime's default source mints, in bytes (256 bits). */
export const ATTEMPT_CREDENTIAL_BYTES = 32;

/**
 * Build the binding tuple of one attempt. The permission is not a parameter:
 * this protocol issues credentials for exactly one scope.
 */
export function attemptCredentialBinding(
  identity: AttemptIdentity,
): AttemptCredentialBinding {
  return Object.freeze({
    graphId: identity.graphId,
    nodeId: identity.nodeId,
    attemptId: identity.attemptId,
    planRevision: identity.planRevision,
    permission: SUBMIT_OUTCOME_PERMISSION,
  });
}

/**
 * The runtime's default source: {@link ATTEMPT_CREDENTIAL_BYTES} bytes from the
 * platform CSPRNG, hex-encoded. Not derived from the node, the attempt or the
 * plan revision — the binding is checked out of band, and a guessed value would
 * have to match the persisted nonce exactly.
 */
export const RUNTIME_ATTEMPT_CREDENTIAL_SOURCE: AttemptCredentialSource = () =>
  randomBytes(ATTEMPT_CREDENTIAL_BYTES).toString("hex");

/**
 * Mint one attempt credential and refuse a source that answers nothing usable.
 *
 * A source that returns an empty or non-string value is a PROGRAMMING error in
 * the injected generator, not a submission to repair: an attempt persisted
 * without a usable credential could never be settled, so the mint throws here
 * rather than writing a state entry no submission can name. The default source
 * always answers {@link ATTEMPT_CREDENTIAL_BYTES} bytes of hex.
 */
export function mintAttemptCredential(
  source: AttemptCredentialSource,
  binding: AttemptCredentialBinding,
): string {
  const credential = source(binding);
  if (!isAttemptCredential(credential)) {
    throw new Error(
      "attempt-credential: the injected credential source answered " +
        describeValue(credential) +
        " for attempt " +
        JSON.stringify(binding.nodeId) +
        " — an attempt credential is a non-empty string",
    );
  }
  return credential;
}

// ── Shape ───────────────────────────────────────────────────────────────────

/**
 * The shape rule of a credential value: a non-empty string.
 *
 * The VALUE is opaque — no structure, no checksum, no prefix — so a credential
 * carries no information a worker could use to derive another one. Length is
 * not enforced because an injected test source may mint a short deterministic
 * value; the SHIPPED source mints 256 bits.
 */
export function isAttemptCredential(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Describe a rejected value for a diagnostic without ever throwing. */
function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return String(value);
}
