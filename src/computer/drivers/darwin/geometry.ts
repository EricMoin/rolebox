import type { ComputerCaptureGuard, ComputerCaptureRequest } from "../../../platform/system/types.ts";
import {
  DARWIN_CAPTURE_GUARD_SCRIPT, DARWIN_CAPTURE_SCRIPT, DARWIN_COMPOSITE_SCRIPT, DARWIN_GEOMETRY_SCRIPT,
} from "./native-scripts.ts";

export { DARWIN_COMPOSITE_SCRIPT, DARWIN_GEOMETRY_SCRIPT };

export function darwinCaptureGuardScript(guard: ComputerCaptureGuard): string {
  return [
    DARWIN_GEOMETRY_SCRIPT,
    `var guard = ${JSON.stringify(guard)};`,
    DARWIN_CAPTURE_GUARD_SCRIPT,
  ].join("\n");
}

export function darwinCaptureScript(request: ComputerCaptureRequest): string {
  const { path, ...target } = request;
  return [
    DARWIN_GEOMETRY_SCRIPT,
    DARWIN_COMPOSITE_SCRIPT,
    `var target = ${JSON.stringify(target)};`,
    `var path = ${JSON.stringify(path)};`,
    DARWIN_CAPTURE_SCRIPT,
  ].join("\n");
}
