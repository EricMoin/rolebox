/// <reference types="bun-types" />

/**
 * The immutable artifact store, and the property it exists for (P4 item 5 / A17).
 *
 * A gate that reads and digests a reference proves only "at validation time, this
 * reference named these bytes". The moment anything reads the PATH again it may name
 * different bytes — validated A, consumed B. Retaining the exact bytes under an
 * identity derived from them, and recording WHICH identity was accepted, is what
 * closes that hole; re-digesting the path does not.
 *
 * Every case uses an isolated temp root and removes it.
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ARTIFACT_STORE_DIR,
  artifactIdOf,
  artifactObjectPath,
  digestOf,
  putArtifact,
  readArtifactById,
  type ArtifactDeposit,
} from "../../src/graph/store/artifacts.ts";
import { readArtifact } from "../../src/graph/outcome/validators.ts";

function withRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "artifact-retention-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const A = Buffer.from("revision A: the bytes the gate judged", "utf-8");
const B = Buffer.from("revision B: what the path holds afterwards", "utf-8");

/** Deposit bytes and require the publication to have succeeded. */
function deposited(root: string, bytes: Buffer): ArtifactDeposit {
  const result = putArtifact(root, bytes);
  if (result.kind !== "deposited") {
    throw new Error("fixture: the deposit was refused: " + result.reason);
  }
  return result;
}

describe("the immutable artifact store", () => {
  it("round-trips bytes under their content identity", () => {
    withRoot((root) => {
      const deposit = deposited(root, A);
      expect(deposit.digest).toBe(digestOf(A));
      expect(deposit.artifactId).toBe(artifactIdOf(digestOf(A)));
      expect(deposit.size).toBe(A.length);

      const read = readArtifactById(root, deposit.artifactId);
      expect(read.kind).toBe("read");
      if (read.kind !== "read") return;
      expect(Buffer.compare(read.bytes, A)).toBe(0);
    });
  });

  it("publishes once: a second deposit of the same bytes REUSES the object byte-identical", () => {
    withRoot((root) => {
      const first = deposited(root, A);
      const path = artifactObjectPath(root, first.artifactId);
      const inodeBefore = statSync(path).ino;
      const second = deposited(root, A);
      // The SAME object, not a rewritten one: the inode is unchanged, so a
      // later deposit never truncated or replaced what an earlier one named.
      expect(statSync(path).ino).toBe(inodeBefore);
      expect(second.artifactId).toBe(first.artifactId);
      expect(second.digest).toBe(first.digest);
      expect(second.size).toBe(first.size);
      const read = readArtifactById(root, first.artifactId);
      expect(read.kind).toBe("read");
      if (read.kind !== "read") return;
      expect(Buffer.compare(read.bytes, A)).toBe(0);
    });
  });

  it("REFUSES to overwrite an object that no longer hashes to its identity", () => {
    withRoot((root) => {
      const deposit = deposited(root, A);
      const path = artifactObjectPath(root, deposit.artifactId);
      // The object is damaged after publication: it no longer holds A.
      writeFileSync(path, B);

      const again = putArtifact(root, A);
      expect(again.kind).toBe("problem");
      if (again.kind !== "problem") return;
      expect(again.reason).toContain("is already published, but the existing object does not verify");
      expect(again.reason).toContain("never repairs it in place");
      // The damaged object is LEFT EXACTLY AS IT IS: a deposit is not a repair
      // path, because overwriting it would change what an accepted result means.
      expect(Buffer.compare(readFileSync(path), B)).toBe(0);
      const read = readArtifactById(root, deposit.artifactId);
      expect(read.kind).toBe("problem");
    });
  });

  it("refuses a missing object instead of falling back to anything", () => {
    withRoot((root) => {
      const read = readArtifactById(root, artifactIdOf(digestOf(A)));
      expect(read.kind).toBe("problem");
      if (read.kind !== "problem") return;
      expect(read.reason).toContain("not present in this store");
      expect(read.reason).toContain("NOT re-read as a substitute");
    });
  });

  it("refuses a TAMPERED object rather than returning it", () => {
    withRoot((root) => {
      const deposit = deposited(root, A);
      writeFileSync(
        join(root, ARTIFACT_STORE_DIR, deposit.artifactId.slice("sha256:".length)),
        B,
      );
      const read = readArtifactById(root, deposit.artifactId);
      expect(read.kind).toBe("problem");
      if (read.kind !== "problem") return;
      expect(read.reason).toContain("does not hash to its own identity");
    });
  });

  it("refuses a value that is not a content identity at all", () => {
    withRoot((root) => {
      const read = readArtifactById(root, join(root, "one", "does", "not", "exist"));
      expect(read.kind).toBe("problem");
      if (read.kind !== "problem") return;
      expect(read.reason).toContain("is not a sha256 content identity");
    });
  });
});

describe("THE PROPERTY: a retained revision survives the path changing", () => {
  it("still produces revision A after the reference names revision B", () => {
    withRoot((root) => {
      const artifactRoot = join(root, "workspace");
      const storeRoot = join(root, "store");
      const ref = "evidence/report.json";
      mkdirSync(join(artifactRoot, "evidence"), { recursive: true });
      writeFileSync(join(artifactRoot, "evidence", "report.json"), A);

      // 1. The gate reads the reference and digests the bytes it read.
      const judged = readArtifact(artifactRoot, ref);
      expect(judged.kind).toBe("read");
      if (judged.kind !== "read") return;
      expect(judged.evidence.digest).toBe(digestOf(A));

      // 2. THOSE EXACT bytes are retained under their content identity.
      const deposit = deposited(storeRoot, judged.bytes);
      expect(deposit.artifactId).toBe(judged.evidence.artifactId);

      // 3. The path now names DIFFERENT bytes.
      writeFileSync(join(artifactRoot, "evidence", "report.json"), B);
      const reJudged = readArtifact(artifactRoot, ref);
      expect(reJudged.kind).toBe("read");
      if (reJudged.kind !== "read") return;
      expect(reJudged.evidence.digest).toBe(digestOf(B));
      expect(reJudged.evidence.digest).not.toBe(judged.evidence.digest);

      // 4. The RETAINED revision is still A — the accepted identity, not the
      //    path, is what a downstream consumer resolves.
      const consumed = readArtifactById(storeRoot, judged.evidence.artifactId);
      expect(consumed.kind).toBe("read");
      if (consumed.kind !== "read") return;
      expect(Buffer.compare(consumed.bytes, A)).toBe(0);
      expect(digestOf(consumed.bytes)).toBe(judged.evidence.digest);
      expect(digestOf(consumed.bytes)).not.toBe(digestOf(B));
    });
  });
});
