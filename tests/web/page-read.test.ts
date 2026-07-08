import { describe, it, expect, mock, afterEach } from "bun:test";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// -----------------------------------------------------------------------
// Jina Reader success
// -----------------------------------------------------------------------

describe("page-read tool", () => {
  it("Jina Reader success: returns markdown from Jina", async () => {
    const jinaContent = "# Page Title\n\nThis is the page content.";

    globalThis.fetch = mock((url: string) => {
      if (url.startsWith("https://r.jina.ai/")) {
        return Promise.resolve(new Response(jinaContent, {
          status: 200,
          headers: { "content-type": "text/markdown" },
        }));
      }
      return Promise.reject(new Error("unexpected URL: " + url));
    });

    const { createPageReadTool } = await import("../../src/web/page-read");
    const tool = createPageReadTool();
    const result = await tool.execute({
      url: "https://example.com/page",
    });

    expect(result).toContain("# Page Title");
    expect(result).toContain("This is the page content.");
  });

  // -----------------------------------------------------------------------
  // Jina fallback to local fetch
  // -----------------------------------------------------------------------

  it("falls back to local fetch when Jina returns error",
    async () => {
      let callCount = 0;

      globalThis.fetch = mock((_url: string, opts: RequestInit = {}) => {
        callCount++;
        if (callCount <= 3) {
          // Return 500 for all Jina retry attempts (fetchWithRetry with maxRetries=2
          // = 3 total attempts)
          return Promise.resolve(new Response("error", { status: 500 }));
        }
        // Local fetch — return HTML (note: this timeout is 30s to allow Jina retries)
        return Promise.resolve(new Response(
          "<html><body><main><h1>Local Page</h1><p>Cached content</p></main></body></html>",
          { status: 200, headers: { "content-type": "text/html" } },
        ));
      });

      const { createPageReadTool } = await import("../../src/web/page-read");
      const tool = createPageReadTool();
      const result = await tool.execute({
        url: "https://example.com/page",
      });

      expect(result).toContain("Local Page");
      expect(result).toContain("Cached content");
      expect(result).toContain("> Source: https://example.com/page");
      // 3 Jina retries + 1 local fetch = 4 total
      expect(callCount).toBe(4);
    },
    30000, // 30s timeout for Jina retry backoff
  );

  // -----------------------------------------------------------------------
  // Both fail
  // -----------------------------------------------------------------------

  it("returns error message when Jina and local fetch both fail",
    async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("error", { status: 500 })),
      );

      const { createPageReadTool } = await import("../../src/web/page-read");
      const tool = createPageReadTool();
      const result = await tool.execute({
        url: "https://example.com/inaccessible",
      });

      expect(result).toContain("Error Reading Page");
      expect(result).toContain("https://example.com/inaccessible");
      expect(result).toContain("All sources failed");
    },
    30000,
  );

  // -----------------------------------------------------------------------
  // Truncation
  // -----------------------------------------------------------------------

  it("truncates Jina response when it exceeds ~30KB", async () => {
    const largeContent = "x".repeat(35 * 1024);

    globalThis.fetch = mock((url: string) => {
      if (url.startsWith("https://r.jina.ai/")) {
        return Promise.resolve(new Response(largeContent, {
          status: 200,
          headers: { "content-type": "text/markdown" },
        }));
      }
      return Promise.reject(new Error("unexpected"));
    });

    const { createPageReadTool } = await import("../../src/web/page-read");
    const tool = createPageReadTool();
    const result = await tool.execute({
      url: "https://example.com/large",
    });

    expect(result).toContain("(truncated to 30KB)");
    expect(Buffer.byteLength(result, "utf-8")).toBeLessThan(31000);
  });

  it("uses local fallback when Jina fetch returns error",
    async () => {
      let callCount = 0;

      globalThis.fetch = mock((url: string, _opts: RequestInit = {}) => {
        callCount++;
        if (callCount <= 3) {
          // Jina retries
          return Promise.resolve(new Response("error", { status: 500 }));
        }
        // Local fetch
        return Promise.resolve(new Response(
          "<html><body><article><h2>Fallback Article</h2><p>Recovered via local fetch.</p></article></body></html>",
          { status: 200, headers: { "content-type": "text/html" } },
        ));
      });

      const { createPageReadTool } = await import("../../src/web/page-read");
      const tool = createPageReadTool();
      const result = await tool.execute({
        url: "https://example.com/fallback",
      });

      expect(result).toContain("Fallback Article");
      expect(result).toContain("Recovered via local fetch.");
      expect(result).toContain("> Source: https://example.com/fallback");
    },
    30000,
  );
});
