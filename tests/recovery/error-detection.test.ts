/**
 * ─────────────────────────────────────────────────────────────────────
 * Sub-task 7: error-detection unit tests
 *
 * Covers PatternRegistry (register, detect, detectFirst, detectCategory,
 * clear) and createDefaultPatterns (all 7 patterns match appropriate
 * error signatures with category and errorType).
 * ─────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect, afterEach } from "bun:test";
import { PatternRegistry, createDefaultPatterns } from "../../src/recovery/error-detection.ts";
import type { RecoveryErrorCategory } from "../../src/recovery/types.ts";

describe("PatternRegistry", () => {
  let registry: PatternRegistry;

  afterEach(() => {
    registry?.clear();
  });

  it("starts with no patterns", () => {
    registry = new PatternRegistry();
    expect(registry.detect("anything")).toEqual([]);
    expect(registry.detectFirst("anything")).toBeNull();
  });

  it("register adds a pattern for detection", () => {
    registry = new PatternRegistry();
    registry.register({
      name: "test-pattern",
      category: "session_error",
      match: (err) =>
        typeof err === "string" && err.includes("TEST_ERR")
          ? { category: "session_error" as RecoveryErrorCategory, errorType: "test_type", message: err, timestamp: 1 }
          : null,
    });

    const results = registry.detect("this has TEST_ERR in it");
    expect(results).toHaveLength(1);
    expect(results[0].errorType).toBe("test_type");
  });

  it("detect returns all matching patterns", () => {
    registry = new PatternRegistry();
    registry.register({
      name: "pattern-a",
      category: "session_error",
      match: (err) =>
        typeof err === "string" && err.includes("ERR")
          ? { category: "session_error" as RecoveryErrorCategory, errorType: "a", message: err, timestamp: 1 }
          : null,
    });
    registry.register({
      name: "pattern-b",
      category: "session_error",
      match: (err) =>
        typeof err === "string" && err.includes("FOO")
          ? { category: "session_error" as RecoveryErrorCategory, errorType: "b", message: err, timestamp: 1 }
          : null,
    });

    // Both patterns match
    const results = registry.detect("ERR and FOO");
    expect(results).toHaveLength(2);

    // Only one matches
    const single = registry.detect("ERR only");
    expect(single).toHaveLength(1);
    expect(single[0].errorType).toBe("a");
  });

  it("detectFirst returns only the first match", () => {
    registry = new PatternRegistry();
    registry.register({
      name: "first",
      category: "session_error",
      match: (err) =>
        typeof err === "string" && err.includes("ERR")
          ? { category: "session_error" as RecoveryErrorCategory, errorType: "first", message: err, timestamp: 1 }
          : null,
    });
    registry.register({
      name: "second",
      category: "session_error",
      match: (err) =>
        typeof err === "string" && err.includes("ERR")
          ? { category: "session_error" as RecoveryErrorCategory, errorType: "second", message: err, timestamp: 1 }
          : null,
    });

    const result = registry.detectFirst("ERR here");
    expect(result).not.toBeNull();
    expect(result!.errorType).toBe("first");
  });

  it("detectCategory filters by category", () => {
    registry = new PatternRegistry();
    registry.register({
      name: "session-pattern",
      category: "session_error",
      match: (err) =>
        typeof err === "string" && err.includes("ERR")
          ? { category: "session_error" as RecoveryErrorCategory, errorType: "session", message: err, timestamp: 1 }
          : null,
    });
    registry.register({
      name: "edit-pattern",
      category: "edit_error",
      match: (err) =>
        typeof err === "string" && err.includes("ERR")
          ? { category: "edit_error" as RecoveryErrorCategory, errorType: "edit", message: err, timestamp: 1 }
          : null,
    });

    const sessionMatches = registry.detectCategory("ERR", "session_error");
    expect(sessionMatches).not.toBeNull();
    expect(sessionMatches!.errorType).toBe("session");

    const editMatches = registry.detectCategory("ERR", "edit_error");
    expect(editMatches).not.toBeNull();
    expect(editMatches!.errorType).toBe("edit");

    const guardMatches = registry.detectCategory("ERR", "guard_violation");
    expect(guardMatches).toBeNull();
  });

  it("detect returns empty array when nothing matches", () => {
    registry = new PatternRegistry();
    registry.register({
      name: "specific",
      category: "session_error",
      match: (err) =>
        typeof err === "string" && err === "SPECIFIC"
          ? { category: "session_error" as RecoveryErrorCategory, errorType: "specific", message: err, timestamp: 1 }
          : null,
    });

    expect(registry.detect("nothing relevant")).toEqual([]);
    expect(registry.detectFirst("nothing relevant")).toBeNull();
  });

  it("clear removes all patterns", () => {
    registry = new PatternRegistry();
    registry.register({
      name: "p",
      category: "session_error",
      match: () => ({ category: "session_error" as RecoveryErrorCategory, errorType: "t", message: "x", timestamp: 1 }),
    });
    expect(registry.detect("anything")).toHaveLength(1);
    registry.clear();
    expect(registry.detect("anything")).toEqual([]);
  });
});

// ── Default Patterns ─────────────────────────────────────────────────

describe("createDefaultPatterns", () => {
  it("returns 9 default patterns", () => {
    const patterns = createDefaultPatterns();
    expect(patterns).toHaveLength(9);
  });

  it("api-error pattern matches errors with error.type", () => {
    const patterns = createDefaultPatterns();
    const error = { error: { type: "rate_limit" }, message: "API rate limited" };
    for (const p of patterns) {
      const result = p.match(error);
      if (result) {
        expect(result.category).toBe("session_error");
        expect(result.errorType).toBe("api_error");
        return;
      }
    }
    expect.unreachable("No pattern matched api error");
  });

  it("api-error pattern matches errors with code field", () => {
    const patterns = createDefaultPatterns();
    const error = { code: 429, message: "Too Many Requests" };
    for (const p of patterns) {
      const result = p.match(error);
      if (result) {
        expect(result.category).toBe("session_error");
        expect(result.errorType).toBe("api_error");
        return;
      }
    }
    expect.unreachable("No pattern matched api error with code");
  });

  it("timeout pattern matches 'timed out' string", () => {
    const patterns = createDefaultPatterns();
    const match = patterns[1]; // timeout is index 1
    const result = match.match("connection timed out");
    expect(result).not.toBeNull();
    expect(result!.category).toBe("session_error");
    expect(result!.errorType).toBe("timeout");
  });

  it("timeout pattern matches deadline exceeded", () => {
    const patterns = createDefaultPatterns();
    const match = patterns[1];
    const result = match.match(new Error("deadline exceeded"));
    expect(result).not.toBeNull();
    expect(result!.errorType).toBe("timeout");
  });

  it("tool-unavailable pattern matches 'tool not found'", () => {
    const patterns = createDefaultPatterns();
    const match = patterns[2]; // tool-unavailable is index 2
    const result = match.match("The tool 'foobar' was not found");
    expect(result).not.toBeNull();
    expect(result!.category).toBe("session_error");
    expect(result!.errorType).toBe("unavailable_tool");
  });

  it("tool-unavailable pattern matches 'unknown tool'", () => {
    const patterns = createDefaultPatterns();
    const match = patterns[2];
    const result = match.match("unknown tool: xyz");
    expect(result).not.toBeNull();
    expect(result!.errorType).toBe("unavailable_tool");
  });

  it("token-limit pattern matches context_length_exceeded", () => {
    const patterns = createDefaultPatterns();
    const match = patterns[3];
    const result = match.match("context_length_exceeded");
    expect(result).not.toBeNull();
    expect(result!.category).toBe("context_window");
    expect(result!.errorType).toBe("token_limit");
  });

  it("token-limit pattern matches 'too many tokens'", () => {
    const patterns = createDefaultPatterns();
    const match = patterns[3];
    const result = match.match(new Error("too many tokens in the response"));
    expect(result).not.toBeNull();
    expect(result!.errorType).toBe("token_limit");
  });

  it("edit-not-found pattern matches 'oldString not found'", () => {
    const patterns = createDefaultPatterns();
    const match = patterns[4]; // edit-not-found is index 4
    const result = match.match("oldString not found in content");
    expect(result).not.toBeNull();
    expect(result!.category).toBe("edit_error");
    expect(result!.errorType).toBe("oldstring_not_found");
  });

  it("edit-multiple-matches pattern matches 'multiple matches'", () => {
    const patterns = createDefaultPatterns();
    const match = patterns[5]; // edit-multiple-matches is index 5
    const result = match.match("oldString found multiple times");
    expect(result).not.toBeNull();
    expect(result!.category).toBe("edit_error");
    expect(result!.errorType).toBe("multiple_matches");
  });

  it("edit-same-content pattern matches 'must be different'", () => {
    const patterns = createDefaultPatterns();
    const match = patterns[6]; // but wait, index 5 is edit-multiple-matches, index 6 would be edit-same-content
    // Actually let's check by counting: 0=api, 1=timeout, 2=tool, 3=token, 4=edit-not-found, 5=edit-multiple, 6=edit-same
    // No, there are only 7 patterns total: 0=api, 1=timeout, 2=tool, 3=token, 4=edit-not-found, 5=edit-multiple, 6=edit-same-content
    // Let's iterate to find by name
    for (const p of patterns) {
      if (p.name === "edit-same-content") {
        const result = p.match("oldString and newString must be different");
        expect(result).not.toBeNull();
        expect(result!.category).toBe("edit_error");
        expect(result!.errorType).toBe("same_content");
        return;
      }
    }
    expect.unreachable("edit-same-content pattern not found");
  });

  it("json-parse-error pattern matches 'Unexpected token'", () => {
    const patterns = createDefaultPatterns();
    for (const p of patterns) {
      if (p.name === "json-parse-error") {
        const result = p.match("Unexpected token '}' at position 42");
        expect(result).not.toBeNull();
        expect(result!.category).toBe("json_error");
        expect(result!.errorType).toBe("json_parse");
        return;
      }
    }
    expect.unreachable("json-parse-error pattern not found");
  });

  it("json-parse-error pattern matches 'invalid json'", () => {
    const patterns = createDefaultPatterns();
    for (const p of patterns) {
      if (p.name === "json-parse-error") {
        const result = p.match("Invalid JSON in tool arguments");
        expect(result).not.toBeNull();
        expect(result!.errorType).toBe("json_parse");
        return;
      }
    }
    expect.unreachable("json-parse-error pattern not found");
  });

  it("empty-response pattern matches object with short output", () => {
    const patterns = createDefaultPatterns();
    for (const p of patterns) {
      if (p.name === "empty-response") {
        const result = p.match({ output: "ab" });
        expect(result).not.toBeNull();
        expect(result!.category).toBe("empty_response");
        expect(result!.errorType).toBe("empty_output");
        return;
      }
    }
    expect.unreachable("empty-response pattern not found");
  });

  it("empty-response pattern matches short string", () => {
    const patterns = createDefaultPatterns();
    for (const p of patterns) {
      if (p.name === "empty-response") {
        const result = p.match("ok");
        expect(result).not.toBeNull();
        expect(result!.errorType).toBe("empty_output");
        return;
      }
    }
    expect.unreachable("empty-response pattern not found");
  });

  it("empty-response does not match long output", () => {
    const patterns = createDefaultPatterns();
    for (const p of patterns) {
      if (p.name === "empty-response") {
        const result = p.match({ output: "this is a long output that should not match" });
        expect(result).toBeNull();
        return;
      }
    }
    expect.unreachable("empty-response pattern not found");
  });

  it("non-matching error returns null from all patterns", () => {
    const patterns = createDefaultPatterns();
    for (const p of patterns) {
      expect(p.match("completely normal operation")).toBeNull();
    }
  });
});
