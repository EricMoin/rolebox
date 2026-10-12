/// <reference types="bun-types" />

/**
 * One model, one declaration (F-08).
 *
 * WHY THIS FILE EXISTS. The engine declared several models two to four times:
 * a validator data contract beside the plan's own, a host execution identity in
 * three modules, the artifact shape in four, the input-view manifest beside the
 * delivered view, a state-body registry input beside its output, four
 * hand-joined cache keys for three identities, and a drain report that stated
 * its single decision twice. Only one of those had a live trigger — the
 * acceptance core REBUILT the plan's data contract field by field, so a field
 * the compiler added to `CompiledOutcomeData` never reached a validator and
 * nothing reported the omission — and the rest were the same root cause with a
 * maintenance cost.
 *
 * WHAT IS PINNED HERE.
 *
 * 1. Every alias equals the ONE declaration it names (`expectTypeOf`), and its
 *    KEY SET equals the canonical key set, so a restatement that quietly drops
 *    or omits a field fails `bun run typecheck:tests` rather than this suite.
 * 2. Adding a field to a canonical type surfaces at the alias site. The
 *    mechanism differs by leg and is stated at each site: a direct alias has
 *    the field by construction; a `Pick` (the validator contract) does not,
 *    which is why the acceptance now hands the plan's own value through; the
 *    manifest's `Omit`-derived field set makes the added field part of the
 *    manifest, so the rest spread that drops `path` carries it, and the key-set
 *    pin fails typecheck if the alias is ever restated without it; the registry
 *    factory's `current` is `T[number]["format"]`, so a version with no reader
 *    cannot be declared.
 * 3. At runtime, `graph_audit`'s public JSON is byte-identical to the shape the
 *    report carried before the change, and an accepted outcome's data reaches a
 *    validator UNCHANGED — the same plan-side object, with `schema` and
 *    `version` intact.
 *
 * @module
 */

import { describe, expect, expectTypeOf, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileGraph } from "../../src/graph/compiler/compile.ts";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import type { CompiledOutcomeData, CompiledPlan } from "../../src/graph/compiler/plan.ts";
import type { AcceptedArtifact } from "../../src/graph/domain/model.ts";
import type { RetainedArtifactRef } from "../../src/graph/ledger/types.ts";
import type { RetainedArtifact } from "../../src/graph/store/artifacts.ts";
import {
  validateSubmission,
  type AcceptanceRequest,
} from "../../src/graph/outcome/acceptance.ts";
import type { OutcomeExecutionIdentity } from "../../src/graph/outcome/dispatch-effects.ts";
import type { HostCompletionExecution } from "../../src/graph/outcome/runtime-contract.ts";
import type { HostExecutionIdentity } from "../../src/graph/host/execution-index.ts";
import type {
  HostCompletionExecutionRecord,
  HostCompletionExecutionSource,
} from "../../src/graph/host/completion-bridge.ts";
import type {
  DeliveredInput,
  DeliveredInputFile,
  InputViewManifest,
  InputViewManifestFile,
  InputViewManifestInput,
} from "../../src/graph/host/input-view.ts";
import { OutcomeStateError } from "../../src/graph/outcome/state-errors.ts";
import {
  createOutcomeStateBodyRegistry,
  type OutcomeStateBodyReader,
} from "../../src/graph/outcome/state-codec.ts";
import {
  createValidatorRegistry,
  substantiatesSchema,
  type ArtifactEvidence,
  type ValidatorDataContract,
  type ValidatorRequest,
} from "../../src/graph/outcome/validators.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../../src/graph/tools/index.ts";

// ── Type pins ───────────────────────────────────────────────────────────────

/**
 * The compiler's own omission detector. `Exclude<…>` that is not `never` fails
 * to satisfy `Missing extends never`, so an undeclared field is a TS2344 at
 * THIS site instead of a silent absence.
 */
type MissingKeysAreNever<Missing extends never> = Missing;

describe("the seven twins have one declaration each", () => {
  it("leg 1 — the validator contract is the plan's own two fields", () => {
    expectTypeOf<ValidatorDataContract>().toEqualTypeOf<
      Pick<CompiledOutcomeData, "schema" | "version">
    >();
    expectTypeOf<keyof ValidatorDataContract>().toEqualTypeOf<"schema" | "version">();
    // Mechanism: `Pick` selects `schema` and `version` from the compiler's
    // declaration, so a change to either field's type changes this alias; and
    // acceptance passes `outcome.data` THROUGH, so a field ADDED to
    // `CompiledOutcomeData` reaches the validator's value at runtime as well.
    expectTypeOf<CompiledOutcomeData>().toMatchTypeOf<ValidatorDataContract>();
    // The alias accepts EXACTLY what the pre-F-08 hand-written parameter type
    // accepted, so no caller that compiled before is refused now.
    expectTypeOf<ValidatorDataContract>().toEqualTypeOf<{
      readonly schema: string;
      readonly version?: number;
    }>();
    // The repaired seam reads through the ONE declaration, not a restatement:
    // `substantiatesSchema`'s contract parameter IS `ValidatorDataContract`.
    expectTypeOf<Parameters<typeof substantiatesSchema>[1]>().toEqualTypeOf<ValidatorDataContract>();
  });

  it("leg 2 — one execution identity, two aliases", () => {
    expectTypeOf<HostExecutionIdentity>().toEqualTypeOf<OutcomeExecutionIdentity>();
    expectTypeOf<HostCompletionExecution>().toEqualTypeOf<OutcomeExecutionIdentity>();
    expectTypeOf<HostCompletionExecutionRecord>().toEqualTypeOf<OutcomeExecutionIdentity>();
    expectTypeOf<keyof HostExecutionIdentity>().toEqualTypeOf<keyof OutcomeExecutionIdentity>();
    expectTypeOf<keyof HostCompletionExecution>().toEqualTypeOf<
      keyof OutcomeExecutionIdentity
    >();
    expectTypeOf<keyof HostCompletionExecutionRecord>().toEqualTypeOf<
      keyof OutcomeExecutionIdentity
    >();
    // The bridge's name accepts EXACTLY what its pre-F-08 hand-written
    // interface accepted, so the `executionFor` seam did not narrow.
    expectTypeOf<HostCompletionExecutionRecord>().toEqualTypeOf<{
      readonly executionId: string;
      readonly taskId?: string;
    }>();
    // The bridge's `executionFor` seam answers the ONE declaration too.
    expectTypeOf<
      ReturnType<HostCompletionExecutionSource["executionFor"]>
    >().toEqualTypeOf<HostCompletionExecutionRecord | undefined>();
    // Mechanism: both host-facing names are direct aliases, so a field added to
    // `OutcomeExecutionIdentity` IS a field of each, with no second edit.
    expectTypeOf<OutcomeExecutionIdentity>().toMatchTypeOf<{
      readonly executionId: string;
    }>();
  });

  it("leg 3 — one artifact shape, three aliases (and the evidence name)", () => {
    expectTypeOf<RetainedArtifactRef>().toEqualTypeOf<AcceptedArtifact>();
    expectTypeOf<RetainedArtifact>().toEqualTypeOf<AcceptedArtifact>();
    expectTypeOf<ArtifactEvidence>().toEqualTypeOf<AcceptedArtifact>();
    expectTypeOf<keyof RetainedArtifactRef>().toEqualTypeOf<keyof AcceptedArtifact>();
    expectTypeOf<keyof RetainedArtifact>().toEqualTypeOf<keyof AcceptedArtifact>();
    expectTypeOf<keyof ArtifactEvidence>().toEqualTypeOf<keyof AcceptedArtifact>();
    // Mechanism: direct aliases — a field added to `AcceptedArtifact` is a field
    // of every one of them, and a restatement that omits it fails the key-set
    // equality above at typecheck time.
  });

  it("leg 4 — the manifest is derived from the delivered view", () => {
    expectTypeOf<InputViewManifestFile>().toEqualTypeOf<Omit<DeliveredInputFile, "path">>();
    expectTypeOf<InputViewManifestInput>().toEqualTypeOf<
      Omit<DeliveredInput, "artifacts"> & {
        readonly artifacts: readonly Omit<DeliveredInputFile, "path">[];
      }
    >();
    expectTypeOf<InputViewManifest["version"]>().toEqualTypeOf<1>();
    // Mechanism: the manifest file type is the delivered file type minus `path`,
    // so a field added to `DeliveredInputFile` IS a field of the manifest and
    // the rest spread in `manifestText` carries it; the key-set equality below
    // is what fails if the alias is ever restated with a field missing.
    type _ManifestFileCarriesEveryDeliveredField = MissingKeysAreNever<
      Exclude<keyof DeliveredInputFile, keyof InputViewManifestFile | "path">
    >;
    type _ManifestInputCarriesEveryDeliveredField = MissingKeysAreNever<
      Exclude<keyof DeliveredInput, keyof InputViewManifestInput | "artifacts">
    >;
    expectTypeOf<keyof InputViewManifestFile>().toEqualTypeOf<
      "ref" | "artifactId" | "digest" | "size" | "file"
    >();
  });

  it("leg 5 — the registry's current version is one of its readers", () => {
    type NineOnlyRegistryInput = Parameters<
      typeof createOutcomeStateBodyRegistry<readonly [OutcomeStateBodyReader<9>]>
    >[0];
    expectTypeOf<NineOnlyRegistryInput>().toEqualTypeOf<{
      readonly current: 9;
      readonly formats: readonly [OutcomeStateBodyReader<9>];
    }>();
    // Mechanism: `current` is `T[number]["format"]`, so a registry declaring
    // `{ current: 10, formats: [nineOnlyReader] }` does not compile; the runtime
    // throw in the factory stays as the second gate. The input twin is gone, so
    // no caller can pass a registry description the output type would accept
    // verbatim.
    const registry = createOutcomeStateBodyRegistry({
      current: 9,
      formats: [stubReader(9)],
    });
    expect(registry.current).toBe(9);
  });
});

/** One inert reader, for the registry factory's shape. */
function stubReader<V extends number>(format: V): OutcomeStateBodyReader<V> {
  return Object.freeze({
    format,
    read: () => ({
      kind: "invalid" as const,
      error: new OutcomeStateError("malformed-state", "stub reader " + String(format)),
    }),
  });
}

// ── Runtime: the accepted data reaches the validator unchanged (leg 1) ──────

const GRAPH = "graph.model-dedup";
const NODE = "work";
const OUTCOME = "done";
const GATE = "gate.check";
const NOW = 1_700_000_000_000;

/** A one-node graph whose `done` outcome declares a data contract and one gate. */
const DECLARATION: GraphDeclarationV3 = {
  version: 3,
  name: GRAPH,
  nodes: [
    {
      id: NODE,
      agent: "agent.worker",
      prompt: "Produce an outcome.",
      outcomes: [
        {
          id: OUTCOME,
          data: { schema: "schema.demo", version: 3 },
          acceptance: [{ validator: GATE, version: 1 }],
        },
      ],
    },
  ],
  edges: [],
};

function executablePlan(): CompiledPlan {
  const result = compileGraph(DECLARATION, {
    supportedValidators: [{ validator: GATE, version: 1 }],
  });
  if (!result.ok) {
    throw new Error(
      "fixture did not compile: " +
        result.errors.map((error) => error.code + "@" + error.path).join(", "),
    );
  }
  return result.plan;
}

describe("the accepted outcome's data contract", () => {
  it("reaches a validator unchanged, as the plan's own value", () => {
    const plan = executablePlan();
    const compiled: CompiledOutcomeData | undefined = plan.nodes
      .find((node) => node.id === NODE)
      ?.outcomes.find((outcome) => outcome.id === OUTCOME)?.data;
    expect(compiled).toBeDefined();

    const seen: (ValidatorDataContract | undefined)[] = [];
    const read: ({ readonly schema?: string; readonly version?: number })[] = [];
    const validators = createValidatorRegistry([
      {
        id: GATE,
        version: 1,
        implementation: (request: ValidatorRequest) => {
          seen.push(request.dataContract);
          read.push({
            schema: request.dataContract?.schema,
            version: request.dataContract?.version,
          });
          return { kind: "pass" };
        },
      },
    ]);

    const request: AcceptanceRequest = {
      plan,
      submittedPlanRevision: plan.planRevision,
      identity: { graphId: GRAPH, attemptId: "work#1", submissionId: "sub-1" },
      proposal: { nodeId: NODE, outcomeId: OUTCOME },
      validators,
      artifactRoot: tmpdir(),
      now: NOW,
    };
    const validation = validateSubmission(request);
    expect(validation.kind).toBe("validated");
    if (validation.kind !== "validated") return;
    expect(validation.decision.kind).toBe("accepted");

    // The values the pre-F-08 copy also carried.
    expect(read).toEqual([{ schema: "schema.demo", version: 3 }]);
    expect(seen).toEqual([{ schema: "schema.demo", version: 3 }]);
    // And it is the PLAN'S OWN object, not a two-field rebuild: the copy could
    // never satisfy this, and a plan-side field added tomorrow rides along.
    expect(seen[0]).toBe(compiled);
  });
});

// ── Runtime: the audit tool's public JSON is unchanged (leg 7) ──────────────

describe("the graph_audit tool's drained/verdict serialization", () => {
  it("keeps the pre-change bytes: `drained` last, projected from `verdict`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "model-dedup-audit-"));
    try {
      const toolset = createGraphToolSet({ stateDir: dir });
      const tools = createOutcomeGraphTools(toolset);
      const tool = tools["graph_audit"];
      if (tool === undefined) throw new Error("graph_audit was not registered");
      const output = String(await tool.execute({}, {} as never));

      const report = await toolset.graph_audit();
      // The 85e70da report carried `drained` as its LAST field, computed exactly
      // this way; the tool edge projects that object, so the bytes a caller sees
      // are unchanged while the internal report has one authority.
      expect(output).toBe(
        JSON.stringify({ ...report, drained: report.verdict === "drained" }, null, 2),
      );
      expect(Object.keys(JSON.parse(output) as Record<string, unknown>)).toEqual([
        "directory",
        "storeDirectory",
        "ledgerFilePath",
        "ledger",
        "entries",
        "blockers",
        "totals",
        "verdict",
        "drained",
      ]);
      const parsed = JSON.parse(output) as {
        readonly verdict: string;
        readonly drained: boolean;
      };
      expect(parsed.verdict).toBe("drained");
      expect(parsed.drained).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
