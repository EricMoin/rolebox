import { createHash, randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

/** The object one successful deposit published. */
export interface ArtifactDeposit {
  readonly artifactId: string;
  readonly digest: string;
  readonly size: number;
}

/**
 * What depositing bytes produced: the published object, or the problem that
 * prevented publication.
 *
 * This is a result union rather than an exception on purpose. A caller that
 * cannot retain the bytes must REFUSE the acceptance that would have named
 * them — committing a revision nobody can read back is the defect the store
 * exists to prevent — so the failure has to be a value every caller handles,
 * not an exception an inattentive one can drop.
 */
export type ArtifactDepositResult =
  | ({ readonly kind: "deposited" } & ArtifactDeposit)
  | { readonly kind: "problem"; readonly reason: string };

/** The prefix of a deposit's in-flight temporary file; never a content identity. */
const TEMPORARY_PREFIX = ".deposit-";

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
 * Deposit bytes and answer the object they were published as — or the problem
 * that prevented publication.
 *
 * PUBLISH-ONCE. The bytes go to a unique temporary file in the store directory
 * and are published with an exists-refusing link, so an object an earlier
 * acceptance already named cannot be truncated or replaced by a later deposit.
 * That holds under concurrency too: the link creates the object at most once,
 * and every other depositor either reuses the object or refuses it.
 *
 * REUSE IS VERIFIED, NEVER ASSUMED. When the identity is already published, the
 * existing object is re-read and must still hash to it. An object that does not
 * verify is a named problem and is NOT overwritten and NOT repaired: it may be
 * what an accepted result already means, and replacing it would change that
 * meaning without anyone deciding to.
 */
export function putArtifact(root: string, bytes: Buffer): ArtifactDepositResult {
  const digest = digestOf(bytes);
  const artifactId = artifactIdOf(digest);
  const directory = join(root, ARTIFACT_STORE_DIR);
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    return {
      kind: "problem",
      reason:
        "the artifact store directory " +
        JSON.stringify(directory) +
        " could not be created (" +
        errorText(error) +
        "), so " +
        artifactId +
        " was not deposited",
    };
  }
  const temporaryPath = join(
    directory,
    TEMPORARY_PREFIX + randomBytes(16).toString("hex"),
  );
  try {
    // `wx` refuses a collision instead of truncating whatever holds the name.
    writeFileSync(temporaryPath, bytes, { flag: "wx" });
  } catch (error) {
    return {
      kind: "problem",
      reason:
        "the bytes of " +
        artifactId +
        " could not be written to a temporary file in the store (" +
        errorText(error) +
        "), so nothing was published",
    };
  }
  try {
    linkSync(temporaryPath, artifactObjectPath(root, artifactId));
    return Object.freeze({ kind: "deposited", artifactId, digest, size: bytes.length });
  } catch (error) {
    if (!isAlreadyPublished(error)) {
      return {
        kind: "problem",
        reason:
          artifactId +
          " could not be published (" +
          errorText(error) +
          ") — the temporary file was discarded and any existing object was left untouched",
      };
    }
  } finally {
    // Runs for every exit above: a temporary is never an object.
    discardTemporary(temporaryPath);
  }
  const existing = readArtifactById(root, artifactId);
  if (existing.kind !== "read") {
    return {
      kind: "problem",
      reason:
        artifactId +
        " is already published, but the existing object does not verify (" +
        existing.reason +
        ") — a deposit never overwrites an object an accepted result may already name, and never repairs it in place",
    };
  }
  return Object.freeze({
    kind: "deposited",
    artifactId,
    digest: existing.digest,
    size: existing.bytes.length,
  });
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

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Whether a link failure means the identity is already published. */
function isAlreadyPublished(error: unknown): boolean {
  return errorCodeOf(error) === "EEXIST";
}

/** The `code` of a system error, without assuming the value is one. */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code: unknown = error.code;
  return typeof code === "string" ? code : undefined;
}

/** Remove one deposit's temporary file; nothing published ever names it. */
function discardTemporary(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // The temporary is already gone; it was never readable as an object.
  }
}

/** The message of a caught value, without assuming it is an Error. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
