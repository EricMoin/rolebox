/**
 * A HOST IDENTITY STAND-IN for the outcome-protocol tests (D9).
 *
 * The production shape of the capability is a declaration the host injects:
 * `{ version: 1, id, current() }`, where `current()` answers the invocation
 * identity the host attributes to the operation being performed. A test needs to
 * CHANGE that answer between the dispatch and the submission — that is the whole
 * point of the binding — so this helper owns a mutable holder and hands out a
 * frozen capability reading from it, plus a read counter so a test can prove the
 * runtime actually asked the host rather than assuming an answer.
 *
 * Usage:
 *   const host = testHostIdentity({ sessionId: "s1", agentId: "a1" });
 *   const runtime = new OutcomeGraphRuntime({ ..., hostIdentity: host.capability });
 *   host.set({ sessionId: "s2", agentId: "a1" });   // a different invocation
 */

import type {
  HostIdentityCapability,
  HostInvocationIdentity,
} from "../../../src/graph/outcome/host-identity.ts";

/** A capability whose answer a test can move, with the number of reads so far. */
export interface MutableHostIdentity {
  /** The value to inject as `OutcomeGraphRuntimeOptions.hostIdentity`. */
  readonly capability: HostIdentityCapability;
  /** The identity every subsequent `current()` call answers; `undefined` = none. */
  set(identity: HostInvocationIdentity | undefined): void;
  /** How many times the runtime asked this host for the current identity. */
  readonly reads: number;
}

/**
 * Build a version-1 host identity capability over a mutable holder. Deeply
 * frozen, like a value the module's reader returns; the holder is the only
 * moving part.
 */
export function testHostIdentity(
  initial?: HostInvocationIdentity,
): MutableHostIdentity {
  let current = initial;
  let reads = 0;
  const capability: HostIdentityCapability = Object.freeze({
    version: 1 as const,
    id: "test-host:invocation-identity",
    current: (): HostInvocationIdentity | undefined => {
      reads += 1;
      return current;
    },
  });
  return {
    capability,
    set(identity: HostInvocationIdentity | undefined): void {
      current = identity;
    },
    get reads(): number {
      return reads;
    },
  };
}
