import { createHash, randomBytes } from "node:crypto";

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
 * `attemptId` and the credential's DIGEST, and the permission is the protocol
 * constant. A submission is checked against the tuple the reader reconstructed
 * from that record — never against a tuple the caller supplied — by hashing the
 * presented credential and comparing it to the recorded verifier.
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

// ── The persisted form ──────────────────────────────────────────────────────

/**
 * The prefix every persisted credential DIGEST carries.
 *
 * A digest is a value this build can verify against but can never present: the
 * bearer credential itself is handed to one dispatch channel and kept by the
 * host store, while the durable record keeps only the verifier. The prefix
 * makes the two unmistakable in a diagnostic, so a store that receives a digest
 * where it expects a credential is refused by name rather than used as one.
 */
export const ATTEMPT_CREDENTIAL_DIGEST_PREFIX = "sha256:" as const;

/** The digest length in bits — the platform hash, named once. */
const ATTEMPT_CREDENTIAL_DIGEST_HEX = 64;

/**
 * The DIGEST of one attempt credential: what the persisted state body records.
 *
 * WHY A DIGEST AND NOT THE CREDENTIAL. The credential is a bearer nonce: any
 * process that can READ the value can present it and be accepted as the attempt
 * it was issued for. A durable record that carries the nonce therefore IS a
 * second, unprotected copy of the capability — which is exactly the defect the
 * credential-isolation capability exists to close (a read-only open of the
 * acceptance ledger, then a submission with another attempt's credential, was
 * ACCEPTED before this rule). A digest closes it at the storage layer, without
 * depending on any host, filesystem permission or mount option: the record
 * proves possession of the credential (verification hashes what the submitter
 * presents and compares) while nothing recoverable is written down. It is
 * also stable across processes and restarts, so a legitimate submission still
 * settles its attempt after the process that dispatched it is gone.
 *
 * WHAT THE DIGEST DOES NOT DO. It cannot be handed back to a worker: a recovered
 * attempt is re-delivered from the HOST's store, which holds the credential
 * itself (see `credential-isolation.ts`). A host that cannot produce it is
 * reported, never handed a fabricated one.
 *
 * The hash is the platform digest of the exact credential string (UTF-8); the
 * nonce's 256 bits of entropy make the digest non-invertible in practice.
 */
export function attemptCredentialDigest(credential: string): string {
  return (
    ATTEMPT_CREDENTIAL_DIGEST_PREFIX +
    createHash("sha256").update(credential, "utf8").digest("hex")
  );
}

/**
 * Whether a value has the exact shape this build writes for a digest:
 * `sha256:` followed by 64 lowercase hexadecimal digits.
 *
 * STRICT on purpose: a persisted record that carries the credential itself
 * (any layout before body version 8) does not satisfy this, so a state written
 * by that layout is never read as if its nonce were a digest — the version gate
 * owns that distinction and this predicate keeps it checkable.
 */
export function isAttemptCredentialDigest(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value.startsWith(ATTEMPT_CREDENTIAL_DIGEST_PREFIX)) return false;
  const hex = value.slice(ATTEMPT_CREDENTIAL_DIGEST_PREFIX.length);
  if (hex.length !== ATTEMPT_CREDENTIAL_DIGEST_HEX) return false;
  for (const character of hex) {
    if (!((character >= "0" && character <= "9") || (character >= "a" && character <= "f"))) {
      return false;
    }
  }
  return true;
}

// ── Resolving the attempt a presented credential names ──────────────────────

/**
 * The fields of a persisted state entry this module needs to locate the attempt
 * a presented credential was issued for. Structural on purpose: the caller
 * passes its own `OutcomeNodeState` (which carries exactly these fields among
 * others) without this dependency leaf importing the state model.
 */
export interface AttemptCredentialEntry {
  readonly nodeId: string;
  readonly attemptId?: string;
  readonly attemptCredentialDigest?: string;
}

/**
 * The entry whose recorded DIGEST matches the presented credential, or
 * `undefined` when no entry does.
 *
 * THE SAME RULE THE RUN PATH APPLIES, exposed so a caller that must make a
 * decision BEFORE the acceptance core — the submission ingress's worker-context
 * check — locates the SAME attempt the run path will settle, rather than
 * re-deriving one from the node id or the node's current attempt. The
 * comparison is a hash of what the caller presents against the recorded
 * verifier: a credential the state never saw, a credential for another node and
 * a credential for a superseded attempt all answer `undefined` here, exactly as
 * they are refused there.
 *
 * WHAT THIS FUNCTION DOES NOT DECIDE. Finding an entry is NOT an acceptance: an
 * entry with no `attemptId`, a node whose status makes the attempt unsettleable
 * and every gate of the declared contract stay the acceptance core's to judge.
 * This locator only says WHICH attempt the submission is about.
 */
export function attemptEntryHoldingCredential(
  entries: readonly AttemptCredentialEntry[],
  credential: string,
): AttemptCredentialEntry | undefined {
  const presented = attemptCredentialDigest(credential);
  for (const entry of entries) {
    if (entry.attemptCredentialDigest === presented) return entry;
  }
  return undefined;
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
