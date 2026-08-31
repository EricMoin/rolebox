import type { PluginService } from "../service.ts";
import type { PluginContext } from "../context.ts";
import { RecoveryEngine } from "../../recovery/engine.ts";
import { RecoveryStateStore } from "../../recovery/state.ts";
import { BuiltInHookRegistry } from "../../recovery/builtin/registry.ts";
import { registerBuiltinHooks } from "../../recovery/builtin/index.ts";
import { parseRecoveryConfig, mergeBuiltinFlags, DEFAULT_RECOVERY_CONFIG } from "../../recovery/config.ts";
import { hookState } from "../../hooks/state.ts";
import { createSubLogger } from "../../logger.ts";
import { StartupChecker } from "../../recovery/startup-check.ts";
import type { StartupHealth } from "../../recovery/startup-check.ts";
import { stateDirFor } from "../../utils/state-paths.ts";

const log = createSubLogger("recovery-service");

export class RecoveryService implements PluginService {
  readonly name = "recovery-service";
  readonly dependencies: string[] = [];
  readonly critical = true;

  private recoveryEngine?: RecoveryEngine;
  private builtInHookRegistry?: BuiltInHookRegistry;
  private builtinConfig?: Record<string, boolean>;
  private startupHealth: StartupHealth | undefined;
  private static notifiedQuarantine = false;

  /** Reset throttling flag (for testing). */
  static __resetNotifiedQuarantine(): void {
    RecoveryService.notifiedQuarantine = false;
  }

  async init(ctx: PluginContext): Promise<void> {
    const { resolvedRoles, directory, session: client } = ctx;
    const dir = directory;

    // Collect builtin flags and recovery configs from all roles
    const builtinFlagsList: Record<string, boolean>[] = [];
    const recoveryConfigsList: unknown[] = [];

    for (const role of resolvedRoles) {
      if (role.config.hooks) {
        if (role.config.hooks.builtin) {
          builtinFlagsList.push(role.config.hooks.builtin);
        }
        if (role.config.hooks.recovery) {
          recoveryConfigsList.push(role.config.hooks.recovery);
        }
      }
    }

    const builtinConfig = mergeBuiltinFlags(builtinFlagsList);

    // Tiered defaults: error recovery hooks default ON, guard hooks default OFF
    const ERROR_RECOVERY_HOOKS = [
      "session_error",
      "edit_error",
      "json_error",
      "context_window",
      "empty_response",
    ];
    const GUARD_HOOKS = [
      "tool_pair_validation",
      "write_existing_file_guard",
      "bash_file_read_guard",
      "webfetch_redirect_guard",
    ];

    // Apply tiered defaults only when user hasn't explicitly set a value
    for (const key of ERROR_RECOVERY_HOOKS) {
      if (builtinConfig[key] === undefined) {
        builtinConfig[key] = true;
      }
    }
    for (const key of GUARD_HOOKS) {
      if (builtinConfig[key] === undefined) {
        builtinConfig[key] = false;
      }
    }

    // Master recovery toggle defaults to true so the engine is created
    if (builtinConfig.recovery === undefined) {
      builtinConfig.recovery = true;
    }

    this.builtinConfig = builtinConfig;

    const recoveryConfig = recoveryConfigsList.length > 0
      ? parseRecoveryConfig(recoveryConfigsList[0])
      : DEFAULT_RECOVERY_CONFIG;

    if (builtinConfig.recovery === true) {
      const recoveryStateStore = new RecoveryStateStore(dir);
      this.recoveryEngine = new RecoveryEngine(recoveryConfig, recoveryStateStore, {
        pendingCorrections: hookState.pendingCorrections,
        client,
      });
      this.builtInHookRegistry = new BuiltInHookRegistry();
      registerBuiltinHooks(this.builtInHookRegistry, this.recoveryEngine);
    }

    // Defense-in-depth: run StartupChecker again at service init
    // PluginCore.init() at the top already runs this, but here at the
    // service layer we catch anything that might have been missed.
    let health: StartupHealth;
    try {
      health = StartupChecker.checkAll(dir, stateDirFor(dir));
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
    this.startupHealth = health;

    if (health.quarantined.length > 0 && !RecoveryService.notifiedQuarantine) {
      RecoveryService.notifiedQuarantine = true;
      const fileList = health.quarantined.join(", ");
      log.warn(`State files quarantined during startup: ${fileList}. Some state may have been lost.`);
    }

    if (health.warnings.length > 0) {
      log.info("RecoveryService startup check warnings", { warnings: health.warnings });
    }
  }

  async dispose(): Promise<void> {
    try { await this.recoveryEngine?.dispose(); } catch {}
  }

  getRecoveryEngine(): RecoveryEngine | undefined { return this.recoveryEngine; }
  getBuiltInHookRegistry(): BuiltInHookRegistry | undefined { return this.builtInHookRegistry; }
  getBuiltinConfig(): Record<string, boolean> | undefined { return this.builtinConfig; }
  getStartupHealth(): StartupHealth | undefined { return this.startupHealth; }

  health(): import("../service.ts").ServiceHealth {
    if (this.startupHealth && this.startupHealth.quarantined.length > 0) {
      return {
        status: "degraded",
        detail: `${this.startupHealth.quarantined.length} state file(s) quarantined during startup`,
      };
    }
    if (!this.recoveryEngine) {
      // Recovery engine not created (possibly disabled by config)
      return { status: "healthy", detail: "recovery engine not created" };
    }
    // Check recovery metrics for high failure rate
    const metrics = this.recoveryEngine.getMetrics();
    const totalAttempts = metrics.totalAttempts;
    const abortedChains = metrics.abortedChains;
    if (totalAttempts > 10 && abortedChains / totalAttempts > 0.5) {
      return { status: "degraded", detail: `high abort rate: ${abortedChains}/${totalAttempts}` };
    }
    return { status: "healthy" };
  }
}
