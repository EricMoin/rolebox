import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationRecorder } from "../../src/recording/recorder.ts";
import { recordingReplay } from "../../src/recording/replay.ts";
import { fakeEncoder, recordingContext, recordingPng } from "./helpers.ts";

const directories: string[] = [];
const recordings: Array<{ recorder: OperationRecorder; context: ReturnType<typeof recordingContext> }> = [];

function harness() {
  const worktree = mkdtempSync(join(tmpdir(), "rolebox-recording-"));
  directories.push(worktree);
  const encoder = fakeEncoder();
  const context = recordingContext(worktree);
  const recorder = new OperationRecorder("browse", encoder, () => Date.now());
  recordings.push({ recorder, context });
  const capture = vi.fn(async (path: string) => {
    writeFileSync(path, recordingPng(), { mode: 0o600, flag: "wx" });
    return { width: 16, height: 16 };
  });
  return { recorder, encoder, context, capture, start: () => recorder.start(context, { fps: 2, maxDurationMs: 120_000, capture }) };
}

afterEach(async () => {
  while (recordings.length > 0) {
    const { recorder, context } = recordings.pop()!;
    if (recorder.status(context).state !== "idle") await recorder.stop(context);
  }
  vi.useRealTimers();
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("operation recording lifecycle", () => {
  it("produces a private video, timeline and seekable replay; stop is idempotent", async () => {
    const h = harness();
    expect(h.recorder.status(h.context)).toEqual({ state: "idle" });
    const started = await h.start();
    const operation = h.recorder.begin(h.context, "browse_type", { text: "private-value", target: "css=[data-secret=private-value]", url: "https://example.com/private-value" });
    h.recorder.complete(operation, { output: "private-value", metadata: { cookies: "private-value" } });
    const stopped = await h.recorder.stop(h.context);
    expect(stopped).toMatchObject({ state: "stopped", id: started.id, frame_count: 2, step_count: 1, reason: "requested" });
    const step = JSON.parse(readFileSync(stopped.timeline_path, "utf8"));
    expect(step).toMatchObject({ tool: "browse_type", success: true, arguments: { text_length: 13, target_kind: "css" } });
    const replay = readFileSync(stopped.replay_path, "utf8");
    expect(replay).toContain("recording.mp4");
    expect(replay).toContain("currentTime");
    expect(replay).not.toContain("private-value");
    expect(existsSync(join(stopped.directory, "frame-000000.png"))).toBe(false);
    if (process.platform !== "win32") {
      expect(statSync(stopped.directory).mode & 0o777).toBe(0o700);
      expect(statSync(stopped.timeline_path).mode & 0o777).toBe(0o600);
    }
    expect(await h.recorder.stop(h.context)).toEqual(stopped);
    expect(h.encoder.encode).toHaveBeenCalledOnce();
  });

  it("samples without overlapping captures and automatically finalizes at its deadline", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.recorder.start(h.context, { fps: 2, maxDurationMs: 1_000, capture: h.capture });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(h.recorder.status(h.context)).toMatchObject({ state: "stopped", reason: "duration_limit", frame_count: 3, duration_ms: 1_000 });
    expect(h.capture).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.capture).toHaveBeenCalledTimes(3);
  });

  it("finalizes existing frames when the next capture fails", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.start();
    h.capture.mockRejectedValueOnce(new Error("target closed"));
    await vi.advanceTimersByTimeAsync(501);
    expect(h.recorder.status(h.context)).toMatchObject({ state: "stopped", reason: "capture_failed", frame_count: 1 });
  });

  it("enforces the raw-frame byte budget before retaining another frame", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.capture.mockImplementation(async path => {
      writeFileSync(path, recordingPng());
      truncateSync(path, 32 * 1024 * 1024);
      return { width: 16, height: 16 };
    });
    await h.recorder.start(h.context, { fps: 5, maxDurationMs: 120_000, capture: h.capture });
    await vi.advanceTimersByTimeAsync(1_601);
    expect(h.recorder.status(h.context)).toMatchObject({ state: "stopped", reason: "frame_limit", frame_count: 8 });
    expect(h.encoder.encode).toHaveBeenCalledOnce();
  });

  it("retains raw frames on encoding failure and records interrupted operations", async () => {
    const h = harness();
    await h.start();
    h.recorder.begin(h.context, "browse_click", { target: "e1" });
    h.encoder.encode.mockRejectedValueOnce(new Error("fixture encoder failure"));
    const stopped = await h.recorder.stop(h.context);
    expect(stopped).toMatchObject({ state: "failed", reason: "encoding_failed", step_count: 1 });
    expect(stopped.video_path).toBeUndefined();
    expect(existsSync(join(stopped.directory, "frame-000000.png"))).toBe(true);
    expect(JSON.parse(readFileSync(stopped.timeline_path, "utf8"))).toMatchObject({ success: null, arguments: { target: "e1" } });
  });

  it("isolates sessions and worktrees and refuses duplicate starts", async () => {
    const h = harness();
    await h.start();
    await expect(h.start()).rejects.toThrow("already active");
    expect(h.recorder.status({ ...h.context, sessionID: "another-session" })).toEqual({ state: "idle" });
    expect(h.recorder.status({ ...h.context, worktree: join(h.context.worktree, "another-worktree") })).toEqual({ state: "idle" });
    await expect(h.recorder.stop({ ...h.context, sessionID: "another-session" })).rejects.toThrow("No recording");
    expect(h.recorder.begin(h.context, "browse_click", { dry_run: true })).toBeUndefined();
  });

  it("reports missing ffmpeg before capturing and allows a later retry", async () => {
    const h = harness();
    h.encoder.check.mockRejectedValueOnce(new Error("ffmpeg unavailable"));
    await expect(h.start()).rejects.toThrow("ffmpeg unavailable");
    expect(h.capture).not.toHaveBeenCalled();
    await h.start();
    expect(h.capture).toHaveBeenCalledOnce();
  });

  it("stops an in-flight sampler on stop and waits for it before encoding", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.start();
    let aborted = false;
    h.capture.mockImplementationOnce(async (_path: string, signal?: AbortSignal) => new Promise((_, reject) => {
      signal!.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }, { once: true });
    }));
    await vi.advanceTimersByTimeAsync(500);
    const stopped = await h.recorder.stop(h.context);
    expect(aborted).toBe(true);
    expect(stopped.state).toBe("stopped");
    expect(h.encoder.encode).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform === "win32")("refuses symbolic-link output directories", async () => {
    const h = harness();
    const other = mkdtempSync(join(tmpdir(), "rolebox-recording-other-"));
    directories.push(other);
    symlinkSync(other, join(h.context.worktree, ".rolebox"));
    await expect(h.start()).rejects.toThrow("symbolic links");
    expect(h.capture).not.toHaveBeenCalled();
  });

  it("escapes embedded timeline data in the replay", () => {
    const page = recordingReplay([{ seq: 1, tool: "</script><script>alert(1)</script>", start_ms: 0, end_ms: 1, success: true, arguments: {} }], true);
    expect(page).not.toContain("</script><script>alert(1)");
    expect(page).toContain("\\u003c/script>");
  });
});
