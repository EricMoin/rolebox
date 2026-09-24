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
import { GraphStore } from "../store/graph-store.ts";
import { GRAPH_STORE_TABLES } from "../store/schema.ts";

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
  /**
   * An ALREADY OPEN workspace store to share.
   *
   * Omitted (the default), the vault opens its own connection to `root` — or a
   * private in-memory store for `durability: "memory"`. A host that assembles
   * several capabilities passes ONE store so all of them address one database
   * and one transaction boundary even in memory mode.
   */
  readonly store?: GraphStore;
}

/**
 * The credential table this vault writes, as the STORE names it. Exported
 * because a reader of the host layer may want the durable name; the vault
 * addresses it through the store, so the name has one definition.
 */
export const HOST_CREDENTIAL_TABLE = GRAPH_STORE_TABLES.credentials;

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
  private readonly graphStore: GraphStore;

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
    this.graphStore =
      options.store ??
      (this.durability === "memory"
        ? GraphStore.openMemory()
        : GraphStore.openFile(this.root));
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
    this.graphStore.rememberCredential(
      identity,
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
    return this.graphStore.readCredentialRetention(identity);
  }

  /**
   * Drop one attempt's credential and its durable record. Idempotent: a record
   * with no in-memory value (a non-retained row from an earlier process) is
   * deleted too.
   */
  forget(identity: CredentialStoreIdentity): void {
    this.entries.delete(entryKey(identity));
    this.graphStore.forgetCredential(identity);
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
    this.graphStore.close();
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
    const retained = this.graphStore.retainedCredentials();
    for (const entry of retained) {
      if (!isAttemptCredential(entry.credential)) {
        throw new Error(
          "host-credential-vault: the store holds a retained entry this build cannot read " +
          "(graph " +
          JSON.stringify(entry.identity.graphId) +
          ", node " +
          JSON.stringify(entry.identity.nodeId) +
          ", attempt " +
          JSON.stringify(entry.identity.attemptId) +
          ") — refusing the whole store rather than dropping one attempt's credential",
        );
      }
      this.entries.set(entryKey(entry.identity), entry.credential);
    }
  }
}

// ── Primitives ──────────────────────────────────────────────────────────────

/** The vault's map key: the runtime's own attempt identity, joined unambiguously. */
function entryKey(identity: CredentialStoreIdentity): string {
  return identity.graphId + "\u0000" + identity.nodeId + "\u0000" + identity.attemptId;
}