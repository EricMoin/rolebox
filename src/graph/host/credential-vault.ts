/**
 * Graph Execution Engine v2 — the host's attempt-credential vault
 *
 * Version: 2.0
 * Date: 2026-09-23
 *
 * THE STORE HALF OF THE CREDENTIAL-ISOLATION CAPABILITY
 * (`src/graph/outcome/credential-isolation.ts`). The outcome runtime persists
 * only the DIGEST of an attempt credential in the acceptance ledger, so this
 * host module is the one place the credential ITSELF lives — and the only place
 * a recovery can obtain one from.
 *
 * WHAT IT ENFORCES, AND WHAT IT DOES NOT.
 *
 * - ENFORCED BY THIS BUILD. No durable artifact this vault writes holds a
 *   credential VALUE unless the host explicitly declares a store it can
 *   protect. The default (`durableCredentialStore: "none"`) writes a row per
 *   attempt that records the binding and `not-retained`, so a same-account
 *   process that reads the whole store obtains no credential, and a recovery
 *   reports the effect as UNSETTLED instead of inventing one. The previous
 *   shape mirrored every credential into one 0600 JSON file while the
 *   capability declared `protectedCredentialStore: true`: a plain
 *   `readFileSync` recovered every live attempt's credential, and two
 *   processes rewriting that file from their own in-memory snapshots ERASED
 *   each other's rows. Both are gone: the value is not on disk by default, and
 *   the rows live in the host's transactional store with a per-attempt primary
 *   key.
 * - NOT ENFORCED, AND NOT CLAIMED. A host that opts into
 *   `durableCredentialStore: "platform-isolated"` puts the value back on disk
 *   so it can re-deliver a crash-window attempt after a restart. This build
 *   cannot verify that the host's store is protected: a same-account process
 *   can read the file, and no mode bit, path or mount option this module could
 *   inspect would change that. The option is therefore the deployment's
 *   ASSERTION (a different OS account, a container or mount namespace the
 *   worker is not in), it is stated as such in the capability
 *   (`durableCredentialStore`), and it is refused together with
 *   `durability: "memory"` because that combination claims a store that does
 *   not exist.
 * - THE AUTHORITATIVE COPY IS IN THIS PROCESS'S MEMORY. A credential resolves
 *   only for the exact attempt it was issued for, the API hands out at most one
 *   credential and never a listing, and no value is written to a report, a log
 *   line, an effect payload, a graph-state entry or a status surface.
 *
 * THE BINDING IS THE KEY. Every entry is addressed by
 * `(graphId, nodeId, attemptId)` — the runtime's own attempt identity — so a
 * credential can only ever be resolved for the exact attempt it was issued for.
 * The ledger's digest and this vault's exact-attempt lookup are two independent
 * halves of the same binding: neither can re-aim a credential at another
 * attempt, and neither can fabricate one for an attempt that was never issued
 * one.
 */

import { randomBytes } from "node:crypto";

import type {
  AttemptCredentialBinding,
  AttemptCredentialSource,
} from "../outcome/attempt-credential.ts";
import {
  ATTEMPT_CREDENTIAL_BYTES,
  isAttemptCredential,
} from "../outcome/attempt-credential.ts";
import type {
  CredentialIsolationAdapterV3,
  CredentialIsolationStore,
  CredentialStoreIdentity,
  DurableCredentialStore,
} from "../outcome/credential-isolation.ts";
import { CREDENTIAL_ISOLATION_VERSION_V3 } from "../outcome/credential-isolation.ts";
import { HostStore, HOST_STORE_FILE } from "./host-store.ts";

// ── Options and identity ────────────────────────────────────────────────────

/** How long the vault's RECORDS survive the process that wrote them. */
export type HostCredentialDurability =
  /**
   * The durable host store under `root` (the default). What the durable rows
   * HOLD is decided by `durableCredentialStore`: with the default `"none"`
   * they record the binding and no value.
   */
  | "file"
  /**
   * Process memory only. Nothing durable holds even the attempt's record, so a
   * restart cannot report which attempts had a credential.
   */
  | "memory";

/** Re-exported so a host names the file through this module's contract. */
export { HOST_STORE_FILE };

/** Inputs to {@link HostCredentialVault.open}. */
export interface HostCredentialVaultOptions {
  /**
   * The host-owned directory the store lives in. It is created (0700) when
   * absent and is NEVER the workspace by default: pass a host directory the
   * deployed workers are not given a path to. This is the one path-shaped part
   * of the boundary — not a substitute for the platform isolation this module
   * cannot provide.
   */
  readonly root: string;
  /**
   * The capability identity reported to the runtime for diagnostics. Never a
   * secret. Defaults to `"host:credential-vault"`.
   */
  readonly id?: string;
  /** Defaults to `"file"` (see {@link HostCredentialDurability}). */
  readonly durability?: HostCredentialDurability;
  /**
   * The minting source. Defaults to the platform CSPRNG: the vault mints and
   * stores in one step, so a credential never exists outside the vault between
   * minting and delivery.
   */
  readonly mint?: AttemptCredentialSource;
  /**
   * Whether the durable store holds the credential VALUE. Defaults to
   * `"none"` — see the module header for what each choice enforces and what it
   * merely asserts. `"platform-isolated"` with `durability: "memory"` is
   * refused: it would declare a durable store that does not exist.
   */
  readonly durableCredentialStore?: DurableCredentialStore;
}

/** The store's credential table, exported for tests that fabricate a store. */
export const HOST_CREDENTIAL_TABLE = "host_attempt_credentials" as const;

// ── The vault ───────────────────────────────────────────────────────────────

/**
 * The host's real credential store: process memory as the authority, with a
 * durable record for restart recovery whose VALUE is written only when the host
 * declares a store it can protect.
 */
export class HostCredentialVault {
  private readonly root: string;
  private readonly id: string;
  private readonly durability: HostCredentialDurability;
  private readonly retainValues: boolean;
  private readonly mintSource: AttemptCredentialSource;
  private readonly entries = new Map<string, string>();
  private readonly hostStore: HostStore;

  private constructor(options: HostCredentialVaultOptions) {
    this.root = options.root;
    this.id = options.id ?? "host:credential-vault";
    this.durability = options.durability ?? "file";
    const durable = options.durableCredentialStore ?? "none";
    if (this.durability === "memory" && durable !== "none") {
      throw new Error(
        "host-credential-vault: " +
          JSON.stringify(durable) +
          " declares a durable credential store, but this vault was opened with " +
          "durability 'memory' — a store that does not outlive the process cannot hold " +
          "one, and the capability must not declare what the vault does not build",
      );
    }
    this.retainValues = durable === "platform-isolated";
    this.mintSource =
      options.mint ??
      ((binding: AttemptCredentialBinding): string => this.randomCredential(binding));
    this.hostStore =
      this.durability === "memory" ? HostStore.openMemory() : HostStore.openFile(this.root);
    if (this.retainValues) this.loadRetained();
  }

  /**
   * Open one vault over `root`. With `durability: "file"` the directory is
   * created when absent (0700) and the store is opened; a store this build
   * cannot read is REFUSED (never silently treated as empty, which would strand
   * every in-flight attempt it holds).
   */
  static open(options: HostCredentialVaultOptions): HostCredentialVault {
    return new HostCredentialVault(options);
  }

  /**
   * Mint one credential for `binding` and store it, returning the credential
   * for the one channel that delivers it. This is an
   * `AttemptCredentialSource`: a host that wants the vault to own minting
   * passes it as the runtime's `mintCredential`.
   */
  readonly mint = (binding: AttemptCredentialBinding): string => {
    const credential = this.mintSource(binding);
    if (!isAttemptCredential(credential)) {
      throw new Error(
        "host-credential-vault: the configured mint source produced no usable credential " +
          "for attempt " +
          JSON.stringify(binding.attemptId),
      );
    }
    this.remember(
      { graphId: binding.graphId, nodeId: binding.nodeId, attemptId: binding.attemptId },
      credential,
    );
    return credential;
  };

  /**
   * Adopt one already-minted credential for the attempt it is bound to.
   *
   * Called by the runtime the moment a credential is minted — BEFORE the state
   * recording its digest is committed — so the vault holds it for every attempt
   * the durable state can ever name. A value that is not a non-empty credential
   * is REFUSED: storing it would make the attempt permanently unsettleable
   * while reading as if it were deliverable.
   */
  remember(identity: CredentialStoreIdentity, credential: string): void {
    if (!isAttemptCredential(credential)) {
      throw new Error(
        "host-credential-vault: refusing to store a non-credential for attempt " +
          JSON.stringify(identity.attemptId),
      );
    }
    this.entries.set(entryKey(identity), credential);
    this.hostStore.run(
      `INSERT INTO ${HOST_CREDENTIAL_TABLE}
         (graph_id, node_id, attempt_id, retention, credential, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (graph_id, node_id, attempt_id) DO UPDATE SET
         retention = excluded.retention,
         credential = excluded.credential,
         updated_at = excluded.updated_at`,
      identity.graphId,
      identity.nodeId,
      identity.attemptId,
      this.retainValues ? "retained" : "not-retained",
      this.retainValues ? credential : null,
      Date.now(),
    );
  }

  /**
   * The credential this vault holds for exactly that attempt, or `undefined`.
   * The runtime reports an effect it cannot resolve instead of launching it.
   */
  resolve(identity: CredentialStoreIdentity): string | undefined {
    return this.entries.get(entryKey(identity));
  }

  /** Whether this vault holds a credential for exactly that attempt. */
  has(identity: CredentialStoreIdentity): boolean {
    return this.entries.has(entryKey(identity));
  }

  /**
   * What the durable store records for one attempt: `"retained"` (the value is
   * on disk), `"not-retained"` (the attempt is recorded, the value is not), or
   * `undefined` (no record at all).
   *
   * This is a DIAGNOSTIC: it lets a recovery or a report say "the credential
   * was not retained" instead of the different claim "no such attempt", and it
   * never returns the value.
   */
  durableRecord(
    identity: CredentialStoreIdentity,
  ): "retained" | "not-retained" | undefined {
    const row = this.hostStore.get(
      `SELECT retention FROM ${HOST_CREDENTIAL_TABLE}
       WHERE graph_id = ? AND node_id = ? AND attempt_id = ?`,
      identity.graphId,
      identity.nodeId,
      identity.attemptId,
    );
    const retention = row?.["retention"];
    return retention === "retained" || retention === "not-retained"
      ? retention
      : undefined;
  }

  /**
   * Drop one attempt's credential and its durable record. Idempotent: a record
   * with no in-memory value (a non-retained row from an earlier process) is
   * deleted too.
   */
  forget(identity: CredentialStoreIdentity): void {
    this.entries.delete(entryKey(identity));
    this.hostStore.run(
      `DELETE FROM ${HOST_CREDENTIAL_TABLE} WHERE graph_id = ? AND node_id = ? AND attempt_id = ?`,
      identity.graphId,
      identity.nodeId,
      identity.attemptId,
    );
  }

  /**
   * How many credentials this vault can resolve. A COUNT, never a listing: no
   * API of this class hands out more than one credential, and only for the
   * attempt it was issued for.
   */
  get size(): number {
    return this.entries.size;
  }

  /** The vault directory this capability declares as its store root. */
  get storeRoot(): string {
    return this.root;
  }

  /**
   * The store half the runtime adopts credentials through
   * (`CredentialIsolationStore`). Bound methods, so a runtime can hold it
   * without holding the vault's other capabilities — the interface is exactly
   * `{ remember, resolve }`.
   */
  get store(): CredentialIsolationStore {
    return Object.freeze({
      remember: (identity: CredentialStoreIdentity, credential: string): void =>
        this.remember(identity, credential),
      resolve: (identity: CredentialStoreIdentity): string | undefined =>
        this.resolve(identity),
    });
  }

  /**
   * The version-3 credential-isolation capability this vault backs: the
   * declaration of what THIS BUILD enforces (digest-only persisted state,
   * per-attempt delivery) plus the honest statement of what the durable store
   * holds.
   *
   * `durableCredentialStore` is the one part this build cannot enforce. It is
   * `"none"` by default — nothing durable holds a value — and
   * `"platform-isolated"` only when the host opted in and asserted the
   * platform boundary in {@link HostCredentialVaultOptions}. No value here
   * claims a protection no one can check.
   */
  capability(): CredentialIsolationAdapterV3 {
    return Object.freeze({
      version: CREDENTIAL_ISOLATION_VERSION_V3,
      id: this.id,
      credentialStoreRoot: this.root,
      guarantees: Object.freeze({
        digestOnlyPersistedState: true as const,
        perAttemptDelivery: true as const,
      }),
      durableCredentialStore: this.retainValues
        ? ("platform-isolated" as const)
        : ("none" as const),
      store: this.store,
    });
  }

  /** Close the store connection. Idempotent. */
  close(): void {
    this.hostStore.close();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** The platform CSPRNG, hex-encoded — never derived from the attempt. */
  private randomCredential(_binding: AttemptCredentialBinding): string {
    return randomBytes(ATTEMPT_CREDENTIAL_BYTES).toString("hex");
  }

  /**
   * Read every RETAINED credential back into memory. A row whose value is not a
   * usable credential is refused as a whole rather than dropped: an attempt
   * silently missing from the vault is exactly the state a recovery must not
   * see.
   */
  private loadRetained(): void {
    const rows = this.hostStore.all(
      `SELECT graph_id, node_id, attempt_id, credential FROM ${HOST_CREDENTIAL_TABLE}
       WHERE retention = 'retained'`,
    );
    for (const row of rows) {
      const graphId = row["graph_id"];
      const nodeId = row["node_id"];
      const attemptId = row["attempt_id"];
      const credential = row["credential"];
      if (
        typeof graphId !== "string" ||
        typeof nodeId !== "string" ||
        typeof attemptId !== "string" ||
        !isAttemptCredential(credential)
      ) {
        throw new Error(
          "host-credential-vault: the store holds a retained entry this build cannot read " +
            "(graph " +
            JSON.stringify(graphId) +
            ", node " +
            JSON.stringify(nodeId) +
            ", attempt " +
            JSON.stringify(attemptId) +
            ") — refusing the whole store rather than dropping one attempt's credential",
        );
      }
      this.entries.set(entryKey({ graphId, nodeId, attemptId }), credential);
    }
  }
}

// ── Primitives ──────────────────────────────────────────────────────────────

/** The vault's map key: the runtime's own attempt identity, joined unambiguously. */
function entryKey(identity: CredentialStoreIdentity): string {
  return identity.graphId + "\u0000" + identity.nodeId + "\u0000" + identity.attemptId;
}
