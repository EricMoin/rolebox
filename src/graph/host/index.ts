/**
 * Graph Execution Engine v2 — the host capability layer
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * The SHIPPED host-side implementations of the four capabilities the outcome
 * run path requires (`docs/graph-outcome-protocol.md`, the D7/D8/D9 sections):
 *
 * - `credential-vault.ts` — the protected store and per-attempt delivery half
 *   of the credential-isolation capability (version 2), with the honest
 *   boundary of what a same-account host platform can and cannot isolate;
 * - `execution-index.ts` — the host's record of the executions it created, so
 *   a restart can answer `created` / `absent` / `unknown` about a dispatch
 *   effect instead of guessing;
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
  HOST_CREDENTIAL_MIRROR_FILE,
  HOST_CREDENTIAL_MIRROR_VERSION,
  HostCredentialVault,
  type HostCredentialDurability,
  type HostCredentialVaultOptions,
} from "./credential-vault.ts";
export {
  HOST_EXECUTION_INDEX_FILE,
  HOST_EXECUTION_INDEX_VERSION,
  HostExecutionIndex,
  type HostExecutionIndexDurability,
  type HostExecutionIndexOptions,
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
