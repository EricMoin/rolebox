import { graphNotificationText, type GraphNotification } from "../graph/application/graph-notifications.ts";
import type { ISessionClient } from "./ports/session-client.ts";

export function createGraphNotificationSender(
  client: Pick<ISessionClient, "prompt">,
  canDeliver: (sessionId: string) => boolean = () => true,
): (notification: GraphNotification) => Promise<boolean> {
  return async notification => {
    if (!canDeliver(notification.sessionId)) return false;
    const result = await client.prompt(notification.sessionId, {
      ...(notification.agent === undefined ? {} : { agent: notification.agent }),
      parts: [{ type: "text", text: graphNotificationText(notification) }],
      noReply: false,
    });
    return result !== null;
  };
}
