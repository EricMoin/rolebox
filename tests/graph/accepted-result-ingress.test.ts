/// <reference types="bun-types" />

/**
 * The SUBMISSION ingress retains what its gates read (P4 item 5 / A17).
 *
 * The store-level case proves the resolution; this one proves the WIRING: a real
 * submission through `submitOutcome` commits an accepted result whose artifacts
 * name the revisions the artifact gate actually read, and resolving them after
 * the path changed still yields the accepted revision.
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildDeclaredOutcomeGraph } from "../../src/graph/tools/declare-graph.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import { submitOutcome } from "../../src/graph/outcome/acceptance.ts";
import { digestOf } from "../../src/graph/store/artifacts.ts";
import {
  ARTIFACT_REFERENCE_VALIDATOR_ID,
  ARTIFACT_REFERENCE_VALIDATOR_VERSION,
  createArtifactReferenceValidator,
  createValidatorRegistry,
} from "../../src/graph/outcome/validators.ts";

const GRAPH = "p42.ingress";
const NODE = "work";
const ATTEMPT = "work#1";
const SUBMISSION = "sub-1";
const REF = "evidence/report.txt";
const NOW = 1_700_000_000_000;

const A = Buffer.from("revision A: the bytes the gate judged", "utf-8");
const B = Buffer.from("revision B: what the path holds afterwards", "utf-8");

const declaration = {
  version: 3,
  name: GRAPH,
  nodes: [
    {
      id: NODE,
      agent: "agent.worker",
      prompt: "Produce an outcome.",
      outcomes: [
        {
          id: "done",
          acceptance: [
            {
              validator: ARTIFACT_REFERENCE_VALIDATOR_ID,
              version: ARTIFACT_REFERENCE_VALIDATOR_VERSION,
            },
          ],
        },
      ],
    },
  ],
  edges: [],
};

describe("a real submission retains the revision its gate read", () => {
  it("commits the accepted result with the artifact identity, and resolves A after the path holds B", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p42-ingress-"));
    let ledger: SqliteAcceptanceLedger | undefined;
    try {
      const artifactRoot = join(dir, "workspace");
      mkdirSync(join(artifactRoot, "evidence"), { recursive: true });
      writeFileSync(join(artifactRoot, "evidence", "report.txt"), A);

      // The SHIPPED artifact primitive, retaining into the store root — the same
      // wiring `assembleHostCapabilities` performs.
      const validators = createValidatorRegistry([
        {
          id: ARTIFACT_REFERENCE_VALIDATOR_ID,
          version: ARTIFACT_REFERENCE_VALIDATOR_VERSION,
          implementation: createArtifactReferenceValidator({
            artifactStoreRoot: dir,
          }),
        },
      ]);
      const graph = buildDeclaredOutcomeGraph({
        declaration,
        installedValidators: validators,
        installedAcceptanceCapabilities: {
          validators: validators.keys,
          schemas: [],
          commandMappings: [],
        },
      });

      ledger = await SqliteAcceptanceLedger.create(dir);
      const submitted = await submitOutcome({
        plan: graph.plan,
        submittedPlanRevision: graph.binding.planRevision,
        identity: { graphId: GRAPH, attemptId: ATTEMPT, submissionId: SUBMISSION },
        proposal: { nodeId: NODE, outcomeId: "done", evidenceRefs: [REF] },
        validators,
        artifactRoot,
        ledger,
        now: NOW,
      });
      expect(submitted.kind).toBe("submitted");

      // THE ACCEPTED RESULT CARRIES THE REVISION THE GATE READ.
      const record = ledger.readAcceptedResult(GRAPH, ATTEMPT);
      expect(record).toBeDefined();
      expect(record?.artifacts?.length).toBe(1);
      const retained = record?.artifacts?.[0];
      expect(retained?.ref).toBe(REF);
      expect(retained?.digest).toBe(digestOf(A));

      // The path now names DIFFERENT bytes.
      writeFileSync(join(artifactRoot, "evidence", "report.txt"), B);

      const consumed = ledger.readAcceptedArtifact(GRAPH, ATTEMPT, REF);
      expect(consumed.kind).toBe("read");
      if (consumed.kind !== "read") return;
      expect(Buffer.compare(consumed.bytes, A)).toBe(0);
      expect(digestOf(consumed.bytes)).toBe(digestOf(A));
      expect(digestOf(consumed.bytes)).not.toBe(digestOf(B));
    } finally {
      ledger?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
