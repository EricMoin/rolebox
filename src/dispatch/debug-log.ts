import { appendFileSync, writeFileSync } from "node:fs";

const DEBUG = !!process.env.ROLEBOX_DEBUG;
const LOG_PATH = process.env.ROLEBOX_DEBUG_LOG || "/tmp/rolebox-dispatch.log";

let initialized = false;

function ensureInit(): void {
  if (initialized) return;
  initialized = true;
  try {
    writeFileSync(LOG_PATH, `--- rolebox dispatch log started ${new Date().toISOString()} ---\n`);
  } catch { /* best effort */ }
}

export function debugLog(tag: string, taskId: string, msg: string): void {
  if (!DEBUG) return;
  ensureInit();
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  const line = `[${ts}][dispatch:${tag}] ${taskId} ${msg}\n`;
  try {
    appendFileSync(LOG_PATH, line);
  } catch { /* best effort */ }
}

export function getDebugLogPath(): string {
  return LOG_PATH;
}
