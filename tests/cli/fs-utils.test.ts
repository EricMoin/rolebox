import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
