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
 *   - `model`        → merged into the spawn request's `agentOptions.model`
 *                      (dsh-agent `AgentOptions` = `{provider?, model?, maxTokens?}`, §4.2)
 *   - `tools`        → `capabilities.toolFilter` (`{allow, deny}` restriction,
 *                      the `SubagentStartRequest.toolFilter` vocabulary, §4.3)
 *   - `maxSteps`     → `capabilities.depthLimit` (start-time feature, §4.3)
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
 * spawning is delegated to an optional `onSpawn` hook (to be provided by a
 * spawn-provider adapter); without one, a provider's `start()` throws
 * `DshSpawnNotWiredError` while registration/sync still work fully.
 *
 * @module
 */

import type { IAgentRegistrar } from "../../ports/agent-registrar.ts";
import type { AgentDefinition } from "../../types.ts";

// ── Structural dsh types (docs/dsh-plugin-contract.md §3.4, §4.2, §4.3) ────

/**
 * dsh ContentBlock — text block shape from dsh-llm (§3.4).
 * Structural subset; extra fields are preserved.
 */
export type DshContentBlock = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

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
 * dsh SubagentCapabilities — start-time provider features (§4.3).
 * Only the fields rolebox can map from AgentDefinition are modeled; the real
 * type is open and accepts additional fields.
 */
export type DshSubagentCapabilities = {
  depthLimit?: number;
  toolFilter?: DshToolRestriction;
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
};

/**
 * dsh SubagentRun — the result object a provider's `start()` must return (§4.3).
 */
export type DshSubagentRun = {
  id: string;
  localAgent?: unknown;
  result: Promise<unknown>;
  dispose(): Promise<void>;
};

/**
 * dsh SubagentProvider — the catalog entry shape registered into
 * `ctx.subagents` (§4.3, `dsh-subagent/lib/types/types.d.ts:268-287`).
 */
export type DshSubagentProvider = {
  name: string;
  capabilities: DshSubagentCapabilities;
  inheritsParentContext: boolean;
  start(request: DshSubagentStartRequest): Promise<DshSubagentRun>;
};

/**
 * dsh SubagentRuntime seam — the minimal `ctx.subagents` surface this
 * adapter depends on (§4.3, `dsh-subagent/lib/types/index.d.ts:237,243,250`).
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
 * Wired by a future spawn-provider adapter; without it `start()` throws.
 */
export type DshSpawnDelegate = (
  definition: AgentDefinition,
  request: DshSubagentStartRequest,
) => Promise<DshSubagentRun>;

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * Thrown by a registered provider's `start()` when no `onSpawn` delegate is
 * wired. Registration/sync/list are unaffected — only actual spawning fails,
 * with a clear message naming the agent.
 */
export class DshSpawnNotWiredError extends Error {
  /** The agent id whose provider attempted to spawn. */
  readonly agentId: string;

  constructor(agentId: string) {
    super(
      `dsh subagent spawn is not wired for '${agentId}': pass an \`onSpawn\` delegate to DshAgentRegistrar (a spawn-provider adapter will supply this in a full dsh profile)`,
    );
    this.name = "DshSpawnNotWiredError";
    this.agentId = agentId;
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
 * Merge the definition's model override into the spawn request's agentOptions
 * (`AgentOptions.model`, §4.2). The definition wins over the runtime default;
 * the base object is returned untouched when the definition has no model.
 */
function mergeAgentOptions(
  definition: AgentDefinition,
  base: DshAgentOptions | undefined,
): DshAgentOptions | undefined {
  if (!definition.model) return base;
  return { ...(base ?? {}), model: definition.model };
}

/**
 * Map `AgentDefinition.tools` to a dsh ToolRestriction. Copies the arrays so
 * later mutation of the definition cannot alias into the provider. Returns
 * `undefined` when there is nothing to restrict.
 */
function buildToolFilter(
  tools: AgentDefinition["tools"],
): DshToolRestriction | undefined {
  if (!tools) return undefined;
  const filter: DshToolRestriction = {};
  if (tools.allow) filter.allow = [...tools.allow];
  if (tools.deny) filter.deny = [...tools.deny];
  return filter.allow || filter.deny ? filter : undefined;
}

/**
 * Map an AgentDefinition to its dsh SubagentCapabilities: `maxSteps` becomes
 * `depthLimit`, `tools` becomes `toolFilter` (§4.3).
 */
function buildCapabilities(definition: AgentDefinition): DshSubagentCapabilities {
  const capabilities: DshSubagentCapabilities = {};
  if (definition.maxSteps !== undefined) {
    capabilities.depthLimit = definition.maxSteps;
  }
  const toolFilter = buildToolFilter(definition.tools);
  if (toolFilter) capabilities.toolFilter = toolFilter;
  return capabilities;
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
   * When omitted, `start()` throws `DshSpawnNotWiredError` — registration,
   * sync, and listing remain fully functional.
   */
  onSpawn?: DshSpawnDelegate;
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

  constructor(options: DshAgentRegistrarOptions) {
    this.subagents = options.subagents;
    this.onSpawn = options.onSpawn;
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

  // ── Translation helper (exposed for the spawn layer and tests) ───────────

  /**
   * Translate an AgentDefinition into a dsh SubagentProvider.
   *
   * The provider's `start()` prepends the definition's system prompt to the
   * request prompt (§3.4), merges the definition's model into
   * `agentOptions.model` (§4.2), and delegates to the configured `onSpawn`
   * hook — or throws `DshSpawnNotWiredError` when no hook is wired.
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
      start: async (request: DshSubagentStartRequest): Promise<DshSubagentRun> => {
        const prompt = prependSystemPrompt(definition, request.prompt);
        const agentOptions = mergeAgentOptions(definition, request.agentOptions);
        const startRequest: DshSubagentStartRequest = {
          ...request,
          prompt,
          agentOptions,
        };
        if (this.onSpawn) {
          return this.onSpawn(definition, startRequest);
        }
        throw new DshSpawnNotWiredError(definition.id);
      },
    };
  };
}
