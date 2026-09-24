/**
 * The version axis a non-executable load result is attributed to.
 *
 * The same four names the loader already uses
 * (`EngineLoadDimension`, `src/graph/persistence/paths.ts`):
 * `storage` for the on-disk layout, `execution` for the execution-protocol
 * identity, `contract` for a persisted plan binding or compiled-plan record
 * that fails verification, and `capability` for a missing host/acceptance
 * capability. Separate axes on purpose: an unregistered protocol is not a
 * storage mismatch, and an unreadable format is not a protocol mismatch.
 */
export type DomainLoadDimension =
  | "storage"
  | "execution"
  | "contract"
  | "capability";

/**
 * The verdict of loading one authoritative domain record.
 *
 * - `valid` — the record hydrated; `value` is the domain object it names.
 * - `absent` — no authoritative record exists. Creation of a graph is a
 *   separate explicit action and is the ONLY case a caller may initialize from.
 * - `corrupt` — a recognized representation violates its schema, required
 *   shape, enum vocabulary, format discriminator, identity or plan record.
 *   `dimension` names the violated axis; the record is preserved and is never
 *   rerun as fresh.
 * - `unsupported` — a well-formed discriminator with no installed capability.
 *   `detail` names what was received; the caller needs compatible code.
 * - `migration-required` — a recognized source format has a REGISTERED
 *   conversion that has not been committed. `migration` is that capability,
 *   never a bare number; the branch cannot be constructed without one.
 *
 * `Value` is the hydrated domain shape (for example `GraphDefinition` or
 * `GraphRun`); `Migration` is the storage layer's registered conversion
 * capability, and its default `never` is what keeps a migration claim
 * unrepresentable until such a capability exists.
 */
export type DomainLoadResult<Value, Migration = never> =
  | { readonly kind: "valid"; readonly value: Value }
  | { readonly kind: "absent" }
  | {
    readonly kind: "corrupt";
    readonly dimension: DomainLoadDimension;
    readonly reason: string;
  }
  | {
    readonly kind: "unsupported";
    readonly dimension: DomainLoadDimension;
    readonly detail: string;
  }
  | {
    readonly kind: "migration-required";
    readonly dimension: "storage";
    readonly from: number;
    readonly to: number;
    /** The registered conversion capability — never a bare format number. */
    readonly migration: Migration;
  };

/**
 * The ONE constructor of the `migration-required` verdict.
 *
 * It takes the conversion capability ITSELF, so a caller holding no registered
 * migration cannot answer `migration-required` at all: the honest answer for a
 * format this build cannot read is `unsupported`, and the honest answer for a
 * body that violates its own format is `corrupt`. The capability's `from` /
 * `to` are copied onto the verdict so a diagnostic can name the conversion
 * without inspecting the capability object.
 */
export function migrationRequired<
  Value,
  Migration extends { readonly from: number; readonly to: number },
>(
  migration: Migration,
): Extract<DomainLoadResult<Value, Migration>, { readonly kind: "migration-required" }> {
  return {
    kind: "migration-required",
    dimension: "storage",
    from: migration.from,
    to: migration.to,
    migration,
  };
}
