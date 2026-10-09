/**
 * JSONC parsing: the single length-preserving sanitizing walk behind
 * `parseJsonc` and `stripJsonComments`, shared by the host-config readers
 * (opencode's `opencode.jsonc`).
 *
 * Comment markers and closing delimiters inside string literals are data,
 * comments and dropped trailing commas are blanked rather than deleted (so a
 * position in the sanitized text still maps back to the original document),
 * and `parseJsonc` keeps `JSON.parse`'s throw-on-malformed contract, so callers
 * own their fallback policy.
 */
import { describe, it, expect } from "bun:test";
import { parseJsonc, stripJsonComments } from "../../src/utils/jsonc.ts";

/** The four characters JSON accepts as a line terminator. */
const LINE_TERMINATORS = "\n\r\u2028\u2029";

/** Indexes of every line terminator, for the position invariants. */
function lineTerminatorIndexes(text: string): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (LINE_TERMINATORS.includes(text[i])) indexes.push(i);
  }
  return indexes;
}

describe("stripJsonComments", () => {
  it("blanks a whole-line and a trailing `//` comment in place", () => {
    // `// header` is nine code units, so nine spaces; the `\n` keeps its index.
    expect(stripJsonComments('// header\n{"a": 1}')).toBe(`${" ".repeat(9)}\n{"a": 1}`);
    expect(stripJsonComments('{"a": 1} // tail').trim()).toBe('{"a": 1}');
    expect(stripJsonComments('{"a": 1} // tail')).toBe(`{"a": 1} ${" ".repeat(7)}`);
  });

  it("blanks block comments and preserves the document's length", () => {
    const input = '{ "a": 1 /* note */, "b": 2 }';
    const output = stripJsonComments(input);

    expect(output).toBe(`{ "a": 1 ${" ".repeat(10)}, "b": 2 }`);
    expect(output.length).toBe(input.length);
  });

  it("keeps a `//` comment's line terminator at its original index", () => {
    const input = '{ "a": 1, // note\n  "b": 2 }';
    const output = stripJsonComments(input);

    // Nothing but the comment region changes: `// note` becomes seven spaces.
    expect(output).toBe(`{ "a": 1, ${" ".repeat(7)}\n  "b": 2 }`);
    expect(output.length).toBe(input.length);
    expect(output.indexOf("\n")).toBe(input.indexOf("\n"));
  });

  it("blanks a line terminator inside a block comment without moving it", () => {
    const input = '{ /* one\ntwo */ "a": 1 }';
    const output = stripJsonComments(input);

    expect(output).toBe(`{ ${" ".repeat(13)} "a": 1 }`);
    expect(output.length).toBe(input.length);
    expect(output[input.indexOf("\n")]).toBe(" ");
  });

  it("ends a `//` comment at `\\r`, U+2028 or U+2029 too", () => {
    for (const terminator of ["\r", "\r\n", "\u2028", "\u2029"]) {
      const text = `{"a":1, // c${terminator}"b":2}`;
      const output = stripJsonComments(text);

      expect(output.length).toBe(text.length);
      expect(parseJsonc(text)).toEqual({ a: 1, b: 2 });

      if (terminator === "\u2028" || terminator === "\u2029") {
        // Not JSON whitespace: the comment owns this terminator and blanks it.
        expect(output[text.indexOf(terminator)]).toBe(" ");
      } else {
        expect(output[text.indexOf("\r")]).toBe("\r");
      }
    }
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

  it("blanks a single leading byte order mark in place", () => {
    const input = '\uFEFF{"a": 1}';
    const output = stripJsonComments(input);

    expect(output).toBe(' {"a": 1}');
    expect(output.length).toBe(input.length);
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

  it("does not glue the tokens on either side of a comment", () => {
    // A comment used to be deleted, so `1` and `2` were concatenated into the
    // single token `12` and this malformed document silently parsed.
    expect(() => parseJsonc('{"a": 1/*c*/2}')).toThrow();
    expect(parseJsonc('{"a": 1/*c*/}')).toEqual({ a: 1 });
    expect(parseJsonc('{"a": 1/*c*/, "b": 2}')).toEqual({ a: 1, b: 2 });
  });

  it("does not let a quote or a brace inside a comment confuse the walk", () => {
    expect(parseJsonc('{/* " */ "a": 1}')).toEqual({ a: 1 });
    expect(parseJsonc('{/* } */ "a": 1}')).toEqual({ a: 1 });
    expect(parseJsonc('{"a": 1 /* ] */}')).toEqual({ a: 1 });
  });

  it("blanks an unterminated block comment through end of input", () => {
    expect(parseJsonc('{"a": 1} /* oops')).toEqual({ a: 1 });
    expect(() => parseJsonc('{"a": /* oops')).toThrow();
  });

  it("drops a trailing comma that a comment separates from the closer", () => {
    expect(parseJsonc('{"a": [1, 2, /* c */],}')).toEqual({ a: [1, 2] });
    expect(parseJsonc('{"a": [1, 2, // c\n],}')).toEqual({ a: [1, 2] });
  });

  it("keeps a trailing comma at end of input so `JSON.parse` still throws", () => {
    expect(() => parseJsonc("[1, 2,")).toThrow();
    expect(parseJsonc("[1, 2,]")).toEqual([1, 2]);
  });

  it("does not treat `\\v`, `\\f`, NBSP or U+FEFF as whitespace", () => {
    expect(() => parseJsonc("[1, 2,\v]")).toThrow();
    expect(() => parseJsonc("[1, 2,\f]")).toThrow();
    expect(() => parseJsonc("[1, 2,\u00a0]")).toThrow();
    expect(() => parseJsonc("[1, 2,\uFEFF]")).toThrow();
  });

  it("throws on malformed input", () => {
    expect(() => parseJsonc('{ "a": }')).toThrow();
    expect(() => parseJsonc('{"a": 1')).toThrow();
  });
});

describe("sanitizing invariants", () => {
  const corpus = [
    '{"a": 1, "b": [1, 2, 3]}',
    '{\n  // header\n  "a": 1, // tail\n  "b": [1, 2,],\n}',
    '{/* 🚀 emoji in a comment */ "a": 1}',
    '{\r\n  // crlf\r\n  "a": 1\r\n}',
    '{\r\n  "a": 1,\u2028  "b": [1, 2]\r\n}',
    '\uFEFF{"a": 1}',
  ];

  it("preserves length, offsets and every surviving line terminator", () => {
    for (const text of corpus) {
      const output = stripJsonComments(text);

      expect(output.length).toBe(text.length);

      // The walk never shifts text: every index either keeps its original
      // character or holds the space that replaced comment content.
      for (let i = 0; i < text.length; i++) {
        if (output[i] !== text[i]) expect(output[i]).toBe(" ");
      }

      // No comment in this corpus consumes a line terminator, so all four
      // survive at their original indexes.
      expect(lineTerminatorIndexes(output)).toEqual(lineTerminatorIndexes(text));
    }
  });

  it("blanks an astral character in a comment as two code units", () => {
    const input = '{/* 🚀 */"a": 1}';
    const output = stripJsonComments(input);

    // `/* 🚀 */` is eight UTF-16 code units: a `for...of` walk would count the
    // emoji as one and shorten the document by one.
    expect(output).toBe(`{${" ".repeat(8)}"a": 1}`);
    expect(output.length).toBe(input.length);
    expect(parseJsonc(input)).toEqual({ a: 1 });
  });
});

describe("comment lookahead guard", () => {
  // `skipComment` is also called by the trailing-comma lookahead, which probes
  // whatever position follows a comma. It must only read a comment where the
  // character AT that position is the `/`; otherwise "any character followed
  // by a slash" looked like a comment opener, so a comma that is NOT trailing
  // was dropped and a comma that IS trailing was kept.
  it("keeps a comma in front of a string whose first character is `/`", () => {
    expect(parseJsonc('[1, "/x"\n]')).toEqual([1, "/x"]);

    // The realistic host-config shape: a list of `/`-leading paths.
    expect(parseJsonc('{\n  "paths": [\n    "/a",\n    "/b"\n  ]\n}')).toEqual({
      paths: ["/a", "/b"],
    });
    expect(parseJsonc('[\n  "/a",\n  "/b"\n]')).toEqual(["/a", "/b"]);
  });

  it("drops a trailing comma a comment sits between the closer and", () => {
    expect(parseJsonc("[1,2,]/*x*/")).toEqual([1, 2]);
    expect(parseJsonc('{"a":1,}/*x*/')).toEqual({ a: 1 });
    expect(parseJsonc("[1, 2,]// c")).toEqual([1, 2]);
    expect(parseJsonc('[{"a":1,}/*x*/]')).toEqual([{ a: 1 }]);
  });

  it("keeps a string literal that begins with a comment opener", () => {
    expect(parseJsonc('[1, "/* keep */"]')).toEqual([1, "/* keep */"]);
    expect(parseJsonc('[1, "// keep"]')).toEqual([1, "// keep"]);
  });

  it("still rejects malformed input the lookahead must not repair", () => {
    // A colon inside an array is invalid JSONC; the guard restores the
    // documented contract, it does not make malformed documents parse.
    expect(() => parseJsonc('[\n  "paths": [\n    "/a",\n    "/b"\n  ]\n]')).toThrow();
  });

  it("keeps the length and offset invariant for a `/`-leading token", () => {
    const input = '[1, "/x"\n]';
    const output = stripJsonComments(input);

    // Nothing in this document is a comment or a trailing comma, so the
    // sanitizing walk must return it unchanged.
    expect(output).toBe(input);
    expect(output.length).toBe(input.length);
  });
});
