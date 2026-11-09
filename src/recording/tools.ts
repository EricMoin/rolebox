import { z } from "zod";
import { defineTool } from "../platform/ports/tool-factory.ts";
import type { CanonicalToolContext, CanonicalToolDef, ToolResult } from "../platform/types.ts";
import type { FrameCapture, OperationRecorder } from "./recorder.ts";

const CONTROL_ARGS = {
  action: z.enum(["start", "status", "stop"]).describe("Start recording, inspect the current recording, or stop and encode the MP4"),
  fps: z.number().int().min(1).max(5).optional().describe("Requested screenshot sampling rate, 1–5 fps (default 2); actual rate also depends on capture time and tool queues. Start only"),
  max_duration_ms: z.number().int().min(1_000).max(600_000).optional().describe("Automatically stop after this duration (default 120000ms, maximum 600000ms). Start only"),
};

export function createRecordingTool<Args extends z.ZodRawShape>(options: {
  recorder: OperationRecorder;
  targetArgs: Args;
  capture(args: z.infer<z.ZodObject<Args>>, context: CanonicalToolContext): Promise<FrameCapture>;
  metadata(context: CanonicalToolContext): Record<string, unknown>;
  targetDescription: string;
}): CanonicalToolDef {
  const args = {
    ...options.targetArgs,
    ...CONTROL_ARGS,
  };
  const schema = z.object(args);
  return defineTool({
    description: `Record this session's ${options.recorder.family} operations as an MP4 video and a synchronized JSONL step timeline. `
      + options.targetDescription + " Uses sampled screenshots (default 2 fps), no audio. Requires ffmpeg with libx264 on PATH. "
      + "Start persists across tool calls and turns until stop, a capture failure, 256 MiB of frames, 5000 steps or the duration limit. "
      + "Stop returns video, timeline and local HTML replay paths under .rolebox/<family>/recordings/. "
      + "Timeline omits input text, URLs, cookies and raw results; visible screen content is retained in the video. Status has no capture side effects.",
    args,
    async execute(input, context) {
      const metadata = options.metadata(context);
      let code = "invalid_arguments";
      try {
        const parsed = schema.safeParse(input);
        if (!parsed.success) throw new Error("Invalid recording arguments. Use action=start|status|stop, fps=1..5 and max_duration_ms=1000..600000.");
        code = context.abort.aborted ? "cancelled" : "protocol_error";
        if (context.abort.aborted) throw new Error("Recording operation cancelled. Retry in an active turn.");
        const values = z.object(CONTROL_ARGS).parse(parsed.data);
        const report = values.action === "status" ? options.recorder.status(context)
          : values.action === "stop" ? await options.recorder.stop(context)
            : await options.recorder.start(context, {
              fps: values.fps ?? 2, maxDurationMs: values.max_duration_ms ?? 120_000,
              capture: await options.capture(z.object(options.targetArgs).parse(parsed.data), context),
            });
        const failed = report.state === "failed";
        return {
          title: `${options.recorder.family} recording ${report.state}`,
          output: `${failed ? "Error: recording could not finish; inspect reason and retained artifacts.\n" : ""}${JSON.stringify(report, null, 2)}`,
          metadata: { ...metadata, ...report, ...(failed ? { error: true, code: "protocol_error" } : {}) },
        };
      } catch (error) {
        return {
          title: `${options.recorder.family} recording failed`,
          output: `Error: ${error instanceof Error ? error.message.replace(/^Error:\s*/, "") : "Recording operation failed."}`,
          metadata: { ...metadata, error: true, code },
        };
      }
    },
  });
}

/** Capture tool outcomes without changing the operation's result or recording internal sampling calls. */
export function withRecording(recorder: OperationRecorder, tools: Record<string, CanonicalToolDef>): Record<string, CanonicalToolDef> {
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, {
    ...tool,
    async execute(args, context) {
      const operation = recorder.begin(context, name, args ?? {});
      try {
        const result = await tool.execute(args, context);
        recorder.complete(operation, result);
        return result;
      } catch (error) {
        recorder.complete(operation, { output: "Error: operation failed", metadata: { error: true } });
        throw error;
      }
    },
  } satisfies CanonicalToolDef]));
}
