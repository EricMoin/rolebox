import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { OpencodeAgentRegistrar } from "../platform/adapters/opencode/agent-registrar.ts";
import { syncSkillSymlinks } from "../sync/skill-symlinks.ts";
import { createPluginHooks } from "../core/composition.ts";
import { OpencodeSessionAdapter } from "../platform/adapters/opencode/session.ts";
import {
  OpencodeGraphHost,
  opencodeGraphSessionPort,
  opencodeSessionStatusState,
} from "../platform/adapters/opencode/graph-host.ts";
import { graphStoreRoot } from "../graph/store/schema.ts";
import { getDataDir } from "../cli/paths.ts";
export { loopManagerMap, activeLoopManager } from "../core/composition.js";
import { roleFunctionsMap } from "../resolver/registry.ts";
export { roleFunctionsMap } from "../resolver/registry.ts";
import { loadProjectConfig, applyProjectConfig } from "../project-config.ts";
import { PLUGIN_ID } from "../constants.ts";
import { createSubLogger, formatError, getLogFilePath, configureLogDirectory } from "../logger.ts";
import { resolveRoleboxDirectories, initializeRoleboxRuntime } from "../platform/factory.ts";
import { opencodeCapabilities } from "../platform/capabilities.ts";

const RoleboxPlugin: Plugin = async (ctx: PluginInput) => {
  configureLogDirectory(ctx.directory);

  const dirs = resolveRoleboxDirectories({
    workingDir: ctx.directory,
    platformId: "opencode",
  });

  const log = createSubLogger("init");

  // The session adapter is built ONCE and shared: the declared-graph host
  // dispatches through the same adapter the service graph does.
  const sessionAdapter = new OpencodeSessionAdapter(ctx.client);

  const { resolvedRoles, discovered, resolved, skipped } =
    await initializeRoleboxRuntime({
      directories: dirs,
      roleFunctionsMap,
      registrar: new OpencodeAgentRegistrar(),
    });

  // Apply project-level config (`.rolebox/config.json`) if present
  const projectConfig = loadProjectConfig(ctx.directory);
  if (projectConfig?.defaultRole) {
    applyProjectConfig(resolvedRoles, projectConfig);
  }

  syncSkillSymlinks(resolvedRoles, dirs.globalSkillsDir);

  // The declared-graph host capability layer (the OUTCOME run path) behind the
  // five `graph_*` tools. OPENING IT TOUCHES DISK — it creates the host-owned
  // store root under the rolebox data directory, which is deliberately OUTSIDE
  // the workspace (src/graph/store/schema.ts:58-60; the store root key
  // normalizes the workspace itself, src/utils/state-paths.ts:26-37). A store
  // that cannot be opened must therefore never take the plugin down: the throw
  // is CONTAINED here and the plugin registers without the graph face.
  //
  // The workspace handed to the host is `ctx.directory` — the same directory
  // the adapter and the agent registrar use — and the session port is the v1
  // adapter WITHOUT a wait: opencode 1.x exposes no session-turn-end call, so
  // none is synthesized. Its `abort` IS the platform's interrupt, so the port
  // installs it; `sessionEndFeed` is what makes the wrapped `event` handler
  // below the completion channel (a session with no armed wait answers
  // `watching` because this entry feeds every session end it sees).
  //
  // THE SAME ADAPTER IS ALSO THE DECLARING SESSION'S WAKE-UP CHANNEL: the
  // channel is what pushes the shipped `<system-reminder>[GRAPH COMPLETE] /
  // [GRAPH BLOCKED]` payload into the session that DECLARED a graph when its run
  // reaches a terminal or attention state, instead of leaving that agent to poll
  // `graph_status`. The v1 adapter's `prompt` forwards `noReply: false`
  // (src/platform/adapters/opencode/session.ts:210-245), which is what makes
  // opencode run a turn on the notification. One adapter is built per plugin
  // context and shared; no second one is constructed for notifications.
  let graphHost: OpencodeGraphHost | undefined;
  try {
    graphHost = OpencodeGraphHost.open({
      workspaceDir: ctx.directory,
      storeRoot: graphStoreRoot(getDataDir(), ctx.directory),
      session: opencodeGraphSessionPort(sessionAdapter),
      notifyClient: sessionAdapter,
      sessionEndFeed: true,
      env: process.env,
    });
  } catch (err) {
    log.warn(
      "opencode graph host unavailable — the declared-graph tools will not register",
      formatError(err),
    );
  }

  // One line per capability the host installed or had to degrade (the
  // completion channel, the observation read, the cancel port, and the
  // run-notification channel).
  if (graphHost !== undefined) {
    for (const note of graphHost.platformNotes) log.info(note);
  }

  log.info("Plugin initialized", { discovered, resolved, skipped, logFile: getLogFilePath() });
  if (discovered === 0) {
    log.info("No roles found in rolebox directory");
  }

  const hooks = await createPluginHooks({
    resolvedRoles,
    session: sessionAdapter,
    roleFunctionsMap,
    directory: ctx.directory,
    roleboxDir: dirs.roleboxDir,
    globalSkillsDir: dirs.globalSkillsDir,
    configDir: dirs.configDir,
    builtinDir: dirs.builtinDir,
    capabilities: opencodeCapabilities(),
    ...(graphHost === undefined ? {} : { outcomeGraphTools: graphHost.createTools() }),
  });

  // The session ends and the session STATES the declared-graph host reads arrive
  // as EVENTS on this platform: 1.x has no session-turn-end call, so
  // `session.idle` and `session.error` are the completion channel
  // (`sessionEndFeed: true` above), and the typed `session.status` event is the
  // FRESH source for an execution's activity state (busy / retry / idle), which
  // this host's observation reads next to the adapter's own status pull. The
  // handlers are WRAPPED, never replaced in place: the original handler runs
  // first with its own input untouched, and the returned map carries every other
  // key through unchanged.
  // `createPluginHooks` is a union (`Hooks` or the no-op map), so the two
  // members are read through a structural view of their real signatures
  // (node_modules/@opencode-ai/plugin/dist/index.d.ts:173-177, :249-258). The
  // composition ALWAYS installs both, but neither is optional-by-omission in
  // the contract, so an absent one is carried through instead of shadowed by
  // `undefined` in the spread below.
  const installed = hooks as {
    event?: (input: { event: unknown }) => Promise<void>;
    dispose?: () => Promise<void>;
  };
  const event = installed.event;
  const dispose = installed.dispose;

  const wrapped: {
    event?: (input: { event: unknown }) => Promise<void>;
    dispose?: () => Promise<void>;
  } = {};
  if (event !== undefined) {
    wrapped.event = async (input) => {
      // The ORIGINAL handler runs first, with its OWN input object: the raw host
      // event is handed over untouched (the handler normalizes it itself,
      // src/core/services/hook-service.ts:186).
      await event(input);
      const ended = sessionEndOf(input.event);
      if (ended !== undefined) graphHost?.noteSessionEnded(ended.sessionID, ended.kind);
      const state = sessionStatusOf(input.event);
      if (state !== undefined) graphHost?.noteSessionStatus(state.sessionID, state.state);
    };
  }
  if (dispose !== undefined) {
    wrapped.dispose = async () => {
      try {
        graphHost?.close();
      } catch {
        /* a store that cannot be closed must not stop the rolebox flush below */
      }
      await dispose();
    };
  }
  // Every other key — `tool`, `config`, `chat.message`, … — is carried through
  // unchanged, and the two the host reads are the wrapped ones.
  return { ...hooks, ...wrapped };
};

/**
 * One session end carried by a v1 hook event, or `undefined` for anything else.
 *
 * The host hands the raw host event (src/core/services/hook-service.ts:180-199,
 * whose own normalizer runs inside the handler), and the two carriers this
 * reads — `type` and `properties` — are already on it in that shape, which is
 * how `handleEvent` reads them too (`properties.sessionID`,
 * src/hooks/event-handler.ts:62). Only the two session-end types are acted on:
 * `session.idle` is the turn being over and `session.error` the session having
 * failed. Everything else is left to the handler that already ran.
 */
function sessionEndOf(event: unknown): { sessionID: string; kind: "ended" | "errored" } | undefined {
  const canonical = event as { type?: unknown; properties?: unknown } | null | undefined;
  const kind =
    canonical?.type === "session.idle"
      ? ("ended" as const)
      : canonical?.type === "session.error"
        ? ("errored" as const)
        : undefined;
  if (kind === undefined) return undefined;
  const properties = canonical?.properties;
  if (typeof properties !== "object" || properties === null) return undefined;
  const sessionID = (properties as { sessionID?: unknown }).sessionID;
  return typeof sessionID === "string" && sessionID.length > 0
    ? { sessionID, kind }
    : undefined;
}

/**
 * One `session.status` state carried by a v1 hook event, or `undefined` for
 * anything else.
 *
 * The v1 host's event is `{ type: "session.status", properties: { sessionID,
 * status: SessionStatus } }`
 * (node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:406-412), and only the
 * three states the observation port distinguishes are acted on: `busy` / `retry`
 * say a turn is in flight, `idle` that it is over. Everything else — another
 * event type, a payload of an unexpected shape, a status this version does not
 * know — answers `undefined` and changes nothing, so a handler that never saw
 * this feed behaves exactly as it did before it existed.
 */
function sessionStatusOf(
  event: unknown,
): { sessionID: string; state: "idle" | "busy" | "retry" } | undefined {
  const canonical = event as { type?: unknown; properties?: unknown } | null | undefined;
  if (canonical?.type !== "session.status") return undefined;
  const properties = canonical.properties;
  if (typeof properties !== "object" || properties === null) return undefined;
  const sessionID = (properties as { sessionID?: unknown }).sessionID;
  if (typeof sessionID !== "string" || sessionID.length === 0) return undefined;
  const state = opencodeSessionStatusState((properties as { status?: unknown }).status);
  return state === undefined ? undefined : { sessionID, state };
}

export default {
  id: PLUGIN_ID,
  server: RoleboxPlugin,
};
