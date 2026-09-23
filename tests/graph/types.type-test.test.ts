/**
 * Graph Engine v2 — surviving type-level contract pins.
 *
 * Why this file exists: `bun test` is transpile-only, so a contract that only
 * regresses at the type level (a re-widened optional field, a collapsed
 * discriminated union, a renamed JSON key) would keep every runtime suite
 * green. This file is executed by `bun test` like any other test, but its real
 * authority is the compiler: `bun run typecheck:tests`
 * (`tsc -p tsconfig.tests.json`) fails when a pin below drifts.
 *
 * This is the subset of the former `types.type-test.test.ts` whose subjects
 * SURVIVE the legacy runtime's deletion. The pins it dropped
 * (`ApproveReport` / `RejectReport` / `PruneReport`, `CancelScopeReport` and
 * the tool-layer `GraphApproveResult` / `GraphCancelResult` / `GraphRunResult`
 * projections) pinned types that were deleted with the legacy construction and
 * execution tool surface, so there is no contract left to pin.
 *
 * Pinned contracts:
 *   1. `JoinConfig` (C1/R3) — `quorum` exists only on the "quorum" branch, so a
 *      quorum strategy without its required-answer count cannot be declared
 *      (the former `quorum?: number` silently degraded to a count of 1).
 *   2. `GraphStatusSnapshot` (Y27) — which `graph_status` JSON keys are required
 *      and which are conditionally spread (must stay optional).
 */

import { describe, expect, expectTypeOf, it } from "bun:test";
import type { JoinConfig } from "../../src/types.graph-v2.ts";
import type { GraphStatusSnapshot } from "../../src/graph/tools/graph-tools.ts";

/**
 * Whether `K` may be omitted from `T` — the exact "optional" bit. A required
 * key makes the empty object type unassignable to `Pick<T, K>` (`false`); an
 * optional key keeps it assignable (`true`).
 */
type IsOptionalKey<T, K extends keyof T> = {} extends Pick<T, K> ? true : false;

describe("type contract: JoinConfig quorum discriminant (C1/R3)", () => {
  it("accepts a quorum strategy that carries its required count", () => {
    const config: JoinConfig = { strategy: "quorum", quorum: 2 };
    expect(config.strategy).toBe("quorum");
    expect(config.quorum).toBe(2);
  });

  it("types the quorum branch as exactly { strategy, quorum }", () => {
    type QuorumBranch = Extract<JoinConfig, { strategy: "quorum" }>;
    expectTypeOf<QuorumBranch>().toEqualTypeOf<{
      strategy: "quorum";
      quorum: number;
    }>();
    expectTypeOf<QuorumBranch["quorum"]>().toEqualTypeOf<number>();
  });

  it("keeps the all/any branches count-free", () => {
    expectTypeOf<Extract<JoinConfig, { strategy: "all" }>>().toEqualTypeOf<{
      strategy: "all";
    }>();
    expectTypeOf<Extract<JoinConfig, { strategy: "any" }>>().toEqualTypeOf<{
      strategy: "any";
    }>();
  });

  it("fails to compile a quorum strategy with no count", () => {
    // TS2578 fires here if `{ strategy: "quorum" }` ever becomes assignable
    // again — i.e. if the required `quorum: number` is re-widened to optional.
    // @ts-expect-error a quorum strategy must carry its required-answer count
    const missingCount: JoinConfig = { strategy: "quorum" };
    // The value only exists so the runtime case is non-empty; the pin is the
    // suppressed compiler error above.
    expect(missingCount.strategy).toBe("quorum");
  });

  it("rejects a legacy optional-count declaration at the type level", () => {
    type LegacyQuorum = { strategy: "quorum"; quorum?: number };
    /** Constraint check: instantiating with a non-assignable type is an error. */
    type AssignableTo<To, From extends To> = From;
    // @ts-expect-error an optional count is not assignable to the required count
    type LegacyPin = AssignableTo<JoinConfig, LegacyQuorum>;
    expect(true).toBe(true);
  });
});

describe("type contract: GraphStatusSnapshot key requiredness (Y27)", () => {
  it("requires the graph-scoped identity keys", () => {
    expectTypeOf<IsOptionalKey<GraphStatusSnapshot, "graph_id">>().toEqualTypeOf<false>();
    expectTypeOf<IsOptionalKey<GraphStatusSnapshot, "phase">>().toEqualTypeOf<false>();
    expectTypeOf<IsOptionalKey<GraphStatusSnapshot, "nodes">>().toEqualTypeOf<false>();
  });

  it("keeps the conditionally spread JSON keys optional", () => {
    expectTypeOf<IsOptionalKey<GraphStatusSnapshot, "budget">>().toEqualTypeOf<true>();
    expectTypeOf<IsOptionalKey<GraphStatusSnapshot, "loops">>().toEqualTypeOf<true>();
    expectTypeOf<IsOptionalKey<GraphStatusSnapshot, "metrics">>().toEqualTypeOf<true>();
    // The legacy notification-degraded keys are gone with the deleted graph
    // notifier; the snapshot no longer declares them at all.
  });

  it("keeps the C-WIRE flag keys optional", () => {
    expectTypeOf<
      IsOptionalKey<GraphStatusSnapshot, "round_history">
    >().toEqualTypeOf<true>();
    expectTypeOf<IsOptionalKey<GraphStatusSnapshot, "checkpoints">>().toEqualTypeOf<true>();
    expectTypeOf<
      IsOptionalKey<GraphStatusSnapshot, "artifacts_evidence">
    >().toEqualTypeOf<true>();
    expectTypeOf<IsOptionalKey<GraphStatusSnapshot, "signal_stream">>().toEqualTypeOf<true>();
  });

  it("accepts a minimal snapshot and rejects one missing a required key", () => {
    const minimal: GraphStatusSnapshot = {
      graph_id: "g-type-pin",
      phase: "executing",
      nodes: [],
    };
    expect(minimal.graph_id).toBe("g-type-pin");

    // @ts-expect-error graph_id is part of the required JSON contract
    const missingGraphId: GraphStatusSnapshot = { phase: "executing", nodes: [] };
    expect(missingGraphId.phase).toBe("executing");
  });
});
