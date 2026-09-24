/**
 * Graph Execution Engine v2 — the worker-facing input view (D7)
 *
 * Version: 1.0
 * Date: 2026-09-24
 *
 * WHY A CONTENT IDENTITY IS NOT DELIVERY. A resolved input (`inputs.ts`) names
 * the producing node, its accepted outcome, the producing attempt, the accepted
 * data and the retained content identities. Handing a worker those identities is
 * an instruction to go and find the bytes somewhere — and the worker has no
 * store, no entry in the ledger and no access to the path the proposal named. So
 * the dispatch hands it FILES.
 *
 * WHAT IS MATERIALIZED, AND FROM WHERE. For every retained revision this module
 * reads the object from the CONTENT STORE by its identity — never the mutable
 * path the proposal named, which by dispatch time may hold a different revision
 * — verifies that the bytes still hash to the identity the acceptance recorded,
 * and publishes an INDEPENDENT copy in the consumer's own directory. The copy is
 * independent on purpose: a hard link would make a worker's own write reach the
 * store's object, and what an already-accepted result means must not depend on
 * what a worker does with its copy of it.
 *
 * ISOLATION IS STRUCTURAL. The directory is derived from the graph and the
 * CONSUMER ATTEMPT, so two consumers never share one and a view names only files
 * inside its own; the file names are the content identity, so re-delivering the
 * same dispatch (a recovery, a restart, a repeated window) finds the same names
 * and REUSES them instead of duplicating or truncating anything. A file that is
 * already there is read back and must hash to the identity: an object another
 * owner's delivery left in a bad state is a refusal, never something to
 * overwrite.
 *
 * A REFUSAL PUBLISHES NOTHING. Every object is read and verified BEFORE the
 * first file is written, so a missing object or a digest mismatch leaves no
 * partial delivery behind — the caller refuses the dispatch rather than handing a
 * worker a view with a hole in it.
 *
 * THE WORKER IS HANDED NO CAPABILITY. Nothing here returns a store handle, a
 * credential, a policy or a path outside the consumer's own directory: the view
 * is data plus the paths of the files that data was accepted with, and nothing
 * else about the host that produced it.
 *
 * Dependency leaf: node:fs / node:crypto / node:path, the content store's own
 * reader, and the domain types the view carries.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { AcceptedArtifact, AcceptedData } from "../domain/model.ts";
import type { ResolvedInput } from "../outcome/inputs.ts";
import { artifactIdOf, digestOf, readArtifactById } from "../store/artifacts.ts";

/** The directory, under a host's own root, holding per-consumer deliveries. */
export const INPUT_DELIVERY_DIR = "input-deliveries";

/** The manifest file each consumer's directory carries. */
export const INPUT_VIEW_MANIFEST_FILE = "inputs.json";

/** The manifest layout version. */
export const INPUT_VIEW_VERSION = 1;

/** The prefix of a delivery's in-flight temporary file; never a delivered file. */
const TEMPORARY_PREFIX = ".publish-";

/** The mode of one consumer's own directory: readable by its owner alone. */
const CONSUMER_DIRECTORY_MODE = 0o700;

/** The mode of one delivered copy. */
const DELIVERED_FILE_MODE = 0o600;

// ── The view one worker receives ────────────────────────────────────────────

/**
 * One retained revision, materialized as a real file inside the consumer's own
 * directory.
 *
 * `path` is ABSOLUTE and names the copy the worker reads; `file` is the same
 * copy's name inside the consumer's directory, which is what the manifest
 * records so the manifest stays readable after the tree is moved.
 */
export interface DeliveredInputFile {
  /** The reference the producing proposal declared. */
  readonly ref: string;
  /** The content identity the acceptance retained it under (`sha256:<hex>`). */
  readonly artifactId: string;
  /** The SHA-256 hex of the delivered bytes, verified before the view is returned. */
  readonly digest: string;
  /** The delivered byte length. */
  readonly size: number;
  /** The copy's name inside the consumer's directory. */
  readonly file: string;
  /** The copy's absolute path. */
  readonly path: string;
}

/** One accepted upstream result, with its retained revisions as real files. */
export interface DeliveredInput {
  readonly from: string;
  readonly outcome: string;
  readonly attemptId: string;
  /** The accepted data, with D1's presence distinction intact. */
  readonly payload: AcceptedData;
  readonly artifacts: readonly DeliveredInputFile[];
}

/**
 * The minimal view one worker is handed: what an attempt consumes, and where the
 * files it was accepted with are.
 */
export interface DeliveredInputView {
  /** The consumer's own directory — the only place its files live. */
  readonly directory: string;
  /** The manifest naming the same view, inside {@link DeliveredInputView.directory}. */
  readonly manifestPath: string;
  readonly entries: readonly DeliveredInput[];
}

/** Where a host's retained objects live and where deliveries are published. */
export interface InputDeliveryLocation {
  /**
   * The root the RETAINED CONTENT objects were deposited under — the `putArtifact`
   * root the acceptance gate wrote to. Deliberately separate from the root
   * evidence REFERENCES resolve inside: those are paths the proposal named, this
   * is the immutable store of what was accepted.
   */
  readonly contentStoreRoot: string;
  /** Where each consumer's isolated directory is created. */
  readonly deliveryRoot: string;
}

// ── Refusals ────────────────────────────────────────────────────────────────

/**
 * The refusal codes this build defines, in canonical order — the ONE source a
 * reader and a writer share, so a persisted or reported refusal is validated
 * against the same closed vocabulary the materializer produces.
 */
export const INPUT_DELIVERY_REFUSAL_CODES = Object.freeze([
  /** The host has no content-store/delivery location to materialize into. */
  "input-delivery-unavailable",
  /** The retained object is missing, or the store refuses its own read. */
  "input-artifact-unreadable",
  /** The accepted record and the object it names do not describe one revision. */
  "input-artifact-record-mismatch",
  /** The consumer's copy could not be published, or an existing one does not verify. */
  "input-view-not-published",
] as const);

/** One named reason an input could not be delivered as files. */
export type InputDeliveryRefusalCode = (typeof INPUT_DELIVERY_REFUSAL_CODES)[number];

/**
 * Why one input (or one dispatch) could not be materialized.
 *
 * The producer/outcome are present whenever the refusal is about a declared
 * input, and the reference/identity whenever it is about one retained revision:
 * a refusal names what it is about, and a caller reading only the codes still
 * knows which input to look at.
 */
export interface InputDeliveryRefusal {
  readonly code: InputDeliveryRefusalCode;
  /** The producing node, when the refusal names one declared input. */
  readonly from?: string;
  /** The accepted outcome the input pinned, when the refusal names one input. */
  readonly outcome?: string;
  /** The reference whose revision could not be delivered. */
  readonly ref?: string;
  /** The content identity whose revision could not be delivered. */
  readonly artifactId?: string;
  readonly message: string;
}

/** What materializing one attempt's inputs produced. */
export type InputViewMaterialization =
  | { readonly kind: "ready"; readonly view: DeliveredInputView }
  | { readonly kind: "refused"; readonly refusals: readonly InputDeliveryRefusal[] };

/**
 * The synchronous refusal a dispatch raises instead of launching with a hole.
 *
 * A STRUCTURED value, not a bare throw: the refusals travel with the error so
 * the caller that owns the dispatch (the host adapter's create path) can report
 * every offending input rather than the first one, and each one names the input
 * and the reason it could not be delivered.
 */
export class InputViewRefusalError extends Error {
  readonly refusals: readonly InputDeliveryRefusal[];

  constructor(refusals: readonly InputDeliveryRefusal[]) {
    super(
      "graph input delivery: this dispatch was NOT launched, because " +
        String(refusals.length) +
        " of its inputs could not be materialized as files: " +
        refusals
          .map(
            (refusal) =>
              refusal.code +
              " " +
              describeInputOf(refusal) +
              " — " +
              refusal.message,
          )
          .join("; "),
    );
    this.name = "InputViewRefusalError";
    this.refusals = Object.freeze([...refusals]);
  }
}

// ── Materialization ─────────────────────────────────────────────────────────

/** Inputs to {@link materializeInputView}. */
export interface MaterializeInputViewOptions extends InputDeliveryLocation {
  readonly graphId: string;
  readonly attemptId: string;
  /** The bound view the attempt was armed with. */
  readonly inputs: readonly ResolvedInput[];
}

/**
 * The directory ONE consumer's files live in.
 *
 * The token is the readable identity plus a digest of the FULL value, so two
 * identities that sanitize to the same text (a node named `a/b` and one named
 * `a_b`) still get different directories: sanitizing alone would let one
 * consumer's files appear inside another's.
 */
export function inputConsumerDirectory(
  deliveryRoot: string,
  graphId: string,
  attemptId: string,
): string {
  return join(deliveryRoot, consumerToken(graphId), consumerToken(attemptId));
}

/**
 * Materialize one attempt's bound inputs as real files, or refuse the dispatch.
 *
 * TOTAL: every way an input can fail to become a file is a named refusal, and
 * ANY refusal refuses the whole view — a worker is never handed a partial set of
 * the inputs its node declared.
 */
export function materializeInputView(
  options: MaterializeInputViewOptions,
): InputViewMaterialization {
  const directory = inputConsumerDirectory(
    options.deliveryRoot,
    options.graphId,
    options.attemptId,
  );
  const manifestPath = join(directory, INPUT_VIEW_MANIFEST_FILE);
  if (options.inputs.length === 0) {
    // "This attempt consumes nothing" is a view with no files and no directory:
    // nothing was retained, so there is nothing to publish.
    return {
      kind: "ready",
      view: Object.freeze({
        directory,
        manifestPath,
        entries: Object.freeze([]),
      }),
    };
  }
  const refusals: InputDeliveryRefusal[] = [];
  const staged: StagedEntry[] = [];
  // PHASE 1 — READ AND VERIFY EVERY OBJECT, BEFORE ANYTHING IS WRITTEN. A
  // refusal here leaves the consumer's directory untouched, which is what makes
  // "no partial delivery" true rather than hoped for.
  for (const input of options.inputs) {
    const files: StagedFile[] = [];
    for (const artifact of input.artifacts) {
      const read = readArtifactById(options.contentStoreRoot, artifact.artifactId);
      if (read.kind !== "read") {
        refusals.push(
          refusalOf(input, artifact, "input-artifact-unreadable",
            "the retained revision of reference " +
              JSON.stringify(artifact.ref) +
              " could not be produced from the content store (" +
              read.reason +
              ") — the path the reference named is NOT re-read as a substitute, and a view " +
              "missing the bytes the acceptance retained is not delivered"),
        );
        continue;
      }
      if (
        artifactIdOf(read.digest) !== artifact.artifactId ||
        read.digest !== artifact.digest ||
        read.bytes.length !== artifact.size
      ) {
        refusals.push(
          refusalOf(input, artifact, "input-artifact-record-mismatch",
            "the accepted record names digest " +
              artifact.digest +
              " at " +
              String(artifact.size) +
              " bytes, but the object it names reads back as " +
              artifactIdOf(read.digest) +
              " at " +
              String(read.bytes.length) +
              " bytes — a record and an object that disagree do not describe one revision, " +
              "so neither is delivered"),
        );
        continue;
      }
      files.push(
        Object.freeze({
          artifact,
          bytes: read.bytes,
          file: deliveredFileName(read.digest, artifact.ref),
        }),
      );
    }
    staged.push(Object.freeze({ input, files }));
  }
  if (refusals.length > 0) {
    return { kind: "refused", refusals: Object.freeze(refusals) };
  }
  // PHASE 2 — PUBLISH. The directory is created only now, so a refusal above
  // leaves no trace of a delivery that never happened.
  const created = ensureConsumerDirectory(directory);
  if (!created.ok) {
    return {
      kind: "refused",
      refusals: Object.freeze(
        staged.map((entry) => wholeViewRefusal(entry.input, "input-view-not-published", created.reason)),
      ),
    };
  }
  const publishRefusals: InputDeliveryRefusal[] = [];
  const entries: DeliveredInput[] = [];
  for (const entry of staged) {
    const artifacts: DeliveredInputFile[] = [];
    for (const file of entry.files) {
      const published = publishDeliveredFile(
        directory,
        file.file,
        file.bytes,
        file.artifact.digest,
      );
      if (!published.ok) {
        publishRefusals.push(
          refusalOf(entry.input, file.artifact, "input-view-not-published",
            published.reason +
              " — this attempt's view is refused whole rather than delivered with a file it " +
              "cannot read back"),
        );
        continue;
      }
      artifacts.push(
        Object.freeze({
          ref: file.artifact.ref,
          artifactId: file.artifact.artifactId,
          digest: file.artifact.digest,
          size: file.artifact.size,
          file: file.file,
          path: join(directory, file.file),
        }),
      );
    }
    entries.push(
      Object.freeze({
        from: entry.input.from,
        outcome: entry.input.outcome,
        attemptId: entry.input.attemptId,
        payload: entry.input.payload,
        artifacts: Object.freeze(artifacts),
      }),
    );
  }
  if (publishRefusals.length > 0) {
    return { kind: "refused", refusals: Object.freeze(publishRefusals) };
  }
  const manifest = publishManifest(
    manifestPath,
    manifestText(options, Object.freeze(entries)),
  );
  if (!manifest.ok) {
    return {
      kind: "refused",
      refusals: Object.freeze(
        staged.map((entry) => wholeViewRefusal(entry.input, "input-view-not-published", manifest.reason)),
      ),
    };
  }
  return {
    kind: "ready",
    view: Object.freeze({
      directory,
      manifestPath,
      entries: Object.freeze(entries),
    }),
  };
}

// ── Publication ─────────────────────────────────────────────────────────────

/** One verified object, staged for publication. */
interface StagedEntry {
  readonly input: ResolvedInput;
  readonly files: readonly StagedFile[];
}

/** One verified revision, with its bytes and the name it will be published as. */
interface StagedFile {
  readonly artifact: AcceptedArtifact;
  readonly bytes: Buffer;
  readonly file: string;
}

/** What publishing one file established. */
type PublicationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Create one consumer's directory, owner-only.
 *
 * `recursive` also creates the graph level; the leaf is chmod-ed explicitly
 * because a created mode is masked by the process umask and the isolation this
 * directory expresses should not depend on the operator's umask.
 */
function ensureConsumerDirectory(directory: string): PublicationResult {
  try {
    mkdirSync(directory, { recursive: true, mode: CONSUMER_DIRECTORY_MODE });
    chmodSync(directory, CONSUMER_DIRECTORY_MODE);
  } catch (error) {
    return {
      ok: false,
      reason:
        "the consumer's own directory could not be created (" +
        errorText(error) +
        "), so no file was published for this attempt",
    };
  }
  return { ok: true };
}

/**
 * Publish one delivered copy, ONCE, and prove it by reading it back.
 *
 * The temporary-then-link publication is the content store's own primitive
 * (`putArtifact`): the link creates the name at most once, so two processes
 * re-delivering the same dispatch cannot truncate each other's file. When the
 * name already exists it is left EXACTLY as it is and read back: bytes that hash
 * to the identity are reused, and bytes that do not are a refusal — never an
 * overwrite, because another consumer's delivery, or a worker mid-read, may be
 * what put the file there.
 */
function publishDeliveredFile(
  directory: string,
  file: string,
  bytes: Buffer,
  digest: string,
): PublicationResult {
  const target = join(directory, file);
  const temporary = join(directory, TEMPORARY_PREFIX + randomBytes(12).toString("hex"));
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: DELIVERED_FILE_MODE });
  } catch (error) {
    return {
      ok: false,
      reason:
        "the bytes of " +
        artifactIdOf(digest) +
        " could not be written to a temporary file in the consumer's directory (" +
        errorText(error) +
        ")",
    };
  }
  let linkFailure: unknown;
  try {
    linkSync(temporary, target);
  } catch (error) {
    linkFailure = error;
  } finally {
    discardTemporary(temporary);
  }
  if (linkFailure !== undefined && !isAlreadyPublished(linkFailure)) {
    return {
      ok: false,
      reason:
        "the delivered copy " +
        JSON.stringify(file) +
        " could not be published (" +
        errorText(linkFailure) +
        ")",
    };
  }
  let onDisk: Buffer;
  try {
    onDisk = readFileSync(target);
  } catch (error) {
    return {
      ok: false,
      reason:
        "the delivered copy " +
        JSON.stringify(file) +
        " could not be read back from the consumer's directory (" +
        errorText(error) +
        ")",
    };
  }
  if (digestOf(onDisk) !== digest) {
    return {
      ok: false,
      reason:
        "the file " +
        JSON.stringify(file) +
        " already present in this consumer's directory does not hash to " +
        artifactIdOf(digest) +
        " — it is left untouched (its owner may be reading it) and this dispatch is refused " +
        "rather than handed a revision the acceptance did not retain",
    };
  }
  return { ok: true };
}

/**
 * Publish the manifest beside the copies, once, and prove it by reading it back.
 *
 * The text is derived from the same entries the view carries, so the file and the
 * in-memory view cannot disagree; a manifest already present with the SAME bytes
 * is this delivery's own (a repeated window) and is reused, and one with
 * different bytes belongs to something else and is refused.
 */
function publishManifest(path: string, text: string): PublicationResult {
  const temporary = join(dirname(path), TEMPORARY_PREFIX + randomBytes(12).toString("hex"));
  try {
    writeFileSync(temporary, text, { flag: "wx", mode: DELIVERED_FILE_MODE });
  } catch (error) {
    return {
      ok: false,
      reason:
        "the input manifest could not be written (" + errorText(error) + ")",
    };
  }
  let linkFailure: unknown;
  try {
    linkSync(temporary, path);
  } catch (error) {
    linkFailure = error;
  } finally {
    discardTemporary(temporary);
  }
  if (linkFailure !== undefined && !isAlreadyPublished(linkFailure)) {
    return {
      ok: false,
      reason:
        "the input manifest could not be published (" + errorText(linkFailure) + ")",
    };
  }
  let onDisk: string;
  try {
    onDisk = readFileSync(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      reason:
        "the input manifest could not be read back (" + errorText(error) + ")",
    };
  }
  if (onDisk !== text) {
    return {
      ok: false,
      reason:
        "the input manifest already present in this consumer's directory does not describe " +
        "this delivery — it is left untouched and this dispatch is refused",
    };
  }
  return { ok: true };
}

// ── The manifest ────────────────────────────────────────────────────────────

/** The manifest one consumer's directory carries, in a fixed field order. */
interface InputViewManifest {
  readonly version: number;
  readonly graphId: string;
  readonly attemptId: string;
  readonly inputs: readonly {
    readonly from: string;
    readonly outcome: string;
    readonly attemptId: string;
    readonly payload: AcceptedData;
    readonly artifacts: readonly {
      readonly ref: string;
      readonly artifactId: string;
      readonly digest: string;
      readonly size: number;
      readonly file: string;
    }[];
  }[];
}

/**
 * The manifest text.
 *
 * DETERMINISTIC: the same view always spells the same bytes, which is what lets
 * a repeated delivery recognize its own manifest and reuse it instead of
 * rewriting it. Paths are the copies' NAMES inside the directory, so the
 * manifest stays true if the tree is moved.
 */
function manifestText(
  options: MaterializeInputViewOptions,
  entries: readonly DeliveredInput[],
): string {
  const manifest: InputViewManifest = {
    version: INPUT_VIEW_VERSION,
    graphId: options.graphId,
    attemptId: options.attemptId,
    inputs: entries.map((entry) => ({
      from: entry.from,
      outcome: entry.outcome,
      attemptId: entry.attemptId,
      payload: entry.payload,
      artifacts: entry.artifacts.map((artifact) => ({
        ref: artifact.ref,
        artifactId: artifact.artifactId,
        digest: artifact.digest,
        size: artifact.size,
        file: artifact.file,
      })),
    })),
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}

// ── Names ───────────────────────────────────────────────────────────────────

/**
 * The directory token for one identity: readable, and unique per identity.
 *
 * A sanitized value alone is NOT unique (two different ids can collapse to one
 * text), and a shared directory is exactly the isolation this module must not
 * lose, so the digest of the raw value is part of the name.
 */
function consumerToken(value: string): string {
  const readable = value
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 48);
  const digest = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
  return readable.length > 0 ? readable + "-" + digest : digest;
}

/**
 * The name one delivered copy is published as: its content identity, plus the
 * reference's own extension when it has a harmless one.
 *
 * CONTENT-ADDRESSED, so two entries that retained the same bytes name the same
 * file and a repeated delivery can only reuse it; the extension is decoration
 * for the worker's tools and carries no part of the path the reference named.
 */
function deliveredFileName(digest: string, ref: string): string {
  return digest + extensionOf(ref);
}

/** The reference's extension, when it is a short alphanumeric one. */
function extensionOf(ref: string): string {
  const normalized = ref.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const base = slash === -1 ? normalized : normalized.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  const extension = base.slice(dot + 1);
  return /^[A-Za-z0-9]{1,12}$/.test(extension) ? "." + extension : "";
}

// ── Refusal construction ────────────────────────────────────────────────────

/** One refusal about one declared input and the revision it needed. */
function refusalOf(
  input: ResolvedInput,
  artifact: AcceptedArtifact,
  code: InputDeliveryRefusalCode,
  message: string,
): InputDeliveryRefusal {
  return Object.freeze({
    code,
    from: input.from,
    outcome: input.outcome,
    ref: artifact.ref,
    artifactId: artifact.artifactId,
    message,
  });
}

/** One refusal about a whole view, named by the input it was being built for. */
function wholeViewRefusal(
  input: ResolvedInput,
  code: InputDeliveryRefusalCode,
  message: string,
): InputDeliveryRefusal {
  return Object.freeze({
    code,
    from: input.from,
    outcome: input.outcome,
    message,
  });
}

/** One refusal described as one input, for a caller that prints only the reason. */
function describeInputOf(refusal: InputDeliveryRefusal): string {
  const input =
    refusal.from === undefined
      ? "this dispatch"
      : "input " +
        JSON.stringify(refusal.from) +
        "/" +
        JSON.stringify(refusal.outcome ?? "");
  return refusal.ref === undefined ? input : input + " reference " + JSON.stringify(refusal.ref);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Whether a link failure means the name is already published. */
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

/** Remove one publication's temporary file; nothing delivered ever names it. */
function discardTemporary(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // The temporary is already gone; it was never readable as a delivered file.
  }
}

/** The message of a caught value, without assuming it is an Error. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
