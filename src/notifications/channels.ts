// ── Multi-Channel Notification Dispatch ──────────────────────────────

import type {
  NotificationMessage,
  NotificationChannelConfig,
  NotificationChannelKind,
  PlatformInfo,
} from "./types.ts";
import { NOTIFICATION_CHANNEL_KINDS } from "./types.ts";
import {
  detectPlatform,
  commandExists,
  resolveToastSender,
  resolveSoundPlayer,
} from "./platform.ts";
import { SystemToastChannel } from "./channels/system-toast.ts";
import { SoundChannel } from "./channels/sound.ts";
import { CustomCommandChannel } from "./channels/custom-command.ts";
import { WebhookChannel } from "./channels/webhook.ts";
import { FileChannel } from "./channels/file.ts";
import { LogChannel } from "./channels/log.ts";

// ── Channel Interface ───────────────────────────────────────────────

export interface NotificationChannel {
  kind: NotificationChannelKind;
  send(message: NotificationMessage): Promise<void>;
  dispose(): Promise<void>;
}

// ── Custom Channel Factory Registry ──────────────────────────────────

const customChannelFactories = new Map<
  string,
  (config: Record<string, unknown>) => Promise<NotificationChannel | null>
>();

export function registerChannelFactory(
  kind: string,
  factory: (config: Record<string, unknown>) => Promise<NotificationChannel | null>,
): void {
  customChannelFactories.set(kind, factory);
}

// ── Factory ─────────────────────────────────────────────────────────

export async function createChannel(
  config: NotificationChannelConfig,
): Promise<NotificationChannel | null> {
  const customFactory = customChannelFactories.get(config.kind);
  if (customFactory) {
    return customFactory(config as unknown as Record<string, unknown>);
  }

  switch (config.kind) {
    case NOTIFICATION_CHANNEL_KINDS.SystemToast: {
      if (!config.enabled) return null;
      const platform = detectPlatform();
      if (platform.os === "unknown") return null;
      const primary = await resolveToastSender(platform.os);
      if (!primary) return null;

      let fallback: string | null = null;
      if (platform.os === "darwin" && primary === "terminal-notifier") {
        const osaExists = await commandExists("osascript");
        if (osaExists) fallback = "osascript";
      }

      return new SystemToastChannel(platform, primary, fallback);
    }

    case NOTIFICATION_CHANNEL_KINDS.Sound: {
      if (!config.enabled) return null;
      const platform = detectPlatform();
      if (platform.os === "unknown") return null;
      const player = await resolveSoundPlayer(platform.os);
      if (!player) return null;
      return new SoundChannel(platform, player, config.soundPath);
    }

    case NOTIFICATION_CHANNEL_KINDS.CustomCommand: {
      if (!config.enabled) return null;
      if (!config.command || config.command.trim().length === 0) return null;
      return new CustomCommandChannel(config.command, config.passAsStdin, config.env);
    }

    case NOTIFICATION_CHANNEL_KINDS.Webhook: {
      if (!config.enabled) return null;
      if (!config.url || config.url.trim().length === 0) return null;
      return new WebhookChannel(config.url, config.headers, config.timeoutMs);
    }

    case NOTIFICATION_CHANNEL_KINDS.File: {
      if (!config.enabled) return null;
      if (!config.path || config.path.trim().length === 0) return null;
      return new FileChannel(config.path);
    }

    case NOTIFICATION_CHANNEL_KINDS.Log: {
      if (!config.enabled) return null;
      return new LogChannel(config.level);
    }

    default:
      return null;
  }
}

export async function createChannels(
  configs: NotificationChannelConfig[],
): Promise<NotificationChannel[]> {
  const results = await Promise.allSettled(
    configs.map((c) => createChannel(c)),
  );
  const channels: NotificationChannel[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value !== null) {
      channels.push(r.value);
    }
  }
  return channels;
}
