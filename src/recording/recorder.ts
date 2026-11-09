import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CanonicalToolContext, ToolResult } from "../platform/types.ts";
import { recordingReplay } from "./replay.ts";
import { FfmpegVideoEncoder, type VideoEncoder, type VideoFrame } from "./video.ts";

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_STEPS = 5_000;
const MAX_RECORDINGS = 32;

export type RecordingFamily = "browse" | "computer";
export type FrameCapture = (path: string, signal: AbortSignal) => Promise<{ width: number; height: number }>;

export interface RecordingStep {
  seq: number;
  tool: string;
  start_ms: number;
  end_ms: number;
  success: boolean | null;
  arguments: Record<string, unknown>;
}

export interface RecordingSummary {
  id: string;
  state: "starting" | "recording" | "stopping" | "stopped" | "failed";
  started_at: string;
  duration_ms: number;
  fps: number;
  frame_count: number;
  step_count: number;
  directory: string;
  timeline_path: string;
  replay_path: string;
  video_path?: string;
  reason?: string;
}

interface Recording {
  summary: RecordingSummary;
  worktree: string;
  origin: number;
  capture: FrameCapture;
  controller: AbortController;
  frames: VideoFrame[];
  width: number;
  height: number;
  bytes: number;
  steps: RecordingStep[];
  pending: Set<RecordingStep>;
  sequence: number;
  timer?: ReturnType<typeof setTimeout>;
  deadline?: ReturnType<typeof setTimeout>;
  capturing?: Promise<void>;
  ready?: Promise<void>;
  finishing?: Promise<RecordingSummary>;
}

export interface RecordingOperation {
  recording: Recording;
  step: RecordingStep;
}

/** One recorder per family; ownership is the worktree plus host session, never a caller-supplied ID. */
export class OperationRecorder {
  private readonly records = new Map<string, Recording>();

  constructor(
    readonly family: RecordingFamily,
    private readonly encoder: VideoEncoder = new FfmpegVideoEncoder(),
    private readonly now: () => number = () => performance.now(),
  ) {}

  private key(context: CanonicalToolContext): string {
    return JSON.stringify([resolve(context.worktree), context.sessionID.trim() || "default"]);
  }

  status(context: CanonicalToolContext): RecordingSummary | { state: "idle" } {
    const record = this.records.get(this.key(context));
    return record === undefined ? { state: "idle" } : this.summary(record);
  }

  async start(context: CanonicalToolContext, options: { fps: number; maxDurationMs: number; capture: FrameCapture }): Promise<RecordingSummary> {
    const key = this.key(context);
    const previous = this.records.get(key);
    if (previous !== undefined && !["stopped", "failed"].includes(previous.summary.state)) {
      throw new Error("A recording is already active in this session. Stop it before starting another.");
    }
    const active = [...this.records.values()].filter(record => !["stopped", "failed"].includes(record.summary.state));
    if (active.length >= 4) throw new Error("Four recordings are already active. Stop one before starting another.");
    for (const [oldKey, record] of this.records) {
      if (this.records.size < MAX_RECORDINGS) break;
      if (["stopped", "failed"].includes(record.summary.state)) this.records.delete(oldKey);
    }
    const id = randomUUID();
    const directory = join(resolve(context.worktree), ".rolebox", this.family, "recordings", id);
    const record: Recording = {
      summary: {
        id, state: "starting", started_at: new Date().toISOString(), duration_ms: 0, fps: options.fps,
        frame_count: 0, step_count: 0, directory,
        timeline_path: join(directory, "timeline.jsonl"), replay_path: join(directory, "replay.html"),
      },
      worktree: context.worktree, origin: this.now(), capture: options.capture, controller: new AbortController(),
      frames: [], width: 0, height: 0, bytes: 0, steps: [], pending: new Set(), sequence: 0,
    };
    this.records.set(key, record);
    record.ready = (async () => {
      await this.encoder.check(context.abort);
      if (context.abort.aborted) throw new Error("Recording start cancelled.");
      privateDirectory(record.worktree, directory);
      writeFileSync(record.summary.timeline_path, "", { mode: 0o600, flag: "wx" });
      const onAbort = () => record.controller.abort();
      context.abort.addEventListener("abort", onAbort, { once: true });
      if (context.abort.aborted) onAbort();
      try { await this.frame(record); }
      finally { context.abort.removeEventListener("abort", onAbort); }
      if (context.abort.aborted) throw new Error("Recording start cancelled.");
      record.origin = this.now();
      record.summary.started_at = new Date().toISOString();
      record.frames[0]!.at_ms = 0;
      record.summary.state = "recording";
      this.persist(record);
      this.schedule(record);
      record.deadline = setTimeout(() => { void this.finish(record, "duration_limit"); }, options.maxDurationMs);
      record.deadline.unref();
    })();
    try { await record.ready; }
    catch (error) {
      record.controller.abort();
      record.summary.state = "failed";
      record.summary.reason = "start_failed";
      throw error;
    }
    return this.summary(record);
  }

  async stop(context: CanonicalToolContext): Promise<RecordingSummary> {
    const record = this.records.get(this.key(context));
    if (record === undefined) throw new Error("No recording exists in this session. Start one first.");
    await record.ready?.catch(() => undefined);
    return this.finish(record, "requested", context.abort);
  }

  begin(context: CanonicalToolContext, tool: string, args: Record<string, unknown>): RecordingOperation | undefined {
    const record = this.records.get(this.key(context));
    if (record?.summary.state !== "recording" || args.dry_run === true) return undefined;
    if (record.sequence >= MAX_STEPS) { void this.finish(record, "step_limit"); return undefined; }
    const step: RecordingStep = {
      seq: ++record.sequence, tool, start_ms: this.elapsed(record), end_ms: 0, success: null,
      arguments: safeArguments(args),
    };
    record.pending.add(step);
    return { recording: record, step };
  }

  complete(operation: RecordingOperation | undefined, result: ToolResult): void {
    if (operation === undefined) return;
    const { recording: record, step } = operation;
    if (!record.pending.delete(step) || record.summary.state !== "recording") return;
    step.end_ms = this.elapsed(record);
    step.success = typeof result === "string" ? !result.startsWith("Error:")
      : result.metadata?.error !== true && !result.output.startsWith("Error:");
    this.appendStep(record, step);
  }

  private appendStep(record: Recording, step: RecordingStep): void {
    record.steps.push(step);
    record.summary.step_count = record.steps.length;
    try {
      privateDirectory(record.worktree, record.summary.directory);
      assertRegularFile(record.summary.timeline_path);
      appendFileSync(record.summary.timeline_path, `${JSON.stringify(step)}\n`);
    } catch {
      void this.finish(record, "timeline_write_failed");
    }
  }

  private elapsed(record: Recording): number { return Math.max(0, Math.round(this.now() - record.origin)); }

  private summary(record: Recording): RecordingSummary {
    return { ...record.summary, ...(record.summary.state === "recording" ? { duration_ms: this.elapsed(record) } : {}) };
  }

  private persist(record: Recording): void {
    privateDirectory(record.worktree, record.summary.directory);
    const path = join(record.summary.directory, "manifest.json");
    assertRegularFile(path);
    writeFileSync(path, `${JSON.stringify(this.summary(record), null, 2)}\n`, { mode: 0o600 });
  }

  private async frame(record: Recording, signal: AbortSignal = record.controller.signal): Promise<void> {
    privateDirectory(record.worktree, record.summary.directory);
    const file = `frame-${String(record.frames.length).padStart(6, "0")}.png`;
    const path = join(record.summary.directory, file);
    let size: { width: number; height: number };
    try { size = await record.capture(path, signal); }
    catch (error) { rmSync(path, { force: true }); throw error; }
    if (signal.aborted) { rmSync(path, { force: true }); throw new Error("Capture cancelled."); }
    assertRegularFile(path);
    const bytes = statSync(path).size;
    if (bytes > 32 * 1024 * 1024 || record.bytes + bytes > MAX_BYTES) {
      rmSync(path, { force: true });
      throw new Error("frame_limit");
    }
    if (!(Number.isFinite(size.width) && size.width > 0 && Number.isFinite(size.height) && size.height > 0)) throw new Error("invalid_frame");
    chmodSync(path, 0o600);
    record.bytes += bytes;
    record.width ||= size.width;
    record.height ||= size.height;
    record.frames.push({ file, at_ms: this.elapsed(record) });
    record.summary.frame_count = record.frames.length;
  }

  private schedule(record: Recording): void {
    record.timer = setTimeout(() => {
      if (record.summary.state !== "recording") return;
      record.capturing = this.frame(record);
      void record.capturing.then(() => {
        if (record.summary.state === "recording") this.schedule(record);
      }, error => {
        if (record.summary.state === "recording") {
          void this.finish(record, error instanceof Error && error.message === "frame_limit" ? "frame_limit" : "capture_failed");
        }
      });
    }, 1000 / record.summary.fps);
    record.timer.unref();
  }

  private finish(record: Recording, reason: string, signal: AbortSignal = new AbortController().signal): Promise<RecordingSummary> {
    if (record.finishing !== undefined) return record.finishing;
    if (["stopped", "failed"].includes(record.summary.state)) return Promise.resolve(this.summary(record));
    record.summary.state = "stopping";
    record.summary.duration_ms = this.elapsed(record);
    record.summary.reason = reason;
    clearTimeout(record.timer);
    clearTimeout(record.deadline);
    record.controller.abort();
    record.finishing = (async () => {
      await record.capturing?.catch(() => undefined);
      if ((reason === "requested" || reason === "duration_limit") && !signal.aborted) {
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        signal.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(onAbort, 10_000);
        try { await this.frame(record, controller.signal); }
        catch { record.summary.reason = "final_capture_failed"; }
        finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); }
      }
      record.summary.duration_ms = this.elapsed(record);
      for (const step of record.pending) {
        step.end_ms = record.summary.duration_ms;
        this.appendStep(record, step);
      }
      record.pending.clear();
      try {
        privateDirectory(record.worktree, record.summary.directory);
        await this.encoder.encode({
          directory: record.summary.directory, frames: record.frames, duration_ms: record.summary.duration_ms,
          width: record.width, height: record.height, signal,
        });
        record.summary.video_path = join(record.summary.directory, "recording.mp4");
        record.summary.state = "stopped";
      } catch {
        record.summary.state = "failed";
        record.summary.reason = "encoding_failed";
      }
      try {
        privateDirectory(record.worktree, record.summary.directory);
        writeFileSync(record.summary.replay_path, recordingReplay([...record.steps].sort((a, b) => a.seq - b.seq), record.summary.video_path !== undefined), { mode: 0o600, flag: "wx" });
        this.persist(record);
        if (record.summary.video_path !== undefined) {
          for (const frame of record.frames) rmSync(join(record.summary.directory, frame.file), { force: true });
          rmSync(join(record.summary.directory, "frames.ffconcat"), { force: true });
        }
      } catch {
        record.summary.state = "failed";
        record.summary.reason = "artifact_write_failed";
      }
      return this.summary(record);
    })();
    return record.finishing;
  }
}

function safeArguments(args: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of ["x", "y", "from_x", "from_y", "to_x", "to_y", "window_id", "display", "clicks", "amount", "delta_x", "delta_y", "duration_ms"]) {
    if (typeof args[key] === "number" && Number.isFinite(args[key])) safe[key] = args[key];
  }
  for (const key of ["direction", "button", "action"]) {
    if (typeof args[key] === "string" && /^(up|down|left|right|middle|back|forward|reload|new|select|list|close|accept|dismiss|get|set|clear)$/.test(args[key])) safe[key] = args[key];
  }
  if (typeof args.text === "string") safe.text_length = args.text.length;
  if (Array.isArray(args.keys)) safe.key_count = args.keys.length;
  if (typeof args.target === "string") {
    if (/^@?e\d{1,16}$/.test(args.target)) safe.target = args.target;
    else safe.target_kind = /^(css|text|role|label|placeholder|alt|title|testid)=/.exec(args.target)?.[1] ?? "other";
  }
  return safe;
}

function assertRegularFile(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Recording destination must be a private regular file.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function privateDirectory(worktree: string, directory: string): void {
  const root = resolve(worktree);
  let current = realpathSync(root);
  const parts = directory.slice(root.length + 1).split(/[\\/]/);
  if (parts.length !== 4 || parts[0] !== ".rolebox" || !["browse", "computer"].includes(parts[1]!) || parts[2] !== "recordings" || !/^[a-f0-9-]+$/.test(parts[3]!)) {
    throw new Error("Invalid recording directory.");
  }
  for (const part of parts) {
    current = join(current, part);
    try { mkdirSync(current, { mode: 0o700 }); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) throw new Error("Recording directories cannot contain symbolic links.");
  }
}
