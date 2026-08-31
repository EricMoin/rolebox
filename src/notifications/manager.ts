// ── Central NotificationManager ─────────────────────────────────────────
//
// Orchestrates all notification subsystems: config resolution, quiet hours,
// throttling, content building, channel dispatch, and idle scheduling.
// All external entry points are safe (never throw).

import type { ISessionClient } from "../platform/ports/session-client.ts";
import { createSubLogger } from "../logger.ts";
import type { Logger } from "tslog";
import type { ILogObj } from "tslog";
import {
  NOTIFICATION_EVENT_TYPES,
  VALID_NOTIFICATION_EVENT_TYPES,
} from "./types.ts";
import type {
  NotificationConfig,
  NotificationChannelConfig,
  NotificationTemplateVars,
  PlatformInfo,
} from "./types.ts";
import { mergeNotificationConfigs } from "./config.ts";
import {
  detectPlatform,
  preWarmCommandCache,
} from "./platform.ts";
import { createChannels } from "./channels.ts";
import type { NotificationChannel } from "./channels.ts";
import { resolveChannels as resolveChannelsFn } from "./channel-resolver.ts";
import { buildNotificationContent } from "./content.ts";
import { NotificationThrottle } from "./throttle.ts";
import { QuietHours } from "./quiet-hours.ts";
import { NotificationScheduler, createScheduler } from "./scheduler.ts";

const log: Logger<ILogObj> = createSubLogger("NotificationManager");

/** Key used in channelCache for role-less (global) channel entries. */
const GLOBAL_CHANNEL_KEY = "__global__";

export class NotificationManager {
  private globalConfig: NotificationConfig;
  private roleConfigs: Map<string, NotificationConfig>;
  private client: ISessionClient;
  private dir: string;
  private scheduler: NotificationScheduler;
  private throttle: NotificationThrottle;
  private quietHours: QuietHours;
  /** Channel cache: keyed by agent (or GLOBAL_CHANNEL_KEY). Stores the
   *  promise during creation, then the resolved array once done. */
  private channelCache: Map<string, NotificationChannel[] | Promise<NotificationChannel[]>> = new Map();
  private platform: PlatformInfo;

  constructor(opts: {
    globalConfig: NotificationConfig;
    roleConfigs: Map<string, NotificationConfig>;
    client: ISessionClient;
    dir: string;
  }) {
    this.globalConfig = opts.globalConfig;
    this.roleConfigs = opts.roleConfigs;
    this.client = opts.client;
    this.dir = opts.dir;

    this.scheduler = createScheduler({
      idleDelayMs: opts.globalConfig.idleDelayMs,
    });

    this.throttle = new NotificationThrottle(opts.globalConfig.throttle);
    this.quietHours = new QuietHours(opts.globalConfig.quietHours);

    this.platform = detectPlatform();
    preWarmCommandCache([
      "terminal-notifier",
      "osascript",
      "notify-send",
      "afplay",
      "paplay",
      "aplay",
      "powershell",
    ]).catch((err) => {
      log.warn("Failed to pre-warm command cache", { err });
    });
  }

  // ── Config Resolution ────────────────────────────────────────────────

  /**
   * Resolve the effective `NotificationConfig` for a session.
   *
   * If `agent` is provided and a matching role config exists, the role
   * config is merged on top of the global config. Otherwise the bare
   * global config is returned.
   */
  getConfigForSession(_sessionID: string, agent?: string): NotificationConfig {
    if (agent && this.roleConfigs.has(agent)) {
      return mergeNotificationConfigs(
        this.globalConfig,
        this.roleConfigs.get(agent)!,
      );
    }
    return this.globalConfig;
  }

  // ── Primary Notify ───────────────────────────────────────────────────

  /**
   * The primary notification entry point.
   *
   * Applies guard checks (enabled, per-event enabled, quiet hours, throttle)
   * before building content and dispatching to all active channels.
   * NEVER throws — all errors are caught and logged at warn level.
   */
  async notify(opts: {
    sessionID: string;
    eventType: string;
    agent?: string;
    roleName?: string;
    questionText?: string;
    /** Extra template variables merged over the base vars (e.g. graph_id / node_id). */
    templateVars?: NotificationTemplateVars;
  }): Promise<void> {
    const { sessionID, eventType, agent, roleName, questionText, templateVars } = opts;

    if (!VALID_NOTIFICATION_EVENT_TYPES.has(eventType)) {
      log.warn(`Unknown notification event type: "${eventType}"`);
      return;
    }

    try {
      const config = this.getConfigForSession(sessionID, agent);
      if (!config.enabled) return;

      const eventConfig = config.events?.[eventType];
      if (eventConfig?.enabled === false) return;

      const hasEventOverride = eventConfig?.quietHoursOverride !== undefined;
      if (hasEventOverride) {
        const overrideQH = new QuietHours(eventConfig!.quietHoursOverride);
        if (overrideQH.isQuiet()) return;
      } else {
        if (this.quietHours.isQuiet()) return;
      }

      if (!this.throttle.allow(sessionID, eventType)) return;

      const message = await buildNotificationContent({
        sessionID,
        eventType,
        eventConfig,
        client: this.client,
        agent,
        roleName,
        dir: this.dir,
        extraVars: templateVars,
      });

      if (questionText) {
        message.body = message.body
          ? `${message.body}\n\n${questionText}`
          : questionText;
      }

      const channelConfigs: NotificationChannelConfig[] =
        eventConfig?.channels ?? config.channels;

      if (channelConfigs.length === 0) return;

      const cacheKey = agent ?? GLOBAL_CHANNEL_KEY;
      const channels = await this.resolveChannels(cacheKey, channelConfigs);

      const results = await Promise.allSettled(
        channels.map((ch) => ch.send(message)),
      );

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === "rejected") {
          log.warn(
            `Channel ${channels[i]?.kind ?? i} failed to send notification`,
            { err: r.reason },
          );
        }
      }

      log.debug(`Notification sent: ${eventType} for session ${sessionID}`);
    } catch (err) {
      log.warn(`Error sending notification for session ${sessionID}`, { err });
    }
  }

  // ── Channel Resolution ───────────────────────────────────────────────

  /**
   * Resolve notification channels for a cache key, lazily creating them
   * from the provided configs. The promise is cached to prevent races when
   * multiple notifications fire at the same time.
   */
  private async resolveChannels(
    cacheKey: string,
    configs: NotificationChannelConfig[],
  ): Promise<NotificationChannel[]> {
    return resolveChannelsFn(this.channelCache, cacheKey, configs);
  }

  // ── Activity Marking ─────────────────────────────────────────────────

  /** Mark session activity (delegates to scheduler). */
  markActivity(sessionID: string): void {
    this.scheduler.markSessionActivity(sessionID);
  }

  // ── Idle Scheduling ──────────────────────────────────────────────────

  /**
   * Schedule an idle notification for a session.
   * When the idle timer fires, calls `this.notify` with Idle event type.
   */
  scheduleIdle(sessionID: string, agent?: string): void {
    this.scheduler.scheduleIdleNotification(sessionID, () => {
      this.notify({
        sessionID,
        eventType: NOTIFICATION_EVENT_TYPES.Idle,
        agent,
      }).catch((err) => {
        log.warn("Scheduled idle notification failed", { sessionID, err });
      });
    });
  }

  // ── Session Lifecycle Handlers ───────────────────────────────────────

  /** Handle session deletion (clean up scheduler + throttle state). */
  handleSessionDeleted(sessionID: string): void {
    this.scheduler.deleteSession(sessionID);
    this.throttle.removeSession(sessionID);
  }

  /** Handle session errors by firing an Error notification. */
  handleSessionError(sessionID: string, agent?: string): void {
    this.notify({
      sessionID,
      eventType: NOTIFICATION_EVENT_TYPES.Error,
      agent,
    }).catch((err) => {
      log.warn("Session-error notification failed", { sessionID, err });
    });
  }

  /** Handle message update by marking session activity. */
  handleMessageUpdated(sessionID: string, _agent?: string): void {
    this.markActivity(sessionID);
  }

  /** Handle chat message by marking session activity. */
  handleChatMessage(sessionID: string, _agent?: string): void {
    this.markActivity(sessionID);
  }

  // ── Tool Before ──────────────────────────────────────────────────────

  /**
   * Handle tool-before events. If the tool name matches a configured
   * question tool name, extract the question text from args and fire
   * a Question notification.
   */
  handleToolBefore(
    sessionID: string,
    tool: string,
    args?: unknown,
    agent?: string,
  ): void {
    try {
      const config = this.getConfigForSession(sessionID, agent);
      const matches = config.questionToolNames.some(
        (name) => tool === name,
      );
      if (!matches) return;

      let questionText: string | undefined;

      if (args && typeof args === "object") {
        const obj = args as Record<string, unknown>;
        const questions = obj.questions;
        if (
          Array.isArray(questions) &&
          questions.length > 0 &&
          typeof questions[0] === "object" &&
          questions[0] !== null
        ) {
          const q = (questions[0] as Record<string, unknown>).question;
          if (typeof q === "string") {
            questionText = q;
          }
        }
      }

      this.notify({
        sessionID,
        eventType: NOTIFICATION_EVENT_TYPES.Question,
        agent,
        questionText,
      }).catch((err) => {
        log.warn("Question notification failed", { sessionID, err });
      });
    } catch (err) {
      log.warn("Error in handleToolBefore", { err });
    }
  }

  // ── Dispatch / Loop Completion ───────────────────────────────────────

  /** Handle dispatch completion by firing a DispatchComplete notification. */
  handleDispatchComplete(sessionID: string, agent?: string): void {
    this.notify({
      sessionID,
      eventType: NOTIFICATION_EVENT_TYPES.DispatchComplete,
      agent,
    }).catch((err) => {
      log.warn("Dispatch-complete notification failed", { sessionID, err });
    });
  }

  /** Handle loop completion by firing a LoopComplete notification. */
  handleLoopComplete(sessionID: string, agent?: string): void {
    this.notify({
      sessionID,
      eventType: NOTIFICATION_EVENT_TYPES.LoopComplete,
      agent,
    }).catch((err) => {
      log.warn("Loop-complete notification failed", { sessionID, err });
    });
  }

  /**
   * Handle a graph reaching a quiescent-blocked state (one or more nodes await
   * approval) by firing an ApprovalPending notification. Mirrors
   * {@link handleDispatchComplete}: goes through the standard `notify` path so
   * channel routing, quiet-hours, and throttle all apply. Passes `graph_id` /
   * `node_id` as template vars so the title/message templates can reference
   * them (e.g. "Approval gate waiting: {graph_id}/{node_id}").
   *
   * @param sessionID - Owning (emperor/orchestrator) session id.
   * @param graphId - The blocked graph's id.
   * @param nodeId - The blocked node id, when known. The graph-terminal seam
   *   is graph-level and may not carry a single node id, so this is optional.
   * @param agent - Optional agent tag for role-scoped config resolution.
   */
  handleApprovalPending(
    sessionID: string,
    graphId: string,
    nodeId?: string,
    agent?: string,
  ): void {
    this.notify({
      sessionID,
      eventType: NOTIFICATION_EVENT_TYPES.ApprovalPending,
      agent,
      templateVars: {
        graph_id: graphId,
        node_id: nodeId ?? "",
      },
    }).catch((err) => {
      log.warn("Approval-pending notification failed", { sessionID, err });
    });
  }

  // ── Hot Reload ───────────────────────────────────────────────────────

  /**
   * Hot-reload the notification configuration.
   *
   * Updates global and role-level configs, recreates throttle and quiet
   * hours instances, updates the scheduler's idle delay, and clears the
   * channel cache.
   */
  reloadConfig(
    global: NotificationConfig,
    roleConfigs: Map<string, NotificationConfig>,
  ): void {
    this.globalConfig = global;
    this.roleConfigs = roleConfigs;

    this.throttle.dispose();
    this.throttle = new NotificationThrottle(global.throttle);
    this.quietHours = new QuietHours(global.quietHours);

    this.scheduler = createScheduler({
      idleDelayMs: global.idleDelayMs,
    });

    this.channelCache.clear();

    log.debug("NotificationManager configuration reloaded");
  }

  // ── Dispose ──────────────────────────────────────────────────────────

  /**
   * Dispose all resources: scheduler, throttle, and all cached channels.
   * Safe to call multiple times.
   */
  async dispose(): Promise<void> {
    this.scheduler.dispose();
    this.throttle.dispose();

    const pending: Promise<void>[] = [];
    for (const entry of this.channelCache.values()) {
      const channels = Array.isArray(entry) ? entry : [];
      for (const ch of channels) {
        pending.push(
          ch.dispose().catch((err) => {
            log.warn("Failed to dispose notification channel", { err });
          }),
        );
      }
    }

    await Promise.allSettled(pending);
    this.channelCache.clear();

    log.debug("NotificationManager disposed");
  }
}
