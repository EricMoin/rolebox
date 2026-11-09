import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { OperationRecorder } from "../../src/recording/recorder.ts";
import { fakeEncoder } from "../recording/helpers.ts";
import { createBrowseHarness, type BrowseHarness } from "./helpers/fake-driver.ts";

const harnesses: Array<{ h: BrowseHarness; recorder: OperationRecorder }> = [];
function harness() {
  const encoder = fakeEncoder();
  const recorder = new OperationRecorder("browse", encoder);
  const h = createBrowseHarness({ recorder });
  harnesses.push({ h, recorder });
  return { h, recorder, encoder };
}
afterEach(async () => {
  for (const { h, recorder } of harnesses.splice(0)) {
    if (recorder.status(h.context()).state !== "idle") await recorder.stop(h.context());
    await h.cleanup();
  }
  vi.useRealTimers();
});

describe("browse_record", () => {
  it("status does not launch a browser and start requires an existing page", async () => {
    const { h, encoder } = harness();
    expect((await h.call("browse_record", { action: "status" })).metadata).toMatchObject({ state: "idle", action: "browse_record", driver: "playwright" });
    expect((await h.call("browse_record", { action: "start" })).output).toContain("browse_open");
    expect(h.factory.launchCount).toBe(0);
    expect(encoder.check).not.toHaveBeenCalled();
  });

  it("records subsequent tools into the MP4's timeline without logging the sampler", async () => {
    const { h } = harness();
    await h.call("browse_open");
    const start = await h.call("browse_record", { action: "start" });
    expect(start.metadata?.state).toBe("recording");
    await h.call("browse_type", { target: "css=#field", text: "private-input" });
    const stopped = await h.call("browse_record", { action: "stop" });
    expect(stopped.metadata).toMatchObject({ state: "stopped", frame_count: 2, step_count: 1 });
    const timeline = readFileSync(stopped.metadata!.timeline_path as string, "utf8");
    expect(JSON.parse(timeline)).toMatchObject({ tool: "browse_type", success: true, arguments: { text_length: 13 } });
    expect(timeline).not.toContain("private-input");
  });

  it("stops when its page closes without reopening the session", async () => {
    vi.useFakeTimers();
    const { h } = harness();
    await h.call("browse_open");
    await h.call("browse_record", { action: "start" });
    await h.call("browse_close");
    await vi.advanceTimersByTimeAsync(501);
    const result = await h.call("browse_record", { action: "status" });
    expect(result.metadata).toMatchObject({ state: "stopped", reason: "capture_failed" });
    expect(h.manager.sessionCount).toBe(0);
    expect(h.factory.launchCount).toBe(1);
  });

  it("cancels a recording sample queued behind a long operation without waiting for that operation", async () => {
    const { h } = harness();
    await h.call("browse_open");
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = h.manager.run("session-tools", async () => { started.resolve(); await release.promise; });
    await started.promise;
    try {
      const controller = new AbortController();
      const capture = h.manager.recordingFrame("session-tools", "main", controller.signal);
      controller.abort();
      await expect(capture).rejects.toMatchObject({ code: "cancelled" });
    } finally {
      release.resolve();
      await blocker;
    }
    await h.manager.info("session-tools");
    expect(h.page().calls).not.toContain("screenshot");
  });
});
