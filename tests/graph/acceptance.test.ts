/**
 * Acceptance core — submission and decision contract (C3a)
 *
 * Covers the submission/acceptance core end to end against the committed plan
 * compiler and the committed SQLite acceptance ledger: a passing proposal
 * commits its receipt, accepted event and pending effects together; a failing
 * gate AND an indeterminate gate both write a rejected receipt with no event
 * and no effects; every "cannot be evaluated" input (malformed proposal,
 * unknown node, undeclared outcome, draft plan, revision and graph mismatch,
 * unregistered validator) is refused with structured repair diagnostics and
 * NOTHING is written; a digest or identity change after validation is refused
 * by the commit's recheck; a repeated submission replays the persisted
 * decision, the same key with a different digest conflicts, and a distinct
 * submission after settlement is settled; and the proposal digest cannot depend
 * on key or evidence order.
 *
 * Every case runs in its own mkdtemp directory and removes it in a finally
 * block; nothing here writes outside a temp dir.
 */

import { describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compileGraph,
  type CompileResult,
  type SupportedValidatorV3,
} from "../../src/graph/compiler/compile.ts";
import type {
  AcceptanceRequirementV3,
  GraphDeclarationV3,
} from "../../src/graph/compiler/declaration-v3.ts";
import type { CompiledPlan } from "../../src/graph/compiler/plan.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import { submitOutcome, validateSubmission, commitSubmission } from "../../src/graph/outcome/acceptance.ts";
import type {
  AcceptanceRequest,
  SubmissionRefusalCode,
} from "../../src/graph/outcome/acceptance.ts";
import {
  normalizeProposal,
  proposalDigest,
  readOutcomeProposal,
} from "../../src/graph/outcome/proposal.ts";
import {
  ARTIFACT_REFERENCE_VALIDATOR_ID,
  ARTIFACT_REFERENCE_VALIDATOR_VERSION,
  createArtifactReferenceValidator,
  createValidatorRegistry,
  readArtifact,
} from "../../src/graph/outcome/validators.ts";
import type {
  ArtifactEvidence,
  ValidatorRegistry,
} from "../../src/graph/outcome/validators.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const GRAPH = "graph.acceptance";
const NODE = "worker";
const ATTEMPT = "attempt-1";
const SUBMISSION = "submission-1";
const NOW = 1_700_000_000_000;

const ARTIFACT_REQUIREMENT: AcceptanceRequirementV3 = {
  validator: ARTIFACT_REFERENCE_VALIDATOR_ID,
  version: ARTIFACT_REFERENCE_VALIDATOR_VERSION,
};

/** A one-node graph whose `done` outcome carries the given gates. */
function minimalDeclaration(
  acceptance?: readonly AcceptanceRequirementV3[],
  prompt = "Produce an outcome.",
): GraphDeclarationV3 {
  return {
    version: 3,
    name: GRAPH,
    nodes: [
      {
        id: NODE,
        agent: "agent.worker",
        prompt,
        outcomes: [
          acceptance === undefined
            ? { id: "done" }
            : { id: "done", acceptance: [...acceptance] },
          { id: "failed" },
        ],
      },
    ],
    edges: [],
  };
}

/** Compile a declaration that must compile, with a useful failure. */
function planOf(
  acceptance?: readonly AcceptanceRequirementV3[],
  supported?: readonly SupportedValidatorV3[],
  prompt?: string,
): CompiledPlan {
  const result: CompileResult = compileGraph(
    minimalDeclaration(acceptance, prompt),
    supported === undefined ? undefined : { supportedValidators: [...supported] },
  );
  if (!result.ok) {
    throw new Error(
      "fixture did not compile: " +
        result.errors.map((error) => error.code + "@" + error.path).join(", "),
    );
  }
  return result.plan;
}

/** An executable plan whose `done` outcome requires the artifact gate. */
const ARTIFACT_PLAN = planOf([ARTIFACT_REQUIREMENT], [ARTIFACT_REQUIREMENT]);

/** A NON-EXECUTABLE draft: the same gate, compiled with no capability set. */
const DRAFT_PLAN = planOf([ARTIFACT_REQUIREMENT]);

/** An executable plan with one gate the tests implement themselves. */
const FLAKY_REQUIREMENT: AcceptanceRequirementV3 = {
  validator: "gate.flaky",
  version: 3,
};
const FLAKY_PLAN = planOf([FLAKY_REQUIREMENT], [FLAKY_REQUIREMENT]);

/** The artifact validator alone, with no recorder. */
function artifactRegistry(): ValidatorRegistry {
  return createValidatorRegistry([
    {
      id: ARTIFACT_REFERENCE_VALIDATOR_ID,
      version: ARTIFACT_REFERENCE_VALIDATOR_VERSION,
      implementation: createArtifactReferenceValidator(),
    },
  ]);
}

/** The proposal a passing submission carries. */
function passingProposal(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    nodeId: NODE,
    outcomeId: "done",
    evidenceRefs: ["evidence/report.txt"],
    ...overrides,
  };
}

/** A request against `root`; every field can be overridden per case. */
function requestFor(
  root: string,
  overrides: Partial<AcceptanceRequest> = {},
): AcceptanceRequest {
  return {
    plan: ARTIFACT_PLAN,
    submittedPlanRevision: ARTIFACT_PLAN.planRevision,
    identity: { graphId: GRAPH, attemptId: ATTEMPT, submissionId: SUBMISSION },
    proposal: passingProposal(),
    validators: artifactRegistry(),
    artifactRoot: root,
    now: NOW,
    ...overrides,
  };
}

/** Run one case in its own ledger directory and clean up afterwards. */
async function withLedger<T>(
  fn: (ledger: SqliteAcceptanceLedger, dir: string) => T | Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "rolebox-acceptance-"));
  let ledger: SqliteAcceptanceLedger | undefined;
  try {
    ledger = await SqliteAcceptanceLedger.create(dir);
    return await fn(ledger, dir);
  } finally {
    if (ledger !== undefined) ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** An artifact root with one readable file `evidence/report.txt`. */
function artifactRoot(dir: string): string {
  const root = join(dir, "artifacts");
  mkdirSync(join(root, "evidence"), { recursive: true });
  writeFileSync(join(root, "evidence", "report.txt"), "artifact-bytes");
  return root;
}

/** The submission key every fixture uses. */
function key(overrides: Partial<Record<"submissionId", string>> = {}) {
  return {
    graphId: GRAPH,
    attemptId: ATTEMPT,
    submissionId: overrides.submissionId ?? SUBMISSION,
  };
}

/** Assert that a refusal names one code and wrote nothing at all. */
function expectRefusedWithNothingWritten(
  result: Awaited<ReturnType<typeof submitOutcome>>,
  ledger: SqliteAcceptanceLedger,
  code: SubmissionRefusalCode,
): void {
  expect(result.kind).toBe("refused");
  if (result.kind !== "refused") return;
  expect(result.refusals.map((refusal) => refusal.code)).toContain(code);
  expect(ledger.lookupReceipt(key())).toBeUndefined();
  expect(ledger.acceptedEvents(GRAPH)).toHaveLength(0);
  expect(ledger.pendingEffects(GRAPH)).toHaveLength(0);
}

// ── The accepted path ───────────────────────────────────────────────────────

describe("acceptance — the accepted path", () => {
  it("commits the receipt, the accepted event and the pending effects together", async () => {
    await withLedger(async (ledger, dir) => {
      const root = artifactRoot(dir);
      const recorded: ArtifactEvidence[] = [];
      const request = requestFor(root, {
        validators: createValidatorRegistry([
          {
            id: ARTIFACT_REFERENCE_VALIDATOR_ID,
            version: ARTIFACT_REFERENCE_VALIDATOR_VERSION,
            implementation: createArtifactReferenceValidator({
              onArtifact: (evidence) => recorded.push(evidence),
            }),
          },
        ]),
        effects: [
          { effectId: "effect-1", kind: "dispatch", payload: { node: NODE } },
        ],
      });

      const result = submitOutcome({ ...request, ledger });
      expect(result.kind).toBe("submitted");
      if (result.kind !== "submitted") return;
      expect(result.decision.kind).toBe("accepted");
      expect(result.decision.nodeId).toBe(NODE);
      expect(result.decision.outcomeId).toBe("done");
      expect(result.decision.planRevision).toBe(ARTIFACT_PLAN.planRevision);
      expect(result.decision.requirements.map((entry) => entry.outcome.kind)).toEqual([
        "pass",
      ]);
      expect(result.verdict.kind).toBe("committed");

      // The three writes are one acceptance: receipt, event and effect.
      const receipt = ledger.lookupReceipt(key());
      expect(receipt?.decision).toBe("accepted");
      expect(receipt?.planRevision).toBe(ARTIFACT_PLAN.planRevision);
      expect(receipt?.proposalDigest).toBe(result.decision.proposalDigest);
      expect(receipt?.committedAt).toBe(NOW);

      const events = ledger.acceptedEvents(GRAPH);
      expect(events).toHaveLength(1);
      expect(events[0]?.outcomeId).toBe("done");
      expect(events[0]?.submissionId).toBe(SUBMISSION);
      expect(events[0]?.planRevision).toBe(ARTIFACT_PLAN.planRevision);

      const effects = ledger.pendingEffects(GRAPH);
      expect(effects).toHaveLength(1);
      expect(effects[0]?.effectId).toBe("effect-1");
      expect(effects[0]?.kind).toBe("dispatch");
      expect(effects[0]?.payload).toEqual({ node: NODE });
      // Provenance comes from the trusted context and the explicit clock.
      expect(effects[0]?.graphId).toBe(GRAPH);
      expect(effects[0]?.attemptId).toBe(ATTEMPT);
      expect(effects[0]?.createdAt).toBe(NOW);
      expect(effects[0]?.status).toBe("pending");

      // The artifact validator read the artifact and recorded its digest/size.
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.ref).toBe("evidence/report.txt");
      expect(recorded[0]?.size).toBe(Buffer.byteLength("artifact-bytes"));
      expect(recorded[0]?.digest).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it("accepts an outcome that declares no acceptance requirements", async () => {
    await withLedger(async (ledger, dir) => {
      const root = artifactRoot(dir);
      const plan = planOf(undefined, []);
      const result = submitOutcome({
        ...requestFor(root, {
          plan,
          submittedPlanRevision: plan.planRevision,
          proposal: { nodeId: NODE, outcomeId: "done" },
        }),
        ledger,
      });
      expect(result.kind).toBe("submitted");
      if (result.kind !== "submitted") return;
      expect(result.decision.kind).toBe("accepted");
      expect(result.decision.requirements).toHaveLength(0);
      expect(result.verdict.kind).toBe("committed");
    });
  });

  it("records the artifact a committed acceptance referenced", async () => {
    await withLedger(async (ledger, dir) => {
      const root = artifactRoot(dir);
      const read = readArtifact(root, "evidence/report.txt");
      expect(read.kind).toBe("read");
      if (read.kind !== "read") return;
      expect(read.evidence.size).toBe(Buffer.byteLength("artifact-bytes"));

      const result = submitOutcome({ ...requestFor(root), ledger });
      expect(result.kind).toBe("submitted");
    });
  });
});

// ── The rejected paths ──────────────────────────────────────────────────────

describe("acceptance — the rejected paths", () => {
  it("writes a rejected receipt with NO accepted event and no effects when a gate fails", async () => {
    await withLedger(async (ledger, dir) => {
      // The root exists but the referenced artifact does not.
      const root = join(dir, "artifacts");
      mkdirSync(root, { recursive: true });
      const result = submitOutcome({
        ...requestFor(root, {
          effects: [
            { effectId: "effect-1", kind: "dispatch", payload: { node: NODE } },
          ],
        }),
        ledger,
      });
      expect(result.kind).toBe("submitted");
      if (result.kind !== "submitted") return;
      expect(result.decision.kind).toBe("rejected");
      expect(result.decision.requirements.map((entry) => entry.outcome.kind)).toEqual([
        "fail",
      ]);
      expect(result.verdict.kind).toBe("committed");
      if (result.verdict.kind !== "committed") return;
      expect(result.verdict.receipt.decision).toBe("rejected");
      expect(ledger.lookupReceipt(key())?.decision).toBe("rejected");
      // A rejected proposal does not enter the accepted-event stream, does not
      // settle the attempt, and commits no effect.
      expect(ledger.acceptedEvents(GRAPH)).toHaveLength(0);
      expect(ledger.pendingEffects(GRAPH)).toHaveLength(0);
    });
  });

  it("rejects an INDETERMINATE gate, which never satisfies a required gate", async () => {
    await withLedger(async (ledger, dir) => {
      const root = artifactRoot(dir);
      const registry = createValidatorRegistry([
        {
          id: FLAKY_REQUIREMENT.validator,
          version: FLAKY_REQUIREMENT.version ?? 0,
          implementation: () => ({
            kind: "indeterminate",
            reason: "the check could not be completed",
          }),
        },
      ]);
      const result = submitOutcome({
        ...requestFor(root, {
          plan: FLAKY_PLAN,
          submittedPlanRevision: FLAKY_PLAN.planRevision,
          proposal: { nodeId: NODE, outcomeId: "done" },
          validators: registry,
          effects: [{ effectId: "effect-1", kind: "dispatch", payload: null }],
        }),
        ledger,
      });
      expect(result.kind).toBe("submitted");
      if (result.kind !== "submitted") return;
      expect(result.decision.kind).toBe("rejected");
      expect(result.decision.requirements[0]?.outcome.kind).toBe("indeterminate");
      expect(ledger.lookupReceipt(key())?.decision).toBe("rejected");
      expect(ledger.acceptedEvents(GRAPH)).toHaveLength(0);
      expect(ledger.pendingEffects(GRAPH)).toHaveLength(0);
    });
  });

  it("turns a validator that throws into an indeterminate, rejected gate", async () => {
    await withLedger(async (ledger, dir) => {
      const root = artifactRoot(dir);
      const registry = createValidatorRegistry([
        {
          id: FLAKY_REQUIREMENT.validator,
          version: FLAKY_REQUIREMENT.version ?? 0,
          implementation: () => {
            throw new Error("probe exploded");
          },
        },
      ]);
      const result = submitOutcome({
        ...requestFor(root, {
          plan: FLAKY_PLAN,
          submittedPlanRevision: FLAKY_PLAN.planRevision,
          proposal: { nodeId: NODE, outcomeId: "done" },
          validators: registry,
        }),
        ledger,
      });
      expect(result.kind).toBe("submitted");
      if (result.kind !== "submitted") return;
      expect(result.decision.kind).toBe("rejected");
      expect(result.decision.requirements[0]?.outcome.kind).toBe("indeterminate");
      expect(ledger.lookupReceipt(key())?.decision).toBe("rejected");
    });
  });

  it("rejects an artifact gate whose evidence set is empty", async () => {
    await withLedger(async (ledger, dir) => {
      const root = artifactRoot(dir);
      const result = submitOutcome({
        ...requestFor(root, { proposal: { nodeId: NODE, outcomeId: "done" } }),
        ledger,
      });
      expect(result.kind).toBe("submitted");
      if (result.kind !== "submitted") return;
      expect(result.decision.kind).toBe("rejected");
      expect(result.decision.requirements[0]?.outcome.kind).toBe("fail");
    });
  });
});

// ── The refusal gates ───────────────────────────────────────────────────────

describe("acceptance — refusals write nothing", () => {
  const cases: readonly {
    readonly name: string;
    readonly code: SubmissionRefusalCode;
    readonly overrides: Partial<AcceptanceRequest>;
  }[] = [
    {
      name: "a malformed proposal",
      code: "malformed-proposal",
      overrides: { proposal: { outcomeId: "done" } },
    },
    {
      name: "a proposal that tries to name its own execution",
      code: "malformed-proposal",
      overrides: {
        proposal: passingProposal({ graphId: "other-graph", attemptId: "other" }),
      },
    },
    {
      name: "an unknown node",
      code: "unknown-node",
      overrides: {
        proposal: { nodeId: "no-such-node", outcomeId: "done" },
      },
    },
    {
      name: "an undeclared outcome",
      code: "undeclared-outcome",
      overrides: {
        proposal: { nodeId: NODE, outcomeId: "no-such-outcome" },
      },
    },
    {
      name: "a draft plan",
      code: "non-executable-plan",
      overrides: {
        plan: DRAFT_PLAN,
        submittedPlanRevision: DRAFT_PLAN.planRevision,
      },
    },
    {
      name: "a plan revision that disagrees with the binding",
      code: "plan-revision-mismatch",
      overrides: { submittedPlanRevision: "a-different-revision" },
    },
    {
      name: "a trusted graph that disagrees with the plan",
      code: "graph-mismatch",
      overrides: {
        identity: { graphId: "other-graph", attemptId: ATTEMPT, submissionId: SUBMISSION },
      },
    },
    {
      name: "an unrepresentable payload",
      code: "unrepresentable-proposal",
      overrides: {
        proposal: passingProposal({ data: { probe: () => 1 } }),
      },
    },
    {
      name: "a duplicate effect id",
      code: "malformed-effect",
      overrides: {
        effects: [
          { effectId: "effect-1", kind: "dispatch", payload: null },
          { effectId: "effect-1", kind: "notify", payload: null },
        ],
      },
    },
    {
      name: "a clock that is not epoch milliseconds",
      code: "invalid-timestamp",
      overrides: { now: 1.5 },
    },
  ];

  for (const gateCase of cases) {
    it(`refuses ${gateCase.name} and writes nothing`, async () => {
      await withLedger(async (ledger, dir) => {
        const root = artifactRoot(dir);
        const result = submitOutcome({
          ...requestFor(root, gateCase.overrides),
          ledger,
        });
        expectRefusedWithNothingWritten(result, ledger, gateCase.code);
      });
    });
  }

  it("refuses a requirement with no registered implementation", async () => {
    await withLedger(async (ledger, dir) => {
      const root = artifactRoot(dir);
      const result = submitOutcome({
        ...requestFor(root, { validators: createValidatorRegistry([]) }),
        ledger,
      });
      expectRefusedWithNothingWritten(result, ledger, "validator-not-registered");
      if (result.kind !== "refused") return;
      expect(result.refusals[0]?.message).toContain(
        `${ARTIFACT_REFERENCE_VALIDATOR_ID}@${ARTIFACT_REFERENCE_VALIDATOR_VERSION}`,
      );
    });
  });

  it("refuses before running any gate when ONE of several is unregistered", async () => {
    await withLedger(async (ledger, dir) => {
      const root = artifactRoot(dir);
      let ran = 0;
      const registry = createValidatorRegistry([
        {
          id: FLAKY_REQUIREMENT.validator,
          version: FLAKY_REQUIREMENT.version ?? 0,
          implementation: () => {
            ran += 1;
            return { kind: "pass" };
          },
        },
      ]);
      const both: AcceptanceRequirementV3[] = [
        FLAKY_REQUIREMENT,
        { validator: "gate.uninstalled", version: 1 },
      ];
      const plan = planOf(both, [
        FLAKY_REQUIREMENT,
        { validator: "gate.uninstalled", version: 1 },
      ]);
      const result = submitOutcome({
        ...requestFor(root, {
          plan,
          submittedPlanRevision: plan.planRevision,
          proposal: { nodeId: NODE, outcomeId: "done" },
          validators: registry,
        }),
        ledger,
      });
      expectRefusedWithNothingWritten(result, ledger, "validator-not-registered");
      // Nothing ran: a partially checked submission is never evaluated.
      expect(ran).toBe(0);
    });
  });
});

// ── The commit recheck ──────────────────────────────────────────────────────

describe("acceptance — validation is rechecked at the commit boundary", () => {
  it("refuses a proposal whose digest changed after validation", async () => {
    await withLedger(async (ledger, dir) => {
      const root = artifactRoot(dir);
      const request = requestFor(root);
      const validation = validateSubmission(request);
      expect(validation.kind).toBe("validated");
      if (validation.kind !== "validated") return;
      expect(validation.decision.kind).toBe("accepted");

      const result = commitSubmission({
        ...request,
        ledger,
        validation,
        proposal: passingProposal({ data: { changed: "after validation" } }),
      });
      expect(result.kind).toBe("refused");
      if (result.kind !== "refused") return;
      expect(result.refusals.map((refusal) => refusal.code)).toContain(
        "stale-validation",
      );
      expect(ledger.lookupReceipt(key())).toBeUndefined();
      expect(ledger.acceptedEvents(GRAPH)).toHaveLength(0);
      expect(ledger.pendingEffects(GRAPH)).toHaveLength(0);
    });
  });

  it("refuses a changed execution identity after validation", async () => {
    await withLedger(async (ledger, dir) => {
      const root = artifactRoot(dir);
      const request = requestFor(root);
      const validation = validateSubmission(request);
      expect(validation.kind).toBe("validated");
      if (validation.kind !== "validated") return;

      const result = commitSubmission({
        ...request,
        ledger,
        validation,
        identity: {
          graphId: GRAPH,
          attemptId: "attempt-2",
          submissionId: SUBMISSION,
        },
      });
      expect(result.kind).toBe("refused");
      if (result.kind !== "refused") return;
      expect(result.refusals[0]?.code).toBe("stale-validation");
      expect(ledger.lookupReceipt(key())).toBeUndefined();
    });
  });

  it("refuses a plan revision that changed after validation", async () => {
    await withLedger(async (ledger, dir) => {
      const root = artifactRoot(dir);
      const request = requestFor(root);
      const validation = validateSubmission(request);
      expect(validation.kind).toBe("validated");
      if (validation.kind !== "validated") return;

      // A different plan body — a different content address — is a different
      // revision, so this validation describes the old one.
      const otherPlan = planOf(
        [ARTIFACT_REQUIREMENT],
        [ARTIFACT_REQUIREMENT],
        "A different prompt, hence a different plan revision.",
      );
      expect(otherPlan.planRevision).not.toBe(ARTIFACT_PLAN.planRevision);
      const result = commitSubmission({
        ...request,
        ledger,
        validation,
        plan: otherPlan,
        submittedPlanRevision: otherPlan.planRevision,
      });
      expect(result.kind).toBe("refused");
      if (result.kind !== "refused") return;
      expect(result.refusals.map((refusal) => refusal.code)).toContain(
        "stale-validation",
      );
      expect(ledger.acceptedEvents(GRAPH)).toHaveLength(0);
    });
  });
});

// ── Idempotency through the ledger ──────────────────────────────────────────

describe("acceptance — idempotency and settlement", () => {
  it("replays a repeated identical submission with the persisted decision", async () => {
    await withLedger(async (ledger, dir) => {
      const root = artifactRoot(dir);
      const request = requestFor(root, {
        effects: [{ effectId: "effect-1", kind: "dispatch", payload: null }],
      });
      const first = submitOutcome({ ...request, ledger });
      expect(first.kind).toBe("submitted");
      if (first.kind !== "submitted") return;
      expect(first.verdict.kind).toBe("committed");
      if (first.verdict.kind !== "committed") return;

      const second = submitOutcome({ ...request, ledger });
      expect(second.kind).toBe("submitted");
      if (second.kind !== "submitted") return;
      expect(second.verdict.kind).toBe("replayed");
      if (second.verdict.kind !== "replayed") return;
      // The SAME persisted receipt, not a second row.
      expect(second.verdict.receipt).toEqual(first.verdict.receipt);
      expect(ledger.acceptedEvents(GRAPH)).toHaveLength(1);
      expect(ledger.pendingEffects(GRAPH)).toHaveLength(1);
    });
  });

  it("conflicts when the same key is reused with a different digest", async () => {
    await withLedger(async (ledger, dir) => {
      const root = join(dir, "artifacts");
      mkdirSync(root, { recursive: true });
      const first = submitOutcome({
        ...requestFor(root, {
          proposal: passingProposal({ data: { attempt: 1 } }),
        }),
        ledger,
      });
      expect(first.kind).toBe("submitted");
      if (first.kind !== "submitted") return;
      expect(first.verdict.kind).toBe("committed");
      if (first.verdict.kind !== "committed") return;

      const second = submitOutcome({
        ...requestFor(root, {
          proposal: passingProposal({ data: { attempt: 2 } }),
        }),
        ledger,
      });
      expect(second.kind).toBe("submitted");
      if (second.kind !== "submitted") return;
      expect(second.verdict.kind).toBe("conflict");
      // Nothing was rewritten: the key still names the first proposal.
      const receipt = ledger.lookupReceipt(key());
      expect(receipt?.proposalDigest).toBe(first.verdict.receipt.proposalDigest);
      expect(ledger.acceptedEvents(GRAPH)).toHaveLength(0);
    });
  });

  it("settles a distinct submission after settlement", async () => {
    await withLedger(async (ledger, dir) => {
      const root = artifactRoot(dir);
      const first = submitOutcome({ ...requestFor(root), ledger });
      expect(first.kind).toBe("submitted");
      if (first.kind !== "submitted") return;
      expect(first.verdict.kind).toBe("committed");

      const second = submitOutcome({
        ...requestFor(root, {
          identity: {
            graphId: GRAPH,
            attemptId: ATTEMPT,
            submissionId: "submission-2",
          },
        }),
        ledger,
      });
      expect(second.kind).toBe("submitted");
      if (second.kind !== "submitted") return;
      expect(second.verdict.kind).toBe("settled");
      // The accepted result is never overwritten.
      expect(ledger.acceptedEvents(GRAPH)).toHaveLength(1);
      expect(ledger.acceptedEvents(GRAPH)[0]?.submissionId).toBe(SUBMISSION);
      expect(ledger.lookupReceipt(key({ submissionId: "submission-2" }))).toBeUndefined();
    });
  });
});

// ── Proposal canonical form and digest ──────────────────────────────────────

describe("proposal canonical form", () => {
  it("does not depend on key order", () => {
    const a = {
      nodeId: NODE,
      outcomeId: "done",
      data: { alpha: 1, beta: { x: 2, y: 3 } },
    };
    const b = {
      data: { beta: { y: 3, x: 2 }, alpha: 1 },
      outcomeId: "done",
      nodeId: NODE,
    };
    expect(proposalDigest(a)).toBe(proposalDigest(b));
  });

  it("does not depend on evidence-reference order or repetition", () => {
    const base = { nodeId: NODE, outcomeId: "done" };
    const first = proposalDigest({ ...base, evidenceRefs: ["b.txt", "a.txt"] });
    const second = proposalDigest({ ...base, evidenceRefs: ["a.txt", "b.txt", "a.txt"] });
    expect(first).toBe(second);
  });

  it("normalizes to a deeply frozen canonical form", () => {
    const normalized = normalizeProposal({
      nodeId: NODE,
      outcomeId: "done",
      data: { nested: { list: [1, 2, 3] } },
      evidenceRefs: ["b.txt", "a.txt", "b.txt"],
    });
    expect(normalized.evidenceRefs).toEqual(["a.txt", "b.txt"]);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.evidenceRefs)).toBe(true);
    expect(Object.isFrozen(normalized.data)).toBe(true);
    const data = normalized.data as { nested: { list: number[] } };
    expect(Object.isFrozen(data.nested)).toBe(true);
    expect(Object.isFrozen(data.nested.list)).toBe(true);
    // Idempotent: normalizing the canonical form changes nothing.
    expect(proposalDigest(normalized)).toBe(proposalDigest(normalized));
  });

  it("refuses an unrepresentable payload before hashing", () => {
    expect(() =>
      proposalDigest({
        nodeId: NODE,
        outcomeId: "done",
        data: { probe: () => 1 },
      }),
    ).toThrow(/contract-digest/);
  });

  it("reads the shape into a fresh, closed record", () => {
    const reading = readOutcomeProposal({
      nodeId: NODE,
      outcomeId: "done",
      data: { kept: true },
    });
    expect(reading.kind).toBe("ok");
    if (reading.kind !== "ok") return;
    expect(reading.proposal.data).toEqual({ kept: true });

    expect(readOutcomeProposal(null).kind).toBe("malformed");
    expect(readOutcomeProposal([]).kind).toBe("malformed");
    expect(readOutcomeProposal({ nodeId: NODE, outcomeId: "done", extra: 1 }).kind).toBe(
      "malformed",
    );
  });
});

// ── The artifact validator's containment rule ───────────────────────────────

describe("artifact-reference validator", () => {
  it("refuses a reference that escapes the artifact root", async () => {
    await withLedger(async (ledger, dir) => {
      const root = artifactRoot(dir);
      writeFileSync(join(dir, "outside.txt"), "outside");
      const result = submitOutcome({
        ...requestFor(root, {
          proposal: passingProposal({
            evidenceRefs: ["../outside.txt"],
          }),
        }),
        ledger,
      });
      expect(result.kind).toBe("submitted");
      if (result.kind !== "submitted") return;
      expect(result.decision.kind).toBe("rejected");
    });
  });

  it("refuses a symlink that resolves outside the root", async () => {
    await withLedger(async (ledger, dir) => {
      const root = artifactRoot(dir);
      writeFileSync(join(dir, "outside.txt"), "outside");
      symlinkSync(join(dir, "outside.txt"), join(root, "link.txt"));
      const read = readArtifact(root, "link.txt");
      expect(read.kind).toBe("problem");
      if (read.kind !== "problem") return;
      expect(read.reason).toContain("outside the artifact root");
    });
  });

  it("refuses a directory as evidence", async () => {
    await withLedger(async (ledger, dir) => {
      const root = artifactRoot(dir);
      const read = readArtifact(root, "evidence");
      expect(read.kind).toBe("problem");
    });
  });
});
