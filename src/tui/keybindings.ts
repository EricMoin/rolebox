/**
 * TUI keyboard interaction and user preferences.
 *
 * Registers plugin-scoped keybindings via `api.keymap.registerLayer`,
 * persists user preferences via `api.kv`, and wires lifecycle disposal.
 *
 * All commands use the `rolebox.*` prefix to avoid collision with host
 * or other plugin bindings.
 *
 * @module
 */

import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

// ── Types ────────────────────────────────────────────────────────────────

export interface UserPreferences {
  refreshInterval: number;
  collapsedSections: string[];
  defaultFilter: string;
}

export interface KeybindingActions {
  onRefresh: () => void;
  onToggleMetrics: () => void;
  onFilter: () => void;
  onToggleHelp: () => void;
  /** Toggle a specific status filter (running/pending/error/timeout). */
  onToggleStatus: (status: string) => void;
  /** Restore the last-used filter string from persisted preferences. */
  onRestoreFilter?: (text: string) => void;

  // ── Task navigation ──
  onSelectUp: () => boolean;
  onSelectDown: () => boolean;
  onSelectEnter: () => boolean;
  onSelectEscape: () => boolean;

  // ── Detail panel scrolling ──
  onDetailScrollDown: () => boolean;
  onDetailScrollUp: () => boolean;
  onDetailTop: () => boolean;
  onDetailBottom: () => boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────

const KV_REFRESH_INTERVAL = "rolebox.refreshInterval";
const KV_COLLAPSED_SECTIONS = "rolebox.collapsedSections";
const KV_DEFAULT_FILTER = "rolebox.defaultFilter";

/**
 * Layer priority higher than default so our bindings take precedence
 * unless another plugin explicitly overrides with a higher priority.
 */
const LAYER_PRIORITY = 100;

// ── Shortcut help entries ─────────────────────────────────────────────────

export interface ShortcutEntry {
  key: string;
  description: string;
}

export const SHORTCUTS: ShortcutEntry[] = [
  { key: "ctrl+r", description: "Force refresh activity" },
  { key: "ctrl+m", description: "Toggle dispatch metrics" },
  { key: "ctrl+f", description: "Open filter / search mode" },
  { key: "ctrl+1", description: "Toggle running status (in filter mode)" },
  { key: "ctrl+2", description: "Toggle pending status (in filter mode)" },
  { key: "ctrl+3", description: "Toggle error status (in filter mode)" },
  { key: "ctrl+4", description: "Toggle timeout status (in filter mode)" },
  // Navigation
  { key: "\u2191/\u2193", description: "Select task row" },
  { key: "Enter", description: "Open task detail" },
  { key: "Esc", description: "Back to activity list" },
  { key: "ctrl+j/ctrl+k", description: "Scroll detail text" },
  { key: "ctrl+home/ctrl+end", description: "Top/bottom of detail" },
  { key: "ctrl+shift+/", description: "Show this shortcut help" },
];

// ── Setup ─────────────────────────────────────────────────────────────────

/**
 * Register keybindings, load persisted preferences, and wire lifecycle
 * disposal for the rolebox TUI sidebar.
 *
 * Must be called once during plugin initialization. Returns a dispose
 * function that unregisters the layer and persists current preferences.
 */
export function setupKeybindings(
  api: TuiPluginApi,
  actions: KeybindingActions,
): () => void {
  // ── Load persisted preferences ──
  const prefs = loadPreferences(api);

  // ── Register keymap layer ──
  const disposeLayer = api.keymap.registerLayer({
    priority: LAYER_PRIORITY,
    commands: [
      {
        name: "rolebox.refresh",
        run: () => {
          actions.onRefresh();
          return true;
        },
      },
      {
        name: "rolebox.toggleMetrics",
        run: () => {
          actions.onToggleMetrics();
          return true;
        },
      },
      {
        name: "rolebox.filter",
        run: () => {
          actions.onFilter();
          return true;
        },
      },
      {
        name: "rolebox.help",
        run: () => {
          actions.onToggleHelp();
          return true;
        },
      },
      // ── Status filter toggles (ctrl+1-4) ──
      {
        name: "rolebox.filterStatusRunning",
        run: () => {
          actions.onToggleStatus("running");
          return true;
        },
      },
      {
        name: "rolebox.filterStatusPending",
        run: () => {
          actions.onToggleStatus("pending");
          return true;
        },
      },
      {
        name: "rolebox.filterStatusError",
        run: () => {
          actions.onToggleStatus("error");
          return true;
        },
      },
      {
        name: "rolebox.filterStatusTimeout",
        run: () => {
          actions.onToggleStatus("timeout");
          return true;
        },
      },

      // ── Task navigation ──
      {
        name: "rolebox.selectUp",
        run: () => {
          return actions.onSelectUp();
        },
      },
      {
        name: "rolebox.selectDown",
        run: () => {
          return actions.onSelectDown();
        },
      },
      {
        name: "rolebox.selectEnter",
        run: () => {
          return actions.onSelectEnter();
        },
      },
      {
        name: "rolebox.selectEscape",
        run: () => {
          return actions.onSelectEscape();
        },
      },

      // ── Detail panel scrolling ──
      {
        name: "rolebox.detailScrollDown",
        run: () => {
          return actions.onDetailScrollDown();
        },
      },
      {
        name: "rolebox.detailScrollUp",
        run: () => {
          return actions.onDetailScrollUp();
        },
      },
      {
        name: "rolebox.detailTop",
        run: () => {
          return actions.onDetailTop();
        },
      },
      {
        name: "rolebox.detailBottom",
        run: () => {
          return actions.onDetailBottom();
        },
      },
    ],
    bindings: [
      { key: "ctrl+r", cmd: "rolebox.refresh" },
      { key: "ctrl+m", cmd: "rolebox.toggleMetrics" },
      { key: "ctrl+f", cmd: "rolebox.filter" },
      { key: "ctrl+1", cmd: "rolebox.filterStatusRunning" },
      { key: "ctrl+2", cmd: "rolebox.filterStatusPending" },
      { key: "ctrl+3", cmd: "rolebox.filterStatusError" },
      { key: "ctrl+4", cmd: "rolebox.filterStatusTimeout" },
      { key: "ctrl+shift+/", cmd: "rolebox.help" },

      // Task navigation (up/down arrows select rows in activity list)
      { key: "Up", cmd: "rolebox.selectUp" },
      { key: "Down", cmd: "rolebox.selectDown" },
      { key: "Enter", cmd: "rolebox.selectEnter" },
      { key: "Escape", cmd: "rolebox.selectEscape" },

      // Detail scrolling (ctrl+j/k scroll text, ctrl+home/end or ctrl+g/shift+g jump to top/bottom)
      { key: "ctrl+j", cmd: "rolebox.detailScrollDown" },
      { key: "ctrl+k", cmd: "rolebox.detailScrollUp" },
      { key: "ctrl+home", cmd: "rolebox.detailTop" },
      { key: "ctrl+g", cmd: "rolebox.detailTop" },
      { key: "ctrl+end", cmd: "rolebox.detailBottom" },
      { key: "ctrl+shift+g", cmd: "rolebox.detailBottom" },
    ],
  });

  // ── Restore last-used filter text ──
  if (prefs.defaultFilter && actions.onRestoreFilter) {
    actions.onRestoreFilter(prefs.defaultFilter);
  }

  // ── Persist preferences on dispose ──
  function persist(): void {
    try {
      api.kv.set(KV_REFRESH_INTERVAL, prefs.refreshInterval);
      api.kv.set(KV_COLLAPSED_SECTIONS, prefs.collapsedSections);
      api.kv.set(KV_DEFAULT_FILTER, prefs.defaultFilter);
    } catch {
      // Best-effort persistence; swallow so disposal always completes
    }
  }

  // Wire into lifecycle so preferences are saved when the plugin is torn down
  const disposePersist = api.lifecycle.onDispose(() => {
    persist();
  });

  return () => {
    persist();
    disposePersist();
    disposeLayer();
  };
}

// ── Preferences helpers ───────────────────────────────────────────────────

/**
 * Load user preferences from `api.kv` with sensible defaults.
 */
export function loadPreferences(api: TuiPluginApi): UserPreferences {
  return {
    refreshInterval: api.kv.get<number>(KV_REFRESH_INTERVAL, 1000),
    collapsedSections: api.kv.get<string[]>(KV_COLLAPSED_SECTIONS, []),
    defaultFilter: api.kv.get<string>(KV_DEFAULT_FILTER, ""),
  };
}

/**
 * Save user preferences to `api.kv`.
 */
export function savePreferences(
  api: TuiPluginApi,
  prefs: Partial<UserPreferences>,
): void {
  try {
    if (prefs.refreshInterval !== undefined) {
      api.kv.set(KV_REFRESH_INTERVAL, prefs.refreshInterval);
    }
    if (prefs.collapsedSections !== undefined) {
      api.kv.set(KV_COLLAPSED_SECTIONS, prefs.collapsedSections);
    }
    if (prefs.defaultFilter !== undefined) {
      api.kv.set(KV_DEFAULT_FILTER, prefs.defaultFilter);
    }
  } catch {
    // Best-effort persistence
  }
}
