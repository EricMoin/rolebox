/**
 * Graph drain / migration audit (E stage entry) — regression tests.
 *
 * The audit is the evidence release-gate step 5 needs before the legacy
 * execution path may be retired (docs/graph-outcome-protocol.md
 * § "Implementation order and release gates"), so these tests pin the three
 * things a reviewer must be able to check:
 *
 * 1. MIXED PROTOCOL RECORDS CLASSIFY CORRECTLY. A store holding legacy
 *    (protocol 1) and outcome (protocol 2) records at once is partitioned into
 *    readable-and-terminal / readable-and-in-flight / unreadable-or-unknown,
 *    with the protocol split and the unsettled-effect count reported beside the
 *    partition.
 * 2. UNREADABLE AND VERSION-UNKNOWN RECORDS ARE BLOCKERS, EVERY ONE OF THEM. A
 *    corrupt file, an unknown storage format, an unknown execution protocol, a
 *    state body this build cannot read and a ledger this build must refuse each
 *    appear as their own blocker with file attribution — never folded into a
 *    count, never ignored.
 * 3. THE AUDIT WRITES NOTHING. Every file under the audited workspace —
 *    engine-state files AND the SQLite acceptance ledger — is hashed and
 *    mtime-compared before and after a full audit over the mixed store, and a
 *    missing ledger is shown to stay missing (the read-only open never creates
 *    or initializes a store).
 * 4. THE QUEUE FACTS ARE FILE FACTS. A legacy record's stale-lock criterion is
 *    read from the PERSISTED FILE: a record whose file still defers a completion
 *    is `actively-executing` and reports the file's frontier/deferred sizes,
 *    even though the loader deliberately resets `pendingCompletions` (R2(c))
 *    when it hydrates that same record.
 *
 * The verdict is also pinned to be MORE than a count: a store whose only graph
 * is terminal, but which still holds an unsettled ledger effect, is reported
 * `in-flight`, not `drained`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import {
  EnginePersistence,
  engineStateDir,
  serializeEngineState,
} from "../../src/graph/persistence/engine-persistence.ts";
import {
  createEngineState,
  provision,
} from "../../src/graph/engine/engine-state.ts";
import {
  buildDeclaredOutcomeGraph,
  persistDeclaredGraph,
  type DeclaredOutcomeGraph,
} from "../../src/graph/tools/declare-graph.ts";
import {
  LEGACY_SIGNAL_PROTOCOL,
  OUTCOME_PROTOCOL,
} from "../../src/graph/protocol/execution-protocol.ts";
import {
  ledgerFilePath,
  SqliteAcceptanceLedger,
} from "../../src/graph/ledger/sqlite-ledger.ts";
import { createDatabase } from "../../src/memory/db-driver.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import {
  OutcomeGraphRuntime,
  type OutcomeDispatchRequest,
} from "../../src/graph/outcome/runtime.ts";
import {
  auditGraphStore,
  STALE_LOCK_IDLE_THRESHOLD_MS,
  type DrainAuditEntry,
  type DrainAuditReport,
} from "../../src/graph/audit/drain-audit.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";
import { createGraphTools } from "../../src/graph/tools/index.ts";

// ── Temp workspaces ─────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A v2 (legacy) declaration: one node, no edges. */
function legacyDeclaration(name: string): GraphDeclaration {
  return {
    version: 2,
    name,
    nodes: [{ id: "A", agent: "agent.a", prompt: "Do A." }],
    edges: [],
  };
}

/** Persist one legacy engine-state file in a chosen phase / node status. */
function persistLegacy(
  dir: string,
  graphId: string,
  phase: EnginePhase,
  nodeStatus: NodeStatus,
  /**
   * Extra state the staleness fixtures need: the record's own last-update
   * timestamp and its queue. Omitted by every pre-existing caller, so the
   * default fixture is byte-identical to what it always was.
   */
  overrides?: {
    readonly updatedAt?: number;
    readonly frontier?: readonly string[];
    readonly pendingCompletions?: readonly string[];
  },
): void {
  const state = createEngineState(legacyDeclaration(graphId), graphId);
  provision(state);
  state.phase = phase;
  const node = state.nodes.get("A");
  if (node === undefined) throw new Error("fixture: node A was not registered");
  node.status = nodeStatus;
  if (overrides?.updatedAt !== undefined) state.updatedAt = overrides.updatedAt;
  if (overrides?.frontier !== undefined) state.frontier = [...overrides.frontier];
  if (overrides?.pendingCompletions !== undefined) {
    state.pendingCompletions = [...overrides.pendingCompletions];
  }
  new EnginePersistence(dir).save(state);
}

/** A v3 declaration: work -> ship, both outcomes terminal on ship. */
function linearDeclaration(name: string): GraphDeclarationV3 {
  return {
    version: 3,
    name,
    nodes: [
      {
        id: "work",
        agent: "agent.work",
        prompt: "Do the work.",
        outcomes: [{ id: "done" }],
      },
      {
        id: "ship",
        agent: "agent.ship",
        prompt: "Ship it.",
        outcomes: [{ id: "delivered" }],
      },
    ],
    edges: [{ from: "work", to: "ship", outcome: "done" }],
  };
}

/** One declared graph with its persisted record, ledger and live runtime. */
interface OutcomeFixture {
  readonly built: DeclaredOutcomeGraph;
  readonly ledger: SqliteAcceptanceLedger;
  readonly requests: OutcomeDispatchRequest[];
  readonly runtime: OutcomeGraphRuntime;
}

/**
 * Declare a graph, persist its plan, and START it on the real outcome run path:
 * the starting snapshot lands in the acceptance ledger and the entry node is
 * dispatched through the capturing seam. The fixture therefore produces exactly
 * the store shape the audit must classify — no hand-written state.
 */
async function startOutcomeGraph(
  dir: string,
  name: string,
): Promise<OutcomeFixture> {
  const built = buildDeclaredOutcomeGraph({
    declaration: linearDeclaration(name),
  });
  persistDeclaredGraph(built, dir);
  const ledger = await SqliteAcceptanceLedger.create(engineStateDir(dir));
  const requests: OutcomeDispatchRequest[] = [];
  const runtime = new OutcomeGraphRuntime({
    plan: built.plan,
    ledger,
    dispatch: (request) => {
      requests.push(request);
    },
    validators: createValidatorRegistry([]),
    artifactRoot: dir,
    credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
    clock: () => NOW,
  });
  const started = runtime.start(NOW);
  if (started.kind !== "started") {
    throw new Error("fixture: outcome graph did not start (" + started.kind + ")");
  }
  return { built, ledger, requests, runtime };
}

/** The credential the most recent dispatch request for a node carried. */
function credentialFor(
  requests: readonly OutcomeDispatchRequest[],
  nodeId: string,
): string {
  const found = requests.filter((request) => request.nodeId === nodeId).at(-1);
  if (found === undefined) {
    throw new Error("fixture: no dispatch request for node " + nodeId);
  }
  return found.credential;
}

/** Settle one node on the real run path, failing loudly when it is refused. */
function settle(fixture: OutcomeFixture, nodeId: string, outcomeId: string): void {
  const result = fixture.runtime.submit(
    { nodeId, outcomeId, credential: credentialFor(fixture.requests, nodeId) },
    NOW,
  );
  if (result.kind !== "accepted") {
    throw new Error(
      "fixture: submission for " + nodeId + " was " + result.kind,
    );
  }
}

/** Write one raw file into the engine-state store. */
function writeStateFile(dir: string, file: string, text: string): void {
  const stateDir = engineStateDir(dir);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, file), text, "utf-8");
}

/** The audit entry for one store file, or a loud failure. */
function entryOf(report: DrainAuditReport, file: string): DrainAuditEntry {
  const entry = report.entries.find((candidate) => candidate.file === file);
  if (entry === undefined) throw new Error("no audit entry for " + file);
  return entry;
}

/** One file's byte/mtime identity, for the zero-write proof. */
interface FileFingerprint {
  readonly sha256: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

/** Every file under a root, hashed and mtime-stamped, keyed by path. */
function fingerprintTree(root: string): Record<string, FileFingerprint> {
  const out: Record<string, FileFingerprint> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = readFileSync(path);
      out[path] = {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
        mtimeMs: statSync(path).mtimeMs,
      };
    }
  };
  walk(root);
  return out;
}

// ── The mixed store the classification and zero-write tests share ───────────

/**
 * Build a store holding BOTH protocols, terminal AND in-flight records, and
 * every kind of unusable record: a corrupt file, an unknown storage format, an
 * unknown execution protocol and an outcome state body this build cannot read.
 *
 * All fixture writes happen HERE, before the audit runs, so the zero-write test
 * can snapshot the finished store and compare it byte-for-byte afterwards.
 */
async function buildMixedStore(dir: string): Promise<void> {
  // Readable + terminal (legacy).
  persistLegacy(dir, "audit.legacy.complete", EnginePhase.Complete, NodeStatus.Done);
  // Readable + in flight (legacy).
  persistLegacy(dir, "audit.legacy.running", EnginePhase.Executing, NodeStatus.Running);

  // Readable + in flight (outcome): started, nothing settled — the work#1
  // attempt is armed and its dispatch effect is `started` (D8: the intent is
  // durable from the same transaction as the state, and the create returned).
  const running = await startOutcomeGraph(dir, "audit.outcome.running");
  running.ledger.close();

  // Readable + terminal (outcome): both nodes settled, and every dispatch
  // effect was completed by its own attempt's settlement (D8), so this graph
  // owes nothing — deliberately asserted below.
  const complete = await startOutcomeGraph(dir, "audit.outcome.complete");
  settle(complete, "work", "done");
  settle(complete, "ship", "delivered");
  complete.ledger.close();

  // Unreadable: not JSON at all.
  writeStateFile(dir, "engine-audit.corrupt.json", "{ this is not valid json !!!");

  // Version unknown (storage): a legal-looking discriminator no decoder reads.
  writeStateFile(
    dir,
    "engine-audit.storage.unknown.json",
    JSON.stringify({ version: 99, graphId: "audit.storage.unknown", phase: "complete" }),
  );

  // Version unknown (execution): a valid format-2 body bound to protocol 42.
  const legacyState = createEngineState(
    legacyDeclaration("audit.protocol.unknown"),
    "audit.protocol.unknown",
  );
  provision(legacyState);
  legacyState.phase = EnginePhase.Complete;
  writeStateFile(
    dir,
    "engine-audit.protocol.unknown.json",
    JSON.stringify({
      ...serializeEngineState(legacyState),
      executionProtocolVersion: 42,
    }),
  );

  // Version unknown (outcome state body): a protocol-2 record whose ledger row
  // declares a state-body version this build has no reader for.
  const unknownState = await startOutcomeGraph(dir, "audit.outcome.stateversion");
  unknownState.ledger.writeGraphState({
    graphId: unknownState.built.graphId,
    planRevision: unknownState.built.plan.planRevision,
    body: { bodyVersion: 99 },
    updatedAt: NOW,
  });
  unknownState.ledger.close();
}

// ── Classification and blockers ─────────────────────────────────────────────

describe("drain audit — classification", () => {
  it("classifies mixed legacy/outcome records and lists every unreadable or version-unknown record as a blocker", async () => {
    const dir = makeTmpDir("drain-audit-mixed-");
    await buildMixedStore(dir);

    const report = await auditGraphStore({ directory: dir });

    // Deterministic store order + the three-way partition.
    expect(report.stateDirectory).toBe(engineStateDir(dir));
    expect(report.ledger).toBe("opened");
    expect(report.entries.map((entry) => entry.file)).toEqual([
      "engine-audit.corrupt.json",
      "engine-audit.legacy.complete.json",
      "engine-audit.legacy.running.json",
      "engine-audit.outcome.complete.json",
      "engine-audit.outcome.running.json",
      "engine-audit.outcome.stateversion.json",
      "engine-audit.protocol.unknown.json",
      "engine-audit.storage.unknown.json",
    ]);
    expect(report.totals).toMatchObject({
      files: 8,
      terminal: 2,
      inFlight: 2,
      blocked: 4,
      legacyInFlight: 1,
      outcomeInFlight: 1,
      unsettledEffects: 1,
    });
    expect(report.verdict).toBe("blocked");
    expect(report.drained).toBe(false);

    // Readable + terminal (legacy).
    const legacyComplete = entryOf(report, "engine-audit.legacy.complete.json");
    expect(legacyComplete.executionProtocolVersion).toBe(LEGACY_SIGNAL_PROTOCOL);
    expect(legacyComplete.protocol).toBe("legacy-signal");
    expect(legacyComplete.classification).toBe("terminal");
    expect(legacyComplete.phase).toBe(EnginePhase.Complete);
    expect(legacyComplete.unsettledNodeIds).toEqual([]);
    expect(legacyComplete.blockerCodes).toEqual([]);

    // Readable + in flight (legacy): the WORK is named, not just the phase.
    const legacyRunning = entryOf(report, "engine-audit.legacy.running.json");
    expect(legacyRunning.classification).toBe("in-flight");
    expect(legacyRunning.phase).toBe(EnginePhase.Executing);
    expect(legacyRunning.nodeStatusCounts).toEqual({ running: 1 });
    expect(legacyRunning.unsettledNodeIds).toEqual(["A"]);

    // Readable + in flight (outcome): the armed attempt is named.
    const outcomeRunning = entryOf(report, "engine-audit.outcome.running.json");
    expect(outcomeRunning.executionProtocolVersion).toBe(OUTCOME_PROTOCOL);
    expect(outcomeRunning.protocol).toBe("outcome");
    expect(outcomeRunning.classification).toBe("in-flight");
    expect(outcomeRunning.phase).toBe("executing");
    expect(outcomeRunning.hasState).toBe(true);
    expect(outcomeRunning.armed).toEqual([
      { nodeId: "work", attemptId: "work#1" },
    ]);
    // The in-flight attempt's dispatch effect is DURABLE and unsettled: the
    // audit reads it from the ledger rather than inferring it from the state.
    expect(
      outcomeRunning.unsettledEffects?.map(
        (effect) => effect.effectId + "@" + effect.status,
      ),
    ).toEqual(["dispatch:work#1@started"]);

    // Readable + terminal (outcome), with nothing left unsettled: each
    // dispatch effect was completed by its attempt's settlement.
    const outcomeComplete = entryOf(report, "engine-audit.outcome.complete.json");
    expect(outcomeComplete.classification).toBe("terminal");
    expect(outcomeComplete.phase).toBe("complete");
    expect(outcomeComplete.armed).toEqual([]);
    expect(outcomeComplete.unsettledEffects).toEqual([]);
    expect(outcomeComplete.blockerCodes).toEqual([]);

    // Unreadable / version-unknown entries: each one its own blocker.
    const corrupt = entryOf(report, "engine-audit.corrupt.json");
    expect(corrupt.classification).toBe("blocked");
    expect(corrupt.protocol).toBe("unknown");
    expect(corrupt.executionProtocolVersion).toBeUndefined();
    expect(corrupt.blockerCodes).toEqual(["corrupt-record"]);

    const storageUnknown = entryOf(report, "engine-audit.storage.unknown.json");
    expect(storageUnknown.classification).toBe("blocked");
    expect(storageUnknown.blockerCodes).toEqual(["unsupported-version"]);

    const protocolUnknown = entryOf(report, "engine-audit.protocol.unknown.json");
    expect(protocolUnknown.classification).toBe("blocked");
    expect(protocolUnknown.blockerCodes).toEqual(["unsupported-version"]);

    const stateVersion = entryOf(report, "engine-audit.outcome.stateversion.json");
    expect(stateVersion.classification).toBe("blocked");
    expect(stateVersion.hasState).toBe(true);
    expect(stateVersion.blockerCodes).toEqual(["state-version-unsupported"]);

    // The flattened blocker list: one line per condition, with attribution.
    expect(report.blockers.map((entry) => entry.code).sort()).toEqual([
      "corrupt-record",
      "state-version-unsupported",
      "unsupported-version",
      "unsupported-version",
    ]);
    expect(report.blockers.every((entry) => typeof entry.file === "string")).toBe(
      true,
    );
    const byFile = new Map(report.blockers.map((entry) => [entry.file, entry]));
    expect(byFile.get("engine-audit.storage.unknown.json")?.dimension).toBe(
      "storage",
    );
    expect(byFile.get("engine-audit.protocol.unknown.json")?.dimension).toBe(
      "execution",
    );
    expect(byFile.get("engine-audit.outcome.stateversion.json")?.graphId).toBe(
      "audit.outcome.stateversion",
    );
    expect(report.totals.blockersByCode).toEqual({
      "corrupt-record": 1,
      "state-version-unsupported": 1,
      "unsupported-version": 2,
    });
  });

  it("reports 'in-flight', not 'drained', when readable graphs still owe work", async () => {
    const dir = makeTmpDir("drain-audit-inflight-");
    persistLegacy(dir, "audit.legacy.running", EnginePhase.Executing, NodeStatus.Running);
    const running = await startOutcomeGraph(dir, "audit.outcome.running");
    running.ledger.close();

    const report = await auditGraphStore({ directory: dir });

    expect(report.blockers).toEqual([]);
    expect(report.ledger).toBe("opened");
    expect(report.totals).toMatchObject({
      files: 2,
      terminal: 0,
      inFlight: 2,
      blocked: 0,
      legacyInFlight: 1,
      outcomeInFlight: 1,
      // The outcome graph's entry dispatch is a durable, unresolved EFFECT
      // (started, awaiting its attempt's outcome) — the store owes work on the
      // ledger as well as in the state.
      unsettledEffects: 1,
    });
    expect(report.verdict).toBe("in-flight");
    expect(report.drained).toBe(false);
  });

  it("reports 'drained' for a legacy-only terminal store, and never creates the absent ledger", async () => {
    const dir = makeTmpDir("drain-audit-drained-");
    persistLegacy(dir, "audit.legacy.complete", EnginePhase.Complete, NodeStatus.Done);
    expect(existsSync(ledgerFilePath(engineStateDir(dir)))).toBe(false);

    const report = await auditGraphStore({ directory: dir });

    expect(report.ledger).toBe("absent");
    expect(report.blockers).toEqual([]);
    expect(report.totals).toMatchObject({
      files: 1,
      terminal: 1,
      inFlight: 0,
      blocked: 0,
      legacyInFlight: 0,
      unsettledEffects: 0,
    });
    expect(report.verdict).toBe("drained");
    expect(report.drained).toBe(true);
    // The audit read the store; it did not initialize one.
    expect(existsSync(ledgerFilePath(engineStateDir(dir)))).toBe(false);
  });

  it("reads a workspace with no store at all as drained and creates nothing", async () => {
    const dir = makeTmpDir("drain-audit-store-absent-");
    // Nothing is created here: no `.rolebox`, no state directory, no ledger.
    const stateDir = engineStateDir(dir);
    expect(existsSync(stateDir)).toBe(false);

    const report = await auditGraphStore({ directory: dir });

    // A missing store is an EMPTY report, not an unreadable one: there is no
    // graph to drain and nothing to block on. The directory is still named, so
    // a caller can see WHICH store was read.
    expect(report.stateDirectory).toBe(stateDir);
    expect(report.ledger).toBe("absent");
    expect(report.entries).toEqual([]);
    expect(report.blockers).toEqual([]);
    expect(report.totals).toMatchObject({
      files: 0,
      terminal: 0,
      inFlight: 0,
      blocked: 0,
      legacyInFlight: 0,
      outcomeInFlight: 0,
      unsettledEffects: 0,
    });
    expect(report.verdict).toBe("drained");
    expect(report.drained).toBe(true);

    // Reading is never initializing: neither the state directory nor the
    // ledger file exists after the audit.
    expect(existsSync(stateDir)).toBe(false);
    expect(existsSync(ledgerFilePath(stateDir))).toBe(false);
  });

  it("does not call a store drained while a TERMINAL graph still holds an unsettled effect", async () => {
    const dir = makeTmpDir("drain-audit-effect-");
    const fixture = await startOutcomeGraph(dir, "audit.outcome.complete");
    settle(fixture, "work", "done");
    settle(fixture, "ship", "delivered");
    // The RUN PATH now completes a dispatch effect with its attempt (D8), so a
    // completed graph holds none. This fixture writes one unsettled effect of
    // another kind to keep the audit's own rule covered: a terminal graph whose
    // ledger still holds an unresolved row is NOT a drained store.
    fixture.ledger.writeEffect({
      graphId: fixture.built.graphId,
      effectId: "notify:final",
      attemptId: "ship#2",
      kind: "notify",
      payload: { nodeId: "ship" },
      createdAt: NOW,
      status: "pending",
    });
    fixture.ledger.close();

    const report = await auditGraphStore({ directory: dir });

    expect(report.blockers).toEqual([]);
    expect(report.totals.inFlight).toBe(0);
    expect(report.totals.terminal).toBe(1);
    expect(report.totals.unsettledEffects).toBe(1);
    expect(report.verdict).toBe("in-flight");
    expect(report.drained).toBe(false);
  });
});

// ── Stale-lock inference (is the lock real, or is the process dead?) ─────────

/** Ten days: past the threshold by two orders of magnitude. */
const LONG_IDLE_MS = 10 * 24 * 60 * 60 * 1000;

describe("drain audit — stale-lock inference", () => {
  it("calls an in-flight record with nothing queued and no recent update a stale lock", async () => {
    const dir = makeTmpDir("drain-audit-stale-");
    persistLegacy(dir, "audit.legacy.stale", EnginePhase.Executing, NodeStatus.Running, {
      updatedAt: NOW - LONG_IDLE_MS,
      // The node is RUNNING, so the engine consumed the frontier: this record
      // has nothing queued at all (the shape the real store shows).
      frontier: [],
    });

    const report = await auditGraphStore({ directory: dir, now: () => NOW });

    const entry = entryOf(report, "engine-audit.legacy.stale.json");
    expect(entry.classification).toBe("in-flight");
    expect(entry.phase).toBe(EnginePhase.Executing);
    // The inference, with every fact it was drawn from.
    expect(entry.staleness).toEqual({
      lastUpdatedAt: NOW - LONG_IDLE_MS,
      idleMs: LONG_IDLE_MS,
      staleAfterMs: STALE_LOCK_IDLE_THRESHOLD_MS,
      staleness: "stale-lock",
      hasQueuedWork: false,
      frontierEmpty: true,
      frontierSize: 0,
      pendingCompletionsEmpty: true,
      pendingCompletionsSize: 0,
    });
    expect(report.totals.staleLocks).toBe(1);
    expect(report.totals.activelyExecuting).toBe(0);
    // The inference is NOT a rewrite: the entry is still in flight and the
    // verdict still refuses to call the store drained.
    expect(report.verdict).toBe("in-flight");
    expect(report.drained).toBe(false);
  });

  it("never calls a record with queued work stale, however old it is", async () => {
    const dir = makeTmpDir("drain-audit-queued-");
    // The frontier is the queue fact that survives a round trip; "A" is ready
    // for dispatch, so a live engine could still be advancing this record.
    persistLegacy(dir, "audit.legacy.queued", EnginePhase.Executing, NodeStatus.Ready, {
      updatedAt: NOW - LONG_IDLE_MS,
      // Ready for dispatch: the engine has not consumed it, so a live process
      // could still be advancing this record.
      frontier: ["A"],
    });

    const report = await auditGraphStore({ directory: dir, now: () => NOW });

    const entry = entryOf(report, "engine-audit.legacy.queued.json");
    expect(entry.staleness?.staleness).toBe("actively-executing");
    expect(entry.staleness?.hasQueuedWork).toBe(true);
    expect(entry.staleness?.frontierEmpty).toBe(false);
    expect(entry.staleness?.frontierSize).toBe(1);
    // ...and the age is still reported, so the caller sees both halves.
    expect(entry.staleness?.idleMs).toBe(LONG_IDLE_MS);
    expect(report.totals.staleLocks).toBe(0);
    expect(report.totals.activelyExecuting).toBe(1);
  });

  it("never calls a recently updated record stale, however empty its queue", async () => {
    const dir = makeTmpDir("drain-audit-recent-");
    persistLegacy(dir, "audit.legacy.recent", EnginePhase.Executing, NodeStatus.Running, {
      updatedAt: NOW - 1000,
      frontier: [],
    });

    const report = await auditGraphStore({ directory: dir, now: () => NOW });

    const entry = entryOf(report, "engine-audit.legacy.recent.json");
    expect(entry.staleness).toMatchObject({
      idleMs: 1000,
      staleness: "actively-executing",
      hasQueuedWork: false,
    });
    expect(report.totals.staleLocks).toBe(0);
    expect(report.totals.activelyExecuting).toBe(1);
  });

  it("splits exactly at the threshold: idle == threshold is stale, one ms less is not", async () => {
    const dir = makeTmpDir("drain-audit-threshold-");
    persistLegacy(dir, "audit.legacy.at", EnginePhase.Executing, NodeStatus.Running, {
      updatedAt: NOW - STALE_LOCK_IDLE_THRESHOLD_MS,
      frontier: [],
    });
    persistLegacy(dir, "audit.legacy.under", EnginePhase.Executing, NodeStatus.Running, {
      updatedAt: NOW - STALE_LOCK_IDLE_THRESHOLD_MS + 1,
      frontier: [],
    });

    const report = await auditGraphStore({ directory: dir, now: () => NOW });

    expect(entryOf(report, "engine-audit.legacy.at.json").staleness?.staleness).toBe(
      "stale-lock",
    );
    expect(
      entryOf(report, "engine-audit.legacy.under.json").staleness?.staleness,
    ).toBe("actively-executing");
    expect(report.totals).toMatchObject({ staleLocks: 1, activelyExecuting: 1, inFlight: 2 });
  });

  it("reports the threshold it applied, and clamps a future timestamp to zero idle", async () => {
    const dir = makeTmpDir("drain-audit-override-");
    // A record whose next update would be in the future (clock skew between the
    // writer and this reader) must read as "just now", never as ancient.
    persistLegacy(dir, "audit.legacy.future", EnginePhase.Executing, NodeStatus.Running, {
      updatedAt: NOW + 60_000,
      frontier: [],
    });

    const report = await auditGraphStore({
      directory: dir,
      now: () => NOW,
      staleAfterMs: 1000,
    });

    const entry = entryOf(report, "engine-audit.legacy.future.json");
    expect(entry.staleness).toMatchObject({
      lastUpdatedAt: NOW + 60_000,
      idleMs: 0,
      staleAfterMs: 1000,
      staleness: "actively-executing",
    });
  });

  it("reads the queue from the record's persisted FILE, not the loader's reset", async () => {
    const dir = makeTmpDir("drain-audit-pending-");
    // The record is WRITTEN with a deferred completion and it stays in the file:
    // that is what the process that wrote it actually left behind, and the drain
    // gate must not lose it.
    persistLegacy(dir, "audit.legacy.pending", EnginePhase.Executing, NodeStatus.Running, {
      updatedAt: NOW - LONG_IDLE_MS,
      frontier: [],
      pendingCompletions: ["A"],
    });

    // ...while the LOADER deliberately resets the field (R2(c): it describes the
    // critical section of the process that wrote the file, and hydrating it
    // would resurrect completions nobody can replay). The audit must not read
    // its queue through that reset.
    const rawFile = JSON.parse(
      readFileSync(
        join(engineStateDir(dir), "engine-audit.legacy.pending.json"),
        "utf-8",
      ),
    ) as { frontier: unknown; pendingCompletions: unknown };
    expect(rawFile.frontier).toEqual([]);
    expect(rawFile.pendingCompletions).toEqual(["A"]);
    expect(
      new EnginePersistence(dir).load("audit.legacy.pending")?.pendingCompletions,
    ).toEqual([]);

    const report = await auditGraphStore({ directory: dir, now: () => NOW });

    const entry = entryOf(report, "engine-audit.legacy.pending.json");
    expect(entry.classification).toBe("in-flight");
    expect(entry.staleness).toMatchObject({
      frontierEmpty: true,
      frontierSize: 0,
      pendingCompletionsEmpty: false,
      pendingCompletionsSize: 1,
      hasQueuedWork: true,
      staleness: "actively-executing",
    });
    expect(report.totals).toMatchObject({
      staleLocks: 0,
      activelyExecuting: 1,
      inFlight: 1,
    });
  });

  it("refuses stale-lock when EITHER file queue is non-empty, and reports both sizes", async () => {
    const dir = makeTmpDir("drain-audit-bothqueues-");
    // The invariant in one record: the FILE queues on both halves, so neither
    // half may be dropped from the report and the verdict may not be stale.
    persistLegacy(dir, "audit.legacy.both", EnginePhase.Executing, NodeStatus.Running, {
      updatedAt: NOW - LONG_IDLE_MS,
      frontier: ["A"],
      pendingCompletions: ["B"],
    });

    const report = await auditGraphStore({ directory: dir, now: () => NOW });

    const entry = entryOf(report, "engine-audit.legacy.both.json");
    expect(entry.staleness).toMatchObject({
      frontierEmpty: false,
      frontierSize: 1,
      pendingCompletionsEmpty: false,
      pendingCompletionsSize: 1,
      hasQueuedWork: true,
      staleness: "actively-executing",
    });
    // ...and the age is still reported, so the caller sees both halves.
    expect(entry.staleness?.idleMs).toBe(LONG_IDLE_MS);
    expect(report.totals).toMatchObject({ staleLocks: 0, activelyExecuting: 1 });
  });

  it("does not infer staleness for terminal or blocked records", async () => {
    const dir = makeTmpDir("drain-audit-noinfer-");
    await buildMixedStore(dir);

    const report = await auditGraphStore({ directory: dir, now: () => NOW });

    // A terminal record is quiescent: there is no lock to judge.
    expect(entryOf(report, "engine-audit.legacy.complete.json").staleness).toBeUndefined();
    // A blocked record is unreadable: nothing may be inferred from it.
    expect(entryOf(report, "engine-audit.corrupt.json").staleness).toBeUndefined();
    expect(entryOf(report, "engine-audit.outcome.stateversion.json").staleness).toBeUndefined();

    // The pair is the in-flight partition and nothing else.
    expect(report.totals.staleLocks + report.totals.activelyExecuting).toBe(
      report.totals.inFlight,
    );
    expect(report.totals.inFlight).toBe(2);
  });
});

// ── The ledger boundary ─────────────────────────────────────────────────────

describe("drain audit — the acceptance ledger", () => {
  it("reads an absent ledger as 'absent' without creating it", async () => {
    const dir = makeTmpDir("drain-audit-ledger-absent-");
    mkdirSync(engineStateDir(dir), { recursive: true });

    const result = await SqliteAcceptanceLedger.openReadOnly(engineStateDir(dir));

    expect(result.kind).toBe("absent");
    expect(existsSync(ledgerFilePath(engineStateDir(dir)))).toBe(false);
  });

  it("refuses a WAL-mode ledger before opening it, and touches neither it nor its side files", async () => {
    const dir = makeTmpDir("drain-audit-ledger-wal-");
    const fixture = await startOutcomeGraph(dir, "audit.outcome.running");
    fixture.ledger.close();
    const ledgerPath = ledgerFilePath(engineStateDir(dir));

    // Switch the VALID store to WAL and leave the writer connected with its
    // shared-memory index attached: this is the shape a read-only SQLite open
    // cannot read without attaching to (and rewriting) the -shm side file.
    const db = await createDatabase(ledgerPath);
    try {
      db.run("PRAGMA journal_mode = WAL");
      db.query("SELECT count(*) AS n FROM ledger_meta").get();
      // Not vacuous: the WAL store really carries its side files.
      expect(existsSync(ledgerPath + "-shm")).toBe(true);
      expect(existsSync(ledgerPath + "-wal")).toBe(true);
      const before = fingerprintTree(dir);

      // The open refuses it BY NAME, without a connection of its own.
      const opened = await SqliteAcceptanceLedger.openReadOnly(engineStateDir(dir));
      expect(opened.kind).toBe("refused");
      if (opened.kind !== "refused") throw new Error("expected a WAL refusal");
      expect(opened.problem).toBe("wal-journal-mode");

      // The audit inherits that as a blocker for the graph whose state lives
      // in it.
      const report = await auditGraphStore({ directory: dir });
      expect(report.ledger).toBe("refused");
      const entry = entryOf(report, "engine-audit.outcome.running.json");
      expect(entry.classification).toBe("blocked");
      expect(entry.blockerCodes).toEqual(["ledger-refused"]);
      expect(report.verdict).toBe("blocked");

      // Zero writes, side files included: the refusal happened before any
      // connection could attach to the shared-memory file.
      const after = fingerprintTree(dir);
      expect(Object.keys(after)).toEqual(Object.keys(before));
      expect(after).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("reports a declared outcome graph with no ledger store as in flight, never as a blocker", async () => {
    const dir = makeTmpDir("drain-audit-ledger-missing-");
    const built = buildDeclaredOutcomeGraph({
      declaration: linearDeclaration("audit.outcome.unstarted"),
    });
    persistDeclaredGraph(built, dir);
    expect(existsSync(ledgerFilePath(engineStateDir(dir)))).toBe(false);

    const report = await auditGraphStore({ directory: dir });

    // The store is ABSENT, not unreadable: nothing has ever been committed, so
    // the first execution is still owed — the run path creates the ledger and
    // starts the graph from the saved plan. A blocker here would invent an
    // unreadable record and stall the drain on work that is merely not started.
    expect(report.ledger).toBe("absent");
    expect(report.blockers).toEqual([]);
    const entry = entryOf(report, "engine-audit.outcome.unstarted.json");
    expect(entry.executionProtocolVersion).toBe(OUTCOME_PROTOCOL);
    expect(entry.protocol).toBe("outcome");
    expect(entry.classification).toBe("in-flight");
    expect(entry.hasState).toBe(false);
    expect(entry.armed).toEqual([]);
    expect(entry.unsettledEffects).toEqual([]);
    expect(entry.blockerCodes).toEqual([]);
    expect(report.totals).toMatchObject({
      files: 1,
      terminal: 0,
      inFlight: 1,
      blocked: 0,
      legacyInFlight: 0,
      outcomeInFlight: 1,
      unsettledEffects: 0,
    });
    expect(report.verdict).toBe("in-flight");
    expect(report.drained).toBe(false);
    // The audit read the store; it did not initialize one.
    expect(existsSync(ledgerFilePath(engineStateDir(dir)))).toBe(false);
  });

  it("lists a refused ledger as a store blocker and blocks the outcome graph that depends on it", async () => {
    const dir = makeTmpDir("drain-audit-ledger-refused-");
    const fixture = await startOutcomeGraph(dir, "audit.outcome.running");
    fixture.ledger.close();
    const ledgerPath = ledgerFilePath(engineStateDir(dir));
    expect(readFileSync(ledgerPath).byteLength).toBeGreaterThan(0);

    // A file under the ledger's name that holds no tables: not this build's
    // store. The audit must refuse it AND leave it exactly as it found it.
    writeFileSync(ledgerPath, "");

    const report = await auditGraphStore({ directory: dir });

    expect(report.ledger).toBe("refused");
    expect(report.blockers.map((entry) => entry.code)).toEqual([
      "ledger-refused",
      "ledger-refused",
    ]);
    expect(report.blockers[0]?.dimension).toBe("ledger");
    expect(report.blockers[0]?.file).toBeUndefined();
    const entry = entryOf(report, "engine-audit.outcome.running.json");
    expect(entry.classification).toBe("blocked");
    expect(entry.blockerCodes).toEqual(["ledger-refused"]);
    expect(report.verdict).toBe("blocked");
    expect(readFileSync(ledgerPath).byteLength).toBe(0);
  });

  it("blocks an outcome graph whose ledger row is unreadable instead of throwing", async () => {
    const dir = makeTmpDir("drain-audit-ledger-row-");
    const fixture = await startOutcomeGraph(dir, "audit.outcome.running");
    fixture.ledger.close();

    // Hand-edit the state row's body into something the store's own row gate
    // refuses (not JSON). The audit must REPORT it as a blocker, not crash.
    const db = await createDatabase(ledgerFilePath(engineStateDir(dir)));
    try {
      db.run(
        "UPDATE ledger_graph_state SET body = ? WHERE graph_id = ?",
        "this is not json",
        "audit.outcome.running",
      );
    } finally {
      db.close();
    }

    const report = await auditGraphStore({ directory: dir });

    const entry = entryOf(report, "engine-audit.outcome.running.json");
    expect(entry.classification).toBe("blocked");
    expect(entry.blockerCodes).toEqual(["state-unreadable"]);
    expect(report.blockers[0]?.code).toBe("state-unreadable");
    expect(report.blockers[0]?.detail).toContain("not readable JSON");
    expect(report.verdict).toBe("blocked");
  });
});

// ── Tool-surface wiring ─────────────────────────────────────────────────────

describe("drain audit — tool wiring", () => {
  it("is reachable through the additive graph_audit tool and the toolset method", async () => {
    const dir = makeTmpDir("drain-audit-tool-");
    persistLegacy(dir, "audit.legacy.running", EnginePhase.Executing, NodeStatus.Running);

    // The state store is configured through `stateDir` (the same option the
    // persisted `graph_status` scan reads); `directory` is the dispatch cwd.
    const tools = createGraphTools(undefined, { directory: "/tmp", stateDir: dir });
    const auditTool = tools.graph_audit;
    if (auditTool === undefined) throw new Error("graph_audit was not registered");
    const output = await auditTool.execute({}, makeToolContext());
    const parsed = JSON.parse(output as string) as DrainAuditReport;
    expect(parsed.verdict).toBe("in-flight");
    expect(parsed.totals.legacyInFlight).toBe(1);

    const toolset = createGraphToolSet({ stateDir: dir });
    const direct = await toolset.graph_audit();
    expect(direct.verdict).toBe("in-flight");
    expect(direct.totals).toEqual(parsed.totals);
  });
});

/** Minimal tool execution context (mirrors the registration tests'). */
function makeToolContext() {
  return {
    sessionID: "s1",
    messageID: "m1",
    agent: "test-agent",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

// ── Zero-write proof ────────────────────────────────────────────────────────

describe("drain audit — zero writes", () => {
  it("leaves every file byte- and mtime-identical after a full audit of the mixed store", async () => {
    const dir = makeTmpDir("drain-audit-nowrite-");
    await buildMixedStore(dir);

    // Not vacuous: the store really holds engine-state files AND a ledger.
    const ledgerPath = ledgerFilePath(engineStateDir(dir));
    expect(existsSync(ledgerPath)).toBe(true);
    const before = fingerprintTree(dir);
    expect(Object.keys(before).length).toBeGreaterThanOrEqual(9);

    // A fixed clock: the staleness block is a function of (store, now), so two
    // reports of an unchanged store agree only against the same instant. The
    // zero-write property under test does not depend on it either way.
    const first = await auditGraphStore({ directory: dir, now: () => NOW });
    const second = await auditGraphStore({ directory: dir, now: () => NOW });

    const after = fingerprintTree(dir);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(after).toEqual(before);
    expect(first.totals).toEqual(second.totals);
    expect(second.entries).toEqual(first.entries);
    expect(first.verdict).toBe("blocked");
  });
});
