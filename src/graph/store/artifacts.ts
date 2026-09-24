/**
 * Graph persistence — the immutable, content-addressed artifact store
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * WHY THIS EXISTS (§3.1, P4 item 5 / A17).
 *
 * An acceptance gate reads the bytes a reference names and digests them. That
 * proves "at validation time, this reference named these bytes" — and nothing
 * more. The moment the path is read again it may name DIFFERENT bytes, which is
 * the "validated A, consumed B" defect: a plan whose gate passed against A would
 * deliver B to everything downstream.
 *
 * Re-digesting the path before consumption does not fix it. The only thing that
 * fixes it is RETAINING the bytes under an identity derived from the bytes
 * themselves, and making the accepted result name that identity. So:
 *
 * - `putArtifact` deposits the exact bytes that were read and returns their
 *   content identity — `sha256:<hex>`. The identity IS the content, so a second
 *   deposit of the same bytes is the same object and writing it again is a
 *   no-op; there is no version, no overwrite and no way for one deposit to
 *   change what an earlier one meant;
 * - `readArtifactById` reads that object and VERIFIES the digest before
 *   returning it. A tampered or truncated object is a problem, never a
 *   silently-returned payload;
 * - neither function reads the mutable path a proposal named. The path is
 *   provenance, recorded for the operator; the identity is the contract.
 *
 * SQLITE REMAINS THE AUTHORITY FOR WHICH REVISION WAS ACCEPTED. This module
 * stores bytes and knows nothing about graphs, attempts or acceptance: the
 * accepted result row is what says "this attempt was accepted against this
 * artifact identity". Losing this store loses the bytes, never the decision,
 * and a decision whose object is missing is a refusal — not a fallback to
 * whatever the path holds now.
 *
 * Dependency leaf: node:crypto / node:fs and nothing from the graph domain, so
 * the validator layer, the acceptance core and the query surfaces may all use
 * it without a cycle.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The directory holding retained artifacts, under the graph store root. */
export const ARTIFACT_STORE_DIR = "artifacts";

/**
 * One retained artifact, named by its content.
 *
 * `ref` is the reference the proposal declared — PROVENANCE, for an operator
 * reading the record, never a path a consumer resolves again.
 */
export interface RetainedArtifact {
  /** The reference exactly as the proposal declared it. */
  readonly ref: string;
  /** The content identity: `sha256:<hex>`. What an accepted result names. */
  readonly artifactId: string;
  /** The SHA-256 hex of the retained bytes. */
  readonly digest: string;
  /** The retained byte length. */
  readonly size: number;
}

/** What one artifact object deposit produced. */
export interface ArtifactDeposit {
  readonly artifactId: string;
  readonly digest: string;
  readonly size: number;
}

/** The verdict of reading one retained artifact. */
export type ArtifactObjectRead =
  | { readonly kind: "read"; readonly bytes: Buffer; readonly digest: string }
  | { readonly kind: "problem"; readonly reason: string };

/** The content identity of a digest: what a consumer stores and names. */
export function artifactIdOf(digest: string): string {
  return "sha256:" + digest;
}

/** Whether a string is one of this store's content identities (shape only). */
export function isArtifactId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("sha256:") &&
    /^[0-9a-f]{64}$/.test(value.slice("sha256:".length))
  );
}

/** The SHA-256 hex of one byte range. */
export function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The absolute path of one retained object. */
export function artifactObjectPath(root: string, artifactId: string): string {
  return join(root, ARTIFACT_STORE_DIR, artifactId.slice("sha256:".length));
}

/**
 * Deposit bytes and answer their content identity.
 *
 * IDEMPOTENT BY CONSTRUCTION: the identity is the digest, so depositing the same
 * bytes twice writes the same path with the same content. The write is atomic
 * enough for this store's purpose — an object is only ever readable through
 * `readArtifactById`, which verifies the digest, so a half-written file is a
 * problem rather than a wrong answer.
 */
export function putArtifact(root: string, bytes: Buffer): ArtifactDeposit {
  const digest = digestOf(bytes);
  const artifactId = artifactIdOf(digest);
  const directory = join(root, ARTIFACT_STORE_DIR);
  mkdirSync(directory, { recursive: true });
  writeFileSync(artifactObjectPath(root, artifactId), bytes);
  return Object.freeze({ artifactId, digest, size: bytes.length });
}

/**
 * Read one retained object, verifying that its bytes still hash to the identity
 * it is stored under.
 *
 * A missing object and a tampered object are DIFFERENT problems with the same
 * consequence for a consumer: neither may be replaced by reading the mutable
 * path the record's `ref` names. The caller refuses.
 */
export function readArtifactById(
  root: string,
  artifactId: unknown,
): ArtifactObjectRead {
  if (!isArtifactId(artifactId)) {
    return {
      kind: "problem",
      reason:
        "artifact identity " +
        JSON.stringify(artifactId) +
        " is not a sha256 content identity — a retained artifact is named by its content and by nothing else",
    };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(artifactObjectPath(root, artifactId));
  } catch {
    return {
      kind: "problem",
      reason:
        "retained artifact " +
        artifactId +
        " is not present in this store — the accepted revision cannot be produced, and the reference the record carries is NOT re-read as a substitute",
    };
  }
  const digest = digestOf(bytes);
  if (artifactIdOf(digest) !== artifactId) {
    return {
      kind: "problem",
      reason:
        "retained artifact " +
        artifactId +
        " does not hash to its own identity (read " +
        artifactIdOf(digest) +
        ") — the object was altered after it was retained, so it is refused instead of returned",
    };
  }
  return { kind: "read", bytes, digest };
}
