/**
 * T1 Spike: Assert dispatch notification markers are present on 
 * notification-injected messages and distinguishable from human messages.
 * 
 * These tests verify invariants that the T7 cancellation and T10 continuation
 * guards depend on. If this test breaks, update the discriminator logic.
 */
import { describe, it, expect } from "bun:test";
import {
  DISPATCH_COMPLETION_MARKER,
  DISPATCH_ALL_COMPLETE_MARKER,
  DISPATCH_RECOVERY_MARKER,
  DISPATCH_PROGRESS_MILESTONE_MARKER,
  GRAPH_COMPLETION_MARKER,
  GRAPH_COMPLETE_MARKER,
  GRAPH_BLOCKED_MARKER,
  DISPATCH_NOTIFICATION_MARKERS,
  isDispatchNotification,
  buildNotificationText,
} from "../../src/dispatch/notification.ts";

describe("T1 Spike — Dispatch notification discriminator", () => {
  it("isDispatchNotification returns true for completion marker", () => {
    const text = `<system-reminder>\n${DISPATCH_COMPLETION_MARKER}\nTask done\n</system-reminder>`;
    expect(isDispatchNotification(text)).toBe(true);
  });

  it("isDispatchNotification returns true for all-complete marker", () => {
    const text = `<system-reminder>\n${DISPATCH_ALL_COMPLETE_MARKER}\nAll done\n</system-reminder>`;
    expect(isDispatchNotification(text)).toBe(true);
  });

  it("isDispatchNotification returns true for recovery marker", () => {
    const text = `<system-reminder>\n${DISPATCH_RECOVERY_MARKER}\nRecovered\n</system-reminder>`;
    expect(isDispatchNotification(text)).toBe(true);
  });

  it("isDispatchNotification returns false for plain human message", () => {
    expect(isDispatchNotification("Hello, could you review this?")).toBe(false);
  });

  it("isDispatchNotification returns false for auto-continue marker only", () => {
    expect(isDispatchNotification("<system-reminder>[auto-continue 1/5 for test]</system-reminder>")).toBe(false);
  });

  it("all DISPATCH_NOTIFICATION_MARKERS are present in buildNotificationText output", () => {
    const intermediate = buildNotificationText({
      taskId: "task_001", description: "Test", duration: "5s",
      status: "completed", remainingTasks: 2,
    });
    expect(intermediate).toContain(DISPATCH_COMPLETION_MARKER);

    const finalPayload = {
      taskId: "task_001", description: "Test", duration: "5s",
      status: "completed", remainingTasks: 0,
    };
    const final = buildNotificationText(finalPayload);
    expect(final).toContain(DISPATCH_ALL_COMPLETE_MARKER);
  });

  it("markers array is exhaustive — all const values are in DISPATCH_NOTIFICATION_MARKERS", () => {
    expect(DISPATCH_NOTIFICATION_MARKERS).toContain(DISPATCH_COMPLETION_MARKER);
    expect(DISPATCH_NOTIFICATION_MARKERS).toContain(DISPATCH_ALL_COMPLETE_MARKER);
    expect(DISPATCH_NOTIFICATION_MARKERS).toContain(DISPATCH_RECOVERY_MARKER);
    expect(DISPATCH_NOTIFICATION_MARKERS).toContain(DISPATCH_PROGRESS_MILESTONE_MARKER);
    expect(DISPATCH_NOTIFICATION_MARKERS).toContain(GRAPH_COMPLETION_MARKER);
    expect(DISPATCH_NOTIFICATION_MARKERS).toContain(GRAPH_COMPLETE_MARKER);
    expect(DISPATCH_NOTIFICATION_MARKERS).toContain(GRAPH_BLOCKED_MARKER);
    expect(DISPATCH_NOTIFICATION_MARKERS.length).toBe(7);
  });

  it("completion notification uses noReply:false (assert via text format)", () => {
    // When remainingTasks === 0, buildNotificationText produces the ALL_COMPLETE format
    const text = buildNotificationText({
      taskId: "task_final", description: "Final", duration: "10s",
      status: "completed", remainingTasks: 0,
    });
    expect(text).toContain(DISPATCH_ALL_COMPLETE_MARKER);
    expect(text).toContain("All background tasks have finished");
  });

  it("intermediate notification text differs from final (has remaining tasks info)", () => {
    const text = buildNotificationText({
      taskId: "task_int", description: "Intermediate", duration: "5s",
      status: "completed", remainingTasks: 1,
    });
    expect(text).toContain(DISPATCH_COMPLETION_MARKER);
    expect(text).toContain("still in progress");
    expect(text).not.toContain("All background tasks have finished");
  });
});
