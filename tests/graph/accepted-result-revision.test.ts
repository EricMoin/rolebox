/// <reference types="bun-types" />

/**
 * The accepted revision survives the path changing — and a restart.
 *
 * §3.1: an immutable artifact store may hold the bytes, but SQLite remains the
 * sole authority for WHICH revision was accepted. This pins both halves: the
 * accepted result row names a content identity, the bytes live under it, and a
 * consumer resolves that identity. It never re-reads the mutable path the
 * reference names, so the file becoming a different revision cannot change what
 * a downstream consumer receives.
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GraphStore } from "../../src/graph/store/graph-store.ts";
import { digestOf, putArtifact } from "../../src/graph/store/artifacts.ts";

const GRAPH = "p42.result";
const ATTEMPT = "work#1";
const REF = "evidence/report.json";

const A = Buffer.from("revision A: the bytes the gate judged", "utf-8");
const B = Buffer.from("revision B: what the path holds afterwards", "utf-8");

function withRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "p42-result-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Write the accepted-result row exactly as the acceptance transaction does. */
function accept(store: GraphStore, root: string, bytes: Buffer): void {
  const deposit = putArtifact(root, bytes);
  if (deposit.kind !== "deposited") {
    throw new Error("fixture: the deposit was refused: " + deposit.reason);
  }
  store.writeAcceptedResult({
    graphId: GRAPH,
    attemptId: ATTEMPT,
    planRevision: "rev-1",
    payload: { kind: "value", value: { summary: "accepted" } },
    artifacts: [
      {
        ref: REF,
        artifactId: deposit.artifactId,
        digest: deposit.digest,
        size: deposit.size,
      },
    ],
    acceptedAt: 1,
  });
}

describe("the accepted revision is what downstream resolves", () => {
  it("still produces A after the reference names B, and after a REOPEN", () => {
    withRoot((root) => {
      const artifactRoot = join(root, "workspace");
      mkdirSync(join(artifactRoot, "evidence"), { recursive: true });
      writeFileSync(join(artifactRoot, "evidence", "report.json"), A);

      const store = GraphStore.openFile(root);
      try {
        accept(store, root, A);
        // The path now names a DIFFERENT revision.
        writeFileSync(join(artifactRoot, "evidence", "report.json"), B);

        const consumed = store.readAcceptedArtifact(GRAPH, ATTEMPT, REF);
        expect(consumed.kind).toBe("read");
        if (consumed.kind !== "read") return;
        expect(Buffer.compare(consumed.bytes, A)).toBe(0);
        expect(digestOf(consumed.bytes)).not.toBe(digestOf(B));
      } finally {
        store.close();
      }

      // A SECOND store object over the same root: the accepted revision is the
      // row's, not this process's memory.
      const reopened = GraphStore.openFile(root);
      try {
        const after = reopened.readAcceptedArtifact(GRAPH, ATTEMPT, REF);
        expect(after.kind).toBe("read");
        if (after.kind !== "read") return;
        expect(Buffer.compare(after.bytes, A)).toBe(0);
        expect(reopened.readAcceptedResult(GRAPH, ATTEMPT)?.payload).toEqual({
          kind: "value",
          value: { summary: "accepted" },
        });
      } finally {
        reopened.close();
      }
    });
  });

  it("refuses a reference the acceptance did not retain, instead of reading the path", () => {
    withRoot((root) => {
      const store = GraphStore.openFile(root);
      try {
        accept(store, root, A);
        const other = store.readAcceptedArtifact(GRAPH, ATTEMPT, "evidence/other.json");
        expect(other.kind).toBe("problem");
        if (other.kind !== "problem") return;
        expect(other.reason).toContain("retained no artifact");
        expect(other.reason).toContain("never resolved from the path");
      } finally {
        store.close();
      }
    });
  });

  it("refuses an attempt with no accepted result at all", () => {
    withRoot((root) => {
      const store = GraphStore.openFile(root);
      try {
        const none = store.readAcceptedArtifact(GRAPH, "ghost#9", REF);
        expect(none.kind).toBe("problem");
        if (none.kind !== "problem") return;
        expect(none.reason).toContain("has no accepted result");
      } finally {
        store.close();
      }
    });
  });
});
