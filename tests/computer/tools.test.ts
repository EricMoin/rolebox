/// <reference types="bun-types" />

/**
 * The computer-use tool face: dry-run plans, refusals, the screenshot
 * attachment, and the default-off registration.
 *
 * Every tool assertion goes through `dry_run`, which executes nothing: no test
 * in this file can move the pointer, type a character or photograph the
 * developer's screen. The one real capture lives in its own file, guarded to
 * macOS.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureDirectory, captureFilePath, captureResult, ensureCaptureDirectory, readPixelScale } from "../../src/computer/capture.ts";
import { darwinComputerUse } from "../../src/computer/drivers/darwin.ts";
import { helperAvailable, spawnVectorFor } from "../../src/computer/exec.ts";
import { PNG_SIGNATURE, hasPngSignature, readPngResolution, readPngSize } from "../../src/computer/png.ts";
import {
  createComputerClickTool,
  createComputerKeyTool,
  createComputerMoveTool,
  createComputerPermissionsTool,
  createComputerScreenshotTool,
  createComputerTools,
  createComputerTypeTool,
  createComputerWindowsTool,
  permissionRefusal,
  permissionVerdict,
} from "../../src/computer/tools.ts";
import { opencodeCapabilities } from "../../src/platform/capabilities.ts";
import { ROLE_SNAPSHOT_TOOL_KEYS, buildCanonicalTools } from "../../src/platform/tool-assembly.ts";
import { setPlatformForTest } from "../../src/platform/system/index.ts";
import type { CanonicalToolContext } from "../../src/platform/types.ts";

const COMPUTER_TOOL_NAMES = [
  "computer_click",
  "computer_key",
  "computer_move",
  "computer_permissions",
  "computer_screenshot",
  "computer_type",
  "computer_windows",
];

const worktrees: string[] = [];

function makeWorktree(): string {
  const directory = mkdtempSync(join(tmpdir(), "rolebox-computer-test-"));
  worktrees.push(directory);
  return directory;
}

function makeContext(worktree: string): CanonicalToolContext {
  return {
    sessionID: "session-test",
    messageID: "message-test",
    agent: "agent-test",
    directory: worktree,
    worktree,
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  };
}

/**
 * One valid PNG whose IHDR the tool can read (chunk CRCs are not read). A `dpi`
 * additionally writes the pHYs density chunk a real capture carries: the same
 * pixels per metre on both axes, unit 1, the way screencapture tags a 2x screen.
 */
function tinyPng(width: number, height: number, dpi?: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const chunks = [chunk("IHDR", header)];
  if (dpi !== undefined) {
    const density = Buffer.alloc(9);
    const perMetre = Math.round(dpi / 0.0254);
    density.writeUInt32BE(perMetre, 0);
    density.writeUInt32BE(perMetre, 4);
    density[8] = 1;
    chunks.push(chunk("pHYs", density));
  }
  chunks.push(
    chunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])),
    chunk("IEND", Buffer.alloc(0)),
  );
  return Buffer.concat([Buffer.from([...PNG_SIGNATURE]), ...chunks]);
}

/**
 * The byte offset of the pHYs chunk's 9-byte data in a `tinyPng`: 8 signature +
 * 25 IHDR chunk (8 header + 13 data + 4 CRC) + 8 pHYs header.
 */
const PHYS_DATA_OFFSET = 8 + 25 + 8;

function parseReport(result: unknown): Record<string, any> {
  expect(typeof result).toBe("object");
  const output = (result as { output: string }).output;
  return JSON.parse(output);
}

afterEach(() => {
  setPlatformForTest(undefined);
  while (worktrees.length > 0) rmSync(worktrees.pop()!, { recursive: true, force: true });
});

// ── Dry runs ─────────────────────────────────────────────────────────────────

describe("computer tools — dry runs", () => {
  it("darwin dry-runs screenshot, windows, click, move, type, key and permissions", async () => {
    setPlatformForTest("darwin");
    const context = makeContext(makeWorktree());

    const screenshot = await createComputerScreenshotTool().execute({ dry_run: true }, context);
    const shot = parseReport(screenshot);
    expect(shot.argv[0]).toBe("/usr/sbin/screencapture");
    expect((screenshot as any).metadata.dry_run).toBe(true);
    expect((screenshot as any).metadata.driver).toBe("screencapture");

    const windows = parseReport(await createComputerWindowsTool().execute({ dry_run: true }, context));
    expect(windows.argv[0]).toBe("/usr/bin/osascript");
    expect(windows.argv.slice(1, 5)).toEqual(["-l", "JavaScript", "-e", windows.script]);
    expect(windows.script).toContain("CGWindowListCopyWindowInfo");
    expect(windows.script).not.toContain("AXWindowNumber");

    const click = parseReport(
      await createComputerClickTool().execute({ x: 10, y: 20, button: "left", clicks: 2, dry_run: true }, context),
    );
    expect(click.argv[0]).toBe("/usr/bin/osascript");
    expect(click.script).toContain("click at {10, 20}");

    const move = parseReport(await createComputerMoveTool().execute({ x: 1, y: 2, dry_run: true }, context));
    expect(move.argv[0]).toBe("cliclick");
    expect(move.argv[1]).toBe("m:1,2");

    const typed = parseReport(await createComputerTypeTool().execute({ text: "hello", dry_run: true }, context));
    expect(typed.script).toContain('keystroke "hello"');

    const key = parseReport(await createComputerKeyTool().execute({ keys: ["cmd", "c"], dry_run: true }, context));
    expect(key.argv[0]).toBe("/usr/bin/osascript");
    expect(key.script).toContain("keystroke \"c\" using {command down}");

    const permissionsResult = await createComputerPermissionsTool().execute({ dry_run: true }, context);
    const permissions = parseReport(permissionsResult);
    expect(permissions.script).toContain("UI elements enabled");
    expect((permissions as any).metadata).toBeUndefined();
    expect((permissionsResult as any).metadata).toEqual({
      platform: "darwin",
      driver: "osascript",
      action: "permissions",
      dry_run: true,
    });
  });

  it("linux dry-runs the X11 helpers as argv", async () => {
    setPlatformForTest("linux");
    const context = makeContext(makeWorktree());

    const click = parseReport(await createComputerClickTool().execute({ x: 5, y: 6, dry_run: true }, context));
    expect(click.argv).toEqual(["xdotool", "mousemove", "--sync", "5", "6", "click", "1"]);
    const key = parseReport(await createComputerKeyTool().execute({ keys: ["ctrl", "t"], dry_run: true }, context));
    expect(key.argv).toEqual(["xdotool", "key", "--clearmodifiers", "ctrl+t"]);
    const screenshot = parseReport(await createComputerScreenshotTool().execute({ dry_run: true }, context));
    expect(screenshot.argv[0]).toBe("/bin/sh");
    expect(screenshot.script).toContain("import -window root");
  });

  it("win32 dry-runs PowerShell scripts and reports their metadata", async () => {
    setPlatformForTest("win32");
    const context = makeContext(makeWorktree());

    const screenshot = await createComputerScreenshotTool().execute({ dry_run: true }, context);
    const shot = parseReport(screenshot);
    expect(shot.argv[0]).toBe("powershell");
    expect((screenshot as any).metadata).toEqual({ platform: "win32", driver: "powershell", action: "screenshot", dry_run: true });

    const key = parseReport(await createComputerKeyTool().execute({ keys: ["ctrl", "v"], dry_run: true }, context));
    expect(key.script).toContain("SendWait('^v')");
    const windows = parseReport(await createComputerWindowsTool().execute({ app: "code", dry_run: true }, context));
    expect(windows.script).toContain("MainWindowHandle");
  });

  it("executes nothing and writes nothing for a dry run", async () => {
    setPlatformForTest("darwin");
    const worktree = makeWorktree();
    const context = makeContext(worktree);
    await createComputerScreenshotTool().execute({ dry_run: true }, context);
    expect(existsSync(join(worktree, ".rolebox"))).toBe(false);
  });
});

// ── Refusals ─────────────────────────────────────────────────────────────────

describe("computer tools — refusals", () => {
  it("refuses every tool on a platform rolebox declares no driver for", async () => {
    setPlatformForTest("aix");
    const context = makeContext(makeWorktree());
    const calls: Array<[string, Promise<unknown>]> = [
      ["screenshot", createComputerScreenshotTool().execute({ dry_run: true }, context)],
      ["windows", createComputerWindowsTool().execute({ dry_run: true }, context)],
      ["click", createComputerClickTool().execute({ x: 1, y: 2, dry_run: true }, context)],
      ["move", createComputerMoveTool().execute({ x: 1, y: 2, dry_run: true }, context)],
      ["type", createComputerTypeTool().execute({ text: "x", dry_run: true }, context)],
      ["key", createComputerKeyTool().execute({ keys: ["Return"], dry_run: true }, context)],
      ["permissions", createComputerPermissionsTool().execute({ dry_run: true }, context)],
    ];
    for (const [, call] of calls) {
      const result = (await call) as any;
      expect(result.output.startsWith("Error: ")).toBe(true);
      expect(result.output).toContain("posix");
      expect(result.output).toContain("macOS");
      expect(result.output).toContain('platform "aix"');
      expect(result.metadata.driver).toBe("unsupported");
      expect(result.metadata.action.length).toBeGreaterThan(0);
      expect(result.attachments).toBeUndefined();
    }
  });

  it("refuses an impossible request with a named cause instead of a silent no-op", async () => {
    setPlatformForTest("darwin");
    const context = makeContext(makeWorktree());
    const both = (await createComputerScreenshotTool().execute(
      { window_id: 4, region: { x: 0, y: 0, w: 10, h: 10 }, dry_run: true },
      context,
    )) as any;
    expect(both.output).toContain("Error: ");
    expect(both.output).toContain("not both");

    const windowed = (await createComputerTypeTool().execute({ text: "hi", window_id: 4, dry_run: true }, context)) as any;
    expect(windowed.output).toContain("frontmost application");
    expect(windowed.metadata.driver).toBe("none");

    const badKey = (await createComputerKeyTool().execute({ keys: ["Nope"], dry_run: true }, context)) as any;
    expect(badKey.output.startsWith("Error: ")).toBe(true);
    expect(badKey.output).toContain("no key named");
  });

  it("refuses a missing helper before spawning anything", async () => {
    // A PATH with nothing in it: the xdotool plan cannot resolve, so the
    // executor must refuse without starting a process.
    const plan = {
      argv: ["xdotool", "mousemove", "--sync", "1", "2"],
      windowsVerbatimArguments: false,
      requires: ["xdotool"],
      driver: "xdotool",
    };
    const { runComputerPlan } = await import("../../src/computer/exec.ts");
    const result = await runComputerPlan(plan, { env: { PATH: "/nonexistent-rolebox-path" }, installHint: "install xdotool." });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.startsWith("Error: ")).toBe(true);
      expect(result.error).toContain("xdotool");
      expect(result.error).toContain("install xdotool.");
    }
    expect(helperAvailable("xdotool", { PATH: "/nonexistent-rolebox-path" })).toBe(false);
    expect(helperAvailable("/bin/sh", { PATH: "" })).toBe(process.platform !== "win32");
  });

  it("bounds a run with the timeout and reports it without throwing", async () => {
    const { runComputerPlan } = await import("../../src/computer/exec.ts");
    if (process.platform === "win32") return;
    const result = await runComputerPlan(
      { argv: ["/bin/sh", "-c", "sleep 30"], windowsVerbatimArguments: false, requires: ["/bin/sh"], driver: "sh" },
      { timeoutMs: 150 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("did not finish within 150ms");
  });

  it("refuses a cancelled run before it starts", async () => {
    const { runComputerPlan } = await import("../../src/computer/exec.ts");
    const controller = new AbortController();
    controller.abort();
    const result = await runComputerPlan(
      { argv: ["/bin/sh", "-c", "true"], windowsVerbatimArguments: false, requires: ["/bin/sh"], driver: "sh" },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cancelled");
  });
});

// ── The permission verdict ───────────────────────────────────────────────────

describe("the permission verdict", () => {
  it("reads the answer each per-OS probe actually prints", () => {
    // darwin: osascript prints the boolean `UI elements enabled` returns.
    expect(permissionVerdict("true")).toBe(true);
    expect(permissionVerdict("false")).toBe(false);
    // linux and win32 print a sentence and report a refusal through a non-zero
    // exit, which runComputerPlan turns into run.error before this rule is used.
    expect(
      permissionVerdict("X11 session: no per-application input permission is required, and xdotool is installed."),
    ).toBe(true);
    expect(
      permissionVerdict(
        "Windows input needs no per-application permission grant; this session is interactive and SendKeys is available.",
      ),
    ).toBe(true);
  });

  it("denies only the refusal tokens, so an empty or unexpected answer reads as granted", () => {
    for (const denial of ["false", "no", "FALSE", "No", " no \n", "\tFalse"]) {
      expect(permissionVerdict(denial)).toBe(false);
    }
    // The rule is a deny-list: a probe that prints nothing, or prints something
    // this family has never seen, is not read as a refusal.
    for (const other of ["", "   ", "true", "yes", "0", "permission denied"]) {
      expect(permissionVerdict(other)).toBe(true);
    }
  });

  it("builds the refusal sentence and metadata the permissions tool returns", () => {
    setPlatformForTest("darwin");
    const plan = darwinComputerUse.permissionProbe();
    const refusal = permissionRefusal(plan.driver, plan.permissionHint);
    expect(refusal.output.startsWith("Error: osascript reports that input is not permitted; macOS gives input")).toBe(
      true,
    );
    expect(refusal.output).toBe(`Error: ${plan.driver} reports that input is not permitted; ${plan.permissionHint}`);
    expect(refusal.title).toBe("permissions");
    expect(refusal.metadata).toEqual({ platform: "darwin", driver: "osascript", action: "permissions", granted: false });
  });

  it("falls back to the generic remediation sentence when a plan carries no hint", () => {
    setPlatformForTest("darwin");
    const refusal = permissionRefusal("osascript", undefined);
    expect(refusal.output).toBe(
      "Error: osascript reports that input is not permitted; grant this process the permission its system requires and try again.",
    );
  });
});

// ── Screenshot paths and attachments ─────────────────────────────────────────

describe("screenshot files and attachments", () => {
  it("generates a sequenced path under <worktree>/.rolebox/computer", () => {
    const worktree = makeWorktree();
    const path = captureFilePath(worktree, new Date("2026-10-09T12:12:55.123Z"), 7);
    expect(path).toBe(join(worktree, ".rolebox", "computer", "20261009T121255123Z-007.png"));
  });

  it("creates the capture directory owner-only, even when it already exists", () => {
    const worktree = makeWorktree();
    const directory = captureDirectory(worktree);
    mkdirSync(directory, { recursive: true, mode: 0o755 });
    chmodSync(directory, 0o755);
    ensureCaptureDirectory(directory);
    if (process.platform !== "win32") expect(statSync(directory).mode & 0o777).toBe(0o700);
  });

  it("returns the PNG as an attachment plus text, never base64 in the text", () => {
    const worktree = makeWorktree();
    const directory = captureDirectory(worktree);
    ensureCaptureDirectory(directory);
    const path = captureFilePath(worktree, new Date("2026-10-09T12:12:55.123Z"), 1);
    const bytes = tinyPng(120, 80);
    writeFileSync(path, bytes);

    const result = captureResult(path, "darwin", "screencapture") as any;
    expect(result.output).toBe(`[image: image/png, ${bytes.byteLength} bytes]\n${path}`);
    expect(result.output).not.toContain("base64");
    // No pHYs: the file states no scale, so nothing is invented for it.
    expect("pixel_scale" in result.metadata).toBe(false);
    expect(result.metadata).toEqual({
      platform: "darwin",
      driver: "screencapture",
      action: "screenshot",
      path,
      width: 120,
      height: 80,
      bytes: bytes.byteLength,
    });
    expect(result.attachments).toHaveLength(1);
    const attachment = result.attachments[0];
    expect(attachment.type).toBe("file");
    expect(attachment.mime).toBe("image/png");
    expect(attachment.filename).toBe("20261009T121255123Z-001.png");
    expect(attachment.url.startsWith("data:image/png;base64,")).toBe(true);
    expect(Buffer.from(attachment.url.split(",")[1], "base64").equals(bytes)).toBe(true);
  });

  it("refuses a file that is not a PNG, naming the path and the cause", () => {
    const worktree = makeWorktree();
    const directory = captureDirectory(worktree);
    ensureCaptureDirectory(directory);
    const path = join(directory, "not-a-png.png");
    writeFileSync(path, "this is not a PNG");
    const result = captureResult(path, "linux", "import") as any;
    expect(result.output.startsWith("Error: ")).toBe(true);
    expect(result.output).toContain(path);
    expect(result.output).toContain("not a PNG");
    expect(result.attachments).toBeUndefined();

    const missing = captureResult(join(directory, "absent.png"), "linux", "import") as any;
    expect(missing.output.startsWith("Error: ")).toBe(true);
    expect(missing.output).toContain("could not be read");
  });

  it("reads the PNG signature and IHDR geometry", () => {
    const bytes = tinyPng(7, 9);
    expect(hasPngSignature(bytes)).toBe(true);
    expect(readPngSize(bytes)).toEqual({ width: 7, height: 9 });
    expect(readPngSize(Buffer.from("nope"))).toBeNull();
    expect(readPngSize(Buffer.alloc(24, 0))).toBeNull();
  });

  it("reports the pixel scale a capture states, with the division it implies", () => {
    const worktree = makeWorktree();
    const directory = captureDirectory(worktree);
    ensureCaptureDirectory(directory);
    const path = captureFilePath(worktree, new Date("2026-10-09T12:12:55.123Z"), 2);
    const bytes = tinyPng(120, 80, 144);
    writeFileSync(path, bytes);

    const result = captureResult(path, "darwin", "screencapture") as any;
    expect(result.metadata.pixel_scale).toBe(2);
    const lines = result.output.split("\n");
    expect(lines[0]).toBe(`[image: image/png, ${bytes.byteLength} bytes]`);
    expect(lines[1]).toBe(path);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("120x80 pixels");
    expect(lines[2]).toContain("pixel_scale 2");
    expect(lines[2]).toContain("60x40 in screen coordinates");
    expect(lines[2]).toContain("computer_click and computer_move take screen coordinates");
    expect(lines[2]).toContain("divide any pixel coordinate read off this image by 2");
    // Still the bytes themselves, and still never base64 in the text.
    expect(Buffer.from(result.attachments[0].url.split(",")[1], "base64").equals(bytes)).toBe(true);
    expect(result.output).not.toContain("base64");
  });

  it("reports a 1:1 capture as pixel_scale 1 and adds no sentence for it", () => {
    const worktree = makeWorktree();
    const directory = captureDirectory(worktree);
    ensureCaptureDirectory(directory);
    const path = captureFilePath(worktree, new Date("2026-10-09T12:12:55.123Z"), 3);
    const bytes = tinyPng(120, 80, 72);
    writeFileSync(path, bytes);

    const result = captureResult(path, "darwin", "screencapture") as any;
    expect(result.metadata.pixel_scale).toBe(1);
    expect(result.output).toBe(`[image: image/png, ${bytes.byteLength} bytes]\n${path}`);
  });

  it("reads a pHYs density, and answers null for every one it cannot trust", () => {
    const scaled = tinyPng(7, 9, 144);
    expect(readPngResolution(scaled)).toEqual({ xPixelsPerMetre: 5669, yPixelsPerMetre: 5669, unit: 1 });
    expect(readPixelScale(scaled)).toBe(2);
    expect(readPixelScale(tinyPng(7, 9, 72))).toBe(1);

    // No pHYs at all: a scale is not invented.
    expect(readPngResolution(tinyPng(7, 9))).toBeNull();
    expect(readPixelScale(tinyPng(7, 9))).toBeNull();

    // A truncated file: the pHYs data is cut off before its CRC.
    expect(readPngResolution(scaled.subarray(0, PHYS_DATA_OFFSET + 6))).toBeNull();

    // A bad signature is not a PNG, whatever follows it.
    const badSignature = Buffer.from(scaled);
    badSignature[1] = 0x00;
    expect(readPngResolution(badSignature)).toBeNull();

    // Unit 0 states an aspect ratio rather than a density.
    const aspectOnly = Buffer.from(scaled);
    aspectOnly[PHYS_DATA_OFFSET + 8] = 0;
    expect(readPngResolution(aspectOnly)).toEqual({ xPixelsPerMetre: 5669, yPixelsPerMetre: 5669, unit: 0 });
    expect(readPixelScale(aspectOnly)).toBeNull();

    // A density that disagrees with itself on the two axes is not a scale.
    const skewed = Buffer.from(scaled);
    skewed.writeUInt32BE(2835, PHYS_DATA_OFFSET);
    expect(readPixelScale(skewed)).toBeNull();

    // A density between two whole scales (5.5x) is not one either: the 1% rule.
    const between = Buffer.from(scaled);
    const fiveAndAHalf = Math.round((72 / 0.0254) * 5.5);
    between.writeUInt32BE(fiveAndAHalf, PHYS_DATA_OFFSET);
    between.writeUInt32BE(fiveAndAHalf, PHYS_DATA_OFFSET + 4);
    expect(readPixelScale(between)).toBeNull();
  });
});

// ── Registration ─────────────────────────────────────────────────────────────

describe("tool registration", () => {
  const base = { resolvedRoles: [], directory: process.cwd(), capabilities: opencodeCapabilities() };

  it("declares exactly the seven documented tool names", () => {
    expect(Object.keys(createComputerTools()).sort()).toEqual(COMPUTER_TOOL_NAMES);
  });

  it("registers nothing unless the host opts in", () => {
    const off = Object.keys(buildCanonicalTools(base));
    expect(off.filter(key => key.startsWith("computer_"))).toEqual([]);

    const on = Object.keys(buildCanonicalTools({ ...base, computerUse: true }));
    expect(on.filter(key => key.startsWith("computer_")).sort()).toEqual(COMPUTER_TOOL_NAMES);
    // The flag is purely additive: everything else is byte-for-byte the same set.
    expect(on.filter(key => !key.startsWith("computer_")).sort()).toEqual([...off].sort());
  });

  it("keeps the computer tools out of the role-snapshot generation", () => {
    for (const name of COMPUTER_TOOL_NAMES) expect(name in ROLE_SNAPSHOT_TOOL_KEYS).toBe(false);
  });
});
