import type { Logger, ILogObj } from "tslog";

/** The lifecycle events a custom hook can listen to. */
export type HookEvent =
  | "chat.message"
  | "tool.execute.before"
  | "tool.execute.after"
  | "system.transform"
  | "event";

/** Filter criteria to limit when a hook fires. */
export interface HookFilter {
  /** Only fire for these tool names (tool.execute.before/after only) */
  tools?: string[];
  /** Only fire for these event subtypes (event hook only: session.idle, session.error, etc.) */
  eventTypes?: string[];
}

/** A single custom hook declaration from role.yaml. */
export interface CustomHookConfig {
  name: string;
  description?: string;
  events: HookEvent[];
  module: string;
  config?: Record<string, unknown>;
  filter?: HookFilter;
  priority?: number;   // default 50, lower = earlier
  phase?: "before" | "after"; // default "after" (after built-in hooks)
}

/** The hooks block in role.yaml. */
export interface HooksBlock {
  builtin?: Record<string, boolean>;
  custom?: CustomHookConfig[];
}

/** Context passed to every custom hook handler invocation. */
export interface HookContext {
  /** The hook's name (from config) */
  hookName: string;
  /** The hook's config (from role.yaml, passed through as-is) */
  config: Record<string, unknown> | undefined;
  /** Current session ID (when available) */
  sessionID?: string;
  /** Current agent ID (when available) */
  agent?: string;
  /** Inject text into the next system prompt (same mechanism as appendCorrection) */
  inject: (text: string) => void;
  /** Structured logger scoped to this hook */
  log: Logger<ILogObj>;
}

/** The module interface that custom hook files must export. */
export interface HookModule {
  /** Called on chat.message hook */
  onChatMessage?: (ctx: HookContext, input: { text: string }) => void | Promise<void>;
  /** Called on tool.execute.before hook */
  onToolBefore?: (ctx: HookContext, input: { tool: string; args: unknown }) => void | Promise<void>;
  /** Called on tool.execute.after hook */
  onToolAfter?: (ctx: HookContext, input: { tool: string; args: unknown; output: unknown }) => void | Promise<void>;
  /** Called on system.transform hook */
  onSystemTransform?: (ctx: HookContext, input: { system: string[] }) => void | Promise<void>;
  /** Called on event hook (session.idle, session.error, etc.) */
  onEvent?: (ctx: HookContext, input: { type: string; properties?: Record<string, unknown> }) => void | Promise<void>;
  /** Called once when the hook is loaded (lifecycle) */
  onLoad?: (ctx: HookContext) => void | Promise<void>;
  /** Called once when the plugin disposes (lifecycle) */
  onDispose?: (ctx: HookContext) => void | Promise<void>;
}
