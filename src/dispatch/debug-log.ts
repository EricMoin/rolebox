import { createSubLogger, getLogFilePath } from "../logger.ts";

const DEBUG = !!process.env.ROLEBOX_DEBUG;
const log = createSubLogger("dispatch", DEBUG ? 2 /* debug */ : undefined);

export function debugLog(tag: string, taskId: string, msg: string): void {
  log.debug(msg, { tag, taskId });
}

export function getDebugLogPath(): string {
  return process.env.ROLEBOX_DEBUG_LOG || getLogFilePath() || "/tmp/rolebox-dispatch.log";
}
