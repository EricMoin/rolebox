import { describe, it, expect } from "bun:test";
import {
  MAX_RESPONSE_BYTES,
  decodeText,
  readBodyCapped,
  sniffCharset,
  toArrayBuffer,
} from "../../src/web/response-body";

/** Build a Response whose body streams the given chunks. */
function chunkedResponse(chunks: Uint8Array[], init: ResponseInit = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, init);
}

function repeat(byte: number, length: number): Uint8Array {
  return new Uint8Array(length).fill(byte);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

// -----------------------------------------------------------------------
// readBodyCapped
// -----------------------------------------------------------------------

describe("readBodyCapped", () => {
  it("exposes the 20 MiB default cap", () => {
    expect(MAX_RESPONSE_BYTES).toBe(20 * 1024 * 1024);
  });

  it("truncates a streamed body at the cap and cancels the reader", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(repeat(65, 600));
        controller.enqueue(repeat(66, 600));
        controller.enqueue(repeat(67, 600));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });

    const { bytes, truncated } = await readBodyCapped(new Response(stream), 1024);

    expect(truncated).toBe(true);
    expect(bytes.byteLength).toBe(1024);
    expect(bytes[0]).toBe(65);
    expect(bytes[1023]).toBe(66);
    expect(cancelled).toBe(true);
  });

  it("returns the whole body when it fits under the cap", async () => {
    const response = chunkedResponse([repeat(65, 400), repeat(66, 400)]);
    const { bytes, truncated } = await readBodyCapped(response, 1024);

    expect(truncated).toBe(false);
    expect(bytes.byteLength).toBe(800);
    expect(bytes[799]).toBe(66);
  });

  it("uses Content-Length above the cap as a fast path", async () => {
    const response = chunkedResponse([repeat(65, 500), repeat(66, 500), repeat(67, 500)], {
      headers: { "content-length": "5000" },
    });

    const { bytes, truncated } = await readBodyCapped(response, 1024);

    expect(truncated).toBe(true);
    expect(bytes.byteLength).toBe(1024);
  });

  it("falls back to arrayBuffer when there is no body stream", async () => {
    const { bytes, truncated } = await readBodyCapped(new Response(null, { status: 204 }), 1024);

    expect(truncated).toBe(false);
    expect(bytes.byteLength).toBe(0);
  });

  it("surfaces a rejected body stream as an Error", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("body boom");
      },
    });

    await expect(readBodyCapped(new Response(stream), 1024)).rejects.toThrow("body boom");
  });
});

// -----------------------------------------------------------------------
// toArrayBuffer
// -----------------------------------------------------------------------

describe("toArrayBuffer", () => {
  it("copies exactly the view's bytes without over-reading", () => {
    const base = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const view = base.subarray(1, 4);

    const buffer = toArrayBuffer(view);

    expect(buffer.byteLength).toBe(3);
    expect(Array.from(new Uint8Array(buffer))).toEqual([2, 3, 4]);
  });
});

// -----------------------------------------------------------------------
// sniffCharset / decodeText
// -----------------------------------------------------------------------

describe("sniffCharset", () => {
  const encode = (text: string) => new TextEncoder().encode(text);

  it("finds a meta charset tag", () => {
    expect(sniffCharset(encode('<html><head><meta charset="UTF-8"></head>'))).toBe("utf-8");
  });

  it("finds a meta http-equiv content-type charset", () => {
    const html = '<meta http-equiv="Content-Type" content="text/html; charset=gb2312">';
    expect(sniffCharset(encode(html))).toBe("gbk");
  });

  it("finds an XML declaration encoding", () => {
    expect(sniffCharset(encode('<?xml version="1.0" encoding="shift_jis"?>'))).toBe("shift_jis");
  });

  it("returns null when nothing is declared", () => {
    expect(sniffCharset(encode("<html><body>plain</body></html>"))).toBeNull();
    expect(sniffCharset(new Uint8Array(0))).toBeNull();
  });
});

describe("decodeText", () => {
  // GBK bytes for 中文: 中 = D6 D0, 文 = CE C4.
  const gbkChinese = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);

  it("decodes an explicitly declared charset (GBK)", () => {
    const { text, charset } = decodeText(gbkChinese, "text/html; charset=gbk");

    expect(text).toBe("中文");
    expect(charset).toBe("gbk");
  });

  it("normalizes the gb2312 alias and quoted labels", () => {
    const { text, charset } = decodeText(gbkChinese, 'text/html; charset="GB2312"');

    expect(text).toBe("中文");
    expect(charset).toBe("gbk");
  });

  it("sniffs a meta charset when the header declares none", () => {
    const head = new TextEncoder().encode('<html><head><meta charset="gbk"></head><body>');
    const { text, charset } = decodeText(concatBytes(head, new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])), "text/html");

    expect(charset).toBe("gbk");
    expect(text).toContain("中文");
  });

  it("strips a UTF-8 BOM", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    const { text, charset } = decodeText(bytes, "text/html; charset=utf-8");

    expect(text).toBe("hi");
    expect(charset).toBe("utf-8");
  });

  it("decodes a UTF-16LE BOM body", () => {
    // BOM + 中文 encoded as UTF-16LE (中 = 2D 4E, 文 = 87 65).
    const bytes = new Uint8Array([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]);
    const { text, charset } = decodeText(bytes);

    expect(text).toBe("中文");
    expect(charset).toBe("utf-16le");
  });

  it("falls back to utf-8 for an unsupported charset label", () => {
    const bytes = new TextEncoder().encode("plain ascii");
    const { text, charset } = decodeText(bytes, "text/plain; charset=made-up-charset");

    expect(text).toBe("plain ascii");
    expect(charset).toBe("utf-8");
  });

  it("keeps plain utf-8 behaviour with no charset information", () => {
    const source = "héllo — ünïcode 中文";
    const { text, charset } = decodeText(new TextEncoder().encode(source), "text/plain");

    expect(text).toBe(source);
    expect(charset).toBe("utf-8");
  });

  it("drops the partial multi-byte character left by a byte cap", async () => {
    // 中 = E4 B8 AD, 文 = E6 96 87; a 5-byte cap cuts 文 in half.
    const response = chunkedResponse([new Uint8Array([0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87])]);
    const { bytes, truncated } = await readBodyCapped(response, 5);
    expect(truncated).toBe(true);

    const { text, charset } = decodeText(bytes, "text/html; charset=utf-8");

    expect(charset).toBe("utf-8");
    expect(text).toBe("中");
    expect(text.includes("\uFFFD")).toBe(false);
  });

  it("drops a partial character for a declared legacy charset too", () => {
    // GBK 中文 = D6 D0 CE C4; the trailing byte of 文 is missing.
    const { text, charset } = decodeText(new Uint8Array([0xd6, 0xd0, 0xce]), "text/html; charset=gbk");

    expect(charset).toBe("gbk");
    expect(text).toBe("中");
  });

  it("decodes a partial-only tail to an empty string", () => {
    // 中 = E4 B8 AD, 😀 = F0 9F 98 80: each value is an incomplete multi-byte
    // sequence and nothing else, so no replacement glyph may survive.
    const partials = [
      new Uint8Array([0xe4]),
      new Uint8Array([0xe4, 0xb8]),
      new Uint8Array([0xf0, 0x9f, 0x98]),
    ];

    for (const bytes of partials) {
      const { text, charset } = decodeText(bytes, "text/html; charset=utf-8");
      expect(charset).toBe("utf-8");
      expect(text).toBe("");
      expect(text.includes("\uFFFD")).toBe(false);
    }

    // A lone GBK lead byte (CE needs a trailing byte) behaves the same way.
    const gbk = decodeText(new Uint8Array([0xce]), "text/html; charset=gbk");
    expect(gbk.text).toBe("");
  });

  it("drops a partial-only tail through readBodyCapped for tiny caps", async () => {
    // 中 = E4 B8 AD; a 1- or 2-byte cap leaves only part of the character.
    for (const cap of [1, 2]) {
      const { bytes, truncated } = await readBodyCapped(
        chunkedResponse([new Uint8Array([0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87])]),
        cap,
      );
      expect(truncated).toBe(true);

      const { text } = decodeText(bytes, "text/html; charset=utf-8");
      expect(text).toBe("");
    }

    // 😀 = F0 9F 98 80; a 1- to 3-byte cap leaves only part of the character.
    for (const cap of [1, 2, 3]) {
      const { bytes, truncated } = await readBodyCapped(
        chunkedResponse([new Uint8Array([0xf0, 0x9f, 0x98, 0x80])]),
        cap,
      );
      expect(truncated).toBe(true);

      const { text } = decodeText(bytes, "text/html; charset=utf-8");
      expect(text).toBe("");
    }
  });

  it("keeps a body that genuinely ends with U+FFFD", () => {
    // EF BF BD is a complete UTF-8 encoding of U+FFFD, not a partial character.
    const bytes = new Uint8Array([0x61, 0xef, 0xbf, 0xbd]);
    const { text } = decodeText(bytes, "text/html; charset=utf-8");

    expect(text).toBe("a\uFFFD");
  });
});
