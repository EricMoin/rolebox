import type { PluginService } from "./service.ts";
import type { PluginContext } from "./context.ts";
import type { EventBus } from "./event-bus.ts";
import { NotificationManager } from "../notifications/manager.ts";
import type { NotificationConfig } from "../notifications/types.ts";
import { parseNotificationConfig, resolveEnvVarsInConfig, DEFAULT_NOTIFICATION_CONFIG } from "../notifications/config.ts";
import { readFileSync, existsSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("notification-service");

export class NotificationService implements PluginService {
  readonly name = "notification-service";
  readonly dependencies: string[] = [];

  private notificationManager?: NotificationManager;
  private bus?: EventBus;
  /** Unsubscribe functions returned by bus.on() — called during dispose. */
  private unsubs: Array<() => void> = [];

  async init(ctx: PluginContext): Promise<void> {
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

    const mgr = new NotificationManager({
      globalConfig: globalNotifConfig,
      roleConfigs: roleNotifConfigs,
      client: ctx.client,
      dir: ctx.directory,
    });
    this.notificationManager = mgr;

    // Subscribe to lifecycle events instead of ad-hoc hook mounting
    this.bus = ctx.bus;

    this.unsubs.push(
      this.bus.on("hook:chat.message", (payload: { sessionID: string; agent?: string }) => {
        try { mgr.handleChatMessage(payload.sessionID, payload.agent); } catch { /* best effort */ }
      }),
    );

    this.unsubs.push(
      this.bus.on("hook:tool.execute.before", (payload: { tool: string; sessionID: string; callID: string; args?: unknown }) => {
        try { mgr.handleToolBefore(payload.sessionID, payload.tool, payload.args); } catch { /* best effort */ }
      }),
    );

    this.unsubs.push(
      this.bus.on("event:session.idle", (payload: { sessionID: string; agent?: string }) => {
        try { mgr.scheduleIdle(payload.sessionID, payload.agent); } catch { /* best effort */ }
      }),
    );

    this.unsubs.push(
      this.bus.on("event:session.error", (payload: { sessionID: string; agent?: string }) => {
        try { mgr.handleSessionError(payload.sessionID, payload.agent); } catch { /* best effort */ }
      }),
    );

    this.unsubs.push(
      this.bus.on("event:session.deleted", (payload: { sessionID: string }) => {
        try { mgr.handleSessionDeleted(payload.sessionID); } catch { /* best effort */ }
      }),
    );

    this.unsubs.push(
      this.bus.on("event:message.updated", (payload: { sessionID: string; agent?: string }) => {
        try { mgr.handleMessageUpdated(payload.sessionID, payload.agent); } catch { /* best effort */ }
      }),
    );
  }

  async dispose(): Promise<void> {
    // Unsubscribe all bus handlers owned by this service
    for (const unsub of this.unsubs) {
      try { unsub(); } catch { /* best effort */ }
    }
    this.unsubs = [];
    try { await this.notificationManager?.dispose(); } catch { /* best effort */ }
  }

  getNotificationManager(): NotificationManager | undefined {
    return this.notificationManager;
  }
}
