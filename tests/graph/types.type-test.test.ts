/**
 * Graph Engine v2 — type-level contract pins (R1 residual / N7 §3.6).
 *
 * Why this file exists: `bun test` is transpile-only, so a contract that only
 * regresses at the type level (a re-widened optional field, a collapsed
 * discriminated union, a renamed JSON key) would keep every runtime suite
 * green. This file is executed by `bun test` like any other test, but its real
 * authority is the compiler: `bun run typecheck:tests` (`tsc -p
 * tsconfig.tests.json`) fails when a pin below drifts.
 *
 * Two assertion styles are used:
 *
 * - `expectTypeOf` (bun:test, the vendored expect-type matchers) for the
 *   positive shape: an exact-type pin that fails on any widening or rename.
 * - `@ts-expect-error` for the negative direction ("this must NOT compile"):
 *   tsc reports the directive itself as TS2578 the moment the forbidden shape
 *   becomes legal again, so the pin cannot silently rot.
 *
 * Pinned contracts:
 *   1. `JoinConfig` (C1/R3) — `quorum` exists only on the "quorum" branch, so a
 *      quorum strategy without its required-answer count cannot be declared
 *      (the former `quorum?: number` silently degraded to a count of 1).
 *   2. `ApproveReport` / `RejectReport` / `PruneReport` (C6/B16) — the report
 *      shapes the public approve/reject/prune surface returns, including the
 *      `already_resolved`-only `actualStatus`.
 *   3. `GraphStatusSnapshot` (Y27) — which `graph_status` JSON keys are required
 *      and which are conditionally spread (must stay optional).
 *
 * The runtime `expect` calls keep each case visible in the test report; they
 * assert the same facts the types encode where a value happens to be available.
 */

import { describe, expect, expectTypeOf, it } from "bun:test";
import { NodeStatus } from "../../src/constants.ts";
import type { JoinConfig } from "../../src/types.graph-v2.ts";
import type {
  ApproveReport,
  PruneReport,
  RejectReport,
} from "../../src/graph/engine/approval-handler.ts";
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

describe("type contract: approve/reject/prune reports (C6/B16)", () => {
  it("pins ApproveReport to its applied flag", () => {
    expectTypeOf<ApproveReport>().toEqualTypeOf<{ applied: boolean }>();
    const applied: ApproveReport = { applied: true };
    expect(applied.applied).toBe(true);
  });

  it("pins the RejectReport discriminated union", () => {
    expectTypeOf<RejectReport>().toEqualTypeOf<
      | { kind: "escalate" }
      | { kind: "revise" }
      | { kind: "already_resolved"; actualStatus: NodeStatus }
    >();
    const resolved: RejectReport = {
      kind: "already_resolved",
      actualStatus: NodeStatus.Completed,
    };
    expect(resolved.kind).toBe("already_resolved");
  });

  it("exposes actualStatus only on the already_resolved branch", () => {
    type AlreadyResolved = Extract<RejectReport, { kind: "already_resolved" }>;
    expectTypeOf<AlreadyResolved["actualStatus"]>().toEqualTypeOf<NodeStatus>();
    expectTypeOf<
      Extract<RejectReport, { kind: "escalate" }>
    >().toEqualTypeOf<{ kind: "escalate" }>();

    // A consumer that reads actualStatus without narrowing on kind must not
    // compile — that was the old optional-field hazard (undefined for every
    // genuine rejection lane).
    // @ts-expect-error actualStatus exists only on the already_resolved branch
    type EscalateStatus = Extract<RejectReport, { kind: "escalate" }>["actualStatus"];
    // @ts-expect-error actualStatus exists only on the already_resolved branch
    type ReviseStatus = Extract<RejectReport, { kind: "revise" }>["actualStatus"];
    expect(true).toBe(true);
  });

  it("pins PruneReport to the cancelled/surviving split", () => {
    expectTypeOf<PruneReport>().toEqualTypeOf<{
      cancelled: string[];
      surviving: string[];
    }>();
    const prune: PruneReport = { cancelled: ["b"], surviving: ["c"] };
    expect(prune.cancelled).toEqual(["b"]);
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
    expectTypeOf<
      IsOptionalKey<GraphStatusSnapshot, "notification_degraded">
    >().toEqualTypeOf<true>();
    expectTypeOf<
      IsOptionalKey<GraphStatusSnapshot, "notification_degraded_statuses">
    >().toEqualTypeOf<true>();
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
