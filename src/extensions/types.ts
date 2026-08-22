import type { CondEnv } from "../function/conditions.ts";
import type { FlowEdge } from "../types.ts";
import type { ConditionCapability, ObserveCapability } from "./capabilities.ts";

/** All supported extension scopes. */
export type ExtensionScope =
  | "conditions"
  | "graph_topologies"
  | "termination_conditions"
  | "recovery_strategies"
  | "recovery_patterns"
  | "notification_channels"
  | "notification_events"
  | "observe_events";

/** A generic extension entry from role.yaml's extensions: block. */
export interface ExtensionEntry {
  /** Unique name/identifier for this extension within its scope. */
  name: string;
  /** Path to the JS/TS module file (relative to role dir or absolute). */
  module: string;
  /** Optional description. */
  description?: string;
}

/** Extension entry for recovery_strategies — includes categories. */
export interface RecoveryStrategyEntry extends ExtensionEntry {
  /** Which error categories this strategy applies to. */
  categories?: string[];
}

/** Extension entry for recovery_patterns — includes category. */
export interface RecoveryPatternEntry extends ExtensionEntry {
  /** The error category this pattern detects. */
  category: string;
}

/** Extension entry for notification_channels — uses 'kind' instead of 'name'. */
export interface NotificationChannelEntry {
  /** Channel kind identifier (e.g., "slack", "discord"). */
  kind: string;
  /** Path to the JS/TS module file. */
  module: string;
  /** Optional description. */
  description?: string;
}

/** The full extensions: block in role.yaml. */
export interface ExtensionConfig {
  conditions?: ExtensionEntry[];
  graph_topologies?: ExtensionEntry[];
  termination_conditions?: ExtensionEntry[];
  recovery_strategies?: RecoveryStrategyEntry[];
  recovery_patterns?: RecoveryPatternEntry[];
  notification_channels?: NotificationChannelEntry[];
  notification_events?: ExtensionEntry[];
  observe_events?: ExtensionEntry[];
}

// ── Module Contract Interfaces ──────────────────────────────────────
// These define what extension modules must export.

/** Condition module contract. */
export interface ConditionModule {
  /** Handler called when the condition is evaluated. Returns boolean. */
  handler: (arg: string, env: CondEnv) => boolean;
}

/** Graph topology module contract. */
export interface TopologyModule {
  /** Expand the topology into flow edges given agent names. */
  expand: (agents: string[]) => FlowEdge[];
}

/** Termination condition module contract. */
export interface TerminationParserModule {
  /** Parse a raw condition value into a LoopCondition-like object. */
  parse: (value: unknown, availableAgents: string[]) => unknown | null;
}

/** Recovery strategy module contract — re-exports the RecoveryStrategy interface. */
export interface RecoveryStrategyModule {
  /** Strategy name. */
  name: string;
  /** Execute the recovery strategy. */
  execute: (ctx: unknown) => Promise<unknown>;
}

/** Recovery pattern module contract. */
export interface RecoveryPatternModule {
  /** Pattern name. */
  name: string;
  /** The error category this pattern detects. */
  category: string;
  /** Match function — returns a RecoveryError if matched, null otherwise. */
  match: (error: unknown) => unknown | null;
}

/** Notification channel module contract. */
export interface NotificationChannelModule {
  /** Factory to create a channel instance. */
  create: (config: Record<string, unknown>) => {
    kind: string;
    send: (message: unknown) => Promise<void>;
    dispose: () => Promise<void>;
  };
}

/** Observe event module contract. */
export interface ObserveHandlerModule {
  /** Handle an observe event. */
  handle: (ctx: unknown, spec: unknown) => string[];
}

/** Condition module contract using ConditionCapability (recommended for new modules). */
export interface ConditionCapabilityModule {
  /** Handler called when the condition is evaluated. Returns boolean. */
  handler: (arg: string, cap: ConditionCapability) => boolean;
}

/** Observe event module contract using ObserveCapability (recommended for new modules). */
export interface ObserveCapabilityModule {
  /** Handle an observe event with typed capability. */
  handle: (cap: ObserveCapability, spec: unknown) => string[];
}

/** Union type for all possible extension module exports. */
export type ExtensionModule =
  | ConditionModule
  | ConditionCapabilityModule
  | TopologyModule
  | TerminationParserModule
  | RecoveryStrategyModule
  | RecoveryPatternModule
  | NotificationChannelModule
  | ObserveHandlerModule
  | ObserveCapabilityModule
  | Record<string, unknown>;
