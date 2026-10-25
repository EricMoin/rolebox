/**
 * The `browse_*` tool family: one browser, 22 actions.
 *
 * The family is split by intent — navigation (`tools-navigation.ts`),
 * observation (`tools-observe.ts`) and interaction (`tools-interact.ts`) — and
 * assembled here into the record a host registers. `createBrowseTools()` is the
 * only constructor: it builds one shared runtime and returns the definitions
 * keyed by the names below, so a caller can add the set to a tool surface
 * without knowing how the manager is reached.
 *
 * Two properties hold for every member:
 *
 * - `execute` never rejects. Argument parsing, driver errors and session errors
 *   all come back as the canonical `Error: <cause>; <next step>.` result with
 *   `metadata.error = true` and a closed `metadata.code`, so a model can branch
 *   on the cause and a transcript can still read one sentence.
 * - `metadata` always carries `driver`, `action`, `session`, `page`, `url` and
 *   `title`, so results from different actions can be correlated across a turn.
 *
 * A manager is per worktree unless the caller injects one. For tests, inject a
 * manager whose driver factory is the in-memory fake; nothing in the family
 * imports Playwright itself.
 */

import type { CanonicalToolDef } from "../platform/ports/tool-factory.ts";
import { createBrowseRuntime, type BrowseToolsOptions } from "./tool-helpers.ts";
import {
  createBrowseClickTool,
  createBrowseCookiesTool,
  createBrowseDialogTool,
  createBrowseHoverTool,
  createBrowsePressTool,
  createBrowseScrollTool,
  createBrowseSelectTool,
  createBrowseTypeTool,
  createBrowseUploadTool,
} from "./tools-interact.ts";
import {
  createBrowseCloseTool,
  createBrowseHistoryTool,
  createBrowseOpenTool,
  createBrowseTabsTool,
  createBrowseWaitTool,
} from "./tools-navigation.ts";
import {
  createBrowseConsoleTool,
  createBrowseDownloadsTool,
  createBrowseEvalTool,
  createBrowseNetworkTool,
  createBrowseReadTool,
  createBrowseScreenshotTool,
  createBrowseSnapshotTool,
  createBrowseStatusTool,
} from "./tools-observe.ts";

/** The 22 tool names this module registers, in the order they are documented. */
export const BROWSE_TOOL_NAMES = [
  "browse_status",
  "browse_open",
  "browse_snapshot",
  "browse_read",
  "browse_click",
  "browse_type",
  "browse_press",
  "browse_select",
  "browse_hover",
  "browse_scroll",
  "browse_wait",
  "browse_eval",
  "browse_screenshot",
  "browse_upload",
  "browse_downloads",
  "browse_dialog",
  "browse_tabs",
  "browse_history",
  "browse_console",
  "browse_network",
  "browse_cookies",
  "browse_close",
] as const;

/** One member of the family. */
export type BrowseToolName = (typeof BROWSE_TOOL_NAMES)[number];

/**
 * Build every `browse_*` tool definition.
 *
 * The manager is resolved lazily per call, so constructing the record neither
 * imports Playwright nor launches a browser.
 */
export function createBrowseTools(options: BrowseToolsOptions = {}): Record<string, CanonicalToolDef> {
  const runtime = createBrowseRuntime(options);
  return {
    browse_status: createBrowseStatusTool(runtime),
    browse_open: createBrowseOpenTool(runtime),
    browse_snapshot: createBrowseSnapshotTool(runtime),
    browse_read: createBrowseReadTool(runtime),
    browse_click: createBrowseClickTool(runtime),
    browse_type: createBrowseTypeTool(runtime),
    browse_press: createBrowsePressTool(runtime),
    browse_select: createBrowseSelectTool(runtime),
    browse_hover: createBrowseHoverTool(runtime),
    browse_scroll: createBrowseScrollTool(runtime),
    browse_wait: createBrowseWaitTool(runtime),
    browse_eval: createBrowseEvalTool(runtime),
    browse_screenshot: createBrowseScreenshotTool(runtime),
    browse_upload: createBrowseUploadTool(runtime),
    browse_downloads: createBrowseDownloadsTool(runtime),
    browse_dialog: createBrowseDialogTool(runtime),
    browse_tabs: createBrowseTabsTool(runtime),
    browse_history: createBrowseHistoryTool(runtime),
    browse_console: createBrowseConsoleTool(runtime),
    browse_network: createBrowseNetworkTool(runtime),
    browse_cookies: createBrowseCookiesTool(runtime),
    browse_close: createBrowseCloseTool(runtime),
  };
}

/** Re-exported so a host can name the option type without importing the helper module. */
export type { BrowseToolsOptions };
