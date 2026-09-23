/**
 * A HOST ADAPTER for the outcome-protocol tests (D7), backed by the REAL host
 * capability layer instead of a declaration stub.
 *
 * `src/graph/host/credential-vault.ts` is the shipped store half of the
 * credential-isolation capability: the process-memory authority plus a separate
 * `0600` mirror file, with `remember`/`resolve` for exactly the attempt a
 * credential was issued for. The 1824-test graph suite exercises the run path
 * through it, so the tests drive the same code a host deployment does rather
 * than a stand-in that could drift from it.
 *
 * WHAT A TEST PROCESS STILL CANNOT PROVIDE is a boundary around the mirror
 * file: the test runs in the same account as the ledger it writes, exactly like
 * a dispatched worker would, so the vault's file is readable by it. That is the
 * documented host-side boundary (`credential-isolation.ts`), not something
 * this helper pretends to fix; the credential-isolation suite proves the part
 * this build DOES own — a reader of the ledger and of every report surface gets
 * only a digest.
 *
 * The vault is keyed by the store root and reads the mirror file on open, so a
 * second runtime constructed over the same root (a restart, in-process) resolves
 * the credentials the first one minted.
 *
 * Usage:
 *   const runtime = new OutcomeGraphRuntime({
 *     ...,
 *     credentialIsolation: testHostCredentialIsolation(dir),
 *   });
 */

import { HostCredentialVault } from "../../../src/graph/host/credential-vault.ts";
import type { CredentialIsolationAdapterV2 } from "../../../src/graph/outcome/credential-isolation.ts";

/**
 * A version-2 adapter over a real vault rooted at `credentialStoreRoot` (which
 * is also the root the runtime opens the acceptance ledger under).
 */
export function testHostCredentialIsolation(
  credentialStoreRoot: string,
): CredentialIsolationAdapterV2 {
  return HostCredentialVault.open({
    root: credentialStoreRoot,
    id: "test-host:credential-vault",
  }).capability();
}
