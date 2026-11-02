/**
 * Tests for buildSessionScope — builds the OBSERVABLE session scope (the
 * transitive dispatch subtree of a session) by reading dispatch-*.json files
 * from a state directory.
 *
 * All tests use temporary directories (mkdtempSync) that are removed after
 * each case, so there is zero dependency on real dispatch files and the tree
 * stays clean.
 */
import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSessionScope } from "../../src/utils/session-scope.ts";

// ── Helpers ──────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

/** Create a temp dir that is removed after the current case. */
function tmpStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "session-scope-test-"));
  tempDirs.push(dir);
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

/** The result's session IDs as a sorted array, for whole-scope comparisons. */
function ids(result: { sessionIds: Set<string> }): string[] {
  return [...result.sessionIds].sort();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("buildSessionScope", () => {
  test("happy path: complete scope with the current session and its direct children", () => {
    const dir = tmpStateDir();
    writeDispatch(dir, "task1", [
      { parentSessionId: "parent-X", sessionId: "child-1" },
      { parentSessionId: "parent-X", sessionId: "child-2" },
      { parentSessionId: "other-parent", sessionId: "foreign-child" },
    ]);

    const result = buildSessionScope(dir, "parent-X");
    expect(result.complete).toBe(true);
    expect(result.problems).toEqual([]);
    expect(ids(result)).toEqual(["child-1", "child-2", "parent-X"]);
  });

  test("an absent state directory is an empty source, not a failure", () => {
    const dir = tmpStateDir();
    const missingDir = join(dir, "absent");

    const result = buildSessionScope(missingDir, "session-Z");
    expect(result.complete).toBe(true);
    expect(result.problems).toEqual([]);
    expect(ids(result)).toEqual(["session-Z"]);
  });

  test("an empty state directory contains only the current session", () => {
    const dir = tmpStateDir();
    const result = buildSessionScope(dir, "session-A");
    expect(result.complete).toBe(true);
    expect(result.problems).toEqual([]);
    expect(ids(result)).toEqual(["session-A"]);
  });

  test("reports a malformed JSON file but still reads every other dispatch file", () => {
    const dir = tmpStateDir();
    const corrupt = join(dir, "dispatch-corrupt.json");
    writeFileSync(corrupt, "not valid json{{{", "utf-8");
    writeDispatch(dir, "good", [{ parentSessionId: "session-A", sessionId: "readable-child" }]);

    const result = buildSessionScope(dir, "session-A");
    expect(result.complete).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ code: "malformed-file", path: corrupt });
    // The failure is recorded rather than swallowed: the other readable file's
    // child is still discovered.
    expect(result.sessionIds.has("readable-child")).toBe(true);
  });

  test("reports a dispatch file whose JSON has no tasks array", () => {
    const dir = tmpStateDir();
    const path = join(dir, "dispatch-shape.json");
    writeFileSync(path, JSON.stringify({ version: 5 }, null, 2), "utf-8");

    const result = buildSessionScope(dir, "session-A");
    expect(result.complete).toBe(false);
    expect(result.problems).toEqual([
      { code: "malformed-file", path, message: "dispatch state has no tasks array" },
    ]);
  });

  test("reports a dispatch file whose JSON value is not an object", () => {
    const dir = tmpStateDir();
    const path = join(dir, "dispatch-null.json");
    writeFileSync(path, "null", "utf-8");

    const result = buildSessionScope(dir, "session-A");
    expect(result.complete).toBe(false);
    expect(result.problems).toEqual([
      { code: "malformed-file", path, message: "dispatch state has no tasks array" },
    ]);
  });

  test("reports a stateDir that is a regular file as directory-unreadable", () => {
    const dir = tmpStateDir();
    const fileAsDir = join(dir, "state-is-a-file");
    writeFileSync(fileAsDir, "not a directory", "utf-8");

    const result = buildSessionScope(fileAsDir, "session-A");
    expect(result.complete).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ code: "directory-unreadable", path: fileAsDir });
    expect(result.problems[0].message).not.toBe("");
    expect(result.sessionIds.has("session-A")).toBe(true);
  });

  test("reports a dispatch-*.json that is a directory as file-unreadable", () => {
    const dir = tmpStateDir();
    const dirAsFile = join(dir, "dispatch-directory.json");
    mkdirSync(dirAsFile);

    const result = buildSessionScope(dir, "session-A");
    expect(result.complete).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ code: "file-unreadable", path: dirAsFile });
    expect(result.problems[0].message).not.toBe("");
    expect(result.sessionIds.has("session-A")).toBe(true);
  });

  test("follows the dispatch-parent chain transitively (A -> B -> C)", () => {
    const dir = tmpStateDir();
    writeDispatch(dir, "chain", [
      { parentSessionId: "session-A", sessionId: "session-B" },
      { parentSessionId: "session-B", sessionId: "session-C" },
    ]);

    const result = buildSessionScope(dir, "session-A");
    expect(result.complete).toBe(true);
    expect(ids(result)).toEqual(["session-A", "session-B", "session-C"]);
  });

  test("terminates on a dispatch cycle and includes every session once", () => {
    const dir = tmpStateDir();
    writeDispatch(dir, "cycle", [
      { parentSessionId: "session-A", sessionId: "session-B" },
      { parentSessionId: "session-B", sessionId: "session-A" },
    ]);

    const result = buildSessionScope(dir, "session-A");
    expect(result.complete).toBe(true);
    expect(ids(result)).toEqual(["session-A", "session-B"]);
  });

  test("seeds extraSessionIds and discovers their dispatch children", () => {
    const dir = tmpStateDir();
    writeDispatch(dir, "graph", [
      { parentSessionId: "graph-scope-key", sessionId: "worker-1" },
      { parentSessionId: "worker-1", sessionId: "worker-2" },
    ]);

    const result = buildSessionScope(dir, "session-A", {
      // The empty entry is not a session ID and must not become a seed.
      extraSessionIds: ["graph-scope-key", ""],
    });
    expect(result.complete).toBe(true);
    expect(ids(result)).toEqual(["graph-scope-key", "session-A", "worker-1", "worker-2"]);
  });

  test("does not include child sessions belonging to a different parent", () => {
    const dir = tmpStateDir();
    writeDispatch(dir, "other", [
      { parentSessionId: "other-parent", sessionId: "other-child" },
    ]);

    const result = buildSessionScope(dir, "my-parent");
    expect(result.complete).toBe(true);
    expect(ids(result)).toEqual(["my-parent"]);
  });

  test("handles an empty tasks array", () => {
    const dir = tmpStateDir();
    writeDispatch(dir, "empty", []);

    const result = buildSessionScope(dir, "session-B");
    expect(result.complete).toBe(true);
    expect(result.problems).toEqual([]);
    expect(ids(result)).toEqual(["session-B"]);
  });

  test("ignores non-dispatch files and dispatch lock/temp siblings", () => {
    const dir = tmpStateDir();
    // Non-dispatch JSON files should be ignored.
    writeFileSync(join(dir, "some-other.json"), JSON.stringify({ tasks: [{ parentSessionId: "injector", sessionId: "injected" }] }), "utf-8");
    writeFileSync(join(dir, "readme.txt"), "hello", "utf-8");
    // `.json.lock` and `.json.tmp` siblings are not parsed dispatch state.
    writeFileSync(join(dir, "dispatch-other.json.lock"), JSON.stringify({ tasks: [{ parentSessionId: "session-C", sessionId: "locked-child" }] }), "utf-8");
    writeFileSync(join(dir, "dispatch-other.json.tmp"), JSON.stringify({ tasks: [{ parentSessionId: "session-C", sessionId: "temp-child" }] }), "utf-8");

    const result = buildSessionScope(dir, "session-C");
    expect(result.complete).toBe(true);
    expect(result.problems).toEqual([]);
    expect(ids(result)).toEqual(["session-C"]);
  });

  test("skips rows with missing/empty ids and non-object rows without reporting them", () => {
    const dir = tmpStateDir();
    writeDispatch(dir, "partial", [
      { parentSessionId: "parent-Y", sessionId: "valid-child" },
      { parentSessionId: "parent-Y" },                          // no sessionId
      { parentSessionId: "parent-Y", sessionId: "" },           // empty string
      { sessionId: "no-parent" },                               // no parentSessionId
    ]);
    // Non-object row noise is skipped, not treated as a source failure.
    writeFileSync(
      join(dir, "dispatch-rows.json"),
      JSON.stringify({ tasks: [42, null, "row", []] }),
      "utf-8",
    );

    const result = buildSessionScope(dir, "parent-Y");
    expect(result.complete).toBe(true);
    expect(result.problems).toEqual([]);
    expect(ids(result)).toEqual(["parent-Y", "valid-child"]);
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
    expect(result.complete).toBe(true);
    expect(ids(result)).toEqual(["child-A1", "child-B1", "child-C1", "child-C2", "root"]);
  });
});
