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
 * OWNERSHIP. The vault `HostCredentialVault.open` returns owns an OPEN STORE
 * CONNECTION. Earlier this helper returned only `vault.capability()` and threw
 * the vault away, so nothing in the process could close that connection: the
 * handle stayed open inside the test's temp tree, and removing the tree
 * afterwards failed on Windows (`EBUSY: resource busy or locked, rm …`). Every
 * connection opened here is therefore REGISTERED, and every caller releases it
 * in the same teardown that removes the tree:
 *
 *   - `testHostCredentialIsolation(root)` returns the capability, for the
 *     fixture literals that only need one, and the registry owns the vault;
 *   - `closeTestHostCredentialIsolations(root)` closes every vault opened at or
 *     under `root` (no argument: all of them). `tests/graph/helpers/temp-dirs.ts`
 *     calls it from `removeTempTree`, so the ordinary `afterEach` sweep releases
 *     the fixture before it removes the directory;
 *   - `openTestHostCredentialIsolation(root)` returns the capability AND its
 *     `close()` for a case that binds the adapter to a local of its own;
 *   - a test that drives `HostCredentialVault.open` directly registers it with
 *     `helpers/temp-dirs.ts` (`openTrackedCredentialVault`), whose teardown
 *     releases it by the same rule.
 *
 * Usage:
 *   const runtime = new OutcomeGraphRuntime({
 *     ...,
 *     credentialIsolation: testHostCredentialIsolation(dir),
 *   });
 *   // … and the fixture's teardown (removeTempTree/removeTempTrees) closes it
 *   // before it removes `dir`.
 */

import { resolve, sep } from "node:path";

import { HostCredentialVault } from "../../../src/graph/host/credential-vault.ts";
import type {
  CredentialIsolationAdapterV3,
  DurableCredentialStore,
} from "../../../src/graph/outcome/credential-isolation.ts";

/** Inputs the two openers accept: the durable-store choice, nothing else. */
interface TestHostCredentialIsolationOptions {
  readonly durableCredentialStore?: DurableCredentialStore;
}

/** One vault this module opened (or was handed) and has not released yet. */
interface TrackedVault {
  /** The root the vault was opened over, exactly as the caller named it. */
  readonly root: string;
  readonly vault: HostCredentialVault;
  released: boolean;
}

const trackedVaults: TrackedVault[] = [];

/** True when `candidate` is `root` itself or a path inside it. */
function isAtOrUnder(candidate: string, root: string): boolean {
  const path = resolve(candidate);
  const base = resolve(root);
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
}

function track(root: string, vault: HostCredentialVault): TrackedVault {
  const entry: TrackedVault = { root, vault, released: false };
  trackedVaults.push(entry);
  return entry;
}

/** Drop `entry` from the registry, whoever is releasing it. */
function untrack(entry: TrackedVault): void {
  const index = trackedVaults.indexOf(entry);
  if (index !== -1) trackedVaults.splice(index, 1);
}

/**
 * Release one tracked vault. The entry leaves the registry BEFORE the close, so
 * a close that throws cannot leave the same connection queued for the next
 * sweep — the non-stickiness the temp-tree teardown needs, applied to the
 * release itself.
 */
function release(entry: TrackedVault): void {
  entry.released = true;
  untrack(entry);
  entry.vault.close();
}

/**
 * Close every tracked vault opened at or under `root`; with no argument, every
 * tracked vault. Returns how many were closed, and is safe to call for a root
 * nothing was opened over, or twice over the same root.
 *
 * Every matching vault is attempted; the FIRST close failure is rethrown once
 * the rest have been attempted, so a store that refuses to close is reported
 * rather than silently left open (the caller — `removeTempTree` — still removes
 * the tree and reports both outcomes).
 */
export function closeTestHostCredentialIsolations(root?: string): number {
  const matches = trackedVaults.filter(
    (entry) => !entry.released && (root === undefined || isAtOrUnder(entry.root, root)),
  );
  let closed = 0;
  let firstError: unknown;
  for (const entry of matches) {
    try {
      release(entry);
      closed += 1;
    } catch (error) {
      if (firstError === undefined) firstError = error;
    }
  }
  if (firstError !== undefined) throw firstError;
  return closed;
}

/** A capability, plus the release that closes the store connection behind it. */
export interface TestHostCredentialIsolation {
  readonly capability: CredentialIsolationAdapterV3;
  /** Close this vault's store connection. Idempotent. */
  close(): void;
}

/**
 * Open one vault over `credentialStoreRoot` (which is also the root the runtime
 * opens the acceptance ledger under) and return BOTH its capability and the
 * close that releases its connection. Prefer this form when the case binds the
 * adapter to a local it can close; otherwise use `testHostCredentialIsolation`
 * and let the fixture teardown release the registered vault.
 */
export function openTestHostCredentialIsolation(
  credentialStoreRoot: string,
  options: TestHostCredentialIsolationOptions = {},
): TestHostCredentialIsolation {
  const vault = HostCredentialVault.open({
    root: credentialStoreRoot,
    id: "test-host:credential-vault",
    ...(options.durableCredentialStore === undefined
      ? {}
      : { durableCredentialStore: options.durableCredentialStore }),
  });
  const entry = track(credentialStoreRoot, vault);
  return {
    capability: vault.capability(),
    close: () => {
      if (entry.released) return;
      release(entry);
    },
  };
}

/**
 * A version-3 adapter over a real vault rooted at `credentialStoreRoot`: the
 * capability alone, with the vault owned by this module's registry and released
 * by `closeTestHostCredentialIsolations` (which `removeTempTree` calls) in the
 * same teardown that removes the tree.
 */
export function testHostCredentialIsolation(
  credentialStoreRoot: string,
  options: TestHostCredentialIsolationOptions = {},
): CredentialIsolationAdapterV3 {
  return openTestHostCredentialIsolation(credentialStoreRoot, options).capability;
}
