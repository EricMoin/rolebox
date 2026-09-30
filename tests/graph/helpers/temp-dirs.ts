/**
 * Temp-tree teardown for the graph suite: release the fixture stores the tree
 * holds, remove the tree, and never retry a directory that failed.
 *
 * WHY THIS EXISTS. Every graph test builds its fixture in a `mkdtemp` tree and
 * removes it in an `afterEach` sweep. Two things about that sweep matter on a
 * platform where an open handle is observable (Windows: `rm 'C:\\…\\tmp'` ->
 * `EBUSY`):
 *
 * 1. A store connection inside the tree must be RELEASED BEFORE the removal.
 *    `removeTempTree` closes every fixture store registered at or under the
 *    directory first — the credential-isolation vaults the shared helper opens
 *    (`closeTestHostCredentialIsolations`) and the store connections a test
 *    opened through `openTrackedExecutionIndex` / `openTrackedCredentialVault`
 *    / `trackFixtureStore`.
 * 2. A removal that throws must not be retried forever. Bun reports a failing
 *    `afterEach` once per test that follows it, so a shared sweep that kept its
 *    pending list on failure turned ONE leaked handle into 27 reported failures
 *    (`control-entry-vWO1WO`, 20.38 s of retries) and, with fail-fast, canceled
 *    the whole Windows lane.
 *
 * `removeTempTrees` therefore clears the pending list BEFORE the first removal:
 * every directory is attempted exactly once, and the first failure is rethrown
 * so a genuine leak still fails the test it belongs to — once, not 27 times.
 */

import { rmSync } from "node:fs";
import { resolve, sep } from "node:path";

import {
  HostCredentialVault,
  type HostCredentialVaultOptions,
} from "../../../src/graph/host/credential-vault.ts";
import {
  HostExecutionIndex,
  type HostExecutionIndexOptions,
} from "../../../src/graph/host/execution-index.ts";
import { closeTestHostCredentialIsolations } from "./credential-isolation.ts";

/** A connection-owning fixture object this module knows how to release. */
interface ClosableStore {
  close(): void;
}

/** One store connection a test opened and the teardown still owns. */
interface TrackedStore {
  /** The directory the store was opened over, as the caller named it. */
  readonly root: string;
  readonly store: ClosableStore;
  released: boolean;
}

const trackedStores: TrackedStore[] = [];

/**
 * True when `candidate` is `root` itself or a path inside it. Both sides are
 * resolved and the separator is the platform's, so the check holds on Windows
 * too (where a tree is `C:\\…\\tmp` and a nested store root is `C:\\…\\tmp\\host-store`).
 */
function isAtOrUnder(candidate: string, root: string): boolean {
  const path = resolve(candidate);
  const base = resolve(root);
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * Register a fixture store whose connection this module's teardown must
 * release before it removes the store's tree, and return the same object:
 *
 *   const origins = trackFixtureStore(root, HostInvocationOrigins.open({ root }));
 *
 * Release is not sticky either: a store that refuses to close leaves the
 * registry immediately, so the next sweep does not retry it.
 */
export function trackFixtureStore<T extends ClosableStore>(root: string, store: T): T {
  trackedStores.push({ root, store, released: false });
  return store;
}

/**
 * `HostExecutionIndex.open`, with the index's store connection owned by the
 * fixture teardown. An index opened inline and dropped keeps the store file
 * open inside the tree, which is exactly the handle that makes the tree
 * unremovable on Windows.
 */
export function openTrackedExecutionIndex(
  options: HostExecutionIndexOptions,
): HostExecutionIndex {
  return trackFixtureStore(options.root, HostExecutionIndex.open(options));
}

/** `HostCredentialVault.open`, with the vault's store connection owned the same way. */
export function openTrackedCredentialVault(
  options: HostCredentialVaultOptions,
): HostCredentialVault {
  return trackFixtureStore(options.root, HostCredentialVault.open(options));
}

/**
 * Close every tracked store opened at or under `root`; with no argument, every
 * tracked store. Returns how many were closed. Every match is attempted and the
 * FIRST close failure is rethrown once the rest have been attempted, so a store
 * that refuses to close is reported rather than silently left open.
 */
export function closeTrackedFixtureStores(root?: string): number {
  const matches = trackedStores.filter(
    (entry) => !entry.released && (root === undefined || isAtOrUnder(entry.root, root)),
  );
  let closed = 0;
  let firstError: unknown;
  for (const entry of matches) {
    const index = trackedStores.indexOf(entry);
    if (index !== -1) trackedStores.splice(index, 1);
    entry.released = true;
    try {
      entry.store.close();
      closed += 1;
    } catch (error) {
      if (firstError === undefined) firstError = error;
    }
  }
  if (firstError !== undefined) throw firstError;
  return closed;
}

/**
 * Release the fixture stores opened under `dir`, then remove `dir`.
 *
 * Both steps are attempted, and the first failure is rethrown after the other
 * has run: a store that refuses to close must not leave the tree behind, and a
 * tree that refuses to go must not hide the release failure that explains it.
 */
export function removeTempTree(dir: string): void {
  let firstError: unknown;
  try {
    closeTrackedFixtureStores(dir);
  } catch (error) {
    firstError = error;
  }
  try {
    closeTestHostCredentialIsolations(dir);
  } catch (error) {
    if (firstError === undefined) firstError = error;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    if (firstError === undefined) firstError = error;
  }
  if (firstError !== undefined) throw firstError;
}

/**
 * Remove every pending directory exactly once, reporting the first failure.
 *
 * The pending list is emptied up front (`splice(0)`), so a directory whose
 * removal throws is gone from the list before the throw can reach the caller's
 * `afterEach`: the next sweep retries nothing. All remaining directories are
 * still attempted, and the first error is rethrown at the end.
 */
export function removeTempTrees(dirs: string[]): void {
  const pending = dirs.splice(0);
  let firstError: unknown;
  for (const dir of pending) {
    try {
      removeTempTree(dir);
    } catch (error) {
      if (firstError === undefined) firstError = error;
    }
  }
  if (firstError !== undefined) throw firstError;
}
