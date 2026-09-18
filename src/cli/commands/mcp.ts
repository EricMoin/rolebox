import { defineCommand } from "citty";

/**
 * rolebox mcp — run the rolebox MCP server on stdio.
 *
 * This is the command Codex's plugin bundle ultimately speaks to. The entry
 * module is loaded lazily so the CLI's normal startup does not pay the
 * role-runtime boot cost, and main() serves until stdin closes (the MCP stdio
 * lifetime).
 */

/**
 * Load the Codex entry from module scope: tsc's
 * `rewriteRelativeImportExtensions` emits a dynamic `import()` written inline
 * in the `defineCommand(...)` argument with its `.ts` specifier, which breaks
 * the published build.
 */
function loadCodexEntry() {
  return import("../../entries/codex.ts");
}

export default defineCommand({
  meta: {
    name: "mcp",
    description: "Run the rolebox MCP server on stdio (Codex integration)",
  },
  async run() {
    const { main } = await loadCodexEntry();
    await main();
  },
});
