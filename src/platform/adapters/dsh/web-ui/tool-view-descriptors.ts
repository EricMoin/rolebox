/**
 * Tool-name → row descriptor table for the rolebox Web tool cards.
 *
 * The Web client dispatches `tool.call.toolview` by WIRE TOOL NAME only, so one
 * entry per rolebox tool name is required. Every entry names three facts and
 * one optional projection:
 *
 *   - `icon`  — the family glyph (inline SVG, no host icon import);
 *   - `verb`  — the action half of the title ("Declaring", 声明);
 *   - `noun`  — the object half ("graph", 图结构);
 *   - `summarize` — the salient ARGUMENT line under the title (a graph id, a
 *     URL, node/edge counts). It must never echo secrets: `computer_type` and
 *     `browse_type` deliberately return nothing for the typed text.
 *
 * The table is the registration list (`ROLEBOX_TOOL_VIEW_NAMES`) and the
 * component's lookup key at once, so adding a tool means adding one row.
 *
 * Names the HOST also registers are deliberately absent: `web_search`,
 * `web_fetch` and `session_search` are dsh's own tools in a dsh session (the
 * host's copy shadows rolebox's at session scope), and the host already ships
 * dedicated cards for them. Registering a rolebox row for those wire names
 * would REPLACE the host card for a tool rolebox did not provide.
 *
 * @module
 */

import { VERB_COPY, NOUN_COPY, type ToolViewNoun, type ToolViewVerb } from "./tool-view-locales.ts";

/** Glyph family rendered in the row's leading 16px box. */
export type ToolViewIcon =
  | "graph"
  | "memory"
  | "session"
  | "team"
  | "loop"
  | "skill"
  | "page"
  | "terminal"
  | "file"
  | "asset"
  | "signal"
  | "computer"
  | "browse"
  | "search"
  | "sparkle";

/** Namespace-bound translate seat as the slot synthesizes it (`t`). */
export type ToolViewTranslate = (key: string, params?: Record<string, unknown>) => string;

/** One registered tool's row definition. */
export interface ToolDescriptor {
  /** Family glyph. */
  readonly icon: ToolViewIcon;
  /** Action half of the title. */
  readonly verb: ToolViewVerb;
  /** Object half of the title. */
  readonly noun: ToolViewNoun;
  /**
   * Salient argument line shown under the title.
   * @param args - parsed call arguments (object form).
   * @param t - namespace-bound translate for localized units.
   * @returns a short display string, or undefined for no line.
   */
  readonly summarize?: (args: Readonly<Record<string, unknown>>, t: ToolViewTranslate) => string | undefined;
}

/** Read one string argument. */
function text(args: Readonly<Record<string, unknown>>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/** First line only — a summary is one row, never a paragraph. */
function firstLine(value: string, max = 120): string {
  const line = value.split("\n")[0] ?? "";
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** First line of the first present string argument among `keys`. */
function line(args: Readonly<Record<string, unknown>>, ...keys: readonly string[]): string | undefined {
  const value = text(args, ...keys);
  return value === undefined ? undefined : firstLine(value);
}

/** Join the non-empty parts of a summary with the row's separator. */
function join(parts: readonly (string | undefined)[]): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part !== "");
  return kept.length === 0 ? undefined : kept.join(" · ");
}

/** A finite number argument rendered as a count. */
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Parse the graph declaration argument (JSON text or an already-parsed value). */
function declarationOf(args: Readonly<Record<string, unknown>>): {
  name?: string;
  nodes?: number;
  edges?: number;
  loops?: number;
} {
  let value: unknown = args.declaration;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const declaration = value as {
    name?: unknown;
    nodes?: unknown;
    edges?: unknown;
    loop_groups?: unknown;
  };
  return {
    ...(typeof declaration.name === "string" ? { name: declaration.name } : {}),
    ...(Array.isArray(declaration.nodes) ? { nodes: declaration.nodes.length } : {}),
    ...(Array.isArray(declaration.edges) ? { edges: declaration.edges.length } : {}),
    ...(Array.isArray(declaration.loop_groups) ? { loops: declaration.loop_groups.length } : {}),
  };
}

/** One row per rolebox tool name the Web client may render. */
export const TOOL_DESCRIPTORS: Readonly<Record<string, ToolDescriptor>> = {
  // ── Files, memory, assets, references ───────────────────────────────────
  hashline_read: {
    icon: "file", verb: "read", noun: "file",
    summarize: args => text(args, "path") ?? text(args, "file_path"),
  },
  hashline_edit: {
    icon: "file", verb: "edit", noun: "file",
    summarize: args => text(args, "path") ?? text(args, "file_path"),
  },
  memory_write: {
    icon: "memory", verb: "write", noun: "memory",
    summarize: args => text(args, "title") ?? text(args, "id"),
  },
  memory_recall: {
    icon: "memory", verb: "recall", noun: "memory",
    summarize: args => line(args, "query"),
  },
  memory_list: {
    icon: "memory", verb: "list", noun: "memory entries",
    summarize: args => join([text(args, "category"), text(args, "scope"), text(args, "sort")]),
  },
  memory_read: {
    icon: "memory", verb: "read", noun: "memory",
    summarize: args => text(args, "id"),
  },
  memory_update: {
    icon: "memory", verb: "update", noun: "memory",
    summarize: args => text(args, "id") ?? text(args, "title"),
  },
  web_read: {
    icon: "page", verb: "read", noun: "page",
    summarize: args => line(args, "url"),
  },
  signal: {
    icon: "signal", verb: "send", noun: "signal",
    summarize: args => text(args, "type"),
  },
  interactive_terminal: {
    icon: "terminal", verb: "control", noun: "terminal",
    summarize: args => join([text(args, "action"), text(args, "id"), text(args, "command")]),
  },
  asset_search: {
    icon: "asset", verb: "search", noun: "assets",
    summarize: args => line(args, "query"),
  },
  asset_inspect: {
    icon: "asset", verb: "inspect", noun: "asset",
    summarize: args => text(args, "query") ?? text(args, "name") ?? text(args, "path"),
  },
  asset_validate: {
    icon: "asset", verb: "validate", noun: "asset",
    summarize: args => text(args, "path") ?? text(args, "query"),
  },
  reference_search: {
    icon: "search", verb: "search", noun: "references",
    summarize: args => line(args, "query"),
  },
  load_reference: {
    icon: "page", verb: "load", noun: "reference",
    summarize: args => text(args, "name"),
  },

  // ── Sessions ────────────────────────────────────────────────────────────
  session_list: {
    icon: "session", verb: "list", noun: "sessions",
    summarize: args => join([text(args, "from_date"), text(args, "project_path")]),
  },
  session_read: {
    icon: "session", verb: "read", noun: "session",
    summarize: args => join([text(args, "session_id"), text(args, "role_filter")]),
  },
  session_info: {
    icon: "session", verb: "inspect", noun: "session",
    summarize: args => text(args, "session_id"),
  },
  session_diff: {
    icon: "session", verb: "read", noun: "session diff",
    summarize: args => text(args, "session_id"),
  },
  session_fork: {
    icon: "session", verb: "fork", noun: "session",
    summarize: args => join([text(args, "session_id"), text(args, "message_id")]),
  },

  // ── Graph engine ────────────────────────────────────────────────────────
  graph_declare: {
    icon: "graph", verb: "declare", noun: "graph",
    summarize: (args, t) => {
      const declaration = declarationOf(args);
      return join([
        declaration.name,
        declaration.nodes === undefined ? undefined : t("count.nodes", { n: declaration.nodes }),
        declaration.edges === undefined ? undefined : t("count.edges", { n: declaration.edges }),
        declaration.loops === undefined || declaration.loops === 0
          ? undefined
          : t("count.loopGroups", { n: declaration.loops }),
      ]);
    },
  },
  graph_status: {
    icon: "graph", verb: "read", noun: "graph status",
    summarize: args => join([text(args, "graph_id"), text(args, "format")]),
  },
  graph_control: {
    icon: "graph", verb: "control", noun: "graph run",
    summarize: args => join([text(args, "graph_id"), text(args, "command")]),
  },
  graph_audit: {
    icon: "graph", verb: "audit", noun: "graph store",
  },
  graph_submit_outcome: {
    icon: "graph", verb: "submit", noun: "node outcome",
    summarize: args => join([text(args, "node_id"), text(args, "outcome_id")]),
  },

  // ── Teams ───────────────────────────────────────────────────────────────
  team_list_roles: { icon: "team", verb: "list", noun: "roles" },
  team_create: {
    icon: "team", verb: "create", noun: "team",
    summarize: args => line(args, "name"),
  },
  team_add: {
    icon: "team", verb: "add", noun: "member",
    summarize: args => join([text(args, "role_id"), text(args, "team_id")]),
  },
  team_send_event: {
    icon: "team", verb: "send", noun: "team event",
    summarize: args => join([text(args, "kind"), text(args, "recipient")]),
  },
  team_status: {
    icon: "team", verb: "read", noun: "team",
    summarize: args => text(args, "team_id"),
  },
  team_remove: {
    icon: "team", verb: "remove", noun: "member",
    summarize: args => join([text(args, "member_id"), text(args, "team_id")]),
  },
  team_delete: {
    icon: "team", verb: "delete", noun: "team",
    summarize: args => text(args, "team_id"),
  },
  team_resume: {
    icon: "team", verb: "resume", noun: "team",
    summarize: args => text(args, "team_id"),
  },

  // ── Loops ───────────────────────────────────────────────────────────────
  loop_start: {
    icon: "loop", verb: "start", noun: "loop",
    summarize: args => join([
      count(args.iterations) === undefined ? undefined : `×${count(args.iterations)}`,
      line(args, "objective"),
    ]),
  },
  loop_status: {
    icon: "loop", verb: "read", noun: "loop status",
    summarize: args => join([text(args, "session_id"), text(args, "round")]),
  },
  loop_cancel: {
    icon: "loop", verb: "stop", noun: "loop",
    summarize: args => text(args, "session_id"),
  },
  loop_output: {
    icon: "loop", verb: "read", noun: "loop output",
    summarize: args => join([text(args, "session_id"), text(args, "round")]),
  },
  loop_history: {
    icon: "loop", verb: "read", noun: "loop history",
    summarize: args => text(args, "session_id"),
  },
  loop_list: {
    icon: "loop", verb: "list", noun: "loops",
    summarize: args => text(args, "phase"),
  },

  // ── Skills ──────────────────────────────────────────────────────────────
  load_role_skill: {
    icon: "skill", verb: "load", noun: "skill",
    summarize: args => text(args, "name"),
  },

  // ── Computer use ────────────────────────────────────────────────────────
  computer_status: { icon: "computer", verb: "read", noun: "computer status" },
  computer_permissions: {
    icon: "computer", verb: "check", noun: "permissions",
    summarize: args => (args.request === true ? "request" : undefined),
  },
  computer_displays: { icon: "computer", verb: "list", noun: "displays" },
  computer_windows: {
    icon: "computer", verb: "list", noun: "windows",
    summarize: args => text(args, "app"),
  },
  computer_focus: {
    icon: "computer", verb: "focus", noun: "window",
    summarize: args => (count(args.window_id) === undefined ? undefined : `#${count(args.window_id)}`),
  },
  computer_screenshot: {
    icon: "computer", verb: "capture", noun: "screen",
    summarize: args => join([text(args, "path"), text(args, "format")]),
  },
  computer_click: {
    icon: "computer", verb: "click", noun: "screen",
    summarize: args => join([`${count(args.x) ?? "?"},${count(args.y) ?? "?"}`, text(args, "button")]),
  },
  computer_move: {
    icon: "computer", verb: "move", noun: "pointer",
    summarize: args => `${count(args.x) ?? "?"},${count(args.y) ?? "?"}`,
  },
  // Deliberately no summary: the argument is the text being typed and may be a
  // secret. The row shows only what the tool is doing, never the payload.
  computer_type: { icon: "computer", verb: "type", noun: "text" },
  computer_key: {
    icon: "computer", verb: "press", noun: "key",
    summarize: args => (Array.isArray(args.keys) ? args.keys.join("+") : undefined),
  },
  computer_scroll: {
    icon: "computer", verb: "scroll", noun: "screen",
    summarize: args => join([text(args, "direction"), count(args.amount) === undefined ? undefined : `×${count(args.amount)}`]),
  },
  computer_drag: {
    icon: "computer", verb: "drag", noun: "pointer",
    summarize: args => join([
      count(args.from_x) === undefined ? undefined : `${count(args.from_x)},${count(args.from_y)}`,
      count(args.to_x) === undefined ? undefined : `${count(args.to_x)},${count(args.to_y)}`,
    ]),
  },

  // ── Browser ─────────────────────────────────────────────────────────────
  browse_open: {
    icon: "browse", verb: "open", noun: "page",
    summarize: args => line(args, "url"),
  },
  browse_close: {
    icon: "browse", verb: "close", noun: "page",
    summarize: args => text(args, "page"),
  },
  browse_status: { icon: "browse", verb: "read", noun: "browser" },
  browse_snapshot: {
    icon: "browse", verb: "capture", noun: "page snapshot",
    summarize: args => text(args, "selector"),
  },
  browse_read: {
    icon: "browse", verb: "read", noun: "page",
    summarize: args => join([text(args, "selector"), text(args, "format")]),
  },
  browse_screenshot: {
    icon: "browse", verb: "capture", noun: "page",
    summarize: args => join([text(args, "selector"), text(args, "format")]),
  },
  browse_click: {
    icon: "browse", verb: "click", noun: "page",
    summarize: args => line(args, "target"),
  },
  browse_drag: {
    icon: "browse", verb: "drag", noun: "page",
    summarize: args => join([line(args, "from"), line(args, "to")]),
  },
  // The typed text may be a credential; never echo it.
  browse_type: {
    icon: "browse", verb: "type", noun: "page",
    summarize: args => line(args, "target"),
  },
  browse_press: {
    icon: "browse", verb: "press", noun: "key",
    summarize: args => text(args, "key"),
  },
  browse_hover: {
    icon: "browse", verb: "hover", noun: "page",
    summarize: args => line(args, "target"),
  },
  browse_select: {
    icon: "browse", verb: "select", noun: "option",
    summarize: args => join([
      line(args, "target"),
      Array.isArray(args.values) ? args.values.slice(0, 3).join(", ") : undefined,
    ]),
  },
  browse_upload: {
    icon: "browse", verb: "upload", noun: "file",
    summarize: (args, t) =>
      (Array.isArray(args.paths) ? t("count.files", { n: args.paths.length }) : undefined),
  },
  browse_scroll: {
    icon: "browse", verb: "scroll", noun: "page",
    summarize: args => join([
      text(args, "direction"),
      count(args.delta_y) === undefined ? undefined : `Δy ${count(args.delta_y)}`,
    ]),
  },
  browse_wait: {
    icon: "browse", verb: "wait", noun: "page",
    summarize: args => join([text(args, "text"), text(args, "selector"), text(args, "url")]),
  },
  browse_tabs: {
    icon: "browse", verb: "manage", noun: "tabs",
    summarize: args => join([text(args, "action"), text(args, "page")]),
  },
  browse_eval: {
    icon: "browse", verb: "evaluate", noun: "script",
  },
  browse_console: {
    icon: "browse", verb: "read", noun: "console",
    summarize: args => join([text(args, "level"), count(args.limit) === undefined ? undefined : `×${count(args.limit)}`]),
  },
  browse_network: {
    icon: "browse", verb: "read", noun: "network",
    summarize: args => join([text(args, "filter"), text(args, "method")]),
  },
  browse_cookies: {
    icon: "browse", verb: "read", noun: "cookies",
    summarize: args => text(args, "action"),
  },
  browse_dialog: {
    icon: "browse", verb: "handle", noun: "dialog",
    summarize: args => text(args, "action"),
  },
  browse_downloads: { icon: "browse", verb: "read", noun: "downloads" },
  browse_history: {
    icon: "browse", verb: "navigate", noun: "history",
    summarize: args => text(args, "action"),
  },
};

/** Registered wire names, in declaration order (the client registers each). */
export const ROLEBOX_TOOL_VIEW_NAMES: readonly string[] = Object.keys(TOOL_DESCRIPTORS);

/** Every verb/noun a descriptor may name must exist in the copy tables. */
export const TOOL_VIEW_VOCABULARY = { verbs: Object.keys(VERB_COPY), nouns: Object.keys(NOUN_COPY) } as const;
