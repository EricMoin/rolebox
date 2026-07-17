/**
 * Tests for BudgetTracker persistence — persist() / restore() and debounced
 * writing from recordUsage().
 *
 * Run: bun test tests/dispatch/budget-persist.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BudgetTracker } from "../../src/dispatch/budget/budget-tracker.ts";
import { DEFAULT_CONFIG } from "../../src/dispatch/config.ts";

describe("BudgetTracker persistence", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "budget-persist-"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Clean up any state files between tests
    const stateDir = join(tempDir, ".rolebox", "state");
    try { rmSync(stateDir, { recursive: true, force: true }); } catch {}
  });

  function budgetPath(): string {
    const { shortHash } = require("../../src/utils/state-paths.ts");
    return join(tempDir, ".rolebox", "state", `budget-${shortHash(tempDir)}.json`);
  }

  // ── T1: persist() writes a valid file ─────────────────────────────

  it("persist() writes a file that can be read back", () => {
    const tracker = new BudgetTracker(DEFAULT_CONFIG, tempDir);
    tracker.recordUsage("s1", "p1", { input: 100, output: 50 }, 0.01);

    // Call persist() directly (bypass debounce)
    tracker.persist();

    const path = budgetPath();
    expect(existsSync(path)).toBe(true);

    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.requestUsage).toBeDefined();
    expect(parsed.sessionUsage).toBeDefined();
  });

  // ── T2: restore() reads back the Maps ─────────────────────────────

  it("restore() recovers usage Maps from disk", () => {
    const tracker1 = new BudgetTracker(DEFAULT_CONFIG, tempDir);
    tracker1.recordUsage("s1", "parent1", { input: 200, output: 100 }, 0.02);
    tracker1.recordUsage("s2", "parent1", { input: 50, output: 25 }, 0.005);
    tracker1.persist();

    // Create a second tracker — should restore from the same file
    const tracker2 = new BudgetTracker(DEFAULT_CONFIG, tempDir);

    const reqUsage = tracker2.getRequestUsage("parent1");
    expect(reqUsage.inputTokens).toBe(250);
    expect(reqUsage.outputTokens).toBe(125);
    expect(reqUsage.cost).toBeCloseTo(0.025, 6);

    const ses1 = tracker2.getSessionUsage("s1");
    expect(ses1.inputTokens).toBe(200);
    expect(ses1.outputTokens).toBe(100);

    const ses2 = tracker2.getSessionUsage("s2");
    expect(ses2.inputTokens).toBe(50);
    expect(ses2.outputTokens).toBe(25);
  });

  // ── T3: Missing file → starts fresh ───────────────────────────────

  it("restore() starts fresh when file is missing", () => {
    const tracker = new BudgetTracker(DEFAULT_CONFIG, tempDir);
    // No file written yet — should start with empty Maps
    expect(tracker.getRequestUsage("any")).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    });
    expect(tracker.getSessionUsage("any")).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    });
  });

  // ── T4: Corrupt file → starts fresh ───────────────────────────────

  it("restore() starts fresh when file is corrupt", () => {
    const path = budgetPath();
    mkdirSync(join(tempDir, ".rolebox", "state"), { recursive: true });
    require("node:fs").writeFileSync(path, "not valid json {{{");

    const tracker = new BudgetTracker(DEFAULT_CONFIG, tempDir);
    expect(tracker.getRequestUsage("any")).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    });
  });

  // ── T5: Version mismatch → starts fresh ───────────────────────────

  it("restore() starts fresh on version mismatch", () => {
    const path = budgetPath();
    mkdirSync(join(tempDir, ".rolebox", "state"), { recursive: true });
    require("node:fs").writeFileSync(
      path,
      JSON.stringify({ version: 2, requestUsage: [], sessionUsage: [] }),
    );

    const tracker = new BudgetTracker(DEFAULT_CONFIG, tempDir);
    expect(tracker.getRequestUsage("any")).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    });
  });

  // ── T6: recordUsage() triggers debounced persist ──────────────────

  it("recordUsage() triggers debounced persist (waits for 200ms timer)", async () => {
    const tracker = new BudgetTracker(DEFAULT_CONFIG, tempDir);

    // Before recordUsage, no file exists
    const path = budgetPath();
    expect(existsSync(path)).toBe(false);

    tracker.recordUsage("s-debounce", "p-debounce", { input: 10, output: 5 }, 0.001);

    // Immediately after call, timer is pending — file may not exist yet
    // Wait for debounce (200ms) + small buffer
    await new Promise((r) => setTimeout(r, 300));

    // After debounce, file should exist
    expect(existsSync(path)).toBe(true);

    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.sessionUsage.length).toBe(1);
    expect(parsed.requestUsage.length).toBe(1);
  });

  // ── T7: Atomic write pattern leaves no .tmp file ──────────────────

  it("persist() leaves no .tmp file after write", () => {
    const tracker = new BudgetTracker(DEFAULT_CONFIG, tempDir);
    tracker.recordUsage("s-tmp", "p-tmp", { input: 1, output: 1 }, 0.001);
    tracker.persist();

    const stateDir = join(tempDir, ".rolebox", "state");
    const tmpFiles = require("node:fs")
      .readdirSync(stateDir)
      .filter((f: string) => f.endsWith(".tmp"));
    expect(tmpFiles.length).toBe(0);
  });
});
