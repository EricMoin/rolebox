/**
 * Tests for buildSessionScope — builds a set of session IDs belonging to a
 * parent session by reading dispatch-*.json files from a state directory.
 *
 * All tests use temporary directories (mkdtempSync) so there is zero
 * dependency on real dispatch files.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSessionScope } from "../../src/utils/session-scope";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Create a temp dir that is cleaned up on process exit. */
function tmpStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "session-scope-test-"));
  return dir;
}

/** Write a dispatch-<name>.json file into `dir` with the given tasks. */
function writeDispatch(
  dir: string,
  name: string,
  tasks: Array<{ parentSessionId?: string; sessionId?: string }>,
): void {
  writeFileSync(
    join(dir, `dispatch-${name}.json`),
    JSON.stringify({ tasks }, null, 2),
    "utf-8",
  );
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("buildSessionScope", () => {
  test("returns a set containing the currentSessionId even when no dispatch files exist", () => {
    const dir = tmpStateDir();
    const result = buildSessionScope(dir, "session-A");
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(1);
    expect(result.has("session-A")).toBe(true);
  });

  test("finds child sessions from dispatch files with matching parentSessionId", () => {
    const dir = tmpStateDir();
    writeDispatch(dir, "task1", [
      { parentSessionId: "parent-X", sessionId: "child-1" },
      { parentSessionId: "parent-X", sessionId: "child-2" },
    ]);

    const result = buildSessionScope(dir, "parent-X");
    expect(result.has("parent-X")).toBe(true);
    expect(result.has("child-1")).toBe(true);
    expect(result.has("child-2")).toBe(true);
    expect(result.size).toBe(3);
  });

  test("does not include child sessions belonging to a different parent", () => {
    const dir = tmpStateDir();
    writeDispatch(dir, "other", [
      { parentSessionId: "other-parent", sessionId: "other-child" },
    ]);

    const result = buildSessionScope(dir, "my-parent");
    expect(result.has("my-parent")).toBe(true);
    expect(result.has("other-child")).toBe(false);
    expect(result.size).toBe(1);
  });

  test("handles a missing / non-existent state directory gracefully", () => {
    const missingDir = join(tmpdir(), "i-do-not-exist-99999");
    const result = buildSessionScope(missingDir, "session-Z");
    expect(result.has("session-Z")).toBe(true);
    expect(result.size).toBe(1);
  });

  test("handles malformed JSON in a dispatch file gracefully", () => {
    const dir = tmpStateDir();
    // Write an invalid JSON file
    writeFileSync(join(dir, "dispatch-corrupt.json"), "not valid json{{{", "utf-8");

    const result = buildSessionScope(dir, "session-A");
    // Should silently skip the corrupt file and still include currentSessionId
    expect(result.has("session-A")).toBe(true);
    expect(result.size).toBe(1);
  });

  test("handles an empty tasks array", () => {
    const dir = tmpStateDir();
    writeDispatch(dir, "empty", []);

    const result = buildSessionScope(dir, "session-B");
    expect(result.has("session-B")).toBe(true);
    expect(result.size).toBe(1);
  });

  test("ignores non-dispatch files in the state directory", () => {
    const dir = tmpStateDir();
    // Non-dispatch JSON files should be ignored
    writeFileSync(join(dir, "some-other.json"), JSON.stringify({ tasks: [{ parentSessionId: "injector", sessionId: "injected" }] }), "utf-8");
    writeFileSync(join(dir, "readme.txt"), "hello", "utf-8");

    const result = buildSessionScope(dir, "session-C");
    expect(result.has("session-C")).toBe(true);
    // The non-dispatch file with matching parentSessionId must NOT be picked up
    expect(result.has("injected")).toBe(false);
    expect(result.size).toBe(1);
  });

  test("scans multiple dispatch files and aggregates all children for the same parent", () => {
    const dir = tmpStateDir();
    writeDispatch(dir, "alpha", [
      { parentSessionId: "root", sessionId: "child-A1" },
    ]);
    writeDispatch(dir, "beta", [
      { parentSessionId: "root", sessionId: "child-B1" },
    ]);
    writeDispatch(dir, "gamma", [
      { parentSessionId: "root", sessionId: "child-C1" },
      { parentSessionId: "root", sessionId: "child-C2" },
    ]);

    const result = buildSessionScope(dir, "root");
    expect(result.has("root")).toBe(true);
    expect(result.has("child-A1")).toBe(true);
    expect(result.has("child-B1")).toBe(true);
    expect(result.has("child-C1")).toBe(true);
    expect(result.has("child-C2")).toBe(true);
    expect(result.size).toBe(5);
  });

  test("skips entries where sessionId is missing or empty", () => {
    const dir = tmpStateDir();
    writeDispatch(dir, "partial", [
      { parentSessionId: "parent-Y", sessionId: "valid-child" },
      { parentSessionId: "parent-Y" },                          // no sessionId
      { parentSessionId: "parent-Y", sessionId: "" },           // empty string
    ]);

    const result = buildSessionScope(dir, "parent-Y");
    expect(result.has("parent-Y")).toBe(true);
    expect(result.has("valid-child")).toBe(true);
    // Only the valid child should be included
    expect(result.size).toBe(2);
  });
});
