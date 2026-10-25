// Partial path mocks preserve every real export and override only fixture directories.
import * as _REAL_PATHS from "../../src/cli/paths.ts?real";

export interface PathsMockOpts {
  /** Override for getDataDir. */
  getDataDir?: () => string;
  /** Override for getConfigDir. */
  getConfigDir?: () => string;
  /** Additional named exports to override (e.g. getSyncTarget, getOpencodeSkillsDir). */
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
