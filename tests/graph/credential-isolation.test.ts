/**
 * Credential isolation as the OUTCOME run path's production enablement
 * condition (D7).
 *
 * THE REPRODUCED DEFECT THIS FILE PINS. A process that only READS the
 * acceptance ledger — no write, no rebind — obtains another attempt's
 * credential and is ACCEPTED when it submits with it. This build writes that
 * ledger as an ordinary file, so it cannot prevent the read (proved on the real
 * store below, with the file byte-identical across the read); what it CAN do is
 * refuse to enable a run path whose credentials it cannot protect.
 *
 * Covered here, all through real calls:
 * - the refusal: `start`, `resume`, `submit`, the model-facing ingress and
 *   the startup sweep all report `credential-isolation-unavailable` with a
 *   diagnostic naming the host obligation, and none of them writes anything;
 * - the enablement: a host adapter is the ONLY thing that turns the path on, and
 *   its declared `credentialStoreRoot` is where the ledger is opened;
 * - the honest limitation: with a host adapter declared, reading the store still
 *   yields another attempt's credential — the host, not this build, owns that
 *   boundary;
 * - the exposure surface: the credential reaches the dispatch seam and appears
 *   in NO report channel — the ingress result, `graph_status`, the
 *   `<graph_state>` block, `graph_audit`, the startup sweep's report, the
 *   runtime's armed/unsettled/refusal readings, the `graph_declare` result,
 *   and the refusal texts for a missing or tampered credential.
 *
 * Every case runs in its own mkdtemp directory and removes it in a finally
 * block; nothing here writes outside a temp dir.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { auditGraphStore } from "../../src/graph/audit/drain-audit.ts";
import {
  engineStateDir,
  engineStatePath,
} from "../../src/graph/engine/engine-persistence.ts";
import { buildEngineGraphStateBlock } from "../../src/graph/engine/graph-state-block.ts";
import {
  recoverInterruptedGraphs,
  type RecoveryStartupReport,
} from "../../src/graph/engine/engine-startup.ts";
import {
  LEDGER_FILE_NAME,
  SqliteAcceptanceLedger,
  ledgerFilePath,
} from "../../src/graph/ledger/sqlite-ledger.ts";
import {
  credentialIsolationRefusal,
  readCredentialIsolationAdapter,
} from "../../src/graph/outcome/credential-isolation.ts";
import {
  OutcomeGraphRuntime,
  type OutcomeDispatchRequest,
  type OutcomeResumeResult,
} from "../../src/graph/outcome/runtime.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { buildDeclaredOutcomeGraph } from "../../src/graph/tools/declare-graph.ts";
import { OutcomeSubmissionRefusedError } from "../../src/graph/tools/submit-outcome.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { createGraphTools } from "../../src/graph/tools/index.ts";
import type { DispatchManager } from "../../src/dispatch/core/manager.ts";
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

/**
 * alpha and beta are BOTH entry nodes: one start dispatches both, so the
 * ledger holds two live attempt credentials at once — exactly the population a
 * same-account reader would harvest.
 */
const TWO_ENTRIES: GraphDeclarationV3 = {
  version: 3,
  name: "credential.two-entries",
  nodes: [
    { id: "alpha", agent: "agent.alpha", prompt: "Do alpha.", outcomes: [{ id: "done" }] },
    { id: "beta", agent: "agent.beta", prompt: "Do beta.", outcomes: [{ id: "done" }] },
  ],
  edges: [],
};

/** work -> ship: the smallest graph that mints a successor credential. */
const LINEAR: GraphDeclarationV3 = {
  version: 3,
  name: "credential.linear",
  nodes: [
    { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
    { id: "ship", agent: "agent.ship", prompt: "Ship it.", outcomes: [{ id: "delivered" }] },
  ],
  edges: [{ from: "work", to: "ship", outcome: "done" }],
};

/** A deterministic credential so a test can name the attempt it holds. */
const perAttemptCredential = (binding: { nodeId: string; attemptId: string }) =>
  "credential:" + binding.nodeId + "#" + binding.attemptId;

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

/** The dispatch surface the sweep touches for legacy graphs; nothing here. */
function idleManager(): DispatchManager {
  const surface: Partial<DispatchManager> = {
    getTask: () => undefined,
    getTasksByParent: () => [],
    getEventState: () => new Map(),
  };
  return surface as DispatchManager;
}

/** A dispatch seam that records every request, credential included. */
function recorder(into: OutcomeDispatchRequest[]) {
  return (request: OutcomeDispatchRequest): void => {
    into.push(request);
  };
}

/** The credential one dispatched attempt carried, failing when it never ran. */
function credentialOf(
  requests: readonly OutcomeDispatchRequest[],
  attemptId: string,
): string {
  const found = requests.find((request) => request.attemptId === attemptId);
  if (found === undefined) {
    throw new Error(
      "fixture: no dispatch request for attempt " +
        attemptId +
        " (dispatched: " +
        requests.map((request) => request.attemptId).join(", ") +
        ")",
    );
  }
  return found.credential;
}

/** One field of an unknown record value, for ledger-body navigation. */
function fieldOf(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[field];
}

/** The attempt credential a persisted state BODY records for one node. */
function credentialInBody(body: unknown, nodeId: string): string | undefined {
  const nodes = fieldOf(body, "nodes");
  if (!Array.isArray(nodes)) return undefined;
  for (const node of nodes) {
    if (fieldOf(node, "nodeId") !== nodeId) continue;
    const credential = fieldOf(node, "attemptCredential");
    if (typeof credential === "string") return credential;
  }
  return undefined;
}

/**
 * Assert one channel carried none of the credentials under test.
 *
 * Throws (rather than expecting) so the failure names the CHANNEL and the
 * leaked value: without that, a leaking surface and a broken fixture look the
 * same. The values are test credentials minted by this file, never real ones.
 */
function expectNoCredential(
  label: string,
  text: string,
  credentials: readonly string[],
): void {
  const leaked = credentials.filter((credential) => text.includes(credential));
  if (leaked.length > 0) {
    throw new Error(
      label +
        " carried attempt credential(s) " +
        leaked.map((credential) => JSON.stringify(credential)).join(", "),
    );
  }
}

/** The report half of a resume result: everything except the dispatch channel. */
function resumeReport(result: OutcomeResumeResult): unknown {
  if (result.kind === "refused") {
    return { kind: result.kind, refusals: result.refusals };
  }
  return {
    kind: result.kind,
    armed: result.armed,
    unsettledEffects: result.unsettledEffects,
    refusals: result.refusals,
    stop: result.kind === "resumed" ? result.stop : undefined,
  };
}

/** The raw text of one persisted engine state, for the store checks. */
function readStateRecord(dir: string, graphId: string): string {
  return readFileSync(engineStatePath(dir, graphId), "utf-8");
}

// ── The gate ────────────────────────────────────────────────────────────────

describe("credential isolation is the outcome run path's enablement condition", () => {
  it("refuses start, resume and submit with credential-isolation-unavailable and writes nothing", async () => {
    const dir = makeTmpDir("credential-gate-");
    const plan = buildDeclaredOutcomeGraph({ declaration: TWO_ENTRIES }).plan;
    const ledger = await SqliteAcceptanceLedger.create(engineStateDir(dir));
    try {
      const runtime = new OutcomeGraphRuntime({
        plan,
        ledger,
        dispatch: () => undefined,
        validators: createValidatorRegistry([]),
        artifactRoot: dir,
        clock: () => NOW,
        mintCredential: perAttemptCredential,
      });

      const started = runtime.start(NOW);
      expect(started.kind).toBe("refused");
      if (started.kind !== "refused") return;
      expect(started.refusals.map((refusal) => refusal.code)).toEqual([
        "credential-isolation-unavailable",
      ]);
      expect(started.refusals[0]?.path).toBe("$.credentialIsolation");
      // The diagnostic names the exact host obligation, not just the code.
      const message = started.refusals[0]?.message ?? "";
      expect(message).toContain("protectedCredentialStore");
      expect(message).toContain("perAttemptDelivery");
      expect(message).toContain("credentialStoreRoot");

      const resumed = runtime.resume(NOW);
      expect(resumed.kind).toBe("refused");
      if (resumed.kind === "refused") {
        expect(resumed.refusals.map((refusal) => refusal.code)).toEqual([
          "credential-isolation-unavailable",
        ]);
      }

      const submitted = runtime.submit(
        { nodeId: "alpha", outcomeId: "done", credential: "any-credential" },
        NOW,
      );
      expect(submitted.kind).toBe("refused");
      if (submitted.kind === "refused") {
        expect(submitted.refusals.map((refusal) => refusal.code)).toEqual([
          "credential-isolation-unavailable",
        ]);
      }

      // NONE of the three wrote: no state, no receipt, no event, no effect.
      expect(ledger.readGraphState(plan.graphId)).toBeUndefined();
      expect(ledger.acceptedEvents(plan.graphId)).toEqual([]);
      expect(ledger.pendingEffects(plan.graphId)).toEqual([]);
    } finally {
      ledger.close();
    }
  });

  it("reads a capability strictly: no shape, no version, no false guarantee", () => {
    const valid: unknown = {
      version: 1,
      id: "host:protected-ledger",
      credentialStoreRoot: "/protected/credential-store",
      guarantees: { protectedCredentialStore: true, perAttemptDelivery: true },
    };
    const read = readCredentialIsolationAdapter(valid);
    expect(JSON.stringify(read)).toBe(JSON.stringify(valid));
    expect(read?.version).toBe(1);
    expect(read?.id).toBe("host:protected-ledger");
    expect(read?.credentialStoreRoot).toBe("/protected/credential-store");
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read?.guarantees)).toBe(true);
    expect(credentialIsolationRefusal(read)).toBeUndefined();

    const guarantees = { protectedCredentialStore: true, perAttemptDelivery: true };
    const rejected: readonly (readonly [string, unknown])[] = [
      ["absent", undefined],
      ["a non-record", "host:protected-ledger"],
      ["an array", []],
      [
        "a different version",
        { version: 2, id: "h", credentialStoreRoot: "/p", guarantees },
      ],
      ["an empty id", { version: 1, id: "", credentialStoreRoot: "/p", guarantees }],
      [
        "an empty store root",
        { version: 1, id: "h", credentialStoreRoot: "", guarantees },
      ],
      [
        "an extra key",
        { version: 1, id: "h", credentialStoreRoot: "/p", guarantees, extra: true },
      ],
      [
        "a false store guarantee",
        {
          version: 1,
          id: "h",
          credentialStoreRoot: "/p",
          guarantees: { protectedCredentialStore: false, perAttemptDelivery: true },
        },
      ],
      [
        "a missing delivery guarantee",
        {
          version: 1,
          id: "h",
          credentialStoreRoot: "/p",
          guarantees: { protectedCredentialStore: true },
        },
      ],
    ];
    for (const [label, value] of rejected) {
      expect(readCredentialIsolationAdapter(value), label).toBeUndefined();
      const refusal = credentialIsolationRefusal(value);
      expect(refusal?.code, label).toBe("credential-isolation-unavailable");
      expect(refusal?.message.length ?? 0, label).toBeGreaterThan(0);
    }
    // A malformed capability is refused BY NAME, never downgraded to a run.
    expect(credentialIsolationRefusal(rejected[7]?.[1])?.message).toContain(
      "refused rather than downgraded",
    );
    // The absent case explains the fact this build cannot change.
    expect(credentialIsolationRefusal(undefined)?.message).toContain(
      "cannot protect the attempt credentials it persists",
    );
  });

  it("enables the path with a host capability: dispatch, submit, restart and resume", async () => {
    const dir = makeTmpDir("credential-enabled-");
    const adapter = testHostCredentialIsolation(dir);
    const plan = buildDeclaredOutcomeGraph({ declaration: LINEAR }).plan;
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const requests: OutcomeDispatchRequest[] = [];
      const runtime = new OutcomeGraphRuntime({
        plan,
        ledger,
        dispatch: recorder(requests),
        validators: createValidatorRegistry([]),
        artifactRoot: dir,
        clock: () => NOW,
        mintCredential: perAttemptCredential,
        credentialIsolation: adapter,
      });
      const started = runtime.start(NOW);
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      expect(started.dispatched.map((request) => request.attemptId)).toEqual(["work#1"]);
      const workCredential = credentialOf(requests, "work#1");

      const accepted = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: workCredential },
        NOW + 1,
      );
      expect(accepted.kind).toBe("accepted");
      if (accepted.kind !== "accepted") return;
      expect(accepted.state.phase).toBe("executing");
      expect(accepted.dispatched.map((request) => request.attemptId)).toEqual(["ship#2"]);

      // A RESTART: a fresh runtime over the same ledger, with the capability.
      const restarted = new OutcomeGraphRuntime({
        plan,
        ledger,
        dispatch: () => undefined,
        validators: createValidatorRegistry([]),
        artifactRoot: dir,
        clock: () => NOW,
        mintCredential: perAttemptCredential,
        credentialIsolation: adapter,
      });
      const resumed = restarted.resume(NOW + 2);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") return;
      expect(resumed.armed.map((node) => node.attemptId)).toEqual(["ship#2"]);
    } finally {
      ledger.close();
    }
  });

  it("opens the ledger at the store root the host declared, not the workspace default", async () => {
    const workspace = makeTmpDir("credential-workspace-");
    const protectedRoot = makeTmpDir("credential-protected-");
    const adapter = testHostCredentialIsolation(protectedRoot);
    const toolRequests: OutcomeDispatchRequest[] = [];
    const ts = createGraphToolSet({
      stateDir: workspace,
      outcomeNow: NOW,
      // The ingress refuses without a dispatch adapter (D8); this one routes
      // the successor the submission arms.
      outcomeDispatch: recorder(toolRequests),
      credentialIsolation: adapter,
    });
    const declared = ts.graph_declare({ declaration: LINEAR });

    const startRequests: OutcomeDispatchRequest[] = [];
    const sweep: RecoveryStartupReport = await recoverInterruptedGraphs({
      directory: workspace,
      manager: idleManager(),
      stateDir: workspace,
      outcomeNow: NOW,
      outcomeDispatch: recorder(startRequests),
      outcomeCredentialIsolation: adapter,
    });
    expect(sweep.outcomeProtocol?.started).toHaveLength(1);
    expect(sweep.outcomeProtocol?.refused).toEqual([]);
    expect(existsSync(join(protectedRoot, LEDGER_FILE_NAME))).toBe(true);
    expect(existsSync(join(engineStateDir(workspace), LEDGER_FILE_NAME))).toBe(false);

    const accepted = await ts.graph_submit_outcome({
      graph_id: declared.graph_id,
      node_id: "work",
      outcome_id: "done",
      credential: credentialOf(startRequests, "work#1"),
    });
    expect(accepted.decision).toBe("accepted");
    expect(accepted.attempt_id).toBe("work#1");
  });
});

// ── The limitation the gate exists for ──────────────────────────────────────

describe("this build cannot protect the store — so it refuses to run without a host", () => {
  it("yields another attempt's credential from a read-only ledger read, and that credential is accepted", async () => {
    const dir = makeTmpDir("credential-read-");
    const plan = buildDeclaredOutcomeGraph({ declaration: TWO_ENTRIES }).plan;
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const requests: OutcomeDispatchRequest[] = [];
      const runtime = new OutcomeGraphRuntime({
        plan,
        ledger,
        dispatch: recorder(requests),
        validators: createValidatorRegistry([]),
        artifactRoot: dir,
        clock: () => NOW,
        mintCredential: perAttemptCredential,
        credentialIsolation: testHostCredentialIsolation(dir),
      });
      const started = runtime.start(NOW);
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const alphaCredential = credentialOf(requests, "alpha#1");
      const betaCredential = credentialOf(requests, "beta#2");
      expect(alphaCredential).not.toBe(betaCredential);

      // THE READ: the store's own READ-ONLY open — the same one the audit uses
      // — and NOTHING else. The file is byte-identical afterwards.
      const digestBefore = createHash("sha256")
        .update(readFileSync(ledgerFilePath(dir)))
        .digest("hex");
      const opened = await SqliteAcceptanceLedger.openReadOnly(dir);
      if (opened.kind !== "opened") {
        throw new Error("fixture: the ledger did not open read-only (" + opened.kind + ")");
      }
      let stolen: string | undefined;
      try {
        const record = opened.ledger.readGraphState(plan.graphId);
        stolen = credentialInBody(record?.body, "beta");
      } finally {
        opened.ledger.close();
      }
      const digestAfter = createHash("sha256")
        .update(readFileSync(ledgerFilePath(dir)))
        .digest("hex");
      expect(digestAfter).toBe(digestBefore);

      // The credential the alpha worker was never handed is now in hand — and
      // the protocol ACCEPTS it, because a bearer token cannot tell who read
      // it. THAT is why the host, not this build, must own the boundary.
      expect(stolen).toBe(betaCredential);
      expect(stolen).not.toBe(alphaCredential);
      const accepted = runtime.submit(
        { nodeId: "beta", outcomeId: "done", credential: stolen },
        NOW + 1,
      );
      expect(accepted.kind).toBe("accepted");
      if (accepted.kind === "accepted") {
        expect(accepted.decision.identity.attemptId).toBe("beta#2");
      }
    } finally {
      ledger.close();
    }
  });
});

// ── The exposure surface ────────────────────────────────────────────────────

describe("no report channel carries an attempt credential", () => {
  it("carries the credential only over the dispatch channel and in no report surface", async () => {
    const workspace = makeTmpDir("credential-surface-");
    const adapter = testHostCredentialIsolation(engineStateDir(workspace));
    const ts = createGraphToolSet({
      stateDir: workspace,
      outcomeNow: NOW,
      credentialIsolation: adapter,
      outcomeDispatch: recorder([]),
      outcomeValidators: createValidatorRegistry([]),
    });
    const declared = ts.graph_declare({ declaration: TWO_ENTRIES });
    const graphId = declared.graph_id;

    // FIRST EXECUTION through the sweep, recording what the dispatch seam got.
    const requests: OutcomeDispatchRequest[] = [];
    const sweep: RecoveryStartupReport = await recoverInterruptedGraphs({
      directory: workspace,
      manager: idleManager(),
      stateDir: workspace,
      outcomeNow: NOW,
      outcomeDispatch: recorder(requests),
      outcomeCredentialIsolation: adapter,
    });
    const alphaCredential = credentialOf(requests, "alpha#1");
    const betaCredential = credentialOf(requests, "beta#2");
    expect(requests).toHaveLength(2);

    // POSITIVE CONTROL: the probe can see credentials where they DO travel,
    // so a clean reading below is evidence rather than a broken assertion.
    expect(JSON.stringify(requests)).toContain(alphaCredential);
    expect(JSON.stringify(requests)).toContain(betaCredential);

    const credentials = [alphaCredential, betaCredential];

    // 1. The ingress result for beta's accepted outcome.
    const accepted = await ts.graph_submit_outcome({
      graph_id: graphId,
      node_id: "beta",
      outcome_id: "done",
      credential: betaCredential,
    });
    expect(accepted.decision).toBe("accepted");
    expectNoCredential("graph_submit_outcome result", JSON.stringify(accepted), credentials);

    // 2. The runtime's own restart reading (armed / unsettled / refusals). The
    //    dispatched requests and the typed state are the dispatch and host
    //    channels, so they are excluded on purpose.
    const ledger = await SqliteAcceptanceLedger.create(engineStateDir(workspace));
    try {
      const restarted = new OutcomeGraphRuntime({
        plan: buildDeclaredOutcomeGraph({ declaration: TWO_ENTRIES }).plan,
        ledger,
        dispatch: () => undefined,
        validators: createValidatorRegistry([]),
        artifactRoot: workspace,
        clock: () => NOW,
        mintCredential: perAttemptCredential,
        credentialIsolation: adapter,
      });
      const resumed = restarted.resume(NOW + 3);
      expectNoCredential("resume report", JSON.stringify(resumeReport(resumed)), credentials);
    } finally {
      ledger.close();
    }

    // 3. graph_status, the shared <graph_state> block and graph_declare.
    let statusError: unknown;
    try {
      ts.graph_status({ graph_id: graphId });
    } catch (error) {
      statusError = error;
    }
    expect(statusError).toBeInstanceOf(Error);
    expectNoCredential("graph_status refusal", String(statusError), credentials);
    expectNoCredential(
      "<graph_state> block",
      buildEngineGraphStateBlock(ts.liveEngineStates()),
      credentials,
    );
    expectNoCredential("graph_declare result", JSON.stringify(declared), credentials);

    // 4. The worker-facing audit TOOL (registered surface) and the audit
    //    function that backs it.
    const registered = createGraphTools(undefined, { toolset: ts });
    const auditTool = registered.graph_audit;
    if (auditTool === undefined) throw new Error("graph_audit is not registered");
    const auditText = String(
      await auditTool.execute(
        {},
        {
          sessionID: "s1",
          messageID: "m1",
          agent: "test-agent",
          directory: workspace,
          worktree: workspace,
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        },
      ),
    );
    expectNoCredential("graph_audit tool", auditText, credentials);
    expectNoCredential(
      "auditGraphStore report",
      JSON.stringify(await auditGraphStore({ directory: workspace })),
      credentials,
    );

    // 5. The startup sweep's report for the SAME store.
    expectNoCredential("startup sweep report", JSON.stringify(sweep), credentials);

    // 6. Refusal texts: a missing credential and a tampered one are refused
    //    without echoing the value they were given.
    const missing = await ts.graph_submit_outcome({
      graph_id: graphId,
      node_id: "alpha",
      outcome_id: "done",
    });
    expect(missing.refusals.map((refusal) => refusal.code)).toEqual([
      "credential-missing",
    ]);
    expectNoCredential("credential-missing refusal", JSON.stringify(missing), credentials);

    const tamperedValue = "tampered:" + betaCredential;
    const tampered = await ts.graph_submit_outcome({
      graph_id: graphId,
      node_id: "alpha",
      outcome_id: "done",
      credential: tamperedValue,
    });
    expect(tampered.refusals.map((refusal) => refusal.code)).toEqual([
      "credential-unknown",
    ]);
    expectNoCredential("credential-unknown refusal", JSON.stringify(tampered), credentials);
  });

  it("strips an attempt credential a failing dispatch seam echoed in its error", async () => {
    const dir = makeTmpDir("credential-seam-");
    const adapter = testHostCredentialIsolation(dir);
    const plan = buildDeclaredOutcomeGraph({ declaration: LINEAR }).plan;
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const requests: OutcomeDispatchRequest[] = [];
      let failLaunch = false;
      const seam = (request: OutcomeDispatchRequest): void => {
        requests.push(request);
        if (failLaunch) {
          // The plausible adapter bug this guards against: the failure text
          // echoes the request it was just handed, credential included.
          throw new Error("host dispatch adapter failed on " + JSON.stringify(request));
        }
      };
      // The adapter is a HOST (D8): the seam creates, and the query answers
      // `absent` so the recovery's create is the path under test — a create
      // that throws is the one whose report must be credential-free.
      let created = 0;
      const host = {
        create: (request: OutcomeDispatchRequest): void => {
          created += 1;
          seam(request);
        },
        lookup: () => ({ kind: "absent" }) as const,
      };
      const runtime = new OutcomeGraphRuntime({
        plan,
        ledger,
        dispatch: host,
        validators: createValidatorRegistry([]),
        artifactRoot: dir,
        clock: () => NOW,
        mintCredential: perAttemptCredential,
        credentialIsolation: adapter,
      });
      const started = runtime.start(NOW);
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      const workCredential = credentialOf(requests, "work#1");

      // The SUCCESSOR launch fails: the worker submitting `work` must not
      // receive `ship`'s credential back through the thrown error.
      failLaunch = true;
      let caught: unknown;
      try {
        runtime.submit(
          { nodeId: "work", outcomeId: "done", credential: workCredential },
          NOW + 1,
        );
      } catch (error) {
        caught = error;
      }
      const shipCredential = credentialOf(requests, "ship#2");
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).toContain("[redacted attempt credential]");
      expect(message).not.toContain(shipCredential);
      expect(message).not.toContain(workCredential);
      // The unsanitized text stays available to the IN-PROCESS caller only.
      const cause = fieldOf(caught, "cause");
      expect(String(fieldOf(cause, "message"))).toContain(shipCredential);

      // The RESUME path reports the same failure as a refusal, sanitized too.
      // The host still answers `absent` for the successor's effect — the create
      // that threw left the row PENDING, never falsely `started` — so recovery
      // re-issues the create, it throws again, and the REPORT must stay clean.
      const createsBefore = created;
      const restarted = new OutcomeGraphRuntime({
        plan,
        ledger,
        dispatch: host,
        validators: createValidatorRegistry([]),
        artifactRoot: dir,
        clock: () => NOW,
        mintCredential: perAttemptCredential,
        credentialIsolation: adapter,
      });
      const resumed = restarted.resume(NOW + 2);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") return;
      expect(resumed.refusals.map((refusal) => refusal.code)).toContain("dispatch-failed");
      // The failed create really was re-issued — the row was NOT marked started
      // by a call that threw (D8), which is why the host saw a second attempt.
      expect(created).toBe(createsBefore + 1);
      expectNoCredential(
        "resume dispatch-failed refusal",
        JSON.stringify(resumeReport(resumed)),
        [workCredential, shipCredential],
      );
    } finally {
      ledger.close();
    }
  });

  it("refuses the ingress and the sweep before opening a ledger when no capability is installed", async () => {
    const workspace = makeTmpDir("credential-no-host-");
    const ts = createGraphToolSet({ stateDir: workspace, outcomeNow: NOW });
    const declared = ts.graph_declare({ declaration: LINEAR });
    expect(readStateRecord(workspace, declared.graph_id).length).toBeGreaterThan(0);

    let caught: unknown;
    try {
      await ts.graph_submit_outcome({
        graph_id: declared.graph_id,
        node_id: "work",
        outcome_id: "done",
        credential: "credential:work#work#1",
      });
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof OutcomeSubmissionRefusedError)) {
      throw new Error("expected OutcomeSubmissionRefusedError, got " + String(caught));
    }
    expect(caught.reason).toBe("credential-isolation-unavailable");
    expect(caught.message).toContain("credential-isolation-unavailable");
    // NOTHING was opened: the refusal precedes SqliteAcceptanceLedger.create.
    expect(existsSync(join(engineStateDir(workspace), LEDGER_FILE_NAME))).toBe(false);

    // The startup sweep refuses the same way, and ALSO opens no ledger.
    const sweep = await recoverInterruptedGraphs({
      directory: workspace,
      manager: idleManager(),
      stateDir: workspace,
      outcomeNow: NOW,
    });
    expect(sweep.outcomeProtocol?.refused).toHaveLength(1);
    expect(sweep.outcomeProtocol?.refused[0]).toContain(
      "credential-isolation-unavailable",
    );
    expect(sweep.outcomeProtocol?.started).toEqual([]);
    expect(sweep.outcomeProtocol?.resumed).toEqual([]);
    expect(existsSync(join(engineStateDir(workspace), LEDGER_FILE_NAME))).toBe(false);
    // The declaration is still on disk, unmoved: a refusal is not a deletion.
    expect(readStateRecord(workspace, declared.graph_id).length).toBeGreaterThan(0);
  });
});
