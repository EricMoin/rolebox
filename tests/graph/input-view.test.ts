/// <reference types="bun-types" />

/**
 * The worker-facing input view: a retained revision as a real file (D7).
 *
 * WHY THESE CASES EXIST. An `artifactId` is not delivery — the worker has no
 * store, no ledger and no access to the path a proposal named, so what it can
 * actually read has to be a file. These cases pin the properties that make the
 * materialized view delivery rather than a promise of one:
 *
 * - the bytes at the delivered path are the RETAINED ones, and the mutable
 *   source path is never read as a substitute;
 * - the digest is verified before the view is returned, and a missing, tampered
 *   or inconsistent object refuses the WHOLE view with nothing published;
 * - two consumers receive disjoint directories and independent copies, so
 *   neither can see or damage the other's files;
 * - re-delivering the same dispatch reuses its own published files (no
 *   duplicate, no truncation) and never overwrites a file that does not verify;
 * - the manifest keeps D1's absent / null / empty-object / empty-string
 *   distinction, which a consumer must be able to read back.
 *
 * STRENGTH: real filesystem, real content store, one process. No platform runs
 * here, so this is not adapter or host evidence.
 */

import { describe, it, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AcceptedData } from "../../src/graph/domain/model.ts";
import {
  INPUT_VIEW_MANIFEST_FILE,
  inputConsumerDirectory,
  materializeInputView,
  type DeliveredInputView,
  type InputDeliveryRefusal,
  type InputViewMaterialization,
} from "../../src/graph/host/input-view.ts";
import type { ResolvedInput } from "../../src/graph/outcome/inputs.ts";
import {
  artifactIdOf,
  artifactObjectPath,
  digestOf,
  putArtifact,
} from "../../src/graph/store/artifacts.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const REF = "evidence/report.txt";
const OTHER_REF = "evidence/summary.txt";
const GRAPH = "p42.input-view";

/** The retained revision, and what the mutable source path holds afterwards. */
const A = Buffer.from("{revision:A}", "utf-8");
const B = Buffer.from("{revision:B}", "utf-8");

interface Roots {
  readonly root: string;
  /** The content store the acceptance gate deposits into. */
  readonly contentStoreRoot: string;
  /** The workspace the proposal's references resolve inside. */
  readonly workspace: string;
  readonly deliveryRoot: string;
}

/** One temp tree per case, removed whatever the case does. */
async function withRoots<T>(fn: (roots: Roots) => T | Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "p42-input-view-"));
  try {
    const contentStoreRoot = join(root, "host-store");
    const workspace = join(root, "workspace");
    mkdirSync(join(workspace, "evidence"), { recursive: true });
    return await fn({
      root,
      contentStoreRoot,
      workspace,
      deliveryRoot: join(contentStoreRoot, "input-deliveries"),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Deposit one revision into the content store and answer its accepted record. */
function retain(
  contentStoreRoot: string,
  bytes: Buffer,
  ref: string,
): { readonly ref: string; readonly artifactId: string; readonly digest: string; readonly size: number } {
  const deposit = putArtifact(contentStoreRoot, bytes);
  if (deposit.kind !== "deposited") {
    throw new Error("fixture: the deposit failed: " + deposit.reason);
  }
  return {
    ref,
    artifactId: deposit.artifactId,
    digest: deposit.digest,
    size: deposit.size,
  };
}

/** One resolved input carrying the accepted data and the retained revisions. */
function inputOf(
  artifacts: readonly { readonly ref: string; readonly artifactId: string; readonly digest: string; readonly size: number }[],
  payload: AcceptedData = { kind: "absent" },
  from = "work",
  attemptId = "work#1",
): ResolvedInput {
  return { from, outcome: "done", attemptId, payload, artifacts };
}

/** Materialize, insisting the fixture materials are ready. */
function materialize(
  roots: Roots,
  inputs: readonly ResolvedInput[],
  attemptId = "review#2",
  graphId = GRAPH,
): DeliveredInputView {
  const result: InputViewMaterialization = materializeInputView({
    contentStoreRoot: roots.contentStoreRoot,
    deliveryRoot: roots.deliveryRoot,
    graphId,
    attemptId,
    inputs,
  });
  if (result.kind !== "ready") {
    throw new Error(
      "fixture: the view was refused: " +
        result.refusals.map((refusal) => refusal.code).join(","),
    );
  }
  return result.view;
}

/** Materialize, insisting the view was REFUSED, and answer the refusals. */
function refusalsOf(
  roots: Roots,
  inputs: readonly ResolvedInput[],
): readonly InputDeliveryRefusal[] {
  const result = materializeInputView({
    contentStoreRoot: roots.contentStoreRoot,
    deliveryRoot: roots.deliveryRoot,
    graphId: GRAPH,
    attemptId: "review#2",
    inputs,
  });
  if (result.kind !== "refused") {
    throw new Error("fixture: the view was expected to be refused");
  }
  return result.refusals;
}

// ── The delivered file ──────────────────────────────────────────────────────

describe("materializeInputView — the retained revision becomes a readable file", () => {
  it("publishes the retained bytes and reports the verified identity", async () => {
    await withRoots((roots) => {
      const retained = retain(roots.contentStoreRoot, A, REF);
      const view = materialize(roots, [inputOf([retained])]);

      expect(view.entries).toHaveLength(1);
      const file = view.entries[0]?.artifacts[0];
      expect(file).toBeDefined();
      if (file === undefined) return;

      // WHAT THE WORKER ACTUALLY RECEIVES: a file, at the path the view names,
      // whose bytes are the retained ones.
      expect(readFileSync(file.path).equals(A)).toBe(true);
      expect(digestOf(readFileSync(file.path))).toBe(retained.digest);
      expect(file.artifactId).toBe(retained.artifactId);
      expect(file.size).toBe(A.length);
      expect(file.path.startsWith(view.directory)).toBe(true);
      expect(file.path.endsWith(retained.digest + ".txt")).toBe(true);
      expect(existsSync(view.manifestPath)).toBe(true);
      expect(readdirSync(view.directory).sort()).toEqual(
        [file.file, INPUT_VIEW_MANIFEST_FILE].sort(),
      );

      // AND IT IS AN INDEPENDENT COPY: a hard link into the store would let a
      // worker's own write change what the accepted result means.
      const objectPath = artifactObjectPath(roots.contentStoreRoot, retained.artifactId);
      expect(statSync(objectPath).ino).not.toBe(statSync(file.path).ino);
      writeFileSync(file.path, B);
      expect(readFileSync(objectPath).equals(A)).toBe(true);
    });
  });

  it("never reads the mutable source path the proposal named", async () => {
    await withRoots((roots) => {
      // The gate read A from the workspace and retained it...
      writeFileSync(join(roots.workspace, "evidence", "report.txt"), A);
      const retained = retain(roots.contentStoreRoot, A, REF);
      // ...and by dispatch time the path holds B.
      writeFileSync(join(roots.workspace, "evidence", "report.txt"), B);

      const view = materialize(roots, [inputOf([retained])]);
      const file = view.entries[0]?.artifacts[0];
      expect(file).toBeDefined();
      if (file === undefined) return;
      expect(readFileSync(file.path).equals(A)).toBe(true);
      expect(readFileSync(file.path).equals(B)).toBe(false);

      // THE VIEW NAMES NO PATH OUTSIDE THE CONSUMER'S OWN DIRECTORY: not the
      // workspace, not the source reference, not the store object.
      const manifest = readFileSync(view.manifestPath, "utf8");
      expect(manifest).not.toContain(roots.workspace);
      expect(manifest).not.toContain(roots.contentStoreRoot);
      expect(manifest).toContain(retained.artifactId);
    });
  });

  it("creates nothing when the attempt consumes no input", async () => {
    await withRoots((roots) => {
      const view = materialize(roots, []);
      expect(view.entries).toEqual([]);
      expect(existsSync(view.directory)).toBe(false);
    });
  });
});

// ── Refusals ────────────────────────────────────────────────────────────────

describe("materializeInputView — a refusal publishes nothing", () => {
  it("refuses a missing object, naming the input and the reason", async () => {
    await withRoots((roots) => {
      const retained = retain(roots.contentStoreRoot, A, REF);
      const missing = {
        ref: OTHER_REF,
        artifactId: artifactIdOf("f".repeat(64)),
        digest: "f".repeat(64),
        size: 4,
      };
      const refusals = refusalsOf(roots, [inputOf([retained, missing])]);

      expect(refusals).toHaveLength(1);
      const refusal = refusals[0];
      expect(refusal?.code).toBe("input-artifact-unreadable");
      expect(refusal?.from).toBe("work");
      expect(refusal?.outcome).toBe("done");
      expect(refusal?.ref).toBe(OTHER_REF);
      expect(refusal?.artifactId).toBe(missing.artifactId);
      expect(refusal?.message).toContain(missing.artifactId);
      // NO PARTIAL DELIVERY: the readable revision in the same view was NOT
      // published, and the consumer's directory was never created.
      expect(existsSync(inputConsumerDirectory(roots.deliveryRoot, GRAPH, "review#2"))).toBe(false);
    });
  });

  it("refuses an object tampered with after it was retained", async () => {
    await withRoots((roots) => {
      const retained = retain(roots.contentStoreRoot, A, REF);
      writeFileSync(
        artifactObjectPath(roots.contentStoreRoot, retained.artifactId),
        B,
      );
      const refusals = refusalsOf(roots, [inputOf([retained])]);
      expect(refusals.map((refusal) => refusal.code)).toEqual([
        "input-artifact-unreadable",
      ]);
      expect(refusals[0]?.message).toContain("does not hash to its own identity");
    });
  });

  it("refuses a record whose digest disagrees with the object it names", async () => {
    await withRoots((roots) => {
      const retained = retain(roots.contentStoreRoot, A, REF);
      const inconsistent = { ...retained, digest: "e".repeat(64) };
      const refusals = refusalsOf(roots, [inputOf([inconsistent])]);
      expect(refusals.map((refusal) => refusal.code)).toEqual([
        "input-artifact-record-mismatch",
      ]);
      expect(refusals[0]?.artifactId).toBe(retained.artifactId);
      expect(refusals[0]?.message).toContain("do not describe one revision");
    });
  });

  it("refuses a record whose size disagrees with the object it names", async () => {
    await withRoots((roots) => {
      const retained = retain(roots.contentStoreRoot, A, REF);
      const inconsistent = { ...retained, size: A.length + 1 };
      const refusals = refusalsOf(roots, [inputOf([inconsistent])]);
      expect(refusals.map((refusal) => refusal.code)).toEqual([
        "input-artifact-record-mismatch",
      ]);
    });
  });
});

// ── Isolation ───────────────────────────────────────────────────────────────

describe("materializeInputView — consumers are isolated", () => {
  it("gives two consumers disjoint directories and independent copies", async () => {
    await withRoots((roots) => {
      const retained = retain(roots.contentStoreRoot, A, REF);
      const first = materialize(roots, [inputOf([retained])], "review#2");
      const second = materialize(roots, [inputOf([retained])], "audit#3");

      expect(first.directory).not.toBe(second.directory);
      const firstFile = first.entries[0]?.artifacts[0];
      const secondFile = second.entries[0]?.artifacts[0];
      expect(firstFile).toBeDefined();
      expect(secondFile).toBeDefined();
      if (firstFile === undefined || secondFile === undefined) return;

      expect(firstFile.path.startsWith(first.directory)).toBe(true);
      expect(secondFile.path.startsWith(second.directory)).toBe(true);
      // NEITHER VIEW NAMES ANYTHING INSIDE THE OTHER'S DIRECTORY.
      expect(JSON.stringify(first)).not.toContain(second.directory);
      expect(JSON.stringify(second)).not.toContain(first.directory);

      // AND THE COPIES ARE INDEPENDENT: one consumer's write is not the other's.
      writeFileSync(firstFile.path, B);
      expect(readFileSync(secondFile.path).equals(A)).toBe(true);
    });
  });

  it("gives identities that sanitize to one name different directories", async () => {
    await withRoots((roots) => {
      expect(
        inputConsumerDirectory(roots.deliveryRoot, "graph/a", "review#2"),
      ).not.toBe(
        inputConsumerDirectory(roots.deliveryRoot, "graph_a", "review#2"),
      );
      expect(
        inputConsumerDirectory(roots.deliveryRoot, GRAPH, "review/2"),
      ).not.toBe(inputConsumerDirectory(roots.deliveryRoot, GRAPH, "review_2"));
    });
  });
});

// ── Repetition ──────────────────────────────────────────────────────────────

describe("materializeInputView — a repeated delivery reuses what it published", () => {
  it("re-publishes the same paths without duplicating or rewriting them", async () => {
    await withRoots((roots) => {
      const retained = retain(roots.contentStoreRoot, A, REF);
      const inputs = [inputOf([retained])];
      const first = materialize(roots, inputs);
      const firstFile = first.entries[0]?.artifacts[0];
      expect(firstFile).toBeDefined();
      if (firstFile === undefined) return;
      const before = readdirSync(first.directory).sort();
      const inodeBefore = statSync(firstFile.path).ino;
      const manifestBefore = readFileSync(first.manifestPath, "utf8");

      const second = materialize(roots, inputs);
      const secondFile = second.entries[0]?.artifacts[0];
      expect(secondFile?.path).toBe(firstFile.path);
      expect(second.directory).toBe(first.directory);
      expect(readdirSync(second.directory).sort()).toEqual(before);
      expect(statSync(secondFile?.path ?? "").ino).toBe(inodeBefore);
      expect(readFileSync(second.manifestPath, "utf8")).toBe(manifestBefore);
      expect(readFileSync(secondFile?.path ?? "").equals(A)).toBe(true);
    });
  });

  it("refuses rather than overwriting a delivered file that does not verify", async () => {
    await withRoots((roots) => {
      const retained = retain(roots.contentStoreRoot, A, REF);
      const inputs = [inputOf([retained])];
      const first = materialize(roots, inputs);
      const file = first.entries[0]?.artifacts[0];
      expect(file).toBeDefined();
      if (file === undefined) return;
      // Something else owns that name now (a worker, a truncated write): the
      // delivery is refused and the file is left EXACTLY as it is.
      writeFileSync(file.path, B);
      const refusals = refusalsOf(roots, inputs);
      expect(refusals.map((refusal) => refusal.code)).toEqual([
        "input-view-not-published",
      ]);
      expect(readFileSync(file.path).equals(B)).toBe(true);
    });
  });
});

// ── The manifest ────────────────────────────────────────────────────────────

/**
 * The payload one manifest reports, read WITHOUT asserting a shape: the manifest
 * is a JSON file the worker reads, so the case has to narrow it like any other
 * external value.
 */
function manifestPayloadOf(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || !("inputs" in parsed)) {
    throw new Error("fixture: the manifest is not a record carrying inputs");
  }
  const inputs: unknown = parsed.inputs;
  if (!Array.isArray(inputs) || inputs.length !== 1) {
    throw new Error("fixture: the manifest does not carry exactly one input");
  }
  const entry: unknown = inputs[0];
  if (typeof entry !== "object" || entry === null || !("payload" in entry)) {
    throw new Error("fixture: the manifest entry carries no payload");
  }
  return entry.payload;
}

describe("materializeInputView — the manifest keeps D1's presence distinction", () => {
  it("spells absent, null, empty object and empty string apart", async () => {
    await withRoots((roots) => {
      const retained = retain(roots.contentStoreRoot, A, REF);
      const cases: readonly AcceptedData[] = [
        { kind: "absent" },
        { kind: "value", value: null },
        { kind: "value", value: {} },
        { kind: "value", value: "" },
      ];
      const spellings = new Set<string>();
      for (let index = 0; index < cases.length; index += 1) {
        const payload = cases[index];
        if (payload === undefined) continue;
        // One CONSUMER per case: a repeated delivery of the same attempt is
        // bound to the same view by construction (D6), so a manifest that
        // disagreed with one already published is correctly refused.
        const view = materialize(roots, [inputOf([retained], payload)], "review#" + String(index + 2));
        const read = manifestPayloadOf(readFileSync(view.manifestPath, "utf8"));
        expect(read).toEqual(payload);
        spellings.add(JSON.stringify(read));
      }
      // FOUR DISTINCT SPELLINGS: a worker reading the manifest can tell an
      // absent payload from an accepted null, an empty object and an empty
      // string, which is exactly what collapsing them would destroy.
      expect(spellings.size).toBe(4);
    });
  });
});
