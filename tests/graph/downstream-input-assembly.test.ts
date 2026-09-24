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
  type ResolvedInput,
} from "../../src/graph/outcome/inputs.ts";
import {
  artifactIdOf,
  digestOf,
  type ArtifactObjectRead,
} from "../../src/graph/store/artifacts.ts";

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

describe("readResolvedArtifact — addressed by (producer, reference)", () => {
  const WORK_BYTES = Buffer.from("work-revision-A", "utf-8");
  const AUDIT_BYTES = Buffer.from("audit-revision-B", "utf-8");
  const WORK = artifactIdOf(digestOf(WORK_BYTES));
  const AUDIT = artifactIdOf(digestOf(AUDIT_BYTES));

  /** Two producers, each retaining the SAME reference with DIFFERENT bytes. */
  function twoProducers(): readonly ResolvedInput[] {
    const assembled = assembleDownstreamInput(
      [
        { from: "work", outcome: "done" },
        { from: "audit", outcome: "clean" },
      ],
      (nodeId) => (nodeId === "work" ? "work#1" : "audit#1"),
      (attemptId) => {
        if (attemptId === "work#1") {
          return {
            outcomeId: "done",
            artifacts: [
              { ref: REF, artifactId: WORK, digest: digestOf(WORK_BYTES), size: WORK_BYTES.length },
            ],
          };
        }
        if (attemptId === "audit#1") {
          return {
            outcomeId: "clean",
            artifacts: [
              { ref: REF, artifactId: AUDIT, digest: digestOf(AUDIT_BYTES), size: AUDIT_BYTES.length },
            ],
          };
        }
        return undefined;
      },
    );
    if (assembled.kind !== "resolved") throw new Error("expected resolution");
    return assembled.entries;
  }

  /** The store read stub: each identity answers the bytes it was retained for. */
  function readByFixture(artifactId: string): ArtifactObjectRead {
    if (artifactId === WORK) {
      return { kind: "read", bytes: WORK_BYTES, digest: digestOf(WORK_BYTES) };
    }
    if (artifactId === AUDIT) {
      return { kind: "read", bytes: AUDIT_BYTES, digest: digestOf(AUDIT_BYTES) };
    }
    throw new Error("the address resolved to an identity no producer retained: " + artifactId);
  }

  it("reads the retained identity, not the reference path", () => {
    const assembled = assembleDownstreamInput(
      [{ from: "work", outcome: "done" }],
      () => "work#1",
      () => facts("done", "sha256:" + "d".repeat(64)),
    );
    if (assembled.kind !== "resolved") throw new Error("expected resolution");
    const seen: string[] = [];
    const read = readResolvedArtifact(
      assembled.entries,
      { from: "work", ref: REF },
      (artifactId) => {
        seen.push(artifactId);
        return { kind: "read", bytes: Buffer.from("abc"), digest: "d".repeat(64) };
      },
    );
    expect(read.kind).toBe("read");
    expect(seen).toEqual(["sha256:" + "d".repeat(64)]);
  });

  it("returns each producer's OWN bytes when both retained the same reference", () => {
    const entries = twoProducers();
    const fromWork = readResolvedArtifact(entries, { from: "work", ref: REF }, readByFixture);
    expect(fromWork.kind).toBe("read");
    if (fromWork.kind !== "read") return;
    expect(Buffer.compare(fromWork.bytes, WORK_BYTES)).toBe(0);

    const fromAudit = readResolvedArtifact(entries, { from: "audit", ref: REF }, readByFixture);
    expect(fromAudit.kind).toBe("read");
    if (fromAudit.kind !== "read") return;
    expect(Buffer.compare(fromAudit.bytes, AUDIT_BYTES)).toBe(0);
    // The two addresses name two DIFFERENT revisions; neither is the other's,
    // and neither was resolved by input order.
    expect(Buffer.compare(fromWork.bytes, fromAudit.bytes)).not.toBe(0);
  });

  it("refuses a producer that has no resolved entry at all", () => {
    const read = readResolvedArtifact(twoProducers(), { from: "ghost", ref: REF }, readByFixture);
    expect(read.kind).toBe("problem");
    if (read.kind !== "problem") return;
    expect(read.reason).toContain("no resolved input names producer");
    expect(read.reason).toContain("refused rather than searched for the reference alone");
  });

  it("refuses an address the producer retained nothing for, never the path", () => {
    const read = readResolvedArtifact(
      twoProducers(),
      { from: "work", ref: "evidence/other.txt" },
      readByFixture,
    );
    expect(read.kind).toBe("problem");
    if (read.kind !== "problem") return;
    expect(read.reason).toContain("retained no artifact for reference");
    expect(read.reason).toContain("never resolved from the path");
  });

  it("refuses one address retained under TWO content identities instead of resolving by position", () => {
    const assembled = assembleDownstreamInput(
      [{ from: "work", outcome: "done" }],
      () => "work#1",
      () => ({
        outcomeId: "done",
        artifacts: [
          { ref: REF, artifactId: WORK, digest: digestOf(WORK_BYTES), size: WORK_BYTES.length },
          { ref: REF, artifactId: AUDIT, digest: digestOf(AUDIT_BYTES), size: AUDIT_BYTES.length },
        ],
      }),
    );
    if (assembled.kind !== "resolved") throw new Error("expected resolution");
    const read = readResolvedArtifact(assembled.entries, { from: "work", ref: REF }, readByFixture);
    expect(read.kind).toBe("problem");
    if (read.kind !== "problem") return;
    expect(read.reason).toContain("more than one content identity");
    expect(read.reason).toContain("rather than resolved by position");
  });
});
