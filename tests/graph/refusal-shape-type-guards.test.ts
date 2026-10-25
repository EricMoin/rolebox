/**
 * "VALUE OR REFUSAL" READS ARE DISCRIMINATED BY CONSTRUCTION (F-25), AND THE
 * WORKER CHANNEL KEEPS ITS TOOLS' DECLARED TYPES (F-28).
 *
 * WHAT THIS FILE PINS.
 *
 * 1. F-25 — `readPlanState` answered `OutcomeGraphState | OutcomeRuntimeRefusal`
 *    and `resolveSettlementIdentity` answered `ExecutionIdentity | { refusal }`;
 *    both were told apart by probing the VALUE arm for a field the REFUSAL arm
 *    declares (`"code" in value`, `"refusal" in value`). That is a convention,
 *    not a discriminant: the day a state (or an execution identity) gained a
 *    `code`, a perfectly valid reading would silently be reported as a refusal.
 *    Both answers are now `OutcomeReading<T>` — `{ kind: "ok"; value }` or
 *    `{ kind: "refused"; refusal }` — so the arms are proved exhaustive by the
 *    compiler and no value a reader answers can move itself into the refusal
 *    arm. The `expectTypeOf`/`Extract` pins below are the authority for the
 *    union's shape (`npm run typecheck:tests`); the runtime cases beside them
 *    pin the BEHAVIOUR, which is unchanged: the legitimate path still answers
 *    the plan state, and the refused path still answers the owning reader's own
 *    refusal — the same code and the same message bytes.
 *
 * 2. F-28 — the channel's `tools` parameter was `Record<string,
 *    CanonicalToolDef>`, the DEFAULT generic, so every definition's
 *    `args`/`execute` were erased (`z.ZodRawShape` / `{[k: string]: any}`), and
 *    the host's answer was asserted (`response.json() as { result: … }`), so a
 *    200 carrying `{ error }` handed the waiting worker `undefined` TYPED as the
 *    tool's `ToolResult`. The channel is now generic over the caller's own tool
 *    record and the envelope is read through a validator: a legitimate call
 *    still executes and still answers its typed result, and an envelope this
 *    protocol does not define is refused by name instead of becoming a result.
 *
 * COMPATIBILITY. Every legitimate producer's value is unchanged — the pins and
 * the runtime cases below state that, and the two newly refused inputs are
 * named where they are refused (a response envelope with no well-formed
 * `result`, which no producer emits; every channel reply the channel itself
 * writes on success carries one).
 *
 * STRENGTH: real store, real HTTP, temp roots only. No host SDK runs.
 *
 * @module
 */

import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  invokeGraphWorkerChannel,
  openGraphWorkerChannel,
  workerChannelToolOf,
} from "../../src/graph/application/worker-channel.ts";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import type { CompiledPlan } from "../../src/graph/compiler/plan.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/dispatch-effects.ts";
import {
  CURRENT_OUTCOME_STATE_BODY,
  readOutcomeGraphState,
  type OutcomeGraphState,
} from "../../src/graph/outcome/graph-state.ts";
import type { OutcomeRuntimeRefusal } from "../../src/graph/outcome/runtime-contract.ts";
import { OutcomeGraphRuntime } from "../../src/graph/outcome/runtime.ts";
import type { OutcomeReading } from "../../src/graph/outcome/runtime-readings.ts";
import { stateRefusal } from "../../src/graph/outcome/runtime-refusals.ts";
import { resolveSettlementIdentity } from "../../src/graph/outcome/settlement-identity.ts";
import {
  createValidatorRegistry,
  type ExecutionIdentity,
} from "../../src/graph/outcome/validators.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import type { GraphStateRecord } from "../../src/graph/ledger/types.ts";
import { buildDeclaredOutcomeGraph } from "../../src/graph/tools/declare-graph.ts";
import type {
  CanonicalToolContext,
  CanonicalToolDef,
  ToolResult,
} from "../../src/platform/types.ts";
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";
import { removeTempTree } from "./helpers/temp-dirs.ts";

const NOW = 1_700_000_000_000;

/** work -> ship: one successor edge, one terminal outcome. */
const LINEAR: GraphDeclarationV3 = {
  version: 3,
  name: "graph.linear",
  nodes: [
    {
      id: "work",
      agent: "agent.work",
      prompt: "Do the work.",
      outcomes: [{ id: "done" }],
    },
    {
      id: "ship",
      agent: "agent.ship",
      prompt: "Ship it.",
      outcomes: [{ id: "delivered" }],
    },
  ],
  edges: [{ from: "work", to: "ship", outcome: "done" }],
};

/**
 * The refusal the owning reader answers for the corrupted body below, in its own
 * words. The runtime's state reading hands this value through untouched, so the
 * byte-for-byte wording is part of the contract this file pins.
 */
const UNREADABLE_BODY_MESSAGE =
  "outcome-state: the persisted graph state is not the state this build writes: " +
  'the body carries field "progressBaselines", which body version ' +
  CURRENT_OUTCOME_STATE_BODY +
  " does not define — an unknown field is refused rather than dropped; adding a field is a new body version";

const roots: string[] = [];
const channels: Awaited<ReturnType<typeof openGraphWorkerChannel>>[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) channel.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  for (const root of roots.splice(0)) removeTempTree(root);
});

interface RuntimeHarness {
  readonly runtime: OutcomeGraphRuntime;
  readonly ledger: SqliteAcceptanceLedger;
  readonly plan: CompiledPlan;
  readonly graphId: string;
}

/** One started-able runtime over a real file ledger in a temp root. */
async function withRuntime<T>(fn: (harness: RuntimeHarness) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "refusal-shape-"));
  roots.push(dir);
  const ledger = await SqliteAcceptanceLedger.create(dir);
  try {
    const declared = buildDeclaredOutcomeGraph({ declaration: LINEAR });
    const dispatch: OutcomeDispatchRequest[] = [];
    const runtime = new OutcomeGraphRuntime({
      plan: declared.plan,
      ledger,
      dispatch: (request) => {
        dispatch.push(request);
      },
      validators: createValidatorRegistry([]),
      artifactRoot: dir,
      credentialIsolation: testHostCredentialIsolation(dir),
      clock: () => NOW,
      mintCredential: (binding) => "test-credential:" + binding.nodeId + "#" + binding.attemptId,
    });
    return await fn({
      runtime,
      ledger,
      plan: declared.plan,
      graphId: declared.graphId,
    });
  } finally {
    ledger.close();
  }
}

/** The stored row, failing the test when the fixture never wrote one. */
function storedState(ledger: SqliteAcceptanceLedger, graphId: string): GraphStateRecord {
  const record = ledger.readGraphState(graphId);
  if (record === undefined) throw new Error("fixture: the state row is missing");
  return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The stored body as a record, failing the test when it is not one. */
function bodyOf(record: GraphStateRecord): Record<string, unknown> {
  const body = record.body;
  if (!isRecord(body)) throw new Error("fixture: the state body is not a record");
  return body;
}

/** The refusal the OWNING reader answers for the row as it stands. */
function readerRefusal(
  ledger: SqliteAcceptanceLedger,
  graphId: string,
  plan: CompiledPlan,
): OutcomeRuntimeRefusal {
  try {
    readOutcomeGraphState(storedState(ledger, graphId), plan);
  } catch (error) {
    return stateRefusal(graphId, error);
  }
  throw new Error("fixture: the reader accepted the corrupted record");
}

// ── F-25: the state reading ─────────────────────────────────────────────────

describe("F-25: the state reading answers a plan state or the reader's own refusal", () => {
  it("still answers the plan state on the legitimate path", async () => {
    await withRuntime(({ runtime, plan }) => {
      expect(runtime.start(NOW).kind).not.toBe("refused");
      const resumed = runtime.resume(NOW + 1);
      expect(resumed.kind).toBe("resumed");
      if (resumed.kind !== "resumed") throw new Error("the run was not resumed");
      expect(resumed.state.planRevision).toBe(plan.planRevision);
      expect(resumed.state.phase).toBe("executing");
      // The state the reading answered is the PLAN's own node set.
      expect(resumed.state.nodes.map((node) => node.nodeId)).toEqual(
        plan.nodes.map((node) => node.id),
      );
    });
  });

  it("answers the reader's own refusal, same code and same message, when a body cannot be read", async () => {
    await withRuntime(({ runtime, ledger, plan, graphId }) => {
      runtime.start(NOW);
      const started = storedState(ledger, graphId);
      // A field body version 10 does not declare: the strict reader refuses it
      // rather than dropping it, and the runtime reports exactly that refusal.
      ledger.writeGraphState({
        ...started,
        body: { ...bodyOf(started), progressBaselines: { work: { digest: "abc", round: 2 } } },
        updatedAt: NOW + 1,
      });
      const expected = readerRefusal(ledger, graphId, plan);
      expect(expected).toEqual({ code: "unreadable-state", message: UNREADABLE_BODY_MESSAGE });

      // Both call sites of the state reading report the SAME refusal value.
      const resumed = runtime.resume(NOW + 2);
      expect(resumed).toEqual({ kind: "refused", refusals: [expected] });
      const submitted = runtime.submit(
        { nodeId: "work", outcomeId: "done", credential: "not-a-recorded-credential" },
        NOW + 3,
      );
      expect(submitted.kind).toBe("refused");
      if (submitted.kind !== "refused") throw new Error("the submission was not refused");
      expect(submitted.refusals).toEqual([expected]);
    });
  });

  it("keeps a state bound to another revision a plan mismatch", async () => {
    await withRuntime(({ runtime, ledger, plan, graphId }) => {
      runtime.start(NOW);
      const started = storedState(ledger, graphId);
      ledger.writeGraphState({
        ...started,
        planRevision: "revision-from-elsewhere",
        updatedAt: NOW + 1,
      });
      const expected = readerRefusal(ledger, graphId, plan);
      expect(expected.code).toBe("plan-revision-mismatch");
      expect(expected.message).toContain('"revision-from-elsewhere"');
      expect(runtime.resume(NOW + 2)).toEqual({ kind: "refused", refusals: [expected] });
    });
  });

  it("pins both arms of the reading union by its declared discriminant", () => {
    // The discriminant is a declared field of the reading, not a probe into the
    // value: the compiler proves the union exhaustive on `kind` alone.
    expectTypeOf<ReturnType<typeof resolveSettlementIdentity>["kind"]>().toEqualTypeOf<
      "ok" | "refused"
    >();
    // The value arm carries the execution identity, the refusal arm the refusal.
    expectTypeOf<
      Extract<ReturnType<typeof resolveSettlementIdentity>, { readonly kind: "ok" }>["value"]
    >().toEqualTypeOf<ExecutionIdentity>();
    expectTypeOf<
      Extract<ReturnType<typeof resolveSettlementIdentity>, { readonly kind: "refused" }>["refusal"]
    >().toEqualTypeOf<OutcomeRuntimeRefusal>();
    // The reading the state reader answers is the same shape, projected onto the
    // state it carries.
    expectTypeOf<OutcomeReading<OutcomeGraphState>>().toEqualTypeOf<
      | { readonly kind: "ok"; readonly value: OutcomeGraphState }
      | { readonly kind: "refused"; readonly refusal: OutcomeRuntimeRefusal }
    >();
  });
});

// ── F-28: the worker channel's tools and its response envelope ──────────────

const WORKER_TOOLS = {
  graph_submit_outcome: {
    description: "Verify the caller and answer its value.",
    args: { value: z.string() },
    execute: async (
      args: { value: string },
      context: CanonicalToolContext,
    ): Promise<ToolResult> =>
      JSON.stringify({ value: args.value, caller: context.sessionID }),
  },
} satisfies Record<string, CanonicalToolDef>;

const SELECTED_TOOL = workerChannelToolOf(WORKER_TOOLS, "graph_submit_outcome");

describe("F-28: the channel keeps the tool record's declared types", () => {
  it("resolves a name to the definition's own argument type, not the erased default", () => {
    // `execute` receives the argument type the tool author declared. The erased
    // `CanonicalToolDef` default answers `{[k: string]: any}` here, which is not
    // equal to this type, so the pin fails if the record's types are erased.
    expectTypeOf<Parameters<NonNullable<typeof SELECTED_TOOL>["execute"]>[0]>().toEqualTypeOf<{
      value: string;
    }>();
    expectTypeOf<NonNullable<typeof SELECTED_TOOL>["args"]>().toEqualTypeOf<{
      value: z.ZodString;
    }>();
    expectTypeOf<typeof SELECTED_TOOL>().not.toEqualTypeOf<CanonicalToolDef | undefined>();
  });

  it("answers undefined for a name the record does not hold", () => {
    // The lookup is KEYED by the record, so a name a narrowly-typed record does
    // not declare is a compile error. A record typed with a string index — the
    // shape the channel's own generic is instantiated with at the runtime
    // boundary — can be asked, and the absent name answers `undefined`.
    const widelyTyped: Record<string, CanonicalToolDef> = WORKER_TOOLS;
    expect(workerChannelToolOf(widelyTyped, "graph_status")).toBeUndefined();
  });

  it("still executes a legitimate call and answers its typed result", async () => {
    const root = mkdtempSync(join(tmpdir(), "refusal-shape-"));
    roots.push(root);
    const channel = await openGraphWorkerChannel(WORKER_TOOLS, root, join(root, "store"));
    channels.push(channel);
    const grant = channel.issue("session-one", "worker");

    const result = await invokeGraphWorkerChannel(grant, "graph_submit_outcome", { value: "before" });
    expect(result).toBe(JSON.stringify({ value: "before", caller: "session-one" }));
    // The strict argument rule is unchanged: a field the tool does not declare
    // is still refused by the channel.
    await expect(
      invokeGraphWorkerChannel(grant, "graph_submit_outcome", { value: "x", sessionID: "two" }),
    ).rejects.toThrow("400");
  });
});

describe("F-28: the response envelope is read, not asserted", () => {
  /** A stub host answering every invocation with one fixed JSON body. */
  async function withStubHost<T>(
    answer: () => unknown,
    fn: (endpoint: string) => Promise<T>,
  ): Promise<T> {
    const server = createServer((request, response) => {
      // The body is drained and ignored: this stub is about the ANSWER.
      request.on("data", () => {});
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(answer()));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("fixture: the stub host has no port");
    }
    return await fn(`http://127.0.0.1:${address.port}/invoke`);
  }

  it("still parses a legitimate envelope identically", async () => {
    await withStubHost(
      () => ({ result: "a plain string result" }),
      async (endpoint) => {
        const grant = { endpoint, token: "stub-token" };
        expect(await invokeGraphWorkerChannel(grant, "graph_status", {})).toBe(
          "a plain string result",
        );
      },
    );
    await withStubHost(
      () => ({
        result: {
          title: "status",
          output: "the declared result object",
          metadata: { nodes: 2 },
          attachments: [{ type: "file", mime: "text/plain", url: "file:///tmp/report.txt" }],
        },
      }),
      async (endpoint) => {
        const grant = { endpoint, token: "stub-token" };
        expect(await invokeGraphWorkerChannel(grant, "graph_status", {})).toEqual({
          title: "status",
          output: "the declared result object",
          metadata: { nodes: 2 },
          attachments: [{ type: "file", mime: "text/plain", url: "file:///tmp/report.txt" }],
        });
      },
    );
  });

  it("refuses a 200 that carries no tool result instead of fabricating one", async () => {
    // The pre-fix assertion typed `undefined` as the tool's result here: a 200
    // carrying `{ error }` is not a result, and the worker is told so by name.
    await withStubHost(
      () => ({ error: "the host answered without a result" }),
      async (endpoint) => {
        const grant = { endpoint, token: "stub-token" };
        await expect(invokeGraphWorkerChannel(grant, "graph_status", {})).rejects.toThrow(
          'Graph worker channel answered a malformed response envelope for "graph_status", so no tool result is fabricated',
        );
      },
    );
  });

  it("refuses every envelope whose `result` is not the declared shape", async () => {
    const bad: readonly unknown[] = [
      {},
      { result: undefined },
      { result: null },
      { result: 3 },
      { result: { title: "no output" } },
      { result: { output: "bad attachment", attachments: [{ type: "nope", mime: "m", url: "u" }] } },
    ];
    for (const envelope of bad) {
      await withStubHost(
        () => envelope,
        async (endpoint) => {
          const grant = { endpoint, token: "stub-token" };
          await expect(invokeGraphWorkerChannel(grant, "graph_status", {})).rejects.toThrow(
            "malformed response envelope",
          );
        },
      );
    }
  });
});
