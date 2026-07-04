import type { PluginService } from "./service.ts";
import type { PluginContext } from "./context.ts";
import type { ServiceHealth } from "./service.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("health-monitor");

const DEFAULT_INTERVAL_MS = 30_000; // 30 seconds

export class HealthMonitorService implements PluginService {
  readonly name = "health-monitor-service";
  // Depends on hook-service so it initializes LAST (after all other services)
  readonly dependencies = ["hook-service"];

  private intervalTimer: ReturnType<typeof setInterval> | undefined;
  private ctx!: PluginContext;
  private disabled = false;

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;

    // Check env var: ROLEBOX_HEALTH_CHECK=false disables health monitoring
    if (process.env.ROLEBOX_HEALTH_CHECK === "false" || process.env.ROLEBOX_HEALTH_CHECK === "0") {
      this.disabled = true;
      log.info("Health monitoring disabled by env var");
      return;
    }

    const intervalMs = this.parseInterval();
    this.intervalTimer = setInterval(() => {
      void this.checkAll();
    }, intervalMs);

    log.info("Health monitor started", { intervalMs });
  }

  async dispose(): Promise<void> {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = undefined;
    }
  }

  health(): ServiceHealth {
    if (this.disabled) return { status: "healthy", detail: "disabled" };
    if (!this.intervalTimer) return { status: "degraded", detail: "timer not running" };
    return { status: "healthy" };
  }

  private parseInterval(): number {
    const raw = process.env.ROLEBOX_HEALTH_CHECK_INTERVAL_MS;
    if (!raw) return DEFAULT_INTERVAL_MS;
    const n = Number(raw);
    if (Number.isNaN(n) || n <= 0) return DEFAULT_INTERVAL_MS;
    return n;
  }

  private async checkAll(): Promise<void> {
    const services = this.ctx.core.getServices();
    for (const [name, svc] of services) {
      // Skip self to avoid recursive restart
      if (name === this.name) continue;
      // Skip services without health()
      if (typeof svc.health !== "function") continue;

      let result: ServiceHealth;
      try {
        result = svc.health();
      } catch (err) {
        result = {
          status: "unhealthy",
          detail: `health() threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      log.debug("Health check", {
        service: name,
        status: result.status,
        ...(result.detail ? { detail: result.detail } : {}),
      });

      if (result.status === "unhealthy") {
        log.warn("Service unhealthy, attempting restart", { service: name, detail: result.detail });
        try {
          await this.ctx.core.restartService(name);
          log.info("Service restarted after unhealthy check", { service: name });
        } catch (err) {
          log.error("Failed to restart unhealthy service", {
            service: name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }
}
