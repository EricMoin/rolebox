import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createComputerTools } from "../src/computer/tools.ts";
import { readPngSize } from "../src/computer/png.ts";
import type { CanonicalToolContext, ToolResult } from "../src/platform/types.ts";
import type { ComputerDisplay } from "../src/platform/system/types.ts";

type Rect = { x: number; y: number; width: number; height: number; centerX: number; centerY: number };
type FixtureWindow = { id: number; visible: boolean; key: boolean; frame: Rect; backingScale: number };
type FixtureState = {
  ready: boolean; closed: boolean; pid: number; frontmost: boolean; keyWindowId: number;
  updatedAtMs: number; sequence: number;
  coordinateSpace: string; primary: FixtureWindow; secondary: FixtureWindow;
  button: { rect: Rect; clicks: number };
  secondaryButton?: { rect: Rect; clicks: number };
  command?: { id: string; ok: boolean; error?: string };
  input: { rect: Rect; value: string; changes: number; mouseDowns: number; focused: boolean };
  scroll: { rect: Rect; offsetY: number; wheelEvents: number };
  drag: { block: Rect; target: Rect; downs: number; moves: number; ups: number; dragging: boolean };
};
type Step = {
  name: string; status: "running" | "passed" | "failed" | "skipped"; startedAt: string;
  elapsedMs?: number; result?: unknown; evidence?: unknown; error?: string;
};

const usage = "Usage: node --import tsx scripts/computer-macos-smoke.ts --run --state <fixture-state.json> --output <directory> [--commands <fixture-command.json>]\n" +
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
  let commands: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--run") run = true;
    else if (arg === "--state" || arg === "--output" || arg === "--commands") {
      const value = args[++index];
      check(value && !value.startsWith("--"), `${arg} requires a path.`);
      if (arg === "--state") state = value;
      else if (arg === "--output") output = value;
      else commands = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  check(run && state && output, usage);
  check(process.platform === "darwin", "This smoke runner requires macOS.");
  return { state: resolve(state), output: resolve(output), commands: commands === undefined ? undefined : resolve(commands) };
}

function checkLosslessJson(value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    check(Number.isFinite(value), "Tool result contains a nonfinite JSON number.");
    return;
  }
  check(typeof value === "object", "Tool result contains a value that is not lossless JSON.");
  for (const child of Object.values(value)) checkLosslessJson(child);
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
  let beforeCapture: { id: string; x: number; y: number; scaleX: number; scaleY: number } | undefined;
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
    const bounds = result.metadata?.screen_bounds as { x: number; y: number; w: number; h: number } | undefined;
    check(bounds && bounds.x === before.primary.frame.x && bounds.y === before.primary.frame.y
      && bounds.w === before.primary.frame.width && bounds.h === before.primary.frame.height,
      "Screenshot screen bounds do not match the fixture window.");
    check(result.metadata?.pixel_scale_x === size.width / bounds.w && result.metadata.pixel_scale_y === size.height / bounds.h,
      "Screenshot coordinate mapping does not match its raster dimensions.");
    check(typeof result.metadata.screenshot_id === "string", "Screenshot ID is missing.");
    check(result.metadata?.width === size.width && result.metadata.height === size.height, "Screenshot dimensions disagree with PNG.");
    check(result.attachments?.length === 1 && attachment?.mime === "image/png"
      && attachment.url.startsWith("data:image/png;base64,"), "Screenshot image attachment is missing.");
    check(Buffer.from(attachment.url.split(",")[1]!, "base64").equals(bytes), "Screenshot attachment differs from the saved PNG.");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (filename === "before.png") {
      beforeScreenshotHash = sha256;
      beforeCapture = { id: result.metadata.screenshot_id, x: bounds.x, y: bounds.y,
        scaleX: result.metadata.pixel_scale_x as number, scaleY: result.metadata.pixel_scale_y as number };
    }
    else check(beforeScreenshotHash !== undefined && sha256 !== beforeScreenshotHash,
      "The final screenshot did not change after fixture interactions.");
    return { filename, ...size, bytes: bytes.byteLength, windowId: before.primary.id, sha256 };
  }
  function skip(name: string, reason: string) {
    report.steps.push({ name, status: "skipped", startedAt: new Date().toISOString(), evidence: { reason } });
    console.log(`SKIP ${name}: ${reason}`);
    save();
  }
  async function captureMapping(entry: Step, filename: string, target: Record<string, unknown>, bounds: { x: number; y: number; w: number; h: number }) {
    const path = join(config!.output, filename);
    check(!existsSync(path), `Screenshot output ${filename} already exists; use a fresh output directory.`);
    const result = await call(entry, "computer_screenshot", { ...target, path });
    const size = readPngSize(readFileSync(path));
    check(size && size.width > 0 && size.height > 0, "Screenshot is not a nonempty PNG.");
    const actual = result.metadata?.screen_bounds as typeof bounds | undefined;
    check(actual && actual.x === bounds.x && actual.y === bounds.y && actual.w === bounds.w && actual.h === bounds.h,
      "Screenshot geometry does not match the requested fixture target.");
    check(typeof result.metadata?.screenshot_id === "string", "Screenshot ID is missing.");
    const scaleX = size.width / bounds.w;
    const scaleY = size.height / bounds.h;
    check(result.metadata.pixel_scale_x === scaleX && result.metadata.pixel_scale_y === scaleY,
      "Screenshot coordinate mapping does not match the PNG dimensions.");
    return { id: result.metadata.screenshot_id, ...bounds, scaleX, scaleY, ...size };
  }
  function frameBounds(frame: Rect) {
    return { x: frame.x, y: frame.y, w: frame.width, h: frame.height };
  }
  function mappedPoint(mapping: { x: number; y: number; scaleX: number; scaleY: number }, rect: Rect) {
    const position = point(rect);
    return { x: (position.x - mapping.x) * mapping.scaleX, y: (position.y - mapping.y) * mapping.scaleY };
  }
  function interactionCounts(value: FixtureState) {
    return { clicks: value.button.clicks, secondaryClicks: value.secondaryButton?.clicks,
      inputClicks: value.input.mouseDowns, textChanges: value.input.changes, wheelEvents: value.scroll.wheelEvents,
      dragDowns: value.drag.downs, dragMoves: value.drag.moves, dragUps: value.drag.ups };
  }
  async function movePrimary(x: number, y: number) {
    check(config!.commands, "The fixture command path is missing.");
    state();
    const id = randomUUID();
    const pending = `${config!.commands}.${id}.tmp`;
    try {
      writeFileSync(pending, JSON.stringify({ id, action: "move", window: "primary", x, y }), { mode: 0o600 });
      renameSync(pending, config!.commands);
    } finally {
      if (existsSync(pending)) unlinkSync(pending);
    }
    const acknowledged = await waitFor(value => value.command?.id === id, "fixture move acknowledgement");
    check(acknowledged.command?.ok === true, `Fixture move failed: ${acknowledged.command?.error ?? "unknown failure"}`);
    return waitFor(value => Math.abs(value.primary.frame.x - x) <= 1 && Math.abs(value.primary.frame.y - y) <= 1,
      "fixture window at the requested screen position");
  }
  async function expectRejected(entry: Step, args: Record<string, unknown>, expected: RegExp) {
    const before = state();
    const result = await tools.computer_click!.execute({ ...args, timeout_ms: 10_000 }, context);
    entry.result = withoutAttachments(result);
    check(typeof result !== "string" && result.output.startsWith("Error:") && expected.test(result.output),
      `Expected screenshot input rejection: ${typeof result === "string" ? result : result.output}`);
    const current = await waitFor(value => value.sequence > before.sequence, "fixture heartbeat after rejected input");
    check(JSON.stringify(interactionCounts(current)) === JSON.stringify(interactionCounts(before)),
      "Rejected screenshot input changed fixture interaction counters.");
    return { rejection: result.output, counts: interactionCounts(current) };
  }
  async function multiDisplayChecks() {
    let displays: ComputerDisplay[] = [];
    await step("multiscreen-layout", async entry => {
      const result = await call(entry, "computer_displays", {});
      check(Array.isArray(result.metadata?.displays), "Display metadata is missing.");
      displays = result.metadata.displays as ComputerDisplay[];
      return displays;
    });
    await step("secondary-window-mapped-click", async entry => {
      const before = state(true);
      check(before.secondaryButton, "Use a fixture with the secondary button probe.");
      const mapping = await captureMapping(entry, "secondary.png", { window_id: before.secondary.id }, frameBounds(before.secondary.frame));
      await call(entry, "computer_click", { screenshot_id: mapping.id, ...mappedPoint(mapping, before.secondaryButton.rect) });
      const current = await waitFor(value => value.secondaryButton?.clicks === before.secondaryButton!.clicks + 1,
        "mapped secondary window click");
      check(current.button.clicks === before.button.clicks, "Secondary click changed the primary window counter.");
      check(current.keyWindowId === before.secondary.id, "Mapped secondary click did not focus its captured window.");
      return { mapping, before: before.secondaryButton.clicks, after: current.secondaryButton!.clicks };
    });
    await step("scroll-without-coordinates", async entry => {
      const initial = state();
      await call(entry, "computer_move", { window_id: initial.primary.id, ...point(initial.scroll.rect) });
      const before = await waitFor(value => value.primary.key, "primary focus before scrolling");
      const result = await call(entry, "computer_scroll", { window_id: before.primary.id, direction: "down", amount: 6 }, true);
      checkLosslessJson(result);
      const current = await waitFor(value => value.scroll.wheelEvents > before.scroll.wheelEvents
        && value.scroll.offsetY > before.scroll.offsetY, "scroll at the current pointer position", true);
      return { losslessJson: true, before: before.scroll.offsetY, after: current.scroll.offsetY,
        wheelEvents: current.scroll.wheelEvents };
    });
    const original = state().primary.frame;
    const contains = (display: ComputerDisplay, x: number, y: number) => x >= display.x && y >= display.y
      && x < display.x + display.width && y < display.y + display.height;
    const originalDisplay = displays.find(display => contains(display, original.centerX, original.centerY));
    let moved = false;
    try {
      for (const display of displays.filter(value => value.id !== originalDisplay?.id)) {
        if (display.width < original.width + 100 || display.height < original.height + 100) {
          skip(`move-to-display-${display.id}`, "The fixture window does not fit on this display with a 100-point inset.");
          continue;
        }
        await step(`move-to-display-${display.id}`, async entry => {
          const before = state();
          const oldMapping = await captureMapping(entry, `display-${display.id}-before-move.png`,
            { window_id: before.primary.id }, frameBounds(before.primary.frame));
          moved = true;
          const current = await movePrimary(display.x + 100, display.y + 100);
          const rejection = await expectRejected(entry,
            { screenshot_id: oldMapping.id, ...mappedPoint(oldMapping, before.button.rect) }, /screenshot geometry changed/i);
          const mapping = await captureMapping(entry, `display-${display.id}-window.png`,
            { window_id: current.primary.id }, frameBounds(current.primary.frame));
          await call(entry, "computer_click", { screenshot_id: mapping.id, ...mappedPoint(mapping, current.button.rect) });
          const clicked = await waitFor(value => value.button.clicks === current.button.clicks + 1, "mapped click after cross-display move", true);
          return { display: display.id, frame: clicked.primary.frame, backingScale: clicked.primary.backingScale,
            mapping, staleRejection: rejection, clicks: clicked.button.clicks };
        });
        await step(`region-on-display-${display.id}`, async entry => {
          const before = state(true);
          const bounds = frameBounds(before.button.rect);
          const mapping = await captureMapping(entry, `display-${display.id}-region.png`, { region: bounds }, bounds);
          await call(entry, "computer_click", { screenshot_id: mapping.id, ...mappedPoint(mapping, before.button.rect) }, true);
          const current = await waitFor(value => value.button.clicks === before.button.clicks + 1, "mapped region click", true);
          return { mapping, clicks: current.button.clicks };
        });
      }
    } finally {
      if (moved && !controller.signal.aborted) {
        await step("restore-fixture-position", async () => {
          const current = await movePrimary(original.x, original.y);
          return { frame: current.primary.frame };
        });
      }
    }
    if (displays.length < 2) skip("cross-display-movement", "Only one display is available.");
    const desktop = { x: Math.min(...displays.map(display => display.x)), y: Math.min(...displays.map(display => display.y)),
      right: Math.max(...displays.map(display => display.x + display.width)),
      bottom: Math.max(...displays.map(display => display.y + display.height)) };
    const gap = displays.flatMap(display => [
      { x: display.x - 8, y: display.y + display.height / 2, region: { x: display.x - 16, y: display.y + display.height / 2 - 16, w: 32, h: 32 } },
      { x: display.x + display.width + 8, y: display.y + display.height / 2,
        region: { x: display.x + display.width - 16, y: display.y + display.height / 2 - 16, w: 32, h: 32 } },
      { x: display.x + display.width / 2, y: display.y - 8, region: { x: display.x + display.width / 2 - 16, y: display.y - 16, w: 32, h: 32 } },
      { x: display.x + display.width / 2, y: display.y + display.height + 8,
        region: { x: display.x + display.width / 2 - 16, y: display.y + display.height - 16, w: 32, h: 32 } },
    ]).find(candidate => candidate.x >= desktop.x && candidate.x < desktop.right && candidate.y >= desktop.y
      && candidate.y < desktop.bottom && !displays.some(display => contains(display, candidate.x, candidate.y)));
    if (gap) {
      await step("display-gap-rejected", async entry => {
        const mapping = await captureMapping(entry, "display-gap.png", { region: gap.region }, gap.region);
        return expectRejected(entry, { screenshot_id: mapping.id,
          x: (gap.x - mapping.x) * mapping.scaleX, y: (gap.y - mapping.y) * mapping.scaleY }, /gap between displays/i);
      });
    } else skip("display-gap-rejected", "The connected display layout has no suitable internal gap beside a display edge.");
    if (new Set(displays.map(display => display.scale)).size < 2) {
      skip("mixed-scale-desktop", "All connected displays have the same backing scale; physical mixed-scale capture is unavailable.");
    } else {
      let region: { x: number; y: number; w: number; h: number } | undefined;
      for (const left of displays) for (const right of displays) {
        if (left.scale === right.scale) continue;
        const top = Math.max(left.y, right.y), bottom = Math.min(left.y + left.height, right.y + right.height);
        if (left.x + left.width === right.x && bottom - top >= 32) {
          region = { x: right.x - 16, y: Math.floor((top + bottom) / 2) - 16, w: 32, h: 32 };
        }
        const x = Math.max(left.x, right.x), edge = Math.min(left.x + left.width, right.x + right.width);
        if (left.y + left.height === right.y && edge - x >= 32) {
          region = { x: Math.floor((x + edge) / 2) - 16, y: right.y - 16, w: 32, h: 32 };
        }
      }
      if (region) {
        const bounds = region;
        await step("mixed-scale-desktop", async entry => ({
          mapping: await captureMapping(entry, "mixed-scale-region.png", { region: bounds }, bounds),
          displays: displays.map(({ id, scale }) => ({ id, scale })),
        }));
      } else skip("mixed-scale-desktop", "Different backing scales are present, but no adjacent screen pair supports this crossing-region probe.");
    }
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
      check(beforeCapture, "The initial screenshot mapping is missing.");
      const position = point(before.button.rect);
      await call(entry, "computer_click", { screenshot_id: beforeCapture.id,
        x: (position.x - beforeCapture.x) * beforeCapture.scaleX,
        y: (position.y - beforeCapture.y) * beforeCapture.scaleY }, true);
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
    if (config.commands) await multiDisplayChecks();
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
