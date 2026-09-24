import { expect, it } from "bun:test";
import { createGraphNotificationSender } from "../../src/platform/graph-notifications.ts";
import type { GraphNotification } from "../../src/graph/application/graph-notifications.ts";

const notification: GraphNotification = { id: "notice-1", graphId: "flow", runId: "run-1", sessionId: "parent",
  agent: "orchestrator", kind: "complete", reason: "Complete" };

it("wakes the declaring session with a graph status reference, treating a missing delivery as retryable", async () => {
  const calls: unknown[] = [];
  const send = createGraphNotificationSender({ async prompt(...args) { calls.push(args); return null; } });
  expect(await send(notification)).toBe(false);
  expect(calls[0]).toMatchObject(["parent", { agent: "orchestrator", noReply: false }]);
  expect(JSON.stringify(calls[0])).toContain("[GRAPH COMPLETE]");
  expect(JSON.stringify(calls[0])).toContain("graph_status");
});

it("does not redirect a recovered graph's notification to a different active Pi session", async () => {
  let sends = 0;
  let active = "other";
  const send = createGraphNotificationSender({ async prompt() { sends++; return { id: "sent" }; } }, id => id === active);
  expect(await send(notification)).toBe(false); expect(sends).toBe(0);
  active = "parent";
  expect(await send(notification)).toBe(true); expect(sends).toBe(1);
});
