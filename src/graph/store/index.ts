/**
 * Graph store — the ONE authoritative workspace store
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * The single import surface for the converged durable substrate of P1 items 3
 * and 6:
 *
 * - `schema.ts` — the one file, the one format identity, every table and its
 *   exact column shape;
 * - `errors.ts` — the refusal vocabulary (the ledger's own names, moved);
 * - `format.ts` — the format gate: verify, initialize, refuse;
 * - `json.ts` — the one JSON representability rule;
 * - `ledger-tables.ts` — the acceptance tables and their protocol rules ON the
 *   store's connection;
 * - `graph-store.ts` — the store, its ONE transaction interface and every
 *   record it owns;
 * - `load.ts` — the `absent` / `valid` / `corrupt` / `unsupported` verdict.
 *
 * The ledger port (`src/graph/ledger/types.ts`) keeps the record model and the
 * `AcceptanceLedger` port; `src/graph/ledger/sqlite-ledger.ts` re-exports the
 * names it always exported and implements the port over this store, so no
 * existing caller changes.
 */

export {
  GRAPH_STORE_FILE,
  GRAPH_STORE_FORMAT_VERSION,
  GRAPH_STORE_LEDGER_TABLES,
  GRAPH_STORE_TABLES,
  RETIRED_AUTHORITY_FILES,
  graphStoreFilePath,
  graphStoreRoot,
  type GraphStoreColumn,
} from "./schema.ts";
export {
  GraphStoreClosedError,
  GraphStoreFormatError,
  GraphStoreWriteError,
  type GraphStoreFormatProblem,
  type GraphStoreWriteProblem,
} from "./errors.ts";
export {
  emptyStoreRefusal,
  isWalStore,
  readStoreDirectory,
  retiredAuthorityRefusal,
  type StoreDirectoryReading,
} from "./format.ts";
export {
  GraphStore,
  type GraphStoreTx,
} from "./graph-store.ts";
export {
  type AcceptedResultRecord,
  type CredentialRecordIdentity,
  type CredentialRetention,
  type DefinitionWriteResult,
  type ExecutionBindingRecord,
  type ExecutionClaim,
  type ExecutionIdentity,
  type GraphAcceptanceBatch,
  type GraphDefinitionRecord,
  type InvocationOriginRecord,
  type RetainedCredential,
  type StoreEffectKey,
} from "./records.ts";
export {
  loadGraphStore,
  loadGraphStoreSync,
  type GraphStoreLoadResult,
} from "./load.ts";
