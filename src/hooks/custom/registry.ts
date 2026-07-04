import type {
  HookEvent,
  CustomHookConfig,
  HookContext,
  HookModule,
} from "./types.ts";
import { loadHookModule } from "./loader.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("hook:custom-registry");

interface RegisteredHook {
  config: CustomHookConfig;
  module: HookModule | null;
  roleDir: string;
}

export class CustomHookRegistry {
  private byEvent = new Map<HookEvent, RegisteredHook[]>();
  private deps?: {
    pendingCorrections: Map<string, string>;
    functionRuntime: { get: (sid: string, fn: string) => unknown };
    dispatchManager: { getTasksByParent?: (sid: string) => Array<{ id: string; status: string; agent: string }> };
    graphSessionState: { getState: (sid: string) => unknown };
  };

  setDeps(deps: NonNullable<CustomHookRegistry["deps"]>): void {
    this.deps = deps;
  }

  async register(hook: CustomHookConfig, roleDir: string): Promise<void> {
    const mod = await loadHookModule(hook.module, roleDir);

    const entry: RegisteredHook = { config: hook, module: mod, roleDir };

    // Fire onLoad lifecycle hook after successful registration
    if (mod?.onLoad) {
      const ctx: HookContext = {
        hookName: hook.name,
        config: hook.config,
        inject: () => {},
        log: createSubLogger(`hook:${hook.name}`),
      };
      try {
        await mod.onLoad(ctx);
      } catch (err) {
        log.warn(`Custom hook "${hook.name}" onLoad threw`, { err });
      }
    }

    for (const event of hook.events) {
      const list = this.byEvent.get(event) ?? [];
      list.push(entry);
      this.byEvent.set(event, list);
    }

    log.debug("Registered custom hook", { name: hook.name, events: hook.events });
  }

  getHooks(event: HookEvent, phase: "before" | "after"): RegisteredHook[] {
    const all = this.byEvent.get(event);
    if (!all || all.length === 0) return [];

    return all
      .filter((h) => (h.config.phase ?? "after") === phase)
      .sort((a, b) => (a.config.priority ?? 50) - (b.config.priority ?? 50));
  }

  async runHooks(
    event: HookEvent,
    phase: "before" | "after",
    ctxFactory: () => HookContext,
    input: unknown,
  ): Promise<void> {
    const hooks = this.getHooks(event, phase);
    if (hooks.length === 0) return;

    for (const hook of hooks) {
      if (!hook.module) continue;

      const ctx = ctxFactory();
      if (this.deps) this.enrichContext(ctx, event, input);
      const mod = hook.module;
      const name = hook.config.name;

      try {
        // Apply filter logic
        if (hook.config.filter) {
          const filter = hook.config.filter;

          // Tool-specific filter for tool events
          if (
            filter.tools &&
            (event === "tool.execute.before" || event === "tool.execute.after")
          ) {
            const toolInput = input as { tool?: string } | undefined;
            if (toolInput?.tool && !filter.tools.includes(toolInput.tool)) {
              continue;
            }
          }

          // Event-type filter for event hook
          if (filter.eventTypes && event === "event") {
            const eventInput = input as { type?: string } | undefined;
            if (eventInput?.type && !filter.eventTypes.includes(eventInput.type)) {
              continue;
            }
          }
        }

        // Dispatch to the appropriate handler method based on event type
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
        log.warn(`Custom hook "${name}" failed on ${event}`, { err });
      }
    }
  }

  private enrichContext(ctx: HookContext, event: HookEvent, input: unknown): void {
    const deps = this.deps!;

    ctx.getFunctionState = (fnName: string) =>
      deps.functionRuntime.get(ctx.sessionID ?? "", fnName);

    ctx.getDispatchState = () => {
      const tasks = deps.dispatchManager.getTasksByParent?.(ctx.sessionID ?? "") ?? [];
      return {
        activeTaskCount: tasks.filter((t) => t.status === "running").length,
        tasks: tasks.map(t => ({ id: t.id, status: t.status, subagent: t.agent })),
      };
    };

    ctx.getGraphState = () =>
      deps.graphSessionState.getState(ctx.sessionID ?? "");

    ctx.getBlocks = () => {
      if (event !== "system.transform") return [];
      const sysInput = input as { system?: string[] };
      return (sysInput.system ?? []).map((s) => {
        const match = s.match(/^<(\w+)>/);
        return { tag: match ? match[1] : "text", content: s };
      });
    };

    ctx.replaceBlock = (tag: string, newContent: string) => {
      if (event !== "system.transform") return;
      const sysInput = input as { system?: string[] };
      if (!sysInput.system) return;
      const idx = sysInput.system.findIndex((s) => s.includes(`<${tag}>`));
      if (idx >= 0) sysInput.system[idx] = newContent;
    };

    ctx.removeBlock = (tag: string) => {
      if (event !== "system.transform") return;
      const sysInput = input as { system?: string[] };
      if (!sysInput.system) return;
      const idx = sysInput.system.findIndex((s) => s.includes(`<${tag}>`));
      if (idx >= 0) sysInput.system.splice(idx, 1);
    };

    ctx.skip = () => {
      if (typeof input === "object" && input !== null) {
        (input as Record<string, unknown>).__skip = true;
      }
    };

    ctx.retry = () => {
      if (typeof input === "object" && input !== null) {
        (input as Record<string, unknown>).__retry = true;
      }
    };
  }

  async dispose(): Promise<void> {
    const visited = new Set<string>();

    for (const [, hooks] of this.byEvent) {
      for (const hook of hooks) {
        if (!hook.module?.onDispose) continue;
        if (visited.has(hook.config.name)) continue;
        visited.add(hook.config.name);

        const ctx: HookContext = {
          hookName: hook.config.name,
          config: hook.config.config,
          inject: () => {},
          log: createSubLogger(`hook:${hook.config.name}`),
        };
        try {
          await hook.module.onDispose(ctx);
        } catch (err) {
          log.warn(`Custom hook "${hook.config.name}" onDispose threw`, { err });
        }
      }
    }

    this.byEvent.clear();
  }
}
