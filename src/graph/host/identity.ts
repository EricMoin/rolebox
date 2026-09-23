/**
 * Graph Execution Engine v2 — the host's invocation-identity capability
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * THE HOST IMPLEMENTATION OF THE IDENTITY CONTRACT (D9). The runtime records
 * the host's invocation identity on every attempt it dispatches and requires
 * the same identity on the submission that settles it — an ADDITIONAL
 * constraint on top of the bearer credential, never a replacement. This module
 * is what a real host injects as that capability: a mutable "which invocation
 * is running now" holder plus the strict `{ version, id, current }` value the
 * runtime reads.
 *
 * WHAT THE HOST MUST PUT IN IT, AND WHAT THIS MODULE CANNOT CHECK. The value
 * has to be the invoking SESSION and AGENT the platform attributes to the
 * operation being performed — the same attribution for the dispatch that arms
 * an attempt and for the submission that settles it. Nothing here can verify
 * that: a host that answers one constant identity, or that copies an identity
 * out of caller-controlled input, defeats the constraint entirely, and the
 * runtime's documentation says so. The holder exists so a host with a correct
 * attribution has exactly one obvious place to put it.
 *
 * MISSING IS NOT MALFORMED. With no capability injected the identity binding
 * is simply not enabled — the core protocol depends on no host. With a
 * capability that is present but UNREADABLE the runtime refuses the operation
 * by name rather than dropping the constraint. A holder that has no invocation
 * in effect answers `undefined`, which the runtime treats as "this invocation
 * carries no identity": an attempt that recorded one is then refused
 * (`host-identity-absent`) instead of being settled without the check.
 *
 * THE WORKER SIDE, IN THE SAME MODULE. The invocation identity is the DECLARING
 * principal's attribution. A dispatched worker submits from its OWN session, so
 * the host also needs a holder for the session of the operation being performed
 * and a capability that answers what it confirmed it dispatched an attempt AS
 * ({@link hostWorkerIdentityCapability}). That capability is a SUPERSET of the
 * D9 one — the toolset carries one identity option and the shape decides which
 * check applies — and its binding comes from the host's confirmed execution
 * record, never from a caller-supplied string.
 */

import type {
  HostIdentityCapability,
  HostInvocationIdentity,
  HostWorkerAttemptRef,
  HostWorkerBinding,
  HostWorkerIdentityCapability,
} from "../outcome/host-identity.ts";
import {
  HOST_IDENTITY_VERSION,
  HOST_WORKER_IDENTITY_VERSION,
  readHostInvocationIdentity,
} from "../outcome/host-identity.ts";

/** The host's own view of "which invocation is running now". */
export interface HostInvocationSource {
  /** The identity in effect, or `undefined` when this invocation has none. */
  current(): HostInvocationIdentity | undefined;
}

/**
 * Build one invocation identity from the invoking session and agent.
 *
 * Both components are required together: "the same session" and "the same
 * agent" are ONE attribution, and a host that knows only one of them has no
 * comparable identity. Returns `undefined` rather than half an identity, which
 * the holder then reports as "no identity in effect".
 */
export function hostInvocationIdentity(
  sessionId: unknown,
  agentId: unknown,
): HostInvocationIdentity | undefined {
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
  if (typeof agentId !== "string" || agentId.length === 0) return undefined;
  return readHostInvocationIdentity({ sessionId, agentId });
}

/**
 * The host's readable identity capability: version 1, a stable id, and
 * `current()` delegated to the host's own source — the value the runtime
 * injects as `hostIdentity`.
 */
export function hostIdentityCapability(
  id: string,
  source: HostInvocationSource,
): HostIdentityCapability {
  if (id.length === 0) {
    throw new Error("host-identity: the capability id must be a non-empty string");
  }
  if (typeof source.current !== "function") {
    throw new Error("host-identity: the invocation source must expose current()");
  }
  return Object.freeze({
    version: HOST_IDENTITY_VERSION,
    id,
    current: (): HostInvocationIdentity | undefined => source.current(),
  });
}

/**
 * A holder a host moves as it enters and leaves invocations.
 *
 * The capability answers whatever the holder currently carries, so a host
 * whose operations are sequential sets it once per tool call:
 *
 *   const invocations = createHostInvocationHolder();
 *   invocations.set(hostInvocationIdentity(sessionId, agentId));
 *   // ... dispatch / submit for that invocation ...
 *   invocations.clear();
 */
export interface HostInvocationHolder extends HostInvocationSource {
  /** The value to inject as the runtime's `hostIdentity`. */
  readonly capability: HostIdentityCapability;
  /** Put one invocation in effect (a malformed value clears it). */
  set(identity: HostInvocationIdentity | undefined): void;
  /** Report that this invocation has no identity (an unhosted call). */
  clear(): void;
}

export function createHostInvocationHolder(
  initial?: HostInvocationIdentity,
): HostInvocationHolder {
  let current = initial === undefined ? undefined : readHostInvocationIdentity(initial);
  const capability = hostIdentityCapability("host:invocation-holder", {
    current: () => current,
  });
  return Object.freeze({
    capability,
    set(identity: HostInvocationIdentity | undefined): void {
      current = identity === undefined ? undefined : readHostInvocationIdentity(identity);
    },
    clear(): void {
      current = undefined;
    },
    current(): HostInvocationIdentity | undefined {
      return current;
    },
  });
}

// ── The worker principal ────────────────────────────────────────────────────

/**
 * The SESSION of the operation a host is currently performing — the worker side
 * of the identity model, kept separate from the invocation identity above.
 *
 * WHY SEPARATE. The invocation identity is a PAIR (session and agent) because a
 * host that declares it is declaring that one logical invocation is what
 * dispatches and settles an attempt — the D9 constraint. The worker binding
 * names a SESSION only: the platform's own scoping unit for a dispatched
 * worker, and the one fact both shipped hosts can substantiate. Folding the two
 * together would either force an agent comparison neither host can make, or
 * silently widen the D9 identity to a session-only value.
 *
 * The raw session is deliberately allowed to be the ONLY thing a host knows
 * here: a session with no agent attribution is still a comparable worker scope,
 * while an identity with no agent is, by the D9 contract, no identity at all.
 */
export interface HostWorkerSessionSource {
  /** The session in effect, or `undefined` when this operation has none. */
  currentSession(): string | undefined;
}

/**
 * A holder a host moves as it enters and leaves one operation, for the worker
 * session. It is set from the platform's own tool-call context
 * (`context.sessionID`) by {@link bindOutcomeToolInvocation}, never from a
 * value any caller of a tool may supply.
 */
export interface HostWorkerSessionHolder extends HostWorkerSessionSource {
  /** Put one session in effect (an empty value clears it). */
  set(sessionId: string | undefined): void;
  /** Report that this operation carries no session. */
  clear(): void;
}

export function createHostWorkerSessionHolder(
  initial?: string,
): HostWorkerSessionHolder {
  let current = nonEmptyString(initial);
  return Object.freeze({
    set(sessionId: string | undefined): void {
      current = nonEmptyString(sessionId);
    },
    clear(): void {
      current = undefined;
    },
    currentSession(): string | undefined {
      return current;
    },
  });
}

/** The host's own answers the worker-identity capability is built from. */
export interface HostWorkerIdentitySource {
  /** The invocation identity in effect (the D9 shape), for diagnostics/D9 uses. */
  current(): HostInvocationIdentity | undefined;
  /** The session this operation arrives from, or `undefined` when it has none. */
  currentSession(): string | undefined;
  /** What the host confirmed it dispatched one attempt AS, or `undefined`. */
  bindingFor(attempt: HostWorkerAttemptRef): HostWorkerBinding | undefined;
}

/**
 * The host's worker-identity capability: the invocation identity PLUS the two
 * facts a worker submission is checked against
 * ({@link HostWorkerIdentityCapability}).
 *
 * A capability with a non-empty id and all three functions is built; anything
 * else is a programming error in the host assembly and throws here rather than
 * being injected as a declaration the run path would refuse operation by
 * operation.
 */
export function hostWorkerIdentityCapability(
  id: string,
  source: HostWorkerIdentitySource,
): HostWorkerIdentityCapability {
  if (id.length === 0) {
    throw new Error("host-identity: the capability id must be a non-empty string");
  }
  if (typeof source.current !== "function") {
    throw new Error("host-identity: the invocation source must expose current()");
  }
  if (typeof source.currentSession !== "function") {
    throw new Error("host-identity: the worker source must expose currentSession()");
  }
  if (typeof source.bindingFor !== "function") {
    throw new Error("host-identity: the worker source must expose bindingFor()");
  }
  return Object.freeze({
    version: HOST_WORKER_IDENTITY_VERSION,
    id,
    current: (): HostInvocationIdentity | undefined => source.current(),
    currentSession: (): string | undefined => source.currentSession(),
    bindingFor: (attempt: HostWorkerAttemptRef): HostWorkerBinding | undefined =>
      source.bindingFor(attempt),
  });
}

/** A non-empty string, or `undefined`. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
