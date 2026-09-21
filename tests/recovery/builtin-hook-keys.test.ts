/**
 * ─────────────────────────────────────────────────────────────────────
 * Built-in hook key coverage
 *
 * Guards the drift between the BUILTIN_HOOK_KEYS constant table (the single
 * source of truth used by RecoveryService for tiered defaults) and the set of
 * hooks actually registered by registerBuiltinHooks.
 * ─────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect } from "bun:test";
import {
  createBashFileReadGuardHook,
  createContextWindowMonitorHook,
  createEditErrorRecoveryHook,
  createEmptyResponseDetectorHook,
  createJsonErrorRecoveryHook,
  createSessionErrorRecoveryHook,
  createToolPairValidatorHook,
  createWebFetchRedirectGuardHook,
  createWriteExistingFileGuardHook,
} from "../../src/recovery/builtin/index.ts";
import {
  BUILTIN_HOOK_KEYS,
  findUnknownBuiltinConfigKeys,
} from "../../src/recovery/builtin/keys.ts";

/** Stub engine — the error-recovery factories only need a callable recover(). */
const engine = { recover: async () => ({ recovered: false }) };

describe("built-in hook keys", () => {
  it("BUILTIN_HOOK_KEYS matches the configKey of every exported hook factory", () => {
    const hooks = [
      createSessionErrorRecoveryHook(engine),
      createEditErrorRecoveryHook(engine),
      createJsonErrorRecoveryHook(engine),
      createContextWindowMonitorHook(engine),
      createEmptyResponseDetectorHook(engine),
      createToolPairValidatorHook(),
      createWriteExistingFileGuardHook(),
      createBashFileReadGuardHook(),
      createWebFetchRedirectGuardHook(),
    ];

    const actual = hooks.map((hook) => hook.configKey).sort();
    expect(actual).toEqual([...BUILTIN_HOOK_KEYS].sort());
  });

  it("findUnknownBuiltinConfigKeys accepts every known key", () => {
    expect(
      findUnknownBuiltinConfigKeys({ session_error: true, recovery: true }),
    ).toEqual([]);
  });

  it("findUnknownBuiltinConfigKeys reports only the unknown keys", () => {
    expect(
      findUnknownBuiltinConfigKeys({ auto_activate: true, session_error: false }),
    ).toEqual(["auto_activate"]);
  });
});
