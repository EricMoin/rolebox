/**
 * JSONC parsing: string-aware comment stripping and trailing-comma removal,
 * shared by the host-config readers (opencode's `opencode.jsonc`).
 *
 * Comment markers and closing delimiters inside string literals are data, and
 * `parseJsonc` keeps `JSON.parse`'s throw-on-malformed contract, so callers own
 * their fallback policy.
 */
import { describe, it, expect } from "bun:test";
import { parseJsonc, stripJsonComments } from "../../src/utils/jsonc.ts";

describe("stripJsonComments", () => {
  it("removes a whole-line and a trailing `//` comment", () => {
    expect(stripJsonComments('// header\n{"a": 1}')).toBe('\n{"a": 1}');
    expect(stripJsonComments('{"a": 1} // tail').trim()).toBe('{"a": 1}');
  });

  it("removes block comments", () => {
    expect(stripJsonComments('{ "a": 1 /* note */, "b": 2 }')).toBe('{ "a": 1 , "b": 2 }');
  });

  it("keeps comment markers inside string literals", () => {
    const url = '{"url": "https://example.test/a//b"}';
    expect(stripJsonComments(url)).toBe(url);

    const pattern = '{"pattern": "/* keep it */"}';
    expect(stripJsonComments(pattern)).toBe(pattern);
  });

  it("does not end a string at an escaped quote", () => {
    const text = String.raw`{"quote": "say \"hi\" // not a comment"}`;
    expect(stripJsonComments(text)).toBe(text);
  });
});

describe("parseJsonc", () => {
  it("round-trips plain JSON", () => {
    const doc = {
      provider: { oc: { models: { "gpt-4o": { name: "GPT-4o" } } } },
      list: [1, 2, 3],
      flags: { enabled: true, missing: null },
    };

    expect(parseJsonc(JSON.stringify(doc))).toEqual(doc);
  });

  it("ignores a single leading byte order mark", () => {
    expect(parseJsonc("\uFEFF" + JSON.stringify({ a: 1 }))).toEqual({ a: 1 });

    const withCommentsAndTrailingComma = '\uFEFF{\n  // comment\n  "a": [1, 2,],\n}';
    expect(parseJsonc(withCommentsAndTrailingComma)).toEqual({ a: [1, 2] });
  });

  it("still rejects a byte order mark that is not leading", () => {
    expect(() => parseJsonc('{"a": 1}\uFEFF')).toThrow();
  });

  it("parses a document with line and block comments", () => {
    const text = `{
      // The provider map
      "provider": { "oc": { "models": { "gpt-4o": { "name": "GPT-4o" } } } }, /* inline */
      "count": 2
    }`;

    expect(parseJsonc(text)).toEqual({
      provider: { oc: { models: { "gpt-4o": { name: "GPT-4o" } } } },
      count: 2,
    });
  });

  it("keeps comment markers that appear inside string literals", () => {
    expect(parseJsonc('{"url": "https://example.test/a//b"}')).toEqual({
      url: "https://example.test/a//b",
    });
    expect(parseJsonc('{"pattern": "/* not a comment */"}')).toEqual({
      pattern: "/* not a comment */",
    });
  });

  it("does not end a string at an escaped quote", () => {
    const text = String.raw`{"quote": "say \"hi\" // not a comment"}`;

    expect(parseJsonc(text)).toEqual({ quote: 'say "hi" // not a comment' });
  });

  it("removes trailing commas before `}` and `]`", () => {
    expect(parseJsonc('{ "a": 1, "b": [1, 2,], }')).toEqual({ a: 1, b: [1, 2] });
  });

  it("preserves a comma-then-brace inside a string literal", () => {
    expect(parseJsonc('{"literal": "a,}"}')).toEqual({ literal: "a,}" });
    expect(parseJsonc('{"literal": "a,]"}')).toEqual({ literal: "a,]" });
  });

  it("throws on malformed input", () => {
    expect(() => parseJsonc('{ "a": }')).toThrow();
    expect(() => parseJsonc('{"a": 1')).toThrow();
  });
});
