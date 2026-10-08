// Project-wide LOG-DIRECTORY REDIRECT, installed through bunfig.toml's
// `[test] preload`.
//
// WHY. Before the platform pipeline, the test-time logger wrote into the
// workspace's own `.rolebox/logs/` — every `bun test` run left files inside the
// tree CI asserts is clean, and every suite that logged shared one file with the
// developer's real runs. src/log/** resolves its directory from ROLEBOX_LOG_DIR
// first, so a preload that points that variable at the OS temp directory moves
// every test-time record out of the repository without touching a single suite.
//
// ONE DIRECTORY PER TEST PROCESS. `bun test --isolate` runs each file in its own
// process, and the file sink's per-channel rotation is per-process bookkeeping;
// a per-pid directory keeps concurrent files from rotating each other's logs.
// Nothing is created here — the sink creates the directory lazily on the first
// record, so a suite that never logs touches no file system.
//
// AN EXPLICIT ROLEBOX_LOG_DIR WINS. A developer who exported the variable to
// watch a failing suite keeps that choice; a suite that sets its own (or
// ROLEBOX_LOG_FILE) still decides for itself, because both are read when the
// pipeline is built, i.e. after this preload has run.

import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.ROLEBOX_LOG_DIR && !process.env.ROLEBOX_LOG_FILE) {
  process.env.ROLEBOX_LOG_DIR = join(tmpdir(), "rolebox-test-logs", "pid-" + process.pid);
}
