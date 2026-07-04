import type { ExtensionEntry } from "./types.ts";

/**
 * A self-registering extension point. Each scope (conditions, graph_topologies,
 * termination_conditions, recovery_strategies, recovery_patterns,
 * notification_channels, notification_events, observe_events) implements this.
 *
 * The ExtensionRegistry dispatches to registered ExtensionPoints by scope name.
 * Adding a new scope = register a new ExtensionPoint. No core changes needed.
 */
export interface ExtensionPoint {
  /** The scope name this point handles (e.g. "conditions", "graph_topologies"). */
  name: string;
  /**
   * Load and register extension entries for this scope.
   * Called by ExtensionRegistry.loadExtensions() for each scope in the config.
   */
  load(entries: ExtensionEntry[], roleDir: string): Promise<void>;
  /** Optional cleanup on shutdown or hot-reload. */
  dispose?(): Promise<void>;
}
