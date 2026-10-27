/**
 * The browser block injected into a system prompt.
 *
 * Mirrors `src/computer/context.ts`: the block is rendered by
 * `src/prompt/blocks.ts`, it is present only when a `browse_*` tool is actually
 * registered, and its wording follows the host's tool presentation. The rules
 * are written once here so every host (native tools, discover-then-call, or code
 * mode) teaches the same workflow: open, snapshot, act on fresh refs, verify,
 * and close.
 */

import { renderInjectBlock } from "../prompt/blocks.ts";
import { BROWSE_TOOL_NAMES } from "./tools.ts";

export interface BrowseContextOptions {
  tools: readonly string[];
  presentation?: "native" | "discover" | "code";
  discoverInvocation?: "native" | "call";
}

const PRESENTATION_DISCOVER_NATIVE =
  "The browse names below are authorized capabilities. First inspect a capability with graph_worker_tools(action=\"describe\", name=...). "
  + "Then call its native tool only after describe has exposed the schema.";

const PRESENTATION_DISCOVER_CALL =
  "The browse names below are authorized capabilities. First inspect a capability with graph_worker_tools(action=\"describe\", name=...). "
  + "Invoke it with graph_worker_tools(action=\"call\", name=..., arguments=...); these names are not direct tool calls.";

const PRESENTATION_CODE =
  "First inspect the authorized browse schemas with graph_worker_tools(action=\"describe\", name=...), "
  + "then invoke them through graph_worker_code with await tools.call(name, args). These names are not direct tool calls.";

/**
 * Render the browse workflow block for the tools a host registered.
 *
 * Returns `""` when none of the 23 names is present, so a host that did not
 * grant browsing injects no browser instructions at all.
 */
export function buildBrowseContext(options: BrowseContextOptions): string {
  const tools = new Set(options.tools);
  if (!BROWSE_TOOL_NAMES.some(name => tools.has(name))) return "";

  const has = (...names: string[]) => names.some(name => tools.has(name));
  const instructions: string[] = [
    "Prefer the browse tools over computer-use screen control when the target is a web page: browse_* acts on the page's elements and returns page text, "
      + "while coordinate input depends on the desktop state and the visible window.",
  ];

  if (options.presentation === "discover") {
    instructions.push(options.discoverInvocation === "call" ? PRESENTATION_DISCOVER_CALL : PRESENTATION_DISCOVER_NATIVE);
  } else if (options.presentation === "code") {
    instructions.push(PRESENTATION_CODE);
  }

  if (has("browse_open", "browse_snapshot")) {
    instructions.push(
      "Start with browse_open (the page defaults to the session's active page, initially main), then browse_snapshot to read the page and its element refs.",
    );
  }
  if (has("browse_snapshot")) {
    instructions.push(
      "Act only on refs from the latest browse_snapshot: a ref becomes stale after navigation or a DOM change, so re-snapshot instead of retrying it, "
        + "and prefer a ref over a text or role target when several elements could match. A snapshot-then-act loop is the normal way to browse.",
    );
  }
  if (has("browse_read", "browse_screenshot")) {
    instructions.push(
      "Use browse_read for page content (markdown, text, html, links or table) and browse_screenshot when layout or an image matters; "
        + "browse_snapshot is for refs, not for long prose.",
    );
  }
  if (has("browse_console", "browse_network")) {
    instructions.push(
      "Use browse_console for JavaScript errors and browse_network for failed requests before guessing at a broken page.",
    );
  }
  if (has("browse_dialog")) {
    instructions.push(
      "A pending dialog blocks every other action on the page; handle it with browse_dialog (accept or dismiss) as soon as browse_status or another action reports dialog_open.",
    );
  }
  if (has("browse_tabs")) {
    instructions.push(
      "Tabs are named pages in one browser session: browse_tabs lists, creates, selects and closes them, and every browse tool accepts page=<name> to choose one.",
    );
  }
  if (has("browse_status")) {
    instructions.push(
      "Playwright is an optional local dependency: browse_status reports whether it is installed, its version and whether the browser binary is present, and it never launches a browser.",
    );
  }
  instructions.push(
    "The local browser can reach localhost addresses, so a development server on 127.0.0.1 or localhost can be opened with browse_open.",
  );
  if (has("browse_close")) {
    instructions.push(
      "Call browse_close when the browsing task is finished: it releases the pages, the browser and their refs.",
    );
  }
  instructions.push(
    "Report only what a tool result showed: a successful click does not prove the page changed, so verify with a snapshot, a read, a console check or a screenshot before claiming a result.",
  );

  return renderInjectBlock({ title: "Browser use workflow", instruction: instructions });
}
