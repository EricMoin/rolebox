import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanExpiredState } from "../../src/dispatch/persistence/state-gc.ts";

describe("cleanExpiredState", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `state-gc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("removes dispatch state files older than retention period", async () => {
    const oldFile = join(testDir, "dispatch-abc123.json");
    const oldLock = join(testDir, "dispatch-abc123.json.lock");
    writeFileSync(oldFile, "{}");
    writeFileSync(oldLock, "");

    // Set mtime to 10 days ago
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, tenDaysAgo, tenDaysAgo);
    utimesSync(oldLock, tenDaysAgo, tenDaysAgo);

    const result = await cleanExpiredState(testDir);
    expect(result.removed).toBe(2);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(oldLock)).toBe(false);
  });

  it("does NOT remove files newer than retention period", async () => {
    const recentFile = join(testDir, "dispatch-recent123.json");
    writeFileSync(recentFile, "{}");
    // mtime is "now" by default — within retention

    const result = await cleanExpiredState(testDir);
    expect(result.removed).toBe(0);
    expect(existsSync(recentFile)).toBe(true);
  });

  it("does NOT remove non-dispatch files", async () => {
    const otherFile = join(testDir, "memory-abc123.json");
    writeFileSync(otherFile, "{}");

    // Set mtime to 10 days ago
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(otherFile, tenDaysAgo, tenDaysAgo);

    const result = await cleanExpiredState(testDir);
    expect(result.removed).toBe(0);
    expect(existsSync(otherFile)).toBe(true);
  });

  it("handles non-existent directory gracefully", async () => {
    const result = await cleanExpiredState("/tmp/does-not-exist-xyzzy");
    expect(result.removed).toBe(0);
  });

  it("handles empty directory", async () => {
    const result = await cleanExpiredState(testDir);
    expect(result.removed).toBe(0);
  });

  it("respects custom retention period", async () => {
    const file = join(testDir, "dispatch-custom456.json");
    writeFileSync(file, "{}");

    // Set mtime to 2 days ago
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(file, twoDaysAgo, twoDaysAgo);

    // With 3-day retention, file should NOT be removed
    let result = await cleanExpiredState(testDir, 3 * 24 * 60 * 60 * 1000);
    expect(result.removed).toBe(0);
    expect(existsSync(file)).toBe(true);

    // With 1-day retention, file SHOULD be removed
    result = await cleanExpiredState(testDir, 1 * 24 * 60 * 60 * 1000);
    expect(result.removed).toBe(1);
    expect(existsSync(file)).toBe(false);
  });

  it("handles mixed old and new files", async () => {
    const oldFile = join(testDir, "dispatch-old111.json");
    const newFile = join(testDir, "dispatch-new222.json");
    writeFileSync(oldFile, "{}");
    writeFileSync(newFile, "{}");

    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, tenDaysAgo, tenDaysAgo);

    const result = await cleanExpiredState(testDir);
    expect(result.removed).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
  });
});
