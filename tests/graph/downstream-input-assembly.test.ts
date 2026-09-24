/// <reference types="bun-types" />

/**
 * Assembling a node's declared inputs, or refusing the dispatch (§3.5).
 *
 * The rules live in `assembleDownstreamInput` and are pure, so they are pinned
 * here directly: every declared input must resolve to an accepted result whose
 * outcome is the one the reference PINNED, and ANY failure blocks the dispatch.
 * A node is never started with a hole where its input should be.
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import {
  assembleDownstreamInput,
  readResolvedArtifact,
  type AcceptedResultFacts,
} from "../../src/graph/outcome/inputs.ts";

const REF = "evidence/report.txt";

function facts(outcomeId: string, artifactId: string): AcceptedResultFacts {
  return {
    outcomeId,
    artifacts: [
      { ref: REF, artifactId, digest: artifactId.slice("sha256:".length), size: 3 },
    ],
  };
}

describe("assembleDownstreamInput", () => {
  it("resolves nothing when the node declares no inputs", () => {
    const assembled = assembleDownstreamInput([], () => undefined, () => undefined);
    expect(assembled.kind).toBe("resolved");
    if (assembled.kind !== "resolved") return;
    expect(assembled.entries).toEqual([]);
  });

  it("binds each input to the attempt and the retained artifact", () => {
    const assembled = assembleDownstreamInput(
      [{ from: "work", outcome: "done" }],
      (nodeId) => (nodeId === "work" ? "work#1" : undefined),
      (attemptId) =>
        attemptId === "work#1" ? facts("done", "sha256:" + "a".repeat(64)) : undefined,
    );
    expect(assembled.kind).toBe("resolved");
    if (assembled.kind !== "resolved") return;
    expect(assembled.entries.length).toBe(1);
    expect(assembled.entries[0]?.attemptId).toBe("work#1");
    expect(assembled.entries[0]?.artifacts[0]?.ref).toBe(REF);
  });

  it("BLOCKS when the producer has no settled attempt", () => {
    const assembled = assembleDownstreamInput(
      [{ from: "work", outcome: "done" }],
      () => undefined,
      () => undefined,
    );
    expect(assembled.kind).toBe("blocked");
    if (assembled.kind !== "blocked") return;
    expect(assembled.refusals.map((entry) => entry.code)).toEqual([
      "input-producer-unsettled",
    ]);
    expect(assembled.refusals[0]?.message).toContain("nobody produced");
  });

  it("BLOCKS when the producer settled on a DIFFERENT outcome", () => {
    const assembled = assembleDownstreamInput(
      [{ from: "work", outcome: "done" }],
      () => "work#1",
      () => facts("failed", "sha256:" + "b".repeat(64)),
    );
    expect(assembled.kind).toBe("blocked");
    if (assembled.kind !== "blocked") return;
    expect(assembled.refusals.map((entry) => entry.code)).toEqual([
      "input-outcome-mismatch",
    ]);
  });

  it("BLOCKS the whole dispatch when ONE of several inputs is missing", () => {
    const assembled = assembleDownstreamInput(
      [
        { from: "work", outcome: "done" },
        { from: "audit", outcome: "clean" },
      ],
      (nodeId) => (nodeId === "work" ? "work#1" : undefined),
      () => facts("done", "sha256:" + "c".repeat(64)),
    );
    expect(assembled.kind).toBe("blocked");
    if (assembled.kind !== "blocked") return;
    // Two inputs and one missing one means NO input at all.
    expect(assembled.refusals.length).toBe(1);
    expect(assembled.refusals[0]?.from).toBe("audit");
  });
});

describe("readResolvedArtifact", () => {
  it("reads the retained identity, not the reference path", () => {
    const assembled = assembleDownstreamInput(
      [{ from: "work", outcome: "done" }],
      () => "work#1",
      () => facts("done", "sha256:" + "d".repeat(64)),
    );
    if (assembled.kind !== "resolved") throw new Error("expected resolution");
    const seen: string[] = [];
    const read = readResolvedArtifact(assembled.entries, REF, (artifactId) => {
      seen.push(artifactId);
      return { kind: "read", bytes: Buffer.from("abc"), digest: "d".repeat(64) };
    });
    expect(read.kind).toBe("read");
    expect(seen).toEqual(["sha256:" + "d".repeat(64)]);
  });

  it("refuses a reference no resolved input retained", () => {
    const assembled = assembleDownstreamInput(
      [{ from: "work", outcome: "done" }],
      () => "work#1",
      () => facts("done", "sha256:" + "e".repeat(64)),
    );
    if (assembled.kind !== "resolved") throw new Error("expected resolution");
    const read = readResolvedArtifact(assembled.entries, "evidence/other.txt", () => {
      throw new Error("must not read anything");
    });
    expect(read.kind).toBe("problem");
    if (read.kind !== "problem") return;
    expect(read.reason).toContain("never resolved from the path");
  });
});
