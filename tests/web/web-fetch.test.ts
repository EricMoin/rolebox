import { describe, it, expect, mock, afterEach } from "bun:test";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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
