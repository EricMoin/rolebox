// Shared test helper: re-exports the production symlink helpers so CLI-command
// tests can create cross-platform directory/file symlinks in their fixtures.
//
// Background: a bare `fs.symlinkSync` on a directory throws EPERM on Windows
// without Developer Mode, which takes out the whole fixture setup for tests
// that simulate an already-synced role. The production helpers
// (src/utils/symlink.ts) already handle this by using a "junction" for
// directory symlinks on win32 (junctions need no admin rights). Re-exporting
// keeps the tests exercising the SAME code path as production `sync` instead of
// diverging test-only semantics.
//
// WINDOWS JUNCTION TARGET REQUIREMENT: libuv's `fs__create_junction` (src/win/
// fs.c) rejects any target that is not an absolute DRIVE path (`X:\...`). A
// POSIX-style target like "/nonexistent/dead" fails with UV_EINVAL on Windows.
// The target does NOT need to exist — junctions store the target string and
// resolve it at access time — so broken-link fixtures must pass a target built
// from `join(tmpdir(), ...)`, which is an absolute drive path on Windows and an
// absolute POSIX path on Unix.
import {
  createDirSymlink,
  createFileSymlink,
  isSymlink,
} from "../../src/utils/symlink.ts";

export { createDirSymlink, createFileSymlink, isSymlink };
