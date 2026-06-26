import { createSubLogger } from "../logger.ts";

const DEBUG = !!process.env.ROLEBOX_DEBUG;
const log = createSubLogger("dispatch", DEBUG ? 2 /* debug */ : undefined);

/**
 * Structured debug log for the dispatch subsystem.
 * Gated via ROLEBOX_DEBUG env var which lowers the sub-logger's
 * minLevel to debug (2). Without it, debug calls are filtered
 * by the root logger's default level (info=3).
 */
export function debugLog(tag: string, taskId: string, msg: string): void {
  log.debug(msg, { tag, taskId });
}

/** Info-level lifecycle log — always visible at default ROLEBOX_LOG_LEVEL=info. */
export function infoLog(tag: string, taskId: string, msg: string): void {
  log.info(msg, { tag, taskId });
}
