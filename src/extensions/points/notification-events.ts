import type { ExtensionPoint } from "../extension-point.ts";
import type { ExtensionEntry } from "../types.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("ext:point:notification-events");

export class NotificationEventExtensionPoint implements ExtensionPoint {
  readonly name = "notification_events";

  async load(entries: ExtensionEntry[], roleDir: string): Promise<void> {
    for (const entry of entries) {
      log.debug("Notification event type registered as open string", { name: entry.name });
    }
  }
}
