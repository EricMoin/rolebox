// Shared helper: creates a correctly-spread paths mock for test files that
// need to redirect data/config dirs to temp locations.
//
// Background: bun keys `mock.module` registrations by the resolved module path
// and has NO un-mock API (mock.restore() does not revert module mocks).  A
// limited-export mock registered by one test file can therefore shadow the REAL
// module for every subsequent test file in the single-process run.  If the
// limited mock omits `assertSafePathSegment` / `getRolePath`, any later test
// that calls `getRolePath()` will get the mock's implementation — which
// typically does NOT sanitize its arguments, silently bypassing roleId path
// traversal protection.
//
// This helper loads the REAL paths module once via a fresh (cache-busted) import
// and returns a sync factory that spreads its full export surface, so the mock
// always includes `assertSafePathSegment`, `getRolePath`, `getRolesDir`,
// `getPlatform`, `setPlatformForTest`, and every other real export.  Callers
// override ONLY the functions they need to redirect (typically `getDataDir` /
// `getConfigDir`).
//
// Usage (file level):
//   import { createPathsMock } from "../../helpers/paths-mock";
//   mock.module("../../../src/cli/paths", () => createPathsMock({
//     getDataDir: () => dataDir,
//     getConfigDir: () => configDir,
//     extra: { getSyncTarget: ..., },
//   }));

// Pre-load the REAL paths module once.  The cache-busting query string ensures
// this import bypasses any mock.module registry that may already be active for
// `src/cli/paths` — it always resolves to the real on-disk module.
const _REAL_PATHS = await import(
  "../../src/cli/paths.ts?paths-mock-helper=" + Date.now() + "-" + Math.random()
);

export interface PathsMockOpts {
  /** Override for getDataDir. */
  getDataDir?: () => string;
  /** Override for getConfigDir. */
  getConfigDir?: () => string;
  /** Additional named exports to override (e.g. getSyncTarget, getOpencodeConfigPath). */
  extra?: Record<string, unknown>;
}

/** Return a sync mock factory payload — spreads the full real module, overrides only what's given. */
export function createPathsMockPayload(opts: PathsMockOpts = {}): Record<string, unknown> {
  return {
    ..._REAL_PATHS,
    ...(opts.getDataDir ? { getDataDir: opts.getDataDir } : {}),
    ...(opts.getConfigDir ? { getConfigDir: opts.getConfigDir } : {}),
    ...(opts.extra ?? {}),
  };
}
