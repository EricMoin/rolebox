/**
 * ─────────────────────────────────────────────────────────────────────
 * Built-in hook key coverage
 *
 * Guards the drift between the BUILTIN_HOOK_KEYS constant table (the single
 * source of truth used by RecoveryService for tiered defaults) and the set of
 * hooks actually registered by registerBuiltinHooks.
 * ─────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect } from "vitest";
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

describe("webfetch-redirect-guard tool filter", () => {
  // The registry matches a hook's filter names EXACTLY (`registry.ts`), so the
  // guard must name every host spelling of the webfetch tool or it silently
  // never fires there: `webfetch` on opencode-style hosts, `web_fetch` on dsh.
  it("covers both the opencode-style and dsh tool names", () => {
    const hook = createWebFetchRedirectGuardHook();
    expect(hook.filter?.tools).toEqual(expect.arrayContaining(["webfetch", "web_fetch"]));
  });
});
