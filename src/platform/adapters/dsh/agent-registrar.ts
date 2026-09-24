/**
 * DshAgentRegistrar — IAgentRegistrar adapter for the dsh (DeepSeek Harness)
 * subagent catalog.
 *
 * Translates rolebox `AgentDefinition` entries into `SubagentProvider`
 * registrations on the dsh `ctx.subagents` seam
 * (`SubagentRuntime.registerProvider`), using the API surface verified in
 * `docs/dsh-plugin-contract.md` (§4.2, §4.3).
 *
 * Mapping (AgentDefinition → SubagentProvider):
 *   - `id`           → provider `name` (the unique registry key, see `list()`)
 *   - `systemPrompt` → prepended to the spawn request's `prompt` as a text
 *                      ContentBlock (`{type:'text', text}` per §3.4)
 *   - `model`        → split via the shared `splitModel` helper into the spawn
 *                      request's `agentOptions.provider` + `agentOptions.model`:
 *                      a resolved `"<provider>/<model-id>"` sets BOTH fields
 *                      (provider = segment before the first slash; model = the
 *                      rest, so multi-segment ids survive), while a
 *                      bare/`"default"`/malformed model overrides `model` only
 *                      and leaves the base provider untouched.
 *                      (dsh-agent `AgentOptions` = `{provider?, model?, maxTokens?}`, §4.2)
 *
 * ── Provider-route safety path ──────────────────────────────────────────────
 * Emitting a split `provider` that dsh has NO registered llm adapter for would
 * turn a working spawn into a hard dispatch failure (`NO_ADAPTER`,
 * `dsh-llm/lib/index.js:965-966`; see `docs/dsh-provider-notes.md` §2/§4).
 * When a {@link DshProviderRouteProbe} is wired, `mergeAgentOptions` checks the
 * split provider against the routes `ctx.llm.listProviders()` reports and, on a
 * miss, logs ONE explicit warning and degrades to a model-only override —
 * leaving the base provider untouched so the spawn inherits the runtime
 * default route instead of failing. Absent a probe (no `ctx.llm` service), the
 * split is emitted unchanged (the pre-safety behavior).
 *   - `tools` / `maxSteps` → CATALOG configuration only; deliberately NOT
 *                      mapped to dsh start-time capabilities. rc.6 requires all
 *                      four `SubagentCapabilities` booleans and this provider
 *                      advertises none — see `buildCapabilities`.
 *
 * ── Per-session active-role application ─────────────────────────────────────
 * When the registrar is constructed with an `activeRole` lookup (the
 * {@link DshRoleSwitcher}'s shared per-session holder), a provider's
 * `start()` consults it with the spawn request's `sessionId` (threaded by
 * {@link DshDispatchAdapter} from the parent/origin session) and, when a
 * role is active for that session, PREPENDS the active role's systemPrompt
 * to the spawned prompt and applies its model override — the seam that makes
 * a web-UI role switch actually reach the spawned agent. No active role (or
 * no sessionId on the request) falls back to the definition's own behavior;
 * spawning the active role's own definition skips the redundant prepend.
 *
 * ── Spawn-time context injection (the system-transform counterpart) ────────
 * rolebox's `system-transform` hook (`src/hooks/system-transform.ts`) — which
 * injects the role's dynamic context blocks (available functions, memory,
 * graph state) into the agent prompt — remains a no-op at the HOOK level in
 * {@link DshHookProvider} (hook-provider.ts:15,21-24,178); session-level
 * injection now flows through {@link DshSystemPromptAdapter} (system-prompt.ts
 * — `rolebox:role` + `rolebox:context`, per-session via `context.agent.id`).
 * To keep dsh's context injection flowing into a spawned agent, the registrar
 * exposes a {@link DshSpawnContextProvider} seam: when an active role exists
 * for the spawn's session, `start()` prepends the provider's context blocks
 * AHEAD of the active role's complete materialized prompt, so the spawned
 * agent's prompt carries BOTH the injected context AND the role prompt.
 * Absent a provider (or active role) the spawn is unchanged — base behavior.
 *
 * This module does NOT import from any host SDK package — neither the opencode
 * plugin/SDK nor any dsh package. The dsh surface is consumed structurally
 * (duck typing) against the shapes verified in the contract, which keeps the
 * adapter SDK-free and unit-testable against a fake registry double.
 *
 * Platform-artifact cleanup: `registerProvider` returns a disposer that
 * removes the provider from the dsh registry. `unregister()` (and replacement
 * of a changed definition during `register()`/`sync()`) invokes that disposer
 * — that is the platform artifact this adapter cleans up.
 *
 * The live-agent side of dsh (`ctx.agents` AgentRegistry
 * `create`/`resume`/`register`, and `AgentFactory`) is out of scope here:
 * this registrar manages the *catalog* of spawnable definitions. Actual
 * spawning is delegated in order: to an optional `onSpawn` hook when wired,
 * otherwise to an already-registered host provider named by
 * {@link DshAgentRegistrarOptions.spawnProviderName} (default `"spawn"`).
 * When neither resolves, a provider's `start()` throws
 * `DshSpawnNotWiredError` while registration/sync still work fully.
 *
 * @module
 */

import { createSubLogger } from "../../../logger.ts";
import type { Logger, ILogObj } from "tslog";
import { splitModel } from "../../model-ref.ts";
import type { IAgentRegistrar } from "../../ports/agent-registrar.ts";
import type { AgentDefinition } from "../../types.ts";

/** Module logger — swapped by {@link __setLoggerForTest} in unit tests. */
let log: Logger<ILogObj> = createSubLogger("dsh-agent-registrar");

/** @internal Test seam — swap the module-level logger for a mock. */
export function __setLoggerForTest(mockLogger: Logger<ILogObj>): void {
  log = mockLogger;
}

// ── Structural dsh types (docs/dsh-plugin-contract.md §3.4, §4.2, §4.3) ────

/**
 * Structural mirror of the dsh-llm `ContentBlock` union (§3.4;
 * `dsh-llm/lib/types/types.d.ts:39-89`): text, reasoning, image, tool-call,
 * and tool-result. ONE loose structural declaration shared by the subagent
 * registrar (prompt/output), the session adapter (message content), and the
 * tool factory (render output) — the real `ContentBlockMap` is
 * merge-extensible, so unknown members and extra fields are preserved by the
 * index signature and rolebox reads only the members it maps.
 */
export interface DshContentBlock {
  readonly type: string;
  /** `text` / `reasoning` payload. */
  readonly text?: string;
  /** Block id (`tool-call`). */
  readonly id?: string;
  /** Tool name (`tool-call`). */
  readonly name?: string;
  /**
   * Raw JSON string as produced by the model for a `tool-call`
   * (`dsh-llm/lib/types/types.d.ts:59-66`); parsed by the session adapter.
   * Absent for non-tool-call blocks.
   */
  readonly arguments?: string;
  /** Correlates a `tool-result` with its `tool-call`. */
  readonly toolCallId?: string;
  /** Nested blocks (`tool-result` content). */
  readonly content?: unknown;
  /** Whether a `tool-result` is an error. */
  readonly isError?: boolean;
  readonly [key: string]: unknown;
}

/**
 * dsh ToolRestriction — allow/deny mask used by subagent `toolFilter` (§4.3).
 */
export type DshToolRestriction = {
  allow?: string[];
  deny?: string[];
};

/**
 * dsh AgentOptions — model/provider vocabulary from dsh-agent (§4.2).
 */
export type DshAgentOptions = {
  provider?: string;
  model?: string;
  maxTokens?: number;
};

/**
 * dsh SubagentCapabilities — the provider's start-time feature flags
 * (`packages/subagent/subagent/src/types.ts:130-136`, dsh 0.1.5-rc.1).
 * dsh declares FIVE REQUIRED booleans — `agentOptions`, `outputSchema`,
 * `depthLimit`, `toolFilter`, `persona` — each corresponding one-to-one to a
 * `SubagentStartRequest` option that the service's `assertCapabilities`
 * truthy-checks before delegating to `start()`
 * (`packages/subagent/subagent/src/index.ts:641-657`). A start carrying an
 * option whose capability is falsy is rejected with `UNSUPPORTED_CAPABILITY`.
 * rolebox's provider honors only `agentOptions` (its `start()` forwards
 * `request.agentOptions` into the delegated start request), so it advertises
 * `agentOptions: true` and the remaining four as `false`.
 */
export type DshSubagentCapabilities = {
  agentOptions: boolean;
  outputSchema: boolean;
  depthLimit: boolean;
  toolFilter: boolean;
  persona: boolean;
};

/**
 * dsh SubagentStartRequest — the resolved request a provider's `start()`
 * receives (§4.3). Structural subset; rolebox touches `prompt`/`agentOptions`
 * and forwards the rest untouched.
 */
export type DshSubagentStartRequest = {
  label?: string;
  prompt: DshContentBlock[];
  parent: unknown;
  signal: AbortSignal;
  agentOptions?: DshAgentOptions;
  maxDepth?: number;
  toolFilter?: DshToolRestriction;
  persona?: unknown;
  /**
   * The detached durable child descriptor the dsh service resolves and stamps
   * onto the provider-facing request before dispatching to `start()`
   * (`ResolvedSubagentStartRequest = SubagentStartRequest & { descriptor }`,
   * `dsh-subagent/lib/types/types.d.ts:145-148`). OPTIONAL on this base type:
   * it is absent from the start requests rolebox composes itself
   * ({@link DshDispatchAdapter} — dsh, not rolebox, resolves the descriptor),
   * and present on the resolved request a provider's `start()` receives
   * ({@link DshResolvedSubagentStartRequest}). Typed `unknown` because rolebox
   * never reads it.
   */
  descriptor?: unknown;
  /**
   * rolebox extension (NOT part of the dsh vocabulary): the session id whose
   * active role applies to this spawn. Threaded by {@link DshDispatchAdapter}
   * from the parent/origin session; read by `buildProvider().start()` to
   * apply the per-session active role (see the module docstring). Absent on
   * requests dsh itself composes → base-agent behavior.
   */
  sessionId?: string;
};

/**
 * dsh `ResolvedSubagentStartRequest` — the provider-facing request a
 * `SubagentProvider.start()` receives AFTER the service resolves and stamps
 * the durable child descriptor
 * (`ResolvedSubagentStartRequest = SubagentStartRequest & { descriptor:
 * SubagentDescriptorData }` — `dsh-subagent/src/types.ts:207-210`, `:373`;
 * dsh 0.1.5-rc.1). The descriptor is REQUIRED here: the service resolves it
 * before dispatching to `start()`, so a session-backed provider can append it
 * inside the child's initial turn. rolebox forwards the request losslessly
 * (`{...request}`) and types the descriptor `unknown` because it never reads
 * it. The compile-time guard below fails the build if `descriptor` regresses
 * to optional.
 */
export type DshResolvedSubagentStartRequest = DshSubagentStartRequest & {
  descriptor: unknown;
};

/**
 * dsh `SubagentResult` — the terminal outcome a `SubagentRun.result` promise
 * resolves with (`dsh-subagent/lib/types/types.d.ts:204-223`):
 * `{ output, structured?, stopReason }` where stopReason ∈
 * `{ completed, aborted, error, 'max-tokens', refusal }`. Modelled so the
 * dispatch adapter reads `run.result` without a cast.
 */
export interface DshSubagentResult {
  /** The child agent's output ContentBlocks (§3.4). */
  output: DshContentBlock[];
  /** Optional structured output (from `SubagentStartRequest.outputSchema`). */
  structured?: unknown;
  /** Why the subagent run ended. */
  stopReason: "completed" | "aborted" | "error" | "max-tokens" | "refusal";
}

/**
 * dsh SubagentRun — the result object a provider's `start()` must return (§4.3).
 */
export type DshSubagentRun = {
  id: string;
  localAgent?: unknown;
  result: Promise<DshSubagentResult>;
  dispose(): Promise<void>;
};

/**
 * dsh `ContinuableCreateRequest` — what the continuation manager hands a
 * provider while materializing one continuable child's FIRST activation
 * (`packages/subagent/subagent/src/types.ts:219-229`, dsh 0.1.5-rc.1). The
 * manager has already reserved the durable child identity and owns every later
 * operation, so this carries only what distinguishes a fresh child from one
 * seeded with parent history: the reserved `sessionId` (for provider
 * diagnostics), the delegating `parent` (whose history a seeding provider
 * would read), and caller cancellation.
 *
 * rolebox reads NONE of these fields — its provider declares the FRESH-START
 * choice (see {@link DshSubagentProvider.prepareContinuable}) — but the shape
 * is mirrored so the provider's method signature matches dsh's exactly.
 */
export type DshContinuableCreateRequest = {
  /** The reserved durable child session id, for provider diagnostics. */
  readonly sessionId: string;
  /** The delegating parent agent whose history a seeding provider reads. */
  readonly parent: unknown;
  /** Caller cancellation, which owns preparation only until inbox acceptance. */
  readonly signal: AbortSignal;
};

/**
 * dsh `ContinuableCreateSpec` — a provider's detached contribution to one
 * continuable child's creation (`packages/subagent/subagent/src/types.ts:
 * 237-244`, dsh 0.1.5-rc.1). This is DATA, never a capability: it carries no
 * Agent, handle, prompt delivery, result, or disposal, because the continuation
 * manager owns the child's whole lifecycle after preparation.
 *
 * The ONLY field is `seed` — the completed-turn prefix of the parent's log to
 * seed the child session with. It is OPTIONAL and its ABSENCE is exactly the
 * FRESH-START declaration: `continuation.ts:144-145` reads `prepared.seed`
 * (`undefined` → no inherited events, `childSessionMeta(..., false)`), while a
 * present array is persisted through the child's `create.seed`. rolebox
 * deliberately omits it, matching its `inheritsParentContext: false` stance.
 * The `SessionEvent[]` element type is mirrored loosely (`unknown[]`) because
 * rolebox never constructs one — it only ever returns the absent field — and
 * this adapter stays free of any dsh package import.
 */
export type DshContinuableCreateSpec = {
  /** Completed-turn prefix of the parent's log, or absent for a fresh child. */
  readonly seed?: readonly unknown[];
};

// ── Compile-time contract guard ──────────────────────────────────────
// Erased at emit. Fails `bun run typecheck` when a mirrored surface regresses:
//   - `result` → `Promise<unknown>` (which would reintroduce the
//     dispatch-side cast);
//   - the provider-facing `descriptor` → optional (which would admit a start
//     request without the service-resolved descriptor the dsh service
//     guarantees before dispatching to `start()`);
//   - `seed` → required on the continuable spec (which would make the
//     fresh-start choice inexpressible, since dsh treats ABSENCE as fresh);
//   - `sessionId`/`parent`/`signal` → optional on the continuable request
//     (which would drift from the manager-supplied creation inputs).
type _AssertTrue<T extends true> = T;
type _DshSubagentRunResultGuard = _AssertTrue<
  DshSubagentRun["result"] extends Promise<DshSubagentResult> ? true : false
>;
type _DshResolvedStartDescriptorRequiredGuard = _AssertTrue<
  {} extends Pick<DshResolvedSubagentStartRequest, "descriptor"> ? false : true
>;
type _DshContinuableFreshStartGuard = _AssertTrue<
  {} extends DshContinuableCreateSpec ? true : false
>;
type _DshContinuableRequestFieldsRequiredGuard = _AssertTrue<
  Pick<DshContinuableCreateRequest, "sessionId" | "parent" | "signal"> extends {
    readonly sessionId: string;
    readonly parent: unknown;
    readonly signal: AbortSignal;
  }
    ? true
    : false
>;

/**
 * dsh SubagentProvider — the catalog entry shape registered into
 * `ctx.subagents` (§4.3, `dsh-subagent/lib/types/types.d.ts:268-307`).
 */
export type DshSubagentProvider = {
  name: string;
  capabilities: DshSubagentCapabilities;
  inheritsParentContext: boolean;
  /**
   * dsh `SubagentProvider.agentRouteDefaults` — an optional static
   * provider/model route for one-shot Agent options
   * (`dsh-subagent/src/types.ts:355-361`, dsh 0.1.5-rc.1): detached immutable
   * data that consumers merge tool/model overrides over before preflight, and
   * whose presence requires `agentOptions` support. rolebox deliberately does
   * NOT set it — its route derives per-definition at spawn time via
   * {@link mergeAgentOptions} (the dynamic `providerRoutes` behavior), and
   * dsh's contract says a provider whose route derives from the parent omits
   * it.
   */
  agentRouteDefaults?: Readonly<{ provider: string; model: string }>;
  /**
   * Establish a ONE-SHOT child. The request is the RESOLVED form — the dsh
   * service has already validated the requested capabilities and stamped the
   * detached child descriptor, so a session-backed provider appends it inside
   * the child's initial turn.
   */
  start(request: DshResolvedSubagentStartRequest): Promise<DshSubagentRun>;
  /**
   * OPTIONAL (continuable-creation capability) — dsh's analogue of rolebox's
   * opencode `Task(task_id=…)` resumption. Method PRESENCE IS the capability:
   * the dsh service rejects a continuable start on a provider without it with
   * `UNSUPPORTED_CAPABILITY` (`packages/subagent/subagent/src/index.ts:593-606`,
   * `:598`), so a rolebox provider that implements it becomes eligible for
   * continuable children while still serving ordinary one-shot delegations.
   *
   * This is the provider's ONLY participation in a continuable child. The
   * continuation manager owns identity reservation, composition, Agent
   * creation, prompt delivery, cold resume, ownership, and disposal — the
   * provider never sees the child's Agent, handle, turns, or teardown, and
   * must NOT construct or touch the child itself. It contributes a detached
   * {@link DshContinuableCreateSpec} only.
   *
   * rolebox declares the FRESH-START choice (human decision Q1): the returned
   * spec OMITS `seed`, so the child session starts fresh rather than being
   * seeded with the parent's completed-turn history. This matches the
   * provider's `inheritsParentContext: false`. Implemented unconditionally in
   * {@link DshAgentRegistrar.buildProvider}.
   */
  prepareContinuable?(
    request: DshContinuableCreateRequest,
  ): Promise<DshContinuableCreateSpec>;
};

/**
 * dsh SubagentRuntime seam — the minimal `ctx.subagents` surface this
 * adapter depends on (§4.3,
 * `dsh-subagent/lib/types/index.d.ts:237,243,248,259` — registerProvider /
 * getProvider / list / start).
 * Consumed structurally so the real service can be injected in a dsh profile
 * and a fake double can be injected in tests.
 */
export type DshSubagentRuntime = {
  registerProvider(provider: DshSubagentProvider): () => void;
  getProvider(name: string): DshSubagentProvider | undefined;
  list(): string[];
};

/**
 * Spawn delegate invoked by a registered provider's `start()`.
 * A host supplies it via {@link DshAgentRegistrarOptions.onSpawn}; when absent,
 * `start()` delegates to the host provider named by
 * {@link DshAgentRegistrarOptions.spawnProviderName} (default `"spawn"`), and
 * only throws `DshSpawnNotWiredError` when that provider is not registered.
 */
export type DshSpawnDelegate = (
  definition: AgentDefinition,
  request: DshSubagentStartRequest,
) => Promise<DshSubagentRun>;

/**
 * Structural per-session active-role lookup consumed at spawn time.
 *
 * Deliberately a minimal structural subset (only `get`) of the switcher's
 * {@link ActiveRoleRef} — agent-registrar must NOT import from
 * role-switcher.ts (the switcher imports the registrar type, so a value-level
 * cycle would form). Any object with `get(sessionId): string | null`
 * satisfies it; `DshRoleSwitcher.activeRole` does, and so does a test double.
 */
export type DshActiveRoleLookup = {
  /** Return the active role id for a session, or `null` for the base agent. */
  get(sessionId: string): string | null;
};

/**
 * Spawn-time context provider — the dsh counterpart of the rolebox
 * `system-transform` hook (a documented no-op on dsh, hook-provider.ts:178).
 *
 * Given the spawn request's session id, return the rolebox context blocks
 * (available functions / memory / references — the "context injection" that
 * reaches a spawned agent on the non-dsh path) to prepend AHEAD of the
 * active role's prompt. `undefined` (or an empty array) → no context
 * injection, and the spawn stays unchanged. Wired by the dsh plugin with a
 * real implementation; tests inject a fake double.
 */
export type DshSpawnContextProvider = (
  sessionId: string,
) => DshContentBlock[] | undefined;

/**
 * Spawn-time probe for the dsh llm service's registered provider routes.
 *
 * Returns the route ids currently registered on `ctx.llm`
 * (`LlmRuntime.listProviders()` → `LlmProviderInfo.id`, the "Provider route key
 * used by `GenerateOptions.provider`" — `dsh-llm/lib/types/types.d.ts:131-138`,
 * `index.d.ts:234`). Wired by the dsh plugin from the mounted llm service;
 * absent when no `ctx.llm` service exists (headless/test doubles), in which
 * case the registrar emits the split unchanged. A throw is treated as "no
 * routes registered" so a probe failure degrades safely instead of failing the
 * spawn. Tests inject a fake.
 */
export type DshProviderRouteProbe = () => readonly string[];

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * Thrown by a registered provider's `start()` when neither an `onSpawn`
 * delegate is wired nor a host provider named by `spawnProviderName` is
 * registered. Registration/sync/list are unaffected — only actual spawning
 * fails, with a clear message naming the agent, the missing host provider, and
 * the currently registered provider names.
 */
export class DshSpawnNotWiredError extends Error {
  /** The agent id whose provider attempted to spawn. */
  readonly agentId: string;
  /** The host provider name delegation targeted (see `spawnProviderName`). */
  readonly hostName: string;

  constructor(agentId: string, hostName: string, registered: string[]) {
    const names = registered.length > 0 ? registered.join(", ") : "<none>";
    super(
      `dsh subagent spawn is not wired for '${agentId}': no host provider named '${hostName}' is registered in ctx.subagents (registered: ${names}). Pass an \`onSpawn\` delegate to DshAgentRegistrar, or set \`spawnProviderName\` to a registered provider name (default 'spawn').`,
    );
    this.name = "DshSpawnNotWiredError";
    this.agentId = agentId;
    this.hostName = hostName;
  }
}

/**
 * Thrown by a registered provider's `start()` when the configured
 * `spawnProviderName` collides with one of this registrar's own registered
 * agent ids. Delegating to that host provider would re-enter this same
 * `start()` (the provider is registered under the agent id), so the registrar
 * refuses before delegating rather than recursing.
 */
export class DshSpawnRecursionError extends Error {
  /** The agent id whose provider attempted to spawn. */
  readonly agentId: string;
  /** The colliding host provider name (also a registered agent id). */
  readonly hostName: string;

  constructor(agentId: string, hostName: string) {
    super(
      `dsh subagent spawn recursion refused for '${agentId}': the configured host provider name '${hostName}' collides with a rolebox agent id registered by this DshAgentRegistrar. Set \`spawnProviderName\` to a non-agent host provider (default 'spawn'), or pass an \`onSpawn\` delegate.`,
    );
    this.name = "DshSpawnRecursionError";
    this.agentId = agentId;
    this.hostName = hostName;
  }
}

// ── Translation helpers (AgentDefinition → dsh shapes) ─────────────────────

/**
 * Compare two agent definitions by value.
 * Uses JSON serialization for a simple deep equality check (matches the pi
 * adapter's convention; definitions are produced deterministically by rolebox).
 */
function definitionsEqual(a: AgentDefinition, b: AgentDefinition): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Prepend the definition's system prompt to a spawn request's prompt as a
 * text ContentBlock (`{type:'text', text}` per §3.4). Returns the original
 * array untouched when there is no system prompt.
 */
function prependSystemPrompt(
  definition: AgentDefinition,
  prompt: DshContentBlock[],
): DshContentBlock[] {
  if (!definition.systemPrompt) return prompt;
  return [{ type: "text", text: definition.systemPrompt }, ...prompt];
}

/**
 * Compose the final spawn prompt in the conventional order:
 *
 *   [injected context blocks?] → [active-role systemPrompt?] →
 *   [definition systemPrompt] → [...original request prompt blocks]
 *
 * The dsh/rolebox context injection LEADS (mirroring the non-dsh path where
 * the base/context comes first and the role prompt is layered after — see
 * the Pi adapter's `before_agent_start`: `current + role.systemPrompt`),
 * ahead of the active role's complete materialized prompt and the spawned
 * definition's own prompt. Any absent layer is skipped; the request's own
 * blocks are always preserved last.
 */
function composePrompt(
  context: DshContentBlock[] | undefined,
  active: AgentDefinition | undefined,
  prompt: DshContentBlock[],
): DshContentBlock[] {
  let out = active ? prependSystemPrompt(active, prompt) : prompt;
  if (context && context.length > 0) out = [...context, ...out];
  return out;
}

/**
 * Merge the definition's model override into the spawn request's agentOptions
 * (`AgentOptions`, §4.2). A resolved `"<provider>/<model-id>"` is split via the
 * shared {@link splitModel} helper and sets BOTH fields — `provider` and
 * `model` — so the spawn routes through the definition's provider instead of
 * inheriting the runtime default's route. A null split (bare name, `"default"`,
 * or malformed) keeps the legacy behavior: it overrides `model` only and
 * leaves the base `provider` untouched. The definition wins over the runtime
 * default; the base object is returned untouched when the definition has no
 * model.
 *
 * Provider-route safety path: when a {@link DshProviderRouteProbe} is supplied
 * and the split provider is NOT among the routes it reports, the provider is
 * dropped — ONE warning is logged and the result overrides `model` only,
 * leaving the base provider intact, so an unregistered route degrades to the
 * runtime default instead of failing the spawn with `NO_ADAPTER`. A probe throw
 * is treated as "no routes registered" (degrade). No probe → the split is
 * emitted unchanged.
 */
function mergeAgentOptions(
  definition: AgentDefinition,
  base: DshAgentOptions | undefined,
  providerRoutes?: DshProviderRouteProbe,
): DshAgentOptions | undefined {
  if (!definition.model) return base;
  const ref = splitModel(definition.model);
  if (!ref) return { ...(base ?? {}), model: definition.model };
  if (providerRoutes && !isRouteRegistered(providerRoutes, ref.provider)) {
    log.warn(
      `DshAgentRegistrar: provider route '${ref.provider}' for agent ` +
        `'${definition.id}' (model '${definition.model}') has no registered dsh ` +
        `llm adapter; degrading to model-only '${ref.id}' so the spawn inherits ` +
        `the runtime default provider instead of failing with NO_ADAPTER.`,
    );
    return { ...(base ?? {}), model: ref.id };
  }
  return { ...(base ?? {}), provider: ref.provider, model: ref.id };
}

/**
 * Query a {@link DshProviderRouteProbe} for a route, degrading to `false` on a
 * throw. A failing probe is treated as "route not registered" so the spawn
 * takes the safe model-only path rather than surfacing a probe error as a new
 * hard failure.
 */
function isRouteRegistered(
  probe: DshProviderRouteProbe,
  provider: string,
): boolean {
  try {
    return probe().includes(provider);
  } catch {
    return false;
  }
}

/**
 * Build the dsh SubagentCapabilities advertised by a rolebox provider.
 *
 * dsh 0.1.5-rc.1 requires FIVE booleans — `agentOptions`, `outputSchema`,
 * `depthLimit`, `toolFilter`, `persona`
 * (`packages/subagent/subagent/src/types.ts:130-136`) — and
 * `assertCapabilities` truthy-checks each matching request option before
 * delegating to `start()`
 * (`packages/subagent/subagent/src/index.ts:641-657`): a start carrying
 * `agentOptions` is REJECTED with `UNSUPPORTED_CAPABILITY` unless the provider
 * declares `agentOptions` truthy. rolebox's provider `start()` honors
 * `request.agentOptions` (it merges the definition's model override into it and
 * forwards it to the delegated start), so rolebox declares
 * `agentOptions: true`. It reads none of the other four request fields, so those
 * are advertised `false`.
 *
 * `AgentDefinition.maxSteps` and `.tools` are CATALOG configuration, not dsh
 * start-capabilities — they map to no request option this provider honors, so
 * they are deliberately not reflected here.
 */
function buildCapabilities(_definition: AgentDefinition): DshSubagentCapabilities {
  return {
    agentOptions: true,
    outputSchema: false,
    depthLimit: false,
    toolFilter: true,
    persona: false,
  };
}

// ── Adapter implementation ─────────────────────────────────────────────────

/** Options for constructing a DshAgentRegistrar. */
export interface DshAgentRegistrarOptions {
  /**
   * The dsh `ctx.subagents` seam (SubagentRuntime). Injected so the adapter
   * stays SDK-free; tests inject a fake double.
   */
  subagents: DshSubagentRuntime;
  /**
   * Optional spawn delegate invoked by registered providers' `start()`.
   * A host supplies it here (the dsh plugin threads its own `onSpawn` config
   * through — dsh-plugin.ts). When omitted, `start()` delegates to the host
   * provider named by {@link spawnProviderName} (default `"spawn"`); only when
   * that provider is not registered does `start()` throw
   * `DshSpawnNotWiredError`. Registration, sync, and listing remain fully
   * functional either way.
   */
  onSpawn?: DshSpawnDelegate;
  /**
   * Name of the already-registered dsh `ctx.subagents` provider that rolebox
   * delegates real spawning to when no `onSpawn` delegate is wired. Defaults
   * to `"spawn"` — the provider `@deepseek-ai/dsh-subagent-spawn-in-process`
   * registers under its default `providerName`. Point this at any other
   * registered provider (e.g. `"fork"`). A value colliding with a rolebox
   * agent id is refused at spawn time with `DshSpawnRecursionError`.
   */
  spawnProviderName?: string;
  /**
   * Optional per-session active-role lookup (the {@link DshRoleSwitcher}'s
   * shared `activeRole` holder). When present, a provider's `start()`
   * consults it with the request's `sessionId` and prepends the active
   * role's systemPrompt (applying its model override) — the seam that makes
   * a web-UI role switch reach the spawned agent. Absent → base behavior.
   */
  activeRole?: DshActiveRoleLookup;
  /**
   * Optional spawn-time context provider — the dsh counterpart of the
   * `system-transform` hook (a documented no-op on dsh). When present, a
   * provider's `start()` consults it with the request's `sessionId` and,
   * when an active role exists for that session, prepends the returned
   * rolebox context blocks ahead of the active role's complete materialized
   * prompt — so dsh's context injection reaches the spawned role. Absent →
   * no context injection (spawn unchanged).
   */
  contextProvider?: DshSpawnContextProvider;
  /**
   * Optional spawn-time probe for the dsh llm service's registered provider
   * routes (`ctx.llm.listProviders()`). When wired, a split definition model
   * whose provider has no registered adapter is logged once and degraded to a
   * model-only override (see the provider-route safety path in the module
   * docstring) instead of failing the spawn with `NO_ADAPTER`. Absent → the
   * split is emitted unchanged.
   */
  providerRoutes?: DshProviderRouteProbe;
}

/** Internal bookkeeping per registered agent. */
type Entry = {
  definition: AgentDefinition;
  provider: DshSubagentProvider;
  /** Disposer returned by `registerProvider` — the dsh platform artifact. */
  dispose: () => void;
};

/**
 * IAgentRegistrar implementation that translates rolebox AgentDefinitions
 * into dsh SubagentProvider registrations on `ctx.subagents`.
 *
 * All operations are idempotent:
 * - `register()` with an identical definition is a no-op; a changed definition
 *   disposes the previous registration before re-registering.
 * - `unregister()` of unknown ids is a no-op; known ids dispose their dsh
 *   registration (artifact cleanup) and are dropped from the local catalog.
 * - `sync()` diffs against the current catalog and applies only the delta.
 */
export class DshAgentRegistrar implements IAgentRegistrar {
  private readonly entries: Map<string, Entry> = new Map();
  private readonly subagents: DshSubagentRuntime;
  private readonly onSpawn?: DshSpawnDelegate;
  private readonly spawnProviderName?: string;
  private readonly activeRole?: DshActiveRoleLookup;
  private readonly contextProvider?: DshSpawnContextProvider;
  private readonly providerRoutes?: DshProviderRouteProbe;

  constructor(options: DshAgentRegistrarOptions) {
    this.subagents = options.subagents;
    this.onSpawn = options.onSpawn;
    this.spawnProviderName = options.spawnProviderName;
    this.activeRole = options.activeRole;
    this.contextProvider = options.contextProvider;
    this.providerRoutes = options.providerRoutes;
    if (!this.onSpawn) {
      // ONE-TIME diagnostic at registration time (NOT at first spawn): with no
      // delegate, spawning targets the host provider named by
      // `spawnProviderName`. This is informational, not a failure claim —
      // providers can register before that host provider row has applied, and
      // the loud failure is deferred to spawn time (DshSpawnNotWiredError).
      const hostName = this.spawnProviderName ?? "spawn";
      log.info(
        `DshAgentRegistrar: no onSpawn delegate wired; spawn delegation will ` +
          `target the '${hostName}' host provider registered in ctx.subagents.`,
      );
    }
  }

  // ── IAgentRegistrar implementation ───────────────────────────────────────

  /**
   * Register (or update) a batch of agent definitions.
   *
   * Idempotent: registering an identical definition is a no-op. Registering a
   * changed definition for an existing id disposes the previous dsh
   * registration first, so the dsh registry never holds duplicates.
   *
   * @param agentDefs - Agent definitions to register.
   */
  async register(agentDefs: AgentDefinition[]): Promise<void> {
    for (const def of agentDefs) {
      const existing = this.entries.get(def.id);
      if (existing && definitionsEqual(existing.definition, def)) {
        continue; // identical definition — no-op
      }
      if (existing) {
        existing.dispose(); // replace: clean up the stale dsh registration
      }
      const provider = this.buildProvider(def);
      const dispose = this.subagents.registerProvider(provider);
      this.entries.set(def.id, { definition: def, provider, dispose });
    }
  }

  /**
   * Unregister agents by their IDs.
   *
   * Disposes each dsh registration (removing the provider from the dsh
   * registry) and drops the local catalog entry. Silently skips ids that are
   * not currently registered.
   *
   * @param agentIds - IDs of agents to unregister.
   */
  async unregister(agentIds: string[]): Promise<void> {
    for (const id of agentIds) {
      const entry = this.entries.get(id);
      if (!entry) continue; // idempotent no-op for unknown ids
      entry.dispose();
      this.entries.delete(id);
    }
  }

  /**
   * Sync the catalog with a new complete set of agent definitions.
   *
   * Computes the diff against the current catalog:
   * - **added**: ids that are new, or whose definition changed (re-registered
   *   after disposing the stale dsh registration)
   * - **removed**: ids in the current catalog absent from the new set
   *   (disposed)
   * - **unchanged**: ids present in both with identical definitions (untouched)
   *
   * @param agentDefs - The complete new set of agent definitions.
   * @returns A diff summary with added, removed, and unchanged IDs.
   */
  async sync(
    agentDefs: AgentDefinition[],
  ): Promise<{ added: string[]; removed: string[]; unchanged: string[] }> {
    const newIds = new Set(agentDefs.map((def) => def.id));
    const newDefs = new Map(agentDefs.map((def) => [def.id, def]));

    const added: string[] = [];
    const removed: string[] = [];
    const unchanged: string[] = [];

    // Diff existing catalog entries against the new set.
    for (const [id, entry] of this.entries) {
      if (!newIds.has(id)) {
        removed.push(id);
      } else if (definitionsEqual(entry.definition, newDefs.get(id)!)) {
        unchanged.push(id);
      } else {
        added.push(id);
      }
    }

    // Brand-new ids (not present in the current catalog at all).
    for (const def of agentDefs) {
      if (!this.entries.has(def.id)) {
        added.push(def.id);
      }
    }

    // Apply removals.
    for (const id of removed) {
      const entry = this.entries.get(id);
      if (entry) {
        entry.dispose();
        this.entries.delete(id);
      }
    }

    // Apply additions (new or changed) — dispose the stale registration for
    // changed ids before re-registering.
    for (const id of added) {
      const def = newDefs.get(id)!;
      const existing = this.entries.get(id);
      if (existing) existing.dispose();
      const provider = this.buildProvider(def);
      const dispose = this.subagents.registerProvider(provider);
      this.entries.set(id, { definition: def, provider, dispose });
    }

    return { added, removed, unchanged };
  }

  /**
   * List currently registered agent IDs (the provider names registered into
   * the dsh subagent catalog).
   *
   * @returns A sorted array of registered agent IDs.
   */
  async list(): Promise<string[]> {
    return [...this.entries.keys()].sort();
  }

  // ── Additional accessor (not part of IAgentRegistrar) ────────────────────

  /**
   * Retrieve all currently registered agent definitions from the internal
   * catalog, sorted by agent id.
   *
   * Mirrors `PiAgentRegistrar.getRegisteredAgents()`: an extra accessor (the
   * `IAgentRegistrar` port only exposes id listing) for consumers that need
   * the resolved definitions — e.g. a role-switcher reading the current
   * catalog. The returned objects are the definitions stored at registration
   * time; registration, sync, and unregister semantics are unaffected.
   *
   * @returns An array of all currently registered AgentDefinitions, sorted
   *          by id.
   */
  getRegisteredAgents(): AgentDefinition[] {
    return [...this.entries.keys()]
      .sort()
      .map((id) => this.entries.get(id)!.definition);
  }

  // ── Translation helper (exposed for the spawn layer and tests) ───────────

  /**
   * Translate an AgentDefinition into a dsh SubagentProvider.
   *
   * The provider's `start()` prepends the definition's system prompt to the
   * request prompt (§3.4), merges the definition's model into
   * `agentOptions.provider` + `agentOptions.model` (§4.2; split via the shared
   * `splitModel` helper), and — when the request carries a sessionId
   * and the registrar holds an activeRole lookup — additionally prepends the
   * ACTIVE role's system prompt and applies its model override (the
   * per-session role-switch seam; see the module docstring). A split provider
   * with no registered dsh llm adapter degrades to a model-only override with
   * ONE warning when a `providerRoutes` probe is wired (the provider-route
   * safety path; see {@link mergeAgentOptions}). It then delegates
   * in order: the configured `onSpawn` hook when wired, otherwise the host
   * provider named by `spawnProviderName` (default `"spawn"`). It throws
   * `DshSpawnRecursionError` when that name collides with a registered agent
   * id, and `DshSpawnNotWiredError` when no such host provider is registered.
   *
   * @param definition - The rolebox agent definition to translate.
   * @returns A SubagentProvider ready for `ctx.subagents.registerProvider`.
   */
  readonly buildProvider = (definition: AgentDefinition): DshSubagentProvider => {
    const capabilities = buildCapabilities(definition);
    return {
      name: definition.id,
      capabilities,
      inheritsParentContext: false,
      start: async (request: DshResolvedSubagentStartRequest): Promise<DshSubagentRun> => {
        const prompt = prependSystemPrompt(definition, request.prompt);
        const agentOptions = mergeAgentOptions(
          definition,
          request.agentOptions,
          this.providerRoutes,
        );
        // Per-session active-role seam: prepend the active role's prompt and
        // apply its model override when one is active for the request's
        // session. `mode` is a catalog-level classification with no
        // spawn-time dsh mapping (AgentOptions = provider/model/maxTokens),
        // so it is not applied here.
        const active = this.resolveActiveOverride(request.sessionId, definition.id);
        // dsh context injection seam: when the session has an active role,
        // the rolebox context block (the output the `system-transform` hook
        // would have produced — a documented no-op on dsh via
        // hook-provider.ts:178) is prepended AHEAD of the active role's
        // complete materialized prompt, so the spawned agent's effective
        // prompt carries BOTH the injected context and the role prompt.
        const context = this.resolveSpawnContext(request.sessionId);
        const startRequest: DshResolvedSubagentStartRequest = {
          ...request,
          prompt: composePrompt(context, active, prompt),
          agentOptions: active
            ? mergeAgentOptions(active, agentOptions, this.providerRoutes)
            : agentOptions,
        };
        if (this.onSpawn) {
          return this.onSpawn(definition, startRequest);
        }
        // Host-provider delegation: forward the RESOLVED start request to an
        // already-registered dsh provider (default `spawn`) so the child keeps
        // this role's descriptor/provider identity and no second
        // subagent/start pair is emitted. A name colliding with a registered
        // agent id would re-enter this same start() — refuse instead.
        const hostName = this.spawnProviderName ?? "spawn";
        if (this.entries.has(hostName)) {
          throw new DshSpawnRecursionError(definition.id, hostName);
        }
        const host = this.subagents.getProvider(hostName);
        if (!host) {
          throw new DshSpawnNotWiredError(
            definition.id,
            hostName,
            this.subagents.list(),
          );
        }
        return host.start(startRequest);
      },
      // Continuable-creation capability (dsh's analogue of opencode
      // `Task(task_id=…)` resumption). Method presence is the capability the
      // dsh service checks before reserving any child resources
      // (`packages/subagent/subagent/src/index.ts:593-606`); a provider that
      // omits it is rejected there with `UNSUPPORTED_CAPABILITY`.
      //
      // FRESH-START declaration (human decision Q1): this returns a spec with
      // NO `seed`, so the continuation manager materializes the child session
      // fresh — the child is NOT seeded with the parent's completed-turn
      // history (`packages/subagent/subagent/src/types.ts:237-244`; the
      // manager reads `prepared.seed` at `continuation.ts:144-145`). This is
      // the spec's only field and its absence is exactly the fresh-start
      // signal, consistent with this provider's `inheritsParentContext: false`.
      //
      // The provider deliberately touches NONE of `request` (sessionId/parent/
      // signal): the continuation manager owns the child's identity,
      // composition, prompt delivery, cold resume, ownership, and disposal, so
      // the provider must not construct or touch the child Agent.
      prepareContinuable: async (
        _request: DshContinuableCreateRequest,
      ): Promise<DshContinuableCreateSpec> => ({}),
    };
  };

  /**
   * Resolve the active-role override for a spawn request, or `undefined`.
   *
   * Returns the active role's AgentDefinition when ALL of these hold:
   *   - the request carries a `sessionId` and the registrar holds an
   *     `activeRole` lookup
   *   - that session has an active role id
   *   - the id resolves to a registered definition OTHER than the spawned
   *     one (spawning the active role's own definition already carries its
   *     system prompt — a redundant prepend would duplicate it)
   *
   * Otherwise `undefined` → base behavior (definition's own prompt/model).
   */
  private resolveActiveOverride(
    sessionId: string | undefined,
    spawnedId: string,
  ): AgentDefinition | undefined {
    if (!sessionId || !this.activeRole) return undefined;
    const activeId = this.activeRole.get(sessionId);
    if (!activeId || activeId === spawnedId) return undefined;
    return this.entries.get(activeId)?.definition;
  }

  /**
   * Resolve the spawn-time context blocks for a request, or `undefined`.
   *
   * The context flows ONLY when an active role exists for the session (the
   * reported bug: after a web-UI role switch, dsh's context injection never
   * reached the role) — no active role (or no provider wired) leaves the
   * spawn unchanged. Note this deliberately does NOT skip the active role's
   * own definition spawn: its context still applies even when the redundant
   * prompt prepend is skipped by {@link resolveActiveOverride}.
   */
  private resolveSpawnContext(
    sessionId: string | undefined,
  ): DshContentBlock[] | undefined {
    if (!sessionId || !this.activeRole) return undefined;
    const activeId = this.activeRole.get(sessionId);
    if (!activeId) return undefined;
    return this.contextProvider?.(sessionId);
  }
}
