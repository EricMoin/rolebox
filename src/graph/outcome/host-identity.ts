/**
 * Graph Execution Engine v2 — Host invocation identity (stage D, slice 4)
 *
 * Version: 1.0
 * Date: 2026-09-24
 *
 * THE FOURTH HOST CAPABILITY OF THE OUTCOME RUN PATH
 * (docs/graph-outcome-protocol.md § "D9"). The host adapter surface already
 * carries three declarations this build cannot verify on its own: a protected
 * credential store and per-attempt credential delivery
 * (`credential-isolation.ts`, D7) and the create-plus-lookup dispatch channel
 * (`dispatch-effects.ts`, D8). This module adds the fourth: the host's
 * INVOCATION IDENTITY — the session and agent the host attributes to the
 * operation it is currently running.
 *
 * WHAT THE IDENTITY ADDS, AND WHAT IT DOES NOT. An attempt credential is a
 * bearer nonce: possession proves the holder was handed (or copied) this
 * attempt's credential, never that the original worker is asking. When a host
 * declares this capability, the runtime records the host's identity on the
 * attempt at dispatch and requires the SAME identity on the submission that
 * settles it, so a process that copied a credential out of the ledger and
 * submits it from its own host invocation is refused. That is an ADDITIONAL
 * constraint, never a replacement: the credential check still runs first, and
 * the core protocol depends on no host and works without one.
 *
 * WHAT THIS BUILD CANNOT DO, STATED FIRST. It can compare the identity the
 * host DECLARES at dispatch with the identity the host DECLARES at submission.
 * It cannot verify either declaration, cannot force a host to attribute a
 * worker's invocation correctly, and cannot isolate anything at the filesystem
 * level: a host that answers the same identity for every call, or that reports
 * an identity a thief can influence, is lying to or misconfigured for the
 * protocol and is undetectable here. The capability is therefore an assertion
 * by the host, exactly like the credential-isolation adapter, and the honest
 * boundary is the host's.
 *
 * MISSING IS NOT MALFORMED, AND NEITHER IS SILENT:
 * - NO capability injected — the identity binding is NOT enabled. Nothing is
 *   recorded on an attempt, nothing is checked, and every existing path behaves
 *   exactly as it did before this slice could exist: the core protocol does not
 *   depend on any host.
 * - a capability this build CANNOT READ (a wrong version, a missing or extra
 *   key, an empty id, a non-function `current`) — the run path REFUSES the
 *   operation with {@link HOST_IDENTITY_UNAVAILABLE_CODE} before it reads or
 *   writes anything. A declared-but-unreadable capability is never downgraded
 *   to "no constraint": silently dropping a constraint the host asked for is
 *   the failure mode this rule exists to prevent.
 * - an ATTEMPT that recorded an identity, judged by a process that holds no
 *   readable capability, or whose invocation carries none — the submission is
 *   REFUSED ({@link HOST_IDENTITY_UNAVAILABLE_CODE} /
 *   {@link HOST_IDENTITY_ABSENT_CODE}) rather than settled without the check.
 *   The one exception is deliberate and is the compatibility rule: an attempt
 *   that recorded NO identity was dispatched under no host identity, and a
 *   later process never fabricates one for it — the reference is the dispatch
 *   record, never the current invocation.
 *
 * Dependency leaf: no imports at all, so the state reader,
 * `graph-state.ts`, the run path, the recovery seam and a host loader may all
 * depend on it without a cycle.
 */

// ── Identity and refusal codes ──────────────────────────────────────────────

/**
 * The capability-format version this build reads. An exact identity, like every
 * other capability identity in the protocol: an unknown version is refused,
 * never read approximately.
 */
export const HOST_IDENTITY_VERSION = 1;

/**
 * The host declares an identity but this build cannot read the declaration, or
 * a process judging an attempt that RECORDED one holds no readable capability.
 * Stable identifier; wording is not API.
 */
export const HOST_IDENTITY_UNAVAILABLE_CODE = "host-identity-unavailable" as const;

/**
 * The invocation identity the host reports for this submission disagrees with
 * the identity recorded when the attempt was dispatched.
 */
export const HOST_IDENTITY_MISMATCH_CODE = "host-identity-mismatch" as const;

/**
 * The attempt recorded a dispatch identity and the host reports NONE for this
 * invocation, so the binding cannot be checked at all. Distinct from a mismatch
 * because the repair differs (restore the host's attribution vs. submit from
 * the invocation the attempt was dispatched under).
 */
export const HOST_IDENTITY_ABSENT_CODE = "host-identity-absent" as const;

/** The refusal vocabulary this capability contributes. */
export type HostIdentityRefusalCode =
  | typeof HOST_IDENTITY_UNAVAILABLE_CODE
  | typeof HOST_IDENTITY_MISMATCH_CODE
  | typeof HOST_IDENTITY_ABSENT_CODE;

/** One structured reason a host identity could not be established or matched. */
export interface HostIdentityRefusal {
  readonly code: HostIdentityRefusalCode;
  /** Where the disagreement lives, in the runtime's own path vocabulary. */
  readonly path: string;
  readonly message: string;
}

// ── The identity ────────────────────────────────────────────────────────────

/**
 * The host invocation identity: the invoking session and the invoking agent, as
 * the host attributes them. CLOSED SHAPE — exactly `{ sessionId, agentId }`,
 * each a non-empty string, read by {@link readHostInvocationIdentity}. A value
 * with an extra key or an empty component is not an identity and is refused
 * rather than partially trusted.
 *
 * Both components are required together on purpose: "the same session" and "the
 * same agent" are one attribution, and a host that knows only one of them does
 * not have a comparable identity — it has no identity, and says so by answering
 * `undefined` from {@link HostIdentityCapability.current}.
 */
export interface HostInvocationIdentity {
  /** The invoking session, as the host names it. Never a secret. */
  readonly sessionId: string;
  /** The invoking agent, as the host names it. Never a secret. */
  readonly agentId: string;
}

/**
 * Read one identity value, or `undefined` when it is not one.
 *
 * STRICT and total: a plain record whose own keys are exactly the two fields,
 * each a non-empty string. The returned identity is frozen and structurally
 * identical to the accepted input.
 */
export function readHostInvocationIdentity(
  raw: unknown,
): HostInvocationIdentity | undefined {
  if (!isRecord(raw)) return undefined;
  if (!hasExactKeys(raw, ["sessionId", "agentId"])) return undefined;
  const sessionId = nonEmptyString(raw.sessionId);
  const agentId = nonEmptyString(raw.agentId);
  if (sessionId === undefined || agentId === undefined) return undefined;
  return Object.freeze({ sessionId, agentId });
}

/** Whether two identities are the same attribution. Total: `undefined` never matches. */
export function equalHostInvocationIdentity(
  left: HostInvocationIdentity | undefined,
  right: HostInvocationIdentity | undefined,
): boolean {
  if (left === undefined || right === undefined) return false;
  return left.sessionId === right.sessionId && left.agentId === right.agentId;
}

/**
 * A diagnostic token naming one identity: `{ sessionId: "...", agentId: "..." }`.
 *
 * Only ever built from an identity this build READ, so it names values the host
 * itself declared. Carries no credential.
 */
export function describeHostInvocationIdentity(
  identity: HostInvocationIdentity,
): string {
  return (
    "{ sessionId: " +
    JSON.stringify(identity.sessionId) +
    ", agentId: " +
    JSON.stringify(identity.agentId) +
    " }"
  );
}

// ── The capability ──────────────────────────────────────────────────────────

/**
 * The host's invocation-identity capability, injected at construction.
 *
 * CLOSED SHAPE — exactly `{ version, id, current }`, read by
 * {@link readHostIdentityCapability}. `current()` answers the identity the
 * host attributes to the operation being performed NOW: the dispatch about to
 * be created, or the submission being judged. It answers `undefined` when the
 * host has no identity for this invocation (an unhosted call) — which is a
 * fact, not an error.
 *
 * A host that declares this capability is declaring that the same logical
 * invocation is what its created workers submit under; a host whose workers
 * submit under a different attribution will see those submissions refused by
 * name, which is the constraint working, not a build defect.
 */
export interface HostIdentityCapability {
  /** The capability-format version — always 1 for this shape. */
  readonly version: 1;
  /**
   * The host adapter's own stable identity, for diagnostics (for example
   * `"host:invocation-index"`). Never a secret.
   */
  readonly id: string;
  /**
   * The invocation identity in effect for the current operation, or
   * `undefined` when this host invocation carries none.
   */
  current(): HostInvocationIdentity | undefined;
}

/**
 * Read one capability value, or `undefined` when it is not one.
 *
 * STRICT and total: a plain record whose own keys are exactly
 * `{ version, id, current }`, `version` exactly 1, a non-empty `id` and a
 * `current` that is a function. The returned capability is frozen; the
 * function itself is the host's.
 */
export function readHostIdentityCapability(
  raw: unknown,
): HostIdentityCapability | undefined {
  if (!isRecord(raw)) return undefined;
  if (!hasExactKeys(raw, ["version", "id", "current"])) return undefined;
  if (raw.version !== HOST_IDENTITY_VERSION) return undefined;
  const id = nonEmptyString(raw.id);
  if (id === undefined) return undefined;
  if (typeof raw.current !== "function") return undefined;
  const current = raw.current as () => HostInvocationIdentity | undefined;
  return Object.freeze({
    version: HOST_IDENTITY_VERSION,
    id,
    current,
  });
}

/** Whether a value is a readable version-1 host identity capability. */
export function isHostIdentityCapability(
  value: unknown,
): value is HostIdentityCapability {
  return readHostIdentityCapability(value) !== undefined;
}

/** A diagnostic token naming one capability: `"id"`. Carries no identity. */
export function describeHostIdentityCapability(
  capability: HostIdentityCapability,
): string {
  return JSON.stringify(capability.id);
}

// ── The enablement gate ─────────────────────────────────────────────────────

/**
 * The gate every run-path entry consults: `undefined` when the host capability
 * is absent (the identity binding is simply not enabled) or readable, a
 * structured refusal when a value was injected that this build cannot read.
 *
 * TOTAL — never a throw — because every caller reports it as data, exactly like
 * {@link credentialIsolationRefusal}: the runtime returns it, the ingress
 * throws its typed refusal carrying the same message, and the startup sweep
 * records it in its `refused` bucket.
 */
export function hostIdentityRefusal(
  capability: unknown,
): HostIdentityRefusal | undefined {
  if (capability === undefined) return undefined;
  if (readHostIdentityCapability(capability) !== undefined) return undefined;
  return Object.freeze({
    code: HOST_IDENTITY_UNAVAILABLE_CODE,
    path: "$.hostIdentity" as const,
    message:
      "outcome-runtime: the injected host identity capability is not a readable " +
      "version-" +
      HOST_IDENTITY_VERSION +
      " capability — it must be exactly { version: " +
      HOST_IDENTITY_VERSION +
      ", id, current } with a non-empty id and a current() function. A declared " +
      "identity constraint is never downgraded to an unconstrained run, so nothing " +
      "was started, resumed or settled",
  });
}

// ── Reading the current invocation ──────────────────────────────────────────

/**
 * What asking the host for the current invocation identity produced.
 *
 * - `absent` — no capability was injected at all. The identity binding is not
 *   enabled and nothing is checked.
 * - `none` — a readable capability answered `undefined`: this invocation
 *   carries no identity. An attempt that recorded one cannot be verified
 *   against it.
 * - `identified` — the host named the invocation.
 * - `refused` — the capability is unreadable, its `current()` threw, or it
 *   answered something that is not an identity. A host failure is reported, not
 *   converted into "no identity".
 */
export type HostIdentityReading =
  | { readonly kind: "absent" }
  | { readonly kind: "none" }
  | { readonly kind: "identified"; readonly identity: HostInvocationIdentity }
  | { readonly kind: "refused"; readonly refusal: HostIdentityRefusal };

/**
 * Ask the host for the identity of the invocation being performed.
 *
 * TOTAL: an unreadable capability, a throwing `current()` and a malformed
 * answer all come back as `refused` with the reason, so a caller never has to
 * decide whether a throw meant "no identity" (it never does).
 */
export function readCurrentHostIdentity(capability: unknown): HostIdentityReading {
  if (capability === undefined) return Object.freeze({ kind: "absent" as const });
  const read = readHostIdentityCapability(capability);
  if (read === undefined) {
    const refusal = hostIdentityRefusal(capability);
    return Object.freeze({
      kind: "refused" as const,
      refusal:
        refusal ??
        Object.freeze({
          code: HOST_IDENTITY_UNAVAILABLE_CODE,
          path: "$.hostIdentity" as const,
          message:
            "outcome-runtime: the injected host identity capability could not be read",
        }),
    });
  }
  let answered: unknown;
  try {
    answered = read.current();
  } catch (error) {
    return Object.freeze({
      kind: "refused" as const,
      refusal: Object.freeze({
        code: HOST_IDENTITY_UNAVAILABLE_CODE,
        path: "$.hostIdentity" as const,
        message:
          "outcome-runtime: the host identity capability " +
          describeHostIdentityCapability(read) +
          " threw while answering the current invocation identity (" +
          errorText(error) +
          ") — an unanswered identity is never treated as no identity, so the " +
          "operation is refused",
      }),
    });
  }
  if (answered === undefined) return Object.freeze({ kind: "none" as const });
  const identity = readHostInvocationIdentity(answered);
  if (identity === undefined) {
    return Object.freeze({
      kind: "refused" as const,
      refusal: Object.freeze({
        code: HOST_IDENTITY_UNAVAILABLE_CODE,
        path: "$.hostIdentity" as const,
        message:
          "outcome-runtime: the host identity capability " +
          describeHostIdentityCapability(read) +
          " answered " +
          describeValue(answered) +
          ", not a { sessionId, agentId } identity of non-empty strings — a value " +
          "this build cannot read is refused rather than treated as no identity",
      }),
    });
  }
  return Object.freeze({ kind: "identified" as const, identity });
}

// ── The binding check ───────────────────────────────────────────────────────

/**
 * The identity rule of one submission: `undefined` when the submission may
 * settle the attempt, a structured refusal otherwise.
 *
 * THE ORDER IS THE RULE, and it is deliberately asymmetric:
 *
 * 1. `recorded === undefined` — the attempt was dispatched under NO host
 *    identity, so there is nothing to be consistent with and the submission is
 *    NOT constrained. This is the compatibility rule that keeps the core
 *    protocol independent of any host: identity binding is an addition to the
 *    attempts that recorded one, and this build never fabricates a reference
 *    for an attempt that never had one.
 * 2. an attempt that DID record one is never settled without the check:
 *    an unreadable capability (step 1's refusal), no capability at all, a
 *    throwing host, or an invocation the host supplies no identity for all
 *    REFUSE the submission instead of dropping the constraint.
 * 3. only an identical `{ sessionId, agentId }` pair passes.
 *
 * TOTAL and pure: it reads the two values it is given and never calls the host.
 */
export function hostIdentityCheckRefusal(
  recorded: HostInvocationIdentity | undefined,
  reading: HostIdentityReading,
): HostIdentityRefusal | undefined {
  if (recorded === undefined) return undefined;
  if (reading.kind === "refused") return reading.refusal;
  if (reading.kind === "absent") {
    return Object.freeze({
      code: HOST_IDENTITY_UNAVAILABLE_CODE,
      path: "$.dispatchIdentity" as const,
      message:
        "outcome-runtime: the attempt this submission resolves to was dispatched under " +
        "the host identity " +
        describeHostInvocationIdentity(recorded) +
        ", but this process holds no readable host identity capability to check the " +
        "submission against it — an attempt bound to a host identity is never settled " +
        "without the check, and the identity is never dropped to make it settle",
    });
  }
  if (reading.kind === "none") {
    return Object.freeze({
      code: HOST_IDENTITY_ABSENT_CODE,
      path: "$.dispatchIdentity" as const,
      message:
        "outcome-runtime: this attempt was dispatched under the host identity " +
        describeHostInvocationIdentity(recorded) +
        ", but the host reports NO invocation identity for this submission, so the " +
        "binding cannot be checked — nothing was written",
    });
  }
  if (equalHostInvocationIdentity(recorded, reading.identity)) return undefined;
  return Object.freeze({
    code: HOST_IDENTITY_MISMATCH_CODE,
    path: "$.dispatchIdentity" as const,
    message:
      "outcome-runtime: this attempt was dispatched under the host identity " +
      describeHostInvocationIdentity(recorded) +
      ", but the host reports " +
      describeHostInvocationIdentity(reading.identity) +
      " for this submission — a submission must come from the invocation that " +
      "dispatched the attempt, so nothing was written",
  });
}

// ── Primitives ──────────────────────────────────────────────────────────────

/** Whether a value is a PLAIN, non-array record. */
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

/** Whether a record's own enumerable keys are EXACTLY the given set. */
function hasExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(record);
  if (own.length !== keys.length) return false;
  return keys.every((key) => own.includes(key));
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

/** The message of a caught value, without assuming it is an Error. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
