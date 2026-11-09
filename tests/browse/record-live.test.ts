import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { BrowseSessionManager } from "../../src/browse/session.ts";
import { createBrowseTools } from "../../src/browse/tools.ts";
import type { ToolResult } from "../../src/platform/types.ts";
import { OperationRecorder } from "../../src/recording/recorder.ts";
import { recordingContext } from "../recording/helpers.ts";

const live = process.env.ROLEBOX_BROWSE_LIVE === "1";
const hasFfmpeg = live && spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

function ok(result: ToolResult): Exclude<ToolResult, string> {
  if (typeof result === "string") throw new Error(result);
  expect(result.metadata?.error, result.output).not.toBe(true);
  return result;
}

describe.skipIf(!live || !hasFfmpeg)("browse_record live video", () => {
  it("records an existing page, includes the final action and plays its local timeline", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "rolebox-record-live-"));
    const context = recordingContext(worktree);
    const recorder = new OperationRecorder("browse");
    const manager = new BrowseSessionManager({ worktree });
    const tools = createBrowseTools({ manager, recorder });
    try {
      const html = '<body style="background:#203040"><input type="password"><button onclick="document.body.style.background=\'#ff4040\'">Save</button></body>';
      ok(await tools.browse_open!.execute({ url: `data:text/html,${encodeURIComponent(html)}` }, context));
      ok(await tools.browse_record!.execute({ action: "start", fps: 1 }, context));
      ok(await tools.browse_type!.execute({ target: "css=input", text: "example-value" }, context));
      ok(await tools.browse_click!.execute({ target: "css=button" }, context));
      const stopped = ok(await tools.browse_record!.execute({ action: "stop" }, context));
      expect(stopped.metadata).toMatchObject({ state: "stopped", step_count: 2 });
      const videoPath = stopped.metadata!.video_path as string;
      const timeline = readFileSync(stopped.metadata!.timeline_path as string, "utf8");
      expect(timeline).not.toContain("example-value");
      expect(timeline.trim().split("\n").map(line => JSON.parse(line).tool)).toEqual(["browse_type", "browse_click"]);

      const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", videoPath, "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { maxBuffer: 1024 * 1024 });
      expect(decoded.status, decoded.stderr.toString()).toBe(0);
      const last = decoded.stdout.subarray(-3);
      expect(last[0]! - last[1]!).toBeGreaterThan(80);

      ok(await tools.browse_open!.execute({ url: pathToFileURL(stopped.metadata!.replay_path as string).href }, context));
      const playback = ok(await tools.browse_eval!.execute({ expression: `new Promise((resolve, reject) => {
        const video = document.querySelector('video');
        const ready = () => resolve({ duration: video.duration, steps: document.querySelectorAll('nav button').length });
        if (video.readyState >= 1) ready();
        else { video.addEventListener('loadedmetadata', ready); video.addEventListener('error', () => reject(new Error('video unavailable'))); }
      })` }, context));
      expect(JSON.parse(playback.output)).toMatchObject({ steps: 2 });
      expect(JSON.parse(playback.output).duration).toBeGreaterThan(0);
    } finally {
      if (recorder.status(context).state !== "idle") await recorder.stop(context);
      await manager.dispose();
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});
