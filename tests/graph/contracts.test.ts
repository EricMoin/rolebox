import { describe, expect, it } from "bun:test";

import {
  CONTRACT_DIGEST_MAX_BYTES,
  CONTRACT_DIGEST_MAX_DEPTH,
  contractDigest,
  contractRefsEqual,
  isContractRef,
  type ContractRef,
  type ContractSnapshot,
} from "../../src/graph/contracts/contract-definition.ts";
import {
  createContractRegistry,
  resolveContractRef,
  verifyContractBinding,
  type ContractRegistry,
} from "../../src/graph/contracts/resolve.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** A correctly self-describing snapshot for one body. */
function makeSnapshot(
  id: string,
  revision: string,
  body: unknown,
): ContractSnapshot {
  return { ref: { id, revision, digest: contractDigest(body) }, body };
}

/**
 * Run a digest and report EITHER the digest or the error message. Returning a
 * value only on success makes "no digest was returned" an observable fact
 * rather than an inference from a throw.
 */
function digestAttempt(body: unknown): {
  digest: string | null;
  error: string;
} {
  try {
    return { digest: contractDigest(body), error: "" };
  } catch (error) {
    return {
      digest: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The message of the error a call throws, or "" when it does not throw. */
function thrownMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

// ── Canonical digest: stability ─────────────────────────────────────────────

describe("contractDigest — canonical stability", () => {
  it("hashes the same body identically regardless of key order", () => {
    const ordered = { b: 1, a: { d: [2, 3], c: "x" } };
    const reordered = { a: { c: "x", d: [2, 3] }, b: 1 };
    expect(contractDigest(reordered)).toBe(contractDigest(ordered));

    // Nested, array-carried objects are canonicalized the same way.
    expect(contractDigest({ list: [{ y: 1, x: 2 }] })).toBe(
      contractDigest({ list: [{ x: 2, y: 1 }] }),
    );

    // The digest is a lowercase SHA-256 hex string, and it is deterministic.
    expect(contractDigest(ordered)).toMatch(/^[0-9a-f]{64}$/);
    expect(contractDigest(ordered)).toBe(contractDigest(ordered));
  });

  it("hashes a one-character content change differently", () => {
    const base = { id: "x", policy: { maxRounds: 3 }, label: "alpha" };
    const baseDigest = contractDigest(base);

    // One character in a value...
    expect(contractDigest({ ...base, label: "alphb" })).not.toBe(baseDigest);
    // ...one character in a key...
    expect(contractDigest({ idx: "x", policy: base.policy, label: "alpha" })).not.toBe(
      baseDigest,
    );
    // ...and one character in a nested leaf all move the digest.
    expect(contractDigest({ ...base, policy: { maxRounds: 4 } })).not.toBe(
      baseDigest,
    );

    // Values of different types never collide.
    expect(contractDigest("1")).not.toBe(contractDigest(1));
  });

  it("is JSON-stable: a persisted body re-hashes to the digest it was stored under", () => {
    // The canonical text is the JSON data model. -0 is the case that matters:
    // JSON.stringify writes it "0", so a canonical "-0" would name a body the
    // writer stores as 0 — a digest the load boundary could never reproduce.
    const body = { threshold: -0, label: "z", list: [1, -0, "x"] };
    expect(JSON.stringify(-0)).toBe("0");
    expect(contractDigest(-0)).toBe(contractDigest(0));
    expect(contractDigest({ threshold: -0 })).toBe(
      contractDigest({ threshold: 0 }),
    );
    // Exactly the round trip a persisted contract travels.
    expect(contractDigest(JSON.parse(JSON.stringify(body)))).toBe(
      contractDigest(body),
    );
  });
});

// ── Canonical digest: reject-before-hash ────────────────────────────────────

describe("contractDigest — reject-before-hash", () => {
  it("rejects a reference cycle with no digest", () => {
    const cyclic: Record<string, unknown> = { name: "cycle" };
    cyclic.self = cyclic;
    const attempt = digestAttempt(cyclic);
    expect(attempt.digest).toBeNull();
    expect(attempt.error).toMatch(/reference cycle/);

    const cyclicArray: unknown[] = [1];
    cyclicArray.push(cyclicArray);
    const arrayAttempt = digestAttempt(cyclicArray);
    expect(arrayAttempt.digest).toBeNull();
    expect(arrayAttempt.error).toMatch(/reference cycle/);
  });

  it("rejects a function with no digest", () => {
    const attempt = digestAttempt({ handler: () => "x" });
    expect(attempt.digest).toBeNull();
    expect(attempt.error).toMatch(/function/);
  });

  it("rejects a BigInt with no digest", () => {
    const attempt = digestAttempt({ limit: 10n });
    expect(attempt.digest).toBeNull();
    expect(attempt.error).toMatch(/BigInt/);
  });

  it("rejects an oversized body with no digest", () => {
    const attempt = digestAttempt({
      blob: "x".repeat(CONTRACT_DIGEST_MAX_BYTES + 1),
    });
    expect(attempt.digest).toBeNull();
    expect(attempt.error).toMatch(/exceeds the .* bound/);
  });

  it("uses a distinct error for each rejection cause", () => {
    const cyclic: Record<string, unknown> = { name: "cycle" };
    cyclic.self = cyclic;
    const messages = [
      digestAttempt(cyclic).error,
      digestAttempt({ handler: () => "x" }).error,
      digestAttempt({ limit: 10n }).error,
      digestAttempt({ blob: "x".repeat(CONTRACT_DIGEST_MAX_BYTES + 1) }).error,
    ];
    expect(new Set(messages).size).toBe(4);
    expect(messages[0]).toMatch(/reference cycle/);
    expect(messages[1]).toMatch(/function/);
    expect(messages[2]).toMatch(/BigInt/);
    expect(messages[3]).toMatch(/exceeds the .* bound/);
  });

  it("rejects the remaining non-representable values with no digest", () => {
    const sparse: unknown[] = [1];
    sparse[2] = 3; // index 1 is a hole
    // An array with a symbol-keyed own property: the object path rejects
    // symbols, and [1] plus a hidden symbol must not hash as plain [1].
    const symbolKeyedArray = Object.assign([1], { [Symbol("hidden")]: 2 });
    // Accessor properties are rejected from their descriptor: freezing a body
    // cannot pin a getter's value, so it must never reach the hash.
    const accessorObject: Record<string, unknown> = {};
    Object.defineProperty(accessorObject, "counter", {
      enumerable: true,
      get: () => 1,
    });
    const accessorArray: unknown[] = [1];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get: () => 1,
    });
    class Marker {
      readonly kind = "marker";
    }
    const cases: { body: unknown; pattern: RegExp }[] = [
      { body: { missing: undefined }, pattern: /undefined/ },
      { body: { tag: Symbol("x") }, pattern: /symbol/ },
      { body: { score: Number.NaN }, pattern: /not a finite JSON number/ },
      {
        body: { score: Number.POSITIVE_INFINITY },
        pattern: /not a finite JSON number/,
      },
      { body: { index: new Map([["a", 1]]) }, pattern: /Map/ },
      { body: new Set([1]), pattern: /Set/ },
      { body: { at: new Date(0) }, pattern: /Date/ },
      { body: new Marker(), pattern: /Marker/ },
      { body: sparse, pattern: /hole/ },
      { body: symbolKeyedArray, pattern: /symbol-keyed/ },
      { body: { [Symbol("k")]: 1 }, pattern: /symbol-keyed/ },
      { body: accessorObject, pattern: /accessor property/ },
      { body: accessorArray, pattern: /accessor property/ },
    ];
    for (const testCase of cases) {
      const attempt = digestAttempt(testCase.body);
      expect(attempt.digest).toBeNull();
      expect(attempt.error).toMatch(testCase.pattern);
    }
  });

  it("rejects an accessor property so a frozen registry cannot drift", () => {
    let reads = 0;
    const body: Record<string, unknown> = {};
    Object.defineProperty(body, "counter", {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads;
      },
    });

    // Rejected from the descriptor, never invoked: no digest exists for a
    // body whose value can still move.
    const attempt = digestAttempt(body);
    expect(attempt.digest).toBeNull();
    expect(attempt.error).toMatch(/accessor property/);
    expect(reads).toBe(0);

    // The factory therefore refuses it, which is what keeps a frozen
    // registry's accepted set from moving after construction.
    const message = thrownMessage(() =>
      createContractRegistry({
        contracts: [{ ref: { id: "c", revision: "1", digest: "d" }, body }],
      }),
    );
    expect(message).toMatch(/accessor property/);
    expect(reads).toBe(0);
  });

  it("bounds the canonical payload in UTF-8 bytes, not UTF-16 code units", () => {
    // 400_000 '€' characters stay under the bound in code units (400_002) but
    // exceed it in UTF-8 bytes (1_200_002).
    const attempt = digestAttempt("€".repeat(400_000));
    expect(attempt.digest).toBeNull();
    expect(attempt.error).toMatch(/exceeds the .* bound/);
    // A small multi-byte body still hashes.
    expect(contractDigest("€".repeat(10))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a body nested deeper than the documented bound", () => {
    let deep: unknown = "leaf";
    for (let index = 0; index < CONTRACT_DIGEST_MAX_DEPTH + 5; index++) {
      deep = { level: deep };
    }
    const attempt = digestAttempt(deep);
    expect(attempt.digest).toBeNull();
    expect(attempt.error).toMatch(/nests deeper than/);
    // A body within the depth bound still hashes.
    expect(contractDigest({ level: { level: "leaf" } })).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});

// ── Ref identity and guard ──────────────────────────────────────────────────

describe("contractRefsEqual / isContractRef", () => {
  it("compares identity only and never orders revisions", () => {
    const base: ContractRef = { id: "c", revision: "10", digest: "d" };
    // Equal fields in distinct objects are equal refs.
    expect(contractRefsEqual(base, { ...base })).toBe(true);
    // Every field participates.
    expect(contractRefsEqual(base, { ...base, id: "other" })).toBe(false);
    expect(contractRefsEqual(base, { ...base, revision: "9" })).toBe(false);
    expect(contractRefsEqual(base, { ...base, digest: "e" })).toBe(false);
    // "2" and "10" are opaque identifiers — neither is ordered before the other.
    const two: ContractRef = { id: "c", revision: "2", digest: "d" };
    expect(contractRefsEqual(two, base)).toBe(false);
    expect(contractRefsEqual(base, two)).toBe(false);
  });

  it("is a structural guard over non-empty strings", () => {
    expect(isContractRef({ id: "c", revision: "1", digest: "d" })).toBe(true);
    for (const value of [
      null,
      undefined,
      "c@1",
      [],
      {},
      { id: "", revision: "1", digest: "d" },
      { id: "c", revision: "", digest: "d" },
      { id: "c", revision: "1", digest: "" },
      { id: 1, revision: "1", digest: "d" },
      { id: "c", revision: "1" },
    ]) {
      expect(isContractRef(value)).toBe(false);
    }
  });
});

// ── Registry construction: digest-before-accept ─────────────────────────────

describe("createContractRegistry — digest-before-accept", () => {
  it("accepts a verified snapshot and resolves it by identity", () => {
    const body = { outcomes: ["answer"], policy: { completion: "natural" } };
    const registry = createContractRegistry({
      contracts: [makeSnapshot("contract.a", "1", body)],
    });
    const ref = registry.contracts[0].ref;
    const verdict = resolveContractRef(ref, registry);
    expect(verdict.kind).toBe("resolved");
    if (verdict.kind === "resolved") {
      // Identity is preserved: the verdict carries the same snapshot object.
      expect(verdict.snapshot).toBe(registry.contracts[0]);
    }
  });

  it("accepts a -0 body under the JSON-stable digest of its stored form", () => {
    // The body the registry accepts and the body a persisted record carries
    // (JSON's 0) hash identically, so a -0 snapshot can be installed, compiled
    // and later verified from storage with the same digest.
    const body = { threshold: -0, label: "z" };
    const registry = createContractRegistry({
      contracts: [makeSnapshot("contract.zero", "1", body)],
    });
    const ref = registry.contracts[0].ref;
    expect(ref.digest).toBe(contractDigest({ threshold: 0, label: "z" }));
    expect(resolveContractRef(ref, registry).kind).toBe("resolved");
  });

  it("rejects a duplicate (id, revision) pair — one identity has one snapshot", () => {
    const message = thrownMessage(() =>
      createContractRegistry({
        contracts: [
          makeSnapshot("c", "1", { a: 1 }),
          makeSnapshot("c", "1", { a: 2 }),
        ],
      }),
    );
    expect(message).toMatch(/duplicate contract c@1/);
  });

  it("allows one revision under different ids and different revisions under one id", () => {
    const registry = createContractRegistry({
      contracts: [
        makeSnapshot("c.a", "1", { v: 1 }),
        makeSnapshot("c.b", "1", { v: 2 }),
        makeSnapshot("c.a", "2", { v: 3 }),
      ],
    });
    expect(registry.contracts).toHaveLength(3);
  });

  it("rejects a snapshot whose body does not hash to its claimed digest", () => {
    const body = { policy: "strict" };
    const claimed = contractDigest({ policy: "lax" });
    const message = thrownMessage(() =>
      createContractRegistry({
        contracts: [{ ref: { id: "c", revision: "1", digest: claimed }, body }],
      }),
    );
    expect(message).toMatch(/declares digest/);
    // Both the lie and the truth are named.
    expect(message).toContain(claimed);
    expect(message).toContain(contractDigest(body));
  });

  it("rejects a malformed ref — empty id, revision or digest", () => {
    const malformed: ContractRef[] = [
      { id: "", revision: "1", digest: "d" },
      { id: "c", revision: "", digest: "d" },
      { id: "c", revision: "1", digest: "" },
    ];
    for (const ref of malformed) {
      const message = thrownMessage(() =>
        createContractRegistry({ contracts: [{ ref, body: {} }] }),
      );
      expect(message).toMatch(/malformed contract ref/);
    }
  });

  it("rejects a ref that freezing cannot pin: accessor-backed or inherited fields", () => {
    const body = { policy: "strict" };
    const digest = contractDigest(body);

    // An own getter answers through the structural guard, and Object.freeze
    // cannot stop it answering something else afterwards, so the factory must
    // refuse the ref before it becomes a registry key.
    let reads = 0;
    const accessorRef: ContractRef = { id: "c", revision: "1", digest };
    Object.defineProperty(accessorRef, "id", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "c";
      },
    });
    expect(isContractRef(accessorRef)).toBe(true);

    const accessorMessage = thrownMessage(() =>
      createContractRegistry({ contracts: [{ ref: accessorRef, body }] }),
    );
    expect(accessorMessage).toMatch(/not own data properties/);
    expect(accessorMessage).toContain("id");
    // The rejection inspects the descriptor, so only the structural guard's
    // reads reach the getter; nothing re-reads the moving value afterwards.
    expect(reads).toBeLessThanOrEqual(3);
    // A rejected construction freezes nothing, so no half-pinned ref escapes.
    expect(Object.isFrozen(accessorRef)).toBe(false);

    // Fields inherited from a prototype pass the structural guard but are not
    // pinned by freezing the instance: the prototype could rewrite the
    // identity the registry accepted, so they are refused too.
    class PrototypeRef implements ContractRef {
      get id(): string {
        return "c";
      }
      get revision(): string {
        return "1";
      }
      get digest(): string {
        return digest;
      }
    }
    const inheritedRef = new PrototypeRef();
    expect(isContractRef(inheritedRef)).toBe(true);
    const inheritedMessage = thrownMessage(() =>
      createContractRegistry({ contracts: [{ ref: inheritedRef, body }] }),
    );
    expect(inheritedMessage).toMatch(/not own data properties/);

    // Plain data refs are untouched by the hardening.
    const registry = createContractRegistry({
      contracts: [makeSnapshot("c", "1", body)],
    });
    expect(registry.contracts).toHaveLength(1);
  });
});

// ── Resolution ──────────────────────────────────────────────────────────────

describe("resolveContractRef", () => {
  it("answers unknown-contract, unknown-revision, digest-mismatch and resolved", () => {
    const body = { policy: "strict" };
    const registry = createContractRegistry({
      contracts: [makeSnapshot("c", "10", body)],
    });
    const genuine: ContractRef = {
      id: "c",
      revision: "10",
      digest: contractDigest(body),
    };

    const resolved = resolveContractRef(genuine, registry);
    expect(resolved.kind).toBe("resolved");
    if (resolved.kind === "resolved") {
      expect(resolved.snapshot).toBe(registry.contracts[0]);
    }

    expect(resolveContractRef({ ...genuine, id: "missing" }, registry)).toEqual({
      kind: "unknown-contract",
      id: "missing",
    });
    expect(
      resolveContractRef({ ...genuine, revision: "09" }, registry),
    ).toEqual({ kind: "unknown-revision", ref: { ...genuine, revision: "09" } });
    // A revision is an opaque identifier: "10" never satisfies "1".
    expect(resolveContractRef({ ...genuine, revision: "1" }, registry).kind).toBe(
      "unknown-revision",
    );

    // The body is re-hashed, so a snapshot whose body no longer matches the
    // claimed digest reports the ACTUAL digest instead of resolving.
    const tampered: ContractRegistry = {
      contracts: [
        {
          ref: { id: "c", revision: "10", digest: contractDigest(body) },
          body: { policy: "lax" },
        },
      ],
    };
    const mismatch = resolveContractRef(genuine, tampered);
    expect(mismatch.kind).toBe("digest-mismatch");
    if (mismatch.kind === "digest-mismatch") {
      expect(mismatch.ref).toBe(genuine);
      expect(mismatch.actual).toBe(contractDigest({ policy: "lax" }));
      expect(mismatch.actual).not.toBe(genuine.digest);
    }
  });

  it("is total over a factory-built registry: no probe throws", () => {
    const registry = createContractRegistry({
      contracts: [makeSnapshot("c", "1", { a: 1 })],
    });
    for (const probe of [
      { id: "", revision: "", digest: "" },
      { id: "c", revision: "1", digest: "0".repeat(64) },
      { id: "c", revision: "1", digest: registry.contracts[0].ref.digest },
    ]) {
      expect(() => resolveContractRef(probe, registry)).not.toThrow();
    }
  });
});

describe("verifyContractBinding", () => {
  it("verifies an in-hand snapshot with the same rules", () => {
    const body = { policy: "strict" };
    const ref: ContractRef = { id: "c", revision: "1", digest: contractDigest(body) };
    const bound: ContractSnapshot = { ref, body };

    const resolved = verifyContractBinding(ref, bound);
    expect(resolved.kind).toBe("resolved");
    if (resolved.kind === "resolved") expect(resolved.snapshot).toBe(bound);

    expect(verifyContractBinding({ ...ref, id: "other" }, bound)).toEqual({
      kind: "unknown-contract",
      id: "other",
    });
    expect(verifyContractBinding({ ...ref, revision: "2" }, bound)).toEqual({
      kind: "unknown-revision",
      ref: { ...ref, revision: "2" },
    });

    const mismatch = verifyContractBinding(ref, {
      ref,
      body: { policy: "lax" },
    });
    expect(mismatch.kind).toBe("digest-mismatch");
    if (mismatch.kind === "digest-mismatch") {
      expect(mismatch.ref).toBe(ref);
      expect(mismatch.actual).toBe(contractDigest({ policy: "lax" }));
    }
  });
});

// ── Immutability ────────────────────────────────────────────────────────────

describe("registry and snapshots are deeply frozen", () => {
  it("freezes the registry, its array, each snapshot, each ref and the body tree", () => {
    const body = {
      outcomes: ["answer", "revision"],
      policy: { nested: { counter: 0 } },
    };
    const registry = createContractRegistry({
      contracts: [makeSnapshot("c", "1", body)],
    });
    const entry = registry.contracts[0];
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.contracts)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.ref)).toBe(true);
    expect(Object.isFrozen(entry.body)).toBe(true);
    // The body the caller handed in is frozen through, so its digest can no
    // longer be invalidated from outside the registry.
    expect(Object.isFrozen(body)).toBe(true);
    expect(Object.isFrozen(body.outcomes)).toBe(true);
    expect(Object.isFrozen(body.policy)).toBe(true);
    expect(Object.isFrozen(body.policy.nested)).toBe(true);
  });

  it("a tampered entry cannot resolve: frozen writes do not move the accepted set", () => {
    const body: Record<string, unknown> = { policy: "strict" };
    const ref: ContractRef = { id: "c", revision: "1", digest: contractDigest(body) };
    const registry = createContractRegistry({ contracts: [{ ref, body }] });

    // An in-place write to the ref is rejected (strict mode) or a no-op;
    // either way the recorded digest must still describe the body.
    let refWriteThrew = false;
    try {
      Object.assign(ref, { digest: "0".repeat(64) });
    } catch {
      refWriteThrew = true;
    }
    expect(refWriteThrew || ref.digest !== "0".repeat(64)).toBe(true);
    expect(ref.digest).toBe(contractDigest(body));

    // The same holds for a deep body edit, which is what a digest mismatch
    // would otherwise be manufactured from after construction.
    let bodyWriteThrew = false;
    try {
      Object.assign(body, { policy: "lax" });
    } catch {
      bodyWriteThrew = true;
    }
    expect(bodyWriteThrew || body.policy !== "lax").toBe(true);
    expect(body.policy).toBe("strict");

    // Observable resolution is unchanged: the genuine ref resolves, and the
    // digest the rejected writes tried to install does not.
    expect(resolveContractRef(ref, registry).kind).toBe("resolved");
    expect(
      resolveContractRef(
        { id: "c", revision: "1", digest: "0".repeat(64) },
        registry,
      ).kind,
    ).toBe("digest-mismatch");
  });
});
