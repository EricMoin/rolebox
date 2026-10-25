import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createComputerTools } from "../src/computer/tools.ts";
import { readPngSize } from "../src/computer/png.ts";
import type { CanonicalToolContext, ToolResult } from "../src/platform/types.ts";

type Rect = { x: number; y: number; width: number; height: number; centerX: number; centerY: number };
type FixtureWindow = { id: number; visible: boolean; key: boolean; frame: Rect; backingScale: number };
type FixtureState = {
  ready: boolean; closed: boolean; pid: number; frontmost: boolean; keyWindowId: number;
  updatedAtMs: number; sequence: number;
  coordinateSpace: string; primary: FixtureWindow; secondary: FixtureWindow;
  button: { rect: Rect; clicks: number };
  input: { rect: Rect; value: string; changes: number; mouseDowns: number; focused: boolean };
  scroll: { rect: Rect; offsetY: number; wheelEvents: number };
  drag: { block: Rect; target: Rect; downs: number; moves: number; ups: number; dragging: boolean };
};
type Step = {
  name: string; status: "running" | "passed" | "failed"; startedAt: string;
  elapsedMs?: number; result?: unknown; evidence?: unknown; error?: string;
};

const usage = "Usage: node --import tsx scripts/computer-macos-smoke.ts --run --state <fixture-state.json> --output <directory>\n" +
  "Start tests/computer/fixtures/macos-cua-app.swift separately. This runner controls only that fixture; it does not request permissions or manage its lifetime.";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function options() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(usage);
    return;
  }
  let run = false;
  let state: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--run") run = true;
    else if (arg === "--state" || arg === "--output") {
      const value = args[++index];
      check(value && !value.startsWith("--"), `${arg} requires a path.`);
      if (arg === "--state") state = value;
      else output = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  check(run && state && output, usage);
  check(process.platform === "darwin", "This smoke runner requires macOS.");
  return { state: resolve(state), output: resolve(output) };
}

function withoutAttachments(result: ToolResult): unknown {
  if (typeof result === "string") return result;
  return {
    ...result,
    attachments: result.attachments?.map(attachment => ({
      mime: attachment.mime,
      bytes: attachment.url.startsWith("data:") ? Buffer.from(attachment.url.split(",")[1] ?? "", "base64").byteLength : null,
    })),
  };
}

async function main() {
  const config = options();
  if (!config) return;
  mkdirSync(config.output, { recursive: true, mode: 0o700 });
  const report: { status: string; startedAt: string; finishedAt?: string; steps: Step[]; error?: string } = {
    status: "running", startedAt: new Date().toISOString(), steps: [],
  };
  const save = () => writeFileSync(join(config.output, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const tools = createComputerTools();
  const context: CanonicalToolContext = {
    sessionID: "computer-macos-smoke", messageID: "computer-macos-smoke", agent: "smoke",
    directory: process.cwd(), worktree: process.cwd(), abort: controller.signal,
    metadata() {}, async ask() { throw new Error("The smoke runner cannot grant permissions."); },
  };
  let identity: { pid: number; primary: number; secondary: number } | undefined;
  let beforeScreenshotHash: string | undefined;
  function state(requirePrimary = false): FixtureState {
    check(!controller.signal.aborted, "Smoke run interrupted; no further input will be sent.");
    const value = JSON.parse(readFileSync(config!.state, "utf8")) as FixtureState;
    check(Number.isFinite(value.updatedAtMs) && Math.abs(Date.now() - value.updatedAtMs) <= 1_000,
      "Fixture heartbeat is missing or stale; stopping before further input.");
    check(Number.isSafeInteger(value.sequence) && value.sequence > 0, "Fixture heartbeat sequence is invalid.");
    check(value.ready === true && value.closed === false, "Fixture is not ready or has closed.");
    check(value.coordinateSpace === "global-screen-points-top-left", "Unexpected fixture coordinate space.");
    check(Number.isInteger(value.pid) && value.pid > 0, "Fixture PID is invalid.");
    process.kill(value.pid, 0);
    check(value.primary?.visible === true && value.secondary?.visible === true, "Fixture windows must remain visible.");
    check(Number.isInteger(value.primary.id) && value.primary.id > 0 && Number.isInteger(value.secondary.id) && value.secondary.id > 0,
      "Fixture window IDs are invalid.");
    if (identity) check(value.pid === identity.pid && value.primary.id === identity.primary && value.secondary.id === identity.secondary,
      "Fixture identity changed; stopping before further input.");
    else identity = { pid: value.pid, primary: value.primary.id, secondary: value.secondary.id };
    if (requirePrimary) check(value.frontmost === true && value.primary.key === true && value.keyWindowId === value.primary.id,
      "Fixture primary window lost focus; stopping before further input.");
    return value;
  }
  function point(rect: Rect) {
    check(rect && [rect.x, rect.y, rect.width, rect.height, rect.centerX, rect.centerY].every(Number.isFinite)
      && rect.width > 0 && rect.height > 0, "Fixture target rectangle is invalid.");
    return { x: rect.centerX, y: rect.centerY };
  }
  async function waitFor(predicate: (value: FixtureState) => boolean, description: string, requirePrimary = false) {
    const deadline = Date.now() + 3_000;
    let latest = state(requirePrimary);
    while (!predicate(latest)) {
      check(Date.now() < deadline, `Fixture did not confirm ${description} within 3000ms.`);
      await new Promise(done => setTimeout(done, 50));
      latest = state(requirePrimary);
    }
    return latest;
  }
  async function step(name: string, action: (entry: Step) => Promise<unknown>) {
    const entry: Step = { name, status: "running", startedAt: new Date().toISOString() };
    report.steps.push(entry);
    save();
    const started = Date.now();
    try {
      entry.evidence = await action(entry);
      entry.status = "passed";
      console.log(`PASS ${name}`);
    } catch (error) {
      entry.status = "failed";
      entry.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      entry.elapsedMs = Date.now() - started;
      save();
    }
  }
  async function call(entry: Step, name: string, args: Record<string, unknown>, input = false) {
    const initial = state(input);
    if (input) await waitFor(value => value.sequence > initial.sequence, "a fresh fixture heartbeat before input", true);
    const result = await tools[name]!.execute({ ...args, timeout_ms: 10_000 }, context);
    entry.result = withoutAttachments(result);
    save();
    check(typeof result !== "string", `${name} returned an unstructured result.`);
    check(!result.output.startsWith("Error:") && result.metadata?.error !== true, `${name}: ${result.output}`);
    state(input);
    return result;
  }
  async function screenshot(entry: Step, filename: string) {
    const before = state();
    const path = join(config!.output, filename);
    check(!existsSync(path), `Screenshot output ${filename} already exists; use a fresh output directory.`);
    const result = await call(entry, "computer_screenshot", { window_id: before.primary.id, path });
    const bytes = readFileSync(path);
    const size = readPngSize(bytes);
    const attachment = result.attachments?.[0];
    check(size && size.width > 0 && size.height > 0, "Screenshot is not a nonempty PNG.");
    check(Number.isFinite(before.primary.backingScale) && before.primary.backingScale > 0,
      "Fixture window backing scale is invalid.");
    const expectedWidth = Math.round(before.primary.frame.width * before.primary.backingScale);
    const expectedHeight = Math.round(before.primary.frame.height * before.primary.backingScale);
    check(size.width === expectedWidth && size.height === expectedHeight,
      `Screenshot dimensions ${size.width}x${size.height} do not match fixture window ${expectedWidth}x${expectedHeight}.`);
    check(result.metadata?.width === size.width && result.metadata.height === size.height, "Screenshot dimensions disagree with PNG.");
    check(result.attachments?.length === 1 && attachment?.mime === "image/png"
      && attachment.url.startsWith("data:image/png;base64,"), "Screenshot image attachment is missing.");
    check(Buffer.from(attachment.url.split(",")[1]!, "base64").equals(bytes), "Screenshot attachment differs from the saved PNG.");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (filename === "before.png") beforeScreenshotHash = sha256;
    else check(beforeScreenshotHash !== undefined && sha256 !== beforeScreenshotHash,
      "The final screenshot did not change after fixture interactions.");
    return { filename, ...size, bytes: bytes.byteLength, windowId: before.primary.id, sha256 };
  }
  try {
    await step("fixture", async () => {
      const current = state();
      check(current.input.value === "", "Use a fresh fixture with an empty text field.");
      check(!current.drag.dragging && current.drag.downs === 0, "Use a fresh fixture before dragging.");
      check(current.button.clicks === 0 && current.input.mouseDowns === 0 && current.scroll.wheelEvents === 0,
        "Use a fresh fixture without prior desktop interaction.");
      return { pid: current.pid, primary: current.primary.id, secondary: current.secondary.id };
    });
    await step("status", async entry => {
      const result = await call(entry, "computer_status", {});
      const input = result.metadata?.input_permission as { granted?: boolean } | undefined;
      const capture = result.metadata?.screen_capture as { granted?: boolean } | undefined;
      check(input?.granted === true && capture?.granted === true, "Accessibility and Screen Recording permissions must both be granted.");
      return { inputGranted: true, captureGranted: true };
    });
    await step("displays", async entry => {
      const result = await call(entry, "computer_displays", {});
      const displays = result.metadata?.displays;
      check(Array.isArray(displays) && displays.length > 0, "No displays were returned.");
      return displays;
    });
    await step("screenshot-before", entry => screenshot(entry, "before.png"));
    for (const target of ["secondary", "primary"] as const) {
      await step(`focus-${target}`, async entry => {
        const id = state()[target].id;
        await call(entry, "computer_focus", { window_id: id });
        const current = await waitFor(value => value.frontmost && value.keyWindowId === id && value[target].key, `${target} focus`);
        return { keyWindowId: current.keyWindowId, frontmost: current.frontmost };
      });
    }
    await step("click", async entry => {
      const before = state(true);
      await call(entry, "computer_click", point(before.button.rect), true);
      const current = await waitFor(value => value.button.clicks === before.button.clicks + 1, "button click", true);
      return { before: before.button.clicks, after: current.button.clicks };
    });
    await step("click-custom-view", async entry => {
      const before = state(true);
      await call(entry, "computer_click", point(before.drag.block), true);
      const current = await waitFor(value => value.drag.downs === before.drag.downs + 1
        && value.drag.ups === before.drag.ups + 1 && !value.drag.dragging, "mouse down and up on custom view", true);
      return { downs: current.drag.downs, ups: current.drag.ups, dragging: current.drag.dragging };
    });
    await step("focus-input", async entry => {
      const before = state(true);
      await call(entry, "computer_click", point(before.input.rect), true);
      const current = await waitFor(value => value.input.mouseDowns === before.input.mouseDowns + 1 && value.input.focused,
        "text view mouse down and first responder", true);
      return { keyWindowId: current.keyWindowId, mouseDowns: current.input.mouseDowns, focused: current.input.focused };
    });
    await step("type", async entry => {
      const before = state(true);
      const text = "CUA ASCII 123 中文 🙂 e\u0301 \"quotes\" \\ path\nsecond line";
      await call(entry, "computer_type", { text }, true);
      const current = await waitFor(value => value.input.value === text && value.input.changes > before.input.changes, "exact Unicode and multiline text", true);
      return { value: current.input.value, changes: current.input.changes };
    });
    for (const direction of ["down", "up"] as const) {
      await step(`scroll-${direction}`, async entry => {
        const before = state(true);
        await call(entry, "computer_scroll", { direction, amount: 6, ...point(before.scroll.rect) }, true);
        const current = await waitFor(value => value.scroll.wheelEvents > before.scroll.wheelEvents
          && (direction === "down" ? value.scroll.offsetY > before.scroll.offsetY : value.scroll.offsetY < before.scroll.offsetY), `${direction} scroll`, true);
        return { before: before.scroll.offsetY, after: current.scroll.offsetY, wheelEvents: current.scroll.wheelEvents };
      });
    }
    await step("drag", async entry => {
      const before = state(true);
      const from = point(before.drag.block);
      const to = point(before.drag.target);
      await call(entry, "computer_drag", { from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y, duration_ms: 800 }, true);
      const current = await waitFor(value => value.drag.downs === before.drag.downs + 1
        && value.drag.moves > before.drag.moves && value.drag.ups === before.drag.ups + 1 && !value.drag.dragging
        && Math.abs(value.drag.block.centerX - to.x) <= 2 && Math.abs(value.drag.block.centerY - to.y) <= 2, "complete drag onto target", true);
      return current.drag;
    });
    await step("screenshot-after", async entry => {
      const result = await screenshot(entry, "after.png");
      const current = state(true);
      check(current.button.clicks === 1 && current.input.mouseDowns === 1 && current.scroll.wheelEvents === 2
        && current.drag.downs === 2 && current.drag.ups === 2 && !current.drag.dragging,
        "Unexpected desktop input was observed during the smoke run; repeat with a fresh fixture and no concurrent input.");
      return { ...result, interactionCounts: { clicks: current.button.clicks, textClicks: current.input.mouseDowns,
        wheelEvents: current.scroll.wheelEvents, mouseDowns: current.drag.downs, mouseUps: current.drag.ups } };
    });
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    console.error(`CUA smoke failed: ${report.error}`);
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    save();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

await main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
