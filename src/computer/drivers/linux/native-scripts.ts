import { loadNativeScript } from "../native-script.ts";

export const LINUX_MONITOR_ROWS_SCRIPT = loadNativeScript(new URL("./scripts/monitor-rows.awk", import.meta.url));
export const LINUX_DISPLAY_JSON_SCRIPT = loadNativeScript(new URL("./scripts/display-json.awk", import.meta.url));
export const LINUX_WINDOW_BOUNDS_SCRIPT = loadNativeScript(new URL("./scripts/window-bounds.awk", import.meta.url));
export const LINUX_PRIMARY_DISPLAY_SCRIPT = loadNativeScript(new URL("./scripts/primary-display.awk", import.meta.url));
export const LINUX_SELECT_DISPLAY_SCRIPT = loadNativeScript(new URL("./scripts/select-display.awk", import.meta.url));
export const LINUX_ROOT_SIZE_SCRIPT = loadNativeScript(new URL("./scripts/root-size.awk", import.meta.url));
export const LINUX_READ_DISPLAYS_SCRIPT = loadNativeScript(new URL("./scripts/read-displays.sh", import.meta.url));
export const LINUX_READ_GEOMETRY_SCRIPT = loadNativeScript(new URL("./scripts/read-geometry.sh", import.meta.url));
export const LINUX_CAPTURE_SCRIPT = loadNativeScript(new URL("./scripts/capture.sh", import.meta.url));
export const LINUX_FOCUS_CHECK_SCRIPT = loadNativeScript(new URL("./scripts/focus-check.sh", import.meta.url));
export const LINUX_DRAG_SCRIPT = loadNativeScript(new URL("./scripts/drag.sh", import.meta.url));
export const LINUX_WINDOWS_SCRIPT = loadNativeScript(new URL("./scripts/windows.sh", import.meta.url));
export const LINUX_CAPTURE_GUARD_SCRIPT = loadNativeScript(new URL("./scripts/capture-guard.sh", import.meta.url));
export const LINUX_PERMISSION_PROBE_SCRIPT = loadNativeScript(new URL("./scripts/permission-probe.sh", import.meta.url));
export const LINUX_LIST_DISPLAYS_SCRIPT = loadNativeScript(new URL("./scripts/list-displays.sh", import.meta.url));
