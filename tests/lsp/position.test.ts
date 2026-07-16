import { describe, it, expect } from "bun:test";
import { offsetToPosition, positionToOffset } from "../../src/lsp/position.ts";

describe("offsetToPosition", () => {
  it("clamps negative offset to zero", () => {
    expect(offsetToPosition("hello", -1)).toEqual({ line: 0, character: 0 });
  });

  it("clamps offset beyond text length to text length", () => {
    expect(offsetToPosition("hi", 100)).toEqual({ line: 0, character: 2 });
  });

  it("returns line 0, character 0 for offset 0 on empty string", () => {
    expect(offsetToPosition("", 0)).toEqual({ line: 0, character: 0 });
  });

  it("returns correct position for single-line text", () => {
    expect(offsetToPosition("hello world", 5)).toEqual({ line: 0, character: 5 });
  });

  it("counts newlines and resets character", () => {
    // "abc\nde\nf" — offset 4 is just past 'c', on the newline
    // offset 4 = past 'a','b','c' at positions 0,1,2, then '\n' at 3
    // charCodeAt(3) = 0x0a → line=1, character=0
    expect(offsetToPosition("abc\nde\nf", 4)).toEqual({ line: 1, character: 0 });
    // offset 5 = after '\n' and 'd' → line=1, character=1
    expect(offsetToPosition("abc\nde\nf", 5)).toEqual({ line: 1, character: 1 });
    // offset 6 = after '\n', 'd', 'e' → line=1, character=2
    expect(offsetToPosition("abc\nde\nf", 6)).toEqual({ line: 1, character: 2 });
    // offset 7 = second '\n' → line=2, character=0
    expect(offsetToPosition("abc\nde\nf", 7)).toEqual({ line: 2, character: 0 });
    // offset 8 = 'f' → line=2, character=1
    expect(offsetToPosition("abc\nde\nf", 8)).toEqual({ line: 2, character: 1 });
  });

  it("handles empty text", () => {
    expect(offsetToPosition("", 0)).toEqual({ line: 0, character: 0 });
  });

  it("handles multi-line with trailing newline", () => {
    // "a\nb\n" — 4 chars
    expect(offsetToPosition("a\nb\n", 0)).toEqual({ line: 0, character: 0 }); // 'a'
    expect(offsetToPosition("a\nb\n", 1)).toEqual({ line: 0, character: 1 }); // '\n'
    // offset=2: charCodeAt(1)=0x0a → line=1, char=0 ('b')
    expect(offsetToPosition("a\nb\n", 2)).toEqual({ line: 1, character: 0 }); // 'b'
    // offset=3: charCodeAt(2)=0x62 ('b') → 'b' is not 0x0a, char=1, then... wait
    // let me recheck: offset=3 means i=0..2
    // i=0: 'a' (0x61) not 0x0a → char=1
    // i=1: '\n' (0x0a) → line=1 char=0
    // i=2: 'b' (0x62) not 0x0a → char=1
    // So line=1, character=1 (offset is at the second '\n')
    expect(offsetToPosition("a\nb\n", 3)).toEqual({ line: 1, character: 1 }); // second '\n'
  });

  it("increments character for each non-newline byte", () => {
    expect(offsetToPosition("abc", 2)).toEqual({ line: 0, character: 2 });
  });

  it("handles surrogate pairs — high surrogate (U+D800..U+DBFF) counts as 1", () => {
    // Emoji '😀' (U+1F600) = 0xD83D 0xDE00 in UTF-16
    const text = "a😀b";
    // offset 0 = 'a' → {0,0}
    expect(offsetToPosition(text, 0)).toEqual({ line: 0, character: 0 });
    // offset 1 = high surrogate 0xD83D → code in [0xD800, 0xDBFF] → char becomes 1
    expect(offsetToPosition(text, 1)).toEqual({ line: 0, character: 1 });
    // offset 2 = low surrogate 0xDE00 → code in [0xDC00, 0xDFFF] → char becomes 2
    expect(offsetToPosition(text, 2)).toEqual({ line: 0, character: 2 });
    // offset 3 = 'b' → char becomes 3
    expect(offsetToPosition(text, 3)).toEqual({ line: 0, character: 3 });
    // LSP spec: the emoji counts as 2 UTF-16 code units = 2 characters
  });

  it("handles surrogate pairs across newline boundaries", () => {
    // '😀\n😀' = 6 UTF-16 code units
    const text = "😀\n😀";
    // actual offset 3 to hit the '\n' at index 2
    // offset=0: high surrogate → char=1
    // offset=1: low surrogate → char=2
    // offset=2: newline NOT yet reached (processed i=0,1 only)
    expect(offsetToPosition(text, 3)).toEqual({ line: 1, character: 0 });
    expect(offsetToPosition(text, 4)).toEqual({ line: 1, character: 1 });
    // offset=5: low surrogate → char=2
    expect(offsetToPosition(text, 5)).toEqual({ line: 1, character: 2 });


  });
});

describe("positionToOffset", () => {
  it("returns offset 0 for position {0,0}", () => {
    expect(positionToOffset("hello", { line: 0, character: 0 })).toBe(0);
  });

  it("returns correct offset for single-line position", () => {
    expect(positionToOffset("hello world", { line: 0, character: 5 })).toBe(5);
  });

  it("returns text.length when line exceeds actual line count", () => {
    const text = "hello\nworld";
    expect(positionToOffset(text, { line: 5, character: 0 })).toBe(text.length);
  });

  it("returns correct offset for second-line position", () => {
    const text = "line1\nline2\nline3";
    // line 1 starts at offset 6 ('l' of 'line2')
    // character 3 = offset 6+3 = 9
    expect(positionToOffset(text, { line: 1, character: 3 })).toBe(9);
  });

  it("stops at newline boundary when character exceeds line length", () => {
    const text = "ab\nc";
    // line 0 has 2 chars + newline = offset 2 is start of newline
    expect(positionToOffset(text, { line: 0, character: 10 })).toBe(2);
  });

  it("handles position at the very end of text", () => {
    const text = "hello";
    expect(positionToOffset(text, { line: 0, character: 5 })).toBe(5);
  });

  it("returns 0 for position {0,0} on empty string", () => {
    expect(positionToOffset("", { line: 0, character: 0 })).toBe(0);
  });

  it("returns text.length for out-of-range line on empty string", () => {
    expect(positionToOffset("", { line: 1, character: 0 })).toBe(0);
  });
});

describe("round-trip consistency", () => {
  it("round-trips offset→position→offset for single line", () => {
    const text = "hello world";
    for (let offset = 0; offset <= text.length; offset++) {
      const pos = offsetToPosition(text, offset);
      const back = positionToOffset(text, pos);
      expect(back).toBe(offset);
    }
  });

  it("round-trips offset→position→offset for multi-line text", () => {
    const text = "line1\nline2\nline3";
    for (let offset = 0; offset <= text.length; offset++) {
      const pos = offsetToPosition(text, offset);
      const back = positionToOffset(text, pos);
      expect(back).toBe(offset);
    }
  });

  it("round-trips offset→position→offset with emoji", () => {
    const text = "a😀\n😀b";
    for (let offset = 0; offset <= text.length; offset++) {
      const pos = offsetToPosition(text, offset);
      const back = positionToOffset(text, pos);
      expect(back).toBe(offset);
    }
  });

  it("round-trips offset→position→offset with CJK characters", () => {
    const text = "你好\n世界";
    for (let offset = 0; offset <= text.length; offset++) {
      const pos = offsetToPosition(text, offset);
      const back = positionToOffset(text, pos);
      expect(back).toBe(offset);
    }
  });
});
