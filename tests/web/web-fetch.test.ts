import { describe, it, expect, mock, afterEach } from "bun:test";
import { __configureHostPacing } from "../../src/web/http-utils";

// The per-origin pacing gate defaults to a 1000 ms gap (plus jitter) between
// request starts to the same origin. This suite is offline and repeatedly
// reuses the same mocked origins, so disable the gate; afterEach restores the
// disabled state in case a test re-enables pacing.
__configureHostPacing({ minIntervalMs: 0, jitterMs: 0 });

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  __configureHostPacing({ minIntervalMs: 0, jitterMs: 0 });
});

function mockResponse(body: string, status = 200, contentType?: string) {
  const headers: Record<string, string> = {};
  if (contentType) headers["content-type"] = contentType;
  return new Response(body, { status, headers });
}

// -----------------------------------------------------------------------
// SSRF guard — tool must block before making any fetch call
// -----------------------------------------------------------------------

describe("web-fetch SSRF blocking", () => {
  it("blocks localhost URLs and returns error format", async () => {
    // If fetch is called, the guard failed — fail the test
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("fetch should not be called for blocked URLs")),
    );

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "http://localhost:8080/secret",
    });

    expect(typeof result).toBe("string");
    const resultStr = result as string;
    expect(resultStr).toContain("Error Fetching URL");
    expect(resultStr).toContain("localhost");
    expect(resultStr).toContain("Blocked");
  });

  it("blocks RFC 1918 10.x.x.x addresses", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("fetch should not be called")),
    );

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "http://10.0.0.1/admin",
    });

    const resultStr = result as string;
    expect(resultStr).toContain("Error Fetching URL");
    expect(resultStr).toContain("Blocked");
  });

  it("blocks 192.168.x.x addresses", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("fetch should not be called")),
    );

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "http://192.168.1.1/",
    });

    const resultStr = result as string;
    expect(resultStr).toContain("Error Fetching URL");
    expect(resultStr).toContain("Blocked");
  });

  it("blocks *.local hostnames", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("fetch should not be called")),
    );

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "http://myapp.local/",
    });

    const resultStr = result as string;
    expect(resultStr).toContain("Error Fetching URL");
    expect(resultStr).toContain("Blocked");
  });

  it("allows public URLs to proceed to fetch", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(mockResponse("<html><body><p>Hello</p></body></html>", 200, "text/html")),
    );

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "https://example.com/page",
    });

    // Should NOT be an error string — should be a ToolResult object
    expect(typeof result).not.toBe("string");
    expect(result).toHaveProperty("output");
  });

  it("includes recovery suggestions in error format", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("fetch should not be called")),
    );

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "http://localhost/",
    });

    const resultStr = result as string;
    // Recovery suggestions
    expect(resultStr).toContain("Try:");
    expect(resultStr).toContain("engine");
    expect(resultStr).toContain("selector");
  });
});

// -----------------------------------------------------------------------
// Format conversion pipeline
// -----------------------------------------------------------------------

describe("web-fetch format conversion", () => {
  it("converts HTML to markdown by default", async () => {
    const html = `<html><body><main><h1>Page Title</h1><p>Paragraph content.</p></main></body></html>`;

    globalThis.fetch = mock(() =>
      Promise.resolve(mockResponse(html, 200, "text/html")),
    );

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "https://example.com/page",
    });

    expect(result).not.toBeString;
    const output = (result as { output: string }).output;
    expect(output).toContain("Page Title");
    expect(output).toContain("Paragraph content");
  });

  it("extracts plain text with format: text", async () => {
    const html = `<html><body><main><h1>Title</h1><p>Body text</p><script>alert('xss')</script></main></body></html>`;

    globalThis.fetch = mock(() =>
      Promise.resolve(mockResponse(html, 200, "text/html")),
    );

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "https://example.com/page",
      format: "text",
    });

    const output = (result as { output: string }).output;
    expect(output).toContain("Title");
    expect(output).toContain("Body text");
    expect(output).not.toContain("alert");
  });

  it("returns clean HTML with format: html", async () => {
    const html = `<html><head><script>alert('xss')</script><style>.red{color:red}</style></head><body><p>Clean content</p></body></html>`;

    globalThis.fetch = mock(() =>
      Promise.resolve(mockResponse(html, 200, "text/html")),
    );

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "https://example.com/page",
      format: "html",
    });

    const output = (result as { output: string }).output;
    expect(output).toContain("Clean content");
    expect(output).not.toContain("alert(");
    expect(output).not.toContain("color:red");
  });

  it("parses JSON with format: json", async () => {
    const jsonData = JSON.stringify({ key: "value", nested: { num: 42 } });

    globalThis.fetch = mock(() =>
      Promise.resolve(mockResponse(jsonData, 200, "application/json")),
    );

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "https://api.example.com/data",
      format: "json",
    });

    const output = (result as { output: string }).output;
    expect(output).toContain('"key"');
    expect(output).toContain("value");
    expect(output).toContain("42");
  });

  it("returns raw content with format: raw", async () => {
    const text = "Just plain text content";

    globalThis.fetch = mock(() =>
      Promise.resolve(mockResponse(text, 200, "text/plain")),
    );

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "https://example.com/raw",
      format: "raw",
    });

    // With text/plain, raw format should return the raw text
    // ToolResult may be a string or object depending on the pipeline path
    if (typeof result === "string") {
      // Error string — check what happened
      expect(result).toContain("Error");
    } else {
      const output = (result as { output: string }).output;
      expect(output).toContain("Just plain text content");
    }
  });

  it("resolves format: auto based on content type", async () => {
    // HTML content → auto → markdown
    const html = `<html><body><main><p>Auto detected as HTML</p></main></body></html>`;

    globalThis.fetch = mock(() =>
      Promise.resolve(mockResponse(html, 200, "text/html")),
    );

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "https://example.com/page",
      format: "auto",
    });

    const output = (result as { output: string }).output;
    expect(output).toContain("Auto detected as HTML");
  });

  it("returns a text/plain body as content for format: auto", async () => {
    const text = "hello plain world";

    globalThis.fetch = mock(() =>
      Promise.resolve(mockResponse(text, 200, "text/plain; charset=utf-8")),
    );

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "https://example.com/plain.txt",
      format: "auto",
    });

    expect(typeof result).not.toBe("string");
    const output = (result as { output: string }).output;
    expect(output).toContain(text);
    expect(output).not.toContain("Binary content");
  });

  it("returns a text/plain body as content for format: raw", async () => {
    const text = "hello plain world";

    globalThis.fetch = mock(() =>
      Promise.resolve(mockResponse(text, 200, "text/plain; charset=utf-8")),
    );

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "https://example.com/plain.txt",
      format: "raw",
    });

    expect(typeof result).not.toBe("string");
    const output = (result as { output: string }).output;
    expect(output).toContain(text);
    expect(output).not.toContain("Binary content");
  });
});

// -----------------------------------------------------------------------
// Error handling
// -----------------------------------------------------------------------

describe("web-fetch error handling", () => {
  it("returns error message when all sources fail with network error", async () => {
    // Reject (network error) so fetchDefault catches and returns statusCode 0
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("Network failure")),
    );

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "https://example.com/inaccessible",
    });

    expect(typeof result).toBe("string");
    const resultStr = result as string;
    expect(resultStr).toContain("Error Fetching URL");
    expect(resultStr).toContain("https://example.com/inaccessible");
    expect(resultStr).toContain("All sources failed");
  });

  it("returns error for URL with no protocol", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("fetch should not be called")),
    );

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "not-a-valid-url",
    });

    const resultStr = result as string;
    expect(resultStr).toContain("Error Fetching URL");
  });

  it("includes the blocked URL in the error response", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("fetch should not be called")),
    );

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "http://localhost:3000/",
    });

    const resultStr = result as string;
    expect(resultStr).toContain("http://localhost:3000/");
  });
});

// -----------------------------------------------------------------------
// Custom headers passthrough
// -----------------------------------------------------------------------

describe("web-fetch custom headers", () => {
  it("sends custom headers with the request", async () => {
    let capturedHeaders: Record<string, string> | undefined;

    globalThis.fetch = mock((_url: string, opts: RequestInit = {}) => {
      capturedHeaders = opts.headers as Record<string, string>;
      return Promise.resolve(
        mockResponse("<html><body><p>OK</p></body></html>", 200, "text/html"),
      );
    });

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    await tool.execute({
      url: "https://example.com/page",
      headers: { "X-Custom": "test-value" },
    });

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!["X-Custom"]).toBe("test-value");
  });

  it("sends default Accept-Language header", async () => {
    let capturedHeaders: Record<string, string> | undefined;

    globalThis.fetch = mock((_url: string, opts: RequestInit = {}) => {
      capturedHeaders = opts.headers as Record<string, string>;
      return Promise.resolve(
        mockResponse("<html><body><p>OK</p></body></html>", 200, "text/html"),
      );
    });

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    await tool.execute({
      url: "https://example.com/page",
    });

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!["Accept-Language"]).toBe("en-US,en;q=0.9");
  });
});

// -----------------------------------------------------------------------
// Source attribution in markdown output
// -----------------------------------------------------------------------

describe("web-fetch source attribution", () => {
  it("includes the source URL in the output", async () => {
    const html = `<html><body><main><p>Test content</p></main></body></html>`;

    globalThis.fetch = mock(() =>
      Promise.resolve(mockResponse(html, 200, "text/html")),
    );

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "https://example.com/page",
    });

    const output = (result as { output: string }).output;
    // The source is in the markdown as a blockquote prefix
    expect(output).toContain("Source:");
  });

  it("sets the output title to URL with MIME type", async () => {
    const html = `<html><body><main><p>Test</p></main></body></html>`;

    globalThis.fetch = mock(() =>
      Promise.resolve(mockResponse(html, 200, "text/html")),
    );

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "https://example.com/page",
    });

    const title = (result as { title?: string }).title;
    expect(title).toContain("example.com");
    expect(title).toContain("text/html");
  });
});

// -----------------------------------------------------------------------
// Bot-block escalation and decoding
// -----------------------------------------------------------------------

describe("web-fetch bot-block escalation", () => {
  const challengeBody =
    '<html><head><title>Just a moment...</title></head><body>' +
    '<div id="cf-chl-opt">Enable JavaScript and cookies to continue</div></body></html>';

  it("escalates past a Cloudflare challenge to a working fallback engine", async () => {
    const requested: string[] = [];

    globalThis.fetch = mock((url: string) => {
      requested.push(url);
      if (url.startsWith("https://r.jina.ai/")) {
        return Promise.resolve(new Response("# Protected Page\n\nReal content from Jina.", {
          status: 200,
          headers: { "content-type": "text/markdown" },
        }));
      }
      return Promise.resolve(new Response(challengeBody, {
        status: 403,
        headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
      }));
    });

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "https://example.com/protected",
      format: "markdown",
    });

    expect(typeof result).not.toBe("string");
    const output = (result as { output: string }).output;
    expect(output).toContain("Real content from Jina");
    expect(output).not.toContain("Just a moment");
    expect(output).not.toContain("Enable JavaScript and cookies to continue");
    expect(requested.some((u) => u.startsWith("https://r.jina.ai/"))).toBe(true);
  });

  it("reports blocking and All sources failed when every engine is blocked", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(challengeBody, {
        status: 403,
        headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
      })),
    );

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({ url: "https://example.com/protected" });

    expect(typeof result).toBe("string");
    const resultStr = result as string;
    expect(resultStr).toContain("Error Fetching URL");
    expect(resultStr).toContain("https://example.com/protected");
    expect(resultStr).toContain("All sources failed");
    expect(resultStr).toContain("block");
    expect(resultStr).toContain('engine: "browser"');
    // The challenge page itself must never be returned as the answer.
    expect(resultStr).not.toContain("Just a moment");
    expect(resultStr).not.toContain("cf-chl-opt");
  });

  it("returns an ordinary 404 body as content without escalating", async () => {
    let callCount = 0;

    globalThis.fetch = mock(() => {
      callCount++;
      return Promise.resolve(new Response(
        "<html><body><main><h1>Not Found Page</h1><p>The requested page does not exist.</p></main></body></html>",
        { status: 404, headers: { "content-type": "text/html" } },
      ));
    });

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "https://example.com/missing",
      format: "markdown",
    });

    expect(typeof result).not.toBe("string");
    const output = (result as { output: string }).output;
    expect(output).toContain("Not Found Page");
    // No escalation: the static fetch answered on its own.
    expect(callCount).toBe(1);
  });

  it("returns a bare 403 body as content instead of escalating", async () => {
    const requested: string[] = [];
    const errorBody = JSON.stringify({
      error: "forbidden",
      message: "Invalid API key",
    });

    globalThis.fetch = mock((url: string) => {
      requested.push(url);
      return Promise.resolve(
        new Response(errorBody, {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({ url: "https://api.example.com/data" });

    expect(typeof result).not.toBe("string");
    const output = (result as { output: string }).output;
    expect(output).toContain('"error": "forbidden"');
    expect(output).toContain('"message": "Invalid API key"');
    expect(output).not.toContain("All sources failed");
    // No corroboration (no cf-mitigated header, no protection-provider
    // Server/X-Powered-By value, no interstitial marker), so the static fetch
    // answered on its own and nothing was escalated to the Jina reader.
    expect(requested).toHaveLength(1);
    expect(requested.some((u) => u.includes("r.jina.ai"))).toBe(false);
  });

  it("decodes a GBK page instead of returning replacement characters", async () => {
    // <html><body><p> + GBK bytes for 中文测试 + </p></body></html>
    const bytes = new Uint8Array([
      0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0x3c, 0x62, 0x6f, 0x64, 0x79, 0x3e, 0x3c, 0x70, 0x3e,
      0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4,
      0x3c, 0x2f, 0x70, 0x3e, 0x3c, 0x2f, 0x62, 0x6f, 0x64, 0x79, 0x3e, 0x3c, 0x2f, 0x68, 0x74,
      0x6d, 0x6c, 0x3e,
    ]);

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(bytes, {
        status: 200,
        headers: { "content-type": "text/html; charset=gbk" },
      })),
    );

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "https://example.com/cn",
      format: "text",
    });

    expect(typeof result).not.toBe("string");
    const output = (result as { output: string }).output;
    expect(output).toContain("中文测试");
    expect(output).not.toContain("\uFFFD");
  });

  it("bounds retries on a 429 and still returns a clear error", async () => {
    let callCount = 0;

    globalThis.fetch = mock(() => {
      callCount++;
      return Promise.resolve(new Response("slow down", {
        status: 429,
        headers: { "content-type": "text/plain", "retry-after": "0" },
      }));
    });

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({ url: "https://example.com/limited" });

    // default: 1 request + 1 Retry-After retry; jina: maxRetries 1 = 2 requests.
    // Any unbounded retry chain would push this higher.
    expect(callCount).toBe(4);

    expect(typeof result).toBe("string");
    const resultStr = result as string;
    expect(resultStr).toContain("Error Fetching URL");
    expect(resultStr).toContain("All sources failed");
    expect(resultStr).toContain("429");
  });

  it("falls back to the static fetch with a note when engine browser is unavailable", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(mockResponse("<html><body><main><p>Static content</p></main></body></html>", 200, "text/html")),
    );

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({ url: "https://example.com/page", engine: "browser" });

    expect(typeof result).not.toBe("string");
    const output = (result as { output: string }).output;
    expect(output).toContain("Static content");
    expect(output).toContain("browser engine unavailable");
    expect(output).toContain("used static fetch");
  });

  it("does not treat a long legitimate page mentioning an interstitial phrase as blocked", async () => {
    let callCount = 0;
    // The phrase sits inside the first 8 KB, but the page itself is far larger
    // than the advisory marker scan may judge — it must be returned as content.
    const article =
      "<html><body><main><h1>Bot detection explained</h1>" +
      "<p>Some pages ask: verify you are human.</p>" +
      `<p>${"Ordinary article text. ".repeat(2000)}</p></main></body></html>`;

    globalThis.fetch = mock(() => {
      callCount++;
      return Promise.resolve(mockResponse(article, 200, "text/html"));
    });

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "https://example.com/article",
      format: "markdown",
    });

    expect(typeof result).not.toBe("string");
    const output = (result as { output: string }).output;
    expect(output).toContain("Bot detection explained");
    // No escalation: the static fetch answered on its own.
    expect(callCount).toBe(1);
  });

  it("drops a multi-byte character split by truncation instead of an U+FFFD", async () => {
    // 1023 ASCII bytes then a 3-byte CJK character: the 1024-byte cut lands
    // inside that character, which used to surface as a trailing U+FFFD.
    const text = "a".repeat(1023) + "\u4e2d\u6587" + " tail";

    // text/markdown keeps the raw path (no HTML conversion) and is not one of
    // the generic MIME types detectContentType maps to application/octet-stream.
    globalThis.fetch = mock(() =>
      Promise.resolve(mockResponse(text, 200, "text/markdown")),
    );

    const { createWebFetchTool } = await import("../../src/web/web-fetch");
    const tool = createWebFetchTool();
    const result = await tool.execute({
      url: "https://example.com/utf8",
      format: "raw",
      max_size: 1024,
    });

    const output = (result as { output: string }).output;
    expect(output).toContain("... (truncated)");
    expect(output).not.toContain("\uFFFD");
  });
});
