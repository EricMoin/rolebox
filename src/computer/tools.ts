/**
 * The seven computer-use tools — rolebox's own screen-driving family.
 *
 * Every tool answers with the canonical structured {@link ToolResult}: a title,
 * model-facing text, `metadata` that always carries `platform`, `driver` and
 * `action`, and — for a screenshot — one PNG attachment. A failure or refusal
 * is never a thrown exception and never a silent no-op: the text is one
 * sentence that starts with `Error:` and names both the cause and what to do
 * about it (missing helper, missing OS permission, unsupported platform,
 * Wayland session).
 *
 * `dry_run: true` returns the exact spawn vector as JSON
 * (`{argv, windowsVerbatimArguments, script?}`) with `metadata.dry_run` set and
 * executes nothing, which is the seam the tests use: no test ever synthesizes
 * real mouse or keyboard input.
 *
 * Registration is the caller's decision — `buildCanonicalTools` adds this set
 * only when `computerUse: true` is passed, so the default tool surface is
 * unchanged.
 */

import { dirname, resolve } from "node:path";
import { z } from "zod";
import { defineTool, type CanonicalToolDef } from "../platform/ports/tool-factory.ts";
import { currentPlatform, getSystem } from "../platform/system/index.ts";
import type { CanonicalToolContext, ToolResult } from "../platform/types.ts";
import type {
  ComputerInputRequest,
  ComputerPlan,
  ComputerPlanOrRefusal,
  SupportedComputerUse,
} from "../platform/system/types.ts";
import { captureFilePath, captureResult, ensureCaptureDirectory } from "./capture.ts";
import { DEFAULT_COMPUTER_TIMEOUT_MS, runComputerPlan, spawnVectorFor } from "./exec.ts";

/** The action names every result reports in `metadata.action`. */
type ActionName = "screenshot" | "windows" | "click" | "move" | "type" | "key" | "permissions";

const DRY_RUN_ARG = z
  .boolean()
  .optional()
  .describe("Return the exact spawn plan as JSON and execute nothing (the test seam)");

// ── Result plumbing ──────────────────────────────────────────────────────────

function metadataFor(action: ActionName, driver: string): Record<string, unknown> {
  return { platform: getSystem().id, driver, action };
}

type Prepared = { readonly ok: true; readonly plan: ComputerPlan } | { readonly ok: false; readonly result: ToolResult };

/**
 * Turn a per-OS builder's answer into either a plan or the refusal result.
 *
 * A system that declares no driver refuses here, before any builder runs, so an
 * unlisted platform can never be handed a command invented for another one.
 */
function prepare(action: ActionName, build: (facts: SupportedComputerUse) => ComputerPlanOrRefusal): Prepared {
  const facts = getSystem().computerUse;
  if (!facts.supported) {
    const host = currentPlatform();
    const extra = host === getSystem().id ? "" : ` This host reports platform "${host}".`;
    return {
      ok: false,
      result: {
        title: `${action} refused`,
        output: `Error: ${facts.refusal}${extra}`,
        metadata: metadataFor(action, "unsupported"),
      },
    };
  }
  const built = build(facts);
  if (typeof built === "string") {
    return {
      ok: false,
      result: { title: `${action} refused`, output: `Error: ${built}`, metadata: metadataFor(action, "none") },
    };
  }
  return { ok: true, plan: built };
}

/** The dry-run report: the resolved spawn vector, and nothing executed. */
function dryRunResult(action: ActionName, plan: ComputerPlan): ToolResult {
  const vector = spawnVectorFor(plan, process.env);
  const report: Record<string, unknown> = {
    argv: vector.argv,
    windowsVerbatimArguments: vector.windowsVerbatimArguments,
  };
  if (plan.script !== undefined) report.script = plan.script;
  return {
    title: `${action} (dry run)`,
    output: JSON.stringify(report),
    metadata: { ...metadataFor(action, plan.driver), dry_run: true },
  };
}

type Performed = { readonly ok: true; readonly output: string } | { readonly ok: false; readonly result: ToolResult };

async function performPlan(
  action: ActionName,
  plan: ComputerPlan,
  context: CanonicalToolContext,
  timeoutMs: number = DEFAULT_COMPUTER_TIMEOUT_MS,
): Promise<Performed> {
  const facts = getSystem().computerUse;
  const run = await runComputerPlan(plan, {
    env: process.env,
    timeoutMs,
    signal: context.abort,
    installHint: facts.supported ? facts.installHint : undefined,
  });
  if (!run.ok) {
    return {
      ok: false,
      result: { title: `${action} failed`, output: run.error, metadata: metadataFor(action, plan.driver) },
    };
  }
  return { ok: true, output: run.output };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Tools ────────────────────────────────────────────────────────────────────

/** `computer_screenshot` — capture the screen, one window or one region. */
export function createComputerScreenshotTool() {
  return defineTool({
    description:
      "Capture the screen, one window or one region as a PNG and return it as an image attachment. " +
      "The file is written under <worktree>/.rolebox/computer/ unless path is given. " +
      "macOS uses screencapture, Linux X11 import/scrot, Windows PowerShell System.Drawing. " +
      "window_id, region and display are mutually exclusive; use computer_windows to find a window id. " +
      "On macOS a region is exclusive with display too: a region is in global screen coordinates and already selects its own display, and screencapture ignores -D when -R is given. " +
      "A capture with no target covers ONE display (macOS: the main display), never a stitched image of every screen. " +
      "A retina capture is in device pixels: the result reports their ratio as metadata.pixel_scale, so divide image pixels by it before computer_click or computer_move, which take screen coordinates. " +
      "dry_run returns the exact command without executing it.",
    args: {
      window_id: z.number().int().positive().optional().describe("One window id from computer_windows"),
      region: z
        .object({
          x: z.number().describe("Left edge in absolute screen coordinates"),
          y: z.number().describe("Top edge in absolute screen coordinates"),
          w: z.number().positive().describe("Width in pixels"),
          h: z.number().positive().describe("Height in pixels"),
        })
        .optional()
        .describe("One rectangle of the screen, in absolute screen coordinates"),
      display: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Which display to capture: macOS -D is 1-based (1 = the main display, 2 the next), an X11 screen number, or a Windows AllScreens index"),
      path: z
        .string()
        .min(1)
        .optional()
        .describe("Absolute or worktree-relative PNG path; defaults to <worktree>/.rolebox/computer/<timestamp>-<seq>.png"),
      dry_run: DRY_RUN_ARG,
      timeout_ms: z.number().int().positive().optional().describe("Stop the capture after this many milliseconds (default 15000)"),
    },
    async execute(args, context) {
      const platform = getSystem().id;
      const target = args.path === undefined ? captureFilePath(context.worktree) : resolve(context.worktree, args.path);
      try {
        const prepared = prepare("screenshot", facts =>
          facts.capturePlan(
            { path: target, windowId: args.window_id, region: args.region, display: args.display },
            process.env,
          ),
        );
        if (!prepared.ok) return prepared.result;
        if (args.dry_run === true) return dryRunResult("screenshot", prepared.plan);

        ensureCaptureDirectory(dirname(target));
        const performed = await performPlan(
          "screenshot",
          prepared.plan,
          context,
          args.timeout_ms ?? DEFAULT_COMPUTER_TIMEOUT_MS,
        );
        if (!performed.ok) return performed.result;
        return captureResult(target, platform, prepared.plan.driver);
      } catch (error) {
        return {
          title: "Screenshot failed",
          output: `Error: computer_screenshot could not run: ${errorText(error)}`,
          metadata: metadataFor("screenshot", "none"),
        };
      }
    },
  });
}

/** One shared shape for the four input tools. */
async function runInput(
  action: ActionName,
  build: (facts: SupportedComputerUse) => ComputerPlanOrRefusal,
  context: CanonicalToolContext,
  dryRun: boolean | undefined,
  extraMetadata: Record<string, unknown>,
): Promise<ToolResult> {
  const prepared = prepare(action, build);
  if (!prepared.ok) return prepared.result;
  if (dryRun === true) return dryRunResult(action, prepared.plan);
  const performed = await performPlan(action, prepared.plan, context);
  if (!performed.ok) return performed.result;
  const detail = performed.output.length === 0 ? "" : `\n${performed.output}`;
  return {
    title: action,
    output: `${describeAction(action, extraMetadata)} (${prepared.plan.driver}).${detail}`,
    metadata: { ...metadataFor(action, prepared.plan.driver), ...extraMetadata },
  };
}

/** The one-sentence, model-facing description of a gesture that just ran. */
function describeAction(action: ActionName, metadata: Record<string, unknown>): string {
  switch (action) {
    case "click":
      return `Clicked ${String(metadata.button)} x${String(metadata.clicks)} at ${String(metadata.x)},${String(metadata.y)}`;
    case "move":
      return `Moved the pointer to ${String(metadata.x)},${String(metadata.y)}`;
    case "type":
      // The text itself is never echoed back: it may be a password.
      return `Typed ${String(metadata.characters)} character(s) into the focused window`;
    case "key":
      return `Pressed ${(metadata.keys as readonly string[]).join("+")}`;
    default:
      return `Ran ${action}`;
  }
}

/** `computer_windows` — list the windows this OS can address. */
export function createComputerWindowsTool() {
  return defineTool({
    description:
      "List the visible windows with the id this OS uses for window capture and input: " +
      "the macOS window number, an X11 window id, or a Windows MainWindowHandle. " +
      "One line per window: on macOS and Windows id, process or owner, title; on X11 the id and the title. " +
      "On macOS this reads the window server's own list, so the ids are real CGWindowIDs that screencapture -l " +
      "accepts, with no Accessibility grant; window titles need Screen Recording and are empty without it. " +
      "The app filter is a case-insensitive substring of the owner's name on macOS, the title on X11 or the " +
      "process name or title on Windows; a filter that matches nothing is an error on macOS and an empty " +
      "listing elsewhere. dry_run returns the exact command without executing it.",
    args: {
      app: z.string().min(1).optional().describe("Only windows whose application name matches this text"),
      dry_run: DRY_RUN_ARG,
    },
    async execute(args, context) {
      const request: ComputerInputRequest = { action: "windows", app: args.app };
      const prepared = prepare("windows", facts => facts.inputPlan(request, process.env));
      if (!prepared.ok) return prepared.result;
      if (args.dry_run === true) return dryRunResult("windows", prepared.plan);
      const performed = await performPlan("windows", prepared.plan, context);
      if (!performed.ok) return performed.result;
      const lines = performed.output.split(/\r?\n/).filter(line => line.trim().length > 0);
      return {
        title: "windows",
        output: lines.length === 0 ? "No visible windows were listed." : lines.join("\n"),
        metadata: { ...metadataFor("windows", prepared.plan.driver), count: lines.length },
      };
    },
  });
}

/** `computer_click` — press a mouse button at a screen position. */
export function createComputerClickTool() {
  return defineTool({
    description:
      "Click a mouse button at absolute screen coordinates, optionally targeting one X11 window. " +
      "Darwin uses System Events for a left click and the cliclick helper for a right or middle click; " +
      "Linux X11 uses xdotool; Windows uses mouse_event through PowerShell. " +
      "dry_run returns the exact command without executing it.",
    args: {
      x: z.number().describe("Absolute screen x coordinate"),
      y: z.number().describe("Absolute screen y coordinate"),
      button: z.enum(["left", "right", "middle"]).optional().default("left").describe("Mouse button (default left)"),
      clicks: z.union([z.literal(1), z.literal(2)]).optional().default(1).describe("Click count: 1 or 2 (default 1)"),
      window_id: z.number().int().positive().optional().describe("One window id from computer_windows (X11 only)"),
      dry_run: DRY_RUN_ARG,
    },
    async execute(args, context) {
      // The schema's defaults are applied by the host's own arg parsing, but the
      // tool still owns the request it builds: an omitted button is a left
      // click here too, never an undefined one a driver would refuse.
      const button = args.button ?? "left";
      const clicks = args.clicks ?? 1;
      const request: ComputerInputRequest = {
        action: "click",
        x: args.x,
        y: args.y,
        button,
        clicks,
        windowId: args.window_id,
      };
      const extra = { x: Math.round(args.x), y: Math.round(args.y), button, clicks };
      return await runInput("click", facts => facts.inputPlan(request, process.env), context, args.dry_run, extra);
    },
  });
}

/** `computer_move` — move the pointer without clicking. */
export function createComputerMoveTool() {
  return defineTool({
    description:
      "Move the mouse pointer to absolute screen coordinates without clicking. " +
      "Darwin uses the cliclick helper, Linux X11 uses xdotool, Windows uses SetCursorPos through PowerShell. " +
      "dry_run returns the exact command without executing it.",
    args: {
      x: z.number().describe("Absolute screen x coordinate"),
      y: z.number().describe("Absolute screen y coordinate"),
      dry_run: DRY_RUN_ARG,
    },
    async execute(args, context) {
      const request: ComputerInputRequest = { action: "move", x: args.x, y: args.y };
      return await runInput(
        "move",
        facts => facts.inputPlan(request, process.env),
        context,
        args.dry_run,
        { x: Math.round(args.x), y: Math.round(args.y) },
      );
    },
  });
}

/** `computer_type` — type text into the focused window. */
export function createComputerTypeTool() {
  return defineTool({
    description:
      "Type text into the focused window, one keystroke at a time. " +
      "Darwin uses System Events keystroke, Linux X11 uses xdotool type, Windows uses SendKeys. " +
      "The text is never echoed back in the result. dry_run returns the exact command without executing it.",
    args: {
      text: z.string().min(1).describe("Text to type; a newline presses Return"),
      window_id: z.number().int().positive().optional().describe("One window id from computer_windows (X11 only)"),
      dry_run: DRY_RUN_ARG,
    },
    async execute(args, context) {
      const request: ComputerInputRequest = { action: "type", text: args.text, windowId: args.window_id };
      return await runInput(
        "type",
        facts => facts.inputPlan(request, process.env),
        context,
        args.dry_run,
        { characters: [...args.text].length },
      );
    },
  });
}

/** `computer_key` — press one key, or one key with modifiers. */
export function createComputerKeyTool() {
  return defineTool({
    description:
      "Press one key, or one key held with modifiers: keys is modifiers first and the key last, " +
      'for example ["cmd", "shift", "t"] or ["Return"]. ' +
      "Darwin uses System Events key code/keystroke, Linux X11 uses xdotool key, Windows uses SendKeys. " +
      "dry_run returns the exact command without executing it.",
    args: {
      keys: z.array(z.string().min(1)).min(1).describe('Modifiers then the key, e.g. ["ctrl", "shift", "t"]'),
      window_id: z.number().int().positive().optional().describe("One window id from computer_windows (X11 only)"),
      dry_run: DRY_RUN_ARG,
    },
    async execute(args, context) {
      const request: ComputerInputRequest = { action: "key", keys: args.keys, windowId: args.window_id };
      return await runInput(
        "key",
        facts => facts.inputPlan(request, process.env),
        context,
        args.dry_run,
        { keys: args.keys },
      );
    },
  });
}

/**
 * Read the permission probe's own answer.
 *
 * The three probes answer in two different ways: `darwin` prints a bare boolean
 * (`tell application "System Events" to return UI elements enabled`), while
 * `linux` and `win32` print a prose sentence and report a refusal through a
 * non-zero exit, which `runComputerPlan` turns into `run.error` before this rule
 * is reached. Only the two refusal tokens therefore mean "not permitted"; every
 * other answer — including an empty one — is read as a grant.
 */
export function permissionVerdict(output: string): boolean {
  return !/^(false|no)$/i.test(output.trim());
}

/**
 * The refusal the family returns when the probe reports no permission.
 *
 * `hint` is the plan's own remediation text ({@link ComputerPlan.permissionHint});
 * the generic sentence stands in for a driver that declares none.
 */
export function permissionRefusal(driver: string, hint: string | undefined): ToolResult {
  return {
    title: "permissions",
    output:
      `Error: ${driver} reports that input is not permitted; ` +
      (hint ?? "grant this process the permission its system requires and try again."),
    metadata: { ...metadataFor("permissions", driver), granted: false },
  };
}

/** `computer_permissions` — report whether this OS will accept input. */
export function createComputerPermissionsTool() {
  return defineTool({
    description:
      "Report whether this system will accept synthesized input right now, and name the permission to grant when it will not. " +
      "macOS answers whether Accessibility UI scripting is enabled, Linux X11 whether the session and xdotool allow input, " +
      "Windows whether the session is interactive. dry_run returns the exact probe command without executing it.",
    args: { dry_run: DRY_RUN_ARG },
    async execute(args, context) {
      const prepared = prepare("permissions", facts => facts.permissionProbe());
      if (!prepared.ok) return prepared.result;
      if (args.dry_run === true) return dryRunResult("permissions", prepared.plan);

      const facts = getSystem().computerUse;
      const run = await runComputerPlan(prepared.plan, {
        env: process.env,
        timeoutMs: DEFAULT_COMPUTER_TIMEOUT_MS,
        signal: context.abort,
        installHint: facts.supported ? facts.installHint : undefined,
      });
      const driver = prepared.plan.driver;
      if (!run.ok) {
        return {
          title: "permissions",
          output: run.error,
          metadata: { ...metadataFor("permissions", driver), granted: false },
        };
      }
      const granted = permissionVerdict(run.output);
      if (!granted) return permissionRefusal(driver, prepared.plan.permissionHint);
      return {
        title: "permissions",
        output: run.output.length === 0 ? "Input is permitted on this system." : run.output,
        metadata: { ...metadataFor("permissions", driver), granted: true },
      };
    },
  });
}

/**
 * The seven computer-use tools, keyed by the names the tool surface uses.
 *
 * `buildCanonicalTools` merges this record only when `computerUse: true`, so
 * the default surface stays exactly what it was before this family existed.
 */
export function createComputerTools(): Record<string, CanonicalToolDef> {
  return {
    computer_screenshot: createComputerScreenshotTool(),
    computer_windows: createComputerWindowsTool(),
    computer_click: createComputerClickTool(),
    computer_move: createComputerMoveTool(),
    computer_type: createComputerTypeTool(),
    computer_key: createComputerKeyTool(),
    computer_permissions: createComputerPermissionsTool(),
  };
}
