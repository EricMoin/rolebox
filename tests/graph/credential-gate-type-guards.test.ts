/**
 * Credential slice — the Wave 1 gate on the credential store's WRITE (F-14).
 *
 * THE DEFECT THIS FILE PINS. `CredentialIsolationStore.remember` used to answer
 * `void` — the one return type that accepts ANY returned value. An `async`
 * implementation therefore satisfied the interface, the runtime dropped the
 * returned promise, and the state recording only the credential's DIGEST could
 * commit before — or without — the credential: exactly the permanently
 * un-deliverable attempt `credential-isolation.ts` documents it prevents.
 * `resolve` never had the problem (`string | undefined` cannot be a promise), so
 * the asymmetry between the two members was the bug; it is fixed on the write
 * side only, and `resolve` is unchanged.
 *
 * THE THREE LAYERS PINNED HERE:
 * - the TYPE: `remember` answers `undefined`, so an `async` or otherwise
 *   value-returning implementation is refused at its own definition site. The
 *   negative pins are assignability probes whose authority is
 *   `bun run typecheck:tests` (`bun test` is transpile-only);
 * - the READER: `readStore` narrows with an ANSWER check as well as `typeof`, so
 *   an `async` (or generator) `remember` — a JavaScript host satisfies no type —
 *   makes the capability unreadable, and the run path reports the named
 *   `credential-isolation-unavailable` refusal instead of adopting it;
 * - the CALL: the mint checks the answer of the call it makes, the only place a
 *   PLAIN function that returns a promise is observable, and fails the mint so
 *   the enclosing transaction writes nothing.
 *
 * COMPATIBILITY. A well-formed synchronous store is unchanged: it is read, it
 * records the credential, and the runtime's mint/resolve round trip still
 * succeeds. The only new behaviour is fail-closed.
 *
 * @module
 */

import { afterEach, describe, expect, expectTypeOf, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import {
  credentialIsolationRefusal,
  readCredentialIsolationAdapter,
  readCredentialIsolationStore,
} from "../../src/graph/outcome/credential-isolation.ts";
import type {
  CredentialIsolationCapability,
  CredentialIsolationStore,
  CredentialStoreIdentity,
} from "../../src/graph/outcome/credential-isolation.ts";
import { OutcomeGraphRuntime } from "../../src/graph/outcome/runtime.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/runtime.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { buildDeclaredOutcomeGraph } from "../../src/graph/tools/declare-graph.ts";
import {
  openTrackedCredentialVault,
  removeTempTrees,
} from "./helpers/temp-dirs.ts";

const NOW = 1_700_000_000_000;

/** The smallest runnable graph: one entry node, one attempt. */
const ONE_ENTRY: GraphDeclarationV3 = {
  version: 3,
  name: "credential.gate",
  nodes: [
    { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
  ],
  edges: [],
};

/** A deterministic credential, so a test can name the attempt it holds. */
const perAttemptCredential = (binding: { nodeId: string; attemptId: string }) =>
  "credential:" + binding.nodeId + "#" + binding.attemptId;

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  removeTempTrees(tmpDirs);
});

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Assignability as a VALUE, so a pin that stops holding is a compile error
 * rather than a silently-true type. `void` accepted both of the negative cases
 * below; `undefined` accepts neither.
 */
type IsAssignable<From, To> = [From] extends [To] ? true : false;

type AsyncRemember = (
  identity: CredentialStoreIdentity,
  credential: string,
) => Promise<void>;
type ValueRemember = (
  identity: CredentialStoreIdentity,
  credential: string,
) => string;
type SyncRemember = (
  identity: CredentialStoreIdentity,
  credential: string,
) => undefined;

/**
 * A WELL-FORMED STORE: the write is synchronous, answers `undefined`, and the
 * round trip is a plain map. This is the shape the strengthened interface must
 * keep accepting — the compatibility half of F-14.
 */
function recordingStore(): {
  readonly store: CredentialIsolationStore;
  readonly entries: Map<string, string>;
} {
  const entries = new Map<string, string>();
  const keyOf = (identity: CredentialStoreIdentity): string =>
    identity.graphId + "/" + identity.nodeId + "/" + identity.attemptId;
  const store: CredentialIsolationStore = {
    remember: (identity, credential) => {
      entries.set(keyOf(identity), credential);
      return undefined;
    },
    resolve: (identity) => entries.get(keyOf(identity)),
  };
  return { store, entries };
}

/** The version-3 capability over `store`, with the declared guarantees. */
function adapterOver(store: CredentialIsolationStore): CredentialIsolationCapability {
  return {
    version: 3,
    id: "test-host:credential-gate",
    credentialStoreRoot: "/host/credential-store",
    guarantees: { digestOnlyPersistedState: true, perAttemptDelivery: true },
    durableCredentialStore: "none",
    store,
  };
}

/**
 * A store whose `remember` is replaced AT RUNTIME by `replacement`.
 *
 * THE REWRITE IS THE FIXTURE, NOT A SHORTCUT. F-14's hazard is a value the typed
 * option cannot even express — a JavaScript host, or a store mutated after the
 * reader narrowed it — so the value the runtime reads satisfies no TypeScript
 * type at all. Rebuilding the property is how that value is constructed here
 * without a cast, and a cast is one of the tools this slice removes.
 */
function storeWhoseRememberIs(replacement: () => unknown): CredentialIsolationStore {
  const store: CredentialIsolationStore = {
    remember: () => undefined,
    resolve: () => undefined,
  };
  Object.defineProperty(store, "remember", {
    value: replacement,
    enumerable: true,
    configurable: true,
    writable: false,
  });
  return store;
}

// ── The type: the write must answer `undefined` ─────────────────────────────

describe("the credential store's write is declared SYNCHRONOUS (F-14)", () => {
  it("refuses an `async` and a value-returning remember, and keeps resolve as it was", () => {
    // The declared answer is `undefined`, the one spelling that refuses a
    // promise at the implementation site.
    expectTypeOf<
      ReturnType<CredentialIsolationStore["remember"]>
    >().toEqualTypeOf<undefined>();
    // An `async` implementation: `void` accepted it (the promise was dropped);
    // `undefined` does not.
    expectTypeOf<
      IsAssignable<AsyncRemember, CredentialIsolationStore["remember"]>
    >().toEqualTypeOf<false>();
    // Any other value-returning implementation: same rule.
    expectTypeOf<
      IsAssignable<ValueRemember, CredentialIsolationStore["remember"]>
    >().toEqualTypeOf<false>();
    // THE POSITIVE HALF: a synchronous implementation still satisfies it, and
    // `resolve` is UNCHANGED — a `string | undefined` cannot be a promise, which
    // is why only the write side needed the strengthening.
    expectTypeOf<
      IsAssignable<SyncRemember, CredentialIsolationStore["remember"]>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      ReturnType<CredentialIsolationStore["resolve"]>
    >().toEqualTypeOf<string | undefined>();
  });
});

// ── The reader: an answer that cannot be `undefined` is not a store ─────────

describe("a store whose write cannot answer synchronously is refused by name", () => {
  it("refuses an `async` remember through the reader and through the run path", async () => {
    const dir = makeTmpDir("credential-gate-async-");
    // A JavaScript host's store: `remember` is an async function, whose own
    // answer is a promise, whatever the interface says.
    const raw = adapterOver(storeWhoseRememberIs(async () => {}));

    // THE READER refuses it, so the whole capability is unreadable rather than
    // partly trusted, and the named refusal is the one every caller already
    // reports.
    expect(readCredentialIsolationAdapter(raw)).toBeUndefined();
    expect(readCredentialIsolationStore(raw)).toBeUndefined();
    const refusal = credentialIsolationRefusal(raw);
    expect(refusal?.code).toBe("credential-isolation-unavailable");
    expect(refusal?.path).toBe("$.credentialIsolation");
    expect(refusal?.message).toContain("store: exactly { remember, resolve }");

    // THE RUN PATH reports that refusal and writes nothing, instead of adopting
    // a credential whose write was only started.
    const plan = buildDeclaredOutcomeGraph({ declaration: ONE_ENTRY }).plan;
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const runtime = new OutcomeGraphRuntime({
        plan,
        ledger,
        dispatch: () => undefined,
        validators: createValidatorRegistry([]),
        artifactRoot: dir,
        clock: () => NOW,
        mintCredential: perAttemptCredential,
        credentialIsolation: raw,
      });
      const started = runtime.start(NOW);
      expect(started.kind).toBe("refused");
      if (started.kind !== "refused") return;
      expect(started.refusals.map((entry) => entry.code)).toEqual([
        "credential-isolation-unavailable",
      ]);
      expect(ledger.readGraphState(plan.graphId)).toBeUndefined();
    } finally {
      ledger.close();
    }
  });

  it("refuses a plain remember that returns a promise, before anything commits", async () => {
    const dir = makeTmpDir("credential-gate-promise-");
    // The reader CANNOT see this one: it is a plain function, so `typeof` and the
    // callable kind both say "function" while the answer is a promise.
    const raw = adapterOver(storeWhoseRememberIs(() => Promise.resolve(undefined)));
    expect(readCredentialIsolationAdapter(raw)).toBeDefined();

    const plan = buildDeclaredOutcomeGraph({ declaration: ONE_ENTRY }).plan;
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const runtime = new OutcomeGraphRuntime({
        plan,
        ledger,
        dispatch: () => undefined,
        validators: createValidatorRegistry([]),
        artifactRoot: dir,
        clock: () => NOW,
        mintCredential: perAttemptCredential,
        credentialIsolation: raw,
      });
      // The mint fails, and the whole start — run identity, state, effect and
      // credential record — rolls back with it.
      expect(() => runtime.start(NOW)).toThrow(/remember\(\) answered/);
      expect(ledger.readGraphState(plan.graphId)).toBeUndefined();
      expect(ledger.pendingEffects(plan.graphId)).toEqual([]);
    } finally {
      ledger.close();
    }
  });
});

// ── Compatibility: a well-formed store is untouched ─────────────────────────

describe("a well-formed synchronous store keeps working unchanged", () => {
  it("adopts the credential, resolves it, and mints through the runtime", async () => {
    const dir = makeTmpDir("credential-gate-sync-");
    const { store, entries } = recordingStore();
    const raw = adapterOver(store);

    // The reader adopts it, and the capability it declares is readable.
    const read = readCredentialIsolationAdapter(raw);
    expect(read?.version).toBe(3);
    if (read?.version !== 3) {
      throw new Error("fixture: the version-3 capability was not read");
    }
    expect(read.store.remember).toBe(store.remember);
    expect(read.store.resolve).toBe(store.resolve);
    expect(credentialIsolationRefusal(raw)).toBeUndefined();

    // THE ROUND TRIP, directly: the write answers `undefined` and the value is
    // there for the attempt it was issued for.
    const identity: CredentialStoreIdentity = Object.freeze({
      graphId: "graph:credential-gate",
      nodeId: "work",
      attemptId: "work#1",
    });
    expect(read.store.remember(identity, "credential:work#1")).toBeUndefined();
    expect(read.store.resolve(identity)).toBe("credential:work#1");
    expect(entries.size).toBe(1);

    // THE ROUND TRIP THROUGH THE RUNTIME'S OWN MINT: the attempt the state
    // records is one the store can resolve, which is the property F-14 protects.
    const requests: OutcomeDispatchRequest[] = [];
    const plan = buildDeclaredOutcomeGraph({ declaration: ONE_ENTRY }).plan;
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const runtime = new OutcomeGraphRuntime({
        plan,
        ledger,
        dispatch: (request) => {
          requests.push(request);
        },
        validators: createValidatorRegistry([]),
        artifactRoot: dir,
        clock: () => NOW,
        mintCredential: perAttemptCredential,
        credentialIsolation: raw,
      });
      const started = runtime.start(NOW);
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const dispatched = requests[0];
      expect(dispatched?.nodeId).toBe("work");
      expect(dispatched?.attemptId).toBe("work#1");
      expect(dispatched?.credential).toBe("credential:work#work#1");
      const binding: CredentialStoreIdentity = Object.freeze({
        graphId: plan.graphId,
        nodeId: "work",
        attemptId: dispatched?.attemptId ?? "",
      });
      expect(store.resolve(binding)).toBe(dispatched?.credential);
    } finally {
      ledger.close();
    }
  });

  it("keeps the shipped vault's store half valid", () => {
    // The ONE structural implementation (`credential-vault.ts`): its `remember`
    // declares `undefined`, answers `undefined`, and `resolve` hands the value
    // back for exactly the attempt it was issued for.
    const dir = makeTmpDir("credential-gate-vault-");
    const vault = openTrackedCredentialVault({ root: dir });
    const store = vault.store;
    const identity: CredentialStoreIdentity = Object.freeze({
      graphId: "graph:credential-gate",
      nodeId: "work",
      attemptId: "work#1",
    });
    expect(store.remember(identity, "credential:work#1")).toBeUndefined();
    expect(store.resolve(identity)).toBe("credential:work#1");
    expect(store.resolve({ ...identity, attemptId: "work#2" })).toBeUndefined();
  });
});
