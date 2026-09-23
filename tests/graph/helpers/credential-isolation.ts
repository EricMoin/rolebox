/**
 * A HOST ADAPTER STAND-IN for the outcome-protocol tests (D7).
 *
 * The production enablement condition of the outcome run path is a
 * host-injected credential-isolation capability: a protected credential store
 * plus per-attempt delivery. A test process obviously has neither — it is an
 * ordinary same-account process that can read the ledger it writes — so this
 * helper does NOT make a store protected. It builds the DECLARATION a host
 * would inject, so a test can exercise the "a host capability IS present" path
 * while the credential-isolation suite separately proves that the same
 * declaration is the only thing that enables the path, and that reading the
 * ledger behind it still works in this build (which is exactly why the host
 * requirement exists).
 *
 * Usage:
 *   const runtime = new OutcomeGraphRuntime({
 *     ...,
 *     credentialIsolation: testHostCredentialIsolation(dir),
 *   });
 */

import type { CredentialIsolationAdapter } from "../../../src/graph/outcome/credential-isolation.ts";

/**
 * A version-1 adapter declaration naming `credentialStoreRoot` as the
 * protected store. Deeply frozen, like the value the module's reader returns.
 */
export function testHostCredentialIsolation(
  credentialStoreRoot: string,
): CredentialIsolationAdapter {
  return Object.freeze({
    version: 1 as const,
    id: "test-host:credential-isolation",
    credentialStoreRoot,
    guarantees: Object.freeze({
      protectedCredentialStore: true as const,
      perAttemptDelivery: true as const,
    }),
  });
}
