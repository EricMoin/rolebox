import { NOTIFICATION_CHANNEL_KINDS } from "../types.ts";
import type { NotificationMessage } from "../types.ts";
import type { NotificationChannel } from "../channels.ts";
import { createSubLogger } from "../../logger.ts";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const logger = createSubLogger("notification");

export class FileChannel implements NotificationChannel {
  readonly kind = NOTIFICATION_CHANNEL_KINDS.File;
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
