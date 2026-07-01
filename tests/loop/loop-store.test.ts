import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LoopStore } from "../../src/loop/loop-store.ts";
import type { LoopState } from "../../src/loop/types.ts";

describe("LoopStore", () => {
  let tempDir: string;
  let store: LoopStore;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "loop-store-test-"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("save → load round-trips a Map with 2 entries", async () => {
    store = new LoopStore(tempDir);

    const loop1: LoopState = {
      originSessionId: "ses_001",
      agent: "test-agent",
      prompt: "do something",
      mode: "inherit",
      total: 5,
      current: 2,
      status: "running",
      activeSessionId: "ses_002",
      cancelRequested: false,
      startedAt: 1000,
      updatedAt: 2000,
      roundStartedAt: 1500,
      schemaVersion: 1,
    };

    const loop2: LoopState = {
      originSessionId: "ses_010",
      agent: "other-agent",
      prompt: "build feature",
      mode: "fresh",
      total: 3,
      current: 1,
      status: "waiting",
      activeSessionId: "ses_011",
      cancelRequested: true,
      startedAt: 3000,
      updatedAt: 4000,
      roundStartedAt: 3500,
      lastSummary: "round 1 done",
      schemaVersion: 1,
    };

    const input = new Map<string, LoopState>([
      ["loop-1", loop1],
      ["loop-2", loop2],
    ]);

    await store.save(input);

    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.size).toBe(2);
    expect(loaded!.get("loop-1")).toEqual(loop1);
    expect(loaded!.get("loop-2")).toEqual(loop2);
  });

  it("corrupt JSON → load() returns null", () => {
    store = new LoopStore(tempDir);
    const { shortHash } = require("../../src/state-paths.ts");
    const stateDir = join(tempDir, ".rolebox", "state");
    mkdirSync(stateDir, { recursive: true });
    const filePath = join(stateDir, `loops-${shortHash(tempDir)}.json`);
    writeFileSync(filePath, "not valid json {{{");

    const result = store.load();
    expect(result).toBeNull();
  });

  it("version mismatch → load() returns null", () => {
    store = new LoopStore(tempDir);
    const { shortHash } = require("../../src/state-paths.ts");
    const stateDir = join(tempDir, ".rolebox", "state");
    mkdirSync(stateDir, { recursive: true });
    const filePath = join(stateDir, `loops-${shortHash(tempDir)}.json`);
    writeFileSync(filePath, JSON.stringify({ version: 2, loops: [] }));

    const result = store.load();
    expect(result).toBeNull();
  });

  it("empty file → load() returns null", () => {
    store = new LoopStore(tempDir);
    const { shortHash } = require("../../src/state-paths.ts");
    const stateDir = join(tempDir, ".rolebox", "state");
    mkdirSync(stateDir, { recursive: true });
    const filePath = join(stateDir, `loops-${shortHash(tempDir)}.json`);
    writeFileSync(filePath, "");

    const result = store.load();
    expect(result).toBeNull();
  });

  it("saveSync → load round-trips correctly", () => {
    store = new LoopStore(tempDir);

    const loop: LoopState = {
      originSessionId: "ses_sync",
      agent: "sync-agent",
      prompt: "sync test",
      mode: "fresh",
      total: 1,
      current: 1,
      status: "complete",
      activeSessionId: "ses_sync_001",
      cancelRequested: false,
      startedAt: 5000,
      updatedAt: 6000,
      roundStartedAt: 5000,
      schemaVersion: 1,
    };

    const input = new Map<string, LoopState>([["sync-loop", loop]]);
    store.saveSync(input);

    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.size).toBe(1);
    expect(loaded!.get("sync-loop")).toEqual(loop);
  });
});
