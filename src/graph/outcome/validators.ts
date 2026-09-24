import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

import type { NormalizedOutcomeProposal } from "./proposal.ts";
import { artifactIdOf, putArtifact } from "../store/artifacts.ts";

// ── Validator identity ──────────────────────────────────────────────────────

/**
 * The exact identity of one validator implementation: a name and a version.
 *
 * Both fields are required here even though a plan requirement may omit the
 * version while it is unresolved: an EXECUTABLE plan pins one, and this module
 * has no way to run "any version" of a validator.
 */
export interface ValidatorKey {
  /** Validator name, as the plan's requirement names it. */
  readonly id: string;
  /** Exact version; a positive safe integer, compared by identity only. */
  readonly version: number;
}

/** `id@version`, for diagnostics. Not an identity — never parse it back. */
export function validatorKeyText(key: ValidatorKey): string {
  return `${key.id}@${key.version}`;
}

/** Whether two validator keys are the same exact identity. */
export function validatorKeysEqual(a: ValidatorKey, b: ValidatorKey): boolean {
  return a.id === b.id && a.version === b.version;
}

// ── Results ─────────────────────────────────────────────────────────────────

/**
 * The result of running one validator.
 *
 * `indeterminate` is the honest answer for "the check could not be completed"
 * — an unreadable artifact, a timeout, an implementation that threw — and the
 * acceptance core treats it exactly like a failure for gate purposes. It is
 * kept distinct from `fail` so diagnostics can tell "the evidence is wrong"
 * from "the evidence could not be judged".
 */
export type ValidationOutcome =
  | {
    readonly kind: "pass";
    /**
     * The artifacts this gate READ and digested, in evidence-reference order.
     *
     * This is the ONLY channel by which a validation's own reading reaches the
     * acceptance transaction, and it deliberately carries the identity the
     * bytes HASH to rather than a path: the acceptance retains those bytes
     * under that identity, so what a downstream consumer receives is what the
     * gate judged — not whatever the path holds by then (P4 item 5 / A17).
     */
    readonly evidence?: readonly ArtifactEvidence[];
  }
  | { readonly kind: "fail"; readonly reason: string }
  | { readonly kind: "indeterminate"; readonly reason: string };

// ── The request ─────────────────────────────────────────────────────────────

/**
 * The execution an acceptance decision belongs to.
 *
 * This is TRUSTED RUNTIME PROVENANCE: the authentication boundary binds it to
 * the tool context, and it is never read from a proposal. It is structurally
 * the ledger's submission key, because the identity a decision is bound to and
 * the identity a receipt is keyed by are the same triple.
 */
export interface ExecutionIdentity {
  readonly graphId: string;
  readonly attemptId: string;
  readonly submissionId: string;
}

/**
 * Everything one validator implementation may look at.
 *
 * Every field is bound BEFORE the implementation runs and every result is
 * stamped with the same binding afterwards, so a result can never be read as
 * evidence for a different proposal, plan revision or execution.
 */
export interface ValidatorRequest {
  /** The exact identity this implementation was resolved under. */
  readonly key: ValidatorKey;
  /** The submission's canonical proposal. */
  readonly proposal: NormalizedOutcomeProposal;
  /** Digest of that canonical proposal. */
  readonly proposalDigest: string;
  /** The plan revision the attempt is bound to. */
  readonly planRevision: string;
  /** The trusted execution the submission belongs to. */
  readonly identity: ExecutionIdentity;
  /** The root every evidence reference must resolve inside. */
  readonly artifactRoot: string;
  /**
   * The outcome's declared DATA CONTRACT, when the compiled plan declares one.
   *
   * TRUSTED PLAN CONTENT, read from the committed compiled outcome the
   * submission is judged against — never from the proposal. A payload-shape
   * validator therefore resolves the schema IDENTITY the plan pinned, so a
   * worker cannot choose (or omit) the schema it is judged by, and the absence
   * of a declared contract is visible to the implementation instead of being
   * filled in from whatever the submission happened to carry.
   */
  readonly dataContract?: ValidatorDataContract;
  /** The caller-supplied clock, in epoch milliseconds. */
  readonly now: number;
}

/**
 * The data contract one compiled outcome declares: a schema identity and, when
 * the schema is versioned, the exact version.
 *
 * Structurally the plan's own `CompiledOutcomeData`, restated here so this
 * module stays a dependency leaf (it imports no compiler module) while the
 * acceptance core can pass the plan's value through unchanged.
 */
export interface ValidatorDataContract {
  /** Schema identity, e.g. a shipped structural schema. */
  readonly schema: string;
  /** Exact schema version; matching is identity, never ordering. */
  readonly version?: number;
}

/** One validator implementation: a pure function of its request. */
export type ValidatorImplementation = (
  request: ValidatorRequest,
) => ValidationOutcome;

/** One implementation the caller installs, under its exact identity. */
export interface ValidatorRegistration {
  /** Validator name. */
  readonly id: string;
  /** Exact version; a positive safe integer. */
  readonly version: number;
  /** The implementation itself. */
  readonly implementation: ValidatorImplementation;
  /** Optional human-readable note; not consulted by the acceptance core. */
  readonly description?: string;
}

/**
 * The installed validator capability, as the acceptance core sees it.
 *
 * Build one with {@link createValidatorRegistry}. `lookup` answers
 * `undefined` for an unregistered identity — the core turns that into a
 * refusal, so absence is never mistaken for a pass.
 */
export interface ValidatorRegistry {
  /** Every registered key, in registration order. */
  readonly keys: readonly ValidatorKey[];
  /** The implementation registered at exactly this identity, or `undefined`. */
  lookup(key: ValidatorKey): ValidatorImplementation | undefined;
}

/**
 * Build a deeply frozen registry from explicit registrations.
 *
 * Every violation is a programmer error with exactly one sensible owner, so it
 * throws HERE rather than becoming a lookup that mysteriously misses:
 * - an empty id or a non-positive-safe-integer version names nothing, so it can
 *   never be a key (the same legality rule the storage-format and
 *   execution-protocol registries apply);
 * - a non-function implementation is not a capability;
 * - a duplicate `{ id, version }` pair — one exact identity has exactly one
 *   implementation, otherwise which one runs would depend on array order.
 *
 * The registry object, its key list and every key it hands out are frozen, so
 * the installed set cannot move after construction.
 */
export function createValidatorRegistry(
  registrations: readonly ValidatorRegistration[],
): ValidatorRegistry {
  const keys: ValidatorKey[] = [];
  const implementations = new Map<string, ValidatorImplementation>();
  registrations.forEach((registration, index) => {
    if (typeof registration.id !== "string" || registration.id.length === 0) {
      throw new Error(
        `validator-registry: registration[${index}] has no non-empty id — a validator is keyed by an exact { id, version } identity`,
      );
    }
    if (!isPositiveSafeInteger(registration.version)) {
      throw new Error(
        `validator-registry: validator ${JSON.stringify(registration.id)} has version ${describeValue(registration.version)}, not a positive safe integer — versions are compared by identity, never by ordering`,
      );
    }
    if (typeof registration.implementation !== "function") {
      throw new Error(
        `validator-registry: validator ${JSON.stringify(registration.id)}@${registration.version} has no implementation function`,
      );
    }
    const text = keyText(registration.id, registration.version);
    if (implementations.has(text)) {
      throw new Error(
        `validator-registry: ${validatorKeyText(registration)} is registered twice — one exact identity has exactly one implementation, otherwise which one runs would depend on array order`,
      );
    }
    keys.push(
      Object.freeze({ id: registration.id, version: registration.version }),
    );
    implementations.set(text, registration.implementation);
  });
  const frozenKeys: readonly ValidatorKey[] = Object.freeze(keys);
  const byKey = implementations;
  return Object.freeze({
    keys: frozenKeys,
    lookup: (key: ValidatorKey): ValidatorImplementation | undefined =>
      byKey.get(keyText(key.id, key.version)),
  });
}

// ── The concrete acceptance capability set (A22) ────────────────────────────

/** One installed schema implementation's exact identity, as a data contract names it. */
export interface SchemaCapabilityIdentity {
  readonly schema: string;
  readonly version: number;
}

/** One host-authorized command check's exact mapping identity. */
export interface CommandMappingCapabilityIdentity {
  readonly graphId: string;
  readonly nodeId: string;
  readonly outcome: string;
}

/**
 * THE ONE HOST CAPABILITY DESCRIPTION compile and run both resolve against.
 *
 * `validators` is the installed registry's key list; `schemas` and
 * `commandMappings` are the CONCRETE identities those installed validators can
 * substantiate, derived from the very values their implementations close over.
 * A compilation resolves a requirement's concrete identity here, so a plan can
 * neither pin `schema@1` for a schema this host did not install nor require a
 * command check for a mapping no trusted policy authorizes.
 *
 * There is deliberately NO second, hand-written compile-time capability list: a
 * set that could drift from the installed registrations would let a plan be
 * compiled against capabilities the run path cannot resolve.
 */
export interface AcceptanceCapabilitySet {
  readonly approvalMappings?: readonly { readonly graphId: string; readonly nodeId: string }[];
  readonly validators: readonly ValidatorKey[];
  readonly schemas: readonly SchemaCapabilityIdentity[];
  readonly commandMappings: readonly CommandMappingCapabilityIdentity[];
}

/** Whether the host installed this EXACT schema identity (matching is identity, never ordering). */
export function substantiatesSchema(
  set: AcceptanceCapabilitySet,
  contract: { readonly schema: string; readonly version?: number },
): boolean {
  if (!isPositiveSafeInteger(contract.version)) return false;
  return set.schemas.some(
    (identity) =>
      identity.schema === contract.schema && identity.version === contract.version,
  );
}

/** Whether a trusted policy authorizes a check for this EXACT graph/node/outcome mapping. */
export function substantiatesCommandMapping(
  set: AcceptanceCapabilitySet,
  mapping: CommandMappingCapabilityIdentity,
): boolean {
  return set.commandMappings.some(
    (identity) =>
      identity.graphId === mapping.graphId &&
      identity.nodeId === mapping.nodeId &&
      identity.outcome === mapping.outcome,
  );
}

// ── Built-in: artifact-reference validation ─────────────────────────────────

/** The shipped artifact-reference validator's name. */
export const ARTIFACT_REFERENCE_VALIDATOR_ID = "artifact-reference";

/** The shipped artifact-reference validator's exact version. */
export const ARTIFACT_REFERENCE_VALIDATOR_VERSION = 1;

/** What one evidence reference resolved to: the artifact as it was READ. */
export interface ArtifactEvidence {
  /**
   * The reference exactly as the proposal declared it. PROVENANCE: it is
   * recorded for an operator and is NEVER resolved again by a consumer.
   */
  readonly ref: string;
  /** The content identity `sha256:<hex>` — what an accepted result names. */
  readonly artifactId: string;
  /** SHA-256 hex of the bytes read from the artifact. */
  readonly digest: string;
  /** The byte length of those bytes. */
  readonly size: number;
}

/** The outcome of reading one evidence reference. */
export type ArtifactRead =
  | {
    readonly kind: "read";
    readonly evidence: ArtifactEvidence;
    /**
     * THE EXACT BYTES the digest above was taken over.
     *
     * They are returned rather than re-read by the caller on purpose: a second
     * read is a different byte range, and retaining THOSE bytes under THIS
     * digest would retain something the gate never judged — the very
     * "validated A, stored B" hole this path exists to close.
     */
    readonly bytes: Buffer;
  }
  | { readonly kind: "problem"; readonly reason: string };

/** Options for {@link createArtifactReferenceValidator}. */
export interface ArtifactReferenceValidatorOptions {
  /**
   * Called once per artifact, in evidence-reference order, with the identity of
   * the bytes that were actually read. This is where a digest/size record goes;
   * without a recorder the validator still reads and digests every artifact, and
   * a failure still names the artifact it concerns.
   */
  readonly onArtifact?: (evidence: ArtifactEvidence) => void;
  /**
   * The immutable artifact store to RETAIN the bytes in, when this host has one.
   *
   * RETAINING IS NOT OPTIONAL FOR THE PROPERTY THIS GATE IS FOR. Reading and
   * digesting proves "at validation time this reference named these bytes"; only
   * holding the bytes under their own digest lets a later consumer receive them
   * after the path has changed. A host that configures no store still validates
   * (a test, or an embedder with no durable root), and its acceptance simply
   * carries no retained revision — which is a refusal, never a re-read.
   */
  readonly artifactStoreRoot?: string;
}

/**
 * The artifact-reference validator: every evidence reference the submission
 * declares must resolve to a regular file inside `request.artifactRoot`, and
 * each one is read once and digested.
 *
 * The property it proves is exactly this and nothing more: at validation time,
 * these references named these bytes. It is not a claim about the artifact's
 * content, and it is not a path-exists check — the digest is taken over the
 * bytes read in the same operation, so a validator never records a digest for
 * a file it did not read.
 *
 * A submission that declares NO evidence fails rather than passing vacuously:
 * a required artifact gate whose subject set is empty is precisely the trivial
 * check the protocol forbids, so absence of evidence is never evidence.
 */
export function createArtifactReferenceValidator(
  options: ArtifactReferenceValidatorOptions = {},
): ValidatorImplementation {
  const onArtifact = options.onArtifact;
  const storeRoot = options.artifactStoreRoot;
  return (request: ValidatorRequest): ValidationOutcome => {
    const refs = request.proposal.evidenceRefs;
    if (refs.length === 0) {
      return {
        kind: "fail",
        reason:
          "the submission declares no evidence references, so a required artifact gate has nothing to verify — absence of evidence is not evidence",
      };
    }
    const problems: string[] = [];
    const evidence: ArtifactEvidence[] = [];
    for (const ref of refs) {
      const read = readArtifact(request.artifactRoot, ref);
      if (read.kind === "problem") {
        problems.push(read.reason);
        continue;
      }
      let retained = read.evidence;
      if (storeRoot !== undefined) {
        // RETAIN THE EXACT BYTES THIS GATE READ, BEFORE any acceptance
        // transaction opens: a file write inside the transaction would break the
        // one atomic boundary §3.1 requires, and the object must exist before
        // the reference to it is committed. `read.bytes` IS the byte range the
        // digest was taken over — never a second read of the path.
        //
        // A retention that could not be PUBLISHED is a FAILED gate, not a
        // partial one: an acceptance that named this revision could never read
        // it back, so the submission is refused here instead.
        const deposit = putArtifact(storeRoot, read.bytes);
        if (deposit.kind === "problem") {
          problems.push(
            "artifact " +
            JSON.stringify(ref) +
            " could not be retained: " +
            deposit.reason,
          );
          continue;
        }
        retained = Object.freeze({
          ...read.evidence,
          artifactId: deposit.artifactId,
          digest: deposit.digest,
          size: deposit.size,
        });
      }
      evidence.push(retained);
      if (onArtifact !== undefined) onArtifact(retained);
    }
    if (problems.length > 0) {
      return {
        kind: "fail",
        reason:
          "evidence references did not resolve to readable artifacts: " +
          problems.join("; "),
      };
    }
    return { kind: "pass", evidence: Object.freeze(evidence) };
  };
}

/**
 * Read ONE evidence reference under `root` and answer its digest and size.
 *
 * The checks, in order, each a `problem` rather than an exception:
 * 1. the reference is non-empty and carries no NUL byte;
 * 2. the root resolves, and the reference resolves INSIDE it — an absolute
 *    path, a `..` escape or a different drive is refused before any read;
 * 3. the path resolves to a real location that is still inside the root, so a
 *    symlink pointing out of the root does not smuggle a read;
 * 4. it is a regular file, and it is read ONCE — the digest and the size are
 *    both taken from the bytes that were read, so no unrelated later read can
 *    describe an artifact this check did not see.
 */
export function readArtifact(root: string, ref: string): ArtifactRead {
  if (ref.length === 0 || ref.includes("\u0000")) {
    return {
      kind: "problem",
      reason: `evidence reference ${JSON.stringify(ref)} is empty or contains a NUL byte`,
    };
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch (error) {
    return {
      kind: "problem",
      reason: `the artifact root ${JSON.stringify(root)} cannot be resolved (${errorText(error)})`,
    };
  }
  const candidate = resolve(realRoot, ref);
  if (!isInside(realRoot, candidate)) {
    return {
      kind: "problem",
      reason: `evidence reference ${JSON.stringify(ref)} escapes the artifact root ${JSON.stringify(realRoot)}`,
    };
  }
  let realPath: string;
  try {
    realPath = realpathSync(candidate);
  } catch (error) {
    return {
      kind: "problem",
      reason: `evidence reference ${JSON.stringify(ref)} does not resolve to a real path (${errorText(error)})`,
    };
  }
  if (!isInside(realRoot, realPath)) {
    return {
      kind: "problem",
      reason: `evidence reference ${JSON.stringify(ref)} resolves through a link to ${JSON.stringify(realPath)}, outside the artifact root ${JSON.stringify(realRoot)}`,
    };
  }
  try {
    if (!statSync(realPath).isFile()) {
      return {
        kind: "problem",
        reason: `evidence reference ${JSON.stringify(ref)} is not a regular file`,
      };
    }
  } catch (error) {
    return {
      kind: "problem",
      reason: `evidence reference ${JSON.stringify(ref)} cannot be examined (${errorText(error)})`,
    };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(realPath);
  } catch (error) {
    return {
      kind: "problem",
      reason: `evidence reference ${JSON.stringify(ref)} cannot be read (${errorText(error)})`,
    };
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    kind: "read",
    evidence: {
      ref,
      artifactId: artifactIdOf(digest),
      digest,
      size: bytes.length,
    },
    bytes,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** The registry's map key: NUL cannot occur in a name, so it cannot collide. */
function keyText(id: string, version: number): string {
  return `${id}\u0000${version}`;
}

/** Whether `candidate` is `root` itself or lies below it. */
function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(prefix);
}

/** Whether a value is a positive safe integer (the capability-legality rule). */
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Describe a rejected value for a diagnostic without ever throwing. */
function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return typeof value;
}

/** The message of a caught value, without assuming it is an Error. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
