import { NOTIFICATION_CHANNEL_KINDS } from "../types.ts";
import type { NotificationMessage } from "../types.ts";
import type { NotificationChannel } from "../channels.ts";
import { createSubLogger } from "../../logger.ts";

const logger = createSubLogger("notification");

export class WebhookChannel implements NotificationChannel {
  readonly kind = NOTIFICATION_CHANNEL_KINDS.Webhook;
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
        logger.warn("webhook returned non-ok status", { status: response.status, url: this.url });
      }
    } catch (err) {
      logger.warn("webhook request failed", { err, url: this.url });
    } finally {
      clearTimeout(timer);
    }
  }

  async dispose(): Promise<void> {}
}
