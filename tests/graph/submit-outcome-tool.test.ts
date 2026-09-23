/**
 * `graph_submit_outcome` — the model-facing submission ingress (C3c).
 *
 * Covers the vertical path end to end through the TOOL: declare a plan, run its
 * first execution from that same saved plan (the startup sweep), submit an
 * outcome, watch the graph advance, and settle at the terminal. Also covered:
 * the caller cannot supply execution identity or the plan revision (forged args
 * are never read), a refusal returns structured repair diagnostics and writes
 * nothing, a REJECTED decision returns its per-requirement outcomes and leaves
 * the attempt open so a repaired submission can be accepted, pointing the tool
 * at a legacy v2 graph fails with a clear error, the registered tool exposes
 * exactly the minimum args, and the submission ingress is the ONLY completion
 * source for a declared graph (every legacy entry point refuses it and the
 * legacy dispatch port is never called).
 *
 * Every case runs in its own mkdtemp directory and removes it in a finally
 * block; nothing here writes outside a temp dir.
 */

import { describe, expect, it, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import {
  EnginePersistence,
  engineStateDir,
} from "../../src/graph/persistence/engine-persistence.ts";
import { createEngineState } from "../../src/graph/persistence/declared-state.ts";
import { OutcomeHost } from "../../src/graph/host/outcome-host.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import { proposalDigest } from "../../src/graph/outcome/proposal.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/runtime.ts";
import {
  createValidatorRegistry,
  type ValidationOutcome,
} from "../../src/graph/outcome/validators.ts";
import {
  OutcomeSubmissionRefusedError,
  type GraphSubmitOutcomeArgs,
  type GraphSubmitOutcomeResult,
} from "../../src/graph/tools/submit-outcome.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { createOutcomeGraphTools as createGraphTools } from "../../src/graph/tools/index.ts";
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";
import type { DispatchManager } from "../../src/dispatch/core/manager.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

/** work -> ship: one successor edge, one terminal outcome. */
const LINEAR: GraphDeclarationV3 = {
  version: 3,
  name: "tool.linear",
  nodes: [
    { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
    { id: "ship", agent: "agent.ship", prompt: "Ship it.", outcomes: [{ id: "delivered" }] },
  ],
  edges: [{ from: "work", to: "ship", outcome: "done" }],
};

/** The same shape, but "done" is gated by an exact validator identity. */
const GATED: GraphDeclarationV3 = {
  version: 3,
  name: "tool.gated",
  nodes: [
    {
      id: "work",
      agent: "agent.work",
      prompt: "Do the work.",
      outcomes: [{ id: "done", acceptance: [{ validator: "gate.check", version: 1 }] }],
    },
  ],
  edges: [],
};

const GATE_ID = "gate.check";
const GATE_VERSION = 1;

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** An idle dispatch-manager surface (kept for the shared fixture shape). */
function idleManager(): DispatchManager {
  const surface: Partial<DispatchManager> = {
    getTask: () => undefined,
    getTasksByParent: () => [],
    getEventState: () => new Map(),
  };
  return surface as DispatchManager;
}

/** A recorder for the outcome run path's dispatch seam. */
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

/**
 * Give the store's declared graphs their FIRST EXECUTION (or restart resume)
 * through the HOST's own entry — the same `OutcomeHost.recoverDeclaredGraphs`
 * the shipped hosts call at boot. The host is closed afterwards; the credential
 * vault it minted stays under the same store root the toolset's credential
 * capability reads.
 */
async function sweep(
  dir: string,
  requests: OutcomeDispatchRequest[],
): Promise<void> {
  const host = OutcomeHost.open({
    workspaceDir: dir,
    storeRoot: engineStateDir(dir),
    deliver: (request) => {
      requests.push(request);
    },
    durability: "memory",
  });
  try {
    await host.recoverDeclaredGraphs();
  } finally {
    host.close();
  }
}

/** Read the ledger of a workspace; the caller closes it. */
function openLedger(dir: string): Promise<SqliteAcceptanceLedger> {
  return SqliteAcceptanceLedger.create(engineStateDir(dir));
}

/** A minimal canonical tool context, mirroring the registration test helper. */
function makeContext() {
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

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

// ── The vertical path through the tool ──────────────────────────────────────

describe("graph_submit_outcome — the vertical path", () => {
  it("declares, runs the saved plan, accepts an outcome and settles at the terminal", async () => {
    const dir = makeTmpDir("submit-outcome-");
    const toolRequests: OutcomeDispatchRequest[] = [];
    const ts = createGraphToolSet({
      stateDir: dir,
      outcomeNow: NOW,
      outcomeDispatch: recorder(toolRequests),
      credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
    });
    const declared = ts.graph_declare({ declaration: LINEAR });
    const graphId = declared.graph_id;

    // FIRST EXECUTION: the host sweep starts the graph from the SAVED plan.
    const startRequests: OutcomeDispatchRequest[] = [];
    await sweep(dir, startRequests);
    expect(startRequests.map((request) => request.attemptId)).toEqual(["work#1"]);
    expect(startRequests[0]?.graphId).toBe(graphId);
    expect(startRequests[0]?.nodeId).toBe("work");

    // The worker reports its outcome through the model-facing ingress, carrying
    // back the credential its dispatch request handed it.
    const workCredential = credentialOf(startRequests, "work#1");
    const accepted: GraphSubmitOutcomeResult = await ts.graph_submit_outcome({
      graph_id: graphId,
      node_id: "work",
      outcome_id: "done",
      credential: workCredential,
    });
    expect(accepted.decision).toBe("accepted");
    expect(accepted.verdict).toBe("committed");
    expect(accepted.plan_revision).toBe(declared.plan_revision);
    expect(accepted.attempt_id).toBe("work#1");
    // Runtime provenance: the submission id is the canonical digest, and the
    // successor was launched in-process through the toolset's seam.
    expect(accepted.submission_id).toBe(
      "submission:" +
        proposalDigest({ nodeId: "work", outcomeId: "done", credential: workCredential }),
    );
    // The result does not echo the capability back into the transcript.
    expect(JSON.stringify(accepted)).not.toContain(workCredential);

    // No report surface echoes the capability back: the status JSON for the
    // declared graph does not carry the credential.
    const statusJson = ts.graph_status({ graph_id: graphId, scope: "persisted" });
    expect(statusJson).not.toContain(workCredential);
    expect(accepted.settled_nodes).toEqual(["work"]);
    expect(accepted.phase).toBe("executing");
    expect(accepted.refusals).toEqual([]);
    expect(toolRequests.map((request) => request.attemptId)).toEqual(["ship#2"]);

    // The successor's dispatch effect is STARTED — created through the tool
    // set's host in the same call (D8), never left as a `pending` row a later
    // recovery would create a second time. `work#1`'s effect is already DONE:
    // its attempt settled in this submission.
    const afterSuccessor = await openLedger(dir);
    try {
      expect(
        afterSuccessor
          .pendingEffects(graphId)
          .map((effect) => effect.effectId + "@" + effect.status),
      ).toEqual(["dispatch:ship#2@started"]);
    } finally {
      afterSuccessor.close();
    }

    // Terminal outcome ends the run.
    const last = await ts.graph_submit_outcome({
      graph_id: graphId,
      node_id: "ship",
      outcome_id: "delivered",
      credential: credentialOf(toolRequests, "ship#2"),
    });
    expect(last.decision).toBe("accepted");
    expect(last.phase).toBe("complete");
    // Plan order, not declaration order: the compiler fixes the node order.
    expect([...(last.settled_nodes ?? [])].sort()).toEqual(["ship", "work"]);

    // The durable record is the ledger: two accepted events, no unsettled
    // dispatch effect (each attempt's effect is DONE once that attempt settled)
    // and one graph-state row.
    const ledger = await openLedger(dir);
    try {
      // Both submissions were pinned to the same clock, so the ledger's
      // (accepted_at, attempt_id) order is the attempt-id tiebreak.
      expect(
        ledger
          .acceptedEvents(graphId)
          .map((event) => event.attemptId)
          .sort(),
      ).toEqual(["ship#2", "work#1"]);
      expect(ledger.pendingEffects(graphId)).toEqual([]);
      expect(ledger.readGraphState(graphId)?.planRevision).toBe(declared.plan_revision);
    } finally {
      ledger.close();
    }
  });

  it("derives identity and the plan revision itself: forged args cannot move them", async () => {
    const dir = makeTmpDir("submit-outcome-forge-");
    const toolRequests: OutcomeDispatchRequest[] = [];
    const ts = createGraphToolSet({
      stateDir: dir,
      outcomeNow: NOW,
      outcomeDispatch: recorder(toolRequests),
      credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
    });
    const declared = ts.graph_declare({ declaration: LINEAR });
    const graphId = declared.graph_id;
    const startRequests: OutcomeDispatchRequest[] = [];
    await sweep(dir, startRequests);

    // A caller CAN put these keys on the object it passes (the toolset method
    // reads only graph_id / node_id / outcome_id / credential / data /
    // evidence_refs). Every forged value is wrong on purpose; the credential is
    // the one it genuinely holds, and it still cannot name the attempt.
    const workCredential = credentialOf(startRequests, "work#1");
    // Deliberately carries keys the args type does not declare (the forgery
    // this case is about). `satisfies` keeps the extra keys visible to the
    // test while the value stays assignable to the args type, so the object is
    // not narrowed into a shape the tool could rely on.
    const forged = {
      graph_id: graphId,
      node_id: "work",
      outcome_id: "done",
      credential: workCredential,
      attempt_id: "forged-attempt",
      submission_id: "forged-submission",
      plan_revision: "forged-revision",
    } satisfies GraphSubmitOutcomeArgs & Record<string, string>;
    const first = await ts.graph_submit_outcome(forged);
    expect(first.decision).toBe("accepted");
    expect(first.plan_revision).toBe(declared.plan_revision);
    expect(first.attempt_id).toBe("work#1");
    expect(first.submission_id).toBe(
      "submission:" +
        proposalDigest({ nodeId: "work", outcomeId: "done", credential: workCredential }),
    );

    // The receipt is stored under the DERIVED key, and the state is bound to the
    // real plan revision — neither forged value exists in the store.
    const ledger = await openLedger(dir);
    try {
      const receipt = ledger.lookupReceipt({
        graphId,
        attemptId: "work#1",
        submissionId:
          "submission:" +
          proposalDigest({ nodeId: "work", outcomeId: "done", credential: workCredential }),
      });
      expect(receipt?.attemptId).toBe("work#1");
      expect(receipt?.planRevision).toBe(declared.plan_revision);
      expect(ledger.readGraphState(graphId)?.planRevision).toBe(declared.plan_revision);
      expect(
        ledger.lookupReceipt({
          graphId,
          attemptId: "forged-attempt",
          submissionId: "forged-submission",
        }),
      ).toBeUndefined();
    } finally {
      ledger.close();
    }

    // Repeating the submission with DIFFERENT forged identity replays the same
    // persisted receipt: the forged fields never entered the key.
    const forgedAgain = {
      ...forged,
      attempt_id: "another-forged-attempt",
      submission_id: "another-forged-submission",
      plan_revision: "another-forged-revision",
    };
    const again = await ts.graph_submit_outcome(forgedAgain);
    expect(again.verdict).toBe("replayed");
    expect(again.submission_id).toBe(first.submission_id);
  });

  it("returns structured repair diagnostics for a refusal and writes nothing", async () => {
    const dir = makeTmpDir("submit-outcome-refusal-");
    const toolRequests: OutcomeDispatchRequest[] = [];
    const ts = createGraphToolSet({
      stateDir: dir,
      outcomeNow: NOW,
      outcomeDispatch: recorder(toolRequests),
      credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
    });
    const declared = ts.graph_declare({ declaration: LINEAR });
    const graphId = declared.graph_id;
    const startRequests: OutcomeDispatchRequest[] = [];
    await sweep(dir, startRequests);
    const workCredential = credentialOf(startRequests, "work#1");

    // "ship" has no attempt in flight, and work's credential is never re-aimed
    // at it.
    const refused = await ts.graph_submit_outcome({
      graph_id: graphId,
      node_id: "ship",
      outcome_id: "delivered",
      credential: workCredential,
    });
    expect(refused.decision).toBeUndefined();
    expect(refused.refusals.map((entry) => entry.code)).toEqual([
      "credential-node-mismatch",
    ]);
    expect(refused.refusals[0]?.path).toBe("$.credential");

    // An outcome the node does not declare is refused with its own code.
    const undeclared = await ts.graph_submit_outcome({
      graph_id: graphId,
      node_id: "work",
      outcome_id: "ghost",
      credential: workCredential,
    });
    expect(undeclared.refusals.map((entry) => entry.code)).toContain(
      "undeclared-outcome",
    );

    // A malformed proposal (empty node id) is refused by the shape gate.
    const malformed = await ts.graph_submit_outcome({
      graph_id: graphId,
      node_id: "",
      outcome_id: "done",
      credential: workCredential,
    });
    expect(malformed.refusals.map((entry) => entry.code)).toContain(
      "malformed-proposal",
    );

    // A missing credential is a repairable refusal that names the field.
    const credentialless = await ts.graph_submit_outcome({
      graph_id: graphId,
      node_id: "work",
      outcome_id: "done",
    });
    expect(credentialless.refusals.map((entry) => entry.code)).toEqual([
      "credential-missing",
    ]);
    expect(credentialless.refusals[0]?.path).toBe("$.credential");

    // A tampered credential (same shape, one character changed) names no
    // recorded attempt.
    const tamperedValue =
      workCredential.slice(0, -1) + (workCredential.endsWith("0") ? "1" : "0");
    expect(tamperedValue).not.toBe(workCredential);
    const tampered = await ts.graph_submit_outcome({
      graph_id: graphId,
      node_id: "work",
      outcome_id: "done",
      credential: tamperedValue,
    });
    expect(tampered.refusals.map((entry) => entry.code)).toEqual([
      "credential-unknown",
    ]);

    // Nothing was written by any of the refusals: no event, and no dispatch
    // effect beyond the entry attempt's own D8 row (which `start()` committed
    // with the starting snapshot) — no successor was ever armed.
    const ledger = await openLedger(dir);
    try {
      expect(ledger.acceptedEvents(graphId)).toEqual([]);
      expect(ledger.pendingEffects(graphId).map((effect) => effect.effectId)).toEqual([
        "dispatch:work#1",
      ]);
    } finally {
      ledger.close();
    }
  });

  it("reports a rejected decision's per-requirement outcomes and accepts a repaired submission", async () => {
    const dir = makeTmpDir("submit-outcome-rejected-");
    let gate: ValidationOutcome = { kind: "fail", reason: "evidence is insufficient" };
    const toolRequests: OutcomeDispatchRequest[] = [];
    const ts = createGraphToolSet({
      stateDir: dir,
      outcomeNow: NOW,
      outcomeDispatch: recorder(toolRequests),
      credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
      outcomeValidators: createValidatorRegistry([
        { id: GATE_ID, version: GATE_VERSION, implementation: () => gate },
      ]),
    });
    const declared = ts.graph_declare({
      declaration: GATED,
      supported_validators: [{ validator: GATE_ID, version: GATE_VERSION }],
    });
    const graphId = declared.graph_id;
    const startRequests: OutcomeDispatchRequest[] = [];
    await sweep(dir, startRequests);
    const workCredential = credentialOf(startRequests, "work#1");

    const rejected = await ts.graph_submit_outcome({
      graph_id: graphId,
      node_id: "work",
      outcome_id: "done",
      credential: workCredential,
    });
    expect(rejected.decision).toBe("rejected");
    expect(rejected.verdict).toBe("committed");
    expect(rejected.requirements).toEqual([
      {
        validator: GATE_ID,
        version: GATE_VERSION,
        outcome: "fail",
        reason: "evidence is insufficient",
      },
    ]);
    expect(rejected.refusals).toEqual([]);
    // The attempt stays OPEN: a rejected receipt is not an accepted event.
    const afterRejection = await openLedger(dir);
    try {
      expect(afterRejection.acceptedEvents(graphId)).toEqual([]);
    } finally {
      afterRejection.close();
    }

    // Repair: the gate passes and the RESUBMISSION (different content, so a
    // different submission id) is accepted.
    gate = { kind: "pass" };
    const accepted = await ts.graph_submit_outcome({
      graph_id: graphId,
      node_id: "work",
      outcome_id: "done",
      credential: workCredential,
      data: { repaired: true },
    });
    expect(accepted.decision).toBe("accepted");
    expect(accepted.verdict).toBe("committed");
    expect(accepted.requirements).toEqual([
      { validator: GATE_ID, version: GATE_VERSION, outcome: "pass" },
    ]);
    const afterAcceptance = await openLedger(dir);
    try {
      expect(afterAcceptance.acceptedEvents(graphId)).toHaveLength(1);
    } finally {
      afterAcceptance.close();
    }
  });
});

// ── Addressing: declaration-only graphs, legacy graphs ──────────────────────

describe("graph_submit_outcome — the graphs it serves", () => {
  it("refuses a record pinned to the deleted legacy protocol, without opening a ledger", async () => {
    const dir = makeTmpDir("submit-outcome-legacy-");
    const ts = createGraphToolSet({ stateDir: dir });
    // A protocol-1 record — the deleted legacy run path — owns the id. The
    // loader refuses it as unsupported(execution), so this ingress reports an
    // unreadable plan and never treats it as a graph it serves.
    const state = createEngineState(
      { version: 2, name: "legacy.graph", nodes: [], edges: [] },
      "legacy.graph",
    );
    state.executionProtocolVersion = 1;
    new EnginePersistence(dir).save(state);

    let caught: unknown;
    try {
      await ts.graph_submit_outcome({
        graph_id: "legacy.graph",
        node_id: "A",
        outcome_id: "done",
      });
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof OutcomeSubmissionRefusedError)) {
      throw new Error("expected OutcomeSubmissionRefusedError, got " + String(caught));
    }
    expect(caught.reason).toBe("unreadable-plan");
    expect(caught.graphId).toBe("legacy.graph");
    // The refusal happened BEFORE the ledger was opened.
    expect(existsSync(join(engineStateDir(dir), "graph-acceptance-ledger.sqlite"))).toBe(
      false,
    );
  });

  it("refuses an unknown graph with a clear next step", async () => {
    const dir = makeTmpDir("submit-outcome-unknown-");
    const ts = createGraphToolSet({ stateDir: dir });
    let caught: unknown;
    try {
      await ts.graph_submit_outcome({
        graph_id: "never.declared",
        node_id: "work",
        outcome_id: "done",
      });
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof OutcomeSubmissionRefusedError)) {
      throw new Error("expected OutcomeSubmissionRefusedError, got " + String(caught));
    }
    expect(caught.reason).toBe("unknown-graph");
    expect(caught.message).toContain("graph_declare");
  });

  it("refuses a graph whose declared plan never reached the store", async () => {
    const ts = createGraphToolSet();
    const declared = ts.graph_declare({ declaration: LINEAR });
    let caught: unknown;
    try {
      await ts.graph_submit_outcome({
        graph_id: declared.graph_id,
        node_id: "work",
        outcome_id: "done",
      });
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof OutcomeSubmissionRefusedError)) {
      throw new Error("expected OutcomeSubmissionRefusedError, got " + String(caught));
    }
    expect(caught.reason).toBe("no-state-directory");
  });
});

// ── Registration and the single completion source ───────────────────────────

describe("graph_submit_outcome — registration and completion authority", () => {
  it("registers additively with exactly the minimum model-facing args", () => {
    const tools = createGraphTools(createGraphToolSet({ directory: "/tmp" }));
    expect(Object.keys(tools)).toContain("graph_submit_outcome");
    const def = tools.graph_submit_outcome;
    expect(def).toBeDefined();
    if (def === undefined) return;
    expect(Object.keys(def.args).sort()).toEqual([
      "credential",
      "data",
      "evidence_refs",
      "graph_id",
      "node_id",
      "outcome_id",
    ]);
    // No attempt, submission or plan-revision arg exists to supply.
    expect(def.args.attempt_id).toBeUndefined();
    expect(def.args.submission_id).toBeUndefined();
    expect(def.args.plan_revision).toBeUndefined();
    expect(def.args.graphId).toBeUndefined();
    expect(def.args.credential).toBeDefined();
  });

  it("executes through the registered tool and renders a legacy refusal as a clear failure", async () => {
    const dir = makeTmpDir("submit-outcome-registered-");
    const toolRequests: OutcomeDispatchRequest[] = [];
    const ts = createGraphToolSet({
      stateDir: dir,
      outcomeNow: NOW,
      outcomeDispatch: recorder(toolRequests),
      credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
    });
    const declared = ts.graph_declare({ declaration: LINEAR });
    const startRequests: OutcomeDispatchRequest[] = [];
    await sweep(dir, startRequests);
    const tools = createGraphTools(ts);
    const def = tools.graph_submit_outcome;
    if (def === undefined) throw new Error("graph_submit_outcome is not registered");
    const out = await def.execute(
      {
        graph_id: declared.graph_id,
        node_id: "work",
        outcome_id: "done",
        credential: credentialOf(startRequests, "work#1"),
      },
      makeContext(),
    );
    const parsed: unknown = JSON.parse(String(out));
    expect(parsed).toMatchObject({ decision: "accepted", attempt_id: "work#1" });

    // The credential is OPTIONAL at the registered boundary: a call without one
    // is the structured `credential-missing` refusal, not a schema error.
    const credentialless = await def.execute(
      { graph_id: declared.graph_id, node_id: "work", outcome_id: "done" },
      makeContext(),
    );
    expect(JSON.parse(String(credentialless))).toMatchObject({
      refusals: [{ code: "credential-missing", path: "$.credential" }],
    });

    // An id this ingress does not serve renders as a clear tool failure.
    const failed = await def.execute(
      { graph_id: "never.declared", node_id: "A", outcome_id: "done" },
      makeContext(),
    );
    expect(String(failed)).toContain("graph_submit_outcome failed:");
  });

  it("is the ONLY completion source on the shipped tool face", async () => {
    const dir = makeTmpDir("submit-outcome-authority-");
    const toolRequests: OutcomeDispatchRequest[] = [];
    const ts = createGraphToolSet({
      stateDir: dir,
      outcomeNow: NOW,
      outcomeDispatch: recorder(toolRequests),
      credentialIsolation: testHostCredentialIsolation(engineStateDir(dir)),
    });
    const declared = ts.graph_declare({ declaration: LINEAR });
    const graphId = declared.graph_id;
    const startRequests: OutcomeDispatchRequest[] = [];
    await sweep(dir, startRequests);

    // The shipped face registers exactly the outcome entries: no legacy
    // construction/execution key exists that could settle a node.
    const face = createGraphTools(ts);
    expect(Object.keys(face).sort()).toEqual([
      "graph_audit",
      "graph_declare",
      "graph_status",
      "graph_submit_outcome",
    ]);

    // The only settlement on record came from the submission ingress.
    const accepted = await ts.graph_submit_outcome({
      graph_id: graphId,
      node_id: "work",
      outcome_id: "done",
      credential: credentialOf(startRequests, "work#1"),
    });
    expect(accepted.decision).toBe("accepted");
    const ledger = await openLedger(dir);
    try {
      const events = ledger.acceptedEvents(graphId);
      expect(events).toHaveLength(1);
      expect(events[0]?.attemptId).toBe("work#1");
    } finally {
      ledger.close();
    }
  });
});
