/**
 * Graph Execution Engine v2 — Credential-isolation host capability (D7)
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * THE PRODUCTION-ENABLEMENT CONDITION OF THE OUTCOME RUN PATH.
 * (docs/graph-outcome-protocol.md § "D7", and the credential section of
 * § "Submission and acceptance".)
 *
 * WHAT THIS BUILD NOW DOES, AND WHAT IT STILL CANNOT DO. The acceptance ledger
 * no longer carries a usable credential: an attempt's own state entry records
 * the DIGEST of its credential (state-body version 8, `attempt-credential.ts`),
 * so a process that only READS the ledger file — the reproduced defect this
 * capability was introduced for — cannot present anything that verifies. That
 * protection is the build's own and needs no host.
 *
 * WHAT IS LEFT IS THE STORE AND THE DELIVERY, AND BOTH ARE THE HOST'S. A digest
 * verifies a submission but cannot be handed back to a worker: a recovered
 * attempt (the commit-then-crash window D8 reconciles) has to be re-delivered by
 * a host that still holds the credential ITSELF, and the credential must reach
 * exactly one attempt over exactly one channel. A host that provides (a) a
 * store that keeps the credential outside every dispatched worker's read and
 * write scope and (b) a dispatch channel that hands each attempt ONLY its own
 * credential, declares both by injecting a capability. This module owns that
 * declaration in two versions:
 *
 * - version 1 ({@link CredentialIsolationAdapter}): the DECLARATION, with the
 *   store root the ledger is opened under. It enables the run path and is what
 *   every deployment that has adopted the contract already injects;
 * - version 2 ({@link CredentialIsolationAdapterV2}): the declaration PLUS the
 *   {@link CredentialIsolationStore} — the host's own `remember`/`resolve`
 *   store for the credential itself. It is what a recovery needs to re-deliver
 *   an attempt whose execution was never created; without it such an effect is
 *   REPORTED as unsettled work and never launched with a fabricated credential.
 *
 * The outcome run path (`runtime.ts` start/resume/submit), the model-facing
 * ingress (`tools/submit-outcome.ts`) and the startup sweep
 * (`engine/engine-startup.ts`) all consult
 * {@link credentialIsolationRefusal} BEFORE they read or write anything: with
 * no capability, or with a value that is not a readable version-1 or version-2
 * adapter, they refuse with {@link CREDENTIAL_ISOLATION_REFUSAL_CODE} and a
 * diagnostic naming exactly what the host must inject. Nothing is started,
 * resumed or settled under a weaker assumption, and no path "runs anyway".
 *
 * WHAT THE ADAPTER IS, AND WHAT IT IS NOT. It is an ASSERTION by the host, not
 * a proof: this build checks its SHAPE (exact version, non-empty id and store
 * root, both guarantees literally `true`) and its presence — never the
 * filesystem, never a path, never a mount option, because none of those is
 * evidence about what another process can read. A host that declares the
 * guarantees it does not provide is lying to the protocol, and nothing here can
 * detect that; that is exactly why the declaration is the gate rather than a
 * check. The adapter's VALUE is therefore the honest enablement switch the
 * deployment owns: no adapter, no new execution path.
 *
 * THE CREDENTIAL STILL TRAVELS OVER EXACTLY ONE CHANNEL. The adapter does not
 * carry, copy or report a credential: the runtime mints it, persists it on the
 * attempt's state entry, and hands it to the dispatch seam inside
 * `OutcomeDispatchRequest` — the one channel the host's delivery guarantee is
 * about. `credentialStoreRoot` is where the host declares its protected store
 * to live, and the callers that OPEN the ledger use it; it is never compared
 * against the tree, so it is a routing instruction, not a check.
 *
 * Dependency leaf: no imports at all, so the runtime, the tools, the recovery
 * seam and a host loader may all depend on it without a cycle.
 */

// ── Identity and refusal code ───────────────────────────────────────────────

/**
 * The refusal code every entry reports when the host capability is absent or
 * unreadable. Stable identifier; wording is not API.
 */
export const CREDENTIAL_ISOLATION_REFUSAL_CODE =
  "credential-isolation-unavailable" as const;

/**
 * The adapter-format version this build reads. An exact identity, like every
 * other capability identity in the protocol: an unknown version is refused,
 * never read approximately.
 */
export const CREDENTIAL_ISOLATION_VERSION = 1;

/**
 * The adapter-format version that adds the host's store for the credential
 * itself. Read as its own exact identity, exactly like version 1: the two
 * shapes are not interchangeable, and a version-2 value whose store is missing
 * or unreadable is refused rather than downgraded to the declaration alone.
 */
export const CREDENTIAL_ISOLATION_VERSION_V2 = 2;

// ── The capability ──────────────────────────────────────────────────────────

/**
 * The two things the protocol cannot verify and the host therefore declares.
 *
 * Both are the literal `true`: there is no "partly isolated" state this
 * capability could express, so an adapter cannot declare a weaker guarantee
 * and still read as one.
 */
export interface CredentialIsolationGuarantees {
  /**
   * Every persisted attempt credential — the acceptance ledger and the
   * `ledger_graph_state` body inside it — lives where NO dispatched worker
   * can read or write it.
   */
  readonly protectedCredentialStore: true;
  /**
   * A dispatched attempt receives ONLY its own credential, over its own
   * dispatch channel: no worker is handed another attempt's credential, and no
   * shared read (a state block, a status report, a log, an audit) is the
   * channel a credential arrives through.
   */
  readonly perAttemptDelivery: true;
}

/**
 * The host's credential-isolation capability, injected at construction.
 *
 * CLOSED SHAPE — exactly `{ version, id, credentialStoreRoot, guarantees }`,
 * read by {@link readCredentialIsolationAdapter}. A value with an extra key, a
 * false guarantee or a different version is not an adapter and is refused
 * rather than partially trusted.
 */
export interface CredentialIsolationAdapter {
  /** The adapter-format version — always 1 for this shape. */
  readonly version: 1;
  /**
   * The host adapter's own stable identity, for diagnostics (for example
   * `"host:protected-ledger"`). Never a secret and never a credential.
   */
  readonly id: string;
  /**
   * The store root the host declares as protected: the DIRECTORY that holds
   * the acceptance ledger (`graph-acceptance-ledger.sqlite`), which the
   * callers that open the ledger use instead of the workspace default.
   *
   * It is a routing instruction, not a check: this build never compares it
   * against a path or a mount to decide whether the host told the truth.
   */
  readonly credentialStoreRoot: string;
  /** The host's explicit declaration of the two guarantees it provides. */
  readonly guarantees: CredentialIsolationGuarantees;
}

// ── The store half (version 2) ──────────────────────────────────────────────

/**
 * The attempt one stored credential belongs to. Runtime provenance only:
 * every component is minted or compiled by the runtime, never supplied by a
 * worker or a submission.
 */
export interface CredentialStoreIdentity {
  /** The graph the attempt belongs to. */
  readonly graphId: string;
  /** The plan node the attempt executes. */
  readonly nodeId: string;
  /** The runtime-minted attempt the credential names. */
  readonly attemptId: string;
}

/**
 * The host's own store for the credential ITSELF — the half a declaration
 * cannot provide.
 *
 * `remember` is called by the runtime the moment a credential is minted, BEFORE
 * the state that records its digest is committed, so the credential exists in
 * the store for every attempt the durable state can ever name — including one
 * whose dispatch the process never got to perform. `resolve` is what a recovery
 * asks for a credential the state only holds the digest of; a credential the
 * store can no longer produce is REPORTED as unsettled work and never replaced
 * by a fresh one.
 *
 * THE STORE IS THE HOST'S, AND SO IS ITS PROTECTION. Nothing in this build
 * inspects where the store keeps its bytes, whether a worker can read them, or
 * what a mount option says: those are facts about the host's environment that no
 * value here can attest. What the runtime CAN enforce is what it does with the
 * store: a credential is written to it before it is anywhere durable, it is
 * resolved only for the exact attempt it was issued for, and it is never part
 * of a report — the attempt identity names the record, the value never does.
 */
export interface CredentialIsolationStore {
  /**
   * Adopt one freshly minted credential for the attempt it is bound to.
   *
   * Called before the attempt's state (which records only the digest) is
   * committed. A store that throws fails the whole mint — the state is not
   * written, because an attempt whose credential the host never held could
   * never be re-delivered.
   */
  remember(identity: CredentialStoreIdentity, credential: string): void;
  /**
   * The credential this store holds for one attempt, or `undefined` when it
   * cannot produce it (never held, lost with a restart, or pruned). The runtime
   * reports the effect instead of launching it.
   */
  resolve(identity: CredentialStoreIdentity): string | undefined;
}

/**
 * The HOST's credential-isolation capability, version 2: the version-1
 * declaration plus the store that actually holds the credential.
 *
 * CLOSED SHAPE — exactly `{ version, id, credentialStoreRoot, guarantees,
 * store }`, read by {@link readCredentialIsolationAdapter}. A version-2 value
 * without a readable store is refused exactly like a malformed version-1 value:
 * a host that declares the store half and omits it is not partly trusted.
 */
export interface CredentialIsolationAdapterV2 {
  /** The adapter-format version — always 2 for this shape. */
  readonly version: 2;
  /** The host adapter's own stable identity, for diagnostics. Never a secret. */
  readonly id: string;
  /** The store root the host declares as protected. See version 1. */
  readonly credentialStoreRoot: string;
  /** The host's explicit declaration of the two guarantees it provides. */
  readonly guarantees: CredentialIsolationGuarantees;
  /** The host's store for the credential itself (see the interface). */
  readonly store: CredentialIsolationStore;
}

/**
 * Every shape this build reads as a credential-isolation capability: the
 * declaration alone (version 1) or the declaration with the host's store
 * (version 2).
 */
export type CredentialIsolationCapability =
  | CredentialIsolationAdapter
  | CredentialIsolationAdapterV2;

/**
 * Read one adapter value, or `undefined` when it is not one.
 *
 * STRICT and total: the value must be a plain record whose own keys are
 * exactly this shape, `version` must be exactly 1, `id` and
 * `credentialStoreRoot` must be non-empty strings, and `guarantees` must be
 * a plain record with exactly the two keys, each literally `true`. Anything
 * else — a boolean, a version-2 adapter, a missing guarantee, an extra field —
 * names no capability and is refused by the callers rather than read
 * approximately.
 *
 * The returned adapter is deeply frozen and structurally identical to the
 * accepted input.
 */
export function readCredentialIsolationAdapter(
  raw: unknown,
): CredentialIsolationCapability | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.version === CREDENTIAL_ISOLATION_VERSION) return readVersion1Adapter(raw);
  if (raw.version === CREDENTIAL_ISOLATION_VERSION_V2) return readVersion2Adapter(raw);
  return undefined;
}

/** Read the version-1 shape (the declaration alone), or `undefined`. */
function readVersion1Adapter(
  raw: Record<string, unknown>,
): CredentialIsolationAdapter | undefined {
  if (!hasExactKeys(raw, ["version", "id", "credentialStoreRoot", "guarantees"])) {
    return undefined;
  }
  const shared = readSharedDeclaration(raw);
  if (shared === undefined) return undefined;
  return Object.freeze({
    version: CREDENTIAL_ISOLATION_VERSION,
    id: shared.id,
    credentialStoreRoot: shared.credentialStoreRoot,
    guarantees: shared.guarantees,
  });
}

/** Read the version-2 shape (the declaration plus the store), or `undefined`. */
function readVersion2Adapter(
  raw: Record<string, unknown>,
): CredentialIsolationAdapterV2 | undefined {
  if (
    !hasExactKeys(raw, [
      "version",
      "id",
      "credentialStoreRoot",
      "guarantees",
      "store",
    ])
  ) {
    return undefined;
  }
  const shared = readSharedDeclaration(raw);
  if (shared === undefined) return undefined;
  const store = readStore(raw.store);
  if (store === undefined) return undefined;
  return Object.freeze({
    version: CREDENTIAL_ISOLATION_VERSION_V2,
    id: shared.id,
    credentialStoreRoot: shared.credentialStoreRoot,
    guarantees: shared.guarantees,
    store,
  });
}

/** The fields both versions share, read strictly, or `undefined`. */
function readSharedDeclaration(raw: Record<string, unknown>):
  | {
      readonly id: string;
      readonly credentialStoreRoot: string;
      readonly guarantees: CredentialIsolationGuarantees;
    }
  | undefined {
  const id = nonEmptyString(raw.id);
  const credentialStoreRoot = nonEmptyString(raw.credentialStoreRoot);
  if (id === undefined || credentialStoreRoot === undefined) return undefined;
  const guarantees = readGuarantees(raw.guarantees);
  if (guarantees === undefined) return undefined;
  return { id, credentialStoreRoot, guarantees };
}

/**
 * Read the version-2 store: exactly `{ remember, resolve }`, both functions.
 *
 * The host's own store object may expose more than the capability needs; the
 * adapter is the CLOSED value this build reads, so a host wraps its store in
 * these two functions rather than handing over whatever else it has.
 */
function readStore(raw: unknown): CredentialIsolationStore | undefined {
  if (!isRecord(raw)) return undefined;
  if (!hasExactKeys(raw, ["remember", "resolve"])) return undefined;
  if (typeof raw.remember !== "function" || typeof raw.resolve !== "function") {
    return undefined;
  }
  const remember = raw.remember as CredentialIsolationStore["remember"];
  const resolve = raw.resolve as CredentialIsolationStore["resolve"];
  return Object.freeze({ remember, resolve });
}

/** Whether a value is a readable credential-isolation capability (either version). */
export function isCredentialIsolationAdapter(
  value: unknown,
): value is CredentialIsolationCapability {
  return readCredentialIsolationAdapter(value) !== undefined;
}

/**
 * A diagnostic token naming one adapter: `"id" (protected store <root>)`.
 *
 * Only ever built from a READ adapter, so the root named is the host's own
 * declaration. It carries no credential.
 */
export function describeCredentialIsolation(
  adapter: CredentialIsolationCapability,
): string {
  return (
    JSON.stringify(adapter.id) +
    " (version " +
    adapter.version +
    ", protected credential store " +
    JSON.stringify(adapter.credentialStoreRoot) +
    ")"
  );
}

// ── The refusal ─────────────────────────────────────────────────────────────

/** What a missing or unreadable host capability is reported as. */
export interface CredentialIsolationRefusal {
  /** Always {@link CREDENTIAL_ISOLATION_REFUSAL_CODE}. */
  readonly code: typeof CREDENTIAL_ISOLATION_REFUSAL_CODE;
  /** The runtime option a host must set. */
  readonly path: "$.credentialIsolation";
  readonly message: string;
}

/**
 * The enablement gate: `undefined` when `adapter` is a readable version-1
 * capability, a structured refusal otherwise.
 *
 * TOTAL — never a throw — because every caller reports it as data: the runtime
 * returns it, the tool ingress throws its typed refusal carrying the same
 * message, and the startup sweep records it in its `refused` bucket. The
 * message states the FACT this build cannot change (the ledger is not
 * protected by it) and the exact host obligation, so a deployment that has not
 * provided the capability can diagnose the refusal without reading this
 * module.
 */
export function credentialIsolationRefusal(
  adapter: unknown,
): CredentialIsolationRefusal | undefined {
  if (adapter === undefined) {
    return Object.freeze({
      code: CREDENTIAL_ISOLATION_REFUSAL_CODE,
      path: "$.credentialIsolation" as const,
      message:
        "outcome-runtime: this process was given no host credential-isolation " +
        "capability. This build persists only the DIGEST of an attempt credential " +
        "in the acceptance ledger, so a reader of that file cannot present one — but " +
        "the " +
        "credential ITSELF still has to be held and delivered by the host: the " +
        "digest cannot be handed to a recovered worker, and only the host can give " +
        "each attempt its own credential over its own dispatch channel. The outcome " +
        "run path therefore REFUSES to start, resume or settle anything until the " +
        "host injects a credential-isolation adapter — version " +
        CREDENTIAL_ISOLATION_VERSION +
        " declaring { guarantees: { protectedCredentialStore: true, " +
        "perAttemptDelivery: true } } and a credentialStoreRoot outside every " +
        "dispatched worker's read and write scope, or version " +
        CREDENTIAL_ISOLATION_VERSION_V2 +
        " adding the { remember, resolve } store that holds the credential and lets " +
        "a recovery re-deliver an attempt whose execution was never created; " +
        "nothing was written",
    });
  }
  if (!isCredentialIsolationAdapter(adapter)) {
    return Object.freeze({
      code: CREDENTIAL_ISOLATION_REFUSAL_CODE,
      path: "$.credentialIsolation" as const,
      message:
        "outcome-runtime: the injected credential-isolation capability is not a " +
        "readable adapter of version " +
        CREDENTIAL_ISOLATION_VERSION +
        " ({ version, id, credentialStoreRoot, guarantees: { " +
        "protectedCredentialStore: true, perAttemptDelivery: true } }) or version " +
        CREDENTIAL_ISOLATION_VERSION_V2 +
        " (the same shape plus a store of exactly { remember, resolve }). A " +
        "capability this build cannot read is refused rather than downgraded to an " +
        "unprotected run, so nothing was started, resumed or settled",
    });
  }
  return undefined;
}

// ── Primitives ──────────────────────────────────────────────────────────────

/** Read the two literal-true guarantees, or `undefined`. */
function readGuarantees(raw: unknown): CredentialIsolationGuarantees | undefined {
  if (!isRecord(raw)) return undefined;
  if (!hasExactKeys(raw, ["protectedCredentialStore", "perAttemptDelivery"])) {
    return undefined;
  }
  if (raw.protectedCredentialStore !== true) return undefined;
  if (raw.perAttemptDelivery !== true) return undefined;
  return Object.freeze({
    protectedCredentialStore: true as const,
    perAttemptDelivery: true as const,
  });
}

/** Whether a value is a PLAIN, non-array record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A non-empty string, or `undefined`. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Whether a record's own enumerable keys are EXACTLY the given set. */
function hasExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(record);
  if (own.length !== keys.length) return false;
  return keys.every((key) => own.includes(key));
}
