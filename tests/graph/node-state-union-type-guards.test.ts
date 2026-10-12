/**
 * F-17 (first leg) — `OutcomeNodeState` is a discriminated union.
 *
 * The persisted-state model used to be one all-optional interface: `status` was
 * a discriminant with no relation to the attempt fields, so `{status:"settled"}`
 * with no `attemptId`, `outcomeId` or timestamps — and `{status:"pending",
 * attemptId:"x"}` — were representable even though the versioned codec refuses
 * both on the next read. The arms below make the compiler enforce what
 * `state-codec.ts` already enforces, per status:
 *
 *   - `pending`    — `arrivals` required; no attempt identity, credential
 *                    digest, host binding, outcome, timestamp or bound input
 *                    view;
 *   - `dispatched` — `attemptId`, `attemptSeq`, `attemptCredentialDigest`,
 *                    `dispatchedAt` and `arrivals` required;
 *   - `settled`    — the same dispatch facts, plus `outcomeId` and `settledAt`.
 *
 * A field the codec REFUSES for a status is declared `never` on that arm rather
 * than omitted, so it stays addressable (and `undefined`) across the union —
 * which is what every existing reader sees — while a value that CARRIES it is a
 * compile error. The codec's accepted field sets, the persisted JSON shape, the
 * body versions and the plan digest are unchanged.
 *
 * `bun test` is transpile-only, so the authority for every `expectTypeOf` pin
 * below is `bun run typecheck:tests`; the runtime cases beside them pin the
 * behaviour the types describe against the REAL run path and the codec.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import { attemptCredentialDigest } from "../../src/graph/outcome/attempt-credential.ts";
import { OutcomeGraphRuntime } from "../../src/graph/outcome/runtime.ts";
import {
  DEFAULT_OUTCOME_STATE_BODY_REGISTRY,
  readOutcomeGraphState,
} from "../../src/graph/outcome/state-codec.ts";
import type { OutcomeStateBodyReader } from "../../src/graph/outcome/state-codec.ts";
import { CURRENT_OUTCOME_STATE_BODY } from "../../src/graph/outcome/state-model.ts";
import type {
  DispatchedNodeState,
  OutcomeArrival,
  OutcomeNodeState,
  PendingNodeState,
  SettledNodeState,
} from "../../src/graph/outcome/state-model.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { buildDeclaredOutcomeGraph, persistDeclaredGraph } from "../../src/graph/tools/declare-graph.ts";
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";
import { removeTempTree } from "./helpers/temp-dirs.ts";

// ── The type-level pins ─────────────────────────────────────────────────────

describe("F-17: OutcomeNodeState is a discriminated union", () => {
  it("pins the three arms and the fields each one owns", () => {
    expectTypeOf<OutcomeNodeState["status"]>().toEqualTypeOf<
      "pending" | "dispatched" | "settled"
    >();
    expectTypeOf<Extract<OutcomeNodeState, { readonly status: "pending" }>>()
      .toEqualTypeOf<PendingNodeState>();
    expectTypeOf<Extract<OutcomeNodeState, { readonly status: "dispatched" }>>()
      .toEqualTypeOf<DispatchedNodeState>();
    expectTypeOf<Extract<OutcomeNodeState, { readonly status: "settled" }>>()
      .toEqualTypeOf<SettledNodeState>();

    // Every arm IS a state, and the three are different types — a single
    // interface with a union-typed `status` would make these equal.
    expectTypeOf<PendingNodeState>().toExtend<OutcomeNodeState>();
    expectTypeOf<DispatchedNodeState>().toExtend<OutcomeNodeState>();
    expectTypeOf<SettledNodeState>().toExtend<OutcomeNodeState>();
    expectTypeOf<PendingNodeState>().not.toEqualTypeOf<DispatchedNodeState>();
    expectTypeOf<DispatchedNodeState>().not.toEqualTypeOf<SettledNodeState>();
    expectTypeOf<PendingNodeState>().not.toEqualTypeOf<SettledNodeState>();

    // The fields a status REQUIRES are required, not optional.
    expectTypeOf<DispatchedNodeState["attemptId"]>().toEqualTypeOf<string>();
    expectTypeOf<DispatchedNodeState["dispatchedAt"]>().toEqualTypeOf<number>();
    expectTypeOf<SettledNodeState["attemptId"]>().toEqualTypeOf<string>();
    expectTypeOf<SettledNodeState["outcomeId"]>().toEqualTypeOf<string>();
    expectTypeOf<SettledNodeState["dispatchedAt"]>().toEqualTypeOf<number>();
    expectTypeOf<SettledNodeState["settledAt"]>().toEqualTypeOf<number>();
    // ...and the facts `readNodeState` requires of EVERY node are required on
    // every arm: a body that omits the attempt sequence, the credential digest
    // or the arrival list is refused on the next read.
    expectTypeOf<PendingNodeState["arrivals"]>().toEqualTypeOf<readonly OutcomeArrival[]>();
    expectTypeOf<DispatchedNodeState["attemptSeq"]>().toEqualTypeOf<number>();
    expectTypeOf<DispatchedNodeState["attemptCredentialDigest"]>().toEqualTypeOf<string>();
    expectTypeOf<DispatchedNodeState["arrivals"]>().toEqualTypeOf<readonly OutcomeArrival[]>();
    expectTypeOf<SettledNodeState["attemptSeq"]>().toEqualTypeOf<number>();
    expectTypeOf<SettledNodeState["attemptCredentialDigest"]>().toEqualTypeOf<string>();
    expectTypeOf<SettledNodeState["arrivals"]>().toEqualTypeOf<readonly OutcomeArrival[]>();
  });

  it("refuses every state the codec refuses", () => {
    // A settled node without the facts that make it settled.
    expectTypeOf<{
      readonly nodeId: string;
      readonly status: "settled";
      readonly attemptId: string;
      readonly outcomeId: string;
    }>().not.toExtend<OutcomeNodeState>();
    expectTypeOf<{
      readonly nodeId: string;
      readonly status: "settled";
      readonly attemptId: string;
      readonly dispatchedAt: number;
      readonly settledAt: number;
    }>().not.toExtend<OutcomeNodeState>();
    // A dispatched node without the dispatch facts.
    expectTypeOf<{
      readonly nodeId: string;
      readonly status: "dispatched";
      readonly attemptId: string;
    }>().not.toExtend<OutcomeNodeState>();
    expectTypeOf<{
      readonly nodeId: string;
      readonly status: "dispatched";
      readonly dispatchedAt: number;
    }>().not.toExtend<OutcomeNodeState>();
    // A pending node carrying an attempt identity, an outcome or any other
    // field the codec refuses for it...
    expectTypeOf<{
      readonly nodeId: string;
      readonly status: "pending";
      readonly attemptId: string;
    }>().not.toExtend<OutcomeNodeState>();
    expectTypeOf<{
      readonly nodeId: string;
      readonly status: "pending";
      readonly attemptCredentialDigest: string;
    }>().not.toExtend<OutcomeNodeState>();
    expectTypeOf<{
      readonly nodeId: string;
      readonly status: "pending";
      readonly settledAt: number;
    }>().not.toExtend<OutcomeNodeState>();
    // A dispatched node without the attempt sequence, the credential digest or
    // the arrival list the reader requires of it.
    expectTypeOf<{
      readonly nodeId: string;
      readonly status: "dispatched";
      readonly attemptId: string;
      readonly dispatchedAt: number;
    }>().not.toExtend<OutcomeNodeState>();
    expectTypeOf<{
      readonly nodeId: string;
      readonly status: "dispatched";
      readonly attemptId: string;
      readonly attemptSeq: number;
      readonly dispatchedAt: number;
      readonly arrivals: readonly OutcomeArrival[];
    }>().not.toExtend<OutcomeNodeState>();
    // A settled node without them either.
    expectTypeOf<{
      readonly nodeId: string;
      readonly status: "settled";
      readonly attemptId: string;
      readonly attemptSeq: number;
      readonly attemptCredentialDigest: string;
      readonly dispatchedAt: number;
      readonly settledAt: number;
      readonly outcomeId: string;
    }>().not.toExtend<OutcomeNodeState>();
    // A pending node without the arrival list every node records.
    expectTypeOf<{
      readonly nodeId: string;
      readonly status: "pending";
    }>().not.toExtend<OutcomeNodeState>();
    // ...and a dispatched node carrying the outcome a settled body owns.
    expectTypeOf<{
      readonly nodeId: string;
      readonly status: "dispatched";
      readonly attemptId: string;
      readonly dispatchedAt: number;
      readonly outcomeId: string;
    }>().not.toExtend<OutcomeNodeState>();
  });
});

// ── The real round trip ─────────────────────────────────────────────────────

const NOW = 1_000;

/**
 * `A` settles its own outcome and arms `B`; `C` is still pending. One body
 * written by the real run path therefore carries all three arms.
 */
const THREE_NODES: GraphDeclarationV3 = {
  version: 3,
  name: "node-state-union",
  nodes: [
    { id: "A", agent: "agent-a", prompt: "prompt-a", outcomes: [{ id: "done" }] },
    { id: "B", agent: "agent-b", prompt: "prompt-b", outcomes: [{ id: "done" }] },
    { id: "C", agent: "agent-c", prompt: "prompt-c", outcomes: [{ id: "done" }] },
  ],
  edges: [
    { from: "A", to: "B", outcome: "done" },
    { from: "B", to: "C", outcome: "done" },
  ],
};

/** One node, so a hand-crafted body reaches `readNodeState` at index 0. */
const ONE_NODE: GraphDeclarationV3 = {
  version: 3,
  name: "node-state-union-malformed",
  nodes: [{ id: "A", agent: "agent-a", prompt: "prompt-a", outcomes: [{ id: "done" }] }],
  edges: [],
};

/** The reader the registry installs for one body version, if it reads it. */
function readerFor(version: number): OutcomeStateBodyReader {
  const reader = DEFAULT_OUTCOME_STATE_BODY_REGISTRY.formats.find(
    (format) => format.format === version,
  );
  if (reader === undefined) throw new Error("fixture: no reader for body version " + version);
  return reader;
}

describe("F-17: a run-state body this build writes round-trips unchanged", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "node-state-union-"));
  });

  afterEach(() => {
    removeTempTree(dir);
  });

  it("decodes a persisted body carrying all three arms to the written value", async () => {
    const graph = buildDeclaredOutcomeGraph({ declaration: THREE_NODES });
    expect(persistDeclaredGraph(graph, dir)).toBe(true);
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const credentials = new Map<string, string>();
      const runtime = new OutcomeGraphRuntime({
        plan: graph.plan,
        ledger,
        dispatch: (request) => {
          credentials.set(request.attemptId, request.credential);
        },
        validators: createValidatorRegistry([]),
        artifactRoot: dir,
        clock: () => NOW,
        credentialIsolation: testHostCredentialIsolation(dir),
      });
      expect(runtime.start(NOW).kind).toBe("started");
      const credential = credentials.get("A#1");
      if (credential === undefined) throw new Error("fixture: no attempt for A");
      expect(
        runtime.submit({ nodeId: "A", outcomeId: "done", credential }, NOW + 30).kind,
      ).toBe("accepted");

      // The row the writer persisted, decoded by the ONE door to the versioned
      // body — not a state the test built.
      const record = ledger.readGraphState(graph.plan.graphId);
      if (record === undefined) throw new Error("fixture: no persisted run state");
      expect(record.planRevision).toBe(graph.plan.planRevision);
      const decoded = readOutcomeGraphState(record, graph.plan);
      expect(decoded.bodyVersion).toBe(CURRENT_OUTCOME_STATE_BODY);
      // Round trip UNCHANGED: decoding the written body and encoding it again
      // reproduces exactly the persisted value.
      expect(JSON.parse(JSON.stringify(decoded))).toEqual(record.body);

      const byId = new Map(decoded.nodes.map((node) => [node.nodeId, node]));

      const settled = byId.get("A");
      expect(settled?.status).toBe("settled");
      if (settled?.status === "settled") {
        expect(settled.attemptId).toBe("A#1");
        expect(settled.outcomeId).toBe("done");
        expect(typeof settled.dispatchedAt).toBe("number");
        expect(typeof settled.settledAt).toBe("number");
        // The fields the union now requires are the ones the writer already
        // records: a legitimate body never has to invent one.
        expect(typeof settled.attemptSeq).toBe("number");
        expect(typeof settled.attemptCredentialDigest).toBe("string");
        expect(Array.isArray(settled.arrivals)).toBe(true);
      }

      const dispatched = byId.get("B");
      expect(dispatched?.status).toBe("dispatched");
      if (dispatched?.status === "dispatched") {
        expect(dispatched.attemptId).toBe("B#2");
        expect(typeof dispatched.dispatchedAt).toBe("number");
        expect(typeof dispatched.attemptSeq).toBe("number");
        expect(typeof dispatched.attemptCredentialDigest).toBe("string");
        expect(Array.isArray(dispatched.arrivals)).toBe(true);
      }

      const pending = byId.get("C");
      expect(pending?.status).toBe("pending");
      // A pending node carries no attempt identity, outcome or timestamp.
      expect(pending?.attemptId).toBeUndefined();
      expect(pending?.outcomeId).toBeUndefined();
      expect(pending?.dispatchedAt).toBeUndefined();
      expect(pending?.settledAt).toBeUndefined();
      // Every node records an arrival list, pending ones included.
      expect(Array.isArray(pending?.arrivals)).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it("still refuses a malformed settled body with the codec's own message", () => {
    const graph = buildDeclaredOutcomeGraph({ declaration: ONE_NODE });
    const reading = readerFor(CURRENT_OUTCOME_STATE_BODY).read(
      {
        bodyVersion: CURRENT_OUTCOME_STATE_BODY,
        graphId: graph.plan.graphId,
        planRevision: graph.plan.planRevision,
        phase: "executing",
        nodes: [
          {
            nodeId: "A",
            status: "settled",
            attemptId: "A#1",
            attemptSeq: 1,
            attemptCredentialDigest: attemptCredentialDigest("A#1"),
            dispatchedAt: 1,
            arrivals: [],
          },
        ],
        loopTraversals: {},
        attemptSeq: 1,
        loopProgress: {},
      },
      graph.plan,
    );
    expect(reading.kind).toBe("invalid");
    if (reading.kind !== "invalid") throw new Error("the malformed body was accepted");
    // Byte-identical to the message this reader produced before the arms were
    // introduced (`git show 69da741:src/graph/outcome/state-codec.ts`).
    expect(reading.error.message).toBe(
      "outcome-state: the persisted graph state is not the state this build writes: " +
        "nodes[0].outcomeId is undefined, not the non-empty outcome that settled the node",
    );
  });
});
