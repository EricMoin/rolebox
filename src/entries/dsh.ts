/**
 * dsh (DeepSeek Harness) cordis plugin entry point — `src/dsh-plugin.ts`
 *
 * Exports a cordis plugin per the conventions verified in
 * `docs/dsh-plugin-contract.md` against the dsh 0.1.5-rc.1 source checkout
 * (`@deepseek-ai/cordis@4.0.2`, `@deepseek-ai/dsh-tools@0.1.5-rc.1`, ...):
 *
 *   - `name`    — `'rolebox'`
 *   - `inject`  — the dsh services rolebox's adapters consume: `tools`
 *                 (tool registration, §3.1), `sessions` (session lifecycle,
 *                 §4.1), `subagents` (agent catalog, §4.3). The live-agent
 *                 `agents` service (§4.2) is deliberately NOT in the `inject`
 *                 roster: `DshAgentRegistrar` manages the *catalog* of
 *                 spawnable definitions through `ctx.subagents` and explicitly
 *                 keeps the `ctx.agents` AgentRegistry side out of the catalog
 *                 seam (see `src/platform/adapters/dsh/agent-registrar.ts`
 *                 module docstring). It is instead probed OPTIONALLY
 *                 ({@link probeAgentRegistry}) as the graph-notify injection
 *                 seam — the dsh host's per-session message-injection surface
 *                 — so graph `<system-reminder>` reminders reach the
 *                 orchestrator. Injecting it in the roster would gate plugin
 *                 activation on it; probing it lets minimal/headless profiles
 *                 boot with graph-notify degraded instead.
 *   - `Config`  — a StandardSchemaV1 config schema (contract §2.4)
 *   - `apply(ctx, config)` — bootstrap + wire the dsh adapters
 *
 * ── Config mechanism (contract §2.4) ──────────────────────────────────────
 * The contract verified that cordis 4.0.1's `Config` field is typed
 * `StandardSchemaV1<any, T>` and that schemas implementing the standard
 * `'~standard'` interface work directly as a plugin Config (defaults applied,
 * invalid values rejected). The dsh packages use the
 * `@deepseek-ai/schemastery` fork as their schema DSL; this repo does not
 * depend on that fork (or any `@deepseek-ai/*` package — the adapters are
 * deliberately SDK-free, structural). zod v4 — already a rolebox dependency —
 * implements the same `StandardSchemaV1` interface (`~standard`), which is the
 * exact mechanism the contract verified. So `Config` below is a zod schema:
 * identical mechanism, no new dependency. `live:` verified on zod@4.1.8:
 * `schema['~standard'].validate({})` → `{value:{...defaults}}` and invalid
 * input → `{issues:[...]}`.
 *
 * ── Tool registration ─────────────────────────────────────────────────────
 * `DshToolFactory.compileAll(buildCanonicalTools(...))` produces objects
 * structurally matching the verified `ToolDefinition` register input
 * (`DshToolDefinition` — name/description/parameters/output/execute,
 * contract §3.2); `ctx.tools.register(def)` consumes them (§3.1). The real
 * dsh registry stores the definition raw (no `defineTool()` compile step);
 * the structural contract is identical, so direct registration is safe.
 *
 * MUST NOT import `@opencode-ai/plugin` (or any platform SDK).
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { resolveRoleboxDirectories, initializeRoleboxRuntime } from "../platform/factory.ts";
import type {
  RoleboxDirectories,
  InitializeRuntimeOptions,
} from "../platform/factory.ts";
import { DshAgentRegistrar } from "../platform/adapters/dsh/agent-registrar.ts";
import type {
  DshProviderRouteProbe,
  DshSpawnContextProvider,
  DshSpawnDelegate,
  DshSubagentProvider,
} from "../platform/adapters/dsh/agent-registrar.ts";
import { DshDispatchAdapter } from "../platform/adapters/dsh/dispatch.ts";
import type { DshSubagentDispatchRuntime } from "../platform/adapters/dsh/dispatch.ts";
import { DshToolFactory } from "../platform/adapters/dsh/tool-factory.ts";
import type { DshToolDefinition } from "../platform/adapters/dsh/tool-factory.ts";
import { DshSessionAdapter } from "../platform/adapters/dsh/session.ts";
import type {
  DshPromptInjector,
  DshSessionStoreLike,
} from "../platform/adapters/dsh/session.ts";
import { DshHookProvider } from "../platform/adapters/dsh/hook-provider.ts";
import { DshRoleSwitcher, createActiveRoleRef } from "../platform/adapters/dsh/role-switcher.ts";
import { ActiveRoleStore } from "../platform/adapters/dsh/active-role-store.ts";
import { DshSystemPromptAdapter } from "../platform/adapters/dsh/system-prompt.ts";
import type { DshSystemPromptRegistry } from "../platform/adapters/dsh/system-prompt.ts";
import {
  createDshSkillProviderFactory,
  ROLEBOX_SKILL_PROVIDER,
} from "../platform/adapters/dsh/skill-provider.ts";
import type {
  DshSkillProvider,
  DshSkillProviderControl,
  DshSkillProviderLike,
} from "../platform/adapters/dsh/skill-provider.ts";
import {
  DshRoleSwitchWebRoute,
  ROLE_SWITCH_ROUTE_PREFIX,
} from "../platform/adapters/dsh/web-role-switch-route.ts";
import type { DshWebServerRouteRegistrar } from "../platform/adapters/dsh/web-role-switch-route.ts";
import { DshRoleboxMonitorWebRoute } from "../platform/adapters/dsh/web-rolebox-monitor-route.ts";
import { watchRoleboxState } from "../platform/adapters/dsh/watch-rolebox-state.ts";
import { DshRoleboxReloader } from "../platform/adapters/dsh/rolebox-reload.ts";
import {
  buildCanonicalTools,
  buildRoleSnapshotTools,
  ROLE_SNAPSHOT_TOOL_KEYS,
} from "../platform/tool-assembly.ts";
import { dshCapabilities } from "../platform/capabilities.ts";
import { buildAvailableFunctionsBlock } from "../prompt/builder.ts";
import { ProcessFatalReporter } from "../core/process-fatal-reporter.ts";
import {
  createGraphToolSet,
  createOutcomeGraphTools,
} from "../graph/tools/index.ts";
import { OutcomeHost, withCancelDelivery } from "../graph/host/outcome-host.ts";
import { graphStoreRoot } from "../graph/store/schema.ts";
import { getDataDir } from "../cli/paths.ts";
import {
  DshOutcomeDelivery,
  type DshOutcomeSubagentRuntime,
} from "../platform/adapters/dsh/outcome-dispatch.ts";
import { createValidatorRegistry } from "../graph/outcome/validators.ts";
import { LoopCoordinator } from "../loop/coordinator.ts";
import { LoopStore } from "../loop/loop-store.ts";
import { createLoopTools } from "../loop/loop-tools.ts";
import { applyProjectConfig } from "../project-config.ts";
import { createSubLogger } from "../logger.ts";
import { roleFunctionsMap } from "../resolver/registry.ts";
import type { ResolvedRole } from "../types.ts";

// ── Plugin metadata ────────────────────────────────────────────────────────

/** Plugin name — the cordis fiber/logger label (contract §2.2). */
export const name = "rolebox";

/**
 * dsh services this plugin waits for (contract §2.2 `inject`).
 * `tools` / `sessions` / `subagents` are the services rolebox's dsh adapters
 * consume; see the module docstring for why the live-agent `agents` service is
 * probed optionally (graph-notify) rather than injected.
 */
export const inject: string[] = ["tools", "sessions", "subagents"];

// ── Config (StandardSchemaV1, contract §2.4) ───────────────────────────────

/**
 * Plugin config schema — a zod v4 schema implementing the StandardSchemaV1
 * interface cordis 4.0.1 requires for `Config` (see module docstring).
 *
 * All options are optional:
 *   - `roleboxDir`        — override the rolebox directory (default:
 *                           `{cwd}/rolebox` if present, else `{dsh home}/rolebox`)
 *   - `skillsDir`         — override the global skills directory (default:
 *                           `{dsh home}/skills`)
 *   - `defaultRole`       — role id (directory name) promoted to primary
 *   - `enabledNamespaces` — allow-list of tool names / name-space prefixes;
 *                           `"*"` or absent registers every assembled tool
 *   - `onSpawn`           — programmatic spawn delegate (a host seam, NOT
 *                           representable in YAML); when supplied, registered
 *                           providers delegate to it. When omitted, they fall
 *                           back to the host provider named by
 *                           `spawnProviderName` (default `"spawn"`); only when
 *                           that provider is unregistered do they reject with
 *                           `DshSpawnNotWiredError`
 *   - `spawnProviderName` — YAML-representable name of the `ctx.subagents`
 *                           provider rolebox delegates real spawning to when
 *                           `onSpawn` is absent (default `"spawn"`)
 *
 * There is deliberately no web-server config: the role-switch UI now mounts
 * on dsh's own host webserver via the optional `webServer` service seam (see
 * {@link probeWebServer}) and the `dsh.client` slot plugin — no bind host or
 * port belongs on this plugin.
 */
export const Config = z.object({
  roleboxDir: z
    .string()
    .optional()
    .describe("Absolute path to the directory containing role.yaml files"),
  skillsDir: z
    .string()
    .optional()
    .describe("Absolute path to the global skills directory"),
  defaultRole: z
    .string()
    .optional()
    .describe("Role id (directory name) to promote to primary"),
  enabledNamespaces: z
    .array(z.string())
    .optional()
    .describe("Tool name / namespace-prefix allow-list; '*' registers all"),
  onSpawn: z
    .custom<DshSpawnDelegate>(
      (value) => typeof value === "function",
      "onSpawn must be a function (DshSpawnDelegate)",
    )
    .optional()
    .describe(
      "Programmatic host seam (not representable in YAML): spawn delegate invoked by registered providers' start(). Omitted → start() delegates to the host provider named by spawnProviderName (default 'spawn'); only when that provider is unregistered does it reject DshSpawnNotWiredError.",
    ),
  spawnProviderName: z
    .string()
    .optional()
    .describe(
      "Name of the ctx.subagents provider rolebox delegates real spawning to when no onSpawn delegate is wired (default 'spawn', as registered by @deepseek-ai/dsh-subagent-spawn-in-process). A value colliding with a rolebox agent id is refused at spawn time.",
    ),
});

/** Inferred config type — the object passed to `apply(ctx, config)`. */
export type DshPluginConfig = z.infer<typeof Config>;

// ── Structural cordis ctx surface ──────────────────────────────────────────

/** The dsh tool registry seam this plugin consumes (contract §3.1). */
export interface DshToolsRegistry {
  /**
   * Register a tool definition. Returns the disposer that removes it.
   * @param definition - A compiled tool definition (DshToolDefinition).
   */
  register(definition: DshToolDefinition): () => void;
}

/**
 * Minimal structural surface of the cordis `Context` this plugin consumes.
 * Mirrors the documented cordis context (§2.5 — property reads resolve
 * services, `on` subscribes to events) plus the three injected dsh services.
 * The real dsh host supplies the full Context; tests inject a fake double.
 */
export interface DshPluginContext {
  /** dsh tools service (`ToolRuntime`, contract §3.1). */
  tools: DshToolsRegistry;
  /** dsh session service (`SessionStore`, contract §4.1). */
  sessions: DshSessionStoreLike;
  /**
   * dsh subagent service (`SubagentRuntime`, contract §4.3). Typed as the
   * dispatch superset (adds `start`) because this plugin both syncs agents
   * into the catalog (via {@link DshAgentRegistrar}) and dispatches graph
   * nodes / loop rounds through `ctx.subagents.start` (via
   * {@link DshDispatchAdapter}).
   *
   * `listChildren` is OPTIONAL ON THIS MIRROR because it is one consumer's
   * optional capability, not part of the dispatch contract: the outcome run
   * path's execution query correlates a dispatch effect with the subagent run
   * it created through the run's durable label, and a dsh build (or a test
   * double) without the listing is answered `unknown` rather than failing to
   * load. The base profile's `SubagentRuntime` provides it
   * (`docs/dsh-plugin-contract.md` §4.3).
   */
  subagents: DshOutcomeSubagentRuntime;
  /**
   * The dsh system-prompt registry service (`@deepseek-ai/dsh-system-prompt`,
   * structural subset — see {@link DshSystemPromptRegistry}). Present only in
   * full profiles; headless profiles have no model-facing prompt assembly, so
   * the property is absent and the plugin degrades gracefully (see
   * {@link probeSystemPrompt}). Never injected via the `inject` roster — an
   * optional service must not gate plugin activation.
   */
  systemPrompt?: unknown;
  /**
   * The dsh live-agent registry service (`@deepseek-ai/dsh-agent` `AgentRegistry`,
   * structural subset — see {@link DshAgentRegistryLike}). Present only in full
   * profiles where the agent-loop bundle rows are mounted; headless / minimal
   * profiles have no live agent registry, so the property is absent and graph
   * notify degrades gracefully (see {@link probeAgentRegistry}). Never
   * injected via the `inject` roster — an optional service must not gate plugin
   * activation.
   */
  agents?: unknown;
  /**
   * The dsh llm service (`@deepseek-ai/dsh-llm` `LlmRuntime`, structural subset
   * — see {@link DshLlmRuntimeLike}). Always mounted in a full profile; probed
   * optionally by {@link probeLlmRoutes} so the agent registrar can degrade a
   * split model whose provider route has no registered adapter to a model-only
   * override instead of failing the spawn with `NO_ADAPTER`. Never injected via
   * the `inject` roster — an optional service must not gate plugin activation.
   */
  llm?: unknown;
  /**
   * The dsh skill-registry service (`@deepseek-ai/dsh-skill` `ctx.skills`,
   * structural subset — see {@link DshSkillRegistryLike}). Present whenever the
   * profile mounts the `dsh-skill` registry row that resolves model- and
   * user-facing skills; headless / minimal profiles without it have the
   * property absent and rolebox's lazy skill provider is simply not registered
   * (see {@link probeSkillRegistry}). Never injected via the `inject` roster —
   * an optional service must not gate plugin activation.
   */
  skills?: unknown;
  /**
   * Resolve a cordis service by name (optional-service seam). The dsh host
   * context resolves any registered service; this plugin probes for
   * `"webServer"` (present only when the web profile is active) and skips
   * gracefully when it is absent — headless profiles have no web server.
   */
  get(name: string): unknown;
  /** Subscribe to a cordis/dsh event (contract §2.5). */
  on(event: string, listener: (...args: unknown[]) => void): (() => void) | void;
  /** Emit a cordis/dsh event. */
  emit(event: string, ...args: unknown[]): void;
}

// ── Disposer / stats ───────────────────────────────────────────────────────

/** Bootstrap + wiring statistics exposed on the returned disposer. */
export interface DshPluginStats {
  /** Roles discovered on disk. */
  discovered: number;
  /** Roles successfully resolved. */
  resolved: number;
  /** Roles that failed resolution. */
  skipped: number;
  /** Tools registered into `ctx.tools` (after the namespace filter). */
  registeredTools: number;
  /** Agents registered into `ctx.subagents` (roles + subagents). */
  registeredAgents: number;
  /** The resolved roles (post `defaultRole` promotion). */
  resolvedRoles: ResolvedRole[];
  /**
   * Dispatch mode — always `"dsh"` on this platform. The graph engine and
   * loop mode dispatch subagent sessions through the dsh subagent seam
   * (`ctx.subagents.start` / the dsh session service) instead of the opencode
   * SDK client (see {@link DshDispatchAdapter}).
   */
  dispatchMode: "dsh";
  /**
   * Whether the loop coordinator was wired to the dsh dispatch adapter.
   * `false` would indicate a wiring failure (apply still degrades to
   * graph-only orchestration).
   */
  loopWired: boolean;
  /**
   * Whether the `/rolebox` role-switch routes were registered on dsh's host
   * web server. `true` only when the optional `webServer` service was present
   * on the ctx (the web profile) AND registration succeeded; headless
   * profiles have no web server, so this stays `false` and the plugin keeps
   * running. The role-switch surface shares ONE `/rolebox` prefix
   * registration with the monitor surface (see `monitorRouteRegistered`) —
   * the real host webserver rejects duplicate prefix routes.
   */
  webRouteRegistered: boolean;
  /**
   * Whether the `/rolebox` monitor routes (`/status`, `/metrics`) were
   * registered on dsh's host web server. Mirrors `webRouteRegistered` — the
   * role-switch and monitor surfaces are composed into a single `/rolebox`
   * prefix registration, so both flags are set from the same registration
   * outcome. `true` only when the optional `webServer` service was present
   * AND registration succeeded; headless profiles stay `false` and the
   * plugin keeps running.
   */
  monitorRouteRegistered: boolean;
  /**
   * Whether graph-notify was wired on the dsh path. `true` only when the
   * optional live-agent registry (`ctx.agents`) was present at boot, so the
   * session adapter's `prompt()` can route graph `<system-reminder>` reminders
   * into the target session's agent. When `false` (minimal/headless profiles
   * with no `ctx.agents`) the graph engine still assembles with a `graphNotify`
   * config, but `prompt()` degrades to its no-op and the F6 notifier marks the
   * degraded reminder instead of delivering one.
   */
  graphNotifyWired: boolean;
}

/**
 * The fiber disposer returned by `apply()` (cordis convention, contract §8
 * appendix: "return () => {...}; // fiber disposer"). Also carries the
 * `stats` from this boot so callers/tests can observe the bootstrap outcome.
 */
export interface DshPluginDisposer {
  /** Clean up tool registrations, hook listeners, and agent registrations. */
  (): void;
  /** Bootstrap + wiring statistics for this apply() run. */
  stats: DshPluginStats;
  /**
   * In-process role-reload seam: replace the four role-snapshot tools
   * (`asset_search` / `asset_inspect` / `asset_validate` / `reference_search`)
   * with a fresh generation built from `roles`. Disposes the previously
   * registered generation FIRST — the host registry frees each global tool
   * name synchronously, so re-registering the same names cannot collide —
   * then compiles and registers the new snapshot, honoring the
   * `enabledNamespaces` filter. Safe to call repeatedly; the fiber disposer
   * releases the last retained generation.
   * @param roles - the re-resolved roles the new snapshot binds to.
   * @returns the number of tools registered for this generation.
   */
  registerRoleSnapshotTools(roles: ResolvedRole[]): number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

// ── Structural dsh live-agent surface (contract §4.2, duck-typed) ──────────
//
// rolebox's graph-notify reminders are delivered through
// `ISessionClient.prompt(...)` (the SAME path opencode/Pi use). The dsh
// SessionStore has no `prompt` — prompting is driven by the live agent loop —
// so the plugin routes reminders through the live `Agent` surface instead:
// `ctx.agents.get(sessionId)` → the agent's delivery members. rc.6 exposes
// three (runtime-types.d.ts): `steer` (:123 — an idle driver starts a turn; a
// running driver consumes it at its next step boundary), `followup` (:115 —
// queues an ordinary follow-up turn and wakes the driver), and `inject`
// (:132 — queues model-facing context WITHOUT waking an idle driver). Only the
// members graph-notify needs are declared; the dsh surface is consumed
// structurally (SDK-free), so a missing / non-conforming `ctx.agents` resolves
// to "absent" and the plugin degrades cleanly.

/** Minimal structural dsh `Agent` (the live agent backing a session). */
interface DshAgentLike {
  readonly id: string;
  /** Wake the driver with steering (idle starts a turn). rc.6 runtime-types.d.ts:123. */
  steer?(message: unknown): unknown | Promise<unknown>;
  /** Queue a follow-up turn and wake the driver. rc.6 runtime-types.d.ts:115. */
  followup?(message: unknown): unknown | Promise<unknown>;
  /** Queue context WITHOUT waking an idle driver. rc.6 runtime-types.d.ts:132. */
  inject?(message: unknown): unknown | Promise<unknown>;
}

/** Minimal structural dsh `AgentRegistry` (`ctx.agents`). */
interface DshAgentRegistryLike {
  /** Look up the live agent for a session id (§4.2 `get`). */
  get(id: string): DshAgentLike | undefined;
}

/** Minimal structural dsh `LlmRuntime` (`ctx.llm`, `@deepseek-ai/dsh-llm`). */
interface DshLlmRuntimeLike {
  /**
   * Registered provider routes. `LlmProviderInfo.id` is the "Provider route key
   * used by `GenerateOptions.provider`"
   * (`dsh-llm/lib/types/types.d.ts:131-138`; `listProviders()` at
   * `index.d.ts:234`). Only `id` is read.
   */
  listProviders(): ReadonlyArray<{ id: string }>;
}

/**
 * Structurally probe the cordis ctx for the dsh live-agent registry
 * (`ctx.agents`, `@deepseek-ai/dsh-agent`).
 *
 * The service is optional: it is mounted ONLY when the `dsh-agent` /
 * `dsh-agent-loop` bundle rows are present (full profiles). Minimal/headless
 * profiles have no live agent registry, so this probe returns `undefined` and
 * the plugin keeps booting with graph-notify degraded to the engine's default
 * no-op marker (same graceful path as `probeWebServer` / `probeSystemPrompt`).
 *
 * Like `probeSystemPrompt`, the property read is NOT trusted as the whole
 * probe — a service mounted by a SIBLING plugin fiber (the real profile shape)
 * is invisible to the property-resolver walk — so a throw on `ctx.agents`
 * falls through to the named-service resolver `ctx.get("agents")`, which reads
 * the shared reflect store across fibers. Both paths probe `get(id)` to
 * confirm the service is the agent registry (not some unrelated `agents`
 * service). The probe is deliberately NOT gated on the `inject` roster: an
 * optional service must not gate plugin activation.
 */
function probeAgentRegistry(
  ctx: DshPluginContext,
): DshAgentRegistryLike | undefined {
  let service: unknown;
  try {
    service = ctx.agents;
  } catch {
    // Sibling-fiber service (full profile) — the property read throws; fall
    // through to the cross-fiber named-service resolver below.
    service = undefined;
  }
  if (service === undefined && typeof ctx.get === "function") {
    try {
      service = ctx.get("agents");
    } catch {
      return undefined;
    }
  }
  if (
    service !== undefined &&
    service !== null &&
    typeof (service as { get?: unknown }).get === "function"
  ) {
    return service as DshAgentRegistryLike;
  }
  return undefined;
}

/**
 * Bound a `notice` source summary to the rc.6 `CONTEXT_SUMMARY_MAX_CHARS`
 * (120): the first line trimmed, ellipsized when longer
 * (`len <= 120 ? s : s.slice(0, 119) + "…"`). Mirrors `boundContextSummary`
 * (`@deepseek-ai/dsh-llm/lib/types/message.js:15-19`) without importing
 * dsh-llm — the adapter stays SDK-free.
 */
function boundNoticeSummary(text: string): string {
  const firstLine = (text.split(/\r?\n/, 1)[0] ?? "").trim();
  const summary = firstLine || text.trim();
  return summary.length <= 120 ? summary : `${summary.slice(0, 119)}…`;
}

/**
 * Build a {@link DshPromptInjector} over an optional dsh agent registry.
 *
 * The injector resolves the live `Agent` for a target session and delivers
 * the reminder as a full rc.6 `UserMessage` (message.d.ts:120-133). The
 * delivery member is chosen from `options.noReply` with the same semantics as
 * opencode/Pi (`triggerTurn = !noReply`), so dsh does not diverge:
 *
 *   - `noReply: true`  → deliver WITHOUT waking an idle driver: the non-waking
 *     `inject` member only (rc.6 runtime-types.d.ts:124-132; never
 *     `steer`/`followup`). Absent → `null`.
 *   - `noReply: false` → deliver with a WAKING member — `steer` (an idle driver
 *     starts a turn; a running driver consumes it at its next step boundary,
 *     :116-123), then `followup` (:110-115). Absent → `null` (never silently
 *     no-wake an explicit wake request).
 *   - `noReply: undefined` → legacy best-effort: waking members preferred, the
 *     non-waking `inject` fallback last.
 *
 * A missing registry, a session with no live agent, an agent exposing none of
 * the required members, or a throwing / rejecting delivery all degrade to
 * `null` (the reminder is dropped the same way a missing emperor session is)
 * rather than failing the graph engine. The `Agent` surface is duck-typed, so
 * the injector is best-effort and defensive.
 *
 * The message carries a per-injection unique `id` (a randomUUID string — a
 * branded `MessageId` is satisfied structurally at this duck-typed boundary):
 * the host inbox dedupes on `message.id`, so a shared or absent id would
 * silently drop the second of two consecutive reminders.
 */
export function buildAgentPromptInjector(
  registry: DshAgentRegistryLike | undefined,
): DshPromptInjector | undefined {
  if (!registry) return undefined;
  return {
    async inject(
      sessionId: string,
      text: string,
      options?: { agent?: string; noReply?: boolean },
    ): Promise<{ id: string } | null> {
      let agent: DshAgentLike | undefined;
      try {
        agent = registry.get(sessionId);
      } catch {
        return null;
      }
      if (!agent) return null;

      // Delivery member selection (see the docstring): noReply:true → non-waking
      // `inject` only; noReply:false → waking `steer`/`followup` only; undefined
      // → legacy waking-preferred-with-inject-fallback. `.bind(agent)` preserves
      // the method receiver.
      const deliver:
        | ((message: unknown) => unknown | Promise<unknown>)
        | undefined =
        options?.noReply === true
          ? typeof agent.inject === "function"
            ? agent.inject.bind(agent)
            : undefined
          : options?.noReply === false
            ? typeof agent.steer === "function"
              ? agent.steer.bind(agent)
              : typeof agent.followup === "function"
                ? agent.followup.bind(agent)
                : undefined
            : typeof agent.steer === "function"
              ? agent.steer.bind(agent)
              : typeof agent.followup === "function"
                ? agent.followup.bind(agent)
                : typeof agent.inject === "function"
                  ? agent.inject.bind(agent)
                  : undefined;
      if (!deliver) return null;

      // The reminder text already carries the graph marker + the resolved
      // agent (buildGraphCompletionText embeds `agent: <id>`), so the agent is
      // delivered inline in the body. A full rc.6 UserMessage needs id / role
      // / content / source (message.d.ts:120-133); the plugin `notice` source
      // (message.d.ts:98-101, 81-84) carries a bounded summary.
      const id = randomUUID();
      const message = {
        id,
        role: "user" as const,
        content: [{ type: "text" as const, text }],
        source: {
          kind: "plugin" as const,
          plugin: "rolebox",
          form: "notice" as const,
          summary: boundNoticeSummary(text),
        },
      };
      try {
        // Fire-and-forget: resolve a sync or async delivery uniformly, treat
        // a rejection as a degradation.
        await Promise.resolve(deliver(message));
        return { id };
      } catch {
        return null;
      }
    },
  };
}


/**
 * Resolve the rolebox directories for the dsh platform, applying the
 * `roleboxDir` / `skillsDir` config overrides on top of `dshPlatformPaths()`
 * (which resolves `$DSH_HOME` or `~/.dsh` — contract §5.1).
 */
function resolveDirs(config: DshPluginConfig): RoleboxDirectories {
  const dirs = resolveRoleboxDirectories({
    platformId: "dsh",
    workingDir: process.cwd(),
  });
  return {
    ...dirs,
    roleboxDir: config.roleboxDir ?? dirs.roleboxDir,
    globalSkillsDir: config.skillsDir ?? dirs.globalSkillsDir,
  };
}

/**
 * Namespace filter for tool registration.
 *
 * `enabledNamespaces` is a dsh-specific config option: when set and
 * non-empty, only tools whose key matches one of the entries are registered.
 * An entry matches either exactly (the full tool key, e.g. `signal`) or as a
 * namespace prefix (the key's segment before the first `_`, e.g. `hashline`
 * matches `hashline_read` / `hashline_edit`). The wildcard `"*"` disables the
 * filter — as does an absent/empty option (register everything).
 */
function isNamespaceEnabled(
  key: string,
  enabled: string[] | undefined,
): boolean {
  if (!enabled || enabled.length === 0) return true;
  if (enabled.includes("*")) return true;
  const prefix = key.split("_")[0] ?? key;
  return enabled.some((ns) => ns === key || ns === prefix);
}

/**
 * Structurally probe the cordis ctx for the dsh host web server service.
 *
 * The dsh host registers its webserver as a named service
 * (`ctx.get("webServer")`, `@deepseek-ai/dsh-host-webserver`) ONLY when the
 * web profile is active; headless profiles have no web server, so this probe
 * returns `undefined` and the plugin skips `/rolebox` route registration
 * gracefully. The service is consumed by duck typing (the structural
 * `register(route)` surface — see {@link DshWebServerRouteRegistrar}), so a
 * missing `get`, a throw on an unknown name, or a non-conforming value all
 * resolve to "absent" rather than failing the boot.
 */
function probeWebServer(
  ctx: DshPluginContext,
): DshWebServerRouteRegistrar | undefined {
  let service: unknown;
  try {
    service = typeof ctx.get === "function" ? ctx.get("webServer") : undefined;
  } catch {
    return undefined;
  }
  if (
    service !== undefined &&
    service !== null &&
    typeof (service as { register?: unknown }).register === "function"
  ) {
    return service as DshWebServerRouteRegistrar;
  }
  return undefined;
}

/**
 * Structurally probe the cordis ctx for the dsh system-prompt registry
 * service (`@deepseek-ai/dsh-system-prompt`).
 *
 * The service may surface either as a direct `ctx.systemPrompt` property
 * (the host injects the registry onto the context) or through the
 * named-service resolver `ctx.get("systemPrompt")` — both are probed,
 * mirroring {@link probeWebServer}. Full profiles mount the registry (the
 * `system-prompt` bundle row); headless profiles have no model-facing prompt
 * assembly, so this probe returns `undefined` and the plugin skips the
 * rolebox prompt contributions gracefully.
 *
 * The property read is deliberately NOT trusted as the whole probe: a
 * service mounted by a SIBLING plugin fiber (the real profile shape — the
 * bundle loader mounts every row via `ctx.plugin()`, so the registry lives
 * in another plugin's fiber) is invisible to the property-resolver walk,
 * which only climbs ANCESTOR fibers and THROWS on an unknown name. A throw
 * from `ctx.systemPrompt` therefore falls through to the named-service
 * resolver, which reads the shared reflect store across fibers. The service
 * is consumed by duck typing (the structural `section(entry)` /
 * `context(entry)` surface — see {@link DshSystemPromptRegistry}), so a
 * missing `get`, a throw on an unknown name, or a non-conforming value all
 * resolve to "absent" rather than failing the boot. The probe is
 * deliberately NOT gated on the `inject` roster: an optional service must
 * not gate plugin activation.
 */
function probeSystemPrompt(
  ctx: DshPluginContext,
): DshSystemPromptRegistry | undefined {
  let service: unknown;
  try {
    service = ctx.systemPrompt;
  } catch {
    // Sibling-fiber service (full profile) — the property read throws;
    // fall through to the cross-fiber named-service resolver below.
    service = undefined;
  }
  if (service === undefined && typeof ctx.get === "function") {
    try {
      service = ctx.get("systemPrompt");
    } catch {
      return undefined;
    }
  }
  if (
    service !== undefined &&
    service !== null &&
    typeof (service as { section?: unknown }).section === "function" &&
    typeof (service as { context?: unknown }).context === "function"
  ) {
    return service as DshSystemPromptRegistry;
  }
  return undefined;
}

/**
 * Structural dsh skill-registry service (`@deepseek-ai/dsh-skill`
 * `ctx.skills`), SDK-free. Only the `registerProvider` seam is consumed; the
 * candidate/definition surface is owned by the skill-provider module
 * (`DshSkillProviderLike`). Matches the verified rc.6 signature
 * (`dsh-skill/lib/types/index.d.ts:249`):
 * `registerProvider(create: (control) => SkillProvider): () => void`.
 */
interface DshSkillRegistryLike {
  /**
   * Register a LAZY skill provider. `create` is invoked once with the
   * registration control and must return a provider; the returned disposer
   * unregisters it.
   */
  registerProvider(
    create: (control: DshSkillProviderControl) => DshSkillProviderLike,
  ): () => void;
}

/**
 * Structurally probe the cordis ctx for the dsh skill-registry service
 * (`@deepseek-ai/dsh-skill` `ctx.skills`).
 *
 * The service may surface either as a direct `ctx.skills` property (the host
 * injects the registry onto the context) or through the named-service resolver
 * `ctx.get("skills")` — both are probed, mirroring {@link probeSystemPrompt}.
 * Full profiles mount the `dsh-skill` registry row; headless / minimal
 * profiles have no model-facing skill registry, so this probe returns
 * `undefined` (the same no-op marker as {@link probeAgentRegistry}) and the
 * plugin keeps booting with rolebox's skill provider absent.
 *
 * The property read is deliberately NOT trusted as the whole probe: a service
 * mounted by a SIBLING plugin fiber (the real profile shape) is invisible to
 * the property-resolver walk, which only climbs ANCESTOR fibers and THROWS on
 * an unknown name. A throw from `ctx.skills` therefore falls through to the
 * named-service resolver, which reads the shared reflect store across fibers.
 * The service is consumed by duck typing (a callable `registerProvider` — see
 * {@link DshSkillRegistryLike}), so a missing `get`, a throw on an unknown
 * name, or a non-conforming value all resolve to "absent" rather than failing
 * the boot. The probe is deliberately NOT gated on the `inject` roster: an
 * optional service must not gate plugin activation.
 */
function probeSkillRegistry(
  ctx: DshPluginContext,
): DshSkillRegistryLike | undefined {
  let service: unknown;
  try {
    service = ctx.skills;
  } catch {
    // Sibling-fiber service (full profile) — the property read throws;
    // fall through to the cross-fiber named-service resolver below.
    service = undefined;
  }
  if (service === undefined && typeof ctx.get === "function") {
    try {
      service = ctx.get("skills");
    } catch {
      return undefined;
    }
  }
  if (
    service !== undefined &&
    service !== null &&
    typeof (service as { registerProvider?: unknown }).registerProvider === "function"
  ) {
    return service as DshSkillRegistryLike;
  }
  return undefined;
}

/**
 * Structurally probe the cordis ctx for the dsh llm service
 * (`ctx.llm`, `@deepseek-ai/dsh-llm`).
 *
 * The llm service is the adapter registry that answers "does a provider route
 * have a registered adapter?" (`listProviders()`), which is exactly the check
 * that prevents a split rolebox model from routing a spawn through an
 * unregistered provider and failing with `NO_ADAPTER`. It is always mounted in
 * a full dsh profile, but it is NOT in the `inject` roster (an optional probe
 * must not gate plugin activation), so this resolves it structurally: try the
 * direct `ctx.llm` property first, and — because a service mounted by a SIBLING
 * plugin fiber throws on the property-resolver walk (mirroring
 * {@link probeSystemPrompt}) — fall through to the named-service resolver
 * `ctx.get("llm")`. The value is consumed by duck typing (the structural
 * `listProviders()` surface — see {@link DshLlmRuntimeLike}), so a missing
 * `get`, a throw, or a non-conforming value all resolve to "absent" and the
 * registrar keeps its pre-safety behavior (emit the split unchanged).
 */
function probeLlmRoutes(
  ctx: DshPluginContext,
): DshLlmRuntimeLike | undefined {
  let service: unknown;
  try {
    service = ctx.llm;
  } catch {
    // Sibling-fiber service (full profile) — the property read throws;
    // fall through to the cross-fiber named-service resolver below.
    service = undefined;
  }
  if (service === undefined && typeof ctx.get === "function") {
    try {
      service = ctx.get("llm");
    } catch {
      return undefined;
    }
  }
  if (
    service !== undefined &&
    service !== null &&
    typeof (service as { listProviders?: unknown }).listProviders === "function"
  ) {
    return service as DshLlmRuntimeLike;
  }
  return undefined;
}

// ── apply ───────────────────────────────────────────────────────────────────

/**
 * Cordis plugin `apply(ctx, config)` — boots rolebox on the dsh platform.
 *
 * Flow (mirroring `src/index.ts`):
 *   1. Resolve directories via the dsh platform paths (config overrides win).
 *   2. `initializeRoleboxRuntime()` with a `DshAgentRegistrar` bound to
 *      `ctx.subagents` — discovers roles, resolves them, syncs agents into
 *      the dsh subagent catalog.
 *   3. Apply `defaultRole` project-config promotion when configured.
 *   3a. Wire the dsh role switcher (per-session active-role state + the
 *       `session/created` restore listener) and — OPTIONALLY — register the
 *       composed `/rolebox` prefix route (role-switch surface + monitor
 *       `/status`, `/metrics` surfaces) on dsh's host web server via the
 *       `webServer` service seam (present only in the web profile). The two
 *       surfaces share ONE prefix registration — the real host webserver
 *       rejects duplicate `(kind, path)` pairs. The composed route also
 *       carries the in-process `POST /rolebox/reload` surface
 *       (`DshRoleboxReloader`), which re-discovers + re-resolves roles and
 *       refreshes the role-snapshot tools and the skill catalog IN PLACE —
 *       exposed only where this route is (the DSH web monitor panel). A
 *       registration failure logs a warning and degrades — the plugin keeps
 *       running without the web surface.
 *   3b. OPTIONALLY register the session-level system-prompt contributions
 *       (`rolebox:role` section + `rolebox:context` context entry) when the
 *       `systemPrompt` service is present on the ctx (full profiles only);
 *       headless profiles warn-degrade and the plugin keeps running.
 *   4. Compile canonical tools via `DshToolFactory` from
 *      `buildCanonicalTools(...)` (with the dsh session adapter as the
 *      session client) and register them into `ctx.tools`, filtered by
 *      `enabledNamespaces`.
 *   5. Mount hooks via `DshHookProvider` (rolebox hook kinds onto the dsh
 *      `tools/*` / `session/event` extension points).
 *   6. Log discovered/resolved/skipped counts mirroring `src/index.ts`.
 *
 * @param ctx    - The cordis context (structural; the injected dsh services).
 * @param config - Validated plugin config. cordis validates through
 *                 `Config['~standard']` and passes the defaults-applied
 *                 output; direct callers may pass a partial object — every
 *                 option is optional, so the partial path is safe too.
 * @returns A fiber disposer that also carries `stats`.
 */
export async function apply(
  ctx: DshPluginContext,
  config: DshPluginConfig = {} as DshPluginConfig,
): Promise<DshPluginDisposer> {
  const log = createSubLogger("dsh-plugin");

  // 1. Resolve directories (dsh platform paths + config overrides).
  const dirs = resolveDirs(config);
  log.info("dsh plugin starting", {
    roleboxDir: dirs.roleboxDir,
    globalSkillsDir: dirs.globalSkillsDir,
    configDir: dirs.configDir,
  });

  // 2. Discover + resolve roles; sync agents into ctx.subagents.
  //
  // The per-session active-role holder is created FIRST and shared by BOTH
  // the registrar (which reads it at spawn time to apply the active role's
  // system prompt / model to spawned agents) and the role switcher (which
  // writes it on switch/clear and restores it on session/created). Sharing
  // one instance is what makes a web-UI role switch reach the spawned agent.
  //
  // durability: the holder is backed by the concrete `ActiveRoleStore`
  // sidecar. State home MUST be the workspace (`process.cwd()`), NOT
  // `dirs.configDir` (the dsh home, ~/.dsh): the sidecar lives beside the
  // other workspace state under `.rolebox/state`, so a role switch persists
  // with the project — the same convention the graph engine / dispatch stores
  // follow. The store hydrates the holder synchronously at construction
  // (`activerole-<workspaceHash>.json`) and every switch writes back
  // best-effort.
  const activeRoleStore = new ActiveRoleStore(process.cwd());
  const activeRole = createActiveRoleRef(activeRoleStore);
  // Spawn-time context injection: rolebox's `system-transform` hook (which
  // injects the role's dynamic context — available functions, memory — into
  // the agent prompt) has no dsh extension point and is a documented no-op
  // (hook-provider.ts:178). Its counterpart here materializes the ACTIVE
  // role's context block at spawn time — the available-functions block first
  // (mirroring src/hooks/system-transform.ts:77-85) — so a spawned agent's
  // effective prompt carries the rolebox context alongside the role prompt.
  const contextProvider: DshSpawnContextProvider = (sessionId) => {
    const activeId = activeRole.get(sessionId);
    if (!activeId) return undefined;
    const functions = roleFunctionsMap.get(activeId);
    if (!functions || functions.length === 0) return undefined;
    const block = buildAvailableFunctionsBlock(functions);
    return block ? [{ type: "text", text: block }] : undefined;
  };
  // Provider-route safety path: probe the mounted dsh llm service and hand the
  // registrar a live route list, so a split definition model whose provider has
  // no registered adapter degrades to a model-only override (one warning)
  // instead of failing the spawn with NO_ADAPTER. The closure reads
  // `listProviders()` at SPAWN time, so adapters registered after plugin boot
  // are seen. Absent `ctx.llm` → no probe → the split is emitted unchanged.
  const llm = probeLlmRoutes(ctx);
  const providerRoutes: DshProviderRouteProbe | undefined = llm
    ? () => llm.listProviders().map((entry) => entry.id)
    : undefined;
  const registrar = new DshAgentRegistrar({
    subagents: ctx.subagents,
    activeRole,
    contextProvider,
    providerRoutes,
    // Host-supplied spawn seam : when the host passes `onSpawn`, registered
    // providers delegate real spawning to it. Absent → the registrar warns once
    // at construction and every `ctx.subagents.start()` delegates to the host
    // provider named by `spawnProviderName` (default "spawn", registered by
    // @deepseek-ai/dsh-subagent-spawn-in-process); only when that provider is
    // unregistered does `start()` reject DshSpawnNotWiredError.
    onSpawn: config.onSpawn,
    spawnProviderName: config.spawnProviderName,
  });
  const runtimeOptions: InitializeRuntimeOptions = {
    directories: dirs,
    roleFunctionsMap,
    registrar,
  };
  const { resolvedRoles, discovered, resolved, skipped } =
    await initializeRoleboxRuntime(runtimeOptions);

  // 3. Apply the defaultRole promotion when configured.
  if (config.defaultRole) {
    applyProjectConfig(resolvedRoles, { defaultRole: config.defaultRole });
  }

  // 3a. Wire the dsh role switcher (per-session active-role state + the
  // `session/created` restore listener). The switcher is always constructed —
  // it backs the `/rolebox` host routes and `hasRoleSwitch`. The web surface
  // itself is OPTIONAL: the dsh host webserver service (`ctx.get('webServer')`)
  // exists only when the web profile is active, so the `/rolebox` prefix
  // route is registered only when the service is present; headless profiles
  // skip with a debug log and the plugin keeps running.
  // `activeRole` is the SAME store-backed holder created above, so a switch
  // through the switcher (web UI or host route) persists to the workspace
  // sidecar and is read back by the registrar / prompt adapter.
  //
  // Skill-catalog refresh seam (subtask 7). The lazy skill provider registered
  // below retains its registration `control`; `refreshSkillCatalog` is the
  // single hook that invalidates the dsh `ctx.skills` catalog when the set of
  // candidate roles changes. It is wired to BOTH drivers:
  //   (a) an active-role change — the switcher calls `onActiveRoleChanged`
  //       once per applied switch/clear/restore below; and
  //   (b) a role RE-RESOLUTION — a re-`apply` (HMR) re-resolves roles and
  //       registers a FRESH provider from the new role set, while the previous
  //       registration is disposed (its control's abort signal fires), so the
  //       stale provider's `invalidate()` is a no-op and the new provider
  //       already advertises the re-resolved roles.
  // It is a no-op until the provider is registered, and a no-op again after
  // disposal (the provider guards on `control.signal.aborted`).
  let skillProvider: DshSkillProvider | undefined;
  const refreshSkillCatalog = (): void => {
    skillProvider?.invalidate();
  };
  const roleSwitcher = new DshRoleSwitcher({
    registrar,
    store: ctx.sessions,
    ctx,
    activeRole,
    onActiveRoleChanged: () => refreshSkillCatalog(),
  });

  // Optional host webServer seam — probe ONCE here. The composed `/rolebox`
  // prefix route (role-switch surface + monitor surface) is registered below,
  // after the loop wiring that the monitor surface depends on (its live-loop
  // census). The real dsh host webserver rejects a duplicate `(kind, path)`
  // registration (`webserver: duplicate prefix route "/rolebox"` — see
  // `@deepseek-ai/dsh-host-webserver` lib/index.js:54-55), so both surfaces
  // MUST share a single prefix registration; a failure logs a warning and
  // degrades — the plugin keeps running without the web surface.
  const routeDisposers: Array<() => void> = [];

  /**
   * Change-signal sink for the web console's `/rolebox/events` channel.
   *
   * A mutable binding rather than a service: the producers below (the loop
   * coordinator, the graph toolset, the state-directory watcher) are constructed
   * BEFORE the web route exists, and several of them are optional. Until the
   * route registers, the sink is a no-op — every producer stays unaware of
   * whether a console is even connected.
   */
  let notifyRoleboxChanged: (reason: "loop" | "graph" | "file") => void = () => {};
  const webServer = probeWebServer(ctx);
  let webRouteRegistered = false;
  let monitorRouteRegistered = false;

  // Optional systemPrompt service seam — register the rolebox session-level
  // system-prompt contributions (`rolebox:role` section + `rolebox:context`
  // context entry) when the dsh host provides the registry, so the
  // model-facing prompt carries the ACTIVE role's system prompt and its
  // available-functions block. The service exists only in full profiles (the
  // `@deepseek-ai/dsh-system-prompt` bundle); headless profiles have no
  // model-facing prompt assembly, so the probe returns absent and the plugin
  // keeps booting without the prompt seam — identical degradation to the
  // webServer seam above. The adapter's registry disposers are collected
  // into the fiber disposer below via `promptDisposers`.
  const promptDisposers: Array<() => void> = [];
  const systemPromptRegistry = probeSystemPrompt(ctx);
  if (systemPromptRegistry) {
    try {
      const promptAdapter = new DshSystemPromptAdapter({
        registrar,
        activeRole,
        roleFunctionsMap,
        directory: dirs.roleboxDir,
      });
      promptAdapter.register(systemPromptRegistry);
      promptDisposers.push(() => promptAdapter.dispose());
      log.info("Rolebox system-prompt contributions registered", {
        section: "rolebox:role",
        context: "rolebox:context",
      });
    } catch (err) {
      log.warn("System-prompt registration failed — degrading", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    log.warn("No systemPrompt service on ctx — role prompt injection disabled");
  }

  // Optional skills service seam — register rolebox's LAZY skill provider on
  // dsh's global `ctx.skills` registry so every skill name in the role prompt's
  // `<available_skills>` block is resolvable by the `skill` tool under dsh.
  // The registry's plugin seam is `registerProvider(create)` — a FACTORY — fed
  // the `(control) => SkillProvider` factory built from the resolved roles (the
  // candidate pool, narrowed by the provider to the active ∪ default roles),
  // the shared `activeRole` ActiveRoleRef holder (the active set, read at list
  // time), and the promoted default role. The service exists only when the
  // profile mounts the `dsh-skill` registry row; headless / minimal profiles
  // have no skill registry, so the probe returns absent and the plugin keeps
  // booting without it — identical degradation to the systemPrompt seam above.
  // The registration disposer is collected into the fiber disposer below via
  // `skillDisposers`.
  const skillDisposers: Array<() => void> = [];
  const skillRegistry = probeSkillRegistry(ctx);
  if (skillRegistry) {
    try {
      const skillProviderFactory = createDshSkillProviderFactory({
        roles: resolvedRoles,
        activeRole,
        ...(config.defaultRole ? { defaultRoleId: config.defaultRole } : {}),
      });
      // Capture the provider instance the registry's factory creates so the
      // `refreshSkillCatalog` seam wired above can invalidate its catalogs on
      // a role change. The registry invokes `create(control)` synchronously,
      // so `skillProvider` is assigned before `registerProvider` returns.
      const captureProvider = (
        control: DshSkillProviderControl,
      ): DshSkillProviderLike => {
        const provider = skillProviderFactory(control);
        skillProvider = provider;
        return provider;
      };
      const dispose = skillRegistry.registerProvider(captureProvider);
      skillDisposers.push(dispose);
      log.info("Rolebox skill provider registered", {
        provider: ROLEBOX_SKILL_PROVIDER,
        candidateRoles: resolvedRoles.length,
      });
    } catch (err) {
      log.warn("Skill-provider registration failed — degrading", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    log.debug("No skills service on ctx — rolebox skill provider disabled");
  }

  // 4. Compile + register tools (dsh session adapter drives the session tools).
  //
  // graph-notify injection seam (subtask: DSH graphNotify assembly). The dsh
  // SessionStore has NO `prompt` — the opencode/Pi `sessionClient.prompt` way
  // of delivering graph `<system-reminder>` reminders has no SessionStore
  // equivalent. dsh's per-session message delivery lives on the live `Agent`
  // surface (`ctx.agents`), which is mounted only in full profiles. Probe it
  // OPTIONALLY: when the live agent registry is present the session adapter's
  // `prompt()` delivers graph-notify reminders into the target session's agent
  // (the dsh equivalent of opencode/Pi graph-notify), preferring a WAKING
  // member (`steer`, then `followup`; rc.6 runtime-types.d.ts:115-123) and
  // falling back to `inject` (:124-132), which queues model-facing context
  // WITHOUT waking an idle driver; when the registry is absent the adapter
  // keeps its documented no-op and the graph engine's F6 notifier logs the
  // degraded reminder — never a crash, never gating boot.
  const agentRegistry = probeAgentRegistry(ctx);
  const promptInjector = buildAgentPromptInjector(agentRegistry);
  const graphNotifyWired = promptInjector !== undefined;
  const sessionAdapter = new DshSessionAdapter(ctx.sessions, {
    ...(promptInjector ? { promptInjector } : {}),
  });
  const factory = new DshToolFactory();

  // ── dsh dispatch path (subtask 8) ────────────────────────────────────────
  //
  // The dsh platform's "dispatch manager" for LOOP worker rounds: routes loop
  // rounds through the dsh services instead of the opencode SDK client —
  // `ctx.subagents.start` for spawning (per-role agent mapping via the
  // providers {@link DshAgentRegistrar} registered above), `ctx.sessions` +
  // the run's `result` promise for collecting results, `run.dispose()` for
  // cancellation, and stopReason→DispatchTaskStatus translation so failures
  // map to the loop coordinator's semantics.
  const dshDispatch = new DshDispatchAdapter({
    subagents: ctx.subagents,
    sessionClient: sessionAdapter,
    // dsh REQUIRES a live parent `Agent` on every SubagentStartRequest
    // (`dsh-subagent/lib/types/types.d.ts:101`) and the in-process driver
    // dereferences it while composing the child. Resolve it from the probed
    // live-agent registry (`ctx.agents`); when the registry is absent
    // (headless/minimal profile) or the session has no live agent, the adapter
    // fails loud with DshParentUnresolvedError instead of forwarding
    // `parent: undefined`.
    parentResolver: (sid) => agentRegistry?.get(sid),
    directory: process.cwd(),
  });

  // ── The outcome run path's host layer ────────────────────────────────────
  //
  // A declared graph is dispatched by the host capability layer
  // (`src/graph/host/outcome-host.ts`), not by a legacy engine:
  //   - `DshOutcomeDelivery` starts one dsh subagent run per attempt and
  //     observes its terminal result (the attempt's credential travels in that
  //     worker's prompt — the one channel it belongs to);
  //   - the `OutcomeHost` holds the credential vault, the durable execution
  //     index, the invocation identity (D9) and the completion bridge that
  //     settles a finished attempt through `settleNatural`. The vault keeps the
  //     `durableCredentialStore: "none"` default: this host cannot
  //     substantiate a platform-isolated store, so no durable artifact holds a
  //     credential value and a crash-window attempt whose value is gone is
  //     reported as unsettled rather than re-delivered with an invented one;
  //   - `graph_declare` reports the persisted plan through `onGraphDeclared`,
  //     which starts (or resumes) the graph through the runtime's own
  //     `resume` — the same entry the boot sweep uses.
  //
  // The store root is deliberately a host directory beside the workspace state
  // (workers are not handed its path): see `credential-vault.ts` for what that
  // can and cannot isolate on a same-account platform.
  let outcomeHost: OutcomeHost | undefined;
  const outcomeDelivery = new DshOutcomeDelivery({
    subagents: ctx.subagents,
    parentResolver: (sid) => agentRegistry?.get(sid),
    onStartFailed: (_request, effect, reason) => {
      outcomeHost?.reportDeliveryFailure(effect, reason);
    },
    onStarted: (_request, effect, execution) => {
      // The platform named the subagent run it created: the host records the
      // FACT, which is what lets a restart reconcile the effect instead of
      // reporting it as an unknown create.
      outcomeHost?.confirmExecution(effect, execution);
    },
    onSettled: (settlement) => {
      const { request } = settlement;
      if (settlement.kind === "failed") {
        log.warn("dsh outcome dispatch: attempt did not complete", {
          graphId: request.graphId,
          nodeId: request.nodeId,
          attemptId: request.attemptId,
          reason: settlement.reason,
        });
        return;
      }
      void outcomeHost
        ?.complete(request.graphId, request.attemptId)
        .then((report) => {
          // Any settlement moves the graph state the console renders.
          notifyRoleboxChanged("graph");
          log.debug("dsh outcome completion settled", {
            graphId: request.graphId,
            attemptId: request.attemptId,
            kind: report.kind,
          });
        })
        .catch((err: unknown) => {
          log.warn("dsh outcome completion failed", {
            graphId: request.graphId,
            attemptId: request.attemptId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    },
  });
  // THE HOST'S OWN STATE ROOT IS NOT THE WORKSPACE. A dispatched worker runs
  // with the workspace as its root, so keeping the store under
  // `<workspace>/.rolebox/state` handed every worker the directory. This is the
  // one path-shaped part of the boundary — `credential-vault.ts` states why it
  // is not isolation by itself and what the vault does NOT put on disk.
  const outcomeStoreRoot = graphStoreRoot(getDataDir(), process.cwd());
  // TWO DIFFERENT SUBJECTS, TWO DIFFERENT DECISIONS.
  //
  // D9 IS NOT DECLARED. The runtime's dispatch-identity capability binds an
  // attempt to the invocation that ARMED it — the declaring parent. That is
  // attribution: the dsh platform attributes a dispatched worker's own tool
  // call to the WORKER's session (the tool context is built for the executing
  // agent), so a check against the declaring invocation would refuse exactly
  // the submission the delivery handoff asks the worker to make
  // (host-identity-mismatch), and a parent session is not the worker's
  // identity.
  //
  // THE WORKER BINDING IS DECLARED, because this host CAN substantiate it: the
  // dsh type documents that a local subagent run's id IS the published child
  // session id (`DshSubagentRun.id`), and that is the value `onStarted` hands
  // `confirmExecution` — and the session the platform attributes the worker's
  // own tool calls to. The host therefore answers "the worker of attempt X is
  // child session Y" from its durable execution record, and the submission
  // ingress refuses a call that arrives from any other session. The bearer
  // credential still binds the submission to its attempt: the worker binding
  // is an ADDITIONAL constraint, never a replacement.
  outcomeHost = OutcomeHost.open({
    workspaceDir: process.cwd(),
    storeRoot: outcomeStoreRoot,
    deliver: outcomeDelivery.deliver,
    // The registry and the credential RECORDS are durable; no credential VALUE
    // is (the vault default), because this host cannot substantiate the
    // platform boundary a durable value would need.
    validators: createValidatorRegistry([]),
    declareInvocationIdentity: false,
    // The platform's own child-session fact, read back from the confirmed
    // execution: for a local dsh run the run id IS the published child session
    // id, so the worker of an attempt is the session `onStarted` reported.
    workerSessionOf: (execution) => execution.executionId,
    // THE PLATFORM PORTS (P2 part 2 / F3). The dispatch adapter's own question
    // — "does an execution already exist for this stable effect id, and which
    // one?" — is answered from the dsh child listing by the run's durable label,
    // and the boot sweep's terminal read and re-subscribe are installed too.
    // dsh's answers are what the platform can substantiate: the query can NAME
    // an execution and can never prove one absent, the terminal read is
    // `unknown` (no durable outcome exists on the surface rolebox consumes),
    // and the watch is `unsupported` (a run's result promise belongs to the
    // process that started it). Each of those is REPORTED by the host, never
    // rounded into a launch, a settlement or a silent strand.
    query: outcomeDelivery.executionQuery,
    observeExecution: outcomeDelivery.observeExecution,
    watchCompletion: outcomeDelivery.watchCompletion,
    // THE PLATFORM CANCEL PORT (P3). A trusted cancel command's durable intents
    // are handed to dsh through this: a run THIS process started is aborted
    // through its run handle and confirmed by its own `result` promise
    // (`stopReason === "aborted"`); a run it did not start is answered
    // `unsupported` or `requested` — never "cancelled" — because dsh's
    // `interrupt()` returns void and substantiates nothing.
    cancelExecution: outcomeDelivery.cancelExecution,
  });
  // The outcome toolset: the four entries that operate on a DECLARED graph.
  // No manager / dispatch seam is injected, so it can never build a legacy
  // engine; the outcome deps are the host layer above.
  const outcomeToolset = createGraphToolSet({
    directory: process.cwd(),
    stateDir: process.cwd(),
    credentialIsolation: outcomeHost.credentialIsolation,
    // THE WORKER-IDENTITY CAPABILITY, not the D9 one: the identity option
    // carries whichever shape the host declared, and this shape names the
    // child session the platform created for the attempt's worker. Without it
    // the session a submission arrives from would not be an authentication
    // factor at all.
    hostIdentity: outcomeHost.workerIdentity,
    outcomeDispatch: outcomeHost.dispatch,
    outcomeValidators: createValidatorRegistry([]),
    outcomeArtifactRoot: process.cwd(),
    onGraphDeclared: (graphId, invokingSessionId, agent) => {
      // The declaring invocation is handed to the HOST, which records it for the
      // graph and re-supplies it on every dispatch window — the entry attempt
      // here, and every successor a later acceptance arms (a worker's
      // submission, an observed completion, the boot sweep). The delivery seam
      // is stateless: nothing names a session "for the duration of" a call, so
      // there is no window whose end can lose it.
      void outcomeHost
        ?.startDeclaredGraph(graphId, { sessionId: invokingSessionId, agent })
        .then((result) => {
          notifyRoleboxChanged("graph");
          if (result.kind === "refused") {
            log.warn("dsh outcome graph start refused", {
              graphId,
              refusals: result.refusals.map((r) => r.code).join(","),
            });
            return;
          }
          log.info("dsh outcome graph started", {
            graphId,
            kind: result.kind,
            dispatched: result.dispatched.length,
            // The effects this window could NOT launch (and the rows a host
            // fact contradicted) are named, never folded into "started".
            ...(result.refusals.length === 0
              ? {}
              : { refusals: result.refusals.map((r) => r.code).join(",") }),
            ...(result.divergences.length === 0
              ? {}
              : { divergences: result.divergences.length }),
          });
        })
        .catch((err: unknown) => {
          log.warn("dsh outcome graph start failed", {
            graphId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    },
  });
  const graphTools = outcomeHost.bindTools(
    // THE CANCEL DELIVERY IS WIRED TO THE CONTROL ENTRY (P3). After a
    // `graph_control` call returns — the trusted command is durable by then —
    // the host hands the graph's cancel intents to the platform port above. The
    // wrapper runs INSIDE `bindTools`, so the worker boundary refuses a
    // dispatched worker's call before the tool body and before this delivery.
    withCancelDelivery(
      createOutcomeGraphTools(outcomeToolset, {
        getEffectiveAgent: (sessionID?: string) =>
          sessionID ? activeRole.get(sessionID) ?? "" : "",
      }),
      outcomeHost,
    ),
    (sessionID?: string) => (sessionID ? activeRole.get(sessionID) ?? "" : ""),
  );
  // Boot recovery for declared graphs: a graph interrupted by the previous
  // process is continued from its persisted state, and one that was declared
  // but never started gets its first execution — through the same runtime entry
  // the declaration seam uses. The sweep names each graph's recorded declaring
  // invocation, so a pending effect re-arms under the parent it belongs to.
  // Best-effort: a failure is logged, never gates boot.
  void outcomeHost
    .recoverDeclaredGraphs()
    .then(async (report) => {
      if (
        report.started.length > 0 ||
        report.resumed.length > 0 ||
        report.refused.length > 0 ||
        report.effectRefusals.length > 0 ||
        report.divergences.length > 0 ||
        report.cancellations.length > 0 ||
        report.cancelBlocked.length > 0
      ) {
        log.warn("dsh outcome graph recovery", {
          started: report.started,
          resumed: report.resumed,
          refused: report.refused,
          // Per-effect facts a visited graph still owes: an effect the resume
          // would not launch, and a row the host's fact contradicted.
          effectRefusals: report.effectRefusals.map(
            (refusal) => refusal.graphId + ":" + refusal.code,
          ),
          divergences: report.divergences.map(
            (divergence) =>
              divergence.graphId +
              ":" +
              divergence.effectId +
              ":" +
              divergence.local +
              "->" +
              divergence.host,
          ),
          // WHAT THE SWEEP'S CANCEL DELIVERIES ESTABLISHED (P3): confirmed /
          // requested / unsupported / blocked, per attempt. Only `confirmed`
          // is the platform's own substantiation; everything else leaves the
          // execution visible and unsettled, which is why the report names it.
          cancellations: report.cancellations.map(
            (entry) =>
              entry.graphId + ":" + entry.attemptId + ":" + entry.state,
          ),
          cancelBlocked: report.cancelBlocked,
        });
      }
      // THE AWAITING INVENTORY IS CONSUMED, NOT JUST PRINTED (F4). Every
      // confirmed execution the sweep is still waiting on is handed back to the
      // platform adapter, which re-subscribes where dsh supports it and reports
      // the ones it cannot keep observing. On dsh the watch is `unsupported`
      // (a run's result promise belongs to the process that started it), so the
      // report names each execution nobody is listening to — the observable
      // block, never a silent strand — and the next boot sweep re-asks.
      const watching = await outcomeHost?.retainAwaitingCompletions(
        report.awaitingCompletion,
        { onSettled: () => notifyRoleboxChanged("graph") },
      );
      if (
        watching !== undefined &&
        (watching.watched.length > 0 ||
          watching.settled.length > 0 ||
          watching.unwatched.length > 0)
      ) {
        log.warn("dsh outcome graph observation", {
          watched: watching.watched,
          settled: watching.settled,
          unwatched: watching.unwatched.map(
            (entry) =>
              entry.graphId + ":" + entry.attemptId + ":" + entry.executionId,
          ),
        });
      }
    })
    .catch((err: unknown) => {
      log.warn("dsh outcome graph recovery failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  // ── Event-driven console updates ─────────────────────────────────────────
  // Two producers feed the web console's change channel. None of them polls:
  //   - the outcome host reports a settlement / start through
  //     `notifyRoleboxChanged("graph")` (above);
  //   - a debounced watch on the state directory covers what neither hook sees
  //     — node-level writes, dispatch task files, progress and checkpoints.
  // The route turns any of them into a coalesced SSE frame; with no console
  // connected, both cost a function call and nothing else.
  routeDisposers.push(
    watchRoleboxState(process.cwd(), () => {
      notifyRoleboxChanged("file");
    }),
  );

  // Loop mode: the loop coordinator drives worker rounds through the SAME
  // dsh dispatch adapter (dispatchRound/getRoundResult/cancelRound map to
  // subagents.start / run.result / run.dispose), with a LoopStore under the
  // dsh config dir for restart recovery.
  //
  // OUT-OF-SCOPE OUTLIER (pre-existing): unlike the active-role store above
  // (and the graph/dispatch stores, all rooted at `process.cwd()`), this
  // LoopStore is still rooted at `dirs.configDir` (the dsh home, ~/.dsh). It
  // is deliberately left unchanged here to keep the wiring scoped; a
  // follow-up should align it with the workspace state home.
  const loopStore = new LoopStore(dirs.configDir);
  const loopCoordinator = new LoopCoordinator(dshDispatch, {
    delayMs: 2000,
    persist: (loops) => {
      void loopStore.save(loops);
      // The coordinator persists on EVERY state transition, which makes this
      // the loop producer's own change signal — no polling, no extra hook.
      notifyRoleboxChanged("loop");
    },
  });
  const loopTools = createLoopTools(loopCoordinator, sessionAdapter);

  // Role-snapshot registration seam (in-process role reload). The four tools
  // whose behavior is bound to the resolved-role snapshot are registered as
  // ONE disposable generation: a reload disposes the previous generation and
  // registers a fresh one from the re-resolved roles. Disposal MUST precede
  // registration — the host registry keys global tools by name and rejects a
  // duplicate (packages/core/tools/src/index.ts ToolRuntime.register →
  // packages/core/scope/src/store.ts NamedEntries.insert, which throws when
  // the name is already present); the disposer returned by register() runs
  // that insert's undo SYNCHRONOUSLY, so each name is free before the new
  // definition is registered.
  const roleSnapshotDisposers: Array<() => void> = [];
  const registerRoleSnapshotTools = (roles: ResolvedRole[]): number => {
    for (const dispose of roleSnapshotDisposers.splice(0)) {
      try {
        dispose();
      } catch (err) {
        log.debug("role-snapshot tool disposer failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const compiled = factory.compileAll(buildRoleSnapshotTools(roles));
    let registered = 0;
    for (const [key, def] of Object.entries(compiled)) {
      if (!isNamespaceEnabled(key, config.enabledNamespaces)) continue;
      const dispose = ctx.tools.register(def as DshToolDefinition);
      roleSnapshotDisposers.push(dispose);
      registered++;
    }
    return registered;
  };

  // Optional host webServer seam — register the composed `/rolebox` prefix
  // route on dsh's own web server. The role-switch surface (`/roles*`) and
  // the monitor surface (`/status`, `/metrics`) are composed into a SINGLE
  // registration — the real host webserver rejects a second `prefix /rolebox`
  // `register()` (`webserver: duplicate prefix route "/rolebox"`,
  // `@deepseek-ai/dsh-host-webserver` lib/index.js:54-55) — with the monitor
  // route owning `/status` + `/metrics` and delegating the `/roles*`
  // sub-paths to the role-switch handler via its `delegate` option. A
  // registration failure logs a warning and degrades (the plugin keeps
  // running without the web surface); the route disposer is collected into
  // the fiber disposer below.
  if (webServer) {
    try {
      // In-process, NON-DESTRUCTIVE role-reload seam. Built from the SAME
      // instances the boot path created:
      //   - `dirs` — the directories the runtime was booted from;
      //   - `resolvedRoles` — the mutable array `initializeRoleboxRuntime`
      //     returned, i.e. the exact reference the skill-provider factory
      //     captured (`roles: resolvedRoles`) and the boot role-snapshot
      //     generation reads;
      //   - `roleFunctionsMap` — the shared map the system-prompt adapter
      //     reads at render time;
      //   - `registrar` — the EXISTING DshAgentRegistrar (its `sync` is
      //     diff/idempotent, so re-syncing unchanged agents is a no-op).
      // The reloader mutates those containers IN PLACE, so every captured
      // consumer observes the re-resolved roles without re-registration.
      //
      // `refreshSkills` is `refreshSkillCatalog` (invalidate the LIVE
      // provider registration) and that is sufficient: DshSkillProvider
      // resolves `deps.roles` at `list()` time and that dependency IS the
      // array refilled by the reloader, so a fresh factory + re-register would
      // only churn the registration and orphan the captured `skillProvider`.
      // The reloader itself re-applies the project default role on the new
      // set.
      const roleboxReloader = new DshRoleboxReloader({
        directories: dirs,
        resolvedRoles,
        roleFunctionsMap,
        registrar,
        refreshRoleSnapshotTools: registerRoleSnapshotTools,
        refreshSkills: refreshSkillCatalog,
        ...(config.defaultRole ? { defaultRole: config.defaultRole } : {}),
      });
      const roleSwitchRoute = new DshRoleSwitchWebRoute(
        roleSwitcher,
        ctx.sessions,
        { reload: () => roleboxReloader.reload() },
      );
      const monitorRoute = new DshRoleboxMonitorWebRoute(
        roleSwitcher,
        ctx.sessions,
        loopCoordinator,
        process.cwd(),
        {
          delegate: (req, res) => roleSwitchRoute.handle(req, res),
        },
      );
      // From here on, every producer's signal reaches the SSE channel. Set
      // before `register` so no change can be missed between the two.
      notifyRoleboxChanged = (reason) => monitorRoute.notifyChanged(reason);
      const dispose = monitorRoute.register(webServer);
      routeDisposers.push(dispose);
      webRouteRegistered = true;
      monitorRouteRegistered = true;
      log.info("Rolebox routes registered on host web server", {
        prefix: ROLE_SWITCH_ROUTE_PREFIX,
        surfaces: "role-switch + monitor",
      });
    } catch (err) {
      log.warn("Rolebox route registration failed — degrading", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    log.debug(
      "No host web server service on ctx — skipping /rolebox route registration",
    );
  }

  // THE GRAPH FACE IS REGISTERED GLOBALLY, AND THAT IS REPORTED, NOT HIDDEN.
  // dsh's tool registry is global (rolebox's `ctx.tools` mirror exposes
  // `register`, not a per-agent scope or restriction), so a dispatched worker
  // on this host is HANDED the same four graph tools as the declaring session.
  // What rolebox enforces is the call, not the schema: `graphTools` are bound
  // through `OutcomeHost.bindTools`, which refuses every graph tool but
  // `graph_submit_outcome` when the call arrives from a session this host
  // bound as the worker of a dispatched attempt (A21 / plan §3.3), before the
  // tool body runs. Narrowing the dsh schema itself needs a platform scope
  // rolebox does not yet consume.
  const tools = {
    ...buildCanonicalTools({
      resolvedRoles,
      directory: process.cwd(),
      sessionClient: sessionAdapter,
      capabilities: dshCapabilities(),
    }),
    ...graphTools,
    ...loopTools,
  };
  const compiled = factory.compileAll(tools);

  const toolDisposers: Array<() => void> = [];
  let registeredTools = 0;
  for (const [key, def] of Object.entries(compiled)) {
    // The role-snapshot tools are registered as their own disposition-managed
    // generation below — never here, or the host's duplicate-name rejection
    // would throw on boot.
    if (key in ROLE_SNAPSHOT_TOOL_KEYS) continue;
    if (!isNamespaceEnabled(key, config.enabledNamespaces)) continue;
    // compileAll() is typed `Record<string, unknown>` (the IToolFactory port
    // contract); the compiled objects are structurally DshToolDefinition.
    const dispose = ctx.tools.register(def as DshToolDefinition);
    toolDisposers.push(dispose);
    registeredTools++;
  }
  // Initial generation: the same four tools, registered through the reload
  // seam so a later re-registration replaces them cleanly.
  registeredTools += registerRoleSnapshotTools(resolvedRoles);

  // 5. Mount hooks (rolebox hook kinds onto dsh extension points).
  const hookProvider = new DshHookProvider(ctx, {});

  // 5a. Loop-state recovery (mirrors the opencode/pi entry): reconcile
  // persisted loops against the dsh dispatch registry and re-subscribe
  // termination listeners so interrupted loops resume after a restart.
  // Best-effort — a failed load/reconcile degrades to a fresh coordinator
  // (loopWired stays true; only the persisted loops are lost).
  try {
    const loadedLoops = loopStore.load();
    if (loadedLoops && loadedLoops.size > 0) {
      const reconciled = await loopStore.reconcile(loadedLoops, async (taskId) => {
        const status = await dshDispatch.getTaskStatus(taskId);
        return { status: status ?? "unknown", exists: status !== undefined };
      });
      for (const [id, state] of reconciled) {
        loopCoordinator.restoreState(state);
      }
      await loopCoordinator.reSubscribeListeners();
      log.info("Loop state recovered", { restored: reconciled.size });
    }
  } catch (err) {
    log.warn("loop state recovery degraded — starting fresh", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 6. Log counts mirroring src/index.ts.
  const registeredAgents = (await registrar.list()).length;
  log.info("Plugin initialized", {
    discovered,
    resolved,
    skipped,
    registeredTools,
    registeredAgents,
  });
  if (discovered === 0) {
    log.info("No roles found in rolebox directory");
  }

  // Observation-only crash reporter: on uncaughtException / unhandledRejection
  // it synchronously flushes the dsh path's rolebox state (the same saves the
  // disposer below performs) and writes ONE structured log entry. It never
  // calls process.exit, never re-throws and never touches stdout; the latch in
  // the handler makes a second event a no-op. The disposer removes exactly the
  // listeners installed here.
  const fatalReporter = new ProcessFatalReporter({
    flush: () => {
      try {
        const activeRoles = activeRole.snapshot();
        if (activeRoles.size > 0) {
          activeRoleStore.saveSync(activeRoles);
        }
      } catch {
        // Best-effort — the fatal path never blocks on a failed sidecar write.
      }
      try {
        loopStore.saveSync(loopCoordinator.getAllLoopStates() ?? new Map());
      } catch {
        // Best-effort — same policy as the disposer below.
      }
      loopCoordinator.dispose();
    },
  });
  const uninstallFatalReporter = fatalReporter.install();

  // Fiber disposer (cordis convention) + stats for callers/tests.
  const disposer = (() => {
    // The crash reporter goes first: teardown failures must not be observed as
    // process-fatal events, and no handler may run after the listeners are gone.
    uninstallFatalReporter();
    // Host route + prompt-seam teardown FIRST: unmount the /rolebox routes
    // (fire-and-forget — the disposers are no-ops when the route was never
    // registered), release the system-prompt registry contributions (also
    // no-ops when the seam was never wired), and release the switcher's ctx
    // listeners (its `session/created` restore subscription) before any
    // other cleanup.
    for (const dispose of routeDisposers) {
      try {
        dispose();
      } catch (err) {
        log.debug("role-switch route disposer failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const dispose of promptDisposers) {
      try {
        dispose();
      } catch (err) {
        log.debug("system-prompt disposer failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const dispose of skillDisposers) {
      try {
        dispose();
      } catch (err) {
        log.debug("skill-provider disposer failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    roleSwitcher.dispose();
    // durability: final synchronous write of the active-role sidecar. The
    // holder's per-switch write is async/best-effort and the `session/flush`
    // checkpoint may never fire on an abrupt shutdown, so mirror the loop-store
    // sync save below to guarantee the last selection is on disk. Skipped when
    // the map is empty — there is nothing to persist, and writing an empty
    // sidecar would create (or clobber) a file for a workspace that never
    // selected a role. Best-effort: a failed write is logged and never blocks
    // fiber unload.
    try {
      const activeRoles = activeRole.snapshot();
      if (activeRoles.size > 0) {
        activeRoleStore.saveSync(activeRoles);
      }
    } catch (err) {
      log.debug("active-role state save failed during dispose", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    hookProvider.dispose();
    // Loop teardown: persist the live loop states, then stop the coordinator
    // (clears its sweeper interval + worker termination listeners).
    try {
      loopStore.saveSync(loopCoordinator.getAllLoopStates() ?? new Map());
    } catch (err) {
      log.debug("loop state save failed during dispose", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    loopCoordinator.dispose();
    loopStore.dispose();
    for (const dispose of toolDisposers) {
      try {
        dispose();
      } catch (err) {
        log.debug("tool disposer failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // The retained role-snapshot generation (the reload seam spawns a new
    // one per call, so release whichever generation is current).
    for (const dispose of roleSnapshotDisposers) {
      try {
        dispose();
      } catch (err) {
        log.debug("role-snapshot tool disposer failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Best-effort agent-catalog cleanup (dsh providers are removed via the
    // registrar's unregister → disposer chain). Fire-and-forget: fiber
    // unload is synchronous in cordis.
    registrar
      .list()
      .then((ids) => (ids.length > 0 ? registrar.unregister(ids) : undefined))
      .catch((err) => {
        log.debug("agent unregister failed during dispose", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }) as DshPluginDisposer;
  disposer.stats = {
    discovered,
    resolved,
    skipped,
    registeredTools,
    registeredAgents,
    resolvedRoles,
    dispatchMode: "dsh",
    loopWired: true,
    webRouteRegistered,
    graphNotifyWired,
    monitorRouteRegistered,
  };
  disposer.registerRoleSnapshotTools = registerRoleSnapshotTools;
  return disposer;
}

// ── Default export (object plugin shape) ───────────────────────────────────

/**
 * Default export — the object plugin shape (`{ apply(ctx, config) }`,
 * contract §2.2 `Plugin.Object`), which is what the cordis loader consumes
 * from a package's default export. The named exports above (`name`,
 * `inject`, `Config`, `apply`) are also provided for direct import.
 */
export default {
  name,
  inject,
  Config,
  apply,
};

// Type-only re-exports kept out of the plugin metadata: the dsh adapters'
// structural provider type, for consumers wiring a spawn delegate.
export type { DshSubagentProvider };
