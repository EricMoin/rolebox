import type { ExtensionPoint } from "../extension-point.ts";
import type { ExtensionEntry, NotificationChannelEntry, NotificationChannelModule } from "../types.ts";
import { loadExtensionModule } from "../loader.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("ext:point:notification-channels");

export class NotificationChannelExtensionPoint implements ExtensionPoint {
  readonly name = "notification_channels";

  async load(entries: ExtensionEntry[], roleDir: string): Promise<void> {
    const { registerChannelFactory } = await import("../../notifications/channels.ts");

    const channelEntries = entries as unknown as NotificationChannelEntry[];
    for (const entry of channelEntries) {
      const mod = await loadExtensionModule(entry.module, roleDir);
      if (!mod) continue;

      const channelMod = mod as Partial<NotificationChannelModule>;
      if (typeof channelMod.create === "function") {
        registerChannelFactory(entry.kind, async (config) => {
          const channel = channelMod.create!(config);
          return {
            kind: entry.kind,
            send: channel.send,
            dispose: channel.dispose,
          };
        });
        log.debug("Registered custom notification channel", { kind: entry.kind });
      } else {
        log.warn("Notification channel module missing create function", { kind: entry.kind, module: entry.module });
      }
    }
  }
}
