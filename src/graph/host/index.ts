/**
 * Graph Execution Engine v2 — the host capability layer
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * The SHIPPED host-side implementations of the four capabilities the outcome
 * run path requires (`docs/graph-outcome-protocol.md`, the D7/D8/D9 sections):
 *
 * - `host-store.ts` — the host's authoritative SQLite store (execution rows
 *   and attempt-credential rows), with the format gate, the uniqueness and the
 *   transactions the two record-keeping modules below rely on;
 * - `credential-vault.ts` — the store and per-attempt delivery half of the
 *   credential-isolation capability (version 3), whose default keeps NO
 *   credential value on disk and whose capability states that honestly;
 * - `execution-index.ts` — the host's record of the executions it created
 *   (`pending` / `creating` / `created`, with a real host execution id only in
 *   the last), so a restart can answer `created` / `absent` / `unknown` about
 *   a dispatch effect instead of guessing, and two host processes cannot both
 *   claim one effect;
 * - `dispatch-host.ts` — the `OutcomeDispatchHost` implementation: create at
 *   most once per stable effect id, look up the host's fact;
 * - `identity.ts` — the invocation-identity capability (version 1) a host
 *   injects so an attempt is settled only by the invocation that dispatched it;
 * - `invocation-origins.ts` — the host's record of which invocation DECLARED
 *   each graph, so every window that arms a dispatch (a first execution, a
 *   worker's submission, an observed completion, a boot sweep) starts the
 *   worker under the same parent instead of the window's ambient attribution;
 * - `completion-bridge.ts` — the bridge from an observed completion to
 *   `settleNatural`, which is the only settlement channel a completion uses.
 *
 * A host wires them together around its own dispatch seam; nothing in this
 * directory imports a platform or an engine, so the layer is the same for every
 * host and is driven directly by the tests.
 */

export {
  HostStore,
  HostStoreFormatError,
  hostStoreRoot,
  HOST_STORE_FILE,
  HOST_STORE_FORMAT_VERSION,
  HOST_STORE_TABLES,
} from "./host-store.ts";
export {
  HOST_CREDENTIAL_TABLE,
  HostCredentialVault,
  type HostCredentialDurability,
  type HostCredentialVaultOptions,
} from "./credential-vault.ts";
export {
  HOST_EXECUTION_CLAIM_LEASE_MS,
  HOST_EXECUTION_TABLE,
  HostExecutionIndex,
  type HostDispatchExecution,
  type HostExecutionClaim,
  type HostExecutionIdentity,
  type HostExecutionIndexDurability,
  type HostExecutionIndexOptions,
  type HostExecutionState,
} from "./execution-index.ts";
export {
  HostOutcomeDispatch,
  type HostAttemptBinding,
  type HostCompletionBindingSink,
  type HostDispatchDelivery,
  type HostDispatchInvocation,
  type HostOutcomeDispatchOptions,
} from "./dispatch-host.ts";
export {
  HOST_INVOCATION_ORIGINS_FILE,
  HOST_INVOCATION_ORIGINS_VERSION,
  HostInvocationOrigins,
  type HostInvocationOrigin,
  type HostInvocationOriginsDurability,
  type HostInvocationOriginsOptions,
} from "./invocation-origins.ts";
export {
  createHostInvocationHolder,
  hostIdentityCapability,
  hostInvocationIdentity,
  type HostInvocationHolder,
  type HostInvocationSource,
} from "./identity.ts";
export {
  HostDispatchCompletionBridge,
  type HostCompletionAttempt,
  type HostCompletionBridgeOptions,
  type HostCompletionReport,
  type HostCompletionRuntime,
  type HostCompletionRuntimeProvider,
  type HostCompletionSettlement,
} from "./completion-bridge.ts";
export {
  OutcomeHost,
  bindOutcomeToolInvocation,
  type OutcomeHostDurability,
  type OutcomeHostInvocation,
  type OutcomeHostOptions,
  type OutcomeHostRecoveryReport,
  type OutcomeToolAttribution,
} from "./outcome-host.ts";
