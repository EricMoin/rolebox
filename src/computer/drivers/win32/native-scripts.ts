import { loadNativeScript } from "../native-script.ts";

export const WIN32_DPI_SCRIPT = loadNativeScript(new URL("./scripts/dpi.ps1", import.meta.url));
export const WIN32_MOUSE_SCRIPT = loadNativeScript(new URL("./scripts/mouse.ps1", import.meta.url));
export const WIN32_WINDOW_SCRIPT = loadNativeScript(new URL("./scripts/window.ps1", import.meta.url));
export const WIN32_WINDOW_LIST_API_SCRIPT = loadNativeScript(new URL("./scripts/window-list-api.ps1", import.meta.url));
export const WIN32_DISPLAY_SCRIPT = loadNativeScript(new URL("./scripts/display.ps1", import.meta.url));
export const WIN32_ASSERT_GEOMETRY_SCRIPT = loadNativeScript(new URL("./scripts/assert-geometry.ps1", import.meta.url));
export const WIN32_CAPTURE_GUARD_SCRIPT = loadNativeScript(new URL("./scripts/capture-guard.ps1", import.meta.url));
export const WIN32_CAPTURE_SCRIPT = loadNativeScript(new URL("./scripts/capture.ps1", import.meta.url));
export const WIN32_FOCUS_SCRIPT = loadNativeScript(new URL("./scripts/focus.ps1", import.meta.url));
export const WIN32_DRAG_SCRIPT = loadNativeScript(new URL("./scripts/drag.ps1", import.meta.url));
export const WIN32_WINDOWS_SCRIPT = loadNativeScript(new URL("./scripts/windows.ps1", import.meta.url));
export const WIN32_PERMISSION_SCRIPT = loadNativeScript(new URL("./scripts/permission.ps1", import.meta.url));
