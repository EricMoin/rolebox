import { setDefaultTimeout } from "bun:test";

// Project-wide per-test timeout, installed through bunfig.toml's `[test]
// preload` (Bun 1.3.14 ignores a `[test] timeout` key, but honors this one).
//
// The value is derived from the suites it has to keep alive, not arbitrary. The
// cross-process suites spawn REAL `bun` child processes and declare their own
// budgets — the largest is CHILD_DEADLINE_MS = 30_000 (e.g.
// tests/graph/host-restart-cross-process.test.ts:65), with BARRIER_DEADLINE_MS
// = 15_000 (line 67) for the dispatch barrier. Bun's default cap of 5000ms sits
// BELOW both, so a slow child spawn killed the whole test with Bun's opaque
// "timed out after 5000ms" before the file's own kill-and-report path could run
// and name the child that overran. 45_000 clears the largest declared child
// deadline with room for the parent's own bookkeeping, so that path stays
// reachable.
//
// This is only a DEFAULT: an explicit per-test timeout still wins over it — see
// tests/platform/pi-worker-sandbox.test.ts's `}, 20_000)` and
// tests/loop/stale-lock-sweeper.test.ts's `}, 20_000)`.
setDefaultTimeout(45_000);
