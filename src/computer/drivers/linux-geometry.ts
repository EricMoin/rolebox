import type { ComputerCaptureGeometry, ComputerCaptureRequest } from "../../platform/system/types.ts";
import { REGION_REFUSAL, shellQuote, usableWindowId, wholeRegion } from "./shared.ts";

type CaptureTarget = Omit<ComputerCaptureRequest, "path">;

const MONITOR_ROWS = String.raw`
  /^Monitors: [0-9]+$/ { expected = $2; next }
  /^[[:space:]]*[0-9]+:/ {
    line = $0
    sub(/^[[:space:]]*/, "", line)
    id = line; sub(/:.*/, "", id)
    sub(/^[0-9]+: /, "", line)
    primary = line ~ /^[+]*[*]/ ? 1 : 0
    sub(/^[+*]+/, "", line)
    if (!match(line, / [0-9]+\/[0-9]+x[0-9]+\/[0-9]+[+-][0-9]+[+-][0-9]+( |$)/)) { invalid = 1; next }
    name = substr(line, 1, RSTART - 1)
    geometry = substr(line, RSTART + 1, RLENGTH - 1)
    if (!length(name) || name ~ /[[:cntrl:]]/) { invalid = 1; next }
    width = geometry; sub(/\/.*/, "", width)
    sub(/^[0-9]+\/[0-9]+x/, "", geometry)
    height = geometry; sub(/\/.*/, "", height)
    sub(/^[0-9]+\/[0-9]+/, "", geometry)
    match(geometry, /^[+-][0-9]+/)
    x = substr(geometry, 1, RLENGTH) + 0
    y = substr(geometry, RLENGTH + 1) + 0
    if (width + 0 <= 0 || height + 0 <= 0 || id in rows) { invalid = 1; next }
    rows[id] = sprintf("%d\t%d\t%d\t%d\t%d\t%d\t%s", id, x, y, width, height, primary, name)
    count++
  }
  END {
    if (invalid || !count || count != expected) exit 3
    for (i = 0; i < count; i++) { if (!(i in rows)) exit 3; print rows[i] }
  }
`;

const DISPLAY_JSON = String.raw`
  function quote(value, out, i, character) {
    out = "\""
    for (i = 1; i <= length(value); i++) {
      character = substr(value, i, 1)
      if (character == "\"" || character == "\\") out = out "\\"
      out = out character
    }
    return out "\""
  }
  {
    printf "%s{\"id\":%d,\"x\":%d,\"y\":%d,\"width\":%d,\"height\":%d,\"scale\":1,\"primary\":%s,\"name\":%s}", (NR == 1 ? "[" : ","), $1, $2, $3, $4, $5, ($6 ? "true" : "false"), quote($7)
  }
  END { if (!NR) exit 3; print "]" }
`;

export function linuxDisplayScript(): string {
  return [
    "read_monitors() {",
    "  monitor_info=$(LC_ALL=C xrandr --listactivemonitors) || return 3",
    `  printf '%s\\n' "$monitor_info" | awk ${shellQuote(MONITOR_ROWS)}`,
    "}",
    "display_json() {",
    `  awk -F '\\t' ${shellQuote(DISPLAY_JSON)}`,
    "}",
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
    const parseWindow = String.raw`
      /^(WINDOW|X|Y|WIDTH|HEIGHT|SCREEN)=-?[0-9]+$/ {
        if ($1 in fields) invalid = 1
        fields[$1] = $2
      }
      END {
        if (invalid || length(fields) != 6 || fields["WINDOW"] != window || fields["SCREEN"] != screen || fields["WIDTH"] <= 0 || fields["HEIGHT"] <= 0) exit 3
        printf "%d %d %d %d\n", fields["X"], fields["Y"], fields["WIDTH"], fields["HEIGHT"]
      }
    `;
    bounds = [
      `  window_info=$(xdotool getwindowgeometry --shell ${target.windowId}) || return 3`,
      `  rectangle=$(printf '%s\\n' "$window_info" | awk -F '=' -v window=${target.windowId} -v screen=${screen} ${shellQuote(parseWindow)}) || return 3`,
    ].join("\n");
  } else if (target.region !== undefined) {
    const region = wholeRegion(target.region)!;
    bounds = `  rectangle='${region.x} ${region.y} ${region.w} ${region.h}'`;
  } else {
    const select = target.display === undefined
      ? String.raw`NR == 1 { fallback = sprintf("%d %d %d %d", $2, $3, $4, $5) } $6 == 1 { selected = sprintf("%d %d %d %d", $2, $3, $4, $5) } END { print (selected == "" ? fallback : selected) }`
      : String.raw`$1 == wanted { printf "%d %d %d %d\n", $2, $3, $4, $5; found = 1 } END { if (!found) exit 3 }`;
    bounds = `  rectangle=$(printf '%s\\n' "$monitors" | awk -F '\\t' -v wanted=${target.display ?? -1} ${shellQuote(select)}) || return 3`;
  }
  const rootSize = String.raw`
    /^Screen [0-9]+:/ {
      for (i = 1; i <= NF; i++) {
        if ($i == "current" && $(i+1) ~ /^[0-9]+$/ && $(i+2) == "x" && $(i+3) ~ /^[0-9]+,$/) {
          width = $(i+1); height = $(i+3); sub(/,$/, "", height)
          if (width > 0 && height > 0) { printf "%d %d\n", width, height; found = 1; exit }
        }
      }
    }
    END { if (!found) exit 3 }
  `;
  return [
    linuxDisplayScript(),
    "read_geometry() {",
    "  monitors=$(read_monitors) || return 3",
    "  displays_json=$(printf '%s\\n' \"$monitors\" | display_json) || return 3",
    "  screen_info=$(LC_ALL=C xrandr --current) || return 3",
    `  root_size=$(printf '%s\\n' "$screen_info" | awk ${shellQuote(rootSize)}) || return 3`,
    bounds,
    "  set -- $rectangle $root_size",
    "  if [ \"$#\" != 6 ] || [ \"$1\" -lt 0 ] || [ \"$2\" -lt 0 ] || [ \"$(($1 + $3))\" -gt \"$5\" ] || [ \"$(($2 + $4))\" -gt \"$6\" ]; then",
    "    echo 'capture bounds must be fully inside the current X11 root screen' >&2",
    "    return 3",
    "  fi",
    "  capture_x=$1 capture_y=$2 capture_w=$3 capture_h=$4",
    "  geometry_json=$(printf '{\"bounds\":{\"x\":%s,\"y\":%s,\"w\":%s,\"h\":%s},\"displays\":%s}' \"$1\" \"$2\" \"$3\" \"$4\" \"$displays_json\")",
    "}",
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
