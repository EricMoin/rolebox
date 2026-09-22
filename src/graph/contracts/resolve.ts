/**
 * Graph Execution Engine v2 — Contract Resolution
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * The resolution / verification surface of the contract-revision axis: given a
 * `ContractRef`, does an installed capability actually PRODUCE the content the
 * reference names? This module owns that question, so a compiler resolves
 * exact references and a loader re-verifies a binding it already holds by
 * recomputing the canonical digest instead of trusting an identifier
 * (docs/graph-outcome-protocol.md § "Version ownership and load contract").
 *
 * Scope of this delivery (B stage, fourth slice — the identity surface only):
 * - `createContractRegistry` — the only constructor for a registry that is
 *   consistent by construction. It rejects a malformed ref, a ref whose three
 *   fields are not own data properties (a getter or an inherited field is not
 *   pinned by `Object.freeze`), a duplicate `(id, revision)` pair, and a
 *   snapshot whose body does not hash to its claimed digest. Verification
 *   happens BEFORE ACCEPTANCE, so the accepted
 *   set follows the same "capability, not membership" discipline as the
 *   storage-format and execution-protocol registries: a ref resolves only when
 *   the registered body actually hashes to the claimed digest. A registry
 *   built here is deeply frozen — snapshots, refs and body trees — so its
 *   digest invariant cannot move after construction.
 * - `resolveContractRef` — PURE and total over a factory-built registry:
 *   id unknown → `unknown-contract`; `(id, revision)` unknown →
 *   `unknown-revision`; found but the body hashes to something else →
 *   `digest-mismatch` carrying the ACTUAL digest; otherwise `resolved`.
 *   Revisions are matched by string identity, never by ordering.
 * - `verifyContractBinding` — the same rules applied to a binding already in
 *   hand (the ref plus the snapshot it should name), which the load-side slice
 *   uses once a retained compiled plan exists.
 *
 * Binding a ref to a node or compiled plan, and refusing a mismatched or
 * missing binding at load, is the NEXT slice: it needs the
 * `CompiledPlan[graphId, planRevision]` record, so this module deliberately
 * has no registry-lookup-by-node or loader entry point.
 *
 * Dependency leaf alongside `contract-definition.ts`: this module imports
 * only that module, so no engine, loader or compiler module is a dependency
 * and any of them may depend on this one.
 */

import {
  contractDigest,
  isContractRef,
  type ContractRef,
  type ContractSnapshot,
} from "./contract-definition.ts";

// ── Registry capability ─────────────────────────────────────────────────────

/**
 * The installed contract capability: the immutable snapshots this build has,
 * one per exact `(id, revision)` identity.
 *
 * Membership alone grants nothing — a ref resolves only when the registered
 * body actually hashes to the claimed digest. Build one with
 * {@link createContractRegistry}, which enforces the consistency rules the
 * resolution functions rely on.
 */
export interface ContractRegistry {
  /** The installed snapshots, at most one per `(id, revision)` pair. */
  readonly contracts: readonly ContractSnapshot[];
}

/** Input accepted by {@link createContractRegistry}. */
export interface ContractRegistryInput {
  /** The snapshots to install. */
  readonly contracts: readonly ContractSnapshot[];
}

/**
 * The ref fields that are not own data properties.
 *
 * A ref is an immutable identity only if its three fields are pinned by
 * `Object.freeze`. Freezing does not pin a getter (it stops the property from
 * being REPLACED, not the accessor from answering something else), and an
 * inherited field is not an own property of the frozen object at all, so both
 * could answer one identity during construction and another afterwards — the
 * exact drift freezing is supposed to rule out. The check reads descriptors
 * only, so it never invokes the accessor it rejects.
 */
function nonDataRefFields(ref: ContractRef): string[] {
  const fields: string[] = [];
  for (const field of ["id", "revision", "digest"]) {
    const descriptor = Object.getOwnPropertyDescriptor(ref, field);
    if (descriptor === undefined || !("value" in descriptor)) {
      fields.push(field);
    }
  }
  return fields;
}

/**
 * Build a deeply frozen registry from explicit contract snapshots.
 *
 * Consistency is checked HERE rather than left to the resolver, because each
 * violation is a programmer error with exactly one sensible owner:
 * - a malformed ref (empty id, revision or digest) names nothing, so it can
 *   never be a key;
 * - a ref whose id, revision or digest is not an OWN DATA property — a getter
 *   or an inherited field survives freezing, so the identity the factory
 *   accepted could move afterwards;
 * - a duplicate `(id, revision)` pair — one exact identity has exactly one
 *   snapshot, otherwise which body a ref resolved to would depend on array
 *   order, and an exact identity republished with different content would
 *   silently change in-flight semantics;
 * - a snapshot whose body does not hash to its claimed digest — the claimed
 *   digest is not a label to be trusted, it is a claim the body must PROVE.
 *
 * Deeply frozen: the outer object, the contracts array (a fresh copy, so the
 * caller's array cannot be mutated afterwards), every snapshot, every ref and
 * the whole body tree. A body frozen here can no longer be edited to disagree
 * with the digest recorded for it, and an in-place edit of any frozen member
 * throws in strict mode — so the accepted set a compiler or loader sees cannot
 * silently move after construction.
 *
 * Throws a descriptive `Error` on the first violation.
 */
export function createContractRegistry(
  input: ContractRegistryInput,
): ContractRegistry {
  const revisionsById = new Map<string, Set<string>>();
  for (const snapshot of input.contracts) {
    const ref = snapshot.ref;
    if (!isContractRef(ref)) {
      throw new Error(
        "contracts: malformed contract ref — id, revision and digest must all be non-empty strings",
      );
    }
    const nonData = nonDataRefFields(ref);
    if (nonData.length > 0) {
      throw new Error(
        `contracts: contract ref field(s) ${nonData.join(", ")} are not own data properties — Object.freeze cannot pin an accessor or an inherited value, so the accepted identity could move after construction`,
      );
    }
    const revisions = revisionsById.get(ref.id) ?? new Set<string>();
    if (revisions.has(ref.revision)) {
      throw new Error(
        `contracts: duplicate contract ${ref.id}@${ref.revision} — one exact (id, revision) pair has exactly one snapshot`,
      );
    }
    revisions.add(ref.revision);
    revisionsById.set(ref.id, revisions);

    const actual = contractDigest(snapshot.body);
    if (actual !== ref.digest) {
      throw new Error(
        `contracts: snapshot ${ref.id}@${ref.revision} declares digest ${ref.digest} but its body hashes to ${actual}`,
      );
    }
  }

  // Freeze only after every snapshot is valid, so a rejected construction
  // never leaves anything frozen behind. Identity is preserved: resolution
  // answers the SAME snapshot object the caller handed in.
  for (const snapshot of input.contracts) {
    Object.freeze(snapshot.ref);
    deepFreezeBody(snapshot.body);
    Object.freeze(snapshot);
  }
  return Object.freeze({
    contracts: Object.freeze([...input.contracts]),
  });
}

/**
 * Freeze a validated contract body in place.
 *
 * Safe to walk: `contractDigest` already accepted this body, so it is a
 * finite, acyclic tree of plain objects and arrays. Re-freezing a shared
 * subtree is idempotent.
 */
function deepFreezeBody(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeBody(item);
    return;
  }
  for (const key of Object.keys(value)) {
    deepFreezeBody((value as Record<string, unknown>)[key]);
  }
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Verdict for one ref against one registry (or one in-hand snapshot).
 *
 * - `resolved` — an exact registered snapshot exists AND its body hashes to
 *   the ref's digest. The verdict CARRIES that snapshot, so the caller uses a
 *   proven capability instead of re-deriving it.
 * - `unknown-contract` — no registered snapshot has this `id`. `id` carries
 *   the requested contract name for diagnostics.
 * - `unknown-revision` — the id is installed, but not at this exact revision.
 *   `ref` carries the request. This is a MISSING CAPABILITY, never a hint to
 *   fall back to a newer or nearer revision.
 * - `digest-mismatch` — the exact identity exists, but the registered body
 *   hashes to something else. `actual` carries the digest the body really has,
 *   which is corrupt data rather than an unsupported request.
 */
export type ContractResolution =
  | { kind: "resolved"; snapshot: ContractSnapshot }
  | { kind: "unknown-contract"; id: string }
  | { kind: "unknown-revision"; ref: ContractRef }
  | { kind: "digest-mismatch"; ref: ContractRef; actual: string };

/**
 * Resolve one ref against a registry of exact contract capabilities.
 *
 * Rules (the first matching rule wins):
 * 1. no snapshot with this `id` → `unknown-contract`;
 * 2. no snapshot with this `(id, revision)` → `unknown-revision` (revision is
 *    matched by string identity — never ordered, never a range);
 * 3. the snapshot's body does not hash to `ref.digest` → `digest-mismatch`
 *    carrying the ACTUAL digest;
 * 4. otherwise → `resolved`, carrying the exact registered snapshot.
 *
 * PURE by contract: no I/O, no logging, never throws for a registry object
 * that satisfies {@link ContractRegistry} — in particular one built by
 * {@link createContractRegistry}, whose accepted bodies are all
 * canonicalizable.
 */
export function resolveContractRef(
  ref: ContractRef,
  registry: ContractRegistry,
): ContractResolution {
  const forId = registry.contracts.filter(
    (snapshot) => snapshot.ref.id === ref.id,
  );
  if (forId.length === 0) {
    return { kind: "unknown-contract", id: ref.id };
  }
  const snapshot = forId.find(
    (candidate) => candidate.ref.revision === ref.revision,
  );
  if (!snapshot) {
    return { kind: "unknown-revision", ref };
  }
  const actual = contractDigest(snapshot.body);
  if (actual !== ref.digest) {
    return { kind: "digest-mismatch", ref, actual };
  }
  return { kind: "resolved", snapshot };
}

/**
 * Verify one contract binding that is already in hand: the ref a plan or node
 * binds plus the snapshot it should name.
 *
 * The same rules as {@link resolveContractRef}, with the single in-hand
 * snapshot as the whole registry: id mismatch → `unknown-contract`; revision
 * mismatch → `unknown-revision`; a body that does not hash to `ref.digest` →
 * `digest-mismatch` carrying the actual digest; otherwise `resolved`.
 *
 * The digest is always RECOMPUTED from the body and compared with the binding
 * ref, so a snapshot's own claimed digest is never what makes a binding pass.
 * A persisted snapshot that fails the binding therefore reports corrupt
 * contract data — the load-side slice maps that onto its non-executable
 * result, and never repairs or re-resolves it.
 */
export function verifyContractBinding(
  ref: ContractRef,
  snapshot: ContractSnapshot,
): ContractResolution {
  if (snapshot.ref.id !== ref.id) {
    return { kind: "unknown-contract", id: ref.id };
  }
  if (snapshot.ref.revision !== ref.revision) {
    return { kind: "unknown-revision", ref };
  }
  const actual = contractDigest(snapshot.body);
  if (actual !== ref.digest) {
    return { kind: "digest-mismatch", ref, actual };
  }
  return { kind: "resolved", snapshot };
}
