import type { PluginService, PluginCoreLike } from "./service.ts";
import type { PluginContext } from "./context.ts";
import { EventBus } from "./event-bus.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("plugin-core");

export class PluginCore implements PluginCoreLike {
  private services = new Map<string, PluginService>();
  private ctx!: PluginContext;
  private disposed = false;
  private bus = new EventBus();

  registerService(svc: PluginService): void {
    if (this.services.has(svc.name)) {
      log.warn("Service already registered, replacing", { name: svc.name });
    }
    this.services.set(svc.name, svc);
  }

  getService<T>(name: string): T | undefined {
    return this.services.get(name) as T | undefined;
  }

  getServices(): Map<string, PluginService> {
    return this.services;
  }

  getBus(): EventBus {
    return this.bus;
  }

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = { ...ctx, bus: this.bus };
    // Topological sort by dependencies
    const ordered = this.topoSort();
    log.info("Initializing services", { count: ordered.length, order: ordered.map(s => s.name) });
    for (const svc of ordered) {
      log.debug("Initializing service", { name: svc.name, deps: svc.dependencies });
      await svc.init(this.ctx);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Dispose in reverse order
    const ordered = this.topoSort();
    for (const svc of ordered.reverse()) {
      try {
        await svc.dispose();
      } catch (err) {
        log.warn("Service dispose failed", { name: svc.name, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /**
   * Restart a single service and all its transitive dependents.
   * Disposes the target service, re-initializes it, then disposes and
   * re-initializes every service that depends on it (transitively).
   * Errors during dispose are caught and logged; re-init errors propagate.
   */
  async restartService(name: string): Promise<void> {
    const svc = this.services.get(name);
    if (!svc) {
      log.warn("restartService: service not found", { name });
      return;
    }
    if (!this.ctx) {
      log.warn("restartService: no context, cannot restart", { name });
      return;
    }

    // Build reverse dependency map to compute transitive dependents
    const revDeps = new Map<string, string[]>();
    for (const [, s] of this.services) {
      for (const dep of s.dependencies) {
        const list = revDeps.get(dep);
        if (list) {
          list.push(s.name);
        } else {
          revDeps.set(dep, [s.name]);
        }
      }
    }

    // BFS to find the target + all transitive dependents
    const affected = new Set<string>([name]);
    const queue = [name];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const dependent of revDeps.get(current) ?? []) {
        if (!affected.has(dependent)) {
          affected.add(dependent);
          queue.push(dependent);
        }
      }
    }

    // Reorder affected services by the topological sort order
    const ordered = this.topoSort();
    const toRestart = ordered.filter(s => affected.has(s.name));

    for (const s of toRestart) {
      log.debug("Restarting service", { name: s.name });
      try {
        await s.dispose();
      } catch (err) {
        log.warn("Service dispose during restart failed", {
          name: s.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await s.init(this.ctx);
    }

    log.info("Service restart complete", { target: name, restarted: toRestart.map(s => s.name) });
  }

  private topoSort(): PluginService[] {
    const visited = new Set<string>();
    const result: PluginService[] = [];
    const visiting = new Set<string>();

    const visit = (name: string) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        log.error("Circular dependency detected", { name });
        return;
      }
      visiting.add(name);
      const svc = this.services.get(name);
      if (svc) {
        for (const dep of svc.dependencies) {
          visit(dep);
        }
        result.push(svc);
      }
      visiting.delete(name);
      visited.add(name);
    };

    for (const name of this.services.keys()) {
      visit(name);
    }
    return result;
  }
}
