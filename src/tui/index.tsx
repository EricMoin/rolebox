/**
 * rolebox — TUI sidebar plugin (activity-first redesign)
 *
 * Cross-process state bridge: reads on-disk state (.rolebox/state/*.json,
 * role.yaml directories) via the synchronous `readMonitorSnapshot()` reader.
 *
 * Registers into the built-in `sidebar_content` host slot. The panel
 * auto-refreshes every 1s and shows a LIVE ACTIVITY VIEW of what the
 * rolebox agent system is doing right now:
 *
 *   - Which role has a function active (role | function turn N)
 *   - Which agents have been dispatched and their status (▸ running, ● queued, ✗ error)
 *   - Graph execution progress (nodes with ✓/▸/● status)
 *   - Loop round progress (N/M + bar)
 *
 * No section headers for absent things. No abstract counts. Just the
 * current activity, agent-centric, triage-sorted. When idle, the panel
 * collapses to the pulse.
 *
 * Visual vocabulary adapted from the CLI dashboard (monitor.ts).
 */

import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createSidebarRenderer } from "./state";

// ── TUI Plugin ──────────────────────────────────────────────────────────

const roleboxTuiPlugin: TuiPlugin = async (api, _options, _meta) => {
  const workspaceDir = api.state.path.directory;
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
