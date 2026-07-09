import { NOTIFICATION_CHANNEL_KINDS } from "../types.ts";
import type { NotificationMessage } from "../types.ts";
import type { NotificationChannel } from "../channels.ts";
import { createSubLogger } from "../../logger.ts";

export class LogChannel implements NotificationChannel {
  readonly kind = NOTIFICATION_CHANNEL_KINDS.Log;
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
