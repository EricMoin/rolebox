/**
 * E-gate step 1 — no NEW durable legacy record (regression tests).
 *
 * Stage E opens with "stop creating new legacy graphs"
 * (docs/graph-outcome-protocol.md § "Implementation order and release gates"),
 * and this file pins the boundary of that stop:
 *
 * 1. THE DECISION IS A VALUE. `legacyGraphCreationRefusal` refuses exactly one
 *    situation — a configured store holds NO record for the graph id — and
 *    allows every other one, including a record it cannot read (that is the
 *    audit's blocker to report, not this gate's).
 * 2. THE TOOL SURFACE REFUSES, AND WRITES NOTHING. A fresh legacy graph on a
 *    configured store throws the coded refusal before any dispatch, and the
 *    store is not even created; a dry run is still allowed because it writes
 *    nothing.
 * 3. THE LEGACY PATH IS NOT RETIRED. The same graph runs with no store
 *    configured, and an EXISTING record is resumed — recovery, resume and
 *    rebuild are never refused, which is what draining the in-flight graphs
 *    requires.
 * 4. THE DEFECT THE GATE CLOSES IS REPRODUCED (characterization). A record
 *    written with no execution-protocol identity is BOUND to protocol 1 by the
 *    format-2 decoder's backfill, so before this gate every new legacy graph
 *    entered the store indistinguishable from a historical one.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import {
  EnginePersistence,
  engineStateDir,
  engineStatePath,
  serializeEngineState,
} from "../../src/graph/engine/engine-persistence.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import {
  buildDeclaredOutcomeGraph,
  persistDeclaredGraph,
} from "../../src/graph/tools/declare-graph.ts";
import {
  LEGACY_GRAPH_CREATION_REFUSED,
  LegacyGraphCreationRefusedError,
  legacyGraphCreationRefusal,
  legacyGraphCreationRefusedReason,
} from "../../src/graph/tools/legacy-creation-gate.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import {
  LEGACY_SIGNAL_PROTOCOL,
  OUTCOME_PROTOCOL,
} from "../../src/graph/protocol/execution-protocol.ts";
import { auditGraphStore } from "../../src/graph/audit/drain-audit.ts";
import { ScriptedDispatch, settle } from "./helpers/scripted-dispatch.ts";

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

/** A one-node legacy declaration. */
function legacyDeclaration(name: string): GraphDeclaration {
  return {
    version: 2,
    name,
    nodes: [{ id: "A", agent: "agent.a", prompt: "Do A." }],
    edges: [],
  };
}

/** A v3 declaration, for the declared-record arm of the decision. */
function v3Declaration(name: string): GraphDeclarationV3 {
  return {
    version: 3,
    name,
    nodes: [
      { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
    ],
    edges: [],
  };
}

/** Write a legacy record for an id, the way a run leaves one behind. */
function seedLegacyRecord(dir: string, graphId: string, frontier: string[] = []): void {
  const state = createEngineState(legacyDeclaration(graphId), graphId);
  provision(state);
  state.phase = EnginePhase.Executing;
  const node = state.nodes.get("A");
  if (node === undefined) throw new Error("fixture: node A was not registered");
  node.status = NodeStatus.Running;
  state.frontier = [...frontier];
  new EnginePersistence(dir).save(state);
}

// ── The decision, as a value ────────────────────────────────────────────────

describe("legacy creation gate — the decision", () => {
  it("allows everything when no store is configured, because nothing is created", () => {
    expect(
      legacyGraphCreationRefusal({ stateDir: undefined, graphId: "g", allowedByHost: false }),
    ).toBeNull();
  });

  it("refuses the one situation it owns: a store with no record for the graph", () => {
    const dir = makeTmpDir("gate-decision-absent-");
    mkdirSync(engineStateDir(dir), { recursive: true });

    const refusal = legacyGraphCreationRefusal({
      stateDir: dir,
      graphId: "g",
      allowedByHost: false,
    });

    expect(refusal).not.toBeNull();
    expect(refusal?.code).toBe(LEGACY_GRAPH_CREATION_REFUSED);
    expect(refusal?.graphId).toBe("g");
    expect(refusal?.stateFilePath).toBe(engineStatePath(dir, "g"));
    // The diagnostic names the graph, the path, the reason and the alternative.
    expect(refusal?.diagnostic).toContain('graph "g"');
    expect(refusal?.diagnostic).toContain(engineStatePath(dir, "g"));
    expect(refusal?.diagnostic).toContain("backfill");
    expect(refusal?.diagnostic).toContain("graph_declare");
  });

  it("allows an existing legacy record — resuming is not creating", () => {
    const dir = makeTmpDir("gate-decision-legacy-");
    seedLegacyRecord(dir, "g");

    expect(
      legacyGraphCreationRefusal({ stateDir: dir, graphId: "g", allowedByHost: false }),
    ).toBeNull();
  });

  it("allows an existing declared (outcome) record", () => {
    const dir = makeTmpDir("gate-decision-declared-");
    persistDeclaredGraph(
      buildDeclaredOutcomeGraph({ declaration: v3Declaration("g") }),
      dir,
    );

    expect(
      legacyGraphCreationRefusal({ stateDir: dir, graphId: "g", allowedByHost: false }),
    ).toBeNull();
  });

  it("allows a record it cannot read: that is the audit's blocker, not a creation", () => {
    const dir = makeTmpDir("gate-decision-unreadable-");
    mkdirSync(engineStateDir(dir), { recursive: true });
    writeFileSync(engineStatePath(dir, "g"), "{ not json", "utf-8");

    // The record exists, so this run REPLACES nothing new — and the gate must
    // not claim a creation the store does not need. The audit reports the
    // unreadable record as its own blocker.
    expect(
      legacyGraphCreationRefusal({ stateDir: dir, graphId: "g", allowedByHost: false }),
    ).toBeNull();
  });

  it("allows it when the HOST declares that it still creates legacy graphs", () => {
    const dir = makeTmpDir("gate-decision-allowed-");
    mkdirSync(engineStateDir(dir), { recursive: true });

    // The E-gate step-1 switch: a host that still relies on the legacy ingress
    // declares it (GraphToolSetDeps.allowNewLegacyGraphs) and creation
    // proceeds. Removing the declaration is the whole of the change.
    expect(
      legacyGraphCreationRefusal({ stateDir: dir, graphId: "g", allowedByHost: true }),
    ).toBeNull();
  });

  it("states the reason once, so the error and the decision cannot drift", () => {
    const path = engineStatePath("/tmp/gate", "g");
    expect(legacyGraphCreationRefusedReason("g", path)).toContain(path);
  });
});

// ── The tool surface ────────────────────────────────────────────────────────

describe("legacy creation gate — the run ingress", () => {
  it("refuses a fresh legacy graph on a configured store, and writes nothing", async () => {
    const dir = makeTmpDir("gate-run-fresh-");
    const dispatch = new ScriptedDispatch();
    const ts = createGraphToolSet({ stateDir: dir, dispatch });
    const created = ts.graph_create({ name: "fresh" });
    ts.graph_add_node({ graph_id: created.graph_id, id: "A", agent: "a", prompt: "pA" });

    let caught: unknown;
    try {
      await ts.graph_run({ graph_id: created.graph_id });
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof LegacyGraphCreationRefusedError)) {
      throw new Error("expected LegacyGraphCreationRefusedError, got " + String(caught));
    }
    expect(caught.code).toBe(LEGACY_GRAPH_CREATION_REFUSED);
    expect(caught.graphId).toBe(created.graph_id);
    expect(caught.stateFilePath).toBe(engineStatePath(dir, created.graph_id));
    // Nothing was dispatched and no record — not even the directory — appeared.
    expect(dispatch.dispatchCount).toBe(0);
    expect(existsSync(engineStateDir(dir))).toBe(false);
    // A dry run writes nothing, so it is not refused.
    const dry = await ts.graph_run({ graph_id: created.graph_id, dry_run: true });
    expect(dry.dry_run).toBe(true);
    expect(dry.validation?.valid).toBe(true);
  });

  it("creates the record when the HOST declares the allowance (the step-1 switch)", async () => {
    const dir = makeTmpDir("gate-run-allowed-");
    const dispatch = new ScriptedDispatch();
    const ts = createGraphToolSet({
      stateDir: dir,
      dispatch,
      allowNewLegacyGraphs: true,
    });
    const created = ts.graph_create({ name: "declared-host" });
    ts.graph_add_node({ graph_id: created.graph_id, id: "A", agent: "a", prompt: "pA" });

    await ts.graph_run({ graph_id: created.graph_id });
    await settle();

    // The declared host keeps the legacy path, and the record it writes is
    // exactly the unpinned one the gate exists to make visible: no
    // executionProtocolVersion key at all, bound to protocol 1 by the loader on
    // the next read (characterized below). That is the trade the declaration
    // states out loud, and the reason removing it is stage E's first step.
    expect(existsSync(engineStatePath(dir, created.graph_id))).toBe(true);
    const raw = readFileSync(engineStatePath(dir, created.graph_id), "utf-8");
    expect(raw).not.toContain("executionProtocolVersion");
    expect(dispatch.dispatchCount).toBe(1);
  });

  it("still runs the same graph when no store is configured (the path is not retired)", async () => {
    const dispatch = new ScriptedDispatch();
    const ts = createGraphToolSet({ dispatch });
    const created = ts.graph_create({ name: "in-memory" });
    ts.graph_add_node({ graph_id: created.graph_id, id: "A", agent: "a", prompt: "pA" });

    const result = await ts.graph_run({ graph_id: created.graph_id });
    await settle();

    expect(result.phase).toBe(EnginePhase.Executing);
    expect(dispatch.dispatchCount).toBe(1);
    expect(ts["getEntry"](created.graph_id).runtime.status().nodes.get("A")?.status).toBe(
      NodeStatus.Completed,
    );
  });

  it("resumes an existing legacy record instead of refusing it", async () => {
    const dir = makeTmpDir("gate-run-resume-");
    seedLegacyRecord(dir, "resumed");
    expect(existsSync(engineStatePath(dir, "resumed"))).toBe(true);

    const dispatch = new ScriptedDispatch();
    const ts = createGraphToolSet({ stateDir: dir, dispatch });
    // The id is reused, not suffixed: a legacy record does not reserve it.
    const created = ts.graph_create({ name: "resumed" });
    expect(created.graph_id).toBe("resumed");
    ts.graph_add_node({ graph_id: created.graph_id, id: "A", agent: "a", prompt: "pA" });

    const result = await ts.graph_run({ graph_id: created.graph_id });
    await settle();

    expect(result.phase).not.toBe("invalid");
    expect(dispatch.dispatchCount).toBe(1);
    expect(existsSync(engineStatePath(dir, "resumed"))).toBe(true);
  });
});

// ── The defect this gate closes (characterization) ──────────────────────────

describe("legacy creation gate — the backfill it closes", () => {
  it("shows why an unpinned record must not be created: the loader BINDS it to protocol 1", async () => {
    const dir = makeTmpDir("gate-backfill-");
    mkdirSync(engineStateDir(dir), { recursive: true });
    // Exactly what a fresh legacy state persists: no executionProtocolVersion
    // key at all (serializeEngineState writes it only when the state holds one).
    const state = createEngineState(legacyDeclaration("unpinned"), "unpinned");
    provision(state);
    state.phase = EnginePhase.Executing;
    const raw = JSON.stringify(serializeEngineState(state));
    expect(raw).not.toContain("executionProtocolVersion");
    writeFileSync(engineStatePath(dir, "unpinned"), raw, "utf-8");

    const report = await auditGraphStore({ directory: dir });

    const entry = report.entries.find((candidate) => candidate.file === "engine-unpinned.json");
    expect(entry?.executionProtocolVersion).toBe(LEGACY_SIGNAL_PROTOCOL);
    expect(entry?.protocol).toBe("legacy-signal");
    // A record created TODAY is reported exactly like a historical one — which
    // is the ambiguity the gate stops the build from adding to.
    expect(entry?.classification).toBe("in-flight");
    // The declared path, by contrast, pins the protocol it writes.
    const declaredDir = makeTmpDir("gate-backfill-declared-");
    persistDeclaredGraph(
      buildDeclaredOutcomeGraph({ declaration: v3Declaration("declared") }),
      declaredDir,
    );
    const dto = JSON.parse(
      readFileSync(engineStatePath(declaredDir, "declared"), "utf-8"),
    ) as { executionProtocolVersion?: number };
    expect(dto.executionProtocolVersion).toBe(OUTCOME_PROTOCOL);
  });
});
