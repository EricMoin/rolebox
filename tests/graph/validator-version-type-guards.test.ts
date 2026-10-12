/// <reference types="bun-types" />

/**
 * The validator-version domain has ONE total reader (F-10).
 *
 * WHY THIS FILE EXISTS. A validator version used to be a bare `number` copied
 * verbatim from a declared capability into the compiled plan, while the
 * plan-level pinning rule only asked `isFiniteNumber`. Every other reader in
 * the domain asks for a POSITIVE SAFE INTEGER (`createValidatorRegistry`,
 * `substantiateSchema`, the acceptance core). So a declaration whose capability
 * was declared at `-1`, `0`, `1.5` or `2^53` compiled `kind: "executable"`
 * pinning that exact value, and the run path then refused every submission —
 * for `0`, `1.5` and the unsafe integer with `non-executable-plan` — so the
 * executability marker and the run path disagreed about the same field, learned
 * submission by submission.
 *
 * The cases below are the pre-fix hole, one runtime case per unreadable shape,
 * at all three reading levels: the compiler refuses a DECLARED requirement
 * version that does not read, refuses a CAPABILITY whose declared version does
 * not read instead of copying it, and the plan inspector refuses an executable
 * plan that pins one. `readValidatorVersion` is the one predicate behind all
 * three, so the writer and the readers cannot drift.
 *
 * COMPATIBILITY. Every version the shipped capabilities declare is a positive
 * safe integer, and a version-1 declaration still compiles to the same
 * executable plan whose pinned requirement the acceptance core accepts.
 *
 * @module
 */

import { describe, expect, expectTypeOf, it } from "bun:test";
import { tmpdir } from "node:os";

import { compileGraph } from "../../src/graph/compiler/compile.ts";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import {
  inspectCompiledTopology,
  readValidatorVersion,
  type CompiledPlan,
} from "../../src/graph/compiler/plan.ts";
import {
  validateSubmission,
  type AcceptanceRequest,
} from "../../src/graph/outcome/acceptance.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import {
  ARTIFACT_VALIDATOR_ID,
  ARTIFACT_VALIDATOR_VERSION,
  COMMAND_EXIT_VALIDATOR_ID,
  COMMAND_EXIT_VALIDATOR_VERSION,
  PRINCIPAL_APPROVAL_VALIDATOR_ID,
  PRINCIPAL_APPROVAL_VALIDATOR_VERSION,
  SCHEMA_VALIDATOR_ID,
  SCHEMA_VALIDATOR_VERSION,
} from "../../src/graph/policy/acceptance-primitives.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const GATE = "gate.check";
const GRAPH = "graph.validator-version";
const NODE = "work";
const OUTCOME = "done";
const ATTEMPT = "attempt-1";
const SUBMISSION = "submission-1";
const NOW = 1_700_000_000_000;

/** `2^53`, the first integer a JS number cannot tell from its neighbour. */
const UNSAFE_INTEGER = 9_007_199_254_740_992;

/** Every version shape the shared reader must refuse. */
const UNREADABLE_VERSIONS: readonly number[] = [
  -1,
  0,
  1.5,
  UNSAFE_INTEGER,
  Number.NaN,
];

/** The declared version as it appears in a case name (`NaN` is spelled out). */
function label(version: number): string {
  return Number.isNaN(version) ? "NaN" : String(version);
}

/** A one-node graph whose `done` outcome carries one validator requirement. */
function declaration(validator: string, version?: number): GraphDeclarationV3 {
  return {
    version: 3,
    name: GRAPH,
    nodes: [
      {
        id: NODE,
        agent: "agent.work",
        prompt: "Do the work.",
        outcomes: [
          version === undefined
            ? { id: OUTCOME, acceptance: [{ validator }] }
            : { id: OUTCOME, acceptance: [{ validator, version }] },
        ],
      },
    ],
    edges: [],
  };
}

/** The plan of a compilation that must succeed, as an executable plan. */
function executablePlan(validator: string, version: number): CompiledPlan {
  const result = compileGraph(declaration(validator, version), {
    supportedValidators: [{ validator, version }],
  });
  if (!result.ok) {
    throw new Error(
      "fixture did not compile: " +
        result.errors.map((error) => error.code + "@" + error.path).join(", "),
    );
  }
  expect(result.plan.executability).toEqual({ kind: "executable" });
  return result.plan;
}

/** The requirement path a refused declaration names. */
const REQUIREMENT_PATH = `nodes.${NODE}.outcomes[0].acceptance[0]`;

// ── The reader ──────────────────────────────────────────────────────────────

describe("F-10 — the validator-version reader", () => {
  it("answers a positive safe integer or `undefined`, and nothing else", () => {
    expectTypeOf<ReturnType<typeof readValidatorVersion>>().toEqualTypeOf<
      number | undefined
    >();
    expect(readValidatorVersion(1)).toBe(1);
    expect(readValidatorVersion(Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    for (const version of UNREADABLE_VERSIONS) {
      expect(readValidatorVersion(version)).toBeUndefined();
    }
    expect(readValidatorVersion("1")).toBeUndefined();
    expect(readValidatorVersion(undefined)).toBeUndefined();
    expect(readValidatorVersion(null)).toBeUndefined();
  });

  // ── The writer: the declaration's own version ─────────────────────────────

  for (const version of UNREADABLE_VERSIONS) {
    it(`refuses a requirement that declares version ${label(version)}`, () => {
      const result = compileGraph(declaration(GATE, version), {
        supportedValidators: [{ validator: GATE, version }],
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.map((error) => error.code)).toContain(
        "malformed-declaration",
      );
      expect(result.errors.map((error) => error.path)).toContain(
        REQUIREMENT_PATH,
      );
    });
  }

  // ── The writer: the declared CAPABILITY's version ─────────────────────────

  for (const version of UNREADABLE_VERSIONS) {
    it(`refuses a capability that declares version ${label(version)}`, () => {
      // The requirement names no version, so the capability alone supplies the
      // pin — exactly the path that used to copy the value verbatim.
      const result = compileGraph(declaration(GATE), {
        supportedValidators: [{ validator: GATE, version }],
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.map((error) => error.code)).toContain(
        "unpinned-validator-version",
      );
      // The compiler names the requirement itself. Pre-fix only the NaN shape
      // was refused at all, by the plan inspector under `$plan`.
      expect(result.errors.map((error) => error.path)).toContain(
        REQUIREMENT_PATH,
      );
    });
  }

  // ── The plan-level reader: an executable plan that pins one ───────────────

  for (const version of UNREADABLE_VERSIONS) {
    it(`refuses an executable plan pinning version ${label(version)}`, () => {
      const inspection = inspectCompiledTopology(
        [
          {
            id: NODE,
            outcomes: [
              { id: OUTCOME, acceptance: [{ validator: GATE, version }] },
            ],
          },
        ],
        [],
        [],
        [{ nodeId: NODE, outcome: OUTCOME }],
        { kind: "executable" },
      );
      expect(inspection.issues.map((found) => found.code)).toContain(
        "unpinned-validator-version",
      );
    });
  }

  it("accepts an executable plan pinned to version 1", () => {
    const inspection = inspectCompiledTopology(
      [
        {
          id: NODE,
          outcomes: [
            { id: OUTCOME, acceptance: [{ validator: GATE, version: 1 }] },
          ],
        },
      ],
      [],
      [],
      [{ nodeId: NODE, outcome: OUTCOME }],
      { kind: "executable" },
    );
    expect(inspection.issues.map((found) => found.code)).not.toContain(
      "unpinned-validator-version",
    );
  });
});

// ── Compatibility: the working path is unchanged ────────────────────────────

describe("F-10 — version 1 keeps compiling and accepting", () => {
  it("compiles to an executable plan whose pinned requirement acceptance accepts", () => {
    const plan = executablePlan(GATE, 1);
    expect(plan.nodes[0]?.outcomes[0]?.acceptance).toEqual([
      { validator: GATE, version: 1 },
    ]);

    const request: AcceptanceRequest = {
      plan,
      submittedPlanRevision: plan.planRevision,
      identity: {
        graphId: GRAPH,
        attemptId: ATTEMPT,
        submissionId: SUBMISSION,
      },
      proposal: { nodeId: NODE, outcomeId: OUTCOME },
      validators: createValidatorRegistry([
        { id: GATE, version: 1, implementation: () => ({ kind: "pass" }) },
      ]),
      artifactRoot: tmpdir(),
      now: NOW,
    };
    const validation = validateSubmission(request);
    expect(validation.kind).toBe("validated");
    if (validation.kind !== "validated") return;
    expect(validation.decision.kind).toBe("accepted");
    expect(validation.decision.requirements).toEqual([
      { requirement: { id: GATE, version: 1 }, outcome: { kind: "pass" } },
    ]);
  });

  it("keeps every shipped capability version working at its exact identity", () => {
    const shipped: readonly (readonly [string, number])[] = [
      [SCHEMA_VALIDATOR_ID, SCHEMA_VALIDATOR_VERSION],
      [ARTIFACT_VALIDATOR_ID, ARTIFACT_VALIDATOR_VERSION],
      [COMMAND_EXIT_VALIDATOR_ID, COMMAND_EXIT_VALIDATOR_VERSION],
      [PRINCIPAL_APPROVAL_VALIDATOR_ID, PRINCIPAL_APPROVAL_VALIDATOR_VERSION],
    ];
    for (const [validator, version] of shipped) {
      expect(readValidatorVersion(version)).toBe(version);
      const plan = executablePlan(validator, version);
      expect(plan.nodes[0]?.outcomes[0]?.acceptance).toEqual([
        { validator, version },
      ]);
    }
  });
});
