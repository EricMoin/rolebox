export { createSessionErrorRecoveryHook } from "./session-error-recovery.ts";
export { createEditErrorRecoveryHook } from "./edit-error-recovery.ts";
export { createJsonErrorRecoveryHook } from "./json-error-recovery.ts";
export { createContextWindowMonitorHook } from "./context-window-monitor.ts";
export { createEmptyResponseDetectorHook } from "./empty-response-detector.ts";
export { createToolPairValidatorHook } from "./tool-pair-validator.ts";
export { createWriteExistingFileGuardHook } from "./write-existing-file-guard.ts";
export { createBashFileReadGuardHook } from "./bash-file-read-guard.ts";
export { createWebFetchRedirectGuardHook } from "./webfetch-redirect-guard.ts";

export type { RecoveryEngineLike as SessionErrorRecoveryEngine } from "./session-error-recovery.ts";
export type { RecoveryEngineLike as EditErrorRecoveryEngine } from "./edit-error-recovery.ts";
export type { RecoveryEngineLike as JsonErrorRecoveryEngine } from "./json-error-recovery.ts";
export type { RecoveryEngineLike as ContextWindowRecoveryEngine } from "./context-window-monitor.ts";
export type { RecoveryEngineLike as EmptyResponseRecoveryEngine } from "./empty-response-detector.ts";

import type { BuiltInHookDefinition } from "../types.ts";
import type { BuiltInHookRegistry } from "./registry.ts";
import { createSessionErrorRecoveryHook } from "./session-error-recovery.ts";
import { createEditErrorRecoveryHook } from "./edit-error-recovery.ts";
import { createJsonErrorRecoveryHook } from "./json-error-recovery.ts";
import { createContextWindowMonitorHook } from "./context-window-monitor.ts";
import { createEmptyResponseDetectorHook } from "./empty-response-detector.ts";
import { createToolPairValidatorHook } from "./tool-pair-validator.ts";
import { createWriteExistingFileGuardHook } from "./write-existing-file-guard.ts";
import { createBashFileReadGuardHook } from "./bash-file-read-guard.ts";
import { createWebFetchRedirectGuardHook } from "./webfetch-redirect-guard.ts";

/**
 * Minimal engine-like interface for `registerBuiltinHooks`.
 * The caller provides an object with a `recover()` method. Hooks
 * that do not need the engine are registered without it.
 */
export interface BuiltinHooksEngineLike {
  recover(
    sessionID: string,
    error: unknown,
    category?: string,
  ): Promise<{ recovered: boolean; message?: string }>;
}

/**
 * Register all 9 builtin recovery hooks into the given registry.
 *
 * Hooks 1-5 (session-error, edit-error, json-error, context-window,
 * empty-response) require an engine dependency for chain-based
 * recovery and are only registered when `engine` is provided.
 *
 * Hooks 6-9 (tool-pair-validator, write-existing-file-guard,
 * bash-file-read-guard, webfetch-redirect-guard) are pure guards
 * with no engine dependency and are always registered.
 *
 * @param registry - The BuiltInHookRegistry to register hooks into
 * @param engine - Optional engine-like object with recover()
 */
export function registerBuiltinHooks(
  registry: BuiltInHookRegistry,
  engine?: unknown,
): void {
  if (engine) {
    const eng = engine as BuiltinHooksEngineLike;
    registry.register(createSessionErrorRecoveryHook(eng));
    registry.register(createEditErrorRecoveryHook(eng));
    registry.register(createJsonErrorRecoveryHook(eng));
    registry.register(createContextWindowMonitorHook(eng));
    registry.register(createEmptyResponseDetectorHook(eng));
  }

  // Guards — no engine dependency
  registry.register(createToolPairValidatorHook());
  registry.register(createWriteExistingFileGuardHook());
  registry.register(createBashFileReadGuardHook());
  registry.register(createWebFetchRedirectGuardHook());
}
