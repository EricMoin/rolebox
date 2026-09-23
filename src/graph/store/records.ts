/**
 * Graph store — the records the unified store owns
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * The records this store persists BEYOND the ledger port's own model
 * (`src/graph/ledger/types.ts`, unchanged and reused): the accepted business
 * result, the immutable graph definition with its compiled-plan snapshot, and
 * the host-side records the execution index, the credential vault and the
 * invocation-origin record used to keep in a second database and a JSON file.
 *
 * ONE DEFINITION PER CONCEPT, the P1 rule. Where a domain shape already exists
 * (`AcceptedResult`, `HostInvocationOrigin`, `HostDispatchExecution`,
 * `HostExecutionIdentity`, `CredentialStoreIdentity`) this module ALIASES it —
 * every reference is `import type`, so nothing here restates a shape and
 * nothing here pulls a runtime dependency into the store. The one shape that is
 * genuinely new is the persisted DEFINITION ROW: the domain's
 * `GraphDefinition` holds live objects (a validated declaration and a compiled
 * plan), while a durable row holds their JSON text, so the row is declared as
 * the persisted projection of that domain object rather than as a second
 * definition of it.
 *
 * Dependency leaf at runtime: only `import type` statements.
 */

import type { AcceptedResult, GraphDefinition } from "../domain/model.ts";
import type {
  HostDispatchExecution,
  HostExecutionConfirmation,
  HostExecutionIdentity,
  HostExecutionNotCreated,
  HostExecutionRefusal,
  HostExecutionRefusalKind,
} from "../host/execution-index.ts";
import type { HostInvocationOrigin } from "../host/invocation-origins.ts";
import type { CredentialStoreIdentity } from "../outcome/credential-isolation.ts";
import type { AcceptanceBatch, CommitResult } from "../ledger/types.ts";

/** The DAO the store addresses host bindings and credentials by. */
export type StoreEffectKey = {
  readonly graphId: string;
  readonly effectId: string;
  readonly attemptId: string;
};

// ── Accepted results ────────────────────────────────────────────────────────

/**
 * The accepted business result of one settled attempt, as a durable row.
 *
 * It IS the domain's {@link AcceptedResult} plus the acceptance time, so a
 * reader of the row and a reader of the domain model see one shape, not two. At
 * most one row exists per `(graphId, attemptId)` — the same key that carries at
 * most one accepted event — and the row is written INSIDE the acceptance
 * transaction, so a result can never be readable for an attempt whose receipt
 * did not commit.
 */
export type AcceptedResultRecord = AcceptedResult & {
  /** Epoch milliseconds, supplied by the caller. */
  readonly acceptedAt: number;
};

/**
 * One acceptance batch, extended with the accepted result the SAME transaction
 * commits.
 *
 * `AcceptanceBatch` (the port's shape) still describes the receipt, the event
 * and the pending effects; the result is the store's addition, because the port
 * predates the record. An `AcceptanceBatch` is therefore a valid
 * `GraphAcceptanceBatch` — no existing caller changes — and a caller that
 * holds the accepted payload hands it over here instead of opening a second
 * commit for it.
 */
export interface GraphAcceptanceBatch extends AcceptanceBatch {
  readonly acceptedResult?: AcceptedResultRecord;
}

// ── Graph definition ────────────────────────────────────────────────────────

/**
 * The persisted projection of the domain's {@link GraphDefinition}: the
 * immutable definition content of one logical graph, as the store holds it.
 *
 * `declaration` and `plan` are the JSON bodies of the validated v3
 * declaration and the compiled plan (the store persists their text verbatim;
 * the shape of those objects is the compiler's, not the store's).
 * `declarationDigest` is the ADOPTION key: an unchanged re-declaration is the
 * same definition and is preserved; a changed one is refused, never written
 * over — the same rule the declaration path already enforces by name
 * (`declaration-changed`).
 *
 * ONE row per graph: the definition is content, and a changed content is a
 * different plan revision, not an edit of the stored one.
 */
export interface GraphDefinitionRecord {
  readonly graphId: string;
  /** Content digest of the declaration — the adoption key. */
  readonly declarationDigest: string;
  /** The compiled plan's own content-addressed revision. */
  readonly planRevision: string;
  /** The validated v3 declaration, persisted as its JSON text. */
  readonly declaration: unknown;
  /** The compiled plan (its persisted projection), as its JSON text. */
  readonly plan: unknown;
  /** Epoch milliseconds, supplied by the caller. */
  readonly recordedAt: number;
}

/**
 * What writing one definition did.
 *
 * - `recorded` — no definition existed for the graph; the row was written.
 * - `preserved` — the SAME declaration digest and plan revision were already
 *   stored: nothing was written and the stored definition is returned (the B8
 *   "an unchanged declaration preserves it" rule).
 * - `changed` — the graph already names a definition with DIFFERENT content:
 *   nothing was written, and the stored definition is returned so the caller can
 *   refuse with the existing `declaration-changed` reason instead of silently
 *   replacing a plan a run may be executing.
 */
export type DefinitionWriteResult =
  | { readonly kind: "recorded" }
  | { readonly kind: "preserved"; readonly definition: GraphDefinitionRecord }
  | { readonly kind: "changed"; readonly definition: GraphDefinitionRecord };

/** The domain shape one definition row hydrates. Names the alias for readers. */
export type StoreGraphDefinition = GraphDefinition;

// ── Host records ────────────────────────────────────────────────────────────

/**
 * One execution-binding row, as read back.
 *
 * ALIAS of the host registry's own record (the typed view of the
 * `host_dispatch_executions` row): the store persists it, the registry reads
 * it, and there is exactly one shape.
 */
export type ExecutionBindingRecord = HostDispatchExecution;

/** What the host's platform named the execution it started. */
export type ExecutionIdentity = HostExecutionIdentity;

/**
 * A delivery's PROOF that no execution was created for one effect (P2 item 4).
 *
 * ALIAS of the host registry's own proof shape: the host adapter mints it (a
 * synchronous delivery refusal, or the platform's execution query answering
 * `absent`) and every release statement this store owns REQUIRES it, so an
 * unproven failure cannot drop a create right even by mistake.
 */
export type ExecutionNotCreated = HostExecutionNotCreated;

/** What one conditional confirmation did (confirmed / replayed / fenced / ...). */
export type ExecutionConfirmation = HostExecutionConfirmation;

/** The kind of write one registry row refused (see ExecutionRefusal). */
export type ExecutionRefusalKind = HostExecutionRefusalKind;

/** The last refused write of one registry row. */
export type ExecutionRefusal = HostExecutionRefusal;

/**
 * The answer to "may THIS instance create the execution?".
 *
 * `held` is the explicit refusal the create-once rule needs: the effect is
 * owned by another claim or already exists, and this instance must not hand it
 * to the platform again.
 */
export type ExecutionClaim =
  | {
      readonly kind: "claimed";
      readonly ownerId: string;
      /**
       * WHICH claim of that owner this is. The store mints it with the row and
       * moves it on every ownership transition; a caller must present it on
       * every later write, which is what fences a superseded claim out.
       */
      readonly generation: number;
    }
  | { readonly kind: "held"; readonly row: ExecutionBindingRecord };

/** One attempt's credential record, keyed by the runtime's attempt identity. */
export type CredentialRecordIdentity = CredentialStoreIdentity;

/** What a credential row records about the VALUE. Never the value itself. */
export type CredentialRetention = "retained" | "not-retained";

/** One RETAINED credential, as the vault loads it back. Never a listing API. */
export interface RetainedCredential {
  readonly identity: CredentialRecordIdentity;
  readonly credential: string;
}

/** The declaring invocation of one graph. ALIAS of the host's record shape. */
export type InvocationOriginRecord = HostInvocationOrigin;

/** Re-exported so a store reader names the ledger's verdict through one import. */
export type StoreCommitResult = CommitResult;
