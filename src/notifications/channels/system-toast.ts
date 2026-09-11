import { NOTIFICATION_CHANNEL_KINDS } from "../types.ts";
import type { NotificationMessage, PlatformInfo } from "../types.ts";
import type { NotificationChannel } from "../channels.ts";
import { detectPlatform, resolveToastSender, commandExists } from "../platform.ts";
import {
  buildAppleScriptNotification,
  buildWindowsToastScript,
  buildNotifySendCommand,
  truncate,
} from "../formatting.ts";
import { createSubLogger } from "../../logger.ts";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const logger = createSubLogger("notification");

export class SystemToastChannel implements NotificationChannel {
  readonly kind = NOTIFICATION_CHANNEL_KINDS.SystemToast;
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
      if (
        this.primary === "terminal-notifier" ||
        this.fallback === "terminal-notifier"
      ) {
        try {
          await execFileAsync("terminal-notifier", ["-title", title, "-message", body]);
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
        await execFileAsync("notify-send", buildNotifySendCommand(title, body));
        return;
      } catch {}
    } else if (this.platform.os === "win32") {
      try {
        const script = buildWindowsToastScript(title, body);
        await execFileAsync("powershell", [
          "-NoProfile", "-NonInteractive", "-Command", script,
        ]);
        return;
      } catch {}
    }

    logger.warn("all system toast attempts failed", { platform: this.platform.os });
  }

  async dispose(): Promise<void> {}
}
