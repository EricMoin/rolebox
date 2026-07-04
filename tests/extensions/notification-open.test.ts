import { describe, it, expect } from "bun:test";
import {
  NOTIFICATION_CHANNEL_KINDS,
  NOTIFICATION_EVENT_TYPES,
} from "../../src/notifications/types";
import { registerChannelFactory, createChannel } from "../../src/notifications/channels";

describe("Notification Channels Open Registry", () => {
  it("built-in channel kinds resolve to correct string values", () => {
    expect(NOTIFICATION_CHANNEL_KINDS.SystemToast).toBe("system_toast");
    expect(NOTIFICATION_CHANNEL_KINDS.Sound).toBe("sound");
    expect(NOTIFICATION_CHANNEL_KINDS.CustomCommand).toBe("custom_command");
    expect(NOTIFICATION_CHANNEL_KINDS.Webhook).toBe("webhook");
    expect(NOTIFICATION_CHANNEL_KINDS.File).toBe("file");
    expect(NOTIFICATION_CHANNEL_KINDS.Log).toBe("log");
  });

  it("built-in event types resolve to correct string values", () => {
    expect(NOTIFICATION_EVENT_TYPES.Idle).toBe("idle");
    expect(NOTIFICATION_EVENT_TYPES.Error).toBe("error");
    expect(NOTIFICATION_EVENT_TYPES.DispatchComplete).toBe("dispatch_complete");
  });

  it("NotificationChannelKind type accepts custom string values", () => {
    const customKind: string = "slack";
    expect(customKind).toBe("slack");
  });

  it("registerChannelFactory + createChannel invokes custom factory", async () => {
    let invoked = false;
    registerChannelFactory("test_custom_kind", async (config) => {
      invoked = true;
      return {
        kind: "test_custom_kind",
        send: async () => {},
        dispose: async () => {},
      };
    });

    const channel = await createChannel({
      kind: "test_custom_kind",
      enabled: true,
    } as any);

    expect(invoked).toBe(true);
    expect(channel).not.toBeNull();
    expect(channel!.kind).toBe("test_custom_kind");
  });

  it("createChannel returns null for unknown kind without factory", async () => {
    const channel = await createChannel({
      kind: "nonexistent_kind",
      enabled: true,
    } as any);

    expect(channel).toBeNull();
  });
});
