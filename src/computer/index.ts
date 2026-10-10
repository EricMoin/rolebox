/**
 * rolebox's computer-use family: the per-OS plan builders, the executor behind
 * them, and the seven tools the tool surface registers when it is asked for
 * them.
 */

export { createComputerTools } from "./tools.ts";
export { DEFAULT_COMPUTER_TIMEOUT_MS, helperAvailable, runComputerPlan, spawnVectorFor } from "./exec.ts";
export {
  CAPTURE_DIRECTORY,
  captureDirectory,
  captureFilePath,
  captureResult,
  captureTimestamp,
  ensureCaptureDirectory,
  nextCaptureSequence,
} from "./capture.ts";
export { hasPngSignature, PNG_SIGNATURE, readPngSize } from "./png.ts";
export { darwinComputerUse } from "./drivers/darwin.ts";
export { linuxComputerUse } from "./drivers/linux.ts";
export { win32ComputerUse } from "./drivers/win32.ts";
export { unsupportedComputerUse } from "./drivers/unsupported.ts";
