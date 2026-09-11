/**
 * Graph Execution Engine v2 — Node liveness state (subtask 1 of the
 * node-anomaly-detection feature).
 *
 * Pins the OPTIONAL-ADDITIVE `NodeRuntimeState.liveness` carrier:
 *   1. Fresh nodes have NO `liveness` (absent → undefined, never fabricated),
 *      and the serialized DTO omits it — pre-feature v2 files stay loadable.
 *   2. Serialization round-trips `liveness` losslessly (serialize →
 *      deserialize, plus the file-store save → load path), including partial
 *      liveness records with only a subset of fields set.
 *   3. Snapshot clones (`engine.status()` → snapshotEngineState → cloneNode)
 *      never share the `liveness` object reference with the live state — an
 *      in-place mutation of a snapshot cannot leak into the live engine.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type {
  EngineState,
  NodeLivenessState,
} from "../../src/types.engine-v2.ts";
import {
  createEngineState,
  provision,
} from "../../src/graph/engine/engine-state.ts";
import {
  EnginePersistence,
  serializeEngineState,
  deserializeEngineState,
} from "../../src/graph/engine/engine-persistence.ts";
import { createEngine } from "../../src/graph/engine/index.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

function singleNodeDeclaration(): GraphDeclaration {
  return {
    version: 2,
    name: "liveness",
    nodes: [{ id: "A", agent: "a1", prompt: "p1" }],
    edges: [],
  };
}

/** Every field of the carrier populated — the fullest liveness record. */
const FULL_LIVENESS: NodeLivenessState = {
  lastActivityAt: 1000,
  heartbeatSource: "tool",
  stallStatus: "stalling",
  stallWarnedAt: 950,
  stallReason: "no tool calls observed for 5s",
};

// ── Test suite ──────────────────────────────────────────────────────────────

describe("NodeRuntimeState.liveness — optional-additive carrier", () => {
  it("fresh provisioned nodes have no liveness (absent, not fabricated)", () => {
    const state = createEngineState(singleNodeDeclaration(), "g-fresh");
    provision(state);

    const node = state.nodes.get("A")!;
    expect(node.liveness).toBeUndefined();

    // The serialized DTO omits the field entirely — an old-shaped v2 file.
    const dto = serializeEngineState(state);
    expect(dto.nodes["A"].liveness).toBeUndefined();
  });

  it("round-trips liveness losslessly through serialize → deserialize", () => {
    const state = createEngineState(singleNodeDeclaration(), "g-round");
    provision(state);
    state.nodes.get("A")!.liveness = { ...FULL_LIVENESS };

    const dto = serializeEngineState(state);
    const hydrated = deserializeEngineState(dto);
    const node = hydrated.nodes.get("A")!;

    expect(node.liveness).toEqual(FULL_LIVENESS);
    // DTO-level lossless equality: re-serializing the hydrated state yields
    // the identical file (the field survives without drift).
    expect(serializeEngineState(hydrated)).toEqual(dto);
    // The hydrated liveness is a fresh object, never a shared reference.
    expect(node.liveness).not.toBe(dto.nodes["A"].liveness);
  });

  it("round-trips partial liveness (only a subset of fields present)", () => {
    const state = createEngineState(singleNodeDeclaration(), "g-partial");
    provision(state);
    state.nodes.get("A")!.liveness = {
      lastActivityAt: 500,
      stallStatus: "healthy",
    };

    const hydrated = deserializeEngineState(serializeEngineState(state));
    expect(hydrated.nodes.get("A")!.liveness).toEqual({
      lastActivityAt: 500,
      stallStatus: "healthy",
    });
  });

  it("persists through the file store (save → load) with liveness intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "node-liveness-"));
    try {
      const store = new EnginePersistence(dir);
      const state = createEngineState(singleNodeDeclaration(), "g-store");
      provision(state);
      state.nodes.get("A")!.liveness = { ...FULL_LIVENESS };

      store.save(state);
      const loaded = store.load("g-store")!;
      expect(loaded.nodes.get("A")!.liveness).toEqual(FULL_LIVENESS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a v2 file WITHOUT liveness still loads (liveness stays undefined)", () => {
    const state = createEngineState(singleNodeDeclaration(), "g-old");
    provision(state);
    // No liveness recorded — exactly a pre-feature v2 file.
    const dto = serializeEngineState(state);
    expect(dto.nodes["A"].liveness).toBeUndefined();

    const hydrated = deserializeEngineState(dto);
    expect(hydrated.nodes.get("A")!.liveness).toBeUndefined();
    // Pre-existing fields are untouched.
    expect(hydrated.nodes.get("A")!.status).toBe(NodeStatus.Ready);
  });
});

describe("NodeRuntimeState.liveness — snapshot clone isolation", () => {
  it("engine.status() snapshot does not share the liveness reference with the live state", () => {
    const engine = createEngine(singleNodeDeclaration(), {
      graphId: "g-snap",
    });
    engine.provision();

    // Reach the LIVE state (test-only reach into the private slot, mirroring
    // graph-status-flags.test.ts) and record a heartbeat + stall classification.
    const live = (engine as unknown as { state: EngineState }).state;
    const node = live.nodes.get("A")!;
    node.liveness = { ...FULL_LIVENESS };

    const snap = engine.status();
    const snapLiveness = snap.nodes.get("A")!.liveness!;
    // The snapshot carries a deep copy — equal content, distinct object.
    expect(snapLiveness).toEqual(FULL_LIVENESS);
    expect(snapLiveness).not.toBe(node.liveness);

    // In-place mutation of the snapshot's liveness must never leak into the
    // live engine: a shallow clone would share the object, so a fresh snapshot
    // taken after the tamper would observe the altered values.
    snapLiveness.lastActivityAt = 42;
    snapLiveness.stallStatus = "healthy";
    expect(node.liveness!.lastActivityAt).toBe(1000);
    expect(node.liveness!.stallStatus).toBe("stalling");

    // A fresh snapshot still reflects the untampered live liveness.
    const snap2 = engine.status();
    expect(snap2.nodes.get("A")!.liveness!.lastActivityAt).toBe(1000);
    expect(snap2.nodes.get("A")!.liveness!.stallStatus).toBe("stalling");
  });
});
