/**
 * opencode **v2** plugin entry — the loadable `<package>/server` module.
 *
 * opencode 1.x loads `src/entries/opencode.ts` (`export default { id, server }`).
 * opencode 2.x is a separate released product (`@opencode/cli@2.0.18`) and a
 * different loader contract: it resolves a plugin entrypoint as
 * `<package>/server` and requires a default export shaped
 * `{ id, setup }` — a promise-returning `setup(context)` that may return a
 * `Cleanup` (node_modules/@opencode/plugin/dist/promise/plugin.d.ts:54-59).
 * v1 plugins are not loaded by v2, so `src/entries/opencode.ts` is untouched
 * and this file is the v2 side of the same product support.
 *
 * What it does, in order:
 *  1. v1-parity initialization (log directory, rolebox directories, role
 *     bootstrap, project config, skill symlinks) — no file registrar: v2 agents
 *     register in-process (see `opencodeV2Capabilities`).
 *  2. builds rolebox's service graph once through `createPluginHooks`
 *     (src/core/composition.ts) with the v2 session adapter and the v2
 *     capability set;
 *  3. adapts the returned **v1 handler map** onto the v2 domains —
 *     `ctx.tool.transform` / `ctx.tool.hook` / `ctx.session.hook` /
 *     `ctx.event.subscribe` — through the verified registration adapters in
 *     src/platform/adapters/opencode2/ (agents, skills, commands, tool factory,
 *     event bridge).
 *
 * FAILURE POLICY: no registration may take the host down. Every registration is
 * wrapped in `safeRegister`, and the event subscription is contained the same
 * way — a throw is logged and that single surface is skipped, exactly as
 * `createPluginHooks` degrades to no-op handlers instead of throwing
 * (src/core/composition.ts:41-62). `setup` only rejects when the service graph
 * itself fails to build, which is the same failure the v1 entry propagates.
 *
 * RUNTIME IMPORT RULE: this module's graph must not import
 * `@opencode-ai/plugin` at runtime — an opencode v2 user does not install it.
 * Everything v1-shaped here (handler signatures, canonical events) is typed
 * structurally instead. See the grep proof in
 * tests/platform/opencode2-entry.test.ts.
 */

import { Plugin } from "@opencode/plugin";
import type { Plugin as Opencode2Plugin } from "@opencode/plugin";
import {
  Opencode2SessionAdapter,
  Opencode2ToolFactory,
  collectOpencode2Skills,
  normalizeOpencode2Event,
  openOpencode2GraphHost,
  registerOpencode2Agents,
  registerOpencode2Commands,
  registerOpencode2Skills,
  type OpencodeGraphHost,
} from "../platform/adapters/opencode2/index.ts";
import {
  opencodeSessionStatusState,
  type OpencodeGraphSessionReading,
} from "../platform/adapters/opencode/graph-host.ts";
import type { CanonicalEvent } from "../platform/ports/event-bridge.ts";
import { createPluginHooks } from "../core/composition.ts";
import { roleFunctionsMap } from "../resolver/registry.ts";
import { loadProjectConfig, applyProjectConfig } from "../project-config.ts";
import { syncSkillSymlinks } from "../sync/skill-symlinks.ts";
import { PLUGIN_ID } from "../constants.ts";
import { createSubLogger, formatError, getLogFilePath, configureLogDirectory } from "../logger.ts";
import {
  resolveRoleboxDirectories,
  initializeRoleboxRuntime,
  type InitializeRuntimeOptions,
} from "../platform/factory.ts";
import { hookState } from "../hooks/state.ts";
import { functionRuntime } from "../function/runtime-state.ts";
import { sessionSignalLedger } from "../signal/session-signal-ledger.ts";
import { opencodeV2Capabilities } from "../platform/capabilities.ts";
import type { ResolvedRole } from "../types.ts";

// ── v1 handler map (structural view) ────────────────────────────────────────

/**
 * A canonical event as the v1 handler reads it
 * (src/platform/ports/event-bridge.ts, re-exported by src/platform/types.ts).
 */
interface Opencode2CanonicalEvent {
  type: string;
  rawType?: string;
  properties?: Record<string, unknown>;
}

/**
 * The subset of the v1 hook handler map this entry adapts, described
 * structurally so no `@opencode-ai/plugin` type reaches this module's runtime
 * graph. Every signature is copied from the handler the HookService installs
 * (src/core/services/hook-service.ts:192-262); `createPluginHooks` returns that
 * same map (src/core/composition.ts:176-190) and no-op objects built from
 * `satisfies Hooks` (:50-61), so this view is the entry's own narrowing of what
 * the composition promises at compile time.
 */
interface Opencode2Handlers {
  tool: Record<string, unknown>;
  event: (input: { event: Opencode2CanonicalEvent }) => Promise<void>;
  "chat.message": (
    input: { agent?: string; sessionID: string },
    output: { parts: Array<{ type: string; text?: string }> },
  ) => Promise<void>;
  "tool.execute.before": (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown },
  ) => Promise<void>;
  "tool.execute.after": (
    input: { sessionID?: string; tool?: string; args?: unknown },
    output: ToolAfterOutput,
  ) => Promise<void>;
  "experimental.chat.system.transform": (
    input: { sessionID?: string; agent?: string },
    output: { system: string[] },
  ) => Promise<void>;
  "experimental.session.compacting": (
    input: { sessionID: string },
    output: { context: string[]; prompt?: string },
  ) => Promise<void>;
  dispose?: () => Promise<void>;
}

/**
 * The post-tool output v1 hands `handleToolAfter`: the 1.x host contract is
 * `{ title: string; output: string; metadata: any }`
 * (node_modules/@opencode-ai/plugin/dist/index.d.ts:249-258), and that is how
 * every consumer reads it — the recovery guards through `output.output`
 * (src/recovery/builtin/context-window-monitor.ts:133-147), the built-in and
 * custom hooks through `{ tool, args, output }`
 * (src/hooks/tool-after.ts:49,67,133,148) and `runToolObserve`
 * (src/function/observe.ts:67-71). The v2 `execute.after` event is a union
 * pinned to `status` with `result`/`error` instead
 * (…/promise/tool.d.ts:38-51), so the adapter rebuilds the v1 object from the
 * branch the event actually carries.
 */
interface ToolAfterOutput {
  title: string;
  /** The tool text — v2 `Tool.Result.content` (…/schema/tool.d.ts:66-70). */
  output: string;
  metadata: Record<string, unknown>;
}

/** One disposable registration returned by a v2 `transform`/`hook` call. */
type Opencode2Registration = { dispose: () => Promise<void> };

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * `Plugin.Context["tool"]["hook"]` and `["session"]["hook"]` accept a callback
 * receiving their own mutable event object (…/promise/registration.d.ts:8-11).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * log-and-skip wrapper for one registration: the returned cleanup is always a
 * function, so the caller never has to branch on a failed surface, and a host
 * that rejects one registration still gets the others.
 */
async function safeRegister(
  log: ReturnType<typeof createSubLogger>,
  surface: string,
  register: () => Promise<Opencode2Registration>,
): Promise<() => Promise<void>> {
  try {
    const registration = await register();
    return async () => {
      try {
        await registration.dispose();
      } catch (err) {
        log.warn(`Failed to dispose opencode v2 ${surface} registration`, formatError(err));
      }
    };
  } catch (err) {
    log.warn(`opencode v2 ${surface} registration failed — skipping that surface`, formatError(err));
    return async () => {};
  }
}

/** Registration ids for logging — the tools the composition actually exposed. */
function toolNamesOf(handlers: Opencode2Handlers): string[] {
  return Object.entries(handlers.tool ?? {})
    .filter(([name, def]) => name.length > 0 && def !== undefined)
    .map(([name]) => name);
}

/** Build the v1 `{ args }` view of a v2 tool event and write mutations back. */
function toolArgsView(event: { input: unknown }): { args: unknown } {
  return { args: event.input };
}

/**
 * Rebuild the v1 `output` string from a v2 `Tool.Result`
 * (…/schema/tool.d.ts:66-70): the tool text lives in `content` — either a plain
 * string or `{ type: "text", text }` blocks mixed with `{ type: "file", … }`
 * blocks — with the tool's declared `output` value as the fallback. rolebox's
 * compiled tools put their text in `content`
 * (src/platform/adapters/opencode2/tool-factory.ts:85-116), so a v2 result read
 * as a v1 output object carries the tool text instead of degrading to
 * `JSON.stringify(output)` in the recovery guards.
 */
function toolResultOutput(result: unknown): string {
  if (!isRecord(result)) return result === undefined || result === null ? "" : String(result);
  const content = result.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .filter((part) => part.length > 0)
      .join("\n");
    if (text.length > 0) return text;
  }
  return result.output === undefined || result.output === null ? "" : String(result.output);
}

/**
 * The v1 `title` of a v2 `Tool.Result`. rolebox's own tools fold the canonical
 * title into `result.metadata.title`
 * (src/platform/adapters/opencode2/tool-factory.ts:94-100).
 */
function toolResultTitle(result: unknown): string {
  if (!isRecord(result)) return "";
  const metadata = result.metadata;
  if (!isRecord(metadata) || typeof metadata.title !== "string") return "";
  return metadata.title;
}

/** The v1 `metadata` of a v2 `Tool.Result` — the host's own object. */
function toolResultMetadata(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) return {};
  const metadata = result.metadata;
  return isRecord(metadata) ? metadata : {};
}

/** The v1 `output` string of a v2 `Tool.Error` (…/schema/tool.d.ts:35-41, message at 36). */
function toolErrorOutput(error: unknown): string {
  if (typeof error === "string") return error;
  if (isRecord(error)) {
    if (typeof error.message === "string") return error.message;
    if (typeof error.error === "string") return error.error;
  }
  return error === undefined || error === null ? "" : String(error);
}

/** The v1 `metadata` of a v2 `Tool.Error` — empty when the error carries none. */
function toolErrorMetadata(error: unknown): Record<string, unknown> {
  if (!isRecord(error)) return {};
  const metadata = error.metadata;
  return isRecord(metadata) ? metadata : {};
}

/**
 * The agent acting in `sessionID` on opencode v2, or `undefined` when no
 * surface will say.
 *
 * `SessionPrompt` carries no agent (…/promise/session.d.ts:13-19), so the v2
 * prompt hook cannot read it off its own event the way the 1.x host does. Two
 * surfaces can still answer, in order of authority:
 *
 *  1. `ctx.session.get({ sessionID })` — `SessionDomain` exposes `get`
 *     (…/promise/session.d.ts:143-145) and the returned `SessionInfo` carries
 *     the session's acting agent as `agent?: string`
 *     (…/generated/types.d.ts:2788-2814). The host owns the session and
 *     `ctx.session.switchAgent` mutates exactly this value, so the host is
 *     asked FIRST: a switch between turns is observed on the next turn.
 *  2. `hookState.sessionAgentRegistry` — the value the plugin resolved on a
 *     previous turn, written by `handleChatMessage` from that turn's
 *     `input.agent` (src/hooks/chat-message.ts:102-104) and by the context
 *     hook from `SessionContext.agent` (src/entries/opencode2.ts:3d). It is
 *     the FALLBACK, consulted only when the host exposes no `get`, rejects
 *     the call, or answers without an agent.
 *
 * Deliberately not cached: `ctx.session.switchAgent` changes the acting agent
 * between turns, and a per-turn memo is what would keep the stale one. The
 * `get` is one call on a user turn, not on a model request.
 *
 * Every failure mode is a degradation, never a turn failure: no `get` on the
 * host, a rejected call, or a session with no agent all fall through to the
 * recorded mapping (or to `undefined`), and `chat.message` sees the same input
 * shape it saw before this lookup existed.
 */
async function resolveOpencode2SessionAgent(
  ctx: Opencode2Plugin.Context,
  log: ReturnType<typeof createSubLogger>,
  sessionID: string,
): Promise<string | undefined> {
  if (sessionID.length > 0 && typeof ctx.session.get === "function") {
    try {
      const session = await ctx.session.get({ sessionID });
      const agent = session?.agent;
      if (typeof agent === "string" && agent.length > 0) return agent;
    } catch (err) {
      log.debug("opencode v2 session.get failed — using the recorded agent", formatError(err));
    }
  }
  const recorded = hookState.sessionAgentRegistry.get(sessionID);
  return typeof recorded === "string" && recorded.length > 0 ? recorded : undefined;
}

/**
 * The agent acting in `sessionID`, as the DECLARED-GRAPH host must state it.
 *
 * The host's resolver answers with the acting agent of a session it is about to
 * dispatch into (`GraphApplication.createTools(getEffectiveAgent)`) and is
 * synchronous, so it reads the same recorded mapping the rest of the entry
 * falls back to (src/entries/opencode2.ts, the `session.context` hook and
 * `resolveOpencode2SessionAgent`) and answers `""` — the host's own default —
 * when nothing was recorded. Reading only the in-process map keeps this call
 * free of host I/O: the async `ctx.session.get` read belongs to the turn path,
 * not to a tool call.
 */
function graphEffectiveAgent(sessionID?: string): string {
  if (typeof sessionID !== "string" || sessionID.length === 0) return "";
  const recorded = hookState.sessionAgentRegistry.get(sessionID);
  return typeof recorded === "string" ? recorded : "";
}

/**
 * Feed the declared-graph host every session end the event stream reports.
 *
 * The events here are already NORMALIZED (src/platform/adapters/opencode2/
 * event-bridge.ts): `session.idle` keeps its canonical name, and v2's error
 * carrier `session.execution.failed` normalizes to the canonical
 * `session.error` — so both are matched on the canonical type. A host that
 * could not be built is a no-op, and nothing here throws into the relay.
 */
function noteGraphSessionEnd(
  graphHost: OpencodeGraphHost | undefined,
  event: CanonicalEvent,
  log: ReturnType<typeof createSubLogger>,
): void {
  if (graphHost === undefined) return;
  if (event.type !== "session.idle" && event.type !== "session.error") return;
  const sessionID = event.properties["sessionID"];
  if (typeof sessionID !== "string" || sessionID.length === 0) {
    log.debug("opencode v2 session end carried no session id", {
      type: event.type,
      rawType: event.rawType,
    });
    return;
  }
  graphHost.noteSessionEnded(sessionID, event.type === "session.error" ? "errored" : "ended");
}

/**
 * Feed the declared-graph host the typed activity state of every
 * `session.status` event.
 *
 * THE EVENTS HERE ARE ALREADY NORMALIZED (src/platform/adapters/opencode2/
 * event-bridge.ts): `session.status` keeps its canonical name and its payload
 * (`{ sessionID, status }`) is lifted into `properties`. The status object is
 * narrowed by the ONE reader both entries share
 * (`opencodeSessionStatusState`), so a payload of an unexpected shape — this
 * platform's own `status` is the typed `{ type: "idle" | "busy" | "retry" }`
 * union, and an odd one must change nothing — leaves the host exactly as it was.
 * The feed records STATE ONLY: it settles nothing, and an `idle` state is not a
 * completion.
 */
function noteGraphSessionStatus(
  graphHost: OpencodeGraphHost | undefined,
  event: CanonicalEvent,
  log: ReturnType<typeof createSubLogger>,
): void {
  if (graphHost === undefined) return;
  if (event.type !== "session.status") return;
  const sessionID = event.properties["sessionID"];
  if (typeof sessionID !== "string" || sessionID.length === 0) {
    log.debug("opencode v2 session.status carried no session id", {
      rawType: event.rawType,
    });
    return;
  }
  const state = opencodeSessionStatusState(event.properties["status"]);
  if (state === undefined) {
    log.debug("opencode v2 session.status carried no state the host reads", {
      sessionID,
      rawType: event.rawType,
    });
    return;
  }
  graphHost.noteSessionStatus(sessionID, state);
}

/**
 * THE SESSION'S OWN READING, read from v2's raw session domain.
 *
 * `ctx.session.get` returns the platform's `Session.Info`
 * (node_modules/@opencode/client/dist/promise/generated/types.d.ts:2788-2814,
 * through `SessionDomain`'s `get`, …/plugin/dist/promise/session.d.ts:143-145),
 * whose `outcome` is `"succeeded" | "failed" | "interrupted"` — the ONE place
 * this platform records how a finished session went. `time.idle` is deliberately
 * NOT read: a state decision taken from a timestamp's name would be an
 * inference, and `state` stays `null` because v2 exposes no per-session status
 * CALL — that half comes from the typed `session.status` event feed.
 *
 * A REJECTED READ IS A THROWN READ, not a silent `null`: the host contains it,
 * reports the thrown text and settles nothing, which is more honest than
 * answering "no outcome" to a question the platform refused to answer. The
 * `ISessionClient`-shaped degradation is unchanged for every other caller — this
 * read exists only for the declared-graph host.
 */
async function readOpencode2SessionReading(
  session: Opencode2Plugin.Context["session"],
  sessionID: string,
): Promise<OpencodeGraphSessionReading | null> {
  // `.call(session, …)`: the domain method is invoked on its own domain, the
  // same way the entry invokes `ctx.session.wait`.
  const info = await session.get.call(session, { sessionID });
  const outcome = info?.outcome;
  return {
    state: null,
    ...(outcome === "succeeded" || outcome === "failed" || outcome === "interrupted"
      ? { outcome }
      : {}),
  };
}

/**
 * The v2 event stream subscription. `ctx.event.subscribe` is declared on the
 * plugin Context without parameters (…/promise/event.d.ts:2-3), while the
 * promise client behind it accepts `{ signal }`
 * (…/client/dist/promise/client.d.ts:10-11). The signal is therefore optional
 * here and only passed when the host's own function advertises it; cleanup also
 * races the iterator, so a host that ignores the signal still stops.
 */
interface Opencode2EventSubscription extends AsyncIterable<unknown> {
  return?: () => Promise<IteratorResult<unknown>>;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

// ── Entry factory ───────────────────────────────────────────────────────────

/** Injected dependencies — overridden by tests to drive the wiring without booting the service graph. */
export interface Opencode2EntryDeps {
  createHooks: typeof createPluginHooks;
  /** The declared-graph host factory. Tests inject a spy; production uses the real one. */
  openGraphHost?: typeof openOpencode2GraphHost;
  initializeRuntime: (options: InitializeRuntimeOptions) => Promise<{
    resolvedRoles: ResolvedRole[];
    discovered: number;
    resolved: number;
    skipped: number;
  }>;
}

const defaultDeps: Opencode2EntryDeps = {
  createHooks: createPluginHooks,
  openGraphHost: openOpencode2GraphHost,
  initializeRuntime: initializeRoleboxRuntime,
};

/**
 * Build the v2 plugin definition. Exported for tests: the returned object is
 * exactly what `Plugin.define` returns, so asserting its shape asserts the
 * loader contract.
 */
export function createOpencode2Plugin(
  deps: Opencode2EntryDeps = defaultDeps,
): Opencode2Plugin.Plugin {
  return Plugin.define({
    id: PLUGIN_ID,

    async setup(ctx: Opencode2Plugin.Context): Promise<Opencode2Plugin.Cleanup> {
      const directory = ctx.location.directory;
      configureLogDirectory(directory);

      const dirs = resolveRoleboxDirectories({ workingDir: directory, platformId: "opencode" });
      const log = createSubLogger("opencode2-entry");

      // 1. Roles. Bootstrap failure is contained: a broken role file must not
      //    stop the tool/hook surfaces from registering (the v1 entry throws
      //    here; the v2 loader treats a rejected setup as a broken plugin).
      let resolvedRoles: ResolvedRole[] = [];
      let discovered = 0;
      try {
        const boot = await deps.initializeRuntime({
          directories: dirs,
          roleFunctionsMap,
        });
        resolvedRoles = boot.resolvedRoles;
        discovered = boot.discovered;
      } catch (err) {
        log.error("Role bootstrap failed — continuing with no roles", formatError(err));
      }

      const projectConfig = loadProjectConfig(directory);
      if (projectConfig?.defaultRole) {
        applyProjectConfig(resolvedRoles, projectConfig);
      }

      syncSkillSymlinks(resolvedRoles, dirs.globalSkillsDir);

      // 2. The session adapter, built ONCE and shared by the service graph and
      //    the declared-graph host: one adapter per plugin context, like the v1
      //    entry (src/entries/opencode.ts).
      const sessionAdapter = new Opencode2SessionAdapter(ctx.session);

      // 2b. The declared-graph host capability layer (the OUTCOME run path).
      //     Built BEFORE the composition so the five `graph_*` tools it binds
      //     travel in as `outcomeGraphTools` (src/core/composition.ts:107-111).
      //     Opening it touches disk — it creates the host-owned store root under
      //     the rolebox data directory (src/graph/store/schema.ts:58-60) — so a
      //     host that cannot be opened is CONTAINED here, never propagated: this
      //     entry's FAILURE POLICY is that no registration takes the host down.
      //     A partial Context with no `ctx.session.wait` degrades to no wait
      //     rather than throwing (the wait is never synthesized).
      let graphHost: OpencodeGraphHost | undefined;
      try {
        const sessionWait = ctx.session.wait;
        // THE PLATFORM'S OWN READ OF A SESSION'S TERMINAL OUTCOME. A context
        // with no usable `get` degrades to NO read — exactly like a missing
        // `wait` — instead of installing one that could only ever fail, so the
        // host's platformNotes stay truthful about what it can read.
        const sessionGet = ctx.session.get;
        graphHost = (deps.openGraphHost ?? openOpencode2GraphHost)({
          directory,
          client: sessionAdapter,
          // THE DECLARING SESSION'S WAKE-UP CHANNEL, named at this seam as well as
          // derived by the factory: the host pushes the shipped
          // `[GRAPH COMPLETE] / [GRAPH BLOCKED]` reminder into the session that
          // DECLARED a graph at a terminal or attention state, instead of leaving
          // that agent to poll `graph_status`. It is the SAME adapter the host
          // dispatches over — never a second one.
          notifyClient: sessionAdapter,
          // THE SESSION'S OWN TERMINAL OUTCOME, read from the RAW domain:
          // `ctx.session.get` returns the platform's `Session.Info`, which
          // carries `outcome` — while the canonical `SessionInfo` the adapter
          // projects it onto has no such slot, so no `ISessionClient` read can
          // supply it. This is the one place v2 records how a finished session
          // went, and the host turns it into a completion (`succeeded`) or a
          // failed execution (`failed` / `interrupted`).
          ...(typeof sessionGet === "function"
            ? {
                observe: (input: { sessionID: string }) =>
                  readOpencode2SessionReading(ctx.session, input.sessionID),
              }
            : {}),
          ...(typeof sessionWait === "function"
            ? { wait: (input: { sessionID: string }) => sessionWait.call(ctx.session, input) }
            : {}),
          env: process.env,
          getEffectiveAgent: (sessionID) => graphEffectiveAgent(sessionID),
        });
      } catch (err) {
        log.warn(
          "opencode v2 graph host unavailable — the declared-graph tools will not register",
          formatError(err),
        );
      }

      // 2c. Service graph. Same composition the v1 entry uses; it installs the
      //    process-level shutdown/flush handlers exactly once per process
      //    (src/core/composition.ts:141-160), which is what the cleanup below
      //    reuses for an orderly v2 shutdown.
      const handlers = (await deps.createHooks({
        resolvedRoles,
        session: sessionAdapter,
        roleFunctionsMap,
        directory,
        roleboxDir: dirs.roleboxDir,
        globalSkillsDir: dirs.globalSkillsDir,
        configDir: dirs.configDir,
        builtinDir: dirs.builtinDir,
        capabilities: opencodeV2Capabilities(),
        ...(graphHost === undefined ? {} : { outcomeGraphTools: graphHost.createTools() }),
      })) as unknown as Opencode2Handlers;

      // 2d. What the declared-graph host installed or had to degrade, one line
      //     each — the completion channel, the observation read, the cancel port
      //     and the run-notification channel (the wake-up channel is supplied by
      //     the v2 host factory over the same session adapter) — so an operator
      //     can see them in the log.
      if (graphHost !== undefined) {
        for (const note of graphHost.platformNotes) log.info(note);
      }

      log.info("Plugin initialized", {
        discovered,
        roles: resolvedRoles.length,
        tools: toolNamesOf(handlers).length,
        logFile: getLogFilePath(),
      });

      const disposers: Array<() => Promise<void>> = [];

      // 3a. Tools — one editor.add per canonical tool.
      const toolFactory = new Opencode2ToolFactory({ directory });
      const compiled = toolFactory.compileAll(
        (handlers.tool ?? {}) as Parameters<Opencode2ToolFactory["compileAll"]>[0],
      );
      disposers.push(
        await safeRegister(log, "tool", () =>
          ctx.tool.transform((editor) => {
            for (const [name, tool] of Object.entries(compiled)) {
              if (name.length === 0 || tool === undefined) continue;
              editor.add(tool as never);
            }
          }),
        ),
      );

      // 3b. Tool execute hooks. v2 hands ONE mutable event; v1 splits it into
      //     `input` (ids) + `output` ({ args }). The adapter recreates the v1
      //     pair over the event's live `input` field and writes back whatever
      //     the handler mutated, so recovery guards that rewrite args keep
      //     working (src/hooks/tool-before.ts:48-70).
      disposers.push(
        await safeRegister(log, "tool.execute.before", () =>
          ctx.tool.hook("execute.before", async (event) => {
            const view = toolArgsView(event);
            await handlers["tool.execute.before"](
              { tool: event.tool, sessionID: event.sessionID, callID: event.id },
              view,
            );
            if (view.args !== event.input) event.input = view.args;
          }),
        ),
      );

      //     `execute.after`: the v2 event carries `status` + `result`/`error`,
      //     while `handleToolAfter` reads the v1 output object — `output.output`
      //     for the recovery guards and `input.args` for its own checks — so the
      //     event is folded back into `{ title, output, metadata }`.
      disposers.push(
        await safeRegister(log, "tool.execute.after", () =>
          ctx.tool.hook("execute.after", async (event) => {
            const output: ToolAfterOutput =
              event.status === "completed"
                ? {
                    title: toolResultTitle(event.result),
                    output: toolResultOutput(event.result),
                    metadata: toolResultMetadata(event.result),
                  }
                : {
                    title: "",
                    output: toolErrorOutput(event.error),
                    metadata: toolErrorMetadata(event.error),
                  };
            await handlers["tool.execute.after"](
              { sessionID: event.sessionID, tool: event.tool, args: event.input },
              output,
            );
          }),
        ),
      );

      // 3c. User prompt → v1 `chat.message`. `SessionPrompt` itself carries no
      //     agent id (…/promise/session.d.ts:13-19), but the agent is what
      //     scopes everything `handleChatMessage` does with a turn: role
      //     auto-activation, role-scoped `|fn|` validation and the `|loop|`
      //     start path all read `input.agent`
      //     (src/hooks/chat-message.ts:105-113,134-140,150), while only the
      //     tool-hook contexts, copilot role resolution and the
      //     system-transform fallback read the recorded map
      //     (src/hooks/tool-after.ts:41,59,129,144, src/copilot/pipeline.ts:98,
      //     src/copilot/sources/builtin.ts:155,
      //     src/hooks/system-transform.ts:64). So the acting agent is resolved
      //     BEFORE the hook body runs and passed into the v1 input, which is
      //     what makes the turn take the scoped v1 path instead of the
      //     unscoped fallback (src/hooks/chat-message.ts:146).
      //
      //     Source 1 is the session itself: `ctx.session.get({ sessionID })`
      //     returns SessionInfo, whose `agent?: string` is the session's
      //     CURRENT acting agent (…/promise/session.d.ts:143-145,
      //     …/generated/types.d.ts:2788-2814) — the same value the context
      //     hook records at 3d, and the value `ctx.session.switchAgent`
      //     mutates. It is read on the turn that needs it and not cached, so
      //     a `switchAgent` between turns is observed on the next one.
      //     Source 2, the fallback, is `sessionAgentRegistry`, the map the v1
      //     writer fills from a previous turn's `input.agent`
      //     (src/hooks/chat-message.ts:102-104); it answers when the host has
      //     no `get`, rejects the call, or reports no agent. A failing read
      //     therefore logs and continues with the recorded agent or with no
      //     agent — the pre-repair behavior — and can never fail the turn.
      disposers.push(
        await safeRegister(log, "session.prompt", () =>
          ctx.session.hook("prompt", async (event) => {
            if (typeof event.prompt?.text !== "string") return;
            const agent = await resolveOpencode2SessionAgent(ctx, log, event.sessionID);
            const output = { parts: [{ type: "text", text: event.prompt.text }] };
            await handlers["chat.message"](
              agent === undefined
                ? { sessionID: event.sessionID }
                : { sessionID: event.sessionID, agent },
              output,
            );
            // Write the (possibly normalized) text back onto the live prompt.
            const text = output.parts.find((part) => part.type === "text")?.text;
            if (typeof text === "string" && text !== event.prompt.text) {
              event.prompt.text = text;
            }
          }),
        ),
      );

      // 3d. System prompt → v1 `experimental.chat.system.transform`, mapped in
      //     BOTH directions: v2 sends `SystemPart[]` ({ type:"text", text,
      //     cache?, metadata? }, …/ai/dist/schema/messages.d.ts:7-13) and the
      //     v1 handler mutates `string[]`.
      //
      //     The `context` hook is the agent loop's own request — `SessionContext`
      //     (…/promise/session.d.ts:29-35); the auxiliary compaction/title
      //     requests have their own hook names — so the `agent` it carries is
      //     the session's acting agent. Recording it here keeps
      //     `hookState.sessionAgentRegistry` populated from the loop's own
      //     request; the prompt hook does not depend on this write (it resolves
      //     the agent itself, see 3c), so this is a second source, not the only
      //     one. The registry is read by every `tool.execute.after` hook context
      //     (src/hooks/tool-after.ts:41,59,129,144), by copilot's role
      //     resolution (src/copilot/pipeline.ts:98,
      //     src/copilot/sources/builtin.ts:155) and as the fallback when the
      //     system-transform input carries no agent
      //     (src/hooks/system-transform.ts:64) — on v2 the entry passes
      //     `SessionContext.agent` explicitly, so that fallback is not needed
      //     here.
      disposers.push(
        await safeRegister(log, "session.context", () =>
          ctx.session.hook("context", async (event) => {
            if (event.sessionID && event.agent) {
              hookState.sessionAgentRegistry.set(event.sessionID, String(event.agent));
            }
            const original = event.system;
            const view = { system: original.map((part) => part.text) };
            await handlers["experimental.chat.system.transform"](
              { sessionID: event.sessionID, agent: String(event.agent) },
              view,
            );
            // Rebuild only what the handler touched. A part whose text is
            // unchanged keeps its ORIGINAL object — and with it the v2 cache
            // hint and metadata (…/ai/dist/schema/messages.d.ts:7-13) — while a
            // rewritten or appended part becomes plain `{ type: "text", text }`,
            // because the `string[]` view cannot carry those fields
            // (docs/compatibility.md §opencode v2 limitations).
            event.system = view.system.map((text, index) => {
              const previous = original[index];
              return previous !== undefined && previous.text === text
                ? previous
                : { type: "text" as const, text };
            });
          }),
        ),
      );

      // 3e. Compaction. v1's `experimental.session.compacting` output is
      //     `{ context: string[]; prompt?: string }` and `handleCompacting`
      //     pushes its runtime-state block into `context`
      //     (src/hooks/compaction.ts:102). v2's `SessionCompaction` has NO
      //     `context` field — it extends `SessionContext` and exposes
      //     `result?: SessionCompactionResult` (…/promise/session.d.ts:42-45,
      //     :29-35).
      //
      //     `result` is NOT a metadata side channel: the published contract is
      //     "Set to use this compaction and skip the model request"
      //     (…/promise/session.d.ts:43) and `SessionCompactionResult.summary`
      //     is REQUIRED (:37). Fabricating a result therefore does not annotate
      //     a compaction, it REPLACES it with the fabricated summary and skips
      //     the model request — which is why this hook never invents one:
      //
      //       - no `result` yet (the normal case): the block is appended to the
      //         compaction REQUEST as one `SystemPart` on `event.system`, the
      //         mutable `Array<SystemPart>` every session hook receives
      //         (…/promise/session.d.ts:22-28), so the compaction summary is
      //         still produced by the model and the block travels with the
      //         request that produced it. This is the same request-mutation
      //         shape as the system-transform mapping at 3d. It is a
      //         HOST-READBACK DEPENDENCY: a v2 host that ignores a hook's
      //         mutations drops the block (documented in
      //         docs/compatibility.md §opencode v2 limitations).
      //       - `result` already set by another plugin: that compaction is
      //         already decided, so its `summary` is preserved VERBATIM and the
      //         block rides along in `result.metadata["rolebox.context"]`. A
      //         model request that will not happen cannot be extended.
      //     `view.context` is an ARRAY of blocks and is joined into that one
      //     part rather than spread over several, so the joined text is exactly
      //     the v1 handler's output. `view.prompt` stays ignored — no rolebox
      //     handler sets it (src/hooks/compaction.ts writes only `context`), and
      //     v2 has no equivalent field to carry it on, so it is not invented.
      disposers.push(
        await safeRegister(log, "session.compaction", () =>
          ctx.session.hook("compaction", async (event) => {
            const view: { context: string[]; prompt?: string } = { context: [] };
            await handlers["experimental.session.compacting"]({ sessionID: event.sessionID }, view);
            if (view.context.length === 0) return;
            if (event.result === undefined) {
              event.system.push({ type: "text", text: view.context.join("\n") });
              return;
            }
            event.result = {
              ...event.result,
              summary: event.result.summary,
              metadata: {
                ...(event.result.metadata ?? {}),
                "rolebox.context": view.context,
              },
            };
          }),
        ),
      );

      // 3f. Roles → agents. v2 registers in process; the editor has no `add`,
      //     so the adapter upserts every role and sub-agent via `update`.
      disposers.push(
        await safeRegister(log, "agent", () =>
          registerOpencode2Agents(ctx.agent, resolvedRoles),
        ),
      );

      // 3g. Skills. The bodies are read BEFORE the transform runs — a
      //     `transform` callback is synchronous, so an `await` inside it would
      //     register nothing.
      disposers.push(
        await safeRegister(log, "skill", async () => {
          const skills = await collectOpencode2Skills(resolvedRoles);
          return ctx.skill.transform((editor) => {
            for (const skill of skills) editor.add(skill as never);
          });
        }),
      );

      // 3h. `/stop-loop`.
      disposers.push(
        await safeRegister(log, "command", () =>
          registerOpencode2Commands(ctx.command, ctx.session),
        ),
      );

      // 3i. Event stream → v1 `event` handler, consumed in the background so
      //     setup never blocks on the host's stream. Every event is also fed to
      //     the declared-graph host, which is how a dispatched session's END
      //     (session.idle / session.error) AND its typed activity state
      //     (session.status: idle / busy / retry) reach it: on this platform the
      //     event stream IS the completion channel the entry installs
      //     (`sessionEndFeed: true`, src/platform/adapters/opencode2/graph-host.ts)
      //     and the only current source for `state` — v2 exposes no status call.
      const abort = new AbortController();
      const disposeSubscription = startEventRelay(ctx, handlers, log, abort, (event) => {
        noteGraphSessionEnd(graphHost, event, log);
        noteGraphSessionStatus(graphHost, event, log);
      });

      // 4. Cleanup.
      return async () => {
        abort.abort();
        disposeSubscription();
        // Release the declared-graph host BEFORE the rolebox state is flushed:
        // its watches and its application are closed here, and a store that
        // cannot be closed must not stop the flush below.
        try {
          graphHost?.close();
        } catch (err) {
          log.warn("Failed to close the opencode v2 declared-graph host", formatError(err));
        }
        for (const dispose of disposers) {
          try {
            await dispose();
          } catch (err) {
            log.warn("Failed to dispose an opencode v2 registration", formatError(err));
          }
        }
        try {
          await handlers.dispose?.();
        } catch (err) {
          log.warn("Failed to dispose rolebox hook handlers", formatError(err));
        }
        flushRoleboxState();
      };
    },
  });
}

/**
 * Consume the v2 event stream in the background and relay every event into the
 * v1 `event` handler through `normalizeOpencode2Event`
 * (src/platform/adapters/opencode2/event-bridge.ts:172). Never throws: a host
 * whose `subscribe` — or whose iterator acquisition — throws is logged and
 * yields a no-op disposer, the same containment `safeRegister` gives every
 * other surface, so the rest of the plugin still registers (the entry's FAILURE
 * POLICY above). A stream error after that stops only the relay.
 */
function startEventRelay(
  ctx: Opencode2Plugin.Context,
  handlers: Opencode2Handlers,
  log: ReturnType<typeof createSubLogger>,
  abort: AbortController,
  /**
   * Optional observer of every NORMALIZED canonical event, invoked AFTER the v1
   * handler ran. Optional so the existing callers and tests are unaffected. The
   * relay awaits it and contains it, so an observer that throws stops neither
   * the relay nor the handler pipeline.
   */
  onCanonical?: (event: CanonicalEvent) => void | Promise<void>,
): () => void {
  let subscription: Opencode2EventSubscription;
  let iterator: AsyncIterator<unknown>;
  try {
    const subscribe = ctx.event.subscribe as (options?: { signal?: AbortSignal }) => Opencode2EventSubscription;
    subscription = subscribe.length > 0 ? subscribe({ signal: abort.signal }) : subscribe();
    iterator = subscription[Symbol.asyncIterator]();
  } catch (err) {
    log.warn("opencode v2 event.subscribe failed — skipping the event stream", formatError(err));
    return () => {};
  }
  let stopped = false;
  // ONE abort listener for the relay's whole lifetime. A fresh promise per
  // iteration would leave a registered listener behind every time
  // `iterator.next()` won the race, so the list (and the pending resolver and
  // the closure it holds) would grow with the session's event count, and a
  // Node-backed EventTarget would warn past its listener ceiling. The same
  // promise is raced on every iteration instead.
  const aborted = new Promise<{ done: true }>((resolve) => {
    abort.signal.addEventListener("abort", () => resolve({ done: true }), { once: true });
  });

  void (async () => {
    try {
      for (;;) {
        if (stopped) break;
        // Race the next event against cleanup so a host that ignores the abort
        // signal cannot hold the relay open forever.
        const next = await Promise.race([iterator.next(), aborted]);
        if (next.done) break;
        const event = normalizeOpencode2Event(next.value);
        await handlers.event({ event: event as Opencode2CanonicalEvent });
        if (onCanonical !== undefined) {
          try {
            await onCanonical(event);
          } catch (err) {
            log.warn("opencode v2 event observer failed", formatError(err));
          }
        }
      }
    } catch (err) {
      if (!stopped) log.warn("opencode v2 event stream ended", formatError(err));
    }
  })();

  return () => {
    stopped = true;
    // Best-effort: close the host iterator so the stream stops buffering.
    try {
      void subscription.return?.();
    } catch {
      /* the subscription is already gone — nothing to close */
    }
  };
}

/**
 * Flush rolebox's persisted state synchronously on host shutdown.
 *
 * This mirrors the composition's own `flushAllSync`
 * (src/core/composition.ts:135-146), which is already installed as the
 * process-level `exit`/`SIGINT`/`SIGTERM` handler: the cleanup path writes the
 * same state through the same stores so a v2 shutdown (plugin scope disposed
 * while the process lives on) does not lose loop, dispatch or function state.
 */
function flushRoleboxState(): void {
  const log = createSubLogger("opencode2-entry");
  for (const [dir, manager] of hookState.loopManagerMap) {
    try {
      hookState.loopStoreMap.get(dir)?.saveSync(manager.getAllLoopStates());
    } catch (err) {
      log.warn("flushRoleboxState saveSync failed for directory", dir, formatError(err));
    }
    try {
      manager.dispose();
    } catch (err) {
      log.warn("flushRoleboxState loop manager dispose failed", formatError(err));
    }
  }
  try {
    functionRuntime.flushSync();
    sessionSignalLedger.flushSync();
  } catch (err) {
    log.warn("flushRoleboxState runtime flush failed", formatError(err));
  }
}

export default createOpencode2Plugin();
