/**
 * Services that contribute tools to the plugin implement this.
 * The ToolService collects all tool definitions from registered
 * ToolContributors and assembles the final `tool` object.
 *
 * Returns tool definitions in their native format (as returned by
 * the `tool()` factory from `@opencode-ai/plugin`), with a minimal
 * `Record<string, any>` return type for flexibility.
 */
export interface ToolContributor {
  /** Returns a map of tool name → tool definition. */
  getTools(): Record<string, any>;
}
