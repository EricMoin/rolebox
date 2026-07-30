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
// BUT if the suite is invoked WITHOUT `--isolate` (plain `bun test`, shared
// process), a mock registered by a prior test file persists and would shadow
// this helper's bare static import of the real paths module.  To stay robust in
// BOTH modes, the real module is loaded via a cache-busted query-string
// specifier (`?real`).  bun treats that specifier as a distinct module path that
// is not covered by `mock.module("...paths")` — exactly the technique
// `tests/cli/e2e.test.ts` already uses for its `?e2e-real` import.
//
// This helper returns a sync factory that spreads the REAL module's full export
// surface, so the mock always includes `assertSafePathSegment`, `getRolePath`,
// `getRolesDir`, `getPlatform`, `setPlatformForTest`, and every other real
// export.  A limited-export mock that drops `assertSafePathSegment` /
// `getRolePath` would silently bypass roleId path traversal protection, so the
// full-surface spread is a required safety guard.  Callers override ONLY the
// functions they need to redirect (typically `getDataDir` / `getConfigDir`).
//
// Usage (file level):
//   import { createPathsMockPayload } from "../../helpers/paths-mock";
//   mock.module("../../../src/cli/paths", () => createPathsMockPayload({
//     getDataDir: () => dataDir,
//     getConfigDir: () => configDir,
//     extra: { getSyncTarget: ..., },
//   }));

// Load the REAL paths module via a cache-busted query-string specifier.  A
// consuming file's `mock.module(...)` runs after its imports are evaluated, and
// this distinct specifier is never covered by a mock keyed to the bare path, so
// it always resolves to the real on-disk module — even when another test file
// (in a shared-process run) already registered a mock for `src/cli/paths`.
//
// NOTE: this must be a STATIC query-string import, NOT a top-level
// `await import(...)`. A top-level await defers `_REAL_PATHS` into the temporal
// dead zone, and a consuming file's `mock.module(...paths, () => createPathsMockPayload(...))`
// invokes the factory lazily at import-resolution time — which can run before
// the helper's top-level await settles, throwing "Cannot access '_REAL_PATHS'
// before initialization". A static import binds the namespace synchronously.
import * as _REAL_PATHS from "../../src/cli/paths.ts?real";

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
