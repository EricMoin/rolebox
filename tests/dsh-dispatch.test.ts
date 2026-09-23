/// <reference types="bun-types" />

/**
 * dsh dispatch path tests — the {@link DshDispatchAdapter} (`src/platform/
 * adapters/dsh/dispatch.ts`) driving the graph engine and loop mode through a
 * MOCKED dsh subagent service (no real dsh packages, no opencode SDK).
 *
 * Verifies (subtask 8 of the dsh adaptation strategy):
 *   - the OUTCOME run path through the dsh seam: `DshOutcomeDelivery` starts one
 *     dsh run per attempt and the host settles its observed completion
 *   - a throwing `start()` fails the round loud (provider-level rejection)
 *   - the immediate-fire termination guard (listen-after-terminate)
 *   - the loop adapter surface (dispatchRound/getRoundResult/cancelRound/
 *     registerTerminatedListener/getTaskStatus) driven through dsh
 *   - the new dsh dispatch code stays free of @opencode-ai imports
 *
 * The legacy graph-engine dispatch cases (executeNode, engine node escalation,
 * nested-graph settlement) were deleted with the runtime they drove; the
 * surviving graph coverage drives the outcome path instead.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DshOutcomeDelivery } from "../src/platform/adapters/dsh/outcome-dispatch.ts";
import { OutcomeHost } from "../src/graph/host/outcome-host.ts";
import type { GraphDeclarationV3 } from "../src/graph/compiler/declaration-v3.ts";
import {
  buildDeclaredOutcomeGraph,
  persistDeclaredGraph,
} from "../src/graph/tools/declare-graph.ts";
import { engineStateDir } from "../src/graph/persistence/engine-persistence.ts";
import { scanPersistedStates } from "../src/graph/tools/persisted-state.ts";
import { createValidatorRegistry } from "../src/graph/outcome/validators.ts";
import {
  completionPolicyRefOf,
  createCompletionPolicyRegistry,
  type CompletionPolicyBody,
} from "../src/graph/policy/completion-policy.ts";
import { DshDispatchAdapter, DshParentUnresolvedError } from "../src/platform/adapters/dsh/dispatch.ts";
import type { DshSubagentDispatchRuntime } from "../src/platform/adapters/dsh/dispatch.ts";
import type { DshSubagentResult } from "../src/platform/adapters/dsh/dispatch.ts";
import type {
  DshContinuableCreateRequest,
  DshContinuableCreateSpec,
  DshSubagentCapabilities,
  DshSubagentProvider,
  DshSubagentRun,
  DshSubagentStartRequest,
  DshResolvedSubagentStartRequest,
} from "../src/platform/adapters/dsh/agent-registrar.ts";
import { DshAgentRegistrar } from "../src/platform/adapters/dsh/agent-registrar.ts";
import type { AgentDefinition } from "../src/platform/types.ts";
import { sessionSignalLedger } from "../src/signal/session-signal-ledger.ts";

// ── Mocked dsh subagent service ─────────────────────────────────────────────

/** A controllable dsh run: the `result` promise settles via complete()/fail(). */
class FakeRun implements DshSubagentRun {
  readonly id: string;
  disposeCalls = 0;
  result: Promise<DshSubagentResult>;
  private resolveResult!: (value: DshSubagentResult) => void;
  private rejectResult!: (err: unknown) => void;

  constructor(id: string) {
    this.id = id;
    this.result = new Promise<DshSubagentResult>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
  }

  /** Settle the run like a real dsh provider finishing (never rejects). */
  complete(result: DshSubagentResult): void {
    this.resolveResult(result);
  }

  /** Reject the run's result promise (defensive path in the adapter). */
  fail(err: unknown): void {
    this.rejectResult(err);
  }

  async dispose(): Promise<void> {
    this.disposeCalls++;
  }
}

/**
 * Fake `SubagentRuntime` (`ctx.subagents`) that mirrors the real seam's
 * provider delegation: `start(name, request)` resolves the provider registered
 * under `name` and awaits ITS `start(request)` — exactly as
 * `ctx.subagents.start` does — so a provider-level spawn rejection surfaces
 * through the seam instead of being swallowed. Records every start request.
 *
 * Each provider seeded via {@link seedProvider} yields a controllable run.
 * Per-agent behavior:
 *   - `autoComplete.get(agent)` — the provider's start returns a run that
 *     completes on a microtask with the given result (normal graph flow).
 *   - `autoError.get(agent)` — the provider's start REJECTS with the message
 *     (provider-level spawn failure → engine escalate / loop round error).
 *   - otherwise — the provider's start returns a run that stays pending until
 *     the test calls `completeRun(runId, result)`.
 */
class FakeSubagentService implements DshSubagentDispatchRuntime {
  readonly providers = new Map<string, DshSubagentProvider>();
  readonly started: Array<{ name: string; request: DshSubagentStartRequest }> = [];
  readonly runs = new Map<string, FakeRun>();
  readonly autoComplete = new Map<string, DshSubagentResult>();
  readonly autoError = new Map<string, string>();
  private seq = 0;

  registerProvider(provider: DshSubagentProvider): () => void {
    this.providers.set(provider.name, provider);
    return () => {
      this.providers.delete(provider.name);
    };
  }

  getProvider(name: string): DshSubagentProvider | undefined {
    return this.providers.get(name);
  }

  list(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Mirror dsh's service-side continuable gate
   * (`packages/subagent/subagent/src/index.ts:593-606`, dsh 0.1.5-rc.1):
   * resolving a provider's detached continuable-creation contribution throws a
   * typed `UNSUPPORTED_CAPABILITY` error when the provider does not implement
   * `prepareContinuable`, and otherwise delegates to it. Method PRESENCE IS the
   * capability, so this is exactly the surface a continuity-capable rolebox
   * provider must survive without rejection.
   */
  async prepareContinuable(
    name: string,
    request: DshContinuableCreateRequest,
  ): Promise<DshContinuableCreateSpec> {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`dsh subagent provider "${name}" is not registered`);
    }
    if (provider.prepareContinuable === undefined) {
      const err = new Error(
        `subagent provider "${provider.name}" does not support continuable children ` +
          "(no prepareContinuable capability)",
      );
      (err as { code?: string }).code = "UNSUPPORTED_CAPABILITY";
      throw err;
    }
    return provider.prepareContinuable(request);
  }

  async start(name: string, request: DshResolvedSubagentStartRequest): Promise<DshSubagentRun> {
    this.started.push({ name, request });
    // Mirror the real SubagentRuntime: the seam resolves the named provider and
    // delegates to its start(). A provider-level rejection (e.g. the registrar
    // delegating to an unwired host provider) therefore propagates unchanged.
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`dsh subagent provider "${name}" is not registered`);
    }
    return provider.start(request);
  }

  /** Manually settle a specific run (for controllable tests). */
  completeRun(runId: string, result: DshSubagentResult): void {
    this.runs.get(runId)?.complete(result);
  }

  /**
   * Register a provider for an agent so the adapter's mapping guard passes.
   * The provider's `start()` yields the controllable run (or rejects when
   * `autoError` names it) — the same provider-level surface the real registrar
   * exposes through `ctx.subagents.start`.
   */
  seedProvider(name: string): void {
    this.providers.set(name, {
      name,
      capabilities: {
        agentOptions: true,
        outputSchema: false,
        depthLimit: false,
        toolFilter: false,
        persona: false,
      },
      inheritsParentContext: false,
      start: async () => {
        const rejectMsg = this.autoError.get(name);
        if (rejectMsg) throw new Error(rejectMsg);
        const id = `dsh-run-${++this.seq}`;
        const run = new FakeRun(id);
        this.runs.set(id, run);
        const auto = this.autoComplete.get(name);
        if (auto) {
          setTimeout(() => run.complete(auto), 0);
        }
        return run;
      },
    });
  }
}

/** Settle the engine's microtask/timer-driven advancement. */
const settle = () => new Promise((r) => setTimeout(r, 30));

const outputBlock = (text: string) => [{ type: "text", text }];

// ── Shared setup ────────────────────────────────────────────────────────────

let tmpDir: string;
let service: FakeSubagentService;
let dispatch: DshDispatchAdapter;

/**
 * Sentinel live parent `Agent` resolved for every spawn by the shared
 * fixture's resolver. The adapter forwards the SAME reference onto the start
 * request (dsh requires `parent: Agent`).
 */
const fakeParent = { id: "fake-parent-agent", inject: () => undefined };

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "rolebox-dsh-dispatch-"));
  service = new FakeSubagentService();
  dispatch = new DshDispatchAdapter({
    subagents: service,
    directory: tmpDir,
    parentResolver: () => fakeParent,
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});


describe("dsh dispatch round surface through the subagent seam", () => {
  it("fires an already-terminal task's listener via microtask (immediate-fire guard)", async () => {
    service.seedProvider("fast");
    service.autoComplete.set("fast", {
      stopReason: "completed",
      output: outputBlock("done early"),
    });
    const { workerTaskId } = await dispatch.dispatchRound({
      originSessionId: "origin-1",
      agent: "fast",
      prompt: "round",
    });
    await settle();

    // Task already completed — a listener registered now must still fire.
    let fired: string | undefined;
    dispatch.registerTerminatedListener(workerTaskId, (tid, status) => {
      fired = `${tid}:${status}`;
    });
    await settle();
    expect(fired).toBe(`${workerTaskId}:completed`);
  });
});
// ── Loop mode through the dsh dispatch path ─────────────────────────────────

describe("loop mode dispatch through the dsh subagent seam", () => {
  it("dispatchRound starts a dsh run and getRoundResult returns its output", async () => {
    service.seedProvider("worker-agent");
    const { workerTaskId, workerSessionId } = await dispatch.dispatchRound({
      originSessionId: "origin-123",
      agent: "worker-agent",
      prompt: "do the round",
      description: "round 1",
    });

    expect(workerTaskId).toMatch(/^dsh-run-/);
    expect(workerSessionId).toBe(workerTaskId);
    expect(service.started).toHaveLength(1);
    expect(service.started[0].name).toBe("worker-agent");
    expect(service.started[0].request.prompt).toEqual([
      { type: "text", text: "do the round" },
    ]);

    service.completeRun(workerTaskId, {
      stopReason: "completed",
      output: outputBlock("round output text"),
    });
    const result = await dispatch.getRoundResult(workerTaskId);
    expect(result.hadError).toBe(false);
    expect(result.text).toBe("round output text");
  });

  it("getRoundResult reports the error reason for an errored round", async () => {
    service.seedProvider("worker-agent");
    const { workerTaskId } = await dispatch.dispatchRound({
      originSessionId: "origin-1",
      agent: "worker-agent",
      prompt: "p",
    });
    service.completeRun(workerTaskId, {
      stopReason: "error",
      output: outputBlock("round failed hard"),
    });
    const result = await dispatch.getRoundResult(workerTaskId);
    expect(result.hadError).toBe(true);
    expect(result.errorReason).toBe("round failed hard");
  });

  it("registerTerminatedListener fires when the round's run settles", async () => {
    service.seedProvider("worker-agent");
    const { workerTaskId } = await dispatch.dispatchRound({
      originSessionId: "origin-1",
      agent: "worker-agent",
      prompt: "p",
    });
    let fired: string | undefined;
    dispatch.registerTerminatedListener(workerTaskId, (tid, status) => {
      fired = `${tid}:${status}`;
    });
    service.completeRun(workerTaskId, {
      stopReason: "completed",
      output: outputBlock("ok"),
    });
    await settle();
    expect(fired).toBe(`${workerTaskId}:completed`);
    expect(await dispatch.getTaskStatus(workerTaskId)).toBe("completed");
  });

  it("cancelRound cancels a running round via the dsh abort surface", async () => {
    service.seedProvider("worker-agent");
    const { workerTaskId } = await dispatch.dispatchRound({
      originSessionId: "origin-1",
      agent: "worker-agent",
      prompt: "p",
    });
    await dispatch.cancelRound(workerTaskId);
    expect(service.runs.get(workerTaskId)?.disposeCalls).toBeGreaterThanOrEqual(1);
    expect(await dispatch.getTaskStatus(workerTaskId)).toBe("cancelled");
    const result = await dispatch.getRoundResult(workerTaskId);
    expect(result.hadError).toBe(true);
  });

  it("readOriginSummary / getLastMessageId degrade when no session client is wired", async () => {
    expect(await dispatch.readOriginSummary("origin-1")).toBe("");
    expect(await dispatch.getLastMessageId("origin-1")).toBeUndefined();
    await dispatch.injectNote("origin-1", "silent note"); // no-op, must not throw
  });

  it("enforces a per-run timeout via the abort timer (dsh has no native timeout)", async () => {
    service.seedProvider("stall");
    const { workerTaskId } = await dispatch.dispatchRound({
      originSessionId: "origin-1",
      agent: "stall",
      prompt: "p",
      timeoutMs: 20,
    });
    // The run never settles on its own — the adapter's timer must force it.
    await new Promise((r) => setTimeout(r, 60));
    expect(await dispatch.getTaskStatus(workerTaskId)).toBe("timeout");
  });
});

// ── Provider-level spawn rejection (the delegation path) ────────────────────

describe("provider-level spawn rejection is surfaced, not swallowed", () => {
  it("errors the loop round when the provider\u0027s start rejects", async () => {
    // The registered provider's start() rejects — a provider-level spawn
    // failure such as the registrar delegating to an unwired host provider
    // (DshSpawnNotWiredError). The fake seam delegates to the provider, so the
    // rejection reaches the adapter exactly as it does in production.
    service.seedProvider("rejecter");
    service.autoError.set("rejecter", "host provider rejected the spawn");

    // Loop path: dispatchRound propagates the same rejection to the caller as a
    // round error rather than returning a phantom task id.
    let roundErr: unknown;
    try {
      await dispatch.dispatchRound({
        originSessionId: "origin-1",
        agent: "rejecter",
        prompt: "round",
      });
    } catch (e) {
      roundErr = e;
    }
    expect(roundErr).toBeInstanceOf(Error);
    expect((roundErr as Error).message).toContain("host provider rejected the spawn");
  });
});

// ── Outcome dispatch through the dsh subagent seam ──────────────────────────
//
// The legacy graph-engine dispatch cases were deleted with the runtime they
// drove. A dispatched graph node now travels the OUTCOME run path: the dsh
// delivery starts one subagent run per attempt, observes its terminal result,
// and the host settles the attempt through `settleNatural`. This case drives
// that seam with the real delivery adapter and the real host assembly.

describe("outcome dispatch through the dsh subagent seam", () => {
  const POLICY_ID = "dsh.outcome.policy";
  const POLICY_BODY: CompletionPolicyBody = {
    version: 1,
    default: "ungranted",
    rules: [
      { graphId: "dsh.outcome", nodeId: "work", outcome: "done", decision: "allow" },
    ],
  };
  const AUTHORIZED = createCompletionPolicyRegistry({
    policies: [
      {
        ref: completionPolicyRefOf({ id: POLICY_ID, revision: "1", body: POLICY_BODY }),
        body: POLICY_BODY,
      },
    ],
  });

  it("delivers the attempt, observes completion, and settles the graph", async () => {
    const declaration: GraphDeclarationV3 = {
      version: 3,
      name: "dsh.outcome",
      nodes: [
        {
          id: "work",
          agent: "worker-agent",
          prompt: "Do the work.",
          outcomes: [{ id: "done" }],
          completion: { mode: "natural", outcome: "done" },
        },
      ],
      edges: [],
      completion_policy: { id: POLICY_ID, revision: "1" },
    };
    persistDeclaredGraph(
      buildDeclaredOutcomeGraph({ declaration, completionPolicies: AUTHORIZED }),
      tmpDir,
    );
    service.seedProvider("worker-agent");
    service.autoComplete.set("worker-agent", {
      stopReason: "completed",
      output: outputBlock("work done"),
    });

    let host: OutcomeHost | undefined;
    const completions: Array<Promise<void>> = [];
    const delivery = new DshOutcomeDelivery({
      subagents: service,
      parentResolver: () => fakeParent,
      onStartFailed: () => {},
      onSettled: (settlement) => {
        if (settlement.kind !== "completed" || host === undefined) return;
        const settling = host;
        completions.push(
          settling
            .complete(settlement.request.graphId, settlement.request.attemptId)
            .then(() => undefined),
        );
      },
    });
    host = OutcomeHost.open({
      workspaceDir: tmpDir,
      storeRoot: engineStateDir(tmpDir),
      deliver: delivery.deliver,
      validators: createValidatorRegistry([]),
      completionPolicies: AUTHORIZED,
      durability: "memory",
    });
    try {
      delivery.setParentSession("origin-1");
      const started = await host.startDeclaredGraph("dsh.outcome", {
        sessionId: "origin-1",
        agent: "emperor",
      });
      expect(started.kind).toBe("started");
      if (started.kind !== "started") return;
      expect(started.dispatched.map((request) => request.attemptId)).toEqual(["work#1"]);
      // The dsh run resolves asynchronously; the host settles on its observation.
      await settle();
      await Promise.all(completions);

      const state = scanPersistedStates(tmpDir).loaded.find(
        (candidate) => candidate.graphId === "dsh.outcome",
      );
      expect(state?.phase).toBe("complete");
      expect(state?.nodes.get("work")?.status).toBe("completed");
    } finally {
      delivery.setParentSession(undefined);
      host.close();
    }
  });
});

// ── Parent resolution ─────────────────────────────────────────────────

describe("dsh dispatch parent resolution", () => {
  it("forwards the resolved live parent Agent byte-identically to subagents.start", async () => {
    service.seedProvider("worker-agent");
    const parent = { id: "live-parent-agent", inject: () => undefined };
    const seenSessions: string[] = [];
    const adapter = new DshDispatchAdapter({
      subagents: service,
      directory: tmpDir,
      parentResolver: (sid) => {
        seenSessions.push(sid);
        return sid === "origin-1" ? parent : undefined;
      },
    });

    await adapter.dispatchRound({
      originSessionId: "origin-1",
      agent: "worker-agent",
      prompt: "p",
    });

    // The resolver received the parent/origin session id and its result was
    // forwarded as the SAME reference (not cloned, not undefined).
    expect(seenSessions).toEqual(["origin-1"]);
    expect(service.started).toHaveLength(1);
    expect(service.started[0].request.parent).toBe(parent);
  });

  it("fails loud with DshParentUnresolvedError and never calls start when no parent resolves", async () => {
    service.seedProvider("orphan");
    const adapter = new DshDispatchAdapter({
      subagents: service,
      directory: tmpDir,
      parentResolver: () => undefined,
    });

    let err: unknown;
    try {
      await adapter.dispatchRound({
        originSessionId: "missing-session",
        agent: "orphan",
        prompt: "p",
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(DshParentUnresolvedError);
    expect((err as DshParentUnresolvedError).sessionId).toBe("missing-session");
    expect(String((err as Error).message)).toContain("missing-session");
    // The spawn never reached the seam — no `parent: undefined` was shipped.
    expect(service.started).toHaveLength(0);
  });

  it("fails loud when no parentResolver is wired at all", async () => {
    service.seedProvider("orphan");
    const adapter = new DshDispatchAdapter({
      subagents: service,
      directory: tmpDir,
    });

    let err: unknown;
    try {
      await adapter.dispatchRound({
        originSessionId: "session-x",
        agent: "orphan",
        prompt: "p",
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(DshParentUnresolvedError);
    expect((err as DshParentUnresolvedError).sessionId).toBe("session-x");
    expect(service.started).toHaveLength(0);
  });

});

// ── dsh 0.1.5-rc.1 SubagentCapabilities contract ────────────────────────────

describe("dsh 0.1.5-rc.1 subagent capability contract", () => {
  const capabilityDef: AgentDefinition = {
    id: "cap-probe",
    name: "Capability Probe",
    description: "test definition for capability assertions",
    systemPrompt: "",
  };

  it("declares exactly the five required booleans, with agentOptions true", () => {
    const registrar = new DshAgentRegistrar({ subagents: service });
    const capabilities: DshSubagentCapabilities =
      registrar.buildProvider(capabilityDef).capabilities;

    // dsh 0.1.5-rc.1 declares FIVE SubagentCapabilities booleans
    // (packages/subagent/subagent/src/types.ts:130-136). A missing/extra key
    // or a non-boolean value fails here.
    expect(Object.keys(capabilities).sort()).toEqual([
      "agentOptions",
      "depthLimit",
      "outputSchema",
      "persona",
      "toolFilter",
    ]);
    for (const value of Object.values(capabilities)) {
      expect(typeof value).toBe("boolean");
    }

    // rolebox honors request.agentOptions, so dsh's assertCapabilities
    // (packages/subagent/subagent/src/index.ts:641-657) accepts a start
    // carrying it instead of rejecting with UNSUPPORTED_CAPABILITY.
    expect(capabilities.agentOptions).toBe(true);
  });

  it("forwards a start request carrying agentOptions into start()", async () => {
    const captured: DshSubagentStartRequest[] = [];
    const registrar = new DshAgentRegistrar({
      subagents: service,
      onSpawn: async (_definition, request) => {
        captured.push(request);
        return new FakeRun("cap-probe-run");
      },
    });
    const provider = registrar.buildProvider(capabilityDef);

    const options = { provider: "openai", model: "deepseek-chat" };
    await provider.start({
      prompt: outputBlock("do the work"),
      parent: fakeParent,
      signal: new AbortController().signal,
      agentOptions: options,
      // The dsh service stamps the resolved child descriptor before start().
      descriptor: {},
    });

    // capabilityDef has no model override to merge, so the agentOptions carried
    // by the start request reach the delegated start unchanged.
    expect(captured).toHaveLength(1);
    expect(captured[0].agentOptions).toEqual(options);
  });
});

// ── dsh 0.1.5-rc.1 continuable-creation capability (prepareContinuable) ──────

describe("dsh 0.1.5-rc.1 continuable-creation contract (prepareContinuable)", () => {
  const continuableDef: AgentDefinition = {
    id: "continuable-probe",
    name: "Continuable Probe",
    description: "test definition for continuable assertions",
    systemPrompt: "",
  };

  const makeRequest = (): DshContinuableCreateRequest => ({
    sessionId: "child-session-1",
    parent: fakeParent,
    signal: new AbortController().signal,
  });

  it("the service gate rejects a provider without prepareContinuable (control)", async () => {
    // Negative control proving the gate is real: the fake mirrors dsh's
    // `UNSUPPORTED_CAPABILITY` rejection for a provider lacking the method
    // (packages/subagent/subagent/src/index.ts:598-603).
    service.seedProvider("no-continuable");
    let caught: unknown;
    try {
      await service.prepareContinuable("no-continuable", makeRequest());
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe("UNSUPPORTED_CAPABILITY");
  });

  it("a continuable start against a rolebox provider is NOT rejected", async () => {
    const registrar = new DshAgentRegistrar({ subagents: service });
    const provider = registrar.buildProvider(continuableDef);
    service.registerProvider(provider);

    // Method presence IS the capability (types.ts:374-389), so a rolebox
    // provider must expose `prepareContinuable` and survive the service's
    // resolution without an UNSUPPORTED_CAPABILITY rejection.
    expect(typeof provider.prepareContinuable).toBe("function");

    const spec = await service.prepareContinuable(continuableDef.id, makeRequest());
    expect(spec).toBeDefined();
  });

  it("declares the fresh-start choice by omitting the spec's seed field", async () => {
    const provider = registrarFor(continuableDef);
    const spec = await provider.prepareContinuable!(makeRequest());

    // dsh's ContinuableCreateSpec has exactly ONE field, `seed`
    // (packages/subagent/subagent/src/types.ts:237-244): a present array seeds
    // the child from the parent's completed-turn log, while ABSENCE is exactly
    // the fresh-start declaration the continuation manager reads at
    // continuation.ts:144-145. rolebox chose FRESH-START (Q1), so the spec must
    // carry no `seed` key at all.
    expect(Object.keys(spec)).toEqual([]);
    expect(spec.seed).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(spec, "seed")).toBe(false);
  });

  function registrarFor(def: AgentDefinition): DshSubagentProvider {
    return new DshAgentRegistrar({ subagents: service }).buildProvider(def);
  }
});

// ── Terminating-signal parity on the dsh settlement path ────────────────────
//
// The completion evaluator records the sub-agent's terminating signal on the
// task (`task.terminatingSignal`, completion-evaluator.ts) so the engine's
// `mapDispatchStatusToSignal` (engine-recovery.ts) can preserve a real
// `revise_needed` / `escalate` instead of hardcoding `answer`. The dsh
// adapter settles its own tasks, so it must make the same assignment —
// otherwise every completed dsh node falls through to the inferred-answer
// branch and logs "no terminatingSignal recorded for completed task".

describe("terminating-signal parity on dsh completion settlement", () => {
  // `sessionSignalLedger` is a process-wide singleton; reset it around every
  // case so one case's recorded signal cannot leak into another.
  beforeEach(() => {
    sessionSignalLedger.resetAll();
  });

  afterEach(() => {
    sessionSignalLedger.resetAll();
  });

  it("settles a completed run with the synthetic answer signal when no signal was recorded", async () => {
    service.seedProvider("silent-run");
    const { workerTaskId } = await dispatch.dispatchRound({
      originSessionId: "origin-signal",
      agent: "silent-run",
      prompt: "round",
    });

    // Settle the run explicitly so the assertion never races a timer.
    service.completeRun(workerTaskId, {
      stopReason: "completed",
      output: outputBlock("finished clean"),
    });
    await settle();

    const task = dispatch.getTask(workerTaskId);
    expect(task?.status).toBe("completed");
    expect(task?.terminatingSignal?.type).toBe("answer");
    expect(task?.terminatingSignal?.payload).toEqual({ __inferred: true });
  });

  it("carries the ledger's terminating signal from the sub-agent session onto the settled task", async () => {
    service.seedProvider("revise-run");
    const { workerTaskId, workerSessionId } = await dispatch.dispatchRound({
      originSessionId: "origin-signal",
      agent: "revise-run",
      prompt: "round",
    });

    // The sub-agent's own `signal()` call lands in the ledger keyed by its
    // session — in dsh a `SubagentRun.id` IS a `SessionId`.
    sessionSignalLedger.record(workerSessionId, "revise_needed", {
      reason: "rework the draft",
    });
    service.completeRun(workerTaskId, {
      stopReason: "completed",
      output: outputBlock("done"),
    });
    await settle();

    const task = dispatch.getTask(workerTaskId);
    expect(task?.status).toBe("completed");
    expect(task?.terminatingSignal?.type).toBe("revise_needed");
    expect(task?.terminatingSignal?.payload).toEqual({ reason: "rework the draft" });
  });

  it("leaves the error path untouched (it maps independently of the signal)", async () => {
    service.seedProvider("error-run");
    const { workerTaskId } = await dispatch.dispatchRound({
      originSessionId: "origin-signal",
      agent: "error-run",
      prompt: "round",
    });
    service.completeRun(workerTaskId, {
      stopReason: "error",
      output: outputBlock("boom"),
    });
    await settle();

    const task = dispatch.getTask(workerTaskId);
    expect(task?.status).toBe("error");
    expect(task?.terminatingSignal).toBeUndefined();
  });
});

// ── Import hygiene ──────────────────────────────────────────────────────────

describe("dsh dispatch code import hygiene", () => {
  it("contains no @opencode-ai or @deepseek-ai imports", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/platform/adapters/dsh/dispatch.ts"),
      "utf-8",
    );
    expect(source.includes("@opencode-ai")).toBe(false);
    expect(source.includes("@deepseek-ai/")).toBe(false);
  });
});
