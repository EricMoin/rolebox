
import { describe, expect, expectTypeOf, it } from "vitest";
import type { JoinConfig } from "../../src/graph/domain/join.ts";

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
