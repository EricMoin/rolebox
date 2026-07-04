import type { PluginService } from "./service.ts";
import type { PluginContext } from "./context.ts";
import { RecoveryEngine } from "../recovery/engine.ts";
import { RecoveryStateStore } from "../recovery/state.ts";
import { BuiltInHookRegistry } from "../recovery/builtin/registry.ts";
import { registerBuiltinHooks } from "../recovery/builtin/index.ts";
import { parseRecoveryConfig, mergeBuiltinFlags, DEFAULT_RECOVERY_CONFIG } from "../recovery/config.ts";
import { hookState } from "../hooks/state.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("recovery-service");

export class RecoveryService implements PluginService {
  readonly name = "recovery-service";
  readonly dependencies: string[] = [];

  private recoveryEngine?: RecoveryEngine;
  private builtInHookRegistry?: BuiltInHookRegistry;
  private builtinConfig?: Record<string, boolean>;

  async init(ctx: PluginContext): Promise<void> {
    const { resolvedRoles, directory, client } = ctx;
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
  }

  async dispose(): Promise<void> {
    try { await this.recoveryEngine?.dispose(); } catch {}
  }

  getRecoveryEngine(): RecoveryEngine | undefined { return this.recoveryEngine; }
  getBuiltInHookRegistry(): BuiltInHookRegistry | undefined { return this.builtInHookRegistry; }
  getBuiltinConfig(): Record<string, boolean> | undefined { return this.builtinConfig; }
}
