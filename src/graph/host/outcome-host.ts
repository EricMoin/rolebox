/**
 * Graph Execution Engine v2 — the SHIPPED host assembly for the outcome run path
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * WIRES THE HOST CAPABILITY LAYER (`src/graph/host/**`) INTO ONE OBJECT a
 * shipping host injects into the outcome tool face and the startup recovery
 * sweep:
 *
 * - the protected credential vault (D7) — the only place an attempt credential
 *   exists once it is minted, since the ledger keeps its digest;
 * - the durable execution index plus the dispatch adapter (D8) — create at most
 *   once per stable effect id, and answer `created` / `absent` / `unknown`
 *   about an effect a restart finds in the ledger;
 * - the invocation-identity holder (D9) — the host's own attribution of "which
 *   invocation is running now", moved per tool call and per first execution,
 *   captured on each attempt's binding and re-entered for the duration of that
 *   attempt's completion settlement (see {@link OutcomeHost.complete});
 * - the completion bridge — an attempt the platform reports finished is settled
 *   through the runtime's `settleNatural`, never through a second ingress.
 *
 * WHETHER THE HOST DECLARES D9 IS A DECISION, NOT A DEFAULT. The identity
 * capability is an assertion the host must be able to substantiate: the
 * submission that settles an attempt has to be attributed to the same
 * invocation that armed it. {@link OutcomeHostOptions.declareInvocationIdentity}
 * is that decision, and the shipped entries choose NOT to declare it because a
 * dispatched worker is a separate agent session whose own tool calls are
 * attributed to the worker, never to the declaring invocation.
 *
 * WHO RUNS THE FIRST DISPATCH. A declared graph is persisted by
 * `graph_declare` and dispatched by nobody in the tool layer. The host calls
 * {@link OutcomeHost.startDeclaredGraph} from its declaration seam: that opens
 * the graph's saved plan, continues (or starts) it through the outcome
 * runtime's own `resume`, and closes the same crash windows a restart sweep
 * closes. {@link OutcomeHost.recoverDeclaredGraphs} is the same operation over
 * every protocol-2 record in the store, for a host's boot path.
 *
 * EVERY DISPATCH WINDOW NAMES THE GRAPH'S DECLARING INVOCATION. A platform can
 * only start a worker under the invocation that owns it, and only ONE of the
 * windows that arm a dispatch is the declaring call: a successor is armed by an
 * acceptance (a worker's submission or an observed completion) and a boot sweep
 * re-arms what a dead process left pending, both with no tool call in effect.
 * The host therefore keeps the declaring invocation PER GRAPH — in memory and,
 * with `durability: "file"`, in its own store root
 * (`invocation-origins.ts`) — and hands it to the delivery seam on every
 * create, so the entry attempt and every successor run under the same parent
 * instead of the window's ambient attribution.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It never builds a legacy engine,
 * never imports one, and never registers a legacy tool: a declared graph has no
 * legacy runtime instance. Its delivery seam is injected by the host
 * ({@link HostDispatchDelivery}) so the platform-specific way to start a worker
 * stays in the platform adapter.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { CanonicalToolDef, CanonicalToolContext } from "../../platform/types.ts";
import { errorText } from "../../utils/error-text.ts";
import { logWarn } from "../log-warn.ts";
import {
  DEFAULT_STORAGE_FORMAT_REGISTRY,
  engineStateDir,
  engineStatePath,
  loadEngineStateForResume,
} from "../persistence/engine-persistence.ts";
import { SqliteAcceptanceLedger } from "../ledger/sqlite-ledger.ts";
import { persistOutcomeProjection } from "../persistence/outcome-projection.ts";
import { OUTCOME_PROTOCOL } from "../protocol/execution-protocol.ts";
import { readPersistedOutcomePlan } from "../outcome/recovery.ts";
import {
  OutcomeGraphRuntime,
  type OutcomeResumeResult,
} from "../outcome/runtime.ts";
import type { CredentialIsolationCapability } from "../outcome/credential-isolation.ts";
import type { HostIdentityCapability } from "../outcome/host-identity.ts";
import {
  createValidatorRegistry,
  type ValidatorRegistry,
} from "../outcome/validators.ts";
import type { CompletionPolicyRegistry } from "../policy/completion-policy.ts";
import type {
  HostDispatchDelivery,
  HostDispatchInvocation,
} from "./dispatch-host.ts";
import type { OutcomeDispatchEffectKey } from "../outcome/dispatch-effects.ts";
import type {
  OutcomeEffectDivergence,
  OutcomeRuntimeRefusal,
} from "../outcome/runtime.ts";
import { HostOutcomeDispatch } from "./dispatch-host.ts";
import { HostExecutionIndex } from "./execution-index.ts";
import { HostCredentialVault } from "./credential-vault.ts";
import { HostInvocationOrigins } from "./invocation-origins.ts";
import {
  HostDispatchCompletionBridge,
  type HostCompletionReport,
  type HostCompletionRuntime,
} from "./completion-bridge.ts";
import {
  createHostInvocationHolder,
  hostInvocationIdentity,
  type HostInvocationHolder,
} from "./identity.ts";

// ── Options and result shapes ───────────────────────────────────────────────

/** How long the host's vault and execution index outlive the process. */
export type OutcomeHostDurability = "file" | "memory";

/** Inputs to {@link OutcomeHost.open}. */
export interface OutcomeHostOptions {
  /**
   * The workspace whose `.rolebox/state` store holds the declared graphs'
   * persisted plans. Also the default artifact root.
   */
  readonly workspaceDir: string;
  /**
   * The HOST-owned root the vault, the execution index and the acceptance
   * ledger live under. Deliberately NOT the workspace by default — see
   * `credential-vault.ts` for the boundary this root can and cannot give.
   */
  readonly storeRoot: string;
  /** How the platform starts one attempt. See `dispatch-host.ts`. */
  readonly deliver: HostDispatchDelivery;
  /** The validator capabilities this host installs (defaults to none). */
  readonly validators?: ValidatorRegistry;
  /** The completion policies this host authorized (defaults to none). */
  readonly completionPolicies?: CompletionPolicyRegistry;
  /** Root every evidence reference resolves inside. Defaults to `workspaceDir`. */
  readonly artifactRoot?: string;
  /** The clock reported to settlements; defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Vault/index durability. Defaults to `"file"` (restart-recoverable). */
  readonly durability?: OutcomeHostDurability;
  /**
   * Whether this host DECLARES the invocation-identity capability (D9) to the
   * run path. Defaults to `true`.
   *
   * DECLARE IT ONLY WHEN THE HOST CAN SUBSTANTIATE IT. The capability's
   * contract is that a submission settling an attempt is attributed to the
   * SAME invocation the dispatch armed it under. A host whose dispatched
   * workers submit from their OWN invocations (the shipped dsh and Pi entries:
   * a worker is a separate agent session, not the declaring one) cannot
   * substantiate that, and declaring it would refuse exactly the submissions
   * the delivery handoff asks the worker to make. Such a host passes `false`:
   * every other guarantee is unchanged — the bearer credential still binds a
   * submission to its attempt — and no identity is recorded on an attempt.
   */
  readonly declareInvocationIdentity?: boolean;
}

/** One host invocation's attribution, as the declaring tool call saw it. */
export interface OutcomeHostInvocation {
  readonly sessionId?: string;
  readonly agent?: string;
}

/**
 * What a boot sweep over the declared graphs did.
 *
 * A STARTED OR RESUMED GRAPH STILL CARRIES ITS PER-EFFECT DIAGNOSTICS. A
 * graph's own `resume` reports every effect it could not launch and every
 * effect whose persisted row contradicted the host's fact; the sweep is the
 * caller that owns those effects, so it AGGREGATES them instead of reporting
 * only that the graph was visited. `refused` stays what it always was — the
 * graphs the sweep could not open or run AT ALL.
 */
export interface OutcomeHostRecoveryReport {
  /** `graph:revision` for each graph this sweep gave a FIRST EXECUTION. */
  readonly started: readonly string[];
  /** `graph:phase` for each graph continued from persisted state. */
  readonly resumed: readonly string[];
  /** `graph:reason` for each protocol-2 record this sweep could not open. */
  readonly refused: readonly string[];
  /**
   * Every per-effect refusal the graphs' own resumes reported, each tagged with
   * the graph it came from: an effect the runtime would not launch (an
   * unreadable payload, a credential the host cannot produce, a create the
   * platform refused) stays `pending` and is named here rather than dropped.
   */
  readonly effectRefusals: readonly (OutcomeRuntimeRefusal & {
    readonly graphId: string;
  })[];
  /**
   * Every restart DIVERGENCE the graphs' own resumes reported, each tagged with
   * its graph: the persisted local effect status and the host's fact about the
   * same stable id disagree, and the resolution says what the resume did about
   * it — never a blind re-dispatch and never a silent drop.
   */
  readonly divergences: readonly (OutcomeEffectDivergence & {
    readonly graphId: string;
  })[];
}

// ── The host ────────────────────────────────────────────────────────────────

/**
 * One host process's outcome-run-path capability layer.
 *
 * Construct with {@link OutcomeHost.open}, inject `credentialIsolation`,
 * `hostIdentity`, `dispatch` and the toolset's outcome options, and keep the
 * instance for the process lifetime: the vault and the execution index are the
 * host's durable facts, and the completion bridge's bindings live here.
 */
export class OutcomeHost {
  private readonly workspaceDir: string;
  private readonly storeRoot: string;
  private readonly artifactRoot: string;
  private readonly clock: () => number;
  private readonly validators: ValidatorRegistry;
  private readonly completionPolicies: CompletionPolicyRegistry | undefined;
  private readonly vault: HostCredentialVault;
  private readonly executions: HostExecutionIndex;
  private readonly origins: HostInvocationOrigins;
  private readonly holder: HostInvocationHolder;
  private readonly declareInvocationIdentity: boolean;
  private readonly dispatchAdapter: HostOutcomeDispatch;
  /** One bridge per graph — a settlement needs the graph's own saved plan. */
  private readonly bridges = new Map<string, HostDispatchCompletionBridge>();
  /** One open runtime (and ledger) per graph, for settlements and resumes. */
  private readonly runtimes = new Map<
    string,
    Promise<{ runtime: OutcomeGraphRuntime; ledger: SqliteAcceptanceLedger }>
  >();
  private closed = false;

  private constructor(options: OutcomeHostOptions) {
    this.workspaceDir = options.workspaceDir;
    this.storeRoot = options.storeRoot;
    this.artifactRoot = options.artifactRoot ?? options.workspaceDir;
    this.clock = options.clock ?? (() => Date.now());
    this.validators = options.validators ?? createValidatorRegistry([]);
    this.completionPolicies = options.completionPolicies;
    const durability = options.durability ?? "file";
    this.vault = HostCredentialVault.open({ root: options.storeRoot, durability });
    this.executions = HostExecutionIndex.open({ root: options.storeRoot, durability });
    this.origins = HostInvocationOrigins.open({ root: options.storeRoot, durability });
    this.holder = createHostInvocationHolder();
    this.declareInvocationIdentity = options.declareInvocationIdentity ?? true;
    this.dispatchAdapter = new HostOutcomeDispatch({
      executions: this.executions,
      deliver: options.deliver,
      invocation: () => this.holder.current(),
      // The graph's own declaring invocation, not the ambient one: this is what
      // lets a successor armed out of band (and a boot sweep) name the same
      // parent as the entry attempt.
      dispatchInvocation: (graphId) => this.originOf(graphId),
      completions: {
        bind: (binding) => {
          this.bridgeFor(binding.graphId).bind(binding);
        },
      },
    });
  }

  static open(options: OutcomeHostOptions): OutcomeHost {
    return new OutcomeHost(options);
  }

  /** The protected credential store, injected as the runtime's D7 capability. */
  get credentialIsolation(): CredentialIsolationCapability {
    return this.vault.capability();
  }

  /** The host's invocation attribution, injected as the runtime's D9 capability. */
  get hostIdentity(): HostIdentityCapability {
    return this.holder.capability;
  }

  /** The dispatch adapter the outcome runtime and the toolset dispatch through. */
  get dispatch(): HostOutcomeDispatch {
    return this.dispatchAdapter;
  }

  /** The vault, exposed for tests and host reports. */
  get credentials(): HostCredentialVault {
    return this.vault;
  }

  /** Move the invocation this host attributes to the current operation. */
  setInvocation(invocation: OutcomeHostInvocation): void {
    this.holder.set(
      hostInvocationIdentity(invocation.sessionId, invocation.agent),
    );
  }

  /** Report that the current operation carries no host attribution. */
  clearInvocation(): void {
    this.holder.clear();
  }

  /**
   * Settle the attempt the host observed finishing, through the graph's own
   * saved plan. The report is the bridge's — see `completion-bridge.ts`.
   *
   * THE SETTLEMENT RUNS UNDER THE ATTEMPT'S OWN DISPATCH ATTRIBUTION. A
   * completion is observed later, out of band, when no invocation is in effect;
   * the runtime still compares the host's current identity with the one it
   * recorded when the attempt was armed. So the host re-enters the identity the
   * delivery captured on the binding — or, for a host that declared no identity,
   * the graph's own declaring invocation — for exactly this call and restores
   * the ambient attribution afterwards. That window is also what arms the
   * attempt's SUCCESSOR, so the dispatch it triggers names the same parent the
   * entry attempt ran under, whatever the ambient attribution is at the moment
   * the platform reports the completion. An attempt that recorded NO identity
   * is settled with none — nothing fabricates an attribution for it — and an
   * attempt this host never dispatched stays unbound and is reported by the
   * bridge.
   */
  async complete(
    graphId: string,
    attemptId: string,
  ): Promise<HostCompletionReport> {
    const bridge = this.bridgeFor(graphId);
    const binding = bridge.bindingFor({ graphId, attemptId });
    const dispatchIdentity = binding?.dispatchIdentity ?? this.originIdentityOf(graphId);
    const previous = this.holder.current();
    if (dispatchIdentity !== undefined) this.holder.set(dispatchIdentity);
    try {
      const report = await bridge.complete({ graphId, attemptId });
      if (report.kind === "settled") {
        const { runtime } = await this.runtimeFor(graphId);
        const state = runtime.state();
        if (state !== undefined) {
          persistOutcomeProjection(this.workspaceDir, state, this.clock());
        }
      }
      return report;
    } finally {
      if (previous === undefined) {
        this.holder.clear();
      } else {
        this.holder.set(previous);
      }
    }
  }

  /**
   * Give ONE declared graph its first execution, or continue it from the state
   * its ledger already holds.
   *
   * This is deliberately the runtime's own `resume`: a graph with no ledger
   * state is STARTED from the saved plan, a graph with one is continued, and
   * nothing is ever started twice for the same plan revision. The invocation is
   * put in effect for the synchronous dispatch window, so an attempt this call
   * arms records the declaring invocation's identity (D9) — and it is RECORDED
   * for the graph, so the successors this run arms later are dispatched under
   * the same invocation instead of the ambient one.
   *
   * A call that names no session (the sweep finding no recorded origin) records
   * nothing and arms attempts under no invocation: a dispatch the platform then
   * refuses is reported as the effect refusal it is, never attributed to a
   * guess.
   */
  async startDeclaredGraph(
    graphId: string,
    invocation: OutcomeHostInvocation = {},
  ): Promise<OutcomeResumeResult> {
    this.assertOpen();
    const { runtime } = await this.runtimeFor(graphId);
    this.rememberOrigin(graphId, invocation);
    this.setInvocation(invocation);
    try {
      const result = runtime.resume(this.clock());
      // The run just advanced; refresh the operator view of the graph's own
      // record so graph_status reads what the ledger holds (best-effort, and
      // never part of the transaction: the ledger already committed).
      if (result.kind !== "refused") {
        persistOutcomeProjection(this.workspaceDir, result.state, this.clock());
      }
      return result;
    } finally {
      this.holder.clear();
    }
  }

  /**
   * The boot sweep: every protocol-2 record in the workspace store gets the
   * same first-execution/resume treatment as {@link startDeclaredGraph}, one
   * graph at a time. A record this host cannot open is reported, never
   * rewritten; the sweep never throws.
   */
  async recoverDeclaredGraphs(): Promise<OutcomeHostRecoveryReport> {
    this.assertOpen();
    const started: string[] = [];
    const resumed: string[] = [];
    const refused: string[] = [];
    const effectRefusals: (OutcomeRuntimeRefusal & { graphId: string })[] = [];
    const divergences: (OutcomeEffectDivergence & { graphId: string })[] = [];
    for (const graphId of this.declaredGraphIds()) {
      try {
        // The invocation this graph was declared under, when this host knows it
        // (in memory, or from its own record after a restart): a resumed graph
        // re-arms its pending effects, and the platform can only start them
        // under a parent. No recorded origin dispatches under none, and the
        // refusal that follows is reported — not guessed away.
        const origin = this.origins.get(graphId);
        const result = await this.startDeclaredGraph(graphId, origin ?? {});
        if (result.kind === "refused") {
          refused.push(
            graphId + ": " + result.refusals.map((r) => r.code).join(","),
          );
          continue;
        }
        if (result.kind === "started") {
          started.push(graphId + ":" + result.state.planRevision);
        } else {
          resumed.push(graphId + ":" + result.state.phase);
        }
        // A VISITED GRAPH STILL OWES ITS PER-EFFECT FACTS. Every effect the
        // resume would not launch and every row that contradicted the host is
        // carried into the report (and the log below), so "resumed" never hides
        // work that is still pending.
        for (const refusal of result.refusals) {
          effectRefusals.push(Object.freeze({ graphId, ...refusal }));
        }
        for (const divergence of result.divergences) {
          divergences.push(Object.freeze({ graphId, ...divergence }));
        }
      } catch (err) {
        refused.push(graphId + ": " + errorText(err));
      }
    }
    if (
      started.length > 0 ||
      resumed.length > 0 ||
      refused.length > 0 ||
      effectRefusals.length > 0 ||
      divergences.length > 0
    ) {
      logWarn(
        "outcome-host: declared-graph sweep — started=[" +
          started.join(", ") +
          "] resumed=[" +
          resumed.join(", ") +
          "] refused=[" +
          refused.join(", ") +
          "] effect-refusals=[" +
          effectRefusals
            .map((refusal) => refusal.graphId + ":" + refusal.code)
            .join(", ") +
          "] divergences=[" +
          divergences
            .map(
              (divergence) =>
                divergence.graphId +
                ":" +
                divergence.effectId +
                ":" +
                divergence.local +
                "->" +
                divergence.host,
            )
            .join(", ") +
          "]",
      );
    }
    return Object.freeze({
      started: Object.freeze(started),
      resumed: Object.freeze(resumed),
      refused: Object.freeze(refused),
      effectRefusals: Object.freeze(effectRefusals),
      divergences: Object.freeze(divergences),
    });
  }

  /**
   * Bind a tool face to this host's invocation attribution: every call puts the
   * host's attribution of THAT invocation in effect for the call's duration and
   * clears it after (D9).
   */
  bindTools(
    tools: Record<string, CanonicalToolDef>,
    getEffectiveAgent?: (sessionID?: string) => string,
  ): Record<string, CanonicalToolDef> {
    return bindOutcomeToolInvocation(tools, {
      holder: this.holder,
      ...(getEffectiveAgent === undefined ? {} : { getEffectiveAgent }),
    });
  }

  /**
   * Report a delivery that failed asynchronously: no execution was created, so
   * the record the adapter took before delivery is dropped. A later recovery
   * then asks the host and gets `absent` instead of treating the effect as
   * started.
   */
  reportDeliveryFailure(effect: OutcomeDispatchEffectKey, reason: string): void {
    this.executions.unrecord(effect);
    logWarn(
      "outcome-host: delivery failed for graph " +
        JSON.stringify(effect.graphId) +
        " effect " +
        JSON.stringify(effect.effectId) +
        " — the execution-index record was dropped: " +
        reason,
    );
  }

  /** Release every open ledger handle. The host is inert afterwards. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.runtimes.values()) {
      void pending.then(
        ({ ledger }) => {
          try {
            ledger.close();
          } catch {
            // Closing an already-closed handle is not a host failure.
          }
        },
        () => {},
      );
    }
    this.runtimes.clear();
    this.bridges.clear();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Record the declaring invocation a graph's dispatches belong to.
   *
   * A call that names no session records nothing: "no origin" is a fact about
   * this host's knowledge, and a placeholder would turn it into a false
   * attribution. A later call that DOES name a session replaces the record —
   * the newer invocation is the one actually running the graph.
   */
  private rememberOrigin(
    graphId: string,
    invocation: OutcomeHostInvocation,
  ): void {
    const sessionId = invocation.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    this.origins.record(
      graphId,
      invocation.agent === undefined || invocation.agent.length === 0
        ? { sessionId }
        : { sessionId, agent: invocation.agent },
    );
  }

  /** The platform invocation this graph's dispatches run under, if known. */
  private originOf(graphId: string): HostDispatchInvocation | undefined {
    const origin = this.origins.get(graphId);
    if (origin === undefined) return undefined;
    return Object.freeze({
      sessionId: origin.sessionId,
      ...(origin.agent === undefined ? {} : { agent: origin.agent }),
    });
  }

  /** The same origin as the D9 identity shape, or `undefined` when unreadable. */
  private originIdentityOf(graphId: string) {
    const origin = this.origins.get(graphId);
    if (origin === undefined) return undefined;
    return hostInvocationIdentity(origin.sessionId, origin.agent);
  }

  /** The per-graph completion bridge, created on first use. */
  private bridgeFor(graphId: string): HostDispatchCompletionBridge {
    const existing = this.bridges.get(graphId);
    if (existing !== undefined) return existing;
    const bridge = new HostDispatchCompletionBridge({
      runtime: () => this.runtimeFor(graphId).then(({ runtime }) => runtime),
      credentials: this.vault,
      clock: this.clock,
    });
    this.bridges.set(graphId, bridge);
    return bridge;
  }

  /**
   * The graph's outcome runtime over its PERSISTED plan, opened once per graph
   * and kept for the process lifetime (the completion bridge and the declaration
   * seam share it). The loader is the same one the submission ingress uses, so a
   * record that is not this build's outcome-protocol state is refused instead of
   * being run approximately.
   */
  private runtimeFor(
    graphId: string,
  ): Promise<{ runtime: OutcomeGraphRuntime; ledger: SqliteAcceptanceLedger }> {
    const existing = this.runtimes.get(graphId);
    if (existing !== undefined) return existing;
    const pending = this.openRuntime(graphId);
    this.runtimes.set(graphId, pending);
    return pending;
  }

  private async openRuntime(
    graphId: string,
  ): Promise<{ runtime: OutcomeGraphRuntime; ledger: SqliteAcceptanceLedger }> {
    const path = engineStatePath(this.workspaceDir, graphId);
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (error) {
      throw new Error(
        "outcome-host: graph " +
          JSON.stringify(graphId) +
          " has no readable persisted record at " +
          path +
          " (" +
          errorText(error) +
          ") — a declared graph is dispatched only from its SAVED plan",
      );
    }
    const loaded = loadEngineStateForResume(
      raw,
      path,
      DEFAULT_STORAGE_FORMAT_REGISTRY,
    );
    if (loaded.kind !== "valid") {
      throw new Error(
        "outcome-host: graph " +
          JSON.stringify(graphId) +
          " is not a loadable outcome record (" +
          loaded.kind +
          ")",
      );
    }
    if (loaded.executionProtocol !== OUTCOME_PROTOCOL) {
      throw new Error(
        "outcome-host: graph " +
          JSON.stringify(graphId) +
          " is bound to execution protocol " +
          String(loaded.executionProtocol) +
          ", not the outcome protocol",
      );
    }
    const reading = readPersistedOutcomePlan(loaded.state);
    if (reading.kind === "refused") {
      throw new Error(
        "outcome-host: graph " +
          JSON.stringify(graphId) +
          " cannot be run from its persisted record: " +
          reading.refusals.map((r) => r.code).join(", "),
      );
    }
    const ledger = await SqliteAcceptanceLedger.create(this.storeRoot);
    const runtime = new OutcomeGraphRuntime({
      plan: reading.plan.plan,
      ledger,
      dispatch: this.dispatchAdapter,
      validators: this.validators,
      artifactRoot: this.artifactRoot,
      clock: this.clock,
      credentialIsolation: this.credentialIsolation,
      ...(this.declareInvocationIdentity
        ? { hostIdentity: this.hostIdentity }
        : {}),
      ...(this.completionPolicies === undefined
        ? {}
        : { completionPolicies: this.completionPolicies }),
    });
    return { runtime, ledger };
  }

  /** Every graph id the workspace store holds a protocol-2 record for. */
  private declaredGraphIds(): string[] {
    const stateDir = engineStateDir(this.workspaceDir);
    let files: string[];
    try {
      files = readdirSync(stateDir, { encoding: "utf-8" });
    } catch {
      return [];
    }
    const ids: string[] = [];
    for (const file of files.sort()) {
      if (!/^engine-.+\.json$/.test(file)) continue;
      const path = join(stateDir, file);
      try {
        const loaded = loadEngineStateForResume(
          readFileSync(path, "utf-8"),
          path,
          DEFAULT_STORAGE_FORMAT_REGISTRY,
        );
        if (loaded.kind === "valid" && loaded.executionProtocol === OUTCOME_PROTOCOL) {
          ids.push(loaded.state.graphId);
        }
      } catch {
        // A record this sweep cannot read is not a declared graph to start;
        // the drain audit reports it as a blocker.
      }
    }
    return ids;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("outcome-host: this host has been closed");
    }
  }
}

// ── Tool attribution ────────────────────────────────────────────────────────

/** How the host resolves the acting agent for one tool invocation. */
export interface OutcomeToolAttribution {
  /** The host's invocation holder (D9). */
  readonly holder: HostInvocationHolder;
  /** Platform acting-agent resolver (`context.agent` wins when populated). */
  readonly getEffectiveAgent?: (sessionID?: string) => string;
}

/**
 * Bind the outcome tool face to the host's invocation holder: every call puts
 * the host's attribution of THIS invocation in effect for the duration of the
 * call and clears it after. The runtime reads the holder synchronously when it
 * arms an attempt or checks a settlement, so a submission is attributed to the
 * caller rather than to whoever moved the holder last.
 */
export function bindOutcomeToolInvocation(
  tools: Record<string, CanonicalToolDef>,
  attribution: OutcomeToolAttribution,
): Record<string, CanonicalToolDef> {
  const bound: Record<string, CanonicalToolDef> = {};
  for (const [name, def] of Object.entries(tools)) {
    bound[name] = withInvocation(def, attribution);
  }
  return bound;
}

/** The erased argument type one canonical tool's execute receives. */
type ToolExecute = CanonicalToolDef["execute"];
type ToolExecuteArgs = Parameters<ToolExecute>[0];

function withInvocation(
  def: CanonicalToolDef,
  attribution: OutcomeToolAttribution,
): CanonicalToolDef {
  const inner = def.execute;
  return {
    ...def,
    async execute(args: unknown, context: CanonicalToolContext) {
      const agent =
        context?.agent && context.agent.length > 0
          ? context.agent
          : (attribution.getEffectiveAgent?.(context?.sessionID) ?? "");
      attribution.holder.set(hostInvocationIdentity(context?.sessionID, agent));
      try {
        return await inner(args as ToolExecuteArgs, context);
      } finally {
        attribution.holder.clear();
      }
    },
  };
}
