/**
 * Graph Execution Engine v2 — the host's attempt-credential vault
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * THE STORE HALF OF THE CREDENTIAL-ISOLATION CAPABILITY
 * (`src/graph/outcome/credential-isolation.ts`, D7). The outcome runtime
 * persists only the DIGEST of an attempt credential in the acceptance ledger
 * (state-body version 8, `attempt-credential.ts`), so this host module is the
 * one place the credential ITSELF lives — and the only place a recovery can
 * obtain one from.
 *
 * WHAT IT ACTUALLY PROTECTS, AND WHAT IT DOES NOT.
 *
 * - The AUTHORITATIVE copy is in this process's memory. Nothing writes it into
 *   a report, a log line, an effect payload, a graph-state entry or a status
 *   surface: the credential crosses exactly one boundary, the dispatch request
 *   the runtime hands to the host that delivers it (`OutcomeDispatchRequest`).
 * - The DURABLE copy is a separate file under `root`, written atomically with
 *   mode 0600 in a directory created with mode 0700. It is deliberately NOT the
 *   acceptance ledger: every surface that reads the ledger (reports, the drain
 *   audit, the startup sweep, a dispatched worker with file tools) sees only
 *   digests, so the ledger is no longer a credential store at all.
 * - THIS IS NOT FILESYSTEM ISOLATION, AND THIS MODULE DOES NOT CLAIM IT. A
 *   same-account process that can read the mirror file can read the
 *   credentials in it — no mode bit, path or mount option changes what another
 *   process of the same account can read, and this module inspects none of
 *   them. The honest forms of isolation are the platform's: a different OS
 *   account, a container or mount namespace the worker is not in, or the
 *   memory-only mode below.
 * - `durability: "memory"` keeps the authoritative copy in this process only:
 *   nothing durable holds a credential at all, at the cost that an attempt
 *   whose host process died can no longer be re-delivered (the runtime REPORTS
 *   the effect as unsettled rather than inventing a credential). Use it when
 *   the platform cannot give the host a root that dispatched workers cannot
 *   read.
 *
 * THE BINDING IS THE KEY. Every entry is addressed by
 * `(graphId, nodeId, attemptId)` — the runtime's own attempt identity — so a
 * credential can only ever be resolved for the exact attempt it was issued for.
 * The ledger's digest and this store's exact-attempt lookup are two independent
 * halves of the same binding: neither can re-aim a credential at another
 * attempt, and neither can fabricate one for an attempt that was never issued
 * one.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AttemptCredentialBinding,
  AttemptCredentialSource,
} from "../outcome/attempt-credential.ts";
import {
  ATTEMPT_CREDENTIAL_BYTES,
  isAttemptCredential,
} from "../outcome/attempt-credential.ts";
import type {
  CredentialIsolationAdapterV2,
  CredentialIsolationStore,
  CredentialStoreIdentity,
} from "../outcome/credential-isolation.ts";
import { CREDENTIAL_ISOLATION_VERSION_V2 } from "../outcome/credential-isolation.ts";

// ── Options and identity ────────────────────────────────────────────────────

/** How long a credential survives the process that minted it. */
export type HostCredentialDurability =
  /**
   * Process memory plus a separate `0600` mirror file under `root` (the
   * default): a restarted host can still re-deliver an in-flight attempt, and
   * the mirror's confidentiality is the host platform's to provide.
   */
  | "file"
  /**
   * Process memory only. Nothing durable holds a credential; a restart loses
   * every in-flight one and the runtime reports those effects as unsettled
   * instead of re-delivering them.
   */
  | "memory";

/** Inputs to {@link HostCredentialVault.open}. */
export interface HostCredentialVaultOptions {
  /**
   * The host-owned directory the vault's mirror file lives in. It is created
   * (0700) when absent and is NEVER the workspace by default: pass a host
   * directory the deployed workers are not given a path to.
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
   * The minting source. Defaults to the platform CSPRNG
   * ({@link RUNTIME_ATTEMPT_CREDENTIAL_SOURCE}) — the vault mints and stores in
   * one step, so a credential never exists outside the vault between minting
   * and delivery.
   */
  readonly mint?: AttemptCredentialSource;
}

/** The mirror file's name inside {@link HostCredentialVaultOptions.root}. */
export const HOST_CREDENTIAL_MIRROR_FILE = "host-attempt-credentials.json" as const;

/** The mirror file's own format version, refused rather than read approximately. */
export const HOST_CREDENTIAL_MIRROR_VERSION = 1 as const;

// ── The vault ───────────────────────────────────────────────────────────────

/**
 * The host's real credential store: process memory as the authority, with an
 * optional separate-file mirror for restart recovery.
 */
export class HostCredentialVault {
  private readonly root: string;
  private readonly id: string;
  private readonly durability: HostCredentialDurability;
  private readonly mintSource: AttemptCredentialSource;
  private readonly entries = new Map<string, string>();
  private readonly mirrorPath: string;

  private constructor(options: HostCredentialVaultOptions) {
    this.root = options.root;
    this.id = options.id ?? "host:credential-vault";
    this.durability = options.durability ?? "file";
    this.mintSource =
      options.mint ??
      ((binding: AttemptCredentialBinding): string => this.randomCredential(binding));
    this.mirrorPath = join(this.root, HOST_CREDENTIAL_MIRROR_FILE);
    if (this.durability === "file") this.load();
  }

  /**
   * Open one vault over `root`. With `durability: "file"` the directory is
   * created when absent (0700) and the mirror file is read when present; a
   * mirror this build cannot read is REFUSED (never silently treated as empty,
   * which would strand every in-flight attempt it holds).
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
    if (this.durability === "file") this.persist();
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

  /** Drop one attempt's credential (a settled or abandoned attempt). */
  forget(identity: CredentialStoreIdentity): void {
    if (!this.entries.delete(entryKey(identity))) return;
    if (this.durability === "file") this.persist();
  }

  /**
   * How many credentials the vault holds. A COUNT, never a listing: no API of
   * this class hands out more than one credential, and only for the attempt it
   * was issued for.
   */
  get size(): number {
    return this.entries.size;
  }

  /** The vault directory this capability declares as its protected store root. */
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
   * The version-2 credential-isolation capability this vault backs: the
   * declaration (a protected store root, both guarantees) plus {@link store}.
   *
   * The GUARANTEES ARE THE DEPLOYMENT'S, NOT THIS MODULE'S, and the doc header
   * is explicit about which parts this build can keep: the ledger holds no
   * usable credential (structural), the mirror is a separate 0600 file
   * (structural), and whether dispatched workers can read that file is a
   * property of the host's platform that no value here can attest.
   */
  capability(): CredentialIsolationAdapterV2 {
    return Object.freeze({
      version: CREDENTIAL_ISOLATION_VERSION_V2,
      id: this.id,
      credentialStoreRoot: this.root,
      guarantees: Object.freeze({
        protectedCredentialStore: true as const,
        perAttemptDelivery: true as const,
      }),
      store: this.store,
    });
  }

  /** Remove the mirror file (tests and explicit teardown). Memory is untouched. */
  removeMirror(): void {
    if (existsSync(this.mirrorPath)) rmSync(this.mirrorPath, { force: true });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** The platform CSPRNG, hex-encoded — never derived from the attempt. */
  private randomCredential(_binding: AttemptCredentialBinding): string {
    return randomBytes(ATTEMPT_CREDENTIAL_BYTES).toString("hex");
  }

  /** Read the mirror file, refusing a shape this build cannot read. */
  private load(): void {
    if (!existsSync(this.mirrorPath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.mirrorPath, "utf8"));
    } catch (error) {
      throw new Error(
        "host-credential-vault: the mirror file " +
          JSON.stringify(this.mirrorPath) +
          " is not readable JSON (" +
          (error instanceof Error ? error.message : String(error)) +
          ") — refusing to open the vault as if it were empty, because every attempt it " +
          "holds would otherwise become undeliverable",
      );
    }
    if (!isRecord(parsed) || parsed.version !== HOST_CREDENTIAL_MIRROR_VERSION) {
      throw new Error(
        "host-credential-vault: the mirror file " +
          JSON.stringify(this.mirrorPath) +
          " does not declare format version " +
          HOST_CREDENTIAL_MIRROR_VERSION +
          " — refusing to read it approximately",
      );
    }
    if (!Array.isArray(parsed.entries)) {
      throw new Error(
        "host-credential-vault: the mirror file " +
          JSON.stringify(this.mirrorPath) +
          " carries no entries list",
      );
    }
    for (const entry of parsed.entries) {
      if (
        !isRecord(entry) ||
        typeof entry.graphId !== "string" ||
        typeof entry.nodeId !== "string" ||
        typeof entry.attemptId !== "string" ||
        !isAttemptCredential(entry.credential)
      ) {
        throw new Error(
          "host-credential-vault: the mirror file " +
            JSON.stringify(this.mirrorPath) +
            " carries an entry this build cannot read — refusing the whole file rather " +
            "than dropping one attempt's credential",
        );
      }
      this.entries.set(
        entryKey({
          graphId: entry.graphId,
          nodeId: entry.nodeId,
          attemptId: entry.attemptId,
        }),
        entry.credential,
      );
    }
  }

  /**
   * Write the mirror atomically (temp file, then rename) with mode 0600, so a
   * reader never sees a half-written store and the file is not group- or
   * world-readable.
   */
  private persist(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const entries = [...this.entries.entries()].map(([key, credential]) => {
      const [graphId, nodeId, attemptId] = key.split("\u0000");
      return { graphId, nodeId, attemptId, credential };
    });
    const text = JSON.stringify(
      { version: HOST_CREDENTIAL_MIRROR_VERSION, entries },
      null,
      2,
    );
    const temporary = this.mirrorPath + "." + process.pid + ".tmp";
    writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.mirrorPath);
  }
}

// ── Primitives ──────────────────────────────────────────────────────────────

/** The vault's map key: the runtime's own attempt identity, joined unambiguously. */
function entryKey(identity: CredentialStoreIdentity): string {
  return identity.graphId + "\u0000" + identity.nodeId + "\u0000" + identity.attemptId;
}

/** Whether a value is a plain, non-array record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
