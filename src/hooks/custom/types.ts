import type { Logger, ILogObj } from "tslog";
import type { RecoveryConfig } from "../../recovery/types.ts";

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
  recovery?: RecoveryConfig;
}

export interface PromptBlock {
  tag: string;
  content: string;
}

export interface DispatchSnapshot {
  activeTaskCount: number;
  tasks: Array<{ id: string; status: string; subagent: string }>;
}

export interface HookContext {
  hookName: string;
  config: Record<string, unknown> | undefined;
  sessionID?: string;
  agent?: string;
  inject: (text: string) => void;
  log: Logger<ILogObj>;

  replaceBlock?: (tag: string, newContent: string) => void;
  removeBlock?: (tag: string) => void;
  getBlocks?: () => PromptBlock[];

  getFunctionState?: (fnName: string) => unknown | undefined;
  getDispatchState?: () => DispatchSnapshot | undefined;
  getGraphState?: () => unknown | undefined;

  skip?: () => void;
  retry?: () => void;
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
