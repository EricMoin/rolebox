/**
 * A HOST ADAPTER for the outcome-protocol tests (D7), backed by the REAL host
 * capability layer instead of a declaration stub.
 *
 * `src/graph/host/credential-vault.ts` is the shipped store half of the
 * credential-isolation capability: the process-memory authority plus the host's
 * authoritative store, where a durable row records the attempt and — by
 * DEFAULT — no credential value at all. The graph suite exercises the run path
 * through it, so the tests drive the same code a host deployment does rather
 * than a stand-in that could drift from it.
 *
 * DEFAULT (no value on disk) IS WHAT THIS HELPER OPENS, and it is enough for
 * every case that resolves a credential within the process that minted it. A
 * case that needs a SECOND process (a fresh vault over the same root) to
 * re-deliver a crash-window attempt must say so explicitly:
 * `testHostCredentialIsolation(dir, { durableCredentialStore: "platform-isolated" })`
 * — that is an assertion about a platform boundary the test does not have, so
 * only the cases that are ABOUT restart re-delivery should make it.
 *
 * A test process still cannot provide a boundary around the store file: it runs
 * in the same account as the ledger it writes, exactly like a dispatched worker
 * would. That is the documented host-side boundary
 * (`credential-isolation.ts`), not something this helper pretends to fix; the
 * credential-isolation suite proves the part this build DOES own — with the
 * default adapter, reading the whole store yields no credential at all, and a
 * ledger read yields only a digest.
 *
 * Usage:
 *   const runtime = new OutcomeGraphRuntime({
 *     ...,
 *     credentialIsolation: testHostCredentialIsolation(dir),
 *   });
 */

import { HostCredentialVault } from "../../../src/graph/host/credential-vault.ts";
import type {
  CredentialIsolationAdapterV3,
  DurableCredentialStore,
} from "../../../src/graph/outcome/credential-isolation.ts";

/**
 * A version-3 adapter over a real vault rooted at `credentialStoreRoot` (which
 * is also the root the runtime opens the acceptance ledger under).
 */
export function testHostCredentialIsolation(
  credentialStoreRoot: string,
  options: { readonly durableCredentialStore?: DurableCredentialStore } = {},
): CredentialIsolationAdapterV3 {
  return HostCredentialVault.open({
    root: credentialStoreRoot,
    id: "test-host:credential-vault",
    ...(options.durableCredentialStore === undefined
      ? {}
      : { durableCredentialStore: options.durableCredentialStore }),
  }).capability();
}
