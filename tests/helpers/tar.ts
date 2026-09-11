import { spawnSync } from "node:child_process";

// Shared test helper: detect whether a usable `tar` binary is on PATH.
//
// The real download/extraction tests (tests/cli/download-progress-streaming.test.ts,
// tests/cli/registry-client.test.ts, tests/cli/commands/install-realtime.test.ts)
// build a real tarball fixture and run it through the actual `tar xzf`
// extraction. Those tests are Unix-centric (they rely on `tar --version` and
// POSIX tar semantics) and must SKIP GRACEFULLY on hosts without `tar`
// (e.g. a minimal Windows image) rather than fail the suite.

let cached: boolean | null = null;

/** Returns true when `tar --version` succeeds (i.e. tar is on PATH). */
export function hasTar(): boolean {
  if (cached !== null) return cached;
  const result = spawnSync("tar", ["--version"], { stdio: "ignore" });
  cached = result.status === 0 && !result.error;
  return cached;
}
