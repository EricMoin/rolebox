import type { ComputerCaptureGeometry, ComputerCaptureRequest } from "../../../platform/system/types.ts";
import { REGION_REFUSAL, shellQuote, usableWindowId, wholeRegion } from "../shared.ts";
import {
  LINUX_DISPLAY_JSON_SCRIPT, LINUX_MONITOR_ROWS_SCRIPT, LINUX_PRIMARY_DISPLAY_SCRIPT,
  LINUX_READ_DISPLAYS_SCRIPT, LINUX_READ_GEOMETRY_SCRIPT, LINUX_ROOT_SIZE_SCRIPT,
  LINUX_SELECT_DISPLAY_SCRIPT, LINUX_WINDOW_BOUNDS_SCRIPT,
} from "./native-scripts.ts";

type CaptureTarget = Omit<ComputerCaptureRequest, "path">;

export function linuxDisplayScript(): string {
  return [
    `rolebox_monitor_rows=${shellQuote(LINUX_MONITOR_ROWS_SCRIPT)}`,
    `rolebox_display_json=${shellQuote(LINUX_DISPLAY_JSON_SCRIPT)}`,
    LINUX_READ_DISPLAYS_SCRIPT,
  ].join("\n");
}

export function linuxTargetRefusal(target: CaptureTarget): string | null {
  if ([target.windowId, target.region, target.display].filter(value => value !== undefined).length > 1) {
    return "an X11 capture takes one window, region or display, not multiple targets.";
  }
  if (target.windowId !== undefined && !usableWindowId(target.windowId)) return "a window id must be a positive whole number (X11 window ids come from computer_windows).";
  if (target.display !== undefined && (!Number.isInteger(target.display) || target.display < 0)) return "an X11 display must be a non-negative monitor id from computer_displays.";
  if (target.region !== undefined && wholeRegion(target.region) === null) return REGION_REFUSAL;
  return null;
}

export function linuxGeometryScript(target: CaptureTarget, env: NodeJS.ProcessEnv): string {
  let bounds: string;
  if (target.windowId !== undefined) {
    const screen = Number(env.DISPLAY?.match(/:([0-9]+)(?:\.([0-9]+))?$/)?.[2] ?? 0);
    bounds = [
      `  window_info=$(xdotool getwindowgeometry --shell ${target.windowId}) || return 3`,
      `  rectangle=$(printf '%s\\n' "$window_info" | awk -F '=' -v window=${target.windowId} -v screen=${screen} ${shellQuote(LINUX_WINDOW_BOUNDS_SCRIPT)}) || return 3`,
    ].join("\n");
  } else if (target.region !== undefined) {
    const region = wholeRegion(target.region)!;
    bounds = `  rectangle='${region.x} ${region.y} ${region.w} ${region.h}'`;
  } else {
    const select = target.display === undefined ? LINUX_PRIMARY_DISPLAY_SCRIPT : LINUX_SELECT_DISPLAY_SCRIPT;
    bounds = `  rectangle=$(printf '%s\\n' "$monitors" | awk -F '\\t' -v wanted=${target.display ?? -1} ${shellQuote(select)}) || return 3`;
  }
  return [
    linuxDisplayScript(),
    `rolebox_root_size=${shellQuote(LINUX_ROOT_SIZE_SCRIPT)}`,
    "read_capture_bounds() {",
    bounds,
    "}",
    LINUX_READ_GEOMETRY_SCRIPT,
  ].join("\n");
}

export function linuxGeometryJson(geometry: ComputerCaptureGeometry): string {
  return JSON.stringify({
    bounds: { x: geometry.bounds.x, y: geometry.bounds.y, w: geometry.bounds.w, h: geometry.bounds.h },
    displays: geometry.displays.map(display => ({
      id: display.id, x: display.x, y: display.y, width: display.width, height: display.height,
      scale: display.scale, primary: display.primary, name: display.name,
    })),
  });
}
