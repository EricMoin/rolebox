import { writeFileSync } from "node:fs";
import { readPngSize } from "../computer/png.ts";
import { createRecordingTool } from "../recording/tools.ts";
import type { OperationRecorder } from "../recording/recorder.ts";
import { BROWSE_PAGE_ARG, browseSessionKey, type BrowseRuntime } from "./tool-helpers.ts";
import { browseMetadata } from "./results.ts";

export function createBrowseRecordTool(runtime: BrowseRuntime, recorder: OperationRecorder) {
  return createRecordingTool({
    recorder,
    targetArgs: { page: BROWSE_PAGE_ARG },
    targetDescription: "Records one already-open named page; page defaults to the active page at start and stays fixed. Call browse_open first.",
    metadata: context => browseMetadata({ action: "browse_record", session: browseSessionKey(context) }),
    async capture(args, context) {
      const manager = runtime.manager(context.worktree);
      const session = browseSessionKey(context);
      const info = await manager.info(session, context.abort);
      const page = args.page ?? info.active;
      if (page === null || !info.pages.some(candidate => candidate.name === page)) {
        throw new Error("No open recording page. Call browse_open, then browse_record action=start with an existing page.");
      }
      return async (path, signal) => {
        const screenshot = await manager.recordingFrame(session, page, signal);
        if (screenshot.bytes.byteLength > 32 * 1024 * 1024) throw new Error("Recording frame exceeds 32 MiB. Use a smaller browser viewport.");
        const size = readPngSize(screenshot.bytes);
        if (size === null) throw new Error("Recording frame is not a valid PNG.");
        writeFileSync(path, screenshot.bytes, { mode: 0o600, flag: "wx" });
        return size;
      };
    },
  });
}
