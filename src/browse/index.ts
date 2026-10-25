/**
 * rolebox's semantic browser core.
 *
 * This module is the surface the `browse_*` tool family is built on: the driver
 * port and shared vocabulary, availability, target parsing, the snapshot walker,
 * the session manager, the one Playwright driver, capture helpers, the shared
 * tool-result helpers, the 22 `browse_*` tool definitions
 * (`createBrowseTools`) and the browser workflow prompt block
 * (`buildBrowseContext`). Importing this module registers nothing and launches
 * nothing.
 */

export * from "./types.ts";
export * from "./availability.ts";
export * from "./target.ts";
export * from "./snapshot.ts";
export * from "./session.ts";
export * from "./results.ts";
export * from "./capture.ts";
export { BROWSE_TOOL_NAMES, createBrowseTools, type BrowseToolName, type BrowseToolsOptions } from "./tools.ts";
export { buildBrowseContext, type BrowseContextOptions } from "./context.ts";
export {
  AUTOMATION_CONTROLLED_ARG,
  BROWSE_MAX_WAIT_MS,
  DEFAULT_BROWSE_LAUNCH_TIMEOUT_MS,
  DEFAULT_BROWSE_TIMEOUT_MS,
  DEFAULT_BROWSE_VIEWPORT,
  READ_DEFAULT_MAX_CHARS,
  READ_MAX_CHARS,
  clampReadMaxChars,
  launchPlaywrightDriver,
  mapPlaywrightError,
  playwrightDriverFactory,
  truncateReadContent,
} from "./playwright-driver.ts";
