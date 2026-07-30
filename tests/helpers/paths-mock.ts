// Shared helper: creates a correctly-spread paths mock for test files that
// need to redirect data/config dirs to temp locations.
//
// Background: bun keys `mock.module` registrations by the resolved module path
// and has NO un-mock API (mock.restore() does not revert module mocks).  The
// test suite runs under `bun test --isolate`, so each test FILE gets a fresh
// global object and module registry — a mock registered by one file can no
// longer shadow the real module for a later file, making cross-file mock.module
// leakage structurally impossible.
//
// This helper statically imports the REAL paths module and returns a sync
// factory that spreads its full export surface, so the mock always includes
// `assertSafePathSegment`, `getRolePath`, `getRolesDir`, `getPlatform`,
// `setPlatformForTest`, and every other real export.  A limited-export mock
// that drops `assertSafePathSegment` / `getRolePath` would silently bypass
// roleId path traversal protection, so the full-surface spread is a required
// safety guard.  Callers override ONLY the functions they need to redirect
// (typically `getDataDir` / `getConfigDir`).
//
// No cache-busting is needed: under `--isolate` the registry is per-file, and a
// consuming file's `mock.module(...)` runs in its body AFTER its imports are
// evaluated, so this helper's static import always resolves to the real module.
//
// Usage (file level):
//   import { createPathsMockPayload } from "../../helpers/paths-mock";
//   mock.module("../../../src/cli/paths", () => createPathsMockPayload({
//     getDataDir: () => dataDir,
//     getConfigDir: () => configDir,
//     extra: { getSyncTarget: ..., },
//   }));

// Statically import the REAL paths module.  Because a consuming file's
// `mock.module(...)` runs after its imports are evaluated, this always resolves
// to the real on-disk module even when a mock for `src/cli/paths` is registered
// later in the same file.
import * as _REAL_PATHS from "../../src/cli/paths.ts";

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
