import { describe, it, expect, spyOn, afterEach } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDirSymlink,
  createFileSymlink,
  isSymlink,
} from "../../src/utils/symlink.ts";
import { setPlatformForTest } from "../../src/cli/paths.ts";

afterEach(() => {
  setPlatformForTest(undefined);
});

describe("createDirSymlink / createFileSymlink (non-win32 branch)", () => {
  it("createDirSymlink on a real temp dir produces an entry for which isSymlink() is true", () => {
    const tmp = mkdtempSync(join(tmpdir(), "rolebox-symlink-dir-"));
    try {
      const targetDir = join(tmp, "target");
      mkdirSync(targetDir, { recursive: true });
      const link = join(tmp, "link");
      createDirSymlink(targetDir, link);
      expect(isSymlink(link)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("createFileSymlink on a real temp file produces an entry for which isSymlink() is true", () => {
    const tmp = mkdtempSync(join(tmpdir(), "rolebox-symlink-file-"));
    try {
      const targetFile = join(tmp, "target.txt");
      writeFileSync(targetFile, "hello");
      const link = join(tmp, "link.txt");
      createFileSymlink(targetFile, link);
      expect(isSymlink(link)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("win32 branch passes the correct type argument", () => {
  it("createDirSymlink passes 'junction' as the third argument", () => {
    setPlatformForTest("win32");
    const calls: string[][] = [];
    const spy = spyOn(fs, "symlinkSync");
    spy.mockImplementation((target: string, link: string, type?: string) => {
      calls.push([target, link, type ?? "undefined"]);
    });
    try {
      createDirSymlink("C:\\target", "C:\\link");
      expect(calls).toEqual([["C:\\target", "C:\\link", "junction"]]);
    } finally {
      spy.mockRestore();
      setPlatformForTest(undefined);
    }
  });

  it("createFileSymlink passes 'file' as the third argument", () => {
    setPlatformForTest("win32");
    const calls: string[][] = [];
    const spy = spyOn(fs, "symlinkSync");
    spy.mockImplementation((target: string, link: string, type?: string) => {
      calls.push([target, link, type ?? "undefined"]);
    });
    try {
      createFileSymlink("C:\\target.txt", "C:\\link.txt");
      expect(calls).toEqual([["C:\\target.txt", "C:\\link.txt", "file"]]);
    } finally {
      spy.mockRestore();
      setPlatformForTest(undefined);
    }
  });
});

describe("isSymlink", () => {
  it("returns false for a non-existent path (ENOENT)", () => {
    expect(isSymlink(join(tmpdir(), "rolebox-does-not-exist-xyz"))).toBe(false);
  });
});
