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
 * when the resolved `computerUse` gate permits registration.
 */

import { dirname, resolve } from "node:path";
import { chmodSync, existsSync } from "node:fs";
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
import { COMPUTER_DISPLAY_SCHEMA, computerScreenshots, parseCaptureGeometry } from "./geometry.ts";
import { permissionRecovery, PERMISSION_REQUEST_GUIDANCE, PERMISSION_USER_GUIDANCE } from "./permissions.ts";

/** The action names every result reports in `metadata.action`. */
type ActionName = ComputerInputRequest["action"] | "screenshot" | "permissions" | "status";

const DRY_RUN_ARG = z
  .boolean()
  .optional()
  .describe("Return the exact spawn plan as JSON and execute nothing (the test seam)");

const TIMEOUT_ARG = z.number().int().min(1).max(120_000).optional()
  .describe("Total time limit including the desktop queue (default 15000ms, maximum 120000ms)");

const INPUT_WINDOW_ARG = z.number().int().positive().optional()
  .describe("Window id to focus and verify before input on macOS, Windows or X11; omitted uses the current desktop focus. With screenshot_id the captured window is selected automatically; an explicit ID must match it.");

const SCREENSHOT_ARG = z.string().min(1).optional()
  .describe("ID from a recent screenshot in this session. Coordinates then use image pixels and are mapped to the screen automatically. The captured window is focused; changed window geometry or display layout refuses input and requires a fresh screenshot.");

function windowMetadata(windowId: number | undefined): Record<string, unknown> {
  return windowId === undefined ? {} : { window_id: windowId };
}

function pointerRequest<T extends Extract<ComputerInputRequest, { action: "click" | "move" | "scroll" | "drag" }>>(
  request: T, screenshotId: string | undefined, context: CanonicalToolContext,
): T {
  return screenshotId === undefined ? request : computerScreenshots.map(screenshotId, request, {
    sessionID: context.sessionID, worktree: context.worktree, platform: getSystem().id,
  }) as T;
}

function pointerMetadata(request: Extract<ComputerInputRequest, { action: "click" | "move" | "scroll" | "drag" }>, screenshotId: string | undefined): Record<string, unknown> {
  return { ...windowMetadata(request.windowId), ...(screenshotId === undefined ? {} : { screenshot_id: screenshotId }) };
}

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
    "Request currently missing macOS Accessibility and Screen Recording permissions, then probe again. Requests require user approval and may require restarting the host; false/omitted only probes. Other systems expose diagnostics without an OS prompt.",
  );

// ── Result plumbing ──────────────────────────────────────────────────────────

function metadataFor(action: ActionName, driver: string): Record<string, unknown> {
  return { platform: getSystem().id, driver, action };
}

type Prepared = { readonly ok: true; readonly plan: ComputerPlan } | { readonly ok: false; readonly result: Exclude<ToolResult, string> };

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
function dryRunResult(action: ActionName, plan: ComputerPlan): Exclude<ToolResult, string> {
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

type Performed = { readonly ok: true; readonly output: string; readonly stdout: string } | { readonly ok: false; readonly result: Exclude<ToolResult, string> };

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
      result: {
        title: `${action} failed`,
        output: run.error + (run.permission === undefined ? "" : ` ${PERMISSION_REQUEST_GUIDANCE}`),
        metadata: { ...metadataFor(action, plan.driver), ...(run.permission === undefined ? {} : { ...permissionRecovery(), permission: run.permission }) },
      },
    };
  }
  return { ok: true, output: run.output, stdout: run.stdout };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface CapturePermission {
  checked: boolean;
  granted?: boolean;
  error?: string;
  requested?: boolean;
  request_error?: string;
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
      "macOS uses screencapture with native geometry verification, Linux X11 import/scrot, Windows PowerShell System.Drawing. " +
      "window_id, region and display are mutually exclusive; use computer_windows to find a window id. " +
      "A capture with no target covers ONE display (macOS: the main display), never a stitched image of every screen. " +
      "Returns screenshot_id, screen bounds, origin and per-axis pixel scales. Pass screenshot_id to pointer tools to use image pixels with automatic mapping and stale-geometry checks. " +
      "A region may span monitors with different UI scaling; the image uses a uniform mapping. Capture fails if window geometry or the display layout changes during capture. " +
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
        .describe("Display id returned by computer_displays on the current desktop; refresh after changing the display layout"),
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
            output: permission.checked
              ? `Error: Screen Recording permission is not granted. ${PERMISSION_REQUEST_GUIDANCE}`
              : `Error: Screen Recording permission could not be verified. Call computer_permissions({}) to diagnose the probe before retrying.${permission.error ? ` ${permission.error}` : ""}`,
            metadata: {
              ...metadataFor("screenshot", prepared.plan.driver), screen_capture: permission,
              ...(permission.checked ? { ...permissionRecovery(), permission: "screen_capture" } : {
                error: true, error_code: "permission_unverified", next_action: { tool: "computer_permissions", args: {} },
              }),
            },
          };
        }

        ensureCaptureDirectory(dirname(target), args.path === undefined);
        const performed = await performPlan(
          "screenshot",
          prepared.plan,
          context,
          args.timeout_ms ?? DEFAULT_COMPUTER_TIMEOUT_MS,
        );
        if (existsSync(target)) chmodSync(target, 0o600);
        if (!performed.ok) return performed.result;
        const geometry = parseCaptureGeometry(performed.stdout);
        const captureTarget = {
          windowId: args.window_id, region: args.region === undefined ? undefined : geometry.bounds, display: args.display,
        };
        const result = captureResult(target, platform, prepared.plan.driver, captureTarget, geometry);
        if (typeof result === "string" || result.attachments === undefined) return result;
        const screenshotId = computerScreenshots.remember({
          sessionID: context.sessionID, worktree: context.worktree, platform,
          target: captureTarget, geometry, width: result.metadata!.width as number, height: result.metadata!.height as number,
        });
        return {
          ...result,
          output: `${result.output}\nScreenshot ID: ${screenshotId}. Pass screenshot_id with image-pixel coordinates to pointer tools; moved/resized windows or changed displays require a fresh screenshot.`,
          metadata: { ...result.metadata, screenshot_id: screenshotId },
        };
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

/** Run one discovery or input operation inside the tool's desktop queue slot. */
async function runInput(
  action: ActionName,
  build: (facts: SupportedComputerUse) => ComputerPlanOrRefusal,
  context: CanonicalToolContext,
  dryRun: boolean | undefined,
  extraMetadata: Record<string, unknown>,
): Promise<ToolResult> {
  const target = { ...(extraMetadata.window_id === undefined ? {} : { window_id: extraMetadata.window_id }),
    ...(extraMetadata.screenshot_id === undefined ? {} : { screenshot_id: extraMetadata.screenshot_id }) };
  const prepared = prepare(action, build);
  if (!prepared.ok) return { ...prepared.result, metadata: { ...prepared.result.metadata, ...target } };
  if (dryRun === true) {
    const result = dryRunResult(action, prepared.plan);
    return { ...result, metadata: { ...result.metadata, ...target } };
  }
  const performed = await performPlan(action, prepared.plan, context);
  if (!performed.ok) return { ...performed.result, metadata: { ...performed.result.metadata, ...target } };
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
      "the macOS window number, an X11 window id, or a Windows top-level window handle (including multiple windows from one process). " +
      "One line per window: on macOS and Windows id, process or owner, title; on X11 the id and the title. " +
      "On macOS this reads the window server's own list, so the ids are native CGWindowIDs, " +
      "with no Accessibility grant; window titles need Screen Recording and are empty without it. " +
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
      const lines = performed.stdout.split(/\r?\n/).filter(line => line.trim().length > 0);
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
      "Click a mouse button at absolute screen coordinates, optionally focusing and verifying window_id before input. " +
      "Darwin uses native Quartz mouse events for left, right and middle clicks; " +
      "Linux X11 uses xdotool; Windows uses mouse_event through PowerShell. " +
      "dry_run returns the exact command without executing it.",
    args: {
      x: z.number().describe("Screen x coordinate, or image pixel x when screenshot_id is supplied"),
      y: z.number().describe("Screen y coordinate, or image pixel y when screenshot_id is supplied"),
      button: z.enum(["left", "right", "middle"]).optional().default("left").describe("Mouse button (default left)"),
      clicks: z.union([z.literal(1), z.literal(2)]).optional().default(1).describe("Click count: 1 or 2 (default 1)"),
      window_id: INPUT_WINDOW_ARG,
      screenshot_id: SCREENSHOT_ARG,
      dry_run: DRY_RUN_ARG,
      timeout_ms: TIMEOUT_ARG,
    },
    async execute(args, context) {
      // The schema's defaults are applied by the host's own arg parsing, but the
      // tool still owns the request it builds: an omitted button is a left
      // click here too, never an undefined one a driver would refuse.
      const button = args.button ?? "left";
      const clicks = args.clicks ?? 1;
      const request = pointerRequest({
        action: "click",
        x: args.x,
        y: args.y,
        button,
        clicks,
        windowId: args.window_id,
      } as const, args.screenshot_id, context);
      const extra = { x: Math.round(request.x), y: Math.round(request.y), button, clicks, ...pointerMetadata(request, args.screenshot_id) };
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
      x: z.number().describe("Screen x coordinate, or image pixel x when screenshot_id is supplied"),
      y: z.number().describe("Screen y coordinate, or image pixel y when screenshot_id is supplied"),
      window_id: INPUT_WINDOW_ARG,
      screenshot_id: SCREENSHOT_ARG,
      dry_run: DRY_RUN_ARG,
      timeout_ms: TIMEOUT_ARG,
    },
    async execute(args, context) {
      const request = pointerRequest({ action: "move", x: args.x, y: args.y, windowId: args.window_id }, args.screenshot_id, context);
      return await runInput(
        "move",
        facts => facts.inputPlan(request, process.env),
        context,
        args.dry_run,
        { x: Math.round(request.x), y: Math.round(request.y), ...pointerMetadata(request, args.screenshot_id) },
      );
    },
  });
}

/** `computer_type` — type text into the focused window. */
export function createComputerTypeTool() {
  return defineComputerTool("type", {
    description:
      "Type text into the focused window, optionally focusing and verifying window_id first. " +
      "Darwin uses Quartz Unicode keyboard events, Linux X11 uses xdotool type, Windows uses SendKeys. " +
      "Execution results omit the text; dry_run includes the exact command and therefore the text. Do not dry-run secrets.",
    args: {
      text: z.string().min(1).describe("Text to type; a newline presses Return"),
      window_id: INPUT_WINDOW_ARG,
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
        { characters: [...args.text].length, ...windowMetadata(args.window_id) },
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
      window_id: INPUT_WINDOW_ARG,
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
        { keys: args.keys, ...windowMetadata(args.window_id) },
      );
    },
  });
}

export function createComputerDisplaysTool() {
  return defineComputerTool("displays", {
    description: "List displays as JSON with screenshot display ids, screen-coordinate bounds, scale and primary flag. " +
      "macOS ids start at 1; Windows and X11 monitor ids start at 0. Refresh IDs after a layout change. " +
      "X11 lists RandR monitors on the current DISPLAY screen. Windows and X11 use physical desktop pixels; macOS uses screen points. " +
      "Display scale describes UI scaling, not the screenshot pixel-to-input ratio; use the screenshot's per-axis scales or screenshot_id for input.",
    args: { dry_run: DRY_RUN_ARG, timeout_ms: TIMEOUT_ARG },
    async execute(args, context) {
      const prepared = prepare("displays", facts => facts.inputPlan({ action: "displays" }, process.env));
      if (!prepared.ok) return prepared.result;
      if (args.dry_run) return dryRunResult("displays", prepared.plan);
      const performed = await performPlan("displays", prepared.plan, context, args.timeout_ms);
      if (!performed.ok) return performed.result;
      const displays = z.array(COMPUTER_DISPLAY_SCHEMA).min(1).parse(JSON.parse(performed.stdout));
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
      window_id: INPUT_WINDOW_ARG,
      screenshot_id: SCREENSHOT_ARG,
      dry_run: DRY_RUN_ARG, timeout_ms: TIMEOUT_ARG,
    },
    async execute(args, context) {
      const request = pointerRequest({ action: "scroll", direction: args.direction, amount: args.amount ?? 3, x: args.x, y: args.y, windowId: args.window_id }, args.screenshot_id, context);
      return runInput("scroll", facts => facts.inputPlan(request, process.env), context, args.dry_run,
        { direction: request.direction, amount: request.amount,
          ...(request.x === undefined ? {} : { x: request.x }), ...(request.y === undefined ? {} : { y: request.y }),
          ...pointerMetadata(request, args.screenshot_id) });
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
      window_id: INPUT_WINDOW_ARG,
      screenshot_id: SCREENSHOT_ARG,
      dry_run: DRY_RUN_ARG, timeout_ms: TIMEOUT_ARG,
    },
    async execute(args, context) {
      const request = pointerRequest({
        action: "drag", fromX: args.from_x, fromY: args.from_y, toX: args.to_x, toY: args.to_y,
        durationMs: args.duration_ms ?? 500, windowId: args.window_id,
      } as const, args.screenshot_id, context);
      return runInput("drag", facts => facts.inputPlan(request, process.env), context, args.dry_run,
        { from_x: request.fromX, from_y: request.fromY, to_x: request.toX, to_y: request.toY, duration_ms: request.durationMs, ...pointerMetadata(request, args.screenshot_id) });
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
        platform: getSystem().id, supported: true, operations, ...(helpers === undefined ? {} : { helpers }), input_permission: permission,
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

/** Report a confirmed input denial with the next permission-recovery step. */
export function permissionRefusal(
  driver: string,
  hint: string | undefined,
  detail: PermissionRefusalDetail = {},
): ToolResult {
  const answer = detail.answer === undefined ? "" : firstAnswerLine(detail.answer);
  const answered = answer.length === 0 ? "" : ` The probe answered: ${answer}.`;
  return {
    title: "permissions",
    output:
      `Error: ${driver} reports that input is not permitted; ` +
      (hint ?? "grant this process the permission its system requires.") + answered + " " +
      (detail.requested ? PERMISSION_USER_GUIDANCE : PERMISSION_REQUEST_GUIDANCE),
    metadata: { ...metadataFor("permissions", driver), granted: false, ...permissionRecovery(detail.requested) },
  };
}

/** Probe input and capture grants independently; request only missing grants. */
export function createComputerPermissionsTool() {
  return defineComputerTool("permissions", {
    description:
      "Report input permission and independent screen-capture permission. metadata.granted refers only to input; screen_capture.granted is separate. " +
      "macOS probes this process's Accessibility trust and Screen Recording access. Linux X11 checks session access and xdotool; Windows checks an interactive session. " +
      "request:true first probes, requests only missing macOS Accessibility and Screen Recording grants, then probes again. A request or dry run is not a grant. " +
      "Wait for the user to approve OS dialogs or System Settings, restart the application launching the host if required, then call without request to recheck. Do not loop requests. " +
      "Automation for System Events is separate and may require manual approval. Linux/Windows have no requestable per-app grant here; request:true only diagnoses them. " +
      "dry_run reports the conditional request/probe commands without running commands or opening dialogs.",
    args: {
      dry_run: DRY_RUN_ARG,
      timeout_ms: TIMEOUT_ARG,
      request: REQUEST_ARG,
    },
    async execute(args, context) {
      const facts = getSystem().computerUse;
      const prepared = prepare("permissions", loaded => loaded.permissionProbe());
      if (!prepared.ok) return prepared.result;
      if (!facts.supported) return { title: "permissions refused", output: `Error: ${facts.refusal}`, metadata: metadataFor("permissions", "unsupported") };
      const wantsPrompt = args.request === true;
      if (args.dry_run === true) {
        const prompt = wantsPrompt ? facts.permissionPrompt?.() : undefined;
        const result = dryRunResult("permissions", prompt !== undefined && typeof prompt !== "string" ? prompt : prepared.plan);
        const report = JSON.parse(result.output);
        if (wantsPrompt) {
          report.request_only_if_missing = true;
          report.input_permission_probe = { ...spawnVectorFor(prepared.plan, process.env), script: prepared.plan.script };
          const capturePrompt = facts.capturePermissionPrompt?.();
          if (capturePrompt !== undefined) report.capture_permission_request = typeof capturePrompt === "string"
            ? { refusal: capturePrompt }
            : { ...spawnVectorFor(capturePrompt, process.env), script: capturePrompt.script };
        }
        return { ...result, output: JSON.stringify(report) };
      }

      const options = { signal: context.abort, timeoutMs: 120_000, installHint: facts.installHint };
      const probeInput = async (): Promise<CapturePermission & { output?: string }> => {
        const run = await runComputerPlan(prepared.plan, options);
        if (!run.ok) return { checked: run.permission !== undefined, granted: false, error: run.error };
        return { checked: true, granted: facts.readsProbeOutput ? permissionVerdict(run.output) : true, output: run.output };
      };
      const requestGrant = async (plan: ComputerPlanOrRefusal): Promise<string | undefined> => {
        if (typeof plan === "string") return plan;
        const run = await runComputerPlan(plan, options);
        return run.ok ? undefined : run.error;
      };
      let input = await probeInput();
      let screenCapture = await capturePermission(facts, context);
      let inputRequest: Pick<CapturePermission, "requested" | "request_error"> = {};
      let captureRequest: Pick<CapturePermission, "requested" | "request_error"> = {};
      if (wantsPrompt && input.checked && input.granted === false && facts.permissionPrompt !== undefined && !context.abort.aborted) {
        const error = await requestGrant(facts.permissionPrompt());
        inputRequest = { requested: true, ...(error === undefined ? {} : { request_error: error }) };
      }
      if (wantsPrompt && screenCapture.checked && screenCapture.granted === false && facts.capturePermissionPrompt !== undefined && !context.abort.aborted) {
        const error = await requestGrant(facts.capturePermissionPrompt());
        captureRequest = { requested: true, ...(error === undefined ? {} : { request_error: error }) };
      }
      if (inputRequest.requested || captureRequest.requested) {
        input = { ...await probeInput(), ...inputRequest };
        screenCapture = { ...await capturePermission(facts, context), ...captureRequest };
      }

      const denied = (input.checked && input.granted === false) || (screenCapture.checked && screenCapture.granted === false);
      const unverified = !input.checked || (facts.capturePermissionProbe !== undefined && !screenCapture.checked);
      const userActionRequired = wantsPrompt ||
        (input.checked && input.granted === false && facts.permissionPrompt === undefined) ||
        (screenCapture.checked && screenCapture.granted === false && facts.capturePermissionPrompt === undefined);
      const output = [
        input.checked
          ? input.granted
            ? !facts.readsProbeOutput && input.output ? input.output : "Input is permitted on this system."
            : "Error: input permission is not granted."
          : "Error: input permission could not be verified.",
        input.error,
        input.request_error,
        screenCapture.request_error,
        input.requested || screenCapture.requested ? "OS permission requests were attempted; the reported grants come from fresh probes, not the request responses." : undefined,
        denied ? userActionRequired ? PERMISSION_USER_GUIDANCE : PERMISSION_REQUEST_GUIDANCE : undefined,
      ].filter(Boolean).join(" ");
      const { output: _probeOutput, ...inputPermission } = input;
      return withCapturePermission({
        title: "permissions", output,
        metadata: {
          ...metadataFor("permissions", prepared.plan.driver),
          granted: input.granted === true, input_permission: inputPermission,
          permission_requested: input.requested === true || screenCapture.requested === true,
          ...(denied ? permissionRecovery(userActionRequired) : unverified ? { error: true, error_code: "permission_unverified" } : {}),
        },
      }, screenCapture);
    },
  });
}

/**
 * The computer-use tools, keyed by the names the tool surface uses.
 *
 * `buildCanonicalTools` merges this record when the resolved gate permits it.
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
