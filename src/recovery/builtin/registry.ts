import type { BuiltInHookDefinition } from "../types.ts";
import type { HookContext } from "../../hooks/custom/types.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("recovery:builtin-registry");

export class BuiltInHookRegistry {
  private byEvent = new Map<string, BuiltInHookDefinition[]>();

  register(hook: BuiltInHookDefinition): void {
    for (const event of hook.events) {
      const list = this.byEvent.get(event) ?? [];
      list.push(hook);
      this.byEvent.set(event, list);
    }
    log.debug("Registered built-in hook", { name: hook.name, events: hook.events });
  }

  getHooks(
    event: string,
    phase: "before" | "after",
    builtinConfig: Record<string, boolean>,
  ): BuiltInHookDefinition[] {
    const all = this.byEvent.get(event);
    if (!all || all.length === 0) return [];

    return all
      .filter((h) => h.phase === phase)
      .filter((h) => {
        if (builtinConfig.recovery === false) return false;
        const enabled = builtinConfig[h.configKey];
        return enabled === true;
      })
      .sort((a, b) => a.priority - b.priority);
  }

  async runHooks(
    event: string,
    phase: "before" | "after",
    ctxFactory: () => HookContext,
    input: unknown,
    builtinConfig: Record<string, boolean>,
  ): Promise<void> {
    const hooks = this.getHooks(event, phase, builtinConfig);
    if (hooks.length === 0) return;

    for (const hook of hooks) {
      if (hook.filter) {
        if (hook.filter.tools && (event === "tool.execute.before" || event === "tool.execute.after")) {
          const toolInput = input as { tool?: string } | undefined;
          if (toolInput?.tool && !hook.filter.tools.includes(toolInput.tool)) continue;
        }
        if (hook.filter.eventTypes && event === "event") {
          const eventInput = input as { type?: string } | undefined;
          if (eventInput?.type && !hook.filter.eventTypes.includes(eventInput.type)) continue;
        }
      }

      const ctx = ctxFactory();
      const mod = hook.module;

      try {
        switch (event) {
          case "chat.message":
            await mod.onChatMessage?.(ctx, input as { text: string });
            break;
          case "tool.execute.before":
            await mod.onToolBefore?.(ctx, input as { tool: string; args: unknown });
            break;
          case "tool.execute.after":
            await mod.onToolAfter?.(ctx, input as { tool: string; args: unknown; output: unknown });
            break;
          case "system.transform":
            await mod.onSystemTransform?.(ctx, input as { system: string[] });
            break;
          case "event":
            await mod.onEvent?.(ctx, input as { type: string; properties?: Record<string, unknown> });
            break;
        }
      } catch (err) {
        log.warn(`Built-in hook "${hook.name}" failed on ${event}`, { err });
      }
    }
  }

  clear(): void {
    this.byEvent.clear();
  }
}
