/**
 * TUI filter bar component — interactive search and filter controls.
 *
 * Provides text-based agent/session search, inline status toggle buttons,
 * and session ID filtering, plus a "filtered: N of M items" indicator.
 *
 * Rendered below the pulse when filter mode is toggled via `ctrl+f`.
 *
 * Inline "buttons" are rendered as styled text spans — active filters
 * are bracketed and bold, inactive ones are dimmed. Status toggles are
 * driven by `1`-`4` keys.
 *
 * @module
 */

/** @jsxImportSource @opentui/solid */
import { For } from "solid-js";
import type { ThemeColors } from "../helpers.ts";
import { rgbaToCSS, BOLD, DIM, UNDERLINE } from "../helpers.ts";
import { shortSessionId } from "../helpers.ts";

// ── Status filter definitions ────────────────────────────────────────────

export interface StatusFilterDef {
  key: string;
  label: string;
  glyph: string;
}

export const STATUS_FILTERS: StatusFilterDef[] = [
  { key: "running", label: "running", glyph: "\u25b8" },  // ▸
  { key: "pending", label: "pending", glyph: "\u25cf" },  // ●
  { key: "error",   label: "error",   glyph: "\u2717" },  // ✗
  { key: "timeout", label: "timeout", glyph: "\u25c7" },  // ◇
];

// ── Props ────────────────────────────────────────────────────────────────

export interface FilterBarProps {
  c: ThemeColors;
  /** Current text-based filter string. */
  filterText: string;
  /** Set of status keys currently active. Empty = all statuses shown. */
  activeStatuses: Set<string>;
  /** Currently selected session ID for filtering, or null for all. */
  sessionFilterId: string | null;
  /** Filter indicator counts. */
  totalItems: number;
  filteredItems: number;
  /** Available session IDs to filter by (deduplicated, sorted). */
  availableSessions: string[];
  /** The sidebar's own session ID (always shown). */
  currentSessionId: string;
  /** Called when a status filter button is clicked. */
  onToggleStatus?: (status: string) => void;
  /** Called when a session filter selector is clicked (pass session ID or null for all). */
  onSelectSession?: (sessionId: string | null) => void;
  /** Called when the filter bar close is clicked. */
  onClose?: () => void;
}

// ── Render: status toggle button (inline text) ───────────────────────────

function renderStatusToggle(
  c: ThemeColors,
  def: StatusFilterDef,
  isActive: boolean,
  onToggleStatus?: (status: string) => void,
) {
  const info = rgbaToCSS(c.info);
  const muted = rgbaToCSS(c.textMuted);
  const keyDim = rgbaToCSS(c.textMuted);

  const statusKey = def.key;

  if (isActive) {
    // Active: bracketed + bold + colored — looks like a pressed button
    return (
      <span fg={info} attributes={BOLD} on:click={() => onToggleStatus?.(statusKey)}>
        {" [" + def.glyph + " " + def.label + "]"}
      </span>
    );
  }
  // Inactive: dimmed glyph + label (clickable)
  return (
    <span fg={muted} attributes={DIM | UNDERLINE} on:click={() => onToggleStatus?.(statusKey)}>
      {"  " + def.glyph + " " + def.label}
    </span>
  );
}

// ── Main component ───────────────────────────────────────────────────────

export function renderFilterBar(props: FilterBarProps) {
  const { c, filterText, activeStatuses, sessionFilterId, totalItems, filteredItems, currentSessionId } = props;

  const muted = rgbaToCSS(c.textMuted);
  const norm = rgbaToCSS(c.text);
  const info = rgbaToCSS(c.info);
  const warn = rgbaToCSS(c.warning);
  const err = rgbaToCSS(c.error);
  const dim = rgbaToCSS(c.textMuted);

  const hasActiveFilter =
    filterText.length > 0 || activeStatuses.size > 0 || sessionFilterId !== null;

  // Sessions other than the current one (de-duplicated, capped for display)
  const otherSessions = props.availableSessions
    .filter((s) => s !== currentSessionId)
    .slice(0, 5);

  return (
    <box marginBottom={1}>
      {/* Section header */}
      <text fg={muted} attributes={BOLD}>{"\u2500 filter"}</text>

      {/* Search text line */}
      <text>
        <span fg={muted} attributes={DIM}>{"  search: "}</span>
        <span fg={norm}>{filterText.length > 0 ? filterText : "\u2026"}</span>
      </text>

      {/* Status toggle buttons (inline) */}
      <text>
        <span fg={muted} attributes={DIM}>{"  status:"}</span>
        <For each={STATUS_FILTERS}>
          {(def) => renderStatusToggle(c, def, activeStatuses.has(def.key), props.onToggleStatus)}
        </For>
      </text>

      {/* Session ID filter — inline session selectors */}
      <text>
        <span fg={muted} attributes={DIM}>{"  session:"}</span>
        {/* Current session */}
        <For each={[currentSessionId]}>
          {(sid) =>
            sessionFilterId === null || sessionFilterId === sid ? (
              <span
                fg={info} attributes={BOLD}
                on:click={() => props.onSelectSession?.(sid)}
              >
                {" [current]"}
              </span>
            ) : (
              <span
                fg={dim} attributes={DIM | UNDERLINE}
                on:click={() => props.onSelectSession?.(sid)}
              >
                {"  current"}
              </span>
            )
          }
        </For>
        {/* Other available sessions */}
        <For each={otherSessions}>
          {(sid) =>
            sessionFilterId === sid ? (
              <span
                fg={info} attributes={BOLD}
                on:click={() => props.onSelectSession?.(sid)}
              >
                {" [" + shortSessionId(sid) + "]"}
              </span>
            ) : (
              <span
                fg={dim} attributes={DIM | UNDERLINE}
                on:click={() => props.onSelectSession?.(sid)}
              >
                {"  " + shortSessionId(sid)}
              </span>
            )
          }
        </For>
        {/* All-sessions toggle */}
        {sessionFilterId !== null ? (
          <span
            fg={info} attributes={BOLD}
            on:click={() => props.onSelectSession?.(null)}
          >
            {" [all]"}
          </span>
        ) : (
          <span
            fg={dim} attributes={DIM | UNDERLINE}
            on:click={() => props.onSelectSession?.(null)}
          >
            {"  all"}
          </span>
        )}
      </text>

      {/* Filter indicator */}
      <text>
        {hasActiveFilter ? (
          <>
            <span fg={info} attributes={BOLD}>
              {"  filtered: " + filteredItems + " of " + totalItems + " items"}
            </span>
            <span
              fg={muted} attributes={DIM | UNDERLINE}
              on:click={() => props.onClose?.()}
            >
              {"  [close]"}
            </span>
          </>
        ) : (
          <span fg={muted} attributes={DIM}>
            {"  " + totalItems + " total"}
          </span>
        )}
      </text>
    </box>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Compute total unfiltered item count from a snapshot.
 * Sums active functions, tasks, graphs, and loops.
 */
export function countTotalItems(data: {
  fns: unknown[];
  tasks: unknown[];
  graphs: unknown[];
  loops: unknown[];
}): number {
  return data.fns.length + data.tasks.length + data.graphs.length + data.loops.length;
}

/**
 * Collect unique session IDs from the activity data for the filter selector.
 */
export function collectSessionIds(
  tasks: { sessionId?: string | null }[],
  fns: { sessionId: string }[],
  graphs: { sessionId: string }[],
  loops: { originSessionId?: string | null }[],
): string[] {
  const ids = new Set<string>();
  for (const t of tasks) if (t.sessionId) ids.add(t.sessionId);
  for (const fn of fns) ids.add(fn.sessionId);
  for (const g of graphs) ids.add(g.sessionId);
  for (const l of loops) if (l.originSessionId) ids.add(l.originSessionId);
  return [...ids].sort();
}
