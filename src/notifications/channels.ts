// ── Multi-Channel Notification Dispatch ──────────────────────────────

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  NotificationMessage,
  NotificationChannelConfig,
  PlatformInfo,
} from "./types.ts";
import { NotificationChannelKind } from "./types.ts";
import {
  detectPlatform,
  commandExists,
  resolveToastSender,
  resolveSoundPlayer,
} from "./platform.ts";
import {
  buildAppleScriptNotification,
  buildWindowsToastScript,
  buildNotifySendCommand,
  escapePowerShellSingleQuotedText,
  truncate,
} from "./formatting.ts";
import { createSubLogger } from "../logger.ts";

// ── Promisified execFile ────────────────────────────────────────────

const execFileAsync = promisify(execFile);

// ── Logger ──────────────────────────────────────────────────────────

const logger = createSubLogger("notification");

// ── Channel Interface ───────────────────────────────────────────────

export interface NotificationChannel {
  kind: NotificationChannelKind;
  send(message: NotificationMessage): Promise<void>;
  dispose(): Promise<void>;
}

// ── SystemToastChannel ──────────────────────────────────────────────

class SystemToastChannel implements NotificationChannel {
  readonly kind = NotificationChannelKind.SystemToast;
  private platform: PlatformInfo;
  private primary: string | null;
  private fallback: string | null;

  constructor(
    platform: PlatformInfo,
    primary: string | null,
    fallback: string | null,
  ) {
    this.platform = platform;
    this.primary = primary;
    this.fallback = fallback;
  }

  async send(message: NotificationMessage): Promise<void> {
    const title = truncate(message.title, 256);
    const body = truncate(message.body, 4000);

    if (this.platform.os === "darwin") {
      // Try terminal-notifier first, fallback to osascript
      if (
        this.primary === "terminal-notifier" ||
        this.fallback === "terminal-notifier"
      ) {
        try {
          await execFileAsync("terminal-notifier", [
            "-title",
            title,
            "-message",
            body,
          ]);
          return;
        } catch {}
      }
      if (
        this.primary === "osascript" ||
        this.fallback === "osascript"
      ) {
        try {
          const script = buildAppleScriptNotification(title, body);
          await execFileAsync("osascript", ["-e", script]);
          return;
        } catch {}
      }
    } else if (this.platform.os === "linux") {
      try {
        await execFileAsync(
          "notify-send",
          buildNotifySendCommand(title, body),
        );
        return;
      } catch {}
    } else if (this.platform.os === "win32") {
      try {
        const script = buildWindowsToastScript(title, body);
        await execFileAsync("powershell", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          script,
        ]);
        return;
      } catch {}
    }

    logger.warn("all system toast attempts failed", {
      platform: this.platform.os,
    });
  }

  async dispose(): Promise<void> {}
}

// ── SoundChannel ────────────────────────────────────────────────────

class SoundChannel implements NotificationChannel {
  readonly kind = NotificationChannelKind.Sound;
  private platform: PlatformInfo;
  private player: string | null;
  private soundPath: string;

  constructor(
    platform: PlatformInfo,
    player: string | null,
    soundPath: string,
  ) {
    this.platform = platform;
    this.player = player;
    this.soundPath = soundPath;
  }

  async send(_message: NotificationMessage): Promise<void> {
    if (!this.player) {
      logger.warn("no sound player available");
      return;
    }

    const path = this.soundPath;

    try {
      if (this.platform.os === "darwin") {
        await execFileAsync("afplay", [path]);
      } else if (this.platform.os === "linux") {
        try {
          await execFileAsync("paplay", [path]);
        } catch {
          await execFileAsync("aplay", [path]);
        }
      } else if (this.platform.os === "win32") {
        const escapedPath = escapePowerShellSingleQuotedText(path);
        const script = `[System.Media.SoundPlayer]::new('${escapedPath}').PlaySync()`;
        await execFileAsync("powershell", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          script,
        ]);
      }
    } catch (err) {
      logger.warn("failed to play notification sound", { err });
    }
  }
  async dispose(): Promise<void> {}
}

// ── CustomCommandChannel ────────────────────────────────────────────

class CustomCommandChannel implements NotificationChannel {
  readonly kind = NotificationChannelKind.CustomCommand;
  private command: string;
  private passAsStdin: boolean;
  private additionalEnv: Record<string, string> | undefined;

  constructor(
    command: string,
    passAsStdin: boolean | undefined,
    env: Record<string, string> | undefined,
  ) {
    this.command = command;
    this.passAsStdin = passAsStdin ?? false;
    this.additionalEnv = env;
  }

  async send(message: NotificationMessage): Promise<void> {
    const isWin = process.platform === "win32";
    const shell = isWin ? "cmd.exe" : "/bin/sh";
    const shellArgs = isWin
      ? ["/c", this.command]
      : ["-c", this.command];

    const baseEnv: Record<string, string> = {
      NOTICE_TITLE: message.title,
      NOTICE_BODY: message.body,
      NOTICE_SESSION_ID: message.sessionId,
      NOTICE_EVENT_TYPE: message.eventType,
      NOTICE_AGENT: message.agent ?? "",
      NOTICE_ROLE_NAME: message.roleName ?? "",
      NOTICE_TIMESTAMP: message.timestamp,
    };

    const mergedEnv = {
      ...process.env,
      ...baseEnv,
      ...this.additionalEnv,
    } as Record<string, string>;

    try {
      if (this.passAsStdin) {
        await this.runWithStdin(shell, shellArgs, mergedEnv, message);
      } else {
        await execFileAsync(shell, shellArgs, {
          env: mergedEnv,
          timeout: 10_000,
        });
      }
    } catch (err) {
      logger.warn("custom command failed", { err });
    }
  }

  private runWithStdin(
    shell: string,
    shellArgs: string[],
    env: Record<string, string>,
    message: NotificationMessage,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const child = execFile(shell, shellArgs, {
        env,
        timeout: 10_000,
      });

      if (child.stdin) {
        const input = JSON.stringify(message);
        child.stdin.write(input);
        child.stdin.end();
      }

      child.on("exit", (code) => {
        if (code !== 0) {
          logger.warn("custom command exited with non-zero code", {
            code,
            command: this.command,
          });
        }
        resolve();
      });

      child.on("error", () => {
        logger.warn("custom command process error", {
          command: this.command,
        });
        resolve();
      });
    });
  }
  async dispose(): Promise<void> {}
}

// ── WebhookChannel ──────────────────────────────────────────────────

class WebhookChannel implements NotificationChannel {
  readonly kind = NotificationChannelKind.Webhook;
  private url: string;
  private headers: Record<string, string>;
  private timeoutMs: number;

  constructor(
    url: string,
    headers: Record<string, string> | undefined,
    timeoutMs: number | undefined,
  ) {
    this.url = url;
    this.headers = { "Content-Type": "application/json", ...headers };
    this.timeoutMs = timeoutMs ?? 5_000;
  }

  async send(message: NotificationMessage): Promise<void> {
    const body = JSON.stringify({
      title: message.title,
      body: message.body,
      sessionId: message.sessionId,
      eventType: message.eventType,
      agent: message.agent,
      roleName: message.roleName,
      timestamp: message.timestamp,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: this.headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        logger.warn("webhook returned non-ok status", {
          status: response.status,
          url: this.url,
        });
      }
    } catch (err) {
      logger.warn("webhook request failed", { err, url: this.url });
    } finally {
      clearTimeout(timer);
    }
  }
  async dispose(): Promise<void> {}
}

// ── FileChannel ─────────────────────────────────────────────────────

class FileChannel implements NotificationChannel {
  readonly kind = NotificationChannelKind.File;
  private path: string;

  constructor(path: string) {
    this.path = path;
  }

  async send(message: NotificationMessage): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const line = JSON.stringify(message) + "\n";
      await appendFile(this.path, line, "utf-8");
    } catch (err) {
      logger.warn("file channel write failed", { err, path: this.path });
    }
  }
  async dispose(): Promise<void> {}
}

// ── LogChannel ──────────────────────────────────────────────────────

class LogChannel implements NotificationChannel {
  readonly kind = NotificationChannelKind.Log;
  private level: "info" | "warn" | "error" | "debug";
  private channelLogger = createSubLogger("notification");

  constructor(level: "info" | "warn" | "error" | "debug" | undefined) {
    this.level = level ?? "info";
  }

  async send(message: NotificationMessage): Promise<void> {
    const text = `[${message.eventType}] ${message.title} — ${message.body}`;
    switch (this.level) {
      case "debug":
        this.channelLogger.debug(text);
        break;
      case "warn":
        this.channelLogger.warn(text);
        break;
      case "error":
        this.channelLogger.error(text);
        break;
      case "info":
      default:
        this.channelLogger.info(text);
        break;
    }
  }
  async dispose(): Promise<void> {}
}

// ── Factory ─────────────────────────────────────────────────────────

export async function createChannel(
  config: NotificationChannelConfig,
): Promise<NotificationChannel | null> {
  switch (config.kind) {
    case NotificationChannelKind.SystemToast: {
      if (!config.enabled) return null;
      const platform = detectPlatform();
      if (platform.os === "unknown") return null;
      const primary = await resolveToastSender(platform.os);
      if (!primary) return null;

      // For macOS, detect osascript as a fallback
      let fallback: string | null = null;
      if (platform.os === "darwin" && primary === "terminal-notifier") {
        const osaExists = await commandExists("osascript");
        if (osaExists) fallback = "osascript";
      }

      return new SystemToastChannel(platform, primary, fallback);
    }

    case NotificationChannelKind.Sound: {
      if (!config.enabled) return null;
      const platform = detectPlatform();
      if (platform.os === "unknown") return null;
      const player = await resolveSoundPlayer(platform.os);
      if (!player) return null;
      return new SoundChannel(platform, player, config.soundPath);
    }

    case NotificationChannelKind.CustomCommand: {
      if (!config.enabled) return null;
      if (!config.command || config.command.trim().length === 0) return null;
      return new CustomCommandChannel(
        config.command,
        config.passAsStdin,
        config.env,
      );
    }

    case NotificationChannelKind.Webhook: {
      if (!config.enabled) return null;
      if (!config.url || config.url.trim().length === 0) return null;
      return new WebhookChannel(config.url, config.headers, config.timeoutMs);
    }

    case NotificationChannelKind.File: {
      if (!config.enabled) return null;
      if (!config.path || config.path.trim().length === 0) return null;
      return new FileChannel(config.path);
    }

    case NotificationChannelKind.Log: {
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
