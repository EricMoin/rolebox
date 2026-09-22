/**
 * Graph Execution Engine v2 — Storage Format Registry
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * The storage-format axis of the persistence contract: which on-disk engine
 * state layouts this build can DECODE, which it can MIGRATE, and which one it
 * WRITES. This module owns that identity, so the loader and the startup sweep
 * classify a file by a registered CAPABILITY instead of comparing raw numbers
 * themselves (docs/graph-outcome-protocol.md § "Version ownership and load
 * contract").
 *
 * Scope of this delivery (B stage, second slice):
 * - `STORAGE_FORMAT_V2` / `CURRENT_STORAGE_FORMAT` — the only format written
 *   today. `ENGINE_PERSISTENCE_VERSION` stays 2, so the on-disk write format is
 *   unchanged: no field is added, no version is bumped, no migrator is written.
 * - `StorageFormatDecoder` / `StorageFormatMigration` — the capabilities an
 *   exact version maps onto. A decoder hydrates one exact format and answers a
 *   total `StorageDecodeResult`; a migration converts one exact source format
 *   into a target that has a decoder, and its `validateSource` decides whether
 *   the source body actually is the format it claims to be. A number is never
 *   support by itself: the registry stores capabilities, not memberships.
 * - `createStorageFormatRegistry` — the only constructor for a registry that
 *   is consistent by construction: it rejects a duplicate decoder, a duplicate
 *   migration source, a migration whose target has no decoder, and a format
 *   that is both decodable and a migration source. A registry built here is
 *   deeply frozen, so widening support is an explicit new registry rather than
 *   a later in-place mutation.
 * - `classifyStorageFormat` — a PURE verdict over one raw `version` value that
 *   carries the matched capability, and the single owner of which version
 *   identifiers are legal at all.
 *
 * Dependency leaf: the single import is a TYPE-ONLY reference to the engine
 * state shape (`EngineState`), erased by the compiler, so this module has no
 * runtime dependency at all (the same rationale as `log-warn.ts`) and any
 * persistence or loader module may depend on it without creating a cycle. The
 * format-2 decoder — and therefore the default registry that registers it —
 * lives in `engine-persistence.ts`, which owns v2 hydration; this module never
 * imports it.
 */

import type { EngineState } from "../../types.engine-v2.ts";

// ── Format identities ───────────────────────────────────────────────────────

/**
 * The v2 snapshot layout — what `ENGINE_PERSISTENCE_VERSION = 2` writes and
 * what this build decodes. It is a named identity rather than the bare literal
 * `2` because the storage format is owned on this axis, independently of the
 * execution-protocol and contract-revision axes.
 */
export const STORAGE_FORMAT_V2 = 2 as const;

/** The storage format this build writes — and, today, the only decodable one. */
export const CURRENT_STORAGE_FORMAT = STORAGE_FORMAT_V2;

// ── Capabilities ────────────────────────────────────────────────────────────

/**
 * Outcome of decoding one parsed file body with a registered decoder.
 *
 * `ok` carries the hydrated state — the decode succeeded and the body belonged
 * to the decoder's own format. `invalid` carries the diagnostic for a body
 * that does not: a recognized representation that violates its schema, required
 * shape, or enum vocabulary. The distinction is deliberate — a decoder answers
 * a DATA verdict, never a registry verdict, so "no decoder installed" stays a
 * different outcome from "the decoder rejected this body" (unsupported vs
 * corrupt).
 *
 * `invalid.dimension` names the non-executable axis the decoder OBSERVED, so
 * the loader attributes the rejection to the gate that failed instead of
 * folding every rejection into the storage axis. It is optional and defaults to
 * `storage` — the decoder's own format check — so every decoder written before
 * the field existed keeps its exact verdict.
 */
export type StorageDecodeResult =
  | { kind: "ok"; state: EngineState }
  | {
      kind: "invalid";
      reason: string;
      dimension?: StorageDecodeDimension;
    };

/**
 * The axis a decoder's `invalid` verdict belongs to.
 *
 * - `storage` — the body violates the decoder's own format (schema, required
 *   shape, enum vocabulary). This is the default when a decoder names none.
 * - `contract` — the body IS a member of the decoder's format, but the
 *   persisted plan binding it carries fails verification. The format-2 decoder
 *   is the only shipped producer, so the loader reaches `corrupt(contract)`
 *   only through a `planBinding` that fails its own invariants.
 */
export type StorageDecodeDimension = "storage" | "contract";

/**
 * A registered decoder for exactly one storage format.
 *
 * `format` is the exact version identifier this decoder owns; `decode` is
 * TOTAL by contract — it must answer `invalid` with a reason for every body it
 * rejects instead of throwing, because the loader maps its answer onto a
 * non-executable load result and a throw would turn bad user data into a
 * loader failure.
 */
export interface StorageFormatDecoder {
  /** The exact storage format this decoder hydrates. */
  readonly format: number;
  /** Decode one parsed file body — never throws. */
  decode(parsed: unknown): StorageDecodeResult;
}

/**
 * A registered conversion from exactly one source storage format into one
 * target format that has its own decoder.
 *
 * Two capabilities, in this order: `validateSource` decides whether the parsed
 * body is a well-formed member of the SOURCE format — an intact predecessor
 * that this build merely cannot execute yet — and only then may the loader
 * answer `migration-required`. `migrate` performs the actual conversion and is
 * invoked by the migration runner, never by the loader (loading is read-only;
 * see the gate ordering in docs/graph-outcome-protocol.md).
 *
 * The ordering is the point: an intact source is missing a capability, while a
 * source that violates its own format is corrupt data. Collapsing the two would
 * either promise a conversion for garbage or report a build limitation as bad
 * data.
 */
export interface StorageFormatMigration {
  /** The exact source storage format this migration converts FROM. */
  readonly from: number;
  /** The exact target format it converts TO — must have a registered decoder. */
  readonly to: number;
  /** Whether the parsed body is a well-formed member of the source format. */
  validateSource(
    parsed: unknown,
  ): { ok: true } | { ok: false; reason: string };
  /** Convert a validated source body into the target format. */
  migrate(parsed: unknown): unknown;
}

/**
 * Installable storage-format support: the exact decoding and migration
 * CAPABILITIES this build has.
 *
 * Capability — never a numeric comparison or a bare membership check — decides
 * support, so a build that can read `2` but not `3` cannot accidentally accept
 * `1` under a "less than current" rule, and listing a number somewhere cannot
 * make it decodable or migratable. Build one with
 * {@link createStorageFormatRegistry}, which enforces the consistency rules the
 * loaded form relies on.
 */
export interface StorageFormatRegistry {
  /** The format this build writes: the migration target and the registry anchor. */
  readonly current: number;
  /** The installed decoders, one per exact format. */
  readonly decoders: readonly StorageFormatDecoder[];
  /** The installed migrations, one per exact source format. */
  readonly migrations: readonly StorageFormatMigration[];
}

/** Input accepted by {@link createStorageFormatRegistry}. */
export interface StorageFormatRegistryInput {
  /** The format this build writes. */
  readonly current: number;
  /** The decoders to install; at most one per format. */
  readonly decoders: readonly StorageFormatDecoder[];
  /** The migrations to install; at most one per source format. Defaults to none. */
  readonly migrations?: readonly StorageFormatMigration[];
}

/**
 * Build a deeply frozen registry from explicit decoding / migration
 * capabilities.
 *
 * Consistency is checked HERE rather than left to the loader, because each
 * violation is a programmer error with exactly one sensible owner:
 * - a duplicate decoder format — one exact format has exactly one decode owner,
 *   otherwise which body shape is accepted would depend on array order;
 * - a duplicate migration source — one exact source format has exactly one
 *   converter, for the same reason;
 * - a migration whose `to` has no decoder — a conversion nobody can hydrate is
 *   not a capability, it is a dead end that would answer `migration-required`
 *   forever;
 * - a format that is both decodable and a migration source — the loader would
 *   have to prefer one silently; a version is either read directly or
 *   converted, never both.
 *
 * Deeply frozen: the outer object, both arrays (fresh copies, so the caller's
 * arrays cannot be mutated afterwards), and every capability object are frozen.
 * An in-place edit of a frozen registry throws in strict mode, so the accepted
 * set a loader sees cannot silently move after construction.
 *
 * Throws a descriptive `Error` on the first violation.
 */
export function createStorageFormatRegistry(
  input: StorageFormatRegistryInput,
): StorageFormatRegistry {
  const migrations = input.migrations ?? [];

  const decoderFormats = new Set<number>();
  for (const decoder of input.decoders) {
    if (decoderFormats.has(decoder.format)) {
      throw new Error(
        `storage-format: duplicate decoder for format ${decoder.format} — one exact format has exactly one decode owner`,
      );
    }
    decoderFormats.add(decoder.format);
  }

  const migrationSources = new Set<number>();
  for (const migration of migrations) {
    if (migrationSources.has(migration.from)) {
      throw new Error(
        `storage-format: duplicate migration source ${migration.from} — one exact source format has exactly one converter`,
      );
    }
    if (!decoderFormats.has(migration.to)) {
      throw new Error(
        `storage-format: migration ${migration.from} -> ${migration.to} targets a format with no decoder`,
      );
    }
    if (decoderFormats.has(migration.from)) {
      throw new Error(
        `storage-format: format ${migration.from} is both decodable and a migration source — a version is either read directly or converted, never both`,
      );
    }
    migrationSources.add(migration.from);
  }

  // Freeze the capability objects the caller handed us (identity is preserved:
  // a verdict carries the SAME decoder/migration object it matched) and copy
  // the arrays before freezing, so the registry owns its own membership.
  for (const decoder of input.decoders) Object.freeze(decoder);
  for (const migration of migrations) Object.freeze(migration);
  return Object.freeze({
    current: input.current,
    decoders: Object.freeze([...input.decoders]),
    migrations: Object.freeze([...migrations]),
  });
}

// ── Classification ──────────────────────────────────────────────────────────

/**
 * Verdict for one raw `version` value.
 *
 * - `decodable` — an exact registered decoder hydrates this format. The
 *   verdict CARRIES the decoder, so the caller dispatches on a capability
 *   instead of re-deriving support from a number.
 * - `migratable` — a recognized predecessor with a registered conversion
 *   (`from` → `to`), carrying the migration itself. The snapshot cannot
 *   execute until that conversion commits, and its body must NOT be validated
 *   against the target layout; the migration's `validateSource` owns the
 *   source-format check.
 * - `unsupported` — a LEGAL format identifier with no installed decoder and no
 *   registered migration. `format` carries the number for diagnostics.
 * - `invalid` — not a format identifier at all: missing, `null`, a string, a
 *   non-integer or non-positive number, `NaN` / `Infinity`, or an integer
 *   outside the safe range. `value` carries the RAW value because it may hold
 *   any type; the caller reports it as a malformed discriminator (corrupt
 *   storage), never as an unknown-but-well-formed format.
 */
export type StorageFormatVerdict =
  | { kind: "decodable"; format: number; decoder: StorageFormatDecoder }
  | {
      kind: "migratable";
      from: number;
      to: number;
      migration: StorageFormatMigration;
    }
  | { kind: "unsupported"; format: number }
  | { kind: "invalid"; value: unknown };

/**
 * Classify one persisted storage-format value against a registry of exact
 * decoding / migration capabilities.
 *
 * Rules (the first matching rule wins):
 * 1. a value that is not a positive safe integer — missing, `null`, a string,
 *    a non-integer, zero, negative, `NaN` / `Infinity`, or an integer outside
 *    the safe range — → `invalid`, carrying the raw value: an illegal
 *    discriminator names no format at all, so the caller reports corrupt
 *    storage instead of downgrading it to an unknown format;
 * 2. the format of a registered decoder → `decodable`, carrying that decoder;
 * 3. the source of a registered migration → `migratable`, carrying that
 *    migration;
 * 4. anything else → `unsupported`.
 *
 * PURE by contract: no I/O, no logging, never throws — the loader relies on
 * this classification being total while it maps a file onto a load result.
 */
export function classifyStorageFormat(
  version: unknown,
  registry: StorageFormatRegistry,
): StorageFormatVerdict {
  // The identifier rule lives HERE, in one place: a version identifier must be
  // a positive safe integer. 2.5, 0, -1, 2**53, '2', null, NaN and Infinity are
  // all malformed discriminators — not "formats this build does not support".
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version <= 0
  ) {
    return { kind: "invalid", value: version };
  }
  const decoder = registry.decoders.find((d) => d.format === version);
  if (decoder) {
    return { kind: "decodable", format: version, decoder };
  }
  const migration = registry.migrations.find((m) => m.from === version);
  if (migration) {
    return {
      kind: "migratable",
      from: version,
      to: migration.to,
      migration,
    };
  }
  return { kind: "unsupported", format: version };
}
