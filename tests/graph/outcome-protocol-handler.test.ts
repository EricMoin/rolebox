/**
 * Execution-protocol registration and the outcome-only load contract.
 *
 * The legacy signal protocol is deleted: this build registers exactly one
 * handler (the outcome protocol), a record pinned to version 1 is `unsupported`
 * and a record with NO protocol key is `corrupt` — there is no backfill and no
 * implicit protocol. A declared graph loads as valid and runs its compiled plan
 * through the outcome run path.
 *
 * Every case runs in its own mkdtemp directory and removes it in a finally
 * block; nothing here writes outside a temp dir.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import {
  buildDeclaredOutcomeGraph,
  persistDeclaredGraph,
} from "../../src/graph/tools/declare-graph.ts";
import {
  DEFAULT_EXECUTION_PROTOCOL_REGISTRY,
  OUTCOME_PROTOCOL,
  OUTCOME_PROTOCOL_HANDLER,
  classifyExecutionProtocol,
  createExecutionProtocolRegistry,
  isOutcomeProtocolHandler,
} from "../../src/graph/protocol/execution-protocol.ts";
import {
  DEFAULT_STORAGE_FORMAT_REGISTRY,
  engineStatePath,
  loadEngineStateForResume,
} from "../../src/graph/persistence/engine-persistence.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import { OutcomeGraphRuntime } from "../../src/graph/outcome/runtime.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

const DECLARATION: GraphDeclarationV3 = {
  version: 3,
  name: "graph.protocol",
  nodes: [
    {
      id: "plan",
      agent: "agent.plan",
      prompt: "Plan the work.",
      outcomes: [{ id: "planned" }],
    },
    {
      id: "ship",
      agent: "agent.ship",
      prompt: "Ship the work.",
      outcomes: [{ id: "shipped" }],
    },
  ],
  edges: [{ from: "plan", to: "ship", outcome: "planned" }],
};

// ── The registered handler ──────────────────────────────────────────────────

describe("execution-protocol registry — the outcome handler", () => {
  it("binds protocol 2 through the outcome CAPABILITY, not the number", () => {
    const verdict = classifyExecutionProtocol(
      OUTCOME_PROTOCOL,
      DEFAULT_EXECUTION_PROTOCOL_REGISTRY,
    );
    expect(verdict.kind).toBe("bound");
    if (verdict.kind !== "bound") return;
    expect(verdict.handler).toBe(OUTCOME_PROTOCOL_HANDLER);
    expect(isOutcomeProtocolHandler(verdict.handler)).toBe(true);
    expect(OUTCOME_PROTOCOL_HANDLER.completion).toBe("accepted-outcome-submission");
    expect(OUTCOME_PROTOCOL_HANDLER.submissionIngress).toBe(
      "graph-scoped-outcome-submission",
    );
    expect(OUTCOME_PROTOCOL_HANDLER.legacyCompletion).toBe("unreachable");
    // The shipped registry holds the outcome handler ALONE.
    expect(
      DEFAULT_EXECUTION_PROTOCOL_REGISTRY.handlers.map((handler) => handler.version),
    ).toEqual([OUTCOME_PROTOCOL]);
    expect(Object.isFrozen(DEFAULT_EXECUTION_PROTOCOL_REGISTRY)).toBe(true);
    expect(Object.isFrozen(OUTCOME_PROTOCOL_HANDLER)).toBe(true);
  });

  it("refuses the deleted legacy protocol 1 as an unsupported version", () => {
    expect(classifyExecutionProtocol(1, DEFAULT_EXECUTION_PROTOCOL_REGISTRY)).toEqual({
      kind: "unsupported",
      version: 1,
    });
  });

  it("refuses a handler registered under 2 that does not declare the outcome capability", async () => {
    const markerOnly = createExecutionProtocolRegistry({
      handlers: [{ version: 1 }, { version: OUTCOME_PROTOCOL }],
    });
    const verdict = classifyExecutionProtocol(OUTCOME_PROTOCOL, markerOnly);
    expect(verdict.kind).toBe("bound");
    if (verdict.kind !== "bound") return;
    expect(isOutcomeProtocolHandler(verdict.handler)).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), "outcome-handler-"));
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const graph = buildDeclaredOutcomeGraph({ declaration: DECLARATION });
      const runtime = new OutcomeGraphRuntime({
        plan: graph.plan,
        ledger,
        dispatch: () => undefined,
        validators: createValidatorRegistry([]),
        artifactRoot: dir,
        credentialIsolation: testHostCredentialIsolation(dir),
        protocols: markerOnly,
      });
      const started = runtime.start(NOW);
      expect(started.kind).toBe("refused");
      if (started.kind !== "refused") return;
      expect(started.refusals.map((refusal) => refusal.code)).toContain(
        "protocol-unavailable",
      );
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Load contract: no backfill, no implicit protocol ────────────────────────

describe("the loader's protocol gate", () => {
  it("loads a persisted declaration as valid under the outcome protocol", async () => {
    const dir = mkdtempSync(join(tmpdir(), "outcome-load-"));
    try {
      const graph = buildDeclaredOutcomeGraph({ declaration: DECLARATION });
      expect(persistDeclaredGraph(graph, dir)).toBe(true);
      const loaded = loadEngineStateForResume(
        readFileSync(engineStatePath(dir, "graph.protocol"), "utf-8"),
        engineStatePath(dir, "graph.protocol"),
        DEFAULT_STORAGE_FORMAT_REGISTRY,
        DEFAULT_EXECUTION_PROTOCOL_REGISTRY,
      );
      expect(loaded.kind).toBe("valid");
      if (loaded.kind === "valid") {
        expect(loaded.executionProtocol).toBe(OUTCOME_PROTOCOL);
        expect(loaded.state.compiledPlan?.planRevision).toBe(graph.plan.planRevision);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a record with NO protocol key as corrupt(execution) — no backfill", () => {
    const raw = JSON.stringify({
      version: 2,
      graphId: "no-protocol",
      phase: "idle",
      graphDeclaration: { version: 2, name: "no-protocol", nodes: [], edges: [] },
      nodes: {},
      loopGroups: {},
      signalLedger: {},
      frontier: [],
      pendingCompletions: [],
      budget: { sessionsSpawned: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 },
      startedAt: 1,
      updatedAt: 1,
      advancingLock: false,
    });
    const loaded = loadEngineStateForResume(
      raw,
      "no-protocol",
      DEFAULT_STORAGE_FORMAT_REGISTRY,
      DEFAULT_EXECUTION_PROTOCOL_REGISTRY,
    );
    expect(loaded.kind).toBe("corrupt");
    if (loaded.kind === "corrupt") expect(loaded.dimension).toBe("execution");
  });

  it("reports a record pinned to the deleted protocol 1 as unsupported(execution)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-record-"));
    try {
      const graph = buildDeclaredOutcomeGraph({ declaration: DECLARATION });
      expect(persistDeclaredGraph(graph, dir)).toBe(true);
      const path = engineStatePath(dir, "graph.protocol");
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
      parsed.executionProtocolVersion = 1;
      const loaded = loadEngineStateForResume(
        JSON.stringify(parsed),
        path,
        DEFAULT_STORAGE_FORMAT_REGISTRY,
        DEFAULT_EXECUTION_PROTOCOL_REGISTRY,
      );
      expect(loaded.kind).toBe("unsupported");
      if (loaded.kind === "unsupported") {
        expect(loaded.dimension).toBe("execution");
        expect(loaded.detail).toBe("1");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── The run path ────────────────────────────────────────────────────────────

describe("a declared graph runs its plan through the outcome run path", () => {
  it("dispatches the entry node, accepts its outcome and settles the successor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "outcome-protocol-graph-"));
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      const graph = buildDeclaredOutcomeGraph({ declaration: DECLARATION });
      expect(persistDeclaredGraph(graph, dir)).toBe(true);

      // Each dispatch hands the worker the attempt credential it must present back.
      const requests: string[] = [];
      const credentials = new Map<string, string>();
      const runtime = new OutcomeGraphRuntime({
        plan: graph.plan,
        ledger,
        dispatch: (request) => {
          requests.push(request.nodeId + ":" + request.attemptId);
          credentials.set(request.attemptId, request.credential);
        },
        validators: createValidatorRegistry([]),
        artifactRoot: dir,
        credentialIsolation: testHostCredentialIsolation(dir),
        clock: () => NOW,
      });
      const credentialOf = (attemptId: string): string => {
        const found = credentials.get(attemptId);
        if (found === undefined) {
          throw new Error("fixture: no dispatch request for attempt " + attemptId);
        }
        return found;
      };

      const started = runtime.start(NOW);
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      expect(requests).toEqual(["plan:plan#1"]);

      const advanced = runtime.submit(
        { nodeId: "plan", outcomeId: "planned", credential: credentialOf("plan#1") },
        NOW + 1,
      );
      expect(advanced.kind).toBe("accepted");
      if (advanced.kind !== "accepted") return;
      expect(requests).toEqual(["plan:plan#1", "ship:ship#2"]);

      const done = runtime.submit(
        { nodeId: "ship", outcomeId: "shipped", credential: credentialOf("ship#2") },
        NOW + 2,
      );
      expect(done.kind).toBe("accepted");
      if (done.kind !== "accepted") return;
      expect(done.state.phase).toBe("complete");
      // The graph's state lives in the LEDGER, not in a JSON file beside it.
      expect(ledger.readGraphState("graph.protocol")?.planRevision).toBe(
        graph.plan.planRevision,
      );
      expect(ledger.acceptedEvents("graph.protocol")).toHaveLength(2);
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
