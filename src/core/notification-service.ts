import type { PluginService } from "./service.ts";
import type { PluginContext } from "./context.ts";
import { NotificationManager } from "../notifications/manager.ts";
import type { NotificationConfig } from "../notifications/types.ts";
import { parseNotificationConfig, resolveEnvVarsInConfig, DEFAULT_NOTIFICATION_CONFIG } from "../notifications/config.ts";
import { createNotificationHook } from "../notifications/hook.ts";
import { readFileSync, existsSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { createSubLogger } from "../logger.ts";
import { hookState } from "../hooks/state.ts";

const log = createSubLogger("notification-service");

export class NotificationService implements PluginService {
  readonly name = "notification-service";
  readonly dependencies: string[] = [];

  private notificationManager?: NotificationManager;

  async init(ctx: PluginContext): Promise<void> {
    let notificationManager = hookState.notificationManager;
    if (!notificationManager) {
      // Parse global config from env var ROLEBOX_NOTIFICATIONS_CONFIG (path to YAML file)
      let globalNotifConfig: NotificationConfig = { ...DEFAULT_NOTIFICATION_CONFIG };
      const notifConfigPath = process.env.ROLEBOX_NOTIFICATIONS_CONFIG;
      if (notifConfigPath && existsSync(notifConfigPath)) {
        try {
          const raw = readFileSync(notifConfigPath, "utf-8");
          const parsed = loadYaml(raw);
          globalNotifConfig = resolveEnvVarsInConfig(parseNotificationConfig(parsed));
        } catch (e) {
          log.warn("Failed to parse notification config file", { path: notifConfigPath, error: e instanceof Error ? e.message : String(e) });
        }
      }
      // Also check env var to enable/disable
      if (process.env.ROLEBOX_NOTIFICATIONS_ENABLED === "false" || process.env.ROLEBOX_NOTIFICATIONS_ENABLED === "0") {
        globalNotifConfig = { ...globalNotifConfig, enabled: false };
      }

      // Collect per-role notification configs from resolved roles
      const roleNotifConfigs = new Map<string, NotificationConfig>();
      for (const role of ctx.resolvedRoles) {
        if (role.config.notifications) {
          const parsed = parseNotificationConfig(role.config.notifications);
          const resolved = resolveEnvVarsInConfig(parsed);
          roleNotifConfigs.set(role.id, resolved);
        }
      }

      notificationManager = new NotificationManager({
        globalConfig: globalNotifConfig,
        roleConfigs: roleNotifConfigs,
        client: ctx.client,
        dir: ctx.directory,
      });
      hookState.notificationManager = notificationManager;
    }
    this.notificationManager = notificationManager;
  }

  async dispose(): Promise<void> {
    try { await this.notificationManager?.dispose(); } catch {}
  }

  getNotificationManager(): NotificationManager | undefined {
    return this.notificationManager;
  }

  createNotificationHook() {
    if (!this.notificationManager) return null;
    return createNotificationHook(this.notificationManager);
  }
}
