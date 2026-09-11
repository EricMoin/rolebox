import { describe, it, expect } from "bun:test";
import type { LoopPhase } from "../../src/loop/types";

/**
 * Exhaustive switch test: ensures every `LoopPhase` literal is handled.
 * The `never`-guarded default will produce a compile error if a new phase
 * is added to the union without being covered in this test.
 */
describe("LoopPhase exhaustive coverage", () => {
  it("covers all 9 phases in a switch with never guard", () => {
    const phases: LoopPhase[] = [
      "activating",
      "dispatching",
      "awaiting_worker",
      "summarizing",
      "finalizing",
      "complete",
      "cancelled",
      "interrupted",
      "error",
    ];

    for (const phase of phases) {
      const label = exhaustivePhaseLabel(phase);
      expect(label).toBeDefined();
    }
  });
});

function exhaustivePhaseLabel(phase: LoopPhase): string {
  switch (phase) {
    case "activating":
      return "activating";
    case "dispatching":
      return "dispatching";
    case "awaiting_worker":
      return "awaiting_worker";
    case "summarizing":
      return "summarizing";
    case "finalizing":
      return "finalizing";
    case "complete":
      return "complete";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    case "error":
      return "error";
    default:
      // `phase` is narrowed to `never` here — if a new variant is added
      // to the `LoopPhase` union without a corresponding case, this will
      // produce a TypeScript compile error.
      const _exhaustive: never = phase;
      return _exhaustive;
  }
}
