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
 * WHAT THIS BUILD CANNOT DO, STATED FIRST. An attempt credential is a bearer
 * nonce minted at dispatch and persisted in the attempt's own state entry
 * inside the acceptance ledger (see `attempt-credential.ts`). This build
 * writes that ledger as an ordinary file under a configured root, so ANY
 * process that can read the file can read every resident attempt credential,
 * rebind one to another attempt and be accepted: the repository's default root
 * is the workspace, and moving the file to another directory, mounting it
 * read-only, or checking its path here would change nothing about what a
 * same-account process can read. There is no in-process check this module could
 * perform that would make the store protected, so it does not pretend to make
 * one: the boundary is a property of the HOST, not of this build.
 *
 * THEREFORE THE RUN PATH REQUIRES AN EXPLICIT HOST CAPABILITY. A host that
 * provides (a) a credential store outside every dispatched worker's read and
 * write scope and (b) a dispatch channel that hands each attempt ONLY its own
 * credential, declares both by injecting a {@link CredentialIsolationAdapter}.
 * The outcome run path (`runtime.ts` start/resume/submit), the model-facing
 * ingress (`tools/submit-outcome.ts`) and the startup sweep
 * (`engine/engine-startup.ts`) all consult
 * {@link credentialIsolationRefusal} BEFORE they read or write anything: with
 * no adapter, or with a value that is not a readable version-1 adapter, they
 * refuse with {@link CREDENTIAL_ISOLATION_REFUSAL_CODE} and a diagnostic naming
 * exactly what the host must inject. Nothing is started, resumed or settled
 * under a weaker assumption, and no path "runs anyway".
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
): CredentialIsolationAdapter | undefined {
  if (!isRecord(raw)) return undefined;
  if (!hasExactKeys(raw, ["version", "id", "credentialStoreRoot", "guarantees"])) {
    return undefined;
  }
  if (raw.version !== CREDENTIAL_ISOLATION_VERSION) return undefined;
  const id = nonEmptyString(raw.id);
  const credentialStoreRoot = nonEmptyString(raw.credentialStoreRoot);
  if (id === undefined || credentialStoreRoot === undefined) return undefined;
  const guarantees = readGuarantees(raw.guarantees);
  if (guarantees === undefined) return undefined;
  return Object.freeze({
    version: CREDENTIAL_ISOLATION_VERSION,
    id,
    credentialStoreRoot,
    guarantees,
  });
}

/** Whether a value is a readable version-1 credential-isolation adapter. */
export function isCredentialIsolationAdapter(
  value: unknown,
): value is CredentialIsolationAdapter {
  return readCredentialIsolationAdapter(value) !== undefined;
}

/**
 * A diagnostic token naming one adapter: `"id" (protected store <root>)`.
 *
 * Only ever built from a READ adapter, so the root named is the host's own
 * declaration. It carries no credential.
 */
export function describeCredentialIsolation(
  adapter: CredentialIsolationAdapter,
): string {
  return (
    JSON.stringify(adapter.id) +
    " (protected credential store " +
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
        "capability, and this build cannot protect the attempt credentials it " +
        "persists — the acceptance ledger is an ordinary file under the configured " +
        "store root, so any process that can read it (including a dispatched worker " +
        "on the same account) can read another attempt's credential, rebind it and " +
        "be accepted. No path check, read-only mount or directory move performed " +
        "here would change that, so the outcome run path REFUSES to start, resume " +
        "or settle anything until the host injects a version-" +
        CREDENTIAL_ISOLATION_VERSION +
        " credential-isolation adapter declaring { guarantees: { " +
        "protectedCredentialStore: true, perAttemptDelivery: true } } and a " +
        "credentialStoreRoot outside every dispatched worker's read and write " +
        "scope; nothing was written",
    });
  }
  if (!isCredentialIsolationAdapter(adapter)) {
    return Object.freeze({
      code: CREDENTIAL_ISOLATION_REFUSAL_CODE,
      path: "$.credentialIsolation" as const,
      message:
        "outcome-runtime: the injected credential-isolation capability is not a " +
        "readable version-" +
        CREDENTIAL_ISOLATION_VERSION +
        " adapter — it must be exactly { version: " +
        CREDENTIAL_ISOLATION_VERSION +
        ", id, credentialStoreRoot, guarantees: { protectedCredentialStore: true, " +
        "perAttemptDelivery: true } } of non-empty strings. A capability this build " +
        "cannot read is refused rather than downgraded to an unprotected run, so " +
        "nothing was started, resumed or settled",
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
