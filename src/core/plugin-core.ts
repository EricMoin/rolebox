import type { PluginService, PluginCoreLike } from "./service.ts";
import type { ServiceName } from "./service-names.ts";
import type { PluginContext } from "./context.ts";
import { EventBus } from "./event-bus.ts";
import { createSubLogger } from "../logger.ts";
import { logEvent } from "../log/index.ts";
import { StartupChecker } from "../recovery/startup-check.ts";
import type { StartupHealth } from "../recovery/startup-check.ts";
import { stateDirFor } from "../utils/state-paths.ts";
import { ServiceSupervisor } from "./service-supervisor.ts";

export class DescriptiveCycleError extends Error {
  public readonly cycleMembers: string[];

  constructor(cycleMembers: string[]) {
    const message = `Circular dependency detected among services: [${cycleMembers.join(", ")}]`;
    super(message);
    this.name = "DescriptiveCycleError";
    this.cycleMembers = cycleMembers;
  }
}

const log = createSubLogger("plugin-core");

export class PluginCore implements PluginCoreLike {
  private services = new Map<ServiceName, PluginService>();
  private ctx!: PluginContext;
  private disposed = false;
  private bus = new EventBus();
  private degraded = new Set<string>();

  private supervisor: ServiceSupervisor;

  constructor() {
    this.supervisor = new ServiceSupervisor(this);
  }

  registerService(svc: PluginService): void {
    if (this.services.has(svc.name)) {
      logEvent("plugin-core.registration-replaced", { service: svc.name });
    }
    this.services.set(svc.name, svc);
  }

  getService<T>(name: ServiceName): T | undefined {
    return this.services.get(name) as T | undefined;
  }

  getServices(): Map<ServiceName, PluginService> {
    return this.services;
  }

  getBus(): EventBus {
    return this.bus;
  }

  isDegraded(name: ServiceName): boolean {
    return this.degraded.has(name);
  }

  getSupervisor(): ServiceSupervisor {
    return this.supervisor;
  }


  async init(ctx: PluginContext): Promise<void> {
    this.ctx = { ...ctx, bus: this.bus };
    // Run startup consistency check before initializing services
    let health: StartupHealth;
    try {
      health = StartupChecker.checkAll(ctx.directory, stateDirFor(ctx.directory));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(`Startup check failed: ${errMsg}`);
      health = {
        healthy: false,
        quarantined: [],
        staleLocksBroken: 0,
        orphanTmpsRemoved: 0,
        warnings: [`startup check failed: ${errMsg}`],
      };
    }
    if (health.warnings.length > 0) {
      log.info(`Startup check completed: ${health.warnings.length} warning(s)`, {
        quarantined: health.quarantined.length,
        staleLocksBroken: health.staleLocksBroken,
        orphanTmpsRemoved: health.orphanTmpsRemoved,
      });
    }

    // Topological sort by dependencies
    const ordered = this.topoSort();
    for (const svc of ordered) {
      // If any dependency is degraded, skip this service entirely
      const degradedDeps = svc.dependencies.filter(d => this.degraded.has(d));
      if (degradedDeps.length > 0) {
        logEvent("plugin-core.init-skipped", {
          service: svc.name,
          degradedDeps,
        });
        this.degraded.add(svc.name);
        continue;
      }

      log.debug("Initializing service", { name: svc.name, deps: svc.dependencies });
      try {
        await svc.init(this.ctx);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (svc.critical) {
          log.fatal("Critical service init failed, aborting", { name: svc.name, error: errMsg });
          throw err;
        }
        logEvent("plugin-core.init-failed", {
          service: svc.name,
          error: errMsg,
        });
        this.degraded.add(svc.name);
      }
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
        logEvent("plugin-core.dispose-failed", { service: svc.name, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /**
   * Restart a single service and all its transitive dependents.
   * Disposes the target service, re-initializes it, then disposes and
   * re-initializes every service that depends on it (transitively).
   * Errors during dispose are caught and logged; re-init errors propagate.
   */
  async restartService(name: ServiceName): Promise<void> {
    const svc = this.services.get(name);
    if (!svc) {
      logEvent("plugin-core.restart-unknown-service", { service: name });
      return;
    }
    if (!this.ctx) {
      logEvent("plugin-core.restart-no-context", { service: name });
      return;
    }

    // Build reverse dependency map to compute transitive dependents
    const revDeps = new Map<ServiceName, ServiceName[]>();
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
    const affected = new Set<ServiceName>([name]);
    const queue: ServiceName[] = [name];
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
        logEvent("plugin-core.restart-dispose-failed", {
          service: s.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await s.init(this.ctx);
    }

    log.info("Service restart complete", { target: name, restarted: toRestart.map(s => s.name) });
  }

  private topoSort(): PluginService[] {
    const visited = new Set<ServiceName>();
    const result: PluginService[] = [];
    const visiting = new Set<ServiceName>();
    const path: ServiceName[] = [];

    const visit = (name: ServiceName) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        // Recover the cycle members from the current DFS path
        const cycleStart = path.indexOf(name);
        const cycleMembers = path.slice(cycleStart);
        throw new DescriptiveCycleError(cycleMembers);
      }
      visiting.add(name);
      path.push(name);
      const svc = this.services.get(name);
      if (svc) {
        for (const dep of svc.dependencies) {
          visit(dep);
        }
        result.push(svc);
      }
      path.pop();
      visiting.delete(name);
      visited.add(name);
    };

    for (const name of this.services.keys()) {
      visit(name);
    }
    return result;
  }
}
