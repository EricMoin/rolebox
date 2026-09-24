/// <reference types="bun-types" />

/**
 * The run path BINDS a node's declared inputs to the attempt that produced them (D6).
 *
 * `assembleDownstreamInput` and `readResolvedArtifact` prove the RULES; this file
 * proves the WIRING, and it drives the real `OutcomeGraphRuntime` over a compiled
 * plan WITH EDGES — a pure-function test cannot show that a dispatch was armed
 * with a binding, that a blocked dispatch created no effect, or that a restarted
 * process delivers the same view:
 *
 * 1. an accepted result is delivered to its consumer as BOTH the accepted data
 *    (with D1's presence distinction intact) and the retained revision, and the
 *    binding is written into the persisted dispatch target AND the node's own
 *    state entry;
 * 2. the retained revision survives the source path changing — the consumer
 *    resolves the identity the acceptance recorded, never the path;
 * 3. an input that cannot be resolved BLOCKS the dispatch: no worker request and
 *    no dispatch effect, with the named refusals recorded on the node;
 * 4. a restarted process delivers the SAME input view without reading the
 *    accepted result again — the binding is preserved, never re-derived;
 * 5. a repeated submission adds no event, no binding and no effect.
 *
 * Every case runs in its own mkdtemp directory and removes it in a finally
 * block; nothing here writes outside a temp dir.
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase, type DatabaseDriver } from "../../src/memory/db-driver.ts";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import type { AcceptedData } from "../../src/graph/domain/model.ts";
import type { CompiledPlan } from "../../src/graph/compiler/plan.ts";
import { buildDeclaredOutcomeGraph } from "../../src/graph/tools/declare-graph.ts";
import {
  SqliteAcceptanceLedger,
  ledgerFilePath,
} from "../../src/graph/ledger/sqlite-ledger.ts";
import {
  OutcomeGraphRuntime,
  type OutcomeDispatchAdapter,
  type OutcomeDispatchRequest,
  type OutcomeSubmissionResult,
} from "../../src/graph/outcome/runtime.ts";
import type {
  OutcomeDispatchHost,
  OutcomeExecutionLookup,
} from "../../src/graph/outcome/dispatch-effects.ts";
import type { OutcomeGraphState } from "../../src/graph/outcome/graph-state.ts";
import {
  readResolvedArtifact,
  type ResolvedInput,
} from "../../src/graph/outcome/inputs.ts";
import {
  ARTIFACT_REFERENCE_VALIDATOR_ID,
  ARTIFACT_REFERENCE_VALIDATOR_VERSION,
  createArtifactReferenceValidator,
  createValidatorRegistry,
  type ValidatorRegistry,
} from "../../src/graph/outcome/validators.ts";
import type { AttemptCredentialSource } from "../../src/graph/outcome/attempt-credential.ts";
import {
  artifactIdOf,
  digestOf,
  readArtifactById,
} from "../../src/graph/store/artifacts.ts";
import { GRAPH_STORE_TABLES } from "../../src/graph/store/schema.ts";
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const REF = "evidence/report.json";

/** The bytes the gate judges, and what the source path holds afterwards. */
const A = Buffer.from("{revision:A}", "utf-8");
const B = Buffer.from("{revision:B}", "utf-8");

const GATE = {
  validator: ARTIFACT_REFERENCE_VALIDATOR_ID,
  version: ARTIFACT_REFERENCE_VALIDATOR_VERSION,
} as const;

const CREDENTIAL_SOURCE: AttemptCredentialSource = (binding) =>
  "binding-credential:" + binding.nodeId + "#" + binding.attemptId;

/**
 * `work -> review`, where REVIEW consumes work's accepted `done` result.
 *
 * `withFailedBranch` adds a second outcome that routes to the same consumer
 * while the consumer's input pins `done`: the shape in which a real acceptance
 * arms a node whose declared input the producing attempt did not produce.
 */
function chainDeclaration(
  options: { readonly withFailedBranch?: boolean } = {},
): GraphDeclarationV3 {
  const outcomes = options.withFailedBranch
    ? [
        { id: "failed" },
        { id: "done", acceptance: [GATE] },
      ]
    : [{ id: "done", acceptance: [GATE] }];
  return {
    version: 3,
    name: "p42.runtime-input-binding",
    nodes: [
      {
        id: "work",
        agent: "agent.work",
        prompt: "Do the work.",
        outcomes,
      },
      {
        id: "review",
        agent: "agent.review",
        prompt: "Review the work.",
        outcomes: [{ id: "checked" }],
        inputs: [{ from: "work", outcome: "done" }],
      },
    ],
    edges: [
      { from: "work", to: "review", outcome: "done" },
      ...(options.withFailedBranch === true
        ? [{ from: "work", to: "review", outcome: "failed" }]
        : []),
    ],
  };
}

/**
 * A loop whose ENTRY node consumes a producer it can only reach through the
 * back edge, so nothing has settled when the run starts.
 */
function entryConsumerDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: "p42.runtime-entry-inputs",
    nodes: [
      {
        id: "a",
        agent: "agent.a",
        prompt: "A.",
        outcomes: [{ id: "again" }],
        inputs: [{ from: "b", outcome: "done" }],
      },
      {
        id: "b",
        agent: "agent.b",
        prompt: "B.",
        // "exit" is the graph's terminal: it binds no edge, so the plan declares
        // how the loop ends.
        outcomes: [{ id: "done" }, { id: "exit" }],
      },
    ],
    edges: [
      { from: "a", to: "b", outcome: "again" },
      { from: "b", to: "a", outcome: "done" },
    ],
    loop_groups: [
      {
        id: "loop",
        nodes: ["a", "b"],
        max_traversals: 3,
        continuation_outcome: "done",
        exit_outcome: "exit",
      },
    ],
  };
}

/** The shipped artifact gate, retaining into the store root. */
function artifactValidators(storeRoot: string): ValidatorRegistry {
  return createValidatorRegistry([
    {
      id: ARTIFACT_REFERENCE_VALIDATOR_ID,
      version: ARTIFACT_REFERENCE_VALIDATOR_VERSION,
      implementation: createArtifactReferenceValidator({
        artifactStoreRoot: storeRoot,
      }),
    },
  ]);
}

// ── The harness ─────────────────────────────────────────────────────────────

interface Harness {
  readonly runtime: OutcomeGraphRuntime;
  readonly plan: CompiledPlan;
  readonly graphId: string;
  readonly dir: string;
  readonly artifactRoot: string;
  readonly ledger: SqliteAcceptanceLedger;
  /** Every request the dispatch seam was handed, in call order. */
  readonly requests: OutcomeDispatchRequest[];
  /** The credential one dispatched attempt carried. */
  credentialOf(attemptId: string): string;
}

async function withHarness<T>(
  declaration: GraphDeclarationV3,
  fn: (harness: Harness) => Promise<T> | T,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "p42-runtime-inputs-"));
  let ledger: SqliteAcceptanceLedger | undefined;
  try {
    const artifactRoot = join(dir, "workspace");
    mkdirSync(join(artifactRoot, "evidence"), { recursive: true });
    writeFileSync(join(artifactRoot, "evidence", "report.json"), A);

    const validators = artifactValidators(dir);
    const declared = buildDeclaredOutcomeGraph({
      declaration,
      installedValidators: validators,
      installedAcceptanceCapabilities: {
        validators: validators.keys,
        schemas: [],
        commandMappings: [],
      },
    });
    ledger = await SqliteAcceptanceLedger.create(dir);
    const requests: OutcomeDispatchRequest[] = [];
    const runtime = runtimeOver(dir, ledger, declared.plan, (request) => {
      requests.push(request);
    });
    const credentialOf = (attemptId: string): string => {
      const found = requests.find((request) => request.attemptId === attemptId);
      if (found === undefined) {
        throw new Error(
          "fixture: no dispatch request for attempt " +
            attemptId +
            " (dispatched: " +
            requests.map((request) => request.attemptId).join(", ") +
            ")",
        );
      }
      return found.credential;
    };
    return await fn({
      runtime,
      plan: declared.plan,
      graphId: declared.graphId,
      dir,
      artifactRoot,
      ledger,
      requests,
      credentialOf,
    });
  } finally {
    ledger?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One runtime over one ledger.
 *
 * THE PLATFORM-ISOLATED CREDENTIAL STORE is what lets a SECOND runtime over the
 * same directory re-deliver an attempt the first one armed — the restart case
 * below is exactly that.
 */
function runtimeOver(
  dir: string,
  ledger: SqliteAcceptanceLedger,
  plan: CompiledPlan,
  dispatch: OutcomeDispatchAdapter,
): OutcomeGraphRuntime {
  return new OutcomeGraphRuntime({
    plan,
    ledger,
    dispatch,
    validators: artifactValidators(dir),
    artifactRoot: join(dir, "workspace"),
    clock: () => NOW,
    mintCredential: CREDENTIAL_SOURCE,
    credentialIsolation: testHostCredentialIsolation(dir, {
      durableCredentialStore: "platform-isolated",
    }),
  });
}

/** A host that records creates and answers one scripted execution lookup. */
function scriptedHost(lookup: OutcomeExecutionLookup): {
  readonly host: OutcomeDispatchHost;
  readonly creates: OutcomeDispatchRequest[];
} {
  const creates: OutcomeDispatchRequest[] = [];
  return {
    host: {
      create: (request: OutcomeDispatchRequest): void => {
        creates.push(request);
      },
      lookup: (): OutcomeExecutionLookup => lookup,
    },
    creates,
  };
}

/** Require an ACCEPTED submission, naming every refusal when it was refused. */
function acceptedOrThrow(
  result: OutcomeSubmissionResult,
): Extract<OutcomeSubmissionResult, { kind: "accepted" }> {
  if (result.kind !== "accepted") {
    throw new Error(
      "fixture: the submission was not accepted: " + JSON.stringify(result),
    );
  }
  return result;
}

/** One node's persisted entry, failing the test when it is missing. */
function entryOf(state: OutcomeGraphState, nodeId: string) {
  const found = state.nodes.find((node) => node.nodeId === nodeId);
  if (found === undefined) throw new Error("no state for node " + nodeId);
  return found;
}

/** Every effect row of one graph as `effectId@status`, in ledger order. */
function effectRows(ledger: SqliteAcceptanceLedger, graphId: string): string[] {
  return ledger
    .pendingEffects(graphId)
    .map((effect) => effect.effectId + "@" + effect.status);
}

/** Overwrite one attempt's accepted-result payload with a body no reader accepts. */
async function corruptAcceptedResultPayload(
  dir: string,
  attemptId: string,
): Promise<void> {
  const db: DatabaseDriver = await createDatabase(ledgerFilePath(dir));
  try {
    // The column holds the D1 presence envelope; a bare JSON `null` is exactly
    // what a pre-v7 row holds, and every reader of this build REFUSES it rather
    // than guessing which member it meant.
    db.run(
      "UPDATE " +
        GRAPH_STORE_TABLES.acceptedResults +
        " SET payload = 'null' WHERE attempt_id = '" +
        attemptId +
        "'",
    );
  } finally {
    db.close();
  }
}

/**
 * The one proposal shape this suite submits: the attempt's bearer credential
 * (the runtime never derives one) and the evidence reference the gate needs.
 */
function proposalOf(
  nodeId: string,
  outcomeId: string,
  data: { readonly present: boolean; readonly value?: unknown },
  credential: string,
): Record<string, unknown> {
  return {
    nodeId,
    outcomeId,
    credential,
    evidenceRefs: [REF],
    ...(data.present ? { data: data.value } : {}),
  };
}

// ── 1. The successor is armed with the accepted result ──────────────────────

describe("the run path binds a node's declared inputs (D6)", () => {
  it("arms the successor with the accepted DATA and the retained revision, in the state and the effect", async () => {
    await withHarness(chainDeclaration(), async (harness) => {
      const { runtime, ledger, requests, graphId } = harness;
      const started = runtime.start(NOW);
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      // The entry node declares NO inputs, and that is written down as the empty
      // resolved view — not left absent.
      expect(started.dispatched[0]?.inputs).toEqual([]);
      expect(entryOf(started.state, "work").inputs).toEqual([]);

      const accepted = acceptedOrThrow(
        runtime.submit(
          proposalOf(
            "work",
            "done",
            { present: true, value: { report: "A" } },
            harness.credentialOf("work#1"),
          ),
          NOW + 1,
        ),
      );

      const expected: readonly ResolvedInput[] = [
        {
          from: "work",
          outcome: "done",
          attemptId: "work#1",
          payload: { kind: "value", value: { report: "A" } },
          artifacts: [
            {
              ref: REF,
              artifactId: artifactIdOf(digestOf(A)),
              digest: digestOf(A),
              size: A.length,
            },
          ],
        },
      ];

      // (a) THE DELIVERED REQUEST carries the binding.
      const successor = requests.find((request) => request.attemptId === "review#2");
      expect(successor).toBeDefined();
      expect(successor?.inputs).toEqual(expected);
      // The binding names the producing ATTEMPT, not the node.
      expect(successor?.inputs?.[0]?.attemptId).toBe("work#1");

      // (b) THE PERSISTED DISPATCH EFFECT carries the same entries.
      const successorEffect = ledger
        .pendingEffects(graphId)
        .find((effect) => effect.effectId === "dispatch:review#2");
      expect(successorEffect).toBeDefined();
      expect(
        (successorEffect?.payload as { inputs?: unknown } | undefined)?.inputs,
      ).toEqual(expected);

      // (c) THE NODE'S OWN PERSISTED STATE ENTRY carries them too.
      expect(entryOf(accepted.state, "review")).toMatchObject({
        status: "dispatched",
        attemptId: "review#2",
        inputs: expected,
      });
      expect(runtime.state()).toEqual(accepted.state);

      // (d) THE CONSUMER RESOLVES THE ACCEPTED REVISION, even after the source
      // path is replaced with different bytes: the delivered identity is what
      // the gate judged.
      writeFileSync(join(harness.artifactRoot, "evidence", "report.json"), B);
      const read = readResolvedArtifact(
        entryOf(accepted.state, "review").inputs ?? [],
        { from: "work", ref: REF },
        (artifactId) => readArtifactById(harness.dir, artifactId),
      );
      expect(read.kind).toBe("read");
      if (read.kind !== "read") return;
      expect(Buffer.compare(read.bytes, A)).toBe(0);
      expect(digestOf(read.bytes)).toBe(digestOf(A));
      expect(digestOf(read.bytes)).not.toBe(digestOf(B));
    });
  });

  it("keeps missing, null, empty object and empty string DISTINCT in the delivered input", async () => {
    const cases: readonly {
      readonly label: string;
      readonly data: { readonly present: boolean; readonly value?: unknown };
      readonly expected: AcceptedData;
    }[] = [
      {
        label: "no data key at all",
        data: { present: false },
        expected: { kind: "absent" },
      },
      {
        label: "JSON null",
        data: { present: true, value: null },
        expected: { kind: "value", value: null },
      },
      {
        label: "an empty object",
        data: { present: true, value: {} },
        expected: { kind: "value", value: {} },
      },
      {
        label: "an empty string",
        data: { present: true, value: "" },
        expected: { kind: "value", value: "" },
      },
    ];
    for (const testCase of cases) {
      await withHarness(chainDeclaration(), async (harness) => {
        harness.runtime.start(NOW);
        let accepted;
        try {
          accepted = acceptedOrThrow(
            harness.runtime.submit(
              proposalOf(
                "work",
                "done",
                testCase.data,
                harness.credentialOf("work#1"),
              ),
              NOW + 1,
            ),
          );
        } catch (error) {
          throw new Error(testCase.label + ": " + String(error));
        }
        const successor = harness.requests.find(
          (request) => request.attemptId === "review#2",
        );
        expect(successor?.inputs?.[0]?.payload, testCase.label).toEqual(
          testCase.expected,
        );
        expect(
          entryOf(accepted.state, "review").inputs?.[0]?.payload,
          testCase.label,
        ).toEqual(testCase.expected);
      });
    }
  });

  it("BLOCKS the successor whose producer settled on another outcome: no request, no effect, named refusals", async () => {
    await withHarness(
      chainDeclaration({ withFailedBranch: true }),
      async (harness) => {
        const { runtime, ledger, requests, graphId } = harness;
        runtime.start(NOW);
        // The outcome IS accepted — the acceptance decides about the producing
        // node — and the blocked CONSUMER is recorded instead of dispatched.
        const accepted = acceptedOrThrow(
          runtime.submit(
            proposalOf(
              "work",
              "failed",
              { present: true, value: { why: "no" } },
              harness.credentialOf("work#1"),
            ),
            NOW + 1,
          ),
        );
        expect(accepted.dispatched).toEqual([]);
        expect(requests.map((request) => request.attemptId)).toEqual(["work#1"]);
        // No dispatch effect for the blocked node: work#1's own effect settled
        // with its acceptance, so NOTHING is left unsettled.
        expect(effectRows(ledger, graphId)).toEqual([]);
        expect(entryOf(accepted.state, "review")).toMatchObject({
          status: "pending",
          inputRefusals: [
            { from: "work", outcome: "done", code: "input-outcome-mismatch" },
          ],
        });
        const refusal = entryOf(accepted.state, "review").inputRefusals?.[0];
        expect(refusal?.message).toContain("settled on outcome");
        expect(refusal?.message).toContain("failed");

        // The refusal is DURABLE: a fresh read of the stored state answers it,
        // so a node that was never started can be diagnosed from the graph's own
        // record rather than from a dispatch that silently did not happen.
        const reread = runtime.state() ?? accepted.state;
        expect(entryOf(reread, "review").inputRefusals).toEqual(
          entryOf(accepted.state, "review").inputRefusals,
        );
      },
    );
  });

  it("refuses the START of an entry node whose declared input has no producer at all, writing nothing", async () => {
    await withHarness(entryConsumerDeclaration(), async (harness) => {
      const started = harness.runtime.start(NOW);
      expect(started.kind).toBe("refused");
      if (started.kind !== "refused") return;
      expect(started.refusals.map((refusal) => refusal.code)).toEqual([
        "dispatch-input-unbound",
      ]);
      expect(started.refusals[0]?.message).toContain("input-producer-unsettled");
      // NOTHING was written: no state snapshot, no effect and no request.
      expect(harness.ledger.readGraphState(harness.graphId)).toBeUndefined();
      expect(effectRows(harness.ledger, harness.graphId)).toEqual([]);
      expect(harness.requests).toEqual([]);
    });
  });
});

// ── 2. A restart delivers the bound view, and never re-derives it ───────────

describe("a restarted process delivers the bound input view (D6)", () => {
  it("re-launches the armed successor with the SAME entries, without reading the accepted result again", async () => {
    await withHarness(chainDeclaration(), async (harness) => {
      const { dir, plan, graphId, ledger } = harness;
      // THE CRASH WINDOW, reproduced by its real mechanism: the acceptance
      // commits the successor's dispatch intent, and the create throws before it
      // returned — so the row stays `pending` for the next process to resolve.
      const armed = runtimeOver(dir, ledger, plan, (request) => {
        if (request.attemptId === "review#2") {
          throw new Error("fixture: the create threw before delivery");
        }
      });
      armed.start(NOW);
      let threw = false;
      try {
        armed.submit(
          proposalOf(
            "work",
            "done",
            { present: true, value: { report: "A" } },
            "binding-credential:work#work#1",
          ),
          NOW + 1,
        );
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      const committed = armed.state();
      if (committed === undefined) throw new Error("fixture: the state was not committed");
      const bound = entryOf(committed, "review").inputs ?? [];
      if (bound.length !== 1) throw new Error("fixture: the successor was not bound");
      expect(
        ledger
          .pendingEffects(graphId)
          .map((effect) => effect.effectId + "@" + effect.status),
      ).toEqual(["dispatch:review#2@pending"]);

      // THE DURABLE FACT THE BINDING WAS MADE OF IS GONE. The accepted result of
      // the producing attempt is replaced with a body no reader of this build
      // accepts, so a process that RE-DERIVED the input view would refuse
      // instead of delivering one — and could never produce these entries.
      await corruptAcceptedResultPayload(dir, "work#1");

      const restarted = scriptedHost({ kind: "absent" });
      const next = runtimeOver(dir, ledger, plan, restarted.host);
      // The decoder that rebuilds the runtime state preserves the bound view.
      const reread = next.state();
      if (reread === undefined) throw new Error("fixture: the state was not readable");
      expect(entryOf(reread, "review").inputs).toEqual(bound);

      const resumed = next.resume(NOW + 2);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") return;
      const delivered = resumed.dispatched.find(
        (request) => request.attemptId === "review#2",
      );
      expect(delivered).toBeDefined();
      expect(delivered?.inputs).toEqual(bound);
      expect(restarted.creates.map((request) => request.attemptId)).toEqual([
        "review#2",
      ]);
      expect(restarted.creates[0]?.inputs).toEqual(bound);
      // The consumer's binding is the SAME attempt it was armed with, so a
      // producing node that moved on can never rebind it.
      expect(delivered?.inputs?.[0]?.attemptId).toBe("work#1");
    });
  });
});

// ── 3. A replay adds nothing ────────────────────────────────────────────────

describe("a repeated submission is a replay (D6)", () => {
  it("answers the existing confirmation and adds no event, no binding and no effect", async () => {
    await withHarness(chainDeclaration(), async (harness) => {
      const { runtime, ledger, requests, graphId } = harness;
      runtime.start(NOW);
      const proposal = proposalOf(
        "work",
        "done",
        { present: true, value: { report: "A" } },
        harness.credentialOf("work#1"),
      );
      const first = acceptedOrThrow(runtime.submit(proposal, NOW + 1));
      const eventsBefore = ledger.acceptedEvents(graphId).length;
      const effectsBefore = effectRows(ledger, graphId);
      const requestsBefore = requests.length;
      const boundBefore = entryOf(first.state, "review").inputs;

      const again = runtime.submit(proposal, NOW + 2);
      expect(again.kind).toBe("accepted");
      if (again.kind !== "accepted") return;
      expect(again.replayed).toBe(true);
      expect(again.dispatched).toEqual([]);
      expect(ledger.acceptedEvents(graphId).length).toBe(eventsBefore);
      expect(effectRows(ledger, graphId)).toEqual(effectsBefore);
      expect(requests.length).toBe(requestsBefore);
      expect(entryOf(again.state, "review")).toMatchObject({
        status: "dispatched",
        attemptId: "review#2",
      });
      expect(entryOf(again.state, "review").inputs).toEqual(boundBefore);
    });
  });
});
