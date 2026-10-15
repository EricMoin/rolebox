/**
 * The computer-use tools — rolebox's own screen-driving family.
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
import { chmodSync } from "node:fs";
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
import { DEFAULT_COMPUTER_TIMEOUT_MS, helperAvailable, runComputerPlan, spawnVectorFor } from "./exec.ts";
import { computerOperationQueue } from "./queue.ts";

/** The action names every result reports in `metadata.action`. */
type ActionName = ComputerInputRequest["action"] | "screenshot" | "permissions" | "status";

const DRY_RUN_ARG = z
  .boolean()
  .optional()
  .describe("Return the exact spawn plan as JSON and execute nothing (the test seam)");

const TIMEOUT_ARG = z.number().int().min(1).max(120_000).optional()
  .describe("Total time limit including the desktop queue (default 15000ms, maximum 120000ms)");

function defineComputerTool<Args extends z.ZodRawShape>(action: ActionName, definition: CanonicalToolDef<Args>): CanonicalToolDef<Args> {
  const schema = z.object(definition.args);
  return defineTool({
    ...definition,
    async execute(input, context) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        return {
          title: `${action} refused`,
          output: `Error: invalid computer_${action} arguments: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
          metadata: { ...metadataFor(action, "none"), error: true },
        };
      }
      const args = parsed.data;
      const options = args as { dry_run?: boolean; timeout_ms?: number };
      const controller = new AbortController();
      let timedOut = false;
      const timeoutMs = options.timeout_ms ?? DEFAULT_COMPUTER_TIMEOUT_MS;
      const onAbort = () => controller.abort();
      if (context.abort.aborted) controller.abort();
      else context.abort.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        const operation = () => definition.execute(args, { ...context, abort: controller.signal });
        const result = options.dry_run === true
          ? await operation()
          : await computerOperationQueue.run(operation, controller.signal);
        if (timedOut) {
          const detail = typeof result === "string" ? result : result.output;
          return {
            title: `${action} failed`,
            output: `Error: computer_${action} exceeded ${timeoutMs}ms and was stopped.${detail.startsWith("Error:") ? ` ${detail}` : ""}`,
            metadata: { ...(typeof result === "string" ? metadataFor(action, "none") : result.metadata), error: true, timed_out: true },
          };
        }
        return result;
      } catch (error) {
        return {
          title: `${action} failed`,
          output: `Error: ${timedOut ? `computer_${action} exceeded ${timeoutMs}ms and was stopped.` : errorText(error)}`,
          metadata: { ...metadataFor(action, "none"), error: true, cancelled: controller.signal.aborted, timed_out: timedOut },
        };
      } finally {
        clearTimeout(timer);
        context.abort.removeEventListener("abort", onAbort);
      }
    },
  });
}

const REQUEST_ARG = z
  .boolean()
  .optional()
  .describe(
    "Ask the OS to show its own permission prompt (macOS Accessibility dialog) instead of only reporting the status",
  );

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
  if (plan.cleanupPlan !== undefined) {
    const cleanup = spawnVectorFor(plan.cleanupPlan, process.env);
    report.cleanup = { ...cleanup, script: plan.cleanupPlan.script };
  }
  const facts = getSystem().computerUse;
  if ((action === "screenshot" || action === "permissions") && facts.supported && facts.capturePermissionProbe !== undefined) {
    const probe = facts.capturePermissionProbe();
    report.capture_permission_probe = typeof probe === "string" ? { refusal: probe }
      : { ...spawnVectorFor(probe, process.env), script: probe.script };
  }
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
  timeoutMs: number = 120_000,
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

interface CapturePermission {
  checked: boolean;
  granted?: boolean;
  error?: string;
}

async function capturePermission(facts: SupportedComputerUse, context: CanonicalToolContext): Promise<CapturePermission> {
  if (facts.capturePermissionProbe === undefined) return { checked: false };
  const plan = facts.capturePermissionProbe();
  if (typeof plan === "string") return { checked: false, error: plan };
  const run = await runComputerPlan(plan, { signal: context.abort, timeoutMs: 120_000, installHint: facts.installHint });
  return run.ok ? { checked: true, granted: permissionVerdict(run.output) } : { checked: false, error: run.error };
}

function withCapturePermission(result: ToolResult, permission: CapturePermission): ToolResult {
  const status = permission.checked ? permission.granted ? "permitted" : "not permitted" : "not verified";
  const structured = typeof result === "string" ? { output: result } : result;
  return {
    ...structured,
    output: `${structured.output}\nScreen capture permission: ${status}.${permission.error ? ` ${permission.error}` : ""}`,
    metadata: { ...structured.metadata, screen_capture: permission },
  };
}

// ── Tools ────────────────────────────────────────────────────────────────────

/** `computer_screenshot` — capture the screen, one window or one region. */
export function createComputerScreenshotTool() {
  return defineComputerTool("screenshot", {
    description:
      "Capture the screen, one window or one region as a PNG and return it as an image attachment. " +
      "The file is written under <worktree>/.rolebox/computer/ unless path is given. " +
      "macOS uses screencapture, Linux X11 import/scrot, Windows PowerShell System.Drawing. " +
      "window_id, region and display are mutually exclusive; use computer_windows to find a window id. " +
      "On macOS a region is exclusive with display too: a region is in global screen coordinates and already selects its own display, and screencapture ignores -D when -R is given. " +
      "A capture with no target covers ONE display (macOS: the main display), never a stitched image of every screen. " +
      "Input uses absolute screen coordinates. Convert image pixels using metadata.pixel_scale and add metadata.origin; when origin is unknown, locate the window or display before clicking. " +
      "dry_run returns the exact command without executing it.",
    args: {
      window_id: z.number().int().positive().optional().describe("One window id from computer_windows"),
      region: z
        .object({
          x: z.number().describe("Left edge in absolute screen coordinates"),
          y: z.number().describe("Top edge in absolute screen coordinates"),
          w: z.number().positive().describe("Width in screen coordinates"),
          h: z.number().positive().describe("Height in screen coordinates"),
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
      timeout_ms: TIMEOUT_ARG,
    },
    async execute(args, context) {
      if ([args.window_id, args.region, args.display].filter(value => value !== undefined).length > 1) {
        return {
          title: "screenshot refused",
          output: "Error: select one screenshot target: window_id, region or display, not both or multiple targets.",
          metadata: metadataFor("screenshot", "none"),
        };
      }
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

        const facts = getSystem().computerUse;
        if (facts.supported && facts.capturePermissionProbe !== undefined) {
          const permission = await capturePermission(facts, context);
          if (permission.granted !== true) return {
            title: "Screenshot refused",
            output: `Error: Screen Recording permission is not granted or could not be verified. Grant the host application Screen Recording access in System Settings and retry.${permission.error ? ` ${permission.error}` : ""}`,
            metadata: { ...metadataFor("screenshot", prepared.plan.driver), screen_capture: permission },
          };
        }

        ensureCaptureDirectory(dirname(target), args.path === undefined);
        const performed = await performPlan(
          "screenshot",
          prepared.plan,
          context,
          args.timeout_ms ?? DEFAULT_COMPUTER_TIMEOUT_MS,
        );
        if (!performed.ok) return performed.result;
        chmodSync(target, 0o600);
        return captureResult(target, platform, prepared.plan.driver, {
          windowId: args.window_id, region: args.region, display: args.display,
        });
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
    case "focus":
      return `Focused window ${String(metadata.window_id)}`;
    case "scroll":
      return `Scrolled ${String(metadata.direction)} by ${String(metadata.amount)} wheel ticks`;
    case "drag":
      return `Dragged from ${String(metadata.from_x)},${String(metadata.from_y)} to ${String(metadata.to_x)},${String(metadata.to_y)}`;
    default:
      return `Ran ${action}`;
  }
}

/** `computer_windows` — list the windows this OS can address. */
export function createComputerWindowsTool() {
  return defineComputerTool("windows", {
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
      timeout_ms: TIMEOUT_ARG,
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
  return defineComputerTool("click", {
    description:
      "Click a mouse button at absolute screen coordinates, optionally targeting one X11 window. " +
      "Darwin uses native Quartz mouse events for left, right and middle clicks; " +
      "Linux X11 uses xdotool; Windows uses mouse_event through PowerShell. " +
      "dry_run returns the exact command without executing it.",
    args: {
      x: z.number().describe("Absolute screen x coordinate"),
      y: z.number().describe("Absolute screen y coordinate"),
      button: z.enum(["left", "right", "middle"]).optional().default("left").describe("Mouse button (default left)"),
      clicks: z.union([z.literal(1), z.literal(2)]).optional().default(1).describe("Click count: 1 or 2 (default 1)"),
      window_id: z.number().int().positive().optional().describe("One window id from computer_windows (X11 only)"),
      dry_run: DRY_RUN_ARG,
      timeout_ms: TIMEOUT_ARG,
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
  return defineComputerTool("move", {
    description:
      "Move the mouse pointer to absolute screen coordinates without clicking. " +
      "Darwin uses native Quartz mouse events, Linux X11 uses xdotool, Windows uses SetCursorPos through PowerShell. " +
      "dry_run returns the exact command without executing it.",
    args: {
      x: z.number().describe("Absolute screen x coordinate"),
      y: z.number().describe("Absolute screen y coordinate"),
      dry_run: DRY_RUN_ARG,
      timeout_ms: TIMEOUT_ARG,
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
  return defineComputerTool("type", {
    description:
      "Type text into the focused window. " +
      "Darwin uses Quartz Unicode keyboard events, Linux X11 uses xdotool type, Windows uses SendKeys. " +
      "Execution results omit the text; dry_run includes the exact command and therefore the text. Do not dry-run secrets.",
    args: {
      text: z.string().min(1).describe("Text to type; a newline presses Return"),
      window_id: z.number().int().positive().optional().describe("One window id from computer_windows (X11 only)"),
      dry_run: DRY_RUN_ARG,
      timeout_ms: TIMEOUT_ARG,
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
  return defineComputerTool("key", {
    description:
      "Press one key, or one key held with modifiers: keys is modifiers first and the key last, " +
      'for example ["cmd", "shift", "t"] or ["Return"]. ' +
      "Darwin uses System Events key code/keystroke, Linux X11 uses xdotool key, Windows uses SendKeys. " +
      "dry_run returns the exact command without executing it.",
    args: {
      keys: z.array(z.string().min(1)).min(1).describe('Modifiers then the key, e.g. ["ctrl", "shift", "t"]'),
      window_id: z.number().int().positive().optional().describe("One window id from computer_windows (X11 only)"),
      dry_run: DRY_RUN_ARG,
      timeout_ms: TIMEOUT_ARG,
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

const DISPLAY_SCHEMA = z.object({
  id: z.number().int().nonnegative(),
  x: z.number(), y: z.number(),
  width: z.number().positive(), height: z.number().positive(),
  scale: z.number().positive(), primary: z.boolean(),
});

export function createComputerDisplaysTool() {
  return defineComputerTool("displays", {
    description: "List displays as JSON with screenshot display ids, screen-coordinate bounds, scale and primary flag. " +
      "macOS ids start at 1; Windows and X11 screen ids start at 0. X11 screens are separate coordinate spaces, not RandR monitors. " +
      "Use the display origin when converting screenshot pixels to absolute input coordinates. " +
      "X11 input remains on the host's DISPLAY screen; restart the host with the target DISPLAY to control a different X screen.",
    args: { dry_run: DRY_RUN_ARG, timeout_ms: TIMEOUT_ARG },
    async execute(args, context) {
      const prepared = prepare("displays", facts => facts.inputPlan({ action: "displays" }, process.env));
      if (!prepared.ok) return prepared.result;
      if (args.dry_run) return dryRunResult("displays", prepared.plan);
      const performed = await performPlan("displays", prepared.plan, context, args.timeout_ms);
      if (!performed.ok) return performed.result;
      const displays = z.array(DISPLAY_SCHEMA).min(1).parse(JSON.parse(performed.output));
      return {
        title: "displays", output: JSON.stringify(displays),
        metadata: { ...metadataFor("displays", prepared.plan.driver), displays, count: displays.length },
      };
    },
  });
}

export function createComputerFocusTool() {
  return defineComputerTool("focus", {
    description: "Bring one window from computer_windows to the foreground and verify focus. " +
      "Fails when the OS refuses focus or cannot uniquely identify the target. Take a screenshot after focusing before input.",
    args: {
      window_id: z.number().int().positive(), dry_run: DRY_RUN_ARG, timeout_ms: TIMEOUT_ARG,
    },
    async execute(args, context) {
      return runInput("focus", facts => facts.inputPlan({ action: "focus", windowId: args.window_id }, process.env),
        context, args.dry_run, { window_id: args.window_id });
    },
  });
}

export function createComputerScrollTool() {
  return defineComputerTool("scroll", {
    description: "Scroll up, down, left or right by 1–100 wheel ticks (default 3). " +
      "Optionally move the pointer to absolute screen coordinates first; supply both x and y. " +
      "The application decides how far each tick scrolls; observe a screenshot afterward.",
    args: {
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().int().min(1).max(100).optional().default(3),
      x: z.number().optional(), y: z.number().optional(),
      dry_run: DRY_RUN_ARG, timeout_ms: TIMEOUT_ARG,
    },
    async execute(args, context) {
      const request: ComputerInputRequest = { action: "scroll", direction: args.direction, amount: args.amount ?? 3, x: args.x, y: args.y };
      return runInput("scroll", facts => facts.inputPlan(request, process.env), context, args.dry_run,
        { direction: request.direction, amount: request.amount });
    },
  });
}

export function createComputerDragTool() {
  return defineComputerTool("drag", {
    description: "Drag with the left mouse button between two absolute screen positions over 100–5000ms (default 500ms). " +
      "Take a screenshot before choosing coordinates and another afterward to verify the result.",
    args: {
      from_x: z.number(), from_y: z.number(), to_x: z.number(), to_y: z.number(),
      duration_ms: z.number().int().min(100).max(5000).optional().default(500),
      dry_run: DRY_RUN_ARG, timeout_ms: TIMEOUT_ARG,
    },
    async execute(args, context) {
      const request: ComputerInputRequest = {
        action: "drag", fromX: args.from_x, fromY: args.from_y, toX: args.to_x, toY: args.to_y,
        durationMs: args.duration_ms ?? 500,
      };
      return runInput("drag", facts => facts.inputPlan(request, process.env), context, args.dry_run,
        { from_x: args.from_x, from_y: args.from_y, to_x: args.to_x, to_y: args.to_y, duration_ms: request.durationMs });
    },
  });
}

export function createComputerStatusTool() {
  return defineComputerTool("status", {
    description: "Diagnose desktop CUA without taking screenshots or injecting input. Reports the platform, helper availability, " +
      "operation plans/refusals and current input permission. A planned operation is not proof it will succeed. " +
      "Screen Recording is probed separately where the OS exposes a probe; a valid screenshot alone does not prove that permission. No permission prompt is opened. " +
      "dry_run inspects plans only, without probing the filesystem or running commands.",
    args: { dry_run: DRY_RUN_ARG, timeout_ms: TIMEOUT_ARG },
    async execute(args, context) {
      const facts = getSystem().computerUse;
      if (!facts.supported) return {
        title: "status", output: `Error: ${facts.refusal}`,
        metadata: { ...metadataFor("status", "unsupported"), supported: false },
      };
      const inputs: ComputerInputRequest[] = [
        { action: "windows" }, { action: "displays" }, { action: "focus", windowId: 1 },
        { action: "click", x: 0, y: 0, button: "left", clicks: 1 }, { action: "move", x: 0, y: 0 },
        { action: "type", text: "example" }, { action: "key", keys: ["Return"] },
        { action: "scroll", direction: "down", amount: 3 },
        { action: "drag", fromX: 0, fromY: 0, toX: 1, toY: 1, durationMs: 500 },
      ];
      const plans: Array<[string, ComputerPlanOrRefusal]> = [
        ["screenshot", facts.capturePlan({ path: captureFilePath(context.worktree) }, process.env)],
        ...inputs.map(request => [request.action, facts.inputPlan(request, process.env)] as [string, ComputerPlanOrRefusal]),
      ];
      const operations = Object.fromEntries(plans.map(([action, plan]) => [action, typeof plan === "string"
        ? { planned: false, reason: plan }
        : { planned: true, driver: plan.driver, requires: plan.requires }]));
      const helpers = args.dry_run ? undefined : Object.fromEntries(facts.requiredBinaries.map(name => [name, helperAvailable(name)]));
      const probe = facts.permissionProbe();
      let permission: Record<string, unknown> = { checked: false };
      if (!args.dry_run) {
        if (typeof probe === "string") permission = { checked: false, granted: false, error: probe };
        else {
          const result = await runComputerPlan(probe, { signal: context.abort, timeoutMs: args.timeout_ms, installHint: facts.installHint });
          permission = result.ok
            ? { checked: true, granted: facts.readsProbeOutput ? permissionVerdict(result.output) : true }
            : { checked: false, granted: false, error: result.error };
        }
      }
      const report = {
        platform: getSystem().id, supported: true, operations, helpers, input_permission: permission,
        screen_capture: args.dry_run ? { checked: false } : await capturePermission(facts, context),
        install_hint: facts.installHint, serialization: "Operations are serialized within this host process; other applications and host processes can still change the desktop.",
      };
      return {
        title: "status", output: JSON.stringify(report),
        metadata: { ...metadataFor("status", "diagnostic"), ...report, dry_run: args.dry_run === true },
      };
    },
  });
}

/**
 * The one machine token a token-printing probe prints for a grant.
 *
 * A probe whose output is read ({@link SupportedComputerUse.readsProbeOutput})
 * prints exactly this token; every other answer is not a grant.
 */
export const PROBE_GRANTED_TOKEN = "granted";

/**
 * Read a token-printing probe's own answer, fail closed.
 *
 * A probe whose output is read — darwin's — prints exactly one machine token,
 * and only {@link PROBE_GRANTED_TOKEN} (case- and whitespace-insensitive) is a
 * grant. An empty answer, a sentence this family has never seen, an unrelated
 * preference such as `UI elements enabled`, and an answer that could not be
 * read all mean NOT permitted: a probe that cannot be read must never report
 * permission. Probes whose output is not read (linux, win32) never reach this
 * rule — there a successful exit is itself the grant, and their prose output is
 * for the caller.
 */
export function permissionVerdict(output: string): boolean {
  return output.trim().toLowerCase() === PROBE_GRANTED_TOKEN;
}

/** The first non-empty line of a probe's answer, trimmed, or the empty string. */
function firstAnswerLine(text: string): string {
  return text.split(/\r?\n/).find(line => line.trim().length > 0)?.trim() ?? "";
}

/** What a refused run adds to the refusal sentence. */
export interface PermissionRefusalDetail {
  /** The probe's raw output, quoted when it is non-empty. */
  readonly answer?: string;
  /** Whether this call actually ran the OS prompt plan. */
  readonly requested?: boolean;
}

/**
 * The refusal the family returns when the probe reports no permission.
 *
 * `hint` is the plan's own remediation text ({@link ComputerPlan.permissionHint});
 * the generic sentence stands in for a driver that declares none. A non-empty
 * probe answer is quoted verbatim as its own one-line answer, so the caller
 * reads what the probe actually said instead of a paraphrase. When the caller
 * asked the OS for the grant (`detail.requested`), the sentence says macOS has
 * been asked to show its Accessibility dialog, that the prompt appears once per
 * application, and the order to follow: approve it (or use the System Settings
 * pane the hint names), restart the host, then call `computer_permissions`
 * again.
 */
export function permissionRefusal(
  driver: string,
  hint: string | undefined,
  detail: PermissionRefusalDetail = {},
): ToolResult {
  const answer = detail.answer === undefined ? "" : firstAnswerLine(detail.answer);
  const answered = answer.length === 0 ? "" : ` The probe answered: ${answer}.`;
  const requested =
    detail.requested === true
      ? " macOS has been asked to show its Accessibility dialog, which appears once per application: approve it (or grant this process in the System Settings pane named above), restart the host, then call computer_permissions again."
      : "";
  return {
    title: "permissions",
    output:
      `Error: ${driver} reports that input is not permitted; ` +
      (hint ?? "grant this process the permission its system requires and try again.") +
      answered +
      requested,
    metadata: { ...metadataFor("permissions", driver), granted: false },
  };
}

/**
 * `computer_permissions` — report whether this OS reports input as permitted,
 * and ask the OS for the grant when the caller asks for it.
 */
export function createComputerPermissionsTool() {
  return defineComputerTool("permissions", {
    description:
      "Report whether this system's input permission is granted to this process right now, and name the permission to grant when it is not. " +
      "The answer is the permission state the OS reports for this process, never a guess or a machine-wide preference: on macOS it reads this process's own TCC Accessibility trust, Linux X11 whether the session and xdotool allow input, Windows whether the session is interactive. " +
      "request: true asks the OS itself to show its permission dialog — macOS shows the system Accessibility prompt and registers the app in System Settings — instead of only reporting the status; a system with no requestable grant ignores it. " +
      "The host process must be restarted after a grant is approved. " +
      "dry_run returns the exact command without executing it, and shows the request command without showing any dialog.",
    args: {
      dry_run: DRY_RUN_ARG,
      timeout_ms: TIMEOUT_ARG,
      request: REQUEST_ARG,
    },
    async execute(args, context) {
      const facts = getSystem().computerUse;
      const wantsPrompt = args.request === true;
      const prepared = prepare("permissions", loaded =>
        wantsPrompt && loaded.permissionPrompt !== undefined ? loaded.permissionPrompt() : loaded.permissionProbe(),
      );
      if (!prepared.ok) return prepared.result;
      if (args.dry_run === true) return dryRunResult("permissions", prepared.plan);

      // Whether request: true really selected an OS prompt plan: on a system
      // that declares none the request is ignored and the probe runs instead.
      const ranPrompt = wantsPrompt && facts.supported && facts.permissionPrompt !== undefined;
      const run = await runComputerPlan(prepared.plan, {
        env: process.env,
        timeoutMs: args.timeout_ms ?? DEFAULT_COMPUTER_TIMEOUT_MS,
        signal: context.abort,
        installHint: facts.supported ? facts.installHint : undefined,
      });
      const driver = prepared.plan.driver;
      const screenCapture = facts.supported ? await capturePermission(facts, context) : { checked: false };
      if (!run.ok) {
        return withCapturePermission({
          title: "permissions",
          output: run.error,
          metadata: { ...metadataFor("permissions", driver), granted: false },
        }, screenCapture);
      }
      // Read the answer by the driver's own rule: darwin's probe prints a
      // machine token and ONLY the exact token is a grant, while a successful
      // exit on linux and win32 IS the grant and their prose is for the caller.
      const readsProbeOutput = facts.supported && facts.readsProbeOutput === true;
      const granted = readsProbeOutput ? permissionVerdict(run.output) : true;
      if (!granted) {
        return withCapturePermission(permissionRefusal(driver, prepared.plan.permissionHint, { answer: run.output, requested: ranPrompt }), screenCapture);
      }
      const metadata: Record<string, unknown> = { ...metadataFor("permissions", driver), granted: true };
      if (ranPrompt) metadata.permission_requested = true;
      return withCapturePermission({
        title: "permissions",
        // A granted token-printing probe answers with one sentence, never by
        // echoing its own raw `granted` marker back as if it were prose.
        output: readsProbeOutput
          ? "Input is permitted on this system."
          : run.output.length === 0
            ? "Input is permitted on this system."
            : run.output,
        metadata,
      }, screenCapture);
    },
  });
}

/**
 * The computer-use tools, keyed by the names the tool surface uses.
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
    computer_displays: createComputerDisplaysTool(),
    computer_focus: createComputerFocusTool(),
    computer_scroll: createComputerScrollTool(),
    computer_drag: createComputerDragTool(),
    computer_status: createComputerStatusTool(),
  };
}
