import { describe, it, expect, mock, afterEach } from "bun:test";
import { z } from "zod";
import { __configureHostPacing } from "../../src/web/http-utils.ts";
import type { CanonicalToolContext } from "../../src/platform/types.ts";

// The per-origin pacing gate defaults to a 1000 ms gap (plus jitter) between
// request starts to the same origin. This suite is offline and reuses the same
// mocked origins, so disable the gate; afterEach restores the disabled state.
__configureHostPacing({ minIntervalMs: 0, jitterMs: 0 });

// Bun's `fetch` accepts `string | URL | Request` and carries a `preconnect`
// helper alongside its call signature (bun-types `declare namespace fetch`), so
// a double installed on `globalThis.fetch` has to match that port shape.
function fetchDouble(
  impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(mock(impl), { preconnect: (): void => {} });
}

/**
 * Build `execute` arguments the way the platform does: every adapter parses raw
 * tool input through the tool's own zod schema before `execute` sees it
 * (`z.object(def.args)` in src/platform/adapters/{dsh,codex}/tool-factory.ts),
 * so `.default()` values are materialized in the object the tool receives.
 */
function toolArgs<T extends z.ZodRawShape>(
  shape: T,
  input: z.input<z.ZodObject<T>>,
): z.infer<z.ZodObject<T>> {
  return z.object(shape).parse(input);
}

/** Minimal `CanonicalToolContext` double — these tools never read the session. */
function ctx(): CanonicalToolContext {
  return {
    sessionID: "test-session",
    messageID: "test-message",
    agent: "test",
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  __configureHostPacing({ minIntervalMs: 0, jitterMs: 0 });
});

// -----------------------------------------------------------------------
// Jina Reader success
// -----------------------------------------------------------------------

describe("page-read tool", () => {
  it("Jina Reader success: returns markdown from Jina", async () => {
    const jinaContent = "# Page Title\n\nThis is the page content.";

    globalThis.fetch = fetchDouble((input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://r.jina.ai/")) {
        return Promise.resolve(new Response(jinaContent, {
          status: 200,
          headers: { "content-type": "text/markdown" },
        }));
      }
      return Promise.reject(new Error("unexpected URL: " + url));
    });

    const { createPageReadTool } = await import("../../src/web/page-read.ts");
    const tool = createPageReadTool();
    const result = await tool.execute(toolArgs(tool.args, {
      url: "https://example.com/page",
    }), ctx());

    expect(result).toContain("# Page Title");
    expect(result).toContain("This is the page content.");
  });

  // -----------------------------------------------------------------------
  // SSRF guard blocks private/localhost URLs
  // -----------------------------------------------------------------------

  it("blocks private/localhost URLs via SSRF guard", async () => {
    globalThis.fetch = fetchDouble(() =>
      Promise.reject(new Error("fetch should not be called for blocked URLs")),
    );

    const { createPageReadTool } = await import("../../src/web/page-read.ts");
    const tool = createPageReadTool();
    const result = await tool.execute(toolArgs(tool.args, {
      url: "http://localhost:8080/secret",
    }), ctx());

    expect(result).toContain("Error Reading Page");
    expect(result).toContain("localhost");
    expect(result).toContain("Blocked");
  });

  // -----------------------------------------------------------------------
  // Jina fallback to local fetch
  // -----------------------------------------------------------------------

  it("falls back to local fetch when Jina returns error",
    async () => {
      let callCount = 0;

      globalThis.fetch = fetchDouble((_url: string | URL | Request, opts: RequestInit = {}) => {
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

      const { createPageReadTool } = await import("../../src/web/page-read.ts");
      const tool = createPageReadTool();
      const result = await tool.execute(toolArgs(tool.args, {
        url: "https://example.com/page",
      }), ctx());

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
      globalThis.fetch = fetchDouble(() =>
        Promise.resolve(new Response("error", { status: 500 })),
      );

      const { createPageReadTool } = await import("../../src/web/page-read.ts");
      const tool = createPageReadTool();
      const result = await tool.execute(toolArgs(tool.args, {
        url: "https://example.com/inaccessible",
      }), ctx());

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

    globalThis.fetch = fetchDouble((input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://r.jina.ai/")) {
        return Promise.resolve(new Response(largeContent, {
          status: 200,
          headers: { "content-type": "text/markdown" },
        }));
      }
      return Promise.reject(new Error("unexpected"));
    });

    const { createPageReadTool } = await import("../../src/web/page-read.ts");
    const tool = createPageReadTool();
    const result = await tool.execute(toolArgs(tool.args, {
      url: "https://example.com/large",
    }), ctx());

    expect(result).toContain("(truncated to 30KB)");
    // `execute` returns `ToolResult`; this path returns the text arm, and the
    // byte budget below is only meaningful for that arm.
    const text = typeof result === "string" ? result : result.output;
    expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(31000);
  });

  it("uses local fallback when Jina fetch returns error",
    async () => {
      let callCount = 0;

      globalThis.fetch = fetchDouble((url: string | URL | Request, _opts: RequestInit = {}) => {
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

      const { createPageReadTool } = await import("../../src/web/page-read.ts");
      const tool = createPageReadTool();
      const result = await tool.execute(toolArgs(tool.args, {
        url: "https://example.com/fallback",
      }), ctx());

      expect(result).toContain("Fallback Article");
      expect(result).toContain("Recovered via local fetch.");
      expect(result).toContain("> Source: https://example.com/fallback");
    },
    30000,
  );

  it("reports blocking when Jina errors and the local fetch is challenged", async () => {
    const challengeBody =
      '<html><head><title>Just a moment...</title></head><body>' +
      '<div id="cf-chl-opt">Enable JavaScript and cookies to continue</div></body></html>';

    globalThis.fetch = fetchDouble((input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://r.jina.ai/")) {
        // Jina answers 200 with an error body: that is a failure, not content.
        return Promise.resolve(new Response("Warning: Target URL returned error 403", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }));
      }
      return Promise.resolve(new Response(challengeBody, {
        status: 403,
        headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
      }));
    });

    const { createPageReadTool } = await import("../../src/web/page-read.ts");
    const tool = createPageReadTool();
    const result = await tool.execute(toolArgs(tool.args, { url: "https://example.com/protected" }), ctx());

    expect(result).toContain("Error Reading Page");
    expect(result).toContain("https://example.com/protected");
    expect(result).toContain("All sources failed");
    expect(result).toContain("blocking");
    // Neither the Jina error text nor the challenge page may be the answer.
    expect(result).not.toContain("Warning: Target URL returned error");
    expect(result).not.toContain("cf-chl-opt");
  });

  it("returns a long legitimate page instead of calling its interstitial phrase a block", async () => {
    // The phrase is inside the inspected head, but the page is far larger than
    // the advisory marker scan may judge, so the local fetch must answer.
    const article =
      "<html><body><main><h1>Bot detection explained</h1>" +
      "<p>Some pages ask: verify you are human.</p>" +
      `<p>${"Ordinary article text. ".repeat(2000)}</p></main></body></html>`;

    globalThis.fetch = fetchDouble((input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://r.jina.ai/")) {
        // Jina answers 200 with an error body: fail fast to the local fetch.
        return Promise.resolve(new Response("Warning: Target URL returned error 403", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }));
      }
      return Promise.resolve(new Response(article, {
        status: 200,
        headers: { "content-type": "text/html" },
      }));
    });

    const { createPageReadTool } = await import("../../src/web/page-read.ts");
    const tool = createPageReadTool();
    const result = await tool.execute(toolArgs(tool.args, { url: "https://example.com/article" }), ctx());

    expect(result).toContain("Bot detection explained");
    expect(result).not.toContain("All sources failed");
  });
});
