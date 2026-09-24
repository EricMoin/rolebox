import { contractDigest } from "../contracts/contract-definition.ts";

// ── The declaration ─────────────────────────────────────────────────────────

/**
 * The declaration-format version this build reads. An exact identity, checked
 * by {@link readCompletionPolicyBody} like every other capability identity in
 * the protocol: an unknown version is refused, never read approximately.
 */
export const COMPLETION_POLICY_VERSION = 1;

/** One exact `(graph, node, outcome)` mapping a policy decides. */
export interface CompletionPolicyMapping {
  /** The graph id the mapping belongs to (the declaration's `name`). */
  readonly graphId: string;
  /** The node that requests natural completion. */
  readonly nodeId: string;
  /** The one outcome runtime completion would map to. */
  readonly outcome: string;
}

/** One declared decision about one exact mapping. */
export interface CompletionPolicyRule extends CompletionPolicyMapping {
  /**
   * `allow` grants the mapping; `deny` forbids it EXPLICITLY, which the
   * compiler answers as a refusal rather than as a draft.
   */
  readonly decision: "allow" | "deny";
}

/**
 * What the policy decides about a mapping it does not list.
 *
 * - `"deny"` — the policy explicitly denies every unlisted mapping, so an
 *   unmatched request is a compile refusal.
 * - `"ungranted"` — the policy is SILENT about unlisted mappings: they are
 *   not authorized (the request cannot execute) and they are not forbidden
 *   either, so the compiler answers a non-executable draft that names the
 *   ungranted mapping.
 */
export type CompletionPolicyFallback = "deny" | "ungranted";

/**
 * The body of one completion-policy declaration. CLOSED: the reader refuses an
 * own key outside this shape, so the content an authorization digest names is
 * exactly the document that was read.
 */
export interface CompletionPolicyBody {
  /** The declaration-format version — always 1 for this shape. */
  readonly version: 1;
  /** The decision for a mapping no rule lists. */
  readonly default: CompletionPolicyFallback;
  /** The declared rules; at most one per mapping. */
  readonly rules: readonly CompletionPolicyRule[];
}

/**
 * A request for authorization, as a graph declaration states it. It names an
 * identity and nothing else: a declaration cannot carry rules, so it can
 * propose a policy revision but never grant itself one.
 */
export interface CompletionPolicyRequest {
  /** The policy declaration's id. */
  readonly id: string;
  /** The exact revision requested; an opaque immutable identifier. */
  readonly revision: string;
}

/**
 * The content-addressed identity of one policy declaration: the requested
 * `(id, revision)` plus the canonical digest of its body. This is what a plan
 * PINS and what a host AUTHORIZES, so a revision republished with different
 * content is a different identity rather than a silent redefinition.
 */
export interface CompletionPolicyRef extends CompletionPolicyRequest {
  /** `contractDigest` of the declaration body, as lowercase hex. */
  readonly digest: string;
}

/** One verified declaration: its identity and the exact body it names. */
export interface CompletionPolicySnapshot {
  readonly ref: CompletionPolicyRef;
  readonly body: CompletionPolicyBody;
}

/**
 * The installed completion-policy capability: the declarations this process
 * may resolve a natural-completion request against.
 *
 * Membership alone grants nothing: a pinned ref resolves only when the
 * registered BODY actually hashes to the ref's digest, exactly like the
 * contract, storage-format and execution-protocol registries. Build one with
 * {@link createCompletionPolicyRegistry} (consistency by construction) or
 * {@link loadCompletionPolicies} (host-authorized selection from a catalog).
 */
export interface CompletionPolicyRegistry {
  /** The installed declarations, at most one per `(id, revision)` pair. */
  readonly policies: readonly CompletionPolicySnapshot[];
}

/** `policy id → revision → body digest`, the identity side of the capability. */
export type CompletionPolicyIdentityIndex = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

// ── Readers ─────────────────────────────────────────────────────────────────

/**
 * Read one declaration body, or `undefined` when the value is not one.
 *
 * STRICT and total: the version must be exactly 1, `default` must be one of
 * the two declared fallbacks, every rule must be a full
 * `{ graphId, nodeId, outcome, decision }` record of non-empty strings with
 * `decision` in `allow`/`deny`, every rule must be an own key of exactly that
 * shape (no extras), and one mapping has at most one rule — a declaration that
 * decides the same mapping twice has no single meaning, so it is refused
 * rather than resolved by rule order.
 *
 * Returned deeply frozen, and structurally identical to the value read (the
 * reader admits no key it does not copy), so `contractDigest` of the result
 * equals the digest of the accepted input.
 */
export function readCompletionPolicyBody(
  raw: unknown,
): CompletionPolicyBody | undefined {
  if (!isRecord(raw)) return undefined;
  if (!hasExactKeys(raw, ["version", "default", "rules"])) return undefined;
  if (raw.version !== COMPLETION_POLICY_VERSION) return undefined;
  const fallback = raw.default;
  if (fallback !== "deny" && fallback !== "ungranted") return undefined;
  const rawRules = raw.rules;
  if (!Array.isArray(rawRules)) return undefined;
  const rules: CompletionPolicyRule[] = [];
  const seen = new Set<string>();
  for (const entry of rawRules) {
    if (!isRecord(entry)) return undefined;
    if (!hasExactKeys(entry, ["graphId", "nodeId", "outcome", "decision"])) {
      return undefined;
    }
    const graphId = nonEmptyString(entry.graphId);
    const nodeId = nonEmptyString(entry.nodeId);
    const outcome = nonEmptyString(entry.outcome);
    const decision = entry.decision;
    if (graphId === undefined || nodeId === undefined || outcome === undefined) {
      return undefined;
    }
    if (decision !== "allow" && decision !== "deny") return undefined;
    const key = mappingKey({ graphId, nodeId, outcome });
    if (seen.has(key)) return undefined;
    seen.add(key);
    rules.push(Object.freeze({ graphId, nodeId, outcome, decision }));
  }
  return Object.freeze({
    version: COMPLETION_POLICY_VERSION,
    default: fallback,
    rules: Object.freeze(rules),
  });
}

/** Whether a value is a well-formed `(id, revision)` request. */
export function isCompletionPolicyRequest(
  value: unknown,
): value is CompletionPolicyRequest {
  if (!isRecord(value)) return false;
  return (
    nonEmptyString(value.id) !== undefined &&
    nonEmptyString(value.revision) !== undefined
  );
}

/** Whether a value is a well-formed content-addressed policy ref. */
export function isCompletionPolicyRef(
  value: unknown,
): value is CompletionPolicyRef {
  if (!isRecord(value)) return false;
  return (
    nonEmptyString(value.id) !== undefined &&
    nonEmptyString(value.revision) !== undefined &&
    nonEmptyString(value.digest) !== undefined
  );
}

/**
 * The exact identity of one catalog declaration: its `(id, revision)` and the
 * canonical digest of its body.
 *
 * The ONE way a host builds the `authorized` list from a reviewed declaration;
 * the digest is recomputed from the body here, never carried as a label.
 */
export function completionPolicyRefOf(declaration: {
  readonly id: string;
  readonly revision: string;
  readonly body: unknown;
}): CompletionPolicyRef {
  return Object.freeze({
    id: declaration.id,
    revision: declaration.revision,
    digest: contractDigest(declaration.body),
  });
}

/** A policy ref or request as a diagnostic token: `"id"@"revision"`. */
export function describeCompletionPolicy(
  ref: CompletionPolicyRequest,
): string {
  return JSON.stringify(ref.id) + "@" + JSON.stringify(ref.revision);
}

// ── The registry ────────────────────────────────────────────────────────────

/** Input accepted by {@link createCompletionPolicyRegistry}. */
export interface CompletionPolicyRegistryInput {
  /** The declarations to install. */
  readonly policies: readonly CompletionPolicySnapshot[];
}

/**
 * Build a deeply frozen registry from explicit policy snapshots.
 *
 * Consistency is checked HERE rather than left to resolution, because each
 * violation is a programmer error with exactly one sensible owner:
 * - a malformed ref names nothing, so it can never be a key;
 * - a duplicate `(id, revision)` pair — one exact identity has exactly one
 *   declaration, otherwise which body a request resolved to would depend on
 *   array order and a republished revision could silently change in-flight
 *   semantics;
 * - a body this build cannot read — a registry a resolver cannot read is not a
 *   capability;
 * - a body that does not hash to the ref's digest — the digest is a claim the
 *   body must PROVE, never a label to be trusted.
 *
 * Deeply frozen: the registry, the policies array, every ref, every body and
 * every rule. Throws a descriptive `Error` on the first violation.
 */
export function createCompletionPolicyRegistry(
  input: CompletionPolicyRegistryInput,
): CompletionPolicyRegistry {
  const revisionsById = new Map<string, Set<string>>();
  const snapshots: CompletionPolicySnapshot[] = [];
  for (const snapshot of input.policies) {
    const ref = snapshot.ref;
    if (!isCompletionPolicyRef(ref)) {
      throw new Error(
        "completion-policy: malformed policy ref — id, revision and digest must all be non-empty strings",
      );
    }
    const revisions = revisionsById.get(ref.id) ?? new Set<string>();
    if (revisions.has(ref.revision)) {
      throw new Error(
        "completion-policy: duplicate policy " +
        describeCompletionPolicy(ref) +
        " — one exact (id, revision) pair has exactly one declaration",
      );
    }
    revisions.add(ref.revision);
    revisionsById.set(ref.id, revisions);

    const body = readCompletionPolicyBody(snapshot.body);
    if (body === undefined) {
      throw new Error(
        "completion-policy: declaration " +
        describeCompletionPolicy(ref) +
        " is not a version-" +
        COMPLETION_POLICY_VERSION +
        ' completion policy ({ version, default: "deny" | "ungranted", rules })',
      );
    }
    let actual: string;
    try {
      actual = contractDigest(snapshot.body);
    } catch (error) {
      throw new Error(
        "completion-policy: declaration " +
        describeCompletionPolicy(ref) +
        " cannot be content-addressed: " +
        errorText(error),
      );
    }
    if (actual !== ref.digest) {
      throw new Error(
        "completion-policy: declaration " +
        describeCompletionPolicy(ref) +
        " declares digest " +
        ref.digest +
        " but its body hashes to " +
        actual,
      );
    }
    snapshots.push(Object.freeze({ ref: Object.freeze({ ...ref }), body }));
  }
  return Object.freeze({ policies: Object.freeze(snapshots) });
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Verdict for one request (or one pinned ref) against one registry.
 *
 * - `resolved` — an exact registered declaration exists (and, for a ref, its
 *   body hashes to the ref's digest). The verdict CARRIES the snapshot, so the
 *   caller uses a proven capability instead of re-deriving it.
 * - `unknown-policy` — no installed declaration has this `id`.
 * - `unknown-revision` — the id is installed, but not at this exact revision;
 *   a missing capability, never a hint to fall back to another revision.
 * - `digest-mismatch` — the exact identity exists, but its body hashes to
 *   something else: the authorized content is not what is installed.
 */
export type CompletionPolicyResolution =
  | { readonly kind: "resolved"; readonly snapshot: CompletionPolicySnapshot }
  | { readonly kind: "unknown-policy"; readonly id: string }
  | {
    readonly kind: "unknown-revision";
    readonly request: CompletionPolicyRequest;
  }
  | {
    readonly kind: "digest-mismatch";
    readonly ref: CompletionPolicyRef;
    readonly actual: string;
  };

/**
 * Resolve one declaration REQUEST against the installed capability, by exact
 * `(id, revision)` identity.
 *
 * PURE and total over a factory-built registry. The request carries no digest
 * (a declaration must not have to know the content hash of what it asks for),
 * so identity is the whole match; the digest rule belongs to
 * {@link verifyCompletionPolicy}, which checks a PINNED ref.
 */
export function resolveCompletionPolicy(
  request: CompletionPolicyRequest,
  registry: CompletionPolicyRegistry,
): CompletionPolicyResolution {
  const forId = registry.policies.filter(
    (snapshot) => snapshot.ref.id === request.id,
  );
  if (forId.length === 0) return { kind: "unknown-policy", id: request.id };
  const snapshot = forId.find(
    (candidate) => candidate.ref.revision === request.revision,
  );
  if (snapshot === undefined) return { kind: "unknown-revision", request };
  return { kind: "resolved", snapshot };
}

/**
 * Verify one PINNED ref that is already in hand — a plan's authorization, or
 * a ref about to be pinned — against the installed capability.
 *
 * The same identity rules as {@link resolveCompletionPolicy}, plus the content
 * rule: the registered body is RE-HASHED and compared with the ref's digest, so
 * a policy republished under the same `(id, revision)` with different content
 * is `digest-mismatch` rather than a silent redefinition of what was
 * authorized.
 */
export function verifyCompletionPolicy(
  ref: CompletionPolicyRef,
  registry: CompletionPolicyRegistry,
): CompletionPolicyResolution {
  const forId = registry.policies.filter(
    (snapshot) => snapshot.ref.id === ref.id,
  );
  if (forId.length === 0) return { kind: "unknown-policy", id: ref.id };
  const snapshot = forId.find(
    (candidate) => candidate.ref.revision === ref.revision,
  );
  if (snapshot === undefined) return { kind: "unknown-revision", request: ref };
  const actual = contractDigest(snapshot.body);
  if (actual !== ref.digest) return { kind: "digest-mismatch", ref, actual };
  return { kind: "resolved", snapshot };
}

/** What one policy body decides about one exact mapping. */
export type CompletionAuthorizationVerdict =
  | {
    readonly kind: "allowed";
    readonly rule: CompletionPolicyRule;
  }
  | {
    readonly kind: "denied";
    /** The rule that denied it, or absent when the declared default did. */
    readonly rule?: CompletionPolicyRule;
  }
  /**
   * The policy is installed and read, but it neither grants nor forbids this
   * mapping (no rule, and its declared default is `"ungranted"`). The
   * compiler answers a non-executable draft naming it: silence is not a grant,
   * and it is not an explicit denial either.
   */
  | { readonly kind: "undecided" };

/**
 * Decide one exact mapping under one policy body.
 *
 * Exact match on all three of graph, node and outcome — no wildcard, no
 * prefix, no case folding. At most one rule can match (the reader refuses a
 * duplicate mapping), so the answer never depends on rule order. An unmatched
 * mapping answers the body's declared default, which is the one place a policy
 * states what its silence means.
 */
export function decideCompletion(
  body: CompletionPolicyBody,
  mapping: CompletionPolicyMapping,
): CompletionAuthorizationVerdict {
  for (const rule of body.rules) {
    if (
      rule.graphId !== mapping.graphId ||
      rule.nodeId !== mapping.nodeId ||
      rule.outcome !== mapping.outcome
    ) {
      continue;
    }
    return rule.decision === "allow"
      ? Object.freeze({ kind: "allowed" as const, rule })
      : Object.freeze({ kind: "denied" as const, rule });
  }
  return body.default === "deny"
    ? Object.freeze({ kind: "denied" as const })
    : Object.freeze({ kind: "undecided" as const });
}

// ── Issue vocabulary ────────────────────────────────────────────────────────

/**
 * The codes a DRAFT's unauthorized-completion reason may carry. Stable
 * identifiers; wording is not API.
 *
 * A persisted reason outside this set is refused rather than read with an
 * unknown meaning, exactly as the stop and progress vocabularies are.
 */
export type CompletionAuthorizationIssueCode =
  /** No policy capability and/or no declaration request exists. */
  | "completion-policy-unavailable"
  /** The requested policy id is not installed. */
  | "completion-policy-unknown"
  /** The id is installed, but not at the requested exact revision. */
  | "completion-policy-unknown-revision"
  /** The policy resolved but does not grant this mapping. */
  | "completion-policy-ungranted";

/** The draft-reason vocabulary, in canonical order. */
export const COMPLETION_AUTHORIZATION_ISSUE_CODES: readonly CompletionAuthorizationIssueCode[] =
  Object.freeze([
    "completion-policy-unavailable",
    "completion-policy-unknown",
    "completion-policy-unknown-revision",
    "completion-policy-ungranted",
  ]);

/** Read one draft-reason code, or `undefined` when it is not in the vocabulary. */
export function readCompletionAuthorizationIssueCode(
  value: unknown,
): CompletionAuthorizationIssueCode | undefined {
  return COMPLETION_AUTHORIZATION_ISSUE_CODES.find((code) => code === value);
}

/**
 * The codes the RUNTIME reports when an installed capability cannot corroborate
 * a plan's PINNED authorization. Stable identifiers; wording is not API.
 */
export type CompletionPolicySupportIssueCode =
  /** This process was given no completion-policy capability at all. */
  | "completion-policy-unavailable"
  /** The pinned policy id is not installed here. */
  | "completion-policy-unknown"
  /** The pinned revision is not installed here. */
  | "completion-policy-unknown-revision"
  /** The pinned revision is installed with DIFFERENT content. */
  | "completion-policy-digest-mismatch";

// ── Host-authorized loading ─────────────────────────────────────────────────

/**
 * One declaration as a catalog offers it, BEFORE verification. The body is
 * `unknown` on purpose: a catalog is untrusted input until the host's
 * authorized digest and {@link readCompletionPolicyBody} have both accepted it.
 */
export interface CompletionPolicyCatalogEntry {
  readonly id: string;
  readonly revision: string;
  readonly body: unknown;
}

/** Why one catalog entry is not part of the installed capability. */
export type CompletionPolicyLoadIssue =
  /** The catalog entry itself is not `{ id, revision, body }`. */
  | {
    readonly kind: "malformed-catalog-entry";
    readonly index: number;
    readonly message: string;
  }
  /** The host's authorized list carries a value that names no identity. */
  | {
    readonly kind: "malformed-authorization";
    readonly index: number;
    readonly message: string;
  }
  /** The host authorized this identity more than once with different digests. */
  | {
    readonly kind: "conflicting-authorization";
    readonly id: string;
    readonly revision: string;
    readonly digests: readonly string[];
  }
  /** A declared catalog entry the host did not authorize: present, not loaded. */
  | {
    readonly kind: "not-authorized";
    readonly id: string;
    readonly revision: string;
  }
  /** The host authorized an identity the catalog does not offer. */
  | {
    readonly kind: "catalog-missing";
    readonly ref: CompletionPolicyRef;
  }
  /** The catalog body is not a readable completion-policy declaration. */
  | {
    readonly kind: "malformed-policy";
    readonly ref: CompletionPolicyRef;
    readonly message: string;
  }
  /** The catalog body does not hash to the authorized digest. */
  | {
    readonly kind: "digest-mismatch";
    readonly ref: CompletionPolicyRef;
    readonly actual: string;
  };

/** Inputs to {@link loadCompletionPolicies}. */
export interface CompletionPolicyLoadInput {
  /**
   * The declaration catalog to select from — this repository's
   * (`declarations.ts`), the host's own, or both. Untrusted until verified.
   */
  readonly catalog: readonly CompletionPolicyCatalogEntry[];
  /**
   * The exact policy revisions the HOST authorizes, content-pinned. This is
   * the authority: a catalog entry that is not in this list is not installed,
   * and an authorized ref whose body does not hash to `digest` is refused.
   */
  readonly authorized: readonly CompletionPolicyRef[];
}

/** What {@link loadCompletionPolicies} produced. */
export interface CompletionPolicyLoadResult {
  /** The declarations that were authorized AND verified. */
  readonly registry: CompletionPolicyRegistry;
  /**
   * Every entry that was offered but not installed, and why, in canonical
   * order. Evidence for the host, never a silent drop.
   */
  readonly issues: readonly CompletionPolicyLoadIssue[];
}

/**
 * Select the host-authorized declarations out of a catalog and install them.
 *
 * THE HOST DECIDES, THE DIGEST PROVES. For every authorized ref the catalog
 * must offer that exact `(id, revision)`, the body must read as a completion
 * policy, and the body must hash to the authorized digest; anything else is an
 * issue and installs nothing. A catalog entry the host did not authorize is
 * reported as `not-authorized` and is NOT installed — a declaration's
 * presence, however reviewable, is not authority.
 *
 * TOTAL: every failure is an issue. A malformed catalog is never a throw, and
 * the registry it returns contains only declarations that passed every rule.
 */
export function loadCompletionPolicies(
  input: CompletionPolicyLoadInput,
): CompletionPolicyLoadResult {
  const issues: CompletionPolicyLoadIssue[] = [];

  // 1. Index the catalog by exact identity. A repeated identity keeps the first
  //    entry and reports the later one: which body a ref resolved to must never
  //    depend on array order.
  const catalogByIdentity = new Map<string, CompletionPolicyCatalogEntry>();
  const catalogOrder: CompletionPolicyCatalogEntry[] = [];
  input.catalog.forEach((entry, index) => {
    // The catalog is untrusted input, so a value whose reads raise is a
    // malformed entry rather than an escaping exception.
    try {
      if (!isRecord(entry)) {
        issues.push({
          kind: "malformed-catalog-entry",
          index,
          message: "is not a { id, revision, body } record",
        });
        return;
      }
      const id = nonEmptyString(entry.id);
      const revision = nonEmptyString(entry.revision);
      if (id === undefined || revision === undefined) {
        issues.push({
          kind: "malformed-catalog-entry",
          index,
          message: "does not declare non-empty string id and revision fields",
        });
        return;
      }
      const identity = identityKey(id, revision);
      if (catalogByIdentity.has(identity)) {
        issues.push({
          kind: "malformed-catalog-entry",
          index,
          message:
            "repeats the identity " +
            describeCompletionPolicy({ id, revision }) +
            " already offered by an earlier entry — one identity has one declaration",
        });
        return;
      }
      const accepted: CompletionPolicyCatalogEntry = Object.freeze({
        id,
        revision,
        body: entry.body,
      });
      catalogByIdentity.set(identity, accepted);
      catalogOrder.push(accepted);
    } catch (error) {
      issues.push({
        kind: "malformed-catalog-entry",
        index,
        message: "could not be read: " + errorText(error),
      });
    }
  });

  // 2. Group the host's authorizations by identity. The same identity with two
  //    different digests is a contradictory instruction: nothing is installed
  //    for it, because picking either digest would be arbitrary.
  const digestsByIdentity = new Map<string, Set<string>>();
  input.authorized.forEach((ref, index) => {
    try {
      if (!isCompletionPolicyRef(ref)) {
        issues.push({
          kind: "malformed-authorization",
          index,
          message:
            "is not { id, revision, digest } of non-empty strings, so it names no policy",
        });
        return;
      }
      const identity = identityKey(ref.id, ref.revision);
      const digests = digestsByIdentity.get(identity) ?? new Set<string>();
      digests.add(ref.digest);
      digestsByIdentity.set(identity, digests);
    } catch (error) {
      issues.push({
        kind: "malformed-authorization",
        index,
        message: "could not be read: " + errorText(error),
      });
    }
  });

  const authorizedIdentities = [...digestsByIdentity.keys()].sort(compareText);
  const snapshots: CompletionPolicySnapshot[] = [];
  for (const identity of authorizedIdentities) {
    const digests = [...(digestsByIdentity.get(identity) ?? new Set<string>())].sort(
      compareText,
    );
    const parts = splitIdentity(identity);
    if (parts === undefined) continue;
    const { id, revision } = parts;
    if (digests.length > 1) {
      issues.push({
        kind: "conflicting-authorization",
        id,
        revision,
        digests: Object.freeze(digests),
      });
      continue;
    }
    const digest = digests[0];
    if (digest === undefined) continue;
    const ref: CompletionPolicyRef = Object.freeze({ id, revision, digest });
    const entry = catalogByIdentity.get(identity);
    if (entry === undefined) {
      issues.push({ kind: "catalog-missing", ref });
      continue;
    }
    const reading = readCatalogPolicy(entry, ref);
    if ("issue" in reading) {
      issues.push(reading.issue);
      continue;
    }
    snapshots.push(reading.snapshot);
  }

  // 3. Report the catalog entries the host did not authorize. They are simply
  //    not part of this capability; the report is evidence, not a failure.
  for (const entry of catalogOrder) {
    if (digestsByIdentity.has(identityKey(entry.id, entry.revision))) continue;
    issues.push({
      kind: "not-authorized",
      id: entry.id,
      revision: entry.revision,
    });
  }

  return {
    registry: createCompletionPolicyRegistry({ policies: snapshots }),
    issues: Object.freeze(issues),
  };
}

/** Read one catalog body against one authorized ref, or name why not. */
function readCatalogPolicy(
  entry: CompletionPolicyCatalogEntry,
  ref: CompletionPolicyRef,
):
  | { readonly snapshot: CompletionPolicySnapshot }
  | { readonly issue: CompletionPolicyLoadIssue } {
  let body: CompletionPolicyBody | undefined;
  try {
    body = readCompletionPolicyBody(entry.body);
  } catch (error) {
    return {
      issue: {
        kind: "malformed-policy",
        ref,
        message: "could not be read: " + errorText(error),
      },
    };
  }
  if (body === undefined) {
    return {
      issue: {
        kind: "malformed-policy",
        ref,
        message:
          "is not a version-" +
          COMPLETION_POLICY_VERSION +
          ' completion policy ({ version, default: "deny" | "ungranted", rules })',
      },
    };
  }
  // The reader admits no key it does not copy, so the digest of the READ body
  // is the digest of the accepted declaration.
  const actual = contractDigest(body);
  if (actual !== ref.digest) {
    return { issue: { kind: "digest-mismatch", ref, actual } };
  }
  return {
    snapshot: Object.freeze({ ref, body }),
  };
}

// ── Identity helpers ────────────────────────────────────────────────────────

/** The flat key of one policy identity; NUL cannot occur in an id. */
function identityKey(id: string, revision: string): string {
  return id + "\u0000" + revision;
}

/** Split one identity key back into its two parts. */
function splitIdentity(
  identity: string,
): { readonly id: string; readonly revision: string } | undefined {
  const separator = identity.indexOf("\u0000");
  if (separator < 0) return undefined;
  return {
    id: identity.slice(0, separator),
    revision: identity.slice(separator + 1),
  };
}

/** The flat key of one mapping; NUL cannot occur in an id. */
function mappingKey(mapping: CompletionPolicyMapping): string {
  return (
    mapping.graphId + "\u0000" + mapping.nodeId + "\u0000" + mapping.outcome
  );
}

// ── Primitives ──────────────────────────────────────────────────────────────

/**
 * Whether a value is a PLAIN, non-array record.
 *
 * Plainness is checked here rather than left to `contractDigest`: a class
 * instance with the right own fields would read as a declaration and then be
 * rejected by the canonical form, so the reader admits only values the digest
 * can represent.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A non-empty string, or `undefined`. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Whether a record's own enumerable keys are EXACTLY the given set.
 *
 * The strictness the declaration's content address depends on: a key the
 * reader does not copy would still be part of the digest, so admitting it
 * would let a declaration name content the resolver never saw.
 */
function hasExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(record);
  if (own.length !== keys.length) return false;
  return keys.every((key) => own.includes(key));
}

/** UTF-16 code-unit order: locale-independent, so ids sort the same everywhere. */
function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** The message of a thrown value, for a diagnostic that must not throw itself. */
function errorText(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  try {
    return String(error);
  } catch {
    return "a thrown value that could not be described";
  }
}
