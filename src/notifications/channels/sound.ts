import { NOTIFICATION_CHANNEL_KINDS } from "../types.ts";
import type { NotificationMessage, PlatformInfo } from "../types.ts";
import type { NotificationChannel } from "../channels.ts";
import { escapePowerShellSingleQuotedText } from "../formatting.ts";
import { createSubLogger } from "../../logger.ts";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const logger = createSubLogger("notification");

export class SoundChannel implements NotificationChannel {
  readonly kind = NOTIFICATION_CHANNEL_KINDS.Sound;
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
          "-NoProfile", "-NonInteractive", "-Command", script,
        ]);
      }
    } catch (err) {
      logger.warn("failed to play notification sound", { err });
    }
  }

  async dispose(): Promise<void> {}
}
