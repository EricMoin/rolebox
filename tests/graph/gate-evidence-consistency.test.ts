/// <reference types="bun-types" />

/**
 * Every required gate judges and retains the SAME revision (D5).
 *
 * Two defects are closed together here, and both are only observable through
 * the REAL commit path — a gate inspected in isolation cannot show what an
 * acceptance retained:
 *
 *  1. the command-exit gate's pass dropped the artifact revision it re-read
 *     after the command finished, so "the revision the command verified" was
 *     inexpressible and a command-only gate retained nothing;
 *  2. the acceptance core CONCATENATED the passes' evidence, so an artifact gate
 *     that judged revision A and a command gate that passed at revision B
 *     produced one artifact list naming both — a result whose own evidence
 *     disagrees with itself.
 *
 * The cases submit through `submitOutcome` against a real SQLite acceptance
 * ledger and read the persisted accepted result back, so the retained identity
 * is the committed one. Every case owns its `mkdtemp` directory (artifact root
 * and ledger under it) and removes it afterwards; nothing here touches the
 * workspace store.
 *
 * @module
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compileGraph,
  type SupportedValidatorV3,
} from "../../src/graph/compiler/compile.ts";
import type {
  AcceptanceRequirementV3,
  GraphDeclarationV3,
} from "../../src/graph/compiler/declaration-v3.ts";
import type { CompiledPlan } from "../../src/graph/compiler/plan.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import {
  submitOutcome,
  type AcceptanceRequest,
  type SubmissionResult,
} from "../../src/graph/outcome/acceptance.ts";
import {
  ARTIFACT_REFERENCE_VALIDATOR_ID,
  ARTIFACT_REFERENCE_VALIDATOR_VERSION,
  createArtifactReferenceValidator,
  createValidatorRegistry,
  type ValidatorImplementation,
  type ValidatorRegistry,
} from "../../src/graph/outcome/validators.ts";
import {
  COMMAND_EXIT_VALIDATOR_ID,
  COMMAND_EXIT_VALIDATOR_VERSION,
  createCommandExitValidator,
  type CommandExitEvidence,
  type TrustedCommandBinding,
} from "../../src/graph/policy/acceptance-primitives.ts";
import { artifactIdOf, digestOf } from "../../src/graph/store/artifacts.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const GRAPH = "graph.gate-evidence";
const NODE = "worker";
const ATTEMPT = "attempt-1";
const SUBMISSION = "submission-1";
const NOW = 1_700_000_000_000;
const REF = "evidence/report.txt";

const A = Buffer.from("revision A: what the first gate judged", "utf-8");
const B = Buffer.from("revision B: what the path holds later", "utf-8");

const ARTIFACT_REQUIREMENT: AcceptanceRequirementV3 = {
  validator: ARTIFACT_REFERENCE_VALIDATOR_ID,
  version: ARTIFACT_REFERENCE_VALIDATOR_VERSION,
};
const COMMAND_REQUIREMENT: AcceptanceRequirementV3 = {
  validator: COMMAND_EXIT_VALIDATOR_ID,
  version: COMMAND_EXIT_VALIDATOR_VERSION,
};

/** A one-node graph whose `done` outcome carries the given gates, in order. */
function declarationOf(
  acceptance: readonly AcceptanceRequirementV3[],
): GraphDeclarationV3 {
  return {
    version: 3,
    name: GRAPH,
    nodes: [
      {
        id: NODE,
        agent: "agent.worker",
        prompt: "Produce an outcome.",
        outcomes: [
          { id: "done", acceptance: [...acceptance] },
          { id: "failed" },
        ],
      },
    ],
    edges: [],
  };
}

/** Compile a declaration that must compile, with a useful failure. */
function planOf(acceptance: readonly AcceptanceRequirementV3[]): CompiledPlan {
  const supported: readonly SupportedValidatorV3[] = [...acceptance];
  const result = compileGraph(declarationOf(acceptance), {
    supportedValidators: [...supported],
  });
  if (!result.ok) {
    throw new Error(
      "fixture did not compile: " +
        result.errors.map((error) => error.code + "@" + error.path).join(", "),
    );
  }
  return result.plan;
}

const COMMAND_ONLY_PLAN = planOf([COMMAND_REQUIREMENT]);
const BOTH_GATES_PLAN = planOf([ARTIFACT_REQUIREMENT, COMMAND_REQUIREMENT]);

/** One case's private directory, artifact root and ledger. */
interface GateFixture {
  readonly dir: string;
  readonly artifactRoot: string;
  readonly reportPath: string;
  readonly storeRoot: string;
  readonly ledger: SqliteAcceptanceLedger;
}

/** Run one case in its own directory and remove everything afterwards. */
async function withFixture<T>(fn: (fixture: GateFixture) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "gate-evidence-"));
  const artifactRoot = join(dir, "artifacts");
  const storeRoot = join(dir, "graph-store");
  mkdirSync(join(artifactRoot, "evidence"), { recursive: true });
  const reportPath = join(artifactRoot, "evidence", "report.txt");
  writeFileSync(reportPath, A);
  let ledger: SqliteAcceptanceLedger | undefined;
  try {
    ledger = await SqliteAcceptanceLedger.create(storeRoot);
    return await fn({ dir, artifactRoot, reportPath, storeRoot, ledger });
  } finally {
    if (ledger !== undefined) ledger.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

/** The trusted command the HOST authorizes for this exact mapping. */
function commandBinding(dir: string): TrustedCommandBinding {
  return {
    graphId: GRAPH,
    nodeId: NODE,
    outcome: "done",
    argv: [process.execPath, "-e", "process.exit(0);"],
    cwd: dir,
    timeoutMs: 10_000,
    expectExitCode: 0,
    artifactRefs: [REF],
  };
}

/** The registry both gates resolve against; the artifact gate is overridable. */
function registryOf(options: {
  readonly fixture: GateFixture;
  readonly artifactGate?: ValidatorImplementation;
  readonly recorded?: CommandExitEvidence[];
}): ValidatorRegistry {
  const artifactGate =
    options.artifactGate ??
    createArtifactReferenceValidator({ artifactStoreRoot: options.fixture.storeRoot });
  return createValidatorRegistry([
    {
      id: ARTIFACT_REFERENCE_VALIDATOR_ID,
      version: ARTIFACT_REFERENCE_VALIDATOR_VERSION,
      implementation: artifactGate,
    },
    {
      id: COMMAND_EXIT_VALIDATOR_ID,
      version: COMMAND_EXIT_VALIDATOR_VERSION,
      implementation: createCommandExitValidator({
        commands: [commandBinding(options.fixture.dir)],
        ...(options.recorded === undefined
          ? {}
          : { onCheck: (evidence: CommandExitEvidence) => options.recorded?.push(evidence) }),
      }),
    },
  ]);
}

/**
 * The REAL artifact gate, plus the file moving around it.
 *
 * `before` is written BEFORE the gate reads — so the gate judges that revision
 * — and `after` is written once it has returned. That is how "the file changed
 * between the gates" is produced deterministically, with no sleep: the change
 * is an ordinary file write between two sequential gate invocations.
 */
function artifactGateAround(
  fixture: GateFixture,
  before: Buffer | undefined,
  after: Buffer | undefined,
): ValidatorImplementation {
  const gate = createArtifactReferenceValidator({
    artifactStoreRoot: fixture.storeRoot,
  });
  return (request) => {
    if (before !== undefined) writeFileSync(fixture.reportPath, before);
    const outcome = gate(request);
    if (after !== undefined) writeFileSync(fixture.reportPath, after);
    return outcome;
  };
}

/** The request both plans are submitted with. */
function requestFor(
  fixture: GateFixture,
  plan: CompiledPlan,
  validators: ValidatorRegistry,
  overrides: Partial<AcceptanceRequest> = {},
): AcceptanceRequest {
  return {
    plan,
    submittedPlanRevision: plan.planRevision,
    identity: { graphId: GRAPH, attemptId: ATTEMPT, submissionId: SUBMISSION },
    proposal: { nodeId: NODE, outcomeId: "done", evidenceRefs: [REF] },
    validators,
    artifactRoot: fixture.artifactRoot,
    now: NOW,
    ...overrides,
  };
}

/** The submission key every fixture uses. */
function key(): { graphId: string; attemptId: string; submissionId: string } {
  return { graphId: GRAPH, attemptId: ATTEMPT, submissionId: SUBMISSION };
}

/** Assert a refusal that wrote nothing at all. */
function expectRefusedWithNothingWritten(
  result: SubmissionResult,
  fixture: GateFixture,
  code: string,
): readonly string[] {
  expect(result.kind).toBe("refused");
  if (result.kind !== "refused") return [];
  const codes = result.refusals.map((refusal) => refusal.code);
  expect(codes).toContain(code);
  expect(fixture.ledger.lookupReceipt(key())).toBeUndefined();
  expect(fixture.ledger.acceptedEvents(GRAPH)).toHaveLength(0);
  expect(fixture.ledger.pendingEffects(GRAPH)).toHaveLength(0);
  expect(fixture.ledger.retainedArtifacts(GRAPH, ATTEMPT)).toBeUndefined();
  return codes;
}

// ── The command gate's own reading reaches the acceptance ───────────────────

describe("the command gate's pass carries the revision it verified", () => {
  it("a command gate ALONE retains the revision it re-read after the command", async () => {
    await withFixture(async (fixture) => {
      const recorded: CommandExitEvidence[] = [];
      const result = submitOutcome({
        ...requestFor(
          fixture,
          COMMAND_ONLY_PLAN,
          registryOf({ fixture, recorded }),
        ),
        ledger: fixture.ledger,
      });
      expect(result.kind).toBe("submitted");
      if (result.kind !== "submitted") return;
      expect(result.decision.kind).toBe("accepted");
      expect(result.decision.requirements.map((entry) => entry.outcome.kind)).toEqual([
        "pass",
      ]);

      // The PERSISTED accepted result — not the gate's return value.
      const retained = fixture.ledger.retainedArtifacts(GRAPH, ATTEMPT) ?? [];
      expect(retained).toHaveLength(1);
      const entry = retained[0];
      if (entry === undefined) return;
      expect(entry.ref).toBe(REF);
      // The bytes the path held while the command ran...
      expect(entry.artifactId).toBe(artifactIdOf(digestOf(A)));
      expect(entry.digest).toBe(digestOf(A));
      expect(entry.size).toBe(A.length);
      // ...and the gate's own POST-COMMAND reading, which is what made this
      // revision expressible at all.
      expect(recorded).toHaveLength(1);
      expect(
        recorded[0]?.artifactRevisions.map((revision) => revision.artifactId),
      ).toEqual([entry.artifactId]);
      expect(recorded[0]?.verdict).toBe("pass");
    });
  });

  it("two agreeing gates retain ONE entry, and its bytes read back", async () => {
    await withFixture(async (fixture) => {
      const result = submitOutcome({
        ...requestFor(fixture, BOTH_GATES_PLAN, registryOf({ fixture })),
        ledger: fixture.ledger,
      });
      expect(result.kind).toBe("submitted");
      if (result.kind !== "submitted") return;
      expect(result.decision.kind).toBe("accepted");
      expect(result.decision.requirements.map((entry) => entry.outcome.kind)).toEqual([
        "pass",
        "pass",
      ]);

      const retained = fixture.ledger.retainedArtifacts(GRAPH, ATTEMPT) ?? [];
      expect(retained).toHaveLength(1);
      expect(retained[0]?.ref).toBe(REF);
      expect(retained[0]?.artifactId).toBe(artifactIdOf(digestOf(A)));

      const consumed = fixture.ledger.readAcceptedArtifact(GRAPH, ATTEMPT, REF);
      expect(consumed.kind).toBe("read");
      if (consumed.kind !== "read") return;
      expect(Buffer.compare(consumed.bytes, A)).toBe(0);
    });
  });
});

// ── Conflicting gates are refused, never stitched together ──────────────────

describe("conflicting evidence across gates refuses the submission", () => {
  it("artifact gate at revision A plus command gate at revision B is REFUSED", async () => {
    await withFixture(async (fixture) => {
      const result = submitOutcome({
        ...requestFor(
          fixture,
          BOTH_GATES_PLAN,
          // The artifact gate judges A; the file moves to B before the command
          // gate reads, so the command gate passes at B.
          registryOf({ fixture, artifactGate: artifactGateAround(fixture, undefined, B) }),
        ),
        ledger: fixture.ledger,
      });
      const codes = expectRefusedWithNothingWritten(
        result,
        fixture,
        "conflicting-artifact-evidence",
      );
      expect(codes).toContain("conflicting-artifact-evidence");
      if (result.kind !== "refused") return;
      const message = result.refusals.map((refusal) => refusal.message).join(" | ");
      expect(message).toContain(JSON.stringify(REF));
      expect(message).toContain(artifactIdOf(digestOf(A)));
      expect(message).toContain(artifactIdOf(digestOf(B)));
      expect(message).toContain("REFUSED rather than committed with evidence that disagrees with itself");
    });
  });

  it("the same conflict is refused when the gates see the revisions the other way round", async () => {
    await withFixture(async (fixture) => {
      const result = submitOutcome({
        ...requestFor(
          fixture,
          BOTH_GATES_PLAN,
          // The artifact gate judges B (the file is moved to B before it reads
          // and back to A afterwards), so the command gate passes at A.
          registryOf({ fixture, artifactGate: artifactGateAround(fixture, B, A) }),
        ),
        ledger: fixture.ledger,
      });
      expectRefusedWithNothingWritten(
        result,
        fixture,
        "conflicting-artifact-evidence",
      );
      if (result.kind !== "refused") return;
      const message = result.refusals.map((refusal) => refusal.message).join(" | ");
      expect(message).toContain(artifactIdOf(digestOf(A)));
      expect(message).toContain(artifactIdOf(digestOf(B)));
    });
  });

  it("a file that changes between the gates is refused, not accepted with a stitched revision", async () => {
    await withFixture(async (fixture) => {
      const result = submitOutcome({
        ...requestFor(
          fixture,
          BOTH_GATES_PLAN,
          registryOf({ fixture, artifactGate: artifactGateAround(fixture, undefined, B) }),
        ),
        ledger: fixture.ledger,
      });
      // Neither revision won: the accepted result row does not exist, so no
      // consumer can be handed a revision list assembled from two readings.
      expectRefusedWithNothingWritten(result, fixture, "conflicting-artifact-evidence");
      expect(fixture.ledger.readAcceptedArtifact(GRAPH, ATTEMPT, REF).kind).toBe("problem");
    });
  });
});
