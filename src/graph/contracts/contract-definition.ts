/**
 * Graph Execution Engine v2 — Contract Identity
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * The contract-revision axis of the persistence contract: which immutable
 * contract CONTENT a reference names. This module owns that identity, so a
 * compiler, a loader or a receipt store can bind and re-verify a contract by
 * content instead of trusting an identifier
 * (docs/graph-outcome-protocol.md § "Version ownership and load contract").
 *
 * Scope of this delivery (B stage, fourth slice — the identity surface only):
 * - `ContractRef` / `ContractSnapshot` — a reference names a contract by
 *   `{ id, revision, digest }`, and a snapshot is the immutable effective
 *   contract that reference identifies. `revision` is an OPAQUE IMMUTABLE
 *   identifier: never ordered, never a semver range, never compared by
 *   magnitude.
 * - `contractDigest` — the ONE canonical digest of a complete contract body.
 *   The canonical representation is a protocol-defined text with recursively
 *   sorted keys (UTF-16 code-unit order), every own enumerable data property
 *   and no whitespace; SHA-256 hex is taken over its exact UTF-8 bytes. It is
 *   EXACTLY the JSON data model, so a persisted body re-hashes to the digest it
 *   was stored under. It REJECTS BEFORE HASHING: a value the canonical form
 *   cannot represent, or a body beyond the documented byte / depth bounds,
 *   throws a descriptive error — a digest is never computed over a truncated
 *   or partially represented body.
 * - `contractRefsEqual` / `isContractRef` — identity comparison and the
 *   structural guard trust boundaries use.
 *
 * Binding a `ContractRef` to a node or a retained compiled plan, and refusing
 * a mismatched binding at load, needs the compiled-plan record shape that does
 * not exist yet: that is the NEXT slice, so no declaration, engine-state,
 * loader or compiler change is made here.
 *
 * Dependency leaf: the single import is `node:crypto`, so any persistence,
 * loader, dispatch or engine module may depend on it without creating a cycle
 * — the same rationale as `storage-format.ts` / `execution-protocol.ts`.
 */

import { createHash } from "node:crypto";

// ── Identities ──────────────────────────────────────────────────────────────

/**
 * A reference to one immutable contract revision.
 *
 * `id` names the contract, independently of any role, node or registry
 * instance. `revision` is an OPAQUE IMMUTABLE identifier: it is never
 * ordered, never a semver range and never compared by magnitude, so `"2"` and
 * `"10"` are simply two different identifiers. `digest` is the content digest
 * of the complete effective contract at that revision. A reference is an
 * identity, not a pointer: two refs are equal exactly when all three fields
 * are identical strings.
 */
export interface ContractRef {
  /** Names the contract. */
  readonly id: string;
  /** Opaque immutable revision identifier, compared by string identity only. */
  readonly revision: string;
  /** Canonical digest of the complete effective contract at this revision. */
  readonly digest: string;
}

/**
 * The immutable effective contract a {@link ContractRef} identifies: the ref
 * plus the complete contract body it names. A registry accepts a snapshot only
 * when `contractDigest(body)` equals `ref.digest`, so a snapshot's content
 * identity is proven rather than declared.
 */
export interface ContractSnapshot {
  readonly ref: ContractRef;
  readonly body: unknown;
}

// ── Canonical digest ────────────────────────────────────────────────────────

/**
 * The largest canonical body, in UTF-8 bytes, {@link contractDigest} will
 * hash. A larger body throws instead of hashing a prefix, so contract size is
 * a protocol bound rather than a silent truncation.
 */
export const CONTRACT_DIGEST_MAX_BYTES = 1_048_576;

/**
 * The deepest container nesting {@link contractDigest} will canonicalize. The
 * bound makes a hostile or accidental deep body fail with a descriptive error
 * instead of exhausting the call stack part-way through a digest.
 */
export const CONTRACT_DIGEST_MAX_DEPTH = 64;

/** Mutable accumulator for one canonicalization pass. */
interface CanonicalBuffer {
  readonly chunks: string[];
  /**
   * UTF-16 code units appended so far. This is a SOUND early bound for the
   * byte bound: UTF-8 never uses fewer bytes than the code units it encodes,
   * so exceeding the bound in code units implies exceeding it in bytes.
   */
  length: number;
  /**
   * Containers on the CURRENT path only. A cycle is an ancestor reference;
   * a shared (diamond) subtree is not a cycle and stays representable.
   */
  readonly ancestors: Set<object>;
}

/**
 * Append one canonical fragment, enforcing the documented size bound as the
 * body is built. A body that would exceed the bound never reaches the hash.
 */
function appendCanonical(
  buffer: CanonicalBuffer,
  text: string,
  path: string,
): void {
  buffer.chunks.push(text);
  buffer.length += text.length;
  if (buffer.length > CONTRACT_DIGEST_MAX_BYTES) {
    throw new Error(
      `contract-digest: canonical body exceeds the ${CONTRACT_DIGEST_MAX_BYTES}-byte bound at ${path} — a digest is never computed over a truncated body`,
    );
  }
}

/**
 * Describe a non-plain container for diagnostics. `Object.prototype.toString`
 * names the exotic built-ins; a class instance falls back to its constructor
 * name, which is the useful part.
 */
function describeNonPlain(value: object): string {
  const tag = Object.prototype.toString.call(value);
  if (tag !== "[object Object]") {
    return `a non-plain ${tag.slice("[object ".length, -1)} value`;
  }
  const proto = Object.getPrototypeOf(value) as {
    readonly constructor?: { readonly name?: unknown };
  } | null;
  const name = proto?.constructor?.name;
  return typeof name === "string" && name.length > 0
    ? `an instance of ${name}`
    : "a non-plain object";
}

/**
 * Canonicalize one array: index order, own elements only, no holes, no
 * non-index properties, no symbol keys and no accessor elements — the object
 * path rejects the same values, so an array carrying one cannot be hashed as
 * if it were absent or already pinned.
 */
function writeCanonicalArray(
  value: readonly unknown[],
  path: string,
  depth: number,
  buffer: CanonicalBuffer,
): void {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(
      `contract-digest: array at ${path} has symbol-keyed properties — the canonical form cannot represent symbol keys`,
    );
  }
  for (const name of Object.getOwnPropertyNames(value)) {
    if (name === "length") continue;
    const index = Number(name);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= value.length ||
      String(index) !== name
    ) {
      throw new Error(
        `contract-digest: array at ${path} carries the non-index property ${JSON.stringify(name)} — the canonical form covers indices only`,
      );
    }
  }
  appendCanonical(buffer, "[", path);
  for (let index = 0; index < value.length; index++) {
    if (!(index in value)) {
      throw new Error(
        `contract-digest: array at ${path} has a hole at index ${index} — JSON has no hole, so a truncated element would be hashed as null`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) {
      throw new Error(
        `contract-digest: array element at ${path}[${index}] is not an own data property — the canonical form covers own elements only`,
      );
    }
    if ("get" in descriptor || "set" in descriptor) {
      throw new Error(
        `contract-digest: an accessor property at ${path}[${index}] is not representable — a contract is static data, and a getter can return a different value on every read`,
      );
    }
    if (index > 0) appendCanonical(buffer, ",", path);
    writeCanonical(value[index], `${path}[${index}]`, depth + 1, buffer);
  }
  appendCanonical(buffer, "]", path);
}

/**
 * Canonicalize one plain object: keys sorted by UTF-16 code unit order, every
 * own enumerable data property covered. Anything whose own properties the
 * canonical form would silently drop (symbol keys, non-enumerables) or cannot
 * pin or express (an accessor property, a prototype other than
 * `Object.prototype` / `null`) is rejected.
 */
function writeCanonicalObject(
  value: object,
  path: string,
  depth: number,
  buffer: CanonicalBuffer,
): void {
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(
      `contract-digest: ${describeNonPlain(value)} at ${path} is not representable — only plain objects and arrays have a canonical form`,
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(
      `contract-digest: object at ${path} has symbol-keyed properties — the canonical form cannot represent symbol keys`,
    );
  }
  const keys = Object.keys(value);
  if (Object.getOwnPropertyNames(value).length !== keys.length) {
    throw new Error(
      `contract-digest: object at ${path} has non-enumerable own properties — the canonical form covers enumerable own properties only`,
    );
  }
  // Default sort: UTF-16 code unit order, locale-independent and stable across
  // processes, so key ORDER never moves the digest.
  keys.sort();
  appendCanonical(buffer, "{", path);
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      throw new Error(
        `contract-digest: own property ${JSON.stringify(key)} at ${path} has no descriptor — the canonical form cannot read it deterministically`,
      );
    }
    if ("get" in descriptor || "set" in descriptor) {
      throw new Error(
        `contract-digest: an accessor property at ${path}[${JSON.stringify(key)}] is not representable — a contract is static data, and a getter can return a different value on every read`,
      );
    }
    if (index > 0) appendCanonical(buffer, ",", path);
    appendCanonical(buffer, `${JSON.stringify(key)}:`, path);
    writeCanonical(
      (value as Record<string, unknown>)[key],
      `${path}[${JSON.stringify(key)}]`,
      depth + 1,
      buffer,
    );
  }
  appendCanonical(buffer, "}", path);
}

/** Canonicalize one container after the cycle check. */
function writeCanonicalContainer(
  value: object,
  path: string,
  depth: number,
  buffer: CanonicalBuffer,
): void {
  if (buffer.ancestors.has(value)) {
    throw new Error(
      `contract-digest: a reference cycle reaches ${path} — the canonical form is finite, so a self-referential body cannot be hashed`,
    );
  }
  buffer.ancestors.add(value);
  if (Array.isArray(value)) {
    writeCanonicalArray(value, path, depth, buffer);
  } else {
    writeCanonicalObject(value, path, depth, buffer);
  }
  buffer.ancestors.delete(value);
}

/**
 * Write the canonical form of one value.
 *
 * Canonical grammar (protocol-defined; this module's file header versions it):
 * - `null` → `null`; booleans → `true` / `false`;
 * - numbers → their JSON text (`JSON.stringify`), so `-0` is written `0`;
 *   `NaN` and the infinities are rejected because JSON has no representation
 *   for them;
 * - strings → their JSON-quoted, escaped form;
 * - arrays → `[` elements `]` in index order;
 * - plain objects → `{` `"key"` `:` value, `,`-joined, `}` with keys sorted by
 *   UTF-16 code unit order.
 *
 * Every unrepresentable value throws BEFORE any hash exists. The grammar is
 * exactly the JSON data model, so a body JSON can carry — including one holding
 * `-0` — re-hashes to the same digest after a `JSON.parse(JSON.stringify(body))`
 * round trip, which is how a persisted contract travels.
 */
function writeCanonical(
  value: unknown,
  path: string,
  depth: number,
  buffer: CanonicalBuffer,
): void {
  if (depth > CONTRACT_DIGEST_MAX_DEPTH) {
    throw new Error(
      `contract-digest: body nests deeper than ${CONTRACT_DIGEST_MAX_DEPTH} containers at ${path} — a digest is never computed over a body the canonical form cannot fully represent`,
    );
  }
  if (value === null) {
    appendCanonical(buffer, "null", path);
    return;
  }
  switch (typeof value) {
    case "string":
      appendCanonical(buffer, JSON.stringify(value), path);
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(
          `contract-digest: ${String(value)} at ${path} is not a finite JSON number — the canonical form cannot represent it`,
        );
      }
      // JSON's OWN number text, including its treatment of signed zero. The
      // persistence format is JSON, so a canonical "-0" would name a body the
      // writer stores as 0 — the writer's own output would then be refused at
      // the load boundary. Conflating -0 with 0 is the JSON data model, and it
      // keeps every accepted body JSON-stable.
      appendCanonical(buffer, JSON.stringify(value), path);
      return;
    case "boolean":
      appendCanonical(buffer, value ? "true" : "false", path);
      return;
    case "undefined":
      throw new Error(
        `contract-digest: undefined at ${path} is not representable — a digest never silently drops or nulls a value`,
      );
    case "bigint":
      throw new Error(
        `contract-digest: a BigInt at ${path} is not representable — convert it to a string or number first`,
      );
    case "symbol":
      throw new Error(
        `contract-digest: a symbol at ${path} is not representable — the canonical form has no symbol value`,
      );
    case "function":
      throw new Error(
        `contract-digest: a function at ${path} is not representable — a contract is data, never executable code`,
      );
    case "object":
      writeCanonicalContainer(value, path, depth, buffer);
      return;
  }
}

/**
 * The ONE canonical digest of a complete contract body: SHA-256 hex over the
 * canonical UTF-8 text described above.
 *
 * PURE and deterministic: the same body always yields the same digest in any
 * process, two bodies that differ only in key order yield the SAME digest, and
 * a body differing anywhere in content yields a different one.
 *
 * JSON-STABLE: the canonical text is the JSON data model, so a body survives
 * `JSON.parse(JSON.stringify(body))` with an UNCHANGED digest — the property
 * the persistence boundary depends on. `-0` is the case that matters: JSON
 * writes it `0`, so it is conflated with `0` rather than hashed as a value
 * the stored form cannot carry.
 *
 * REJECTS BEFORE HASHING — a value the canonical form cannot represent (a
 * function, symbol, BigInt, `undefined`, non-finite number, reference cycle,
 * hole, symbol key, accessor property or non-plain container) and a body beyond
 * {@link CONTRACT_DIGEST_MAX_BYTES} / {@link CONTRACT_DIGEST_MAX_DEPTH} throw a
 * descriptive error. There is no partial or truncated digest.
 */
export function contractDigest(body: unknown): string {
  const buffer: CanonicalBuffer = {
    chunks: [],
    length: 0,
    ancestors: new Set(),
  };
  writeCanonical(body, "$", 0, buffer);
  const canonical = buffer.chunks.join("");
  // Exact UTF-8 accounting: the incremental guard above is sound but
  // conservative, so a multi-byte body can only exceed the real bound here.
  if (Buffer.byteLength(canonical, "utf8") > CONTRACT_DIGEST_MAX_BYTES) {
    throw new Error(
      `contract-digest: canonical body exceeds the ${CONTRACT_DIGEST_MAX_BYTES}-byte bound at $ — a digest is never computed over a truncated body`,
    );
  }
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ── Guards and equality ─────────────────────────────────────────────────────

/**
 * Structural guard for a {@link ContractRef}: all three fields must be
 * non-empty strings. Empty strings are refused here because an empty
 * identifier, revision or digest names nothing and can never be resolved; the
 * remaining shape (an object) is left to the type system.
 *
 * The guard only READS the three fields, so an accessor-backed or
 * prototype-backed object can pass it. Stability is a separate requirement:
 * `createContractRegistry` additionally insists that id, revision and digest
 * are own data properties, because `Object.freeze` cannot pin a getter's
 * return value or an inherited field.
 */
export function isContractRef(value: unknown): value is ContractRef {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    readonly id?: unknown;
    readonly revision?: unknown;
    readonly digest?: unknown;
  };
  return (
    isNonEmptyString(candidate.id) &&
    isNonEmptyString(candidate.revision) &&
    isNonEmptyString(candidate.digest)
  );
}

/** Whether a value is a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Identity comparison for two refs: all three fields must be identical
 * strings. This never recomputes a digest, never trims or normalizes, and
 * never orders revisions — `"10"` is not "greater than" `"9"`, it is simply
 * different.
 */
export function contractRefsEqual(a: ContractRef, b: ContractRef): boolean {
  return (
    a.id === b.id && a.revision === b.revision && a.digest === b.digest
  );
}
