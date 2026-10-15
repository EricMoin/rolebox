import { spawnSync } from "node:child_process";

// Detect the v1 CLI required by the @opencode-ai/sdk integration tests.
//
// The real-server integration tests (tests/integration/e2e-hooks.test.ts,
// tests/integration/loop.test.ts, tests/integration/dispatch.test.ts) use the
// v1 SDK's startup protocol and API routes. A v2 CLI is incompatible even when
// `opencode --version` succeeds. Missing or incompatible CLIs skip these tests;
// probe failures and real server startup failures must remain failures.

let cached: boolean | null = null;

export function isOpencodeV1Version(output: string): boolean {
  const version = /^(?:opencode[ \t]+)?v?(0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(output.trim());
  if (!version) throw new Error("Unrecognized opencode --version output; cannot determine v1 SDK compatibility.");
  return version[1] === "1";
}

/** Returns whether PATH provides an OpenCode 1.x CLI for the v1 SDK tests. */
export function hasOpencode(): boolean {
  if (cached !== null) return cached;
  const result = spawnSync("opencode", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  });
  if (result.error) {
    if ("code" in result.error && result.error.code === "ENOENT") return cached = false;
    throw new Error("Failed to probe opencode --version within 5000ms.", { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(`opencode --version failed (exit ${result.status}, signal ${result.signal ?? "none"}).`);
  }
  cached = isOpencodeV1Version(result.stdout);
  return cached;
}
