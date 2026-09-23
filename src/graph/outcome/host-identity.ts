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
 * THE SECOND SUBJECT THIS MODULE NAMES: THE WORKER. The D9 binding above binds
 * an attempt to the invocation that ARMED it — the declaring/controlling
 * principal. That is attribution, never the worker's identity: a dispatched
 * worker runs in a session the platform creates for it, and its own tool calls
 * are attributed to that session. The worker-binding section below adds what the
 * host CONFIRMED it dispatched an attempt AS (the platform's real
 * execution/task id and the child session) and the rule a submission from the
 * worker is judged by. The two capabilities are separate SHAPES, read by name:
 * a host declares one or the other, and the shipped hosts declare the worker
 * binding because that is the subject their delivery handoff actually produces.
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

// ── The worker principal and the dispatch binding ───────────────────────────

/**
 * THE SECOND IDENTITY QUESTION, AND WHY IT IS NOT THE FIRST ONE.
 *
 * The D9 binding above answers "which invocation armed this attempt": the host's
 * attribution at DISPATCH time, which is the declaring/controlling principal.
 * That is attribution, not the worker's identity: a dispatched worker runs in a
 * session the platform creates for it, and its own tool calls are attributed to
 * THAT session, never to the declaring one. Comparing the two is comparing two
 * different subjects, and a host that did so would refuse exactly the
 * submission its own delivery handoff asks the worker to make.
 *
 * This section is the worker side: what the host CONFIRMED it dispatched one
 * attempt AS — the platform's real execution/task id and the CHILD SESSION the
 * platform created for the worker — and the rule a submission is judged by. The
 * binding is established when the platform names the execution (never at
 * declaration and never by a caller), it belongs to the attempt, and it is the
 * reference the submitting invocation is checked against.
 *
 * THREE PRINCIPALS, THREE FACTS:
 * - the DECLARING controller — the graph's recorded invocation
 *   (`host/invocation-origins.ts`), used to attribute and notify, never as the
 *   worker's identity;
 * - the WORKER — the child session this binding names, checked against the
 *   session the host attributes to the submission;
 * - the HOST COMPLETION AUTHORITY — the host's confirmed execution fact, which
 *   reaches the same acceptance core as its own source rather than impersonating
 *   the declaring invocation.
 *
 * WHAT THE BINDING IS AND IS NOT. It is the platform's own session id — a fact
 * the platform minted and the host read back, never a string a caller supplied.
 * It is NOT a bearer value: it is not secret and proves nothing by possession;
 * the attempt credential remains the capability, and this check is an ADDITIONAL
 * constraint on the load-bearing one. A host that cannot name the session it
 * created for an attempt records nothing, and then nothing may settle that
 * attempt through this path ({@link HOST_WORKER_UNBOUND_CODE}) — an
 * unsubstantiated binding is refused, never downgraded to "no constraint".
 *
 * SESSION, NOT AGENT. The binding names the session, because that is the
 * platform's own scoping unit for an invocation and the one fact both shipped
 * hosts can substantiate. The agent inside the session is not part of the
 * binding: neither shipped host can say which agent id the platform attributes
 * to a dispatched worker's own tool call (dsh resolves the acting agent through
 * a role map, Pi through a process-wide active agent), so an agent comparison
 * would be a check the host only appears to make. The plan's rule is the
 * reverse of that: a check a host cannot substantiate is not declared.
 */

/**
 * The capability-format version this build reads for the worker binding. An
 * exact identity, like every other capability version here.
 */
export const HOST_WORKER_IDENTITY_VERSION = 1;

/**
 * The host declares the worker binding but this build cannot read the
 * declaration, or the host failed while answering it (a throwing
 * `currentSession()`/`bindingFor()`, a value that is not the declared shape).
 */
export const HOST_WORKER_UNAVAILABLE_CODE = "host-worker-unavailable" as const;

/**
 * The attempt has no confirmed dispatch binding: the host never recorded a real
 * execution/child session for it — not confirmed yet, not this host's, or the
 * platform never named one. Nothing may settle it through this path.
 */
export const HOST_WORKER_UNBOUND_CODE = "host-worker-unbound" as const;

/**
 * The host attributes NO session to this call, so the invocation it arrives from
 * cannot be compared with the binding at all. Distinct from a mismatch: the
 * repair is to submit from the worker's own invocation.
 */
export const HOST_WORKER_ABSENT_CODE = "host-worker-absent" as const;

/**
 * The session this call arrives from is not the child session the platform
 * created for the attempt — an unrelated invocation, a superseded one, or a
 * copied credential presented from somewhere else.
 */
export const HOST_WORKER_SESSION_MISMATCH_CODE = "host-worker-session-mismatch" as const;

/** The refusal vocabulary the worker binding contributes. */
export type HostWorkerIdentityRefusalCode =
  | typeof HOST_WORKER_UNAVAILABLE_CODE
  | typeof HOST_WORKER_UNBOUND_CODE
  | typeof HOST_WORKER_ABSENT_CODE
  | typeof HOST_WORKER_SESSION_MISMATCH_CODE;

/** One structured reason a worker binding could not be established or matched. */
export interface HostWorkerIdentityRefusal {
  readonly code: HostWorkerIdentityRefusalCode;
  /** Where the disagreement lives, in the runtime's own path vocabulary. */
  readonly path: string;
  readonly message: string;
}

/**
 * One attempt, as the persisted state addresses it. The graph and node ids come
 * from the compiled plan and the state; the attempt id is the one the presented
 * credential resolved to — never a caller-supplied selector.
 */
export interface HostWorkerAttemptRef {
  readonly graphId: string;
  readonly nodeId: string;
  readonly attemptId: string;
}

/**
 * What the host confirmed it dispatched one attempt AS. CLOSED SHAPE — exactly
 * the keys below; the three platform facts and the three identity facts.
 *
 * `executionId` is the real host execution/task id the platform returned, and
 * `workerSessionId` is the child session the platform created for the worker.
 * Both are host facts; `graphId`/`nodeId`/`attemptId` are the runtime's own
 * plan/run/attempt identity. `taskId` is present only when the platform names
 * the task apart from the execution.
 */
export interface HostWorkerBinding {
  /** The graph the attempt belongs to (the compiled plan's own id). */
  readonly graphId: string;
  /** The plan node the attempt executes. */
  readonly nodeId: string;
  /** The runtime-minted attempt this binding belongs to. */
  readonly attemptId: string;
  /** The platform's own id for the started execution. */
  readonly executionId: string;
  /** The platform's task id, when it names that apart from the execution. */
  readonly taskId?: string;
  /** The child session the platform created for the worker. */
  readonly workerSessionId: string;
}

/**
 * Read one binding value, or `undefined` when it is not one.
 *
 * STRICT and total: a plain record whose keys are exactly the required set plus
 * whichever optional keys are present, each a non-empty string. The returned
 * binding is frozen and structurally identical to the accepted input.
 */
export function readHostWorkerBinding(raw: unknown): HostWorkerBinding | undefined {
  if (!isRecord(raw)) return undefined;
  if (
    !hasKeysWithin(raw, ["graphId", "nodeId", "attemptId", "executionId", "workerSessionId"], [
      "taskId",
    ])
  ) {
    return undefined;
  }
  const graphId = nonEmptyString(raw.graphId);
  const nodeId = nonEmptyString(raw.nodeId);
  const attemptId = nonEmptyString(raw.attemptId);
  const executionId = nonEmptyString(raw.executionId);
  const workerSessionId = nonEmptyString(raw.workerSessionId);
  if (
    graphId === undefined ||
    nodeId === undefined ||
    attemptId === undefined ||
    executionId === undefined ||
    workerSessionId === undefined
  ) {
    return undefined;
  }
  const taskId = raw.taskId === undefined ? undefined : nonEmptyString(raw.taskId);
  if (raw.taskId !== undefined && taskId === undefined) return undefined;
  return Object.freeze({
    graphId,
    nodeId,
    attemptId,
    executionId,
    workerSessionId,
    ...(taskId === undefined ? {} : { taskId }),
  });
}

/**
 * A diagnostic token naming one binding: the attempt, the host execution and the
 * worker session. Only ever built from a binding this build READ, so it names
 * platform facts the host itself declared. Carries no credential.
 */
export function describeHostWorkerBinding(binding: HostWorkerBinding): string {
  return (
    "{ attemptId: " +
    JSON.stringify(binding.attemptId) +
    ", executionId: " +
    JSON.stringify(binding.executionId) +
    ", workerSessionId: " +
    JSON.stringify(binding.workerSessionId) +
    " }"
  );
}

/**
 * The host's WORKER-identity capability: the version-1 invocation identity plus
 * the two facts a worker submission is judged by.
 *
 * It is a SUPERSET of {@link HostIdentityCapability} on purpose — the toolset
 * carries exactly one identity option, and the mode is decided by which SHAPE
 * the host declared, read by name, never by a flag or a boolean.
 *
 * `currentSession()` answers the session the host attributes to the operation
 * being performed NOW (the session a submission arrives from), or `undefined`
 * when this call carries none — a fact, not an error. `bindingFor()` answers
 * what the host confirmed it dispatched one attempt AS, or `undefined` when it
 * has no such fact.
 *
 * WHEN THE INGRESS READS IT, AND WHY THAT IS THE WHOLE FIX. The submission
 * ingress calls `currentSession()` ONCE, SYNCHRONOUSLY, in the call's own
 * prologue — before the first `await` — and never after one. The holder this
 * answer comes from is moved per tool call, so a read that happened after an
 * await would report whichever concurrent call wrote the holder last, which is
 * exactly the ambient-identity defect §3.2 forbids. The ingress compares that
 * captured answer with the session the call context itself carries (the tool
 * facade threads it from the platform's own invocation context, never from a
 * tool argument); the two are the same host fact for one call, and a
 * disagreement is refused by {@link hostWorkerCallSessionRefusal} rather than
 * resolved by preferring either.
 */
export interface HostWorkerIdentityCapability extends HostIdentityCapability {
  /**
   * The session the host attributes to the operation being performed, or
   * `undefined` when this call carries none. Never a secret.
   */
  currentSession(): string | undefined;
  /**
   * The confirmed dispatch binding of one attempt, or `undefined` when the host
   * has no confirmed execution/child session for it.
   */
  bindingFor(attempt: HostWorkerAttemptRef): HostWorkerBinding | undefined;
}

/**
 * Read one worker-identity capability, or `undefined` when it is not one.
 *
 * STRICT and total: a plain record whose own keys are EXACTLY
 * `{ version, id, current, currentSession, bindingFor }`, `version` exactly
 * {@link HOST_WORKER_IDENTITY_VERSION}, a non-empty `id`, and all three of
 * `current`, `currentSession` and `bindingFor` functions. A record with a
 * missing or extra key is NOT this capability — a partial declaration is refused
 * by name rather than trusted for the parts it happens to carry.
 */
export function readHostWorkerIdentityCapability(
  raw: unknown,
): HostWorkerIdentityCapability | undefined {
  if (!isRecord(raw)) return undefined;
  if (
    !hasExactKeys(raw, ["version", "id", "current", "currentSession", "bindingFor"])
  ) {
    return undefined;
  }
  if (raw.version !== HOST_WORKER_IDENTITY_VERSION) return undefined;
  const id = nonEmptyString(raw.id);
  if (id === undefined) return undefined;
  if (typeof raw.current !== "function") return undefined;
  if (typeof raw.currentSession !== "function") return undefined;
  if (typeof raw.bindingFor !== "function") return undefined;
  return Object.freeze({
    version: HOST_WORKER_IDENTITY_VERSION,
    id,
    current: raw.current as () => HostInvocationIdentity | undefined,
    currentSession: raw.currentSession as () => string | undefined,
    bindingFor: raw.bindingFor as (
      attempt: HostWorkerAttemptRef,
    ) => HostWorkerBinding | undefined,
  });
}

/** Whether a value is a readable worker-identity capability. */
export function isHostWorkerIdentityCapability(
  value: unknown,
): value is HostWorkerIdentityCapability {
  return readHostWorkerIdentityCapability(value) !== undefined;
}

/**
 * The gate for a host identity declaration: `undefined` when NO capability was
 * injected (neither binding is enabled), when the injected value is a readable
 * worker declaration, or when it is a readable STRICT identity capability (the
 * other valid declaration); a structured refusal when a declaration was
 * injected that this build cannot read as EITHER shape.
 *
 * The code is {@link HOST_IDENTITY_UNAVAILABLE_CODE}, not the worker-specific
 * one: this refusal is about the DECLARATION's shape, which is the same fact
 * for both shapes, and a host that declared a constraint it cannot be judged
 * by is refused by that name before anything is read or written. The
 * worker-specific `host-worker-unavailable` is for a READABLE worker
 * capability that then fails to answer.
 */
export function hostWorkerIdentityRefusal(
  capability: unknown,
): HostIdentityRefusal | undefined {
  if (capability === undefined) return undefined;
  if (readHostWorkerIdentityCapability(capability) !== undefined) return undefined;
  if (readHostIdentityCapability(capability) !== undefined) return undefined;
  return Object.freeze({
    code: HOST_IDENTITY_UNAVAILABLE_CODE,
    path: "$.hostIdentity" as const,
    message:
      "outcome-runtime: the injected host identity capability is neither a readable " +
      "version-" +
      HOST_IDENTITY_VERSION +
      " identity nor a readable version-" +
      HOST_WORKER_IDENTITY_VERSION +
      " worker binding — a worker declaration must be exactly { version: " +
      HOST_WORKER_IDENTITY_VERSION +
      ", id, current, currentSession, bindingFor }, and a partial declaration is " +
      "never downgraded to an unconstrained one",
  });
}

/**
 * What asking the host for the session of the current call produced.
 *
 * - `identified` — the host named the session this call arrives from.
 * - `none` — the host attributes no session to this call. An attempt that has a
 *   binding cannot be checked against it.
 * - `refused` — the capability is unreadable, its `currentSession()` threw, or
 *   it answered something that is not a non-empty session id. A host failure is
 *   reported, never converted into "no session".
 */
export type HostWorkerSessionReading =
  | { readonly kind: "identified"; readonly sessionId: string }
  | { readonly kind: "none" }
  | { readonly kind: "refused"; readonly refusal: HostWorkerIdentityRefusal };

/**
 * Ask the host which session the operation being performed arrives from.
 *
 * TOTAL: an unreadable capability, a throwing `currentSession()` and a
 * malformed answer all come back as `refused` with the reason.
 *
 * THE CALLER MUST ASK SYNCHRONOUSLY, IN THE CALL'S OWN PROLOGUE. This function
 * is not async and does not await, but its ANSWER is only the current call's
 * while the host's per-call attribution is still in effect. A caller that
 * stores the returned reading and consults it later is safe; a caller that
 * calls this after an `await` has left the call's own window and may read
 * another concurrent call's attribution. The submission ingress captures it
 * before its first await for exactly that reason.
 */
export function readCurrentWorkerSession(capability: unknown): HostWorkerSessionReading {
  const read = readHostWorkerIdentityCapability(capability);
  if (read === undefined) {
    return Object.freeze({
      kind: "refused" as const,
      refusal: Object.freeze({
        code: HOST_WORKER_UNAVAILABLE_CODE,
        path: "$.hostIdentity" as const,
        message:
          "outcome-runtime: the host worker-identity capability could not be read, so the " +
          "session this call arrives from cannot be established — nothing was written",
      }),
    });
  }
  let answered: unknown;
  try {
    answered = read.currentSession();
  } catch (error) {
    return Object.freeze({
      kind: "refused" as const,
      refusal: Object.freeze({
        code: HOST_WORKER_UNAVAILABLE_CODE,
        path: "$.hostIdentity" as const,
        message:
          "outcome-runtime: the host worker-identity capability " +
          JSON.stringify(read.id) +
          " threw while answering the current call's session (" +
          errorText(error) +
          ") — an unanswered session is never treated as no session, so the operation " +
          "is refused",
      }),
    });
  }
  if (answered === undefined) return Object.freeze({ kind: "none" as const });
  const sessionId = nonEmptyString(answered);
  if (sessionId === undefined) {
    return Object.freeze({
      kind: "refused" as const,
      refusal: Object.freeze({
        code: HOST_WORKER_UNAVAILABLE_CODE,
        path: "$.hostIdentity" as const,
        message:
          "outcome-runtime: the host worker-identity capability " +
          JSON.stringify(read.id) +
          " answered " +
          describeValue(answered) +
          ", not a non-empty session id — a value this build cannot read is refused " +
          "rather than treated as no session",
      }),
    });
  }
  return Object.freeze({ kind: "identified" as const, sessionId });
}

/**
 * What asking the host for one attempt's confirmed dispatch binding produced.
 *
 * - `binding` — the host confirmed a real execution and child session.
 * - `unbound` — the host has no confirmed binding for this attempt.
 * - `refused` — the capability is unreadable, its `bindingFor()` threw, or it
 *   answered a value that is not a binding.
 */
export type HostWorkerBindingReading =
  | { readonly kind: "binding"; readonly binding: HostWorkerBinding }
  | { readonly kind: "unbound"; readonly attempt: HostWorkerAttemptRef }
  | { readonly kind: "refused"; readonly refusal: HostWorkerIdentityRefusal };

/**
 * Ask the host what it dispatched one attempt AS.
 *
 * TOTAL: an unreadable capability, a throwing `bindingFor()` and a malformed
 * answer all come back as `refused` with the reason, so "the host cannot say"
 * is never confused with "the host says nothing constrains this attempt".
 */
export function readHostWorkerBindingFor(
  capability: unknown,
  attempt: HostWorkerAttemptRef,
): HostWorkerBindingReading {
  const read = readHostWorkerIdentityCapability(capability);
  if (read === undefined) {
    return Object.freeze({
      kind: "refused" as const,
      refusal: Object.freeze({
        code: HOST_WORKER_UNAVAILABLE_CODE,
        path: "$.workerBinding" as const,
        message:
          "outcome-runtime: this process holds no readable host worker-identity " +
          "capability, so what attempt " +
          JSON.stringify(attempt.attemptId) +
          " was dispatched as cannot be established — nothing was written",
      }),
    });
  }
  let answered: unknown;
  try {
    answered = read.bindingFor(attempt);
  } catch (error) {
    return Object.freeze({
      kind: "refused" as const,
      refusal: Object.freeze({
        code: HOST_WORKER_UNAVAILABLE_CODE,
        path: "$.workerBinding" as const,
        message:
          "outcome-runtime: the host worker-identity capability " +
          JSON.stringify(read.id) +
          " threw while answering the binding of attempt " +
          JSON.stringify(attempt.attemptId) +
          " (" +
          errorText(error) +
          ") — an unanswered binding is never treated as no constraint",
      }),
    });
  }
  if (answered === undefined) {
    return Object.freeze({ kind: "unbound" as const, attempt });
  }
  const binding = readHostWorkerBinding(answered);
  if (binding === undefined) {
    return Object.freeze({
      kind: "refused" as const,
      refusal: Object.freeze({
        code: HOST_WORKER_UNAVAILABLE_CODE,
        path: "$.workerBinding" as const,
        message:
          "outcome-runtime: the host worker-identity capability " +
          JSON.stringify(read.id) +
          " answered " +
          describeValue(answered) +
          " for attempt " +
          JSON.stringify(attempt.attemptId) +
          ", not a { graphId, nodeId, attemptId, executionId, workerSessionId } binding — " +
          "a value this build cannot read is refused rather than trusted in part",
      }),
    });
  }
  if (
    binding.graphId !== attempt.graphId ||
    binding.nodeId !== attempt.nodeId ||
    binding.attemptId !== attempt.attemptId
  ) {
    return Object.freeze({
      kind: "refused" as const,
      refusal: Object.freeze({
        code: HOST_WORKER_UNAVAILABLE_CODE,
        path: "$.workerBinding" as const,
        message:
          "outcome-runtime: the host answered a binding for " +
          describeHostWorkerBinding(binding) +
          " when asked about graph " +
          JSON.stringify(attempt.graphId) +
          " node " +
          JSON.stringify(attempt.nodeId) +
          " attempt " +
          JSON.stringify(attempt.attemptId) +
          " — a binding is bound to exactly one attempt and is never re-aimed",
      }),
    });
  }
  return Object.freeze({ kind: "binding" as const, binding });
}

/**
 * The worker rule of one submission: `undefined` when the submission may
 * proceed to the acceptance core, a structured refusal otherwise.
 *
 * THE ORDER IS THE RULE:
 *
 * 1. a binding the host could not answer or that it answered malformed is a
 *    host failure, and a host failure is never a pass;
 * 2. `unbound` — the attempt has NO confirmed execution/child session. Nothing
 *    may settle an attempt whose worker the host cannot name: the compatibility
 *    rule of the D9 binding (an attempt that recorded nothing is unconstrained)
 *    does NOT apply here, because this binding is established by the host's own
 *    create, and "not confirmed" is a fact about the dispatch, not a licence to
 *    accept any session;
 * 3. a call the host attributes NO session to cannot be compared, and is refused
 *    rather than settled on the credential alone;
 * 4. only the exact child session the platform created passes.
 *
 * TOTAL and pure: it reads the two readings it is given and never calls the host.
 */
export function hostWorkerBindingRefusal(
  binding: HostWorkerBindingReading,
  session: HostWorkerSessionReading,
): HostWorkerIdentityRefusal | undefined {
  if (binding.kind === "refused") return binding.refusal;
  if (session.kind === "refused") return session.refusal;
  if (binding.kind === "unbound") {
    return Object.freeze({
      code: HOST_WORKER_UNBOUND_CODE,
      path: "$.workerBinding" as const,
      message:
        "outcome-runtime: this host holds no confirmed execution and child session for " +
        "attempt " +
        JSON.stringify(binding.attempt.attemptId) +
        " (graph " +
        JSON.stringify(binding.attempt.graphId) +
        ", node " +
        JSON.stringify(binding.attempt.nodeId) +
        "), so the invocation this submission arrives from cannot be checked against " +
        "it — a worker submission is settled only by the attempt's own worker, and " +
        "nothing was written",
    });
  }
  if (session.kind === "none") {
    return Object.freeze({
      code: HOST_WORKER_ABSENT_CODE,
      path: "$.workerSession" as const,
      message:
        "outcome-runtime: attempt " +
        JSON.stringify(binding.binding.attemptId) +
        " is bound to the worker session " +
        JSON.stringify(binding.binding.workerSessionId) +
        ", but the host attributes NO session to this submission, so the binding cannot " +
        "be checked — nothing was written",
    });
  }
  if (session.sessionId === binding.binding.workerSessionId) return undefined;
  return Object.freeze({
    code: HOST_WORKER_SESSION_MISMATCH_CODE,
    path: "$.workerSession" as const,
    message:
      "outcome-runtime: attempt " +
      JSON.stringify(binding.binding.attemptId) +
      " was dispatched as the worker session " +
      JSON.stringify(binding.binding.workerSessionId) +
      " (host execution " +
      JSON.stringify(binding.binding.executionId) +
      "), but this submission arrives from session " +
      JSON.stringify(session.sessionId) +
      " — a submission settles an attempt only from the invocation the platform " +
      "created for that attempt's worker, so nothing was written",
  });
}

/**
 * The host gave TWO different answers about which call one submission arrives
 * from, so neither answer can authenticate it.
 *
 * THE TWO ANSWERS ARE ONE FACT AND MUST AGREE. They are the session the call
 * context carries (threaded by the tool facade from the platform's own
 * invocation context) and the session the declared capability reports for this
 * operation. Both are the host's own attribution of the SAME call, so a
 * disagreement means the host cannot say which invocation is running: one of
 * the two is stale, misconfigured or forged. Resolving that by preferring one
 * of them would silently pick an authentication factor instead of requiring
 * the host to substantiate it, so the submission is refused by name
 * ({@link HOST_WORKER_UNAVAILABLE_CODE}) and nothing is written.
 *
 * TOTAL and pure: it reads the two values it is given and never calls the host.
 * `undefined` is the capability reporting that it attributes NO session to
 * this operation, which disagrees with a non-empty call context just as
 * plainly as a different id does.
 */
export function hostWorkerCallSessionRefusal(
  callSessionId: string,
  declaredSessionId: string | undefined,
): HostWorkerIdentityRefusal {
  return Object.freeze({
    code: HOST_WORKER_UNAVAILABLE_CODE,
    path: "$.workerSession" as const,
    message:
      "outcome-runtime: the call context names session " +
      JSON.stringify(callSessionId) +
      " for this submission, while the host worker-identity capability answers " +
      (declaredSessionId === undefined
        ? "NO session for this operation"
        : "session " + JSON.stringify(declaredSessionId)) +
      " — the two answers are the host's attribution of the SAME call and must " +
      "agree, so which invocation this submission arrives from cannot be " +
      "established and nothing was written",
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

/**
 * Whether a record's own enumerable keys are EXACTLY the required set plus a
 * subset of the optional one — no missing required key and no unknown key.
 */
function hasKeysWithin(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const own = Object.keys(record);
  for (const key of required) {
    if (!own.includes(key)) return false;
  }
  const allowed = new Set([...required, ...optional]);
  return own.every((key) => allowed.has(key));
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
