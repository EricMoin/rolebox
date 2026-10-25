/**
 * THE HOST TOOL SURFACE'S TYPE SEAMS (F-16, F-26, F-31).
 *
 * WHAT THIS FILE PINS, and why each one is a BEHAVIOUR and not a restatement:
 *
 * 1. F-16 — a `graph_control` answer is read through the CLOSED command
 *    vocabulary. The producer is fully typed, but the tool renders the result as
 *    JSON, so the host's post-processing used to re-derive
 *    `{graphId: string; command: string | undefined}` and compare
 *    `command === "retry"` as a bare string. `readAppliedControl(graphId,
 *    result)` is now the one reader of that serialized shape: a shipped answer
 *    still hands over its cancel intents (and a retry its continuation), while a
 *    command outside the vocabulary, an answer about another graph, and every
 *    unreadable value deliver and continue NOTHING. The wrapper cases run
 *    against a real `OutcomeHost` and the shipped `withCancelDelivery`.
 * 2. F-26 — the binding keeps each entry's DECLARED argument type instead of
 *    erasing it to `Record<string, unknown>` and casting the record back. The
 *    `expectTypeOf` pins (authority: `npm run typecheck:tests`, not the
 *    transpile-only test run) fail the day the erased record returns, and the
 *    runtime case proves a malformed argument record is REFUSED by name instead
 *    of being forwarded, while a legitimate record still reaches the body with
 *    every key it carried.
 * 3. F-31 — the exported host publishes a credential READING, not the vault: no
 *    minting, no remembering, no forgetting and no store, and a call arriving
 *    from a session the host bound as a dispatched WORKER can read exactly its
 *    own attempt. The declaring caller's reads are unchanged.
 *
 * STRENGTH: unit plus real-store fixtures. No platform SDK runs and every temp
 * tree is removed.
 */

import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import {
  isControlCommandName,
  readAppliedControl,
  type AppliedControl,
} from "../../src/graph/control/index.ts";
import { CONTROL_COMMAND_NAMES, type ControlCommandName } from "../../src/graph/ledger/types.ts";
import {
  bindOutcomeToolInvocation,
  TOOL_ARGUMENT_REFUSED_CODE,
  withCancelDelivery,
} from "../../src/graph/host/tool-binding.ts";
import {
  OutcomeHost,
  type HostCredentialReading,
} from "../../src/graph/host/outcome-host.ts";
import { createHostInvocationHolder } from "../../src/graph/host/identity.ts";
import type { CredentialStoreIdentity } from "../../src/graph/outcome/credential-isolation.ts";
import type { OutcomeDispatchRequest } from "../../src/graph/outcome/dispatch-effects.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { createGraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { createOutcomeGraphTools } from "../../src/graph/tools/index.ts";
import type { CanonicalToolContext, CanonicalToolDef } from "../../src/platform/types.ts";
import { removeTempTrees } from "./helpers/temp-dirs.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const EMPTY_VALIDATORS = createValidatorRegistry([]);

/** Two ENTRY nodes: one start dispatches both, so one host holds two workers. */
const FAN_OUT: GraphDeclarationV3 = {
  version: 3,
  name: "tool-surface.fan-out",
  nodes: [
    { id: "alpha", agent: "agent.alpha", prompt: "Do alpha.", outcomes: [{ id: "done" }] },
    { id: "beta", agent: "agent.beta", prompt: "Do beta.", outcomes: [{ id: "done" }] },
  ],
  edges: [],
};

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  removeTempTrees(tmpDirs);
});

/** Whether a value is a non-array record — the tests' own total narrowing. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A canonical tool context, as a platform hands one to a tool call. */
function makeContext(sessionID: string, directory: string): CanonicalToolContext {
  return {
    sessionID,
    messageID: "m1",
    agent: "agent.test",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

/** The plain-record answer a tool rendered, or a fixture error. */
function answerOf(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") throw new Error("fixture: the tool answered a non-string");
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("fixture: the tool answered a non-object");
  return parsed;
}

/** The child session the platform "created" for one attempt (the dsh mapping). */
function childSessionOf(attemptId: string): string {
  return "child-session:" + attemptId;
}

/** A bare attribution: the holder alone, which is all these seams read. */
function attributionOf(): { holder: ReturnType<typeof createHostInvocationHolder> } {
  return { holder: createHostInvocationHolder() };
}

// ── F-16: reading an applied control answer ─────────────────────────────────

/** A shipped applied answer, as `graph_control`'s own tool renders one. */
function appliedAnswer(command: unknown, graphId = "graph.a"): string {
  return JSON.stringify({
    kind: "applied",
    graphId,
    runId: graphId + "@1",
    command,
    scope: "attempt",
    minted: [],
    decided: [],
    skipped: [],
    unsettledEffects: [],
    unconfirmedExecutions: [],
    expiredApprovals: [],
  });
}

describe("F-16 — a control answer is read through the closed command vocabulary", () => {
  it("reads a shipped applied answer as its graph and a vocabulary command", () => {
    const applied = readAppliedControl("graph.a", appliedAnswer("retry"));
    expect(applied).toEqual({ graphId: "graph.a", command: "retry" });
    expectTypeOf(applied).toEqualTypeOf<AppliedControl | undefined>();
    expectTypeOf<AppliedControl["command"]>().toEqualTypeOf<ControlCommandName>();
    // CLOSED, not merely narrow: `string extends the command` is the widening a
    // bare string would make true, so this pin fails the day one comes back.
    type CommandIsNotAnyString = string extends AppliedControl["command"] ? never : true;
    expectTypeOf<CommandIsNotAnyString>().toEqualTypeOf<true>();

    // Every member of the shipped vocabulary is readable, and nothing else is.
    for (const command of CONTROL_COMMAND_NAMES) {
      expect(readAppliedControl("graph.a", appliedAnswer(command))).toEqual({
        graphId: "graph.a",
        command,
      });
      expect(isControlCommandName(command)).toBe(true);
    }
    expect(isControlCommandName("teleport")).toBe(false);
    expect(isControlCommandName("")).toBe(false);
    expect(isControlCommandName(7)).toBe(false);
  });

  it("refuses a command outside the vocabulary, by name", () => {
    expect(readAppliedControl("graph.a", appliedAnswer("teleport"))).toBeUndefined();
    expect(readAppliedControl("graph.a", appliedAnswer(""))).toBeUndefined();
    expect(
      readAppliedControl("graph.a", JSON.stringify({ kind: "applied", graphId: "graph.a" })),
    ).toBeUndefined();
  });

  it("refuses an answer about a graph this call did not name", () => {
    expect(readAppliedControl("graph.b", appliedAnswer("cancel"))).toBeUndefined();
    expect(readAppliedControl("", appliedAnswer("cancel"))).toBeUndefined();
  });

  it("refuses every non-applied or unreadable answer", () => {
    expect(
      readAppliedControl(
        "graph.a",
        JSON.stringify({ kind: "refused", graphId: "graph.a", refusals: [] }),
      ),
    ).toBeUndefined();
    expect(readAppliedControl("graph.a", "graph_control failed: boom")).toBeUndefined();
    expect(readAppliedControl("graph.a", "not json")).toBeUndefined();
    expect(readAppliedControl("graph.a", JSON.stringify([{ kind: "applied" }]))).toBeUndefined();
    expect(
      readAppliedControl("graph.a", { kind: "applied", graphId: "graph.a", command: "retry" }),
    ).toBeUndefined();
    expect(readAppliedControl("graph.a", null)).toBeUndefined();
  });
});

describe("F-16 — the cancel/retry hand-over reads the answer through that reader", () => {
  it("delivers cancel, continues only a retry, and refuses the rest", async () => {
    const dir = makeTmpDir("tool-surface-control-");
    const storeRoot = join(dir, "host-store");
    mkdirSync(storeRoot, { recursive: true });
    const host = OutcomeHost.open({
      workspaceDir: dir,
      storeRoot,
      deliver: () => {},
    });
    // WHAT THE FOLLOW-UP ASKS THE HOST TO DO, observed directly: the shipped
    // wrapper's only effects are these two calls.
    const delivered: string[] = [];
    const continued: string[] = [];
    host.deliverCancelIntents = async (graphId: string) => {
      delivered.push(graphId);
      return Object.freeze({ graphId, entries: Object.freeze([]) });
    };
    host.continueAfterControl = async (graphId: string) => {
      continued.push(graphId);
    };
    try {
      const context = makeContext("session-declarer", dir);
      const callThrough = async (answer: string): Promise<void> => {
        const tools = withCancelDelivery(
          {
            graph_control: {
              description: "control stub",
              args: {},
              async execute(_args: Record<string, unknown>, _context: CanonicalToolContext) {
                return answer;
              },
            },
          },
          host,
        );
        await tools.graph_control.execute(
          { graph_id: "graph.a", command: "cancel", reason: "a stub answer" },
          context,
        );
      };

      // A SHIPPED ANSWER: cancel intents are handed over, no continuation.
      await callThrough(appliedAnswer("cancel"));
      expect(delivered).toEqual(["graph.a"]);
      expect(continued).toEqual([]);

      // A RETRY: the effects it wrote are handed over AND the run is continued.
      await callThrough(appliedAnswer("retry"));
      expect(delivered).toEqual(["graph.a", "graph.a"]);
      expect(continued).toEqual(["graph.a"]);

      // A COMMAND OUTSIDE THE VOCABULARY: nothing is delivered and nothing is
      // continued — the answer is not one this build may act on.
      await callThrough(appliedAnswer("teleport"));
      expect(delivered).toEqual(["graph.a", "graph.a"]);
      expect(continued).toEqual(["graph.a"]);

      // AN ANSWER ABOUT ANOTHER GRAPH: same refusal.
      await callThrough(appliedAnswer("retry", "graph.b"));
      expect(delivered).toEqual(["graph.a", "graph.a"]);
      expect(continued).toEqual(["graph.a"]);

      // A REFUSED ANSWER: the service wrote nothing, so there is nothing to
      // hand over.
      await callThrough(JSON.stringify({ kind: "refused", graphId: "graph.a", refusals: [] }));
      expect(delivered).toEqual(["graph.a", "graph.a"]);
      expect(continued).toEqual(["graph.a"]);
    } finally {
      host.close();
    }
  });
});

// ── F-26: the declared argument type survives the bind ──────────────────────

describe("F-26 — a tool's declared argument type survives the host binding", () => {
  it("keeps the concrete record and each entry's inferred argument type", () => {
    const probeArgs = { graph_id: z.string().min(1), limit: z.number().int().optional() };
    type ProbeArgs = typeof probeArgs;
    const probe: CanonicalToolDef<ProbeArgs> = {
      description: "probe",
      args: probeArgs,
      async execute(args) {
        expectTypeOf(args).toEqualTypeOf<z.infer<z.ZodObject<ProbeArgs>>>();
        return "{}";
      },
    };
    const record = { graph_probe: probe };
    const bound = bindOutcomeToolInvocation(record, attributionOf());

    // THE RECORD'S OWN TYPE COMES BACK — not `Record<string, CanonicalToolDef>`.
    expectTypeOf(bound).toEqualTypeOf<typeof record>();
    expectTypeOf(bound.graph_probe.args).toEqualTypeOf<ProbeArgs>();
    expectTypeOf<Parameters<typeof bound.graph_probe.execute>[0]>()
      .toEqualTypeOf<z.infer<z.ZodObject<ProbeArgs>>>();
    // The declared record is NOT the erased default: a record the erased
    // `Record<string, unknown>` would happily accept — one with no `graph_id` at
    // all — is refused by the declared type, which is the erasure this pin
    // prevents from coming back.
    type ErasedExecuteArgs = Parameters<CanonicalToolDef["execute"]>[0];
    type ErasedAcceptsAMissingGraphId = { limit: number } extends ErasedExecuteArgs
      ? true
      : never;
    type DeclaredRefusesAMissingGraphId = { limit: number } extends z.infer<
      z.ZodObject<ProbeArgs>
    >
      ? never
      : true;
    expectTypeOf<ErasedAcceptsAMissingGraphId>().toEqualTypeOf<true>();
    expectTypeOf<DeclaredRefusesAMissingGraphId>().toEqualTypeOf<true>();
  });

  it("refuses a malformed argument record instead of forwarding it", async () => {
    const seen: unknown[] = [];
    const probe: CanonicalToolDef = {
      description: "probe",
      args: { graph_id: z.string().min(1), limit: z.number().int().optional() },
      async execute(args) {
        seen.push(args);
        return "ran";
      },
    };
    const erased: Record<string, CanonicalToolDef> = { graph_probe: probe };
    const bound = bindOutcomeToolInvocation(erased, attributionOf());

    const refused = answerOf(
      await bound.graph_probe.execute({ graph_id: 7 }, makeContext("session-test", ".")),
    );
    expect(refused["refused"]).toBe(true);
    expect(refused["code"]).toBe(TOOL_ARGUMENT_REFUSED_CODE);
    expect(refused["tool"]).toBe("graph_probe");
    expect(seen).toEqual([]);

    // A LEGITIMATE RECORD IS UNCHANGED, including the keys the declared schema
    // does not name: the platform's own enrichment still reaches the body.
    const kept: unknown[] = [];
    const echoing: CanonicalToolDef = {
      description: "echo",
      args: { graph_id: z.string().min(1) },
      async execute(args) {
        kept.push(args);
        return "ran";
      },
    };
    const echoingBound = bindOutcomeToolInvocation({ graph_echo: echoing }, attributionOf());
    await echoingBound.graph_echo.execute(
      { graph_id: "graph.a", enriched_by: "platform" },
      makeContext("session-test", "."),
    );
    expect(kept).toEqual([{ graph_id: "graph.a", enriched_by: "platform" }]);
  });
});

// ── F-31: the published credential surface ──────────────────────────────────

interface FanOutFixture {
  readonly dir: string;
  readonly graphId: string;
  readonly host: OutcomeHost;
  readonly toolset: ReturnType<typeof createGraphToolSet>;
  readonly tools: Record<string, CanonicalToolDef>;
  readonly dispatched: readonly OutcomeDispatchRequest[];
}

/** The shipped host assembly over a real two-entry graph. */
async function openFanOutFixture(): Promise<FanOutFixture> {
  const dir = makeTmpDir("tool-surface-fanout-");
  const storeRoot = join(dir, "host-store");
  mkdirSync(storeRoot, { recursive: true });
  const dispatched: OutcomeDispatchRequest[] = [];
  let host: OutcomeHost | undefined;
  const opened = OutcomeHost.open({
    workspaceDir: dir,
    storeRoot,
    deliver: (request, effect) => {
      dispatched.push(request);
      // The platform named the execution it created; the host records the fact.
      host?.confirmExecution(effect, { executionId: childSessionOf(request.attemptId) });
    },
    validators: EMPTY_VALIDATORS,
    declareInvocationIdentity: false,
    workerSessionOf: (execution) => execution.executionId,
  });
  host = opened;
  const toolset = createGraphToolSet({
    stateDir: dir,
    credentialIsolation: opened.credentialIsolation,
    hostIdentity: opened.workerIdentity,
    outcomeDispatch: opened.dispatch,
    outcomeValidators: EMPTY_VALIDATORS,
    outcomeArtifactRoot: dir,
  });
  const tools = opened.bindTools(createOutcomeGraphTools(toolset));
  const declared = String(
    await tools.graph_declare.execute(
      { declaration: FAN_OUT },
      makeContext("session-declarer", dir),
    ),
  );
  if (declared.includes("graph_declare failed:")) {
    throw new Error("fixture: graph_declare refused the declaration: " + declared);
  }
  const started = await opened.startDeclaredGraph(FAN_OUT.name, {
    sessionId: "session-declarer",
    agent: "agent.declarer",
  });
  if (started.kind !== "started") {
    throw new Error("fixture: the graph did not start (" + started.kind + ")");
  }
  return { dir, graphId: FAN_OUT.name, host: opened, toolset, tools, dispatched };
}

/** One dispatched attempt's request, or a fixture error. */
function dispatchOf(fixture: FanOutFixture, attemptId: string): OutcomeDispatchRequest {
  const request = fixture.dispatched.find((entry) => entry.attemptId === attemptId);
  if (request === undefined) throw new Error("fixture: no dispatch for " + attemptId);
  return request;
}

describe("F-31 — the exported host publishes a scoped credential reading", () => {
  it("keeps a caller's own reads and publishes no vault capability", async () => {
    const fixture = await openFanOutFixture();
    try {
      const alpha = dispatchOf(fixture, "alpha#1");
      const identity = { graphId: fixture.graphId, nodeId: "alpha", attemptId: "alpha#1" };
      const reading: HostCredentialReading = fixture.host.credentials;

      // THE DECLARING/HOST CALLER IS UNAFFECTED: the value it minted is readable,
      // and the durable record still answers.
      expect(reading.resolve(identity)).toBe(alpha.credential);
      expect(reading.has(identity)).toBe(true);
      expect(reading.durableRecord(identity)).toBe("not-retained");

      // WHAT IS NEWLY UNREACHABLE: minting, remembering, forgetting, closing and
      // the runtime store are not part of the published surface — not in its
      // type and not on the value a caller receives.
      expectTypeOf(reading).toEqualTypeOf<HostCredentialReading>();
      expectTypeOf<Parameters<HostCredentialReading["resolve"]>[0]>()
        .toEqualTypeOf<CredentialStoreIdentity>();
      for (const capability of ["mint", "remember", "forget", "close", "store", "capability"]) {
        expect(capability in reading).toBe(false);
      }
    } finally {
      fixture.host.close();
    }
  });

  it("refuses a bound worker the credential of an attempt it does not own", async () => {
    const fixture = await openFanOutFixture();
    try {
      const alpha = dispatchOf(fixture, "alpha#1");
      const beta = dispatchOf(fixture, "beta#2");

      // OUTSIDE a worker call the host still reads every attempt it minted (the
      // compatibility case: the declaring session and restart recovery).
      expect(
        fixture.host.credentials.resolve({
          graphId: fixture.graphId,
          nodeId: "beta",
          attemptId: "beta#2",
        }),
      ).toBe(beta.credential);

      // THE WORKER'S OWN CALL. The probe stands in for the granted delivery
      // channel, so the host's worker boundary admits it and its body runs under
      // the session the host bound as alpha#1's worker.
      const observed: {
        own?: string;
        other?: string;
        retention?: "retained" | "not-retained";
      } = {};
      const probe: CanonicalToolDef = {
        description: "credential probe",
        args: {},
        async execute() {
          observed.own = fixture.host.credentials.resolve({
            graphId: fixture.graphId,
            nodeId: "alpha",
            attemptId: "alpha#1",
          });
          observed.other = fixture.host.credentials.resolve({
            graphId: fixture.graphId,
            nodeId: "beta",
            attemptId: "beta#2",
          });
          observed.retention = fixture.host.credentials.durableRecord({
            graphId: fixture.graphId,
            nodeId: "beta",
            attemptId: "beta#2",
          });
          return "{}";
        },
      };
      const probeFace = fixture.host.bindTools({
        ...createOutcomeGraphTools(fixture.toolset),
        graph_submit_outcome: probe,
      });
      await probeFace.graph_submit_outcome.execute(
        {},
        makeContext(childSessionOf("alpha#1"), fixture.dir),
      );

      // ITS OWN ATTEMPT IS STILL READABLE; the sibling's is not.
      expect(observed.own).toBe(alpha.credential);
      expect(observed.other).toBeUndefined();
      expect(observed.retention).toBeUndefined();
    } finally {
      fixture.host.close();
    }
  });
});
