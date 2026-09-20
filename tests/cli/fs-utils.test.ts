import { describe, it, expect, mock, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  lstatSync,
  chmodSync,
  readdirSync,
} from "node:fs";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as realFs from "node:fs";
import { moveDir, ensureWritableDir } from "../../src/cli/fs-utils";

describe("moveDir", () => {
  it("moves a directory (recursively) and removes the source", () => {
    const base = mkdtempSync(join(tmpdir(), "rolebox-move-"));
    const src = join(base, "src");
    const dest = join(base, "dest");
    mkdirSync(join(src, "nested"), { recursive: true });
    writeFileSync(join(src, "nested", "f.txt"), "hello");

    moveDir(src, dest);

    expect(existsSync(src)).toBe(false);
    expect(readFileSync(join(dest, "nested", "f.txt"), "utf-8")).toBe("hello");

    rmSync(base, { recursive: true, force: true });
  });

  it("refuses an existing destination before the rename (same device)", () => {
    const base = mkdtempSync(join(tmpdir(), "rolebox-move-exists-"));
    try {
      const src = join(base, "src");
      const dest = join(base, "dest");
      mkdirSync(src, { recursive: true });
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(src, "new.js"), "v2");
      writeFileSync(join(dest, "stale.js"), "v1");

      const err = capturedError(() => moveDir(src, dest));

      expect(err?.message).toContain(src);
      expect(err?.message).toContain(dest);
      expect(err?.message).toMatch(/destination already exists/);
      // The guard fires before rename(2), so an existing destination is never
      // merged with or overwritten: the raw ENOTEMPTY path is unreachable.
      expect(readdirSync(dest).sort()).toEqual(["stale.js"]);
      expect(readFileSync(join(dest, "stale.js"), "utf-8")).toBe("v1");
      expect(existsSync(join(src, "new.js"))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // Creating symlinks on Windows needs privileges this suite does not assume.
  it.skipIf(process.platform === "win32")(
    "refuses a dangling symlink destination and leaves the link intact",
    () => {
      const base = mkdtempSync(join(tmpdir(), "rolebox-move-dangling-"));
      try {
        const src = join(base, "src");
        const dest = join(base, "dest");
        mkdirSync(src, { recursive: true });
        writeFileSync(join(src, "new.js"), "v2");
        symlinkSync(join(base, "missing-target"), dest);

        const err = capturedError(() => moveDir(src, dest));

        expect(err?.message).toMatch(/destination already exists/);
        // lstatSync counts the dangling link as an existing destination.
        // existsSync follows it, sees no target, and lets rename(2) replace the
        // link (raw ENOTDIR on this device) or cpSync delete it on the EXDEV path.
        expect(lstatSync(dest).isSymbolicLink()).toBe(true);
        expect(readlinkSync(dest)).toBe(join(base, "missing-target"));
        expect(existsSync(join(src, "new.js"))).toBe(true);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it("propagates non-EXDEV rename errors", () => {
    const base = mkdtempSync(join(tmpdir(), "rolebox-move-err-"));
    const src = join(base, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "f.txt"), "x");

    // Destination's parent does not exist → rename fails (ENOENT), not EXDEV.
    expect(() => moveDir(src, join(base, "missing", "dest"))).toThrow();

    // Source is left intact on failure.
    expect(existsSync(src)).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });
});

describe("ensureWritableDir", () => {
  it("creates a nested dir and is a no-op once present", () => {
    const base = mkdtempSync(join(tmpdir(), "rolebox-ensure-"));
    const dir = join(base, "a", "b", "c");

    ensureWritableDir(dir);
    expect(existsSync(dir)).toBe(true);

    // Idempotent.
    ensureWritableDir(dir);
    expect(existsSync(dir)).toBe(true);

    rmSync(base, { recursive: true, force: true });
  });
});

// ── Fault-injected coverage for the EXDEV fallback and errno classification ──
//
// A cross-device rename (EXDEV) needs two filesystems and EPERM/EROFS need a
// read-only volume, so node:fs is mocked with delegating overrides driven by the
// "faults" object below. mock.module() overwrites the exports of the already
// loaded node:fs namespace in place, so the real implementations are captured
// first and each override delegates to them unless a fault is set. Faults are
// only ever set inside the tests below and reset in their finally blocks, so the
// two suites above keep their real behaviour, and mock.restore() in afterAll
// drops the mock again when the suite runs in a shared process.

const faults: { exdev: boolean; mkdirCode: string | undefined } = {
  exdev: false,
  mkdirCode: undefined,
};

// Captured before mock.module() replaces the namespace exports (calling
// realFs.renameSync inside an override would otherwise re-enter the override).
const realRenameSync = realFs.renameSync;
const realMkdirSync = realFs.mkdirSync;
const realCpSync = realFs.cpSync;

function errnoError(
  message: string,
  code: string,
  errno: number,
): Error & { code: string; errno: number } {
  return Object.assign(new Error(message), { code, errno });
}

/**
 * Emulate Node's documented cpSync default (verbatimSymlinks: false), which
 * resolves a relative symlink target to an absolute path inside the source tree
 * before creating the link in the destination. Verified on Node v26.4.0: copying
 * a "./real.txt" link yields "/<src>/nested/real.txt" by default and
 * "./real.txt" with verbatimSymlinks: true (Bun 1.3.14 preserves the relative
 * target either way, so this only bites under Node). Without the emulation the
 * relative-symlink test below would pass on Bun even if the source dropped
 * verbatimSymlinks, and a Node user would still get a broken link.
 */
function emulateNodeSymlinkDefault(src: string, dest: string): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcChild = join(src, entry.name);
    const destChild = join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      const target = readlinkSync(srcChild);
      if (!isAbsolute(target)) {
        rmSync(destChild, { force: true });
        symlinkSync(resolve(dirname(srcChild), target), destChild);
      }
    } else if (entry.isDirectory()) {
      emulateNodeSymlinkDefault(srcChild, destChild);
    }
  }
}

mock.module("node:fs", () => ({
  ...realFs,
  renameSync: (oldPath: string, newPath: string): void => {
    if (faults.exdev) {
      throw errnoError("EXDEV: cross-device link not permitted, rename", "EXDEV", -18);
    }
    realRenameSync(oldPath, newPath);
  },
  mkdirSync: (dir: string, options: { recursive?: boolean }): string | undefined => {
    if (faults.mkdirCode !== undefined) {
      const message = faults.mkdirCode + ": injected failure, mkdir '" + dir + "'";
      throw errnoError(message, faults.mkdirCode, -1);
    }
    return realMkdirSync(dir, options);
  },
  cpSync: (
    src: string,
    dest: string,
    options?: { recursive?: boolean; verbatimSymlinks?: boolean },
  ): void => {
    realCpSync(src, dest, options);
    if (options?.verbatimSymlinks !== true) emulateNodeSymlinkDefault(src, dest);
  },
}));

const EXDEV_MODULE = "../../src/cli/fs-utils.ts?exdev";
const exdevFsUtils: typeof import("../../src/cli/fs-utils.ts") = await import(EXDEV_MODULE);
const moveDirExdev = exdevFsUtils.moveDir;
const ensureWritableDirExdev = exdevFsUtils.ensureWritableDir;

afterAll(() => {
  mock.restore();
});

/** Run "fn" and return the Error it threw, or undefined when it did not throw. */
function capturedError(fn: () => void): Error | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

describe("moveDir (EXDEV fallback)", () => {
  it("moves the tree recursively to an absent destination and removes the source", () => {
    const base = mkdtempSync(join(tmpdir(), "rolebox-exdev-move-"));
    try {
      const src = join(base, "src");
      const dest = join(base, "dest");
      mkdirSync(join(src, "nested"), { recursive: true });
      writeFileSync(join(src, "nested", "f.txt"), "hello");

      faults.exdev = true;
      moveDirExdev(src, dest);

      expect(existsSync(src)).toBe(false);
      expect(readFileSync(join(dest, "nested", "f.txt"), "utf-8")).toBe("hello");
    } finally {
      faults.exdev = false;
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("refuses an existing destination instead of merging into it", () => {
    const base = mkdtempSync(join(tmpdir(), "rolebox-exdev-merge-"));
    try {
      const src = join(base, "src");
      const dest = join(base, "dest");
      mkdirSync(src, { recursive: true });
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(src, "new.js"), "v2");
      writeFileSync(join(dest, "stale.js"), "v1");

      faults.exdev = true;
      const err = capturedError(() => moveDirExdev(src, dest));

      expect(err?.message).toContain(src);
      expect(err?.message).toContain(dest);
      expect(err?.message).toMatch(/destination already exists/);
      // Regression: the old EXDEV fallback merged the trees and reported success.
      expect(readdirSync(dest).sort()).toEqual(["stale.js"]);
      expect(readFileSync(join(dest, "stale.js"), "utf-8")).toBe("v1");
      expect(existsSync(join(src, "new.js"))).toBe(true);
    } finally {
      faults.exdev = false;
      rmSync(base, { recursive: true, force: true });
    }
  });

  // Windows symlink creation needs privileges this suite does not assume.
  it.skipIf(process.platform === "win32")("preserves a relative symlink target through the copy", () => {
    const base = mkdtempSync(join(tmpdir(), "rolebox-exdev-link-"));
    try {
      const src = join(base, "src");
      const dest = join(base, "dest");
      mkdirSync(join(src, "nested"), { recursive: true });
      writeFileSync(join(src, "nested", "real.txt"), "hi");
      symlinkSync("./real.txt", join(src, "nested", "link.txt"));

      faults.exdev = true;
      moveDirExdev(src, dest);

      const link = join(dest, "nested", "link.txt");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe("./real.txt");
      expect(readFileSync(link, "utf-8")).toBe("hi");
      expect(existsSync(src)).toBe(false);
    } finally {
      faults.exdev = false;
      rmSync(base, { recursive: true, force: true });
    }
  });

  // chmod has no effect on Windows write permission (ACLs, not POSIX mode bits).
  it.skipIf(process.platform === "win32")(
    "removes the partial destination and keeps the source when the copy fails",
    () => {
      const base = mkdtempSync(join(tmpdir(), "rolebox-exdev-partial-"));
      const unreadable = join(base, "src", "secret.txt");
      try {
        const src = join(base, "src");
        const dest = join(base, "dest");
        mkdirSync(src, { recursive: true });
        writeFileSync(join(src, "readable.txt"), "ok");
        writeFileSync(unreadable, "no");
        chmodSync(unreadable, 0o000);

        faults.exdev = true;
        const err = capturedError(() => moveDirExdev(src, dest));

        expect(err).toBeInstanceOf(Error);
        expect(String(err)).toMatch(/EACCES|EPERM/);
        expect(existsSync(dest)).toBe(false);
        expect(existsSync(src)).toBe(true);
        expect(readFileSync(join(src, "readable.txt"), "utf-8")).toBe("ok");

        chmodSync(unreadable, 0o600);
        expect(readFileSync(unreadable, "utf-8")).toBe("no");
      } finally {
        faults.exdev = false;
        try { chmodSync(unreadable, 0o600); } catch { /* best-effort */ }
        rmSync(base, { recursive: true, force: true });
      }
    },
  );
});

describe("ensureWritableDir (errno classification)", () => {
  it("reports a regular file where a directory is expected (EEXIST)", () => {
    const base = mkdtempSync(join(tmpdir(), "rolebox-dir-eexist-"));
    try {
      const file = join(base, "afile");
      writeFileSync(file, "x");

      const err = capturedError(() => ensureWritableDirExdev(file));

      expect(err?.message).toContain(file);
      expect(err?.message).toMatch(/exists but is not a directory/);
      expect(err?.cause).toBeDefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports a file used as a path component (ENOTDIR)", () => {
    const base = mkdtempSync(join(tmpdir(), "rolebox-dir-enotdir-"));
    try {
      const file = join(base, "afile");
      writeFileSync(file, "x");
      const nested = join(file, "sub");

      const err = capturedError(() => ensureWritableDirExdev(nested));

      expect(err?.message).toContain(nested);
      expect(err?.message).toMatch(/a path component is not a directory/);
      expect(err?.cause).toBeDefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  for (const code of ["EPERM", "EROFS"]) {
    it("classifies " + code + " from mkdir as the actionable not-writable error", () => {
      const base = mkdtempSync(join(tmpdir(), "rolebox-dir-code-"));
      try {
        faults.mkdirCode = code;
        const dir = join(base, "a", "b");

        const err = capturedError(() => ensureWritableDirExdev(dir));

        expect(err?.message).toMatch(
          /is not writable; set ROLEBOX_CONFIG_DIR \/ ROLEBOX_DATA_DIR or fix permissions/,
        );
        expect(err?.message).toContain(dir);
        expect(err?.cause).toBeDefined();
      } finally {
        faults.mkdirCode = undefined;
        rmSync(base, { recursive: true, force: true });
      }
    });
  }

  // chmod has no effect on Windows write permission (ACLs, not POSIX mode bits),
  // so the pre-check cannot fail there; the whole case is skipped.
  it.skipIf(process.platform === "win32")(
    "rejects a directory that is writable but not searchable (W_OK alone is not enough)",
    () => {
      const base = mkdtempSync(join(tmpdir(), "rolebox-dir-search-"));
      const dir = join(base, "d200");
      try {
        mkdirSync(dir, { recursive: true });
        chmodSync(dir, 0o200); // write only: creating an entry inside it needs search

        const err = capturedError(() => ensureWritableDir(dir));

        expect(err?.message).toMatch(/is not writable/);
      } finally {
        try { chmodSync(dir, 0o700); } catch { /* best-effort: restore search permission */ }
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  // chmod has no effect on Windows write permission (ACLs, not POSIX mode bits).
  it.skipIf(process.platform === "win32")(
    "names a path containing $& verbatim in the not-writable error",
    () => {
      const base = mkdtempSync(join(tmpdir(), "rolebox-dir-dollar-"));
      const dir = join(base, "ro$&lebox");
      try {
        mkdirSync(dir, { recursive: true });
        chmodSync(dir, 0o500); // read + execute only: not writable

        const err = capturedError(() => ensureWritableDir(dir));

        // String.replace("%s", dir) would expand $& to the matched substring.
        expect(err?.message).toContain(dir);
      } finally {
        try { chmodSync(dir, 0o700); } catch { /* best-effort: restore write permission */ }
        rmSync(base, { recursive: true, force: true });
      }
    },
  );
});

