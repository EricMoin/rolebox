import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComputerTools } from "../../src/computer/tools.ts";
import { darwinComputerUse } from "../../src/computer/drivers/darwin.ts";
import { computerScreenshots } from "../../src/computer/geometry.ts";
import { setPlatformForTest } from "../../src/platform/system/index.ts";
import type { ComputerPlan } from "../../src/platform/system/types.ts";
import type { ToolResult } from "../../src/platform/types.ts";
import { OperationRecorder } from "../../src/recording/recorder.ts";
import { fakeEncoder, recordingContext, recordingPng } from "../recording/helpers.ts";

const directories: string[] = [];
const active: Array<{ recorder: OperationRecorder; context: ReturnType<typeof recordingContext> }> = [];
function command(script: string): ComputerPlan {
  return { argv: [process.execPath, "-e", script], requires: [process.execPath], windowsVerbatimArguments: false, driver: "fixture" };
}
function structured(result: ToolResult): Exclude<ToolResult, string> {
  if (typeof result === "string") throw new Error("Expected structured tool result");
  return result;
}
function harness() {
  const directory = mkdtempSync(join(tmpdir(), "rolebox-computer-record-"));
  directories.push(directory);
  const context = recordingContext(directory);
  const recorder = new OperationRecorder("computer", fakeEncoder());
  active.push({ recorder, context });
  const tools = createComputerTools({ recorder });
  return { context, tools, recorder };
}
afterEach(async () => {
  for (const { recorder, context } of active.splice(0)) {
    if (recorder.status(context).state !== "idle") await recorder.stop(context);
  }
  vi.restoreAllMocks();
  setPlatformForTest(undefined);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("computer_record with inert native commands", () => {
  it("captures the selected target and logs input without consuming screenshot IDs", async () => {
    setPlatformForTest("darwin");
    const h = harness();
    const remember = vi.spyOn(computerScreenshots, "remember");
    vi.spyOn(darwinComputerUse, "capturePermissionProbe").mockReturnValue(command("process.stdout.write('granted')"));
    const capture = vi.spyOn(darwinComputerUse, "capturePlan").mockImplementation(request => command(`
      require('node:fs').writeFileSync(${JSON.stringify(request.path)}, Buffer.from('${recordingPng().toString("base64")}', 'base64'));
      process.stdout.write(${JSON.stringify(JSON.stringify({ bounds: { x: 0, y: 0, w: 16, h: 16 }, displays: [{ id: 1, name: "fixture", x: 0, y: 0, width: 100, height: 100, scale: 1, primary: true }] }))});
    `));
    vi.spyOn(darwinComputerUse, "inputPlan").mockReturnValue(command(""));
    const start = structured(await h.tools.computer_record!.execute({ action: "start", window_id: 42 }, h.context));
    expect(start.metadata).toMatchObject({ state: "recording", action: "record", platform: "darwin" });
    await h.tools.computer_type!.execute({ text: "private-input", window_id: 42 }, h.context);
    const stopped = structured(await h.tools.computer_record!.execute({ action: "stop" }, h.context));
    expect(stopped.metadata).toMatchObject({ state: "stopped", step_count: 1, frame_count: 2 });
    expect(capture.mock.calls.every(([request]) => request.windowId === 42)).toBe(true);
    expect(remember).not.toHaveBeenCalled();
    const timeline = readFileSync(stopped.metadata!.timeline_path as string, "utf8");
    expect(timeline).not.toContain("private-input");
    expect(JSON.parse(timeline)).toMatchObject({ tool: "computer_type", success: true, arguments: { text_length: 13, window_id: 42 } });
  });

  it("status sends no native commands and a denied capture permission refuses start", async () => {
    setPlatformForTest("darwin");
    const h = harness();
    const probe = vi.spyOn(darwinComputerUse, "capturePermissionProbe").mockReturnValue(command("process.stdout.write('denied')"));
    vi.spyOn(darwinComputerUse, "capturePlan").mockReturnValue(command("process.exit(99)"));
    const status = structured(await h.tools.computer_record!.execute({ action: "status" }, h.context));
    expect(status.metadata?.state).toBe("idle");
    expect(probe).not.toHaveBeenCalled();
    const start = structured(await h.tools.computer_record!.execute({ action: "start" }, h.context));
    expect(start.metadata?.error).toBe(true);
    expect(start.output).toContain("Screen Recording permission");
  });
});
