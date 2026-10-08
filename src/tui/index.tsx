/**
 * rolebox — TUI sidebar plugin (activity + logs)
 *
 * Cross-process state bridge: reads on-disk state (.rolebox/state/*.json,
 * role.yaml directories) via the synchronous `readMonitorSnapshot()` reader.
 *
 * Registers into the built-in `sidebar_content` host slot. The panel
 * auto-refreshes every 1s and shows one of TWO views:
 *
 *   - ACTIVITY (default) — which role has a function active (role | function
 *     turn N), which agents have been dispatched (• running, · queued, ✗ error),
 *     graph execution progress and loop round progress.
 *   - LOGS — a live tail of the platform's own log files, driven by the same
 *     1s refresh through `readLogView`'s cursor (src/log/view.ts): pausable,
 *     level-filtered, channel-filtered, with a bounded buffer whose dropped
 *     count is reported.
 *
 * No section headers for absent things. No abstract counts. Just the current
 * activity, agent-centric, triage-sorted. When idle, the panel collapses to the
 * pulse.
 *
 * Visual vocabulary adapted from the CLI dashboard (monitor.ts).
 *
 * ── Key bindings ───────────────────────────────────────────────────────────
 *
 * The Logs controls are registered as ONE keymap layer, so a host that unmounts
 * the plugin (or a later plugin that outranks this one) removes them cleanly.
 * The layer claims the Logs keys and NOTHING else — `ctrl+l` (view toggle),
 * `ctrl+p` (pause), `ctrl+up` / `ctrl+down` (level), `ctrl+n` (channel),
 * `ctrl+g` (follow) — so the host's own navigation and the panel's bare-key
 * overlays (r refresh, m metrics, f filter, ? help) stay exactly as they were:
 * this plugin registered no keymap layer before the Logs view, and every Logs
 * key is inert in the Activity view. `logic.ts` owns their spelling, and the
 * pane's own copy names the same constants.
 */

/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiKeymap } from "@opencode-ai/plugin/tui";
import {
  createSidebarRenderer,
  setEventBridgeRef,
  triggerRefresh,
  triggerToggleMetrics,
  triggerToggleFilter,
  triggerToggleHelp,
  triggerLogsToggle,
  triggerLogsPause,
  triggerLogsLevel,
  triggerLogsChannel,
  triggerLogsFollow,
} from "./state";
import { createEventBridge } from "./events";
import { resolveProjectRoot } from "../cli/commands/monitor/monitor-reader.ts";
import {
  LOGS_CHANNEL_KEY,
  LOGS_FOLLOW_KEY,
  LOGS_LEVEL_LOOSER_KEY,
  LOGS_LEVEL_STRICTER_KEY,
  LOGS_PAUSE_KEY,
  LOGS_TOGGLE_KEY,
} from "./logic";

// ── Logs key bindings ───────────────────────────────────────────────────

/** The key that opens the Logs tab and returns to Activity. */
export const LOGS_TOGGLE_BINDING = LOGS_TOGGLE_KEY;

/**
 * Every Logs control, as `key → command`.
 *
 * Built from the constants in `logic.ts` — the same ones the pane's own copy
 * names — so the key a reader is told to press cannot drift from the key this
 * layer registers. Exported so the binding surface is a value a test can read
 * rather than a sequence of literals buried in a registration call: the set of
 * keys the plugin claims is part of its contract with the host.
 *
 * ONLY THESE KEYS ARE CLAIMED. The panel's other controls (`r` refresh, `m`
 * metrics, `f` filter, `?` help) are bare keys a reader expects the host to own,
 * and this plugin registered no keymap layer before the Logs view — binding them
 * would shadow host actions instead of restoring a control.
 */
export const LOGS_KEY_BINDINGS: ReadonlyArray<readonly [string, string]> = [
  [LOGS_TOGGLE_KEY, "rolebox.logs.toggle"],
  [LOGS_PAUSE_KEY, "rolebox.logs.pause"],
  [LOGS_LEVEL_STRICTER_KEY, "rolebox.logs.level-stricter"],
  [LOGS_LEVEL_LOOSER_KEY, "rolebox.logs.level-looser"],
  [LOGS_CHANNEL_KEY, "rolebox.logs.channel-next"],
  [LOGS_FOLLOW_KEY, "rolebox.logs.follow"],
];

/** The commands the bindings above dispatch, in the order they are declared. */
export const LOGS_COMMANDS: readonly string[] = LOGS_KEY_BINDINGS.map(([, command]) => command);

/**
 * Register the Logs keymap layer and answer its disposer.
 *
 * `registerLayer` normalizes and compiles the layer, reports a malformed one
 * through its own error channel and answers a no-op disposer instead of
 * throwing (measured in @opentui/keymap's `registerLayer`), so a keymap problem
 * can never stop the panel from mounting — the pane is simply unreachable by
 * key until the layer is fixed.
 */
export function registerLogsKeymap(keymap: TuiKeymap, onRefresh: () => void = triggerRefresh): () => void {
  const handlers: Readonly<Record<string, () => void>> = {
    "rolebox.logs.toggle": () => triggerLogsToggle(),
    "rolebox.logs.pause": () => triggerLogsPause(),
    "rolebox.logs.level-stricter": () => triggerLogsLevel(1),
    "rolebox.logs.level-looser": () => triggerLogsLevel(-1),
    "rolebox.logs.channel-next": () => triggerLogsChannel(),
    "rolebox.logs.follow": () => {
      triggerLogsFollow();
      // A follow is a request to see the newest records NOW rather than at the
      // next tick, so it refreshes through the same path the refresh key uses
      // (the pane's poll rides the panel's own cycle).
      onRefresh();
    },
  };
  const bindings = LOGS_KEY_BINDINGS.map(([key, cmd]) => ({ key, cmd }));
  const commands = Object.keys(handlers).map((name) => ({ name, run: handlers[name] }));
  return keymap.registerLayer({ bindings, commands });
}

// ── TUI Plugin ──────────────────────────────────────────────────────────

const roleboxTuiPlugin: TuiPlugin = async (api, _options, _meta) => {
  const workspaceDir = resolveProjectRoot(api.state.path.directory);

  // Create live event bridge for sub-250ms UI updates.
  // Subscribes to opencode host events + fast-polls rolebox state files,
  // and emits attention notifications on error/timeout.
  const eventBridge = createEventBridge(api, workspaceDir);
  setEventBridgeRef(eventBridge);

  // The panel's key controls, in one disposable layer.
  const unregisterKeymap = registerLogsKeymap(api.keymap);

  api.lifecycle.onDispose(() => {
    unregisterKeymap();
    eventBridge.dispose();
    setEventBridgeRef(null);
  });

  // Register the sidebar content slot renderer.
  api.slots.register({
    slots: {
      sidebar_content: createSidebarRenderer(workspaceDir),
    },
  });
};

const tuiPluginModule: TuiPluginModule = {
  id: "rolebox-tui",
  tui: roleboxTuiPlugin,
};

export default tuiPluginModule;
