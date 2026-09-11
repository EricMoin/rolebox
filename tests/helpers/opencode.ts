import { spawnSync } from "node:child_process";

// Shared test helper: detect whether a usable `opencode` binary is on PATH.
//
// The real-server integration tests (tests/integration/e2e-hooks.test.ts,
// tests/integration/loop.test.ts, tests/integration/concurrency.test.ts,
// tests/integration/dispatch.test.ts) spawn an actual `opencode serve`
// process via @opencode-ai/sdk. Those tests must SKIP GRACEFULLY on hosts
// without `opencode` (e.g. a GitHub Actions runner) rather than fail the
// suite with (unnamed) beforeAll/afterAll hook errors.

let cached: boolean | null = null;

/** Returns true when `opencode --version` succeeds (i.e. opencode is on PATH). */
export function hasOpencode(): boolean {
  if (cached !== null) return cached;
  const result = spawnSync("opencode", ["--version"], { stdio: "ignore" });
  cached = result.status === 0 && !result.error;
  return cached;
}
