import { describe, it, expect, mock, afterEach } from "bun:test";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockResponse(body: string, status = 200) {
  return new Response(body, { status });
}

// -----------------------------------------------------------------------
// DuckDuckGo parser
// -----------------------------------------------------------------------

describe("DuckDuckGo search", () => {
  it("extracts titles, URLs, and snippets from DDG HTML", async () => {
    const ddgHtml = `
      <html>
      <body>
        <div class="results">
          <div class="result">
            <h2><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1">Result One</a></h2>
            <a class="result__snippet">First snippet text</a>
          </div>
          <div class="result">
            <h2><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpage2">Result Two</a></h2>
            <a class="result__snippet">Second snippet text</a>
          </div>
        </div>
      </body>
      </html>
    `;

    globalThis.fetch = mock(() => Promise.resolve(mockResponse(ddgHtml)));

    const { createWebSearchTool } = await import("../../src/web/web-search");
    const tool = createWebSearchTool();
    const result = await tool.execute({
      query: "test query",
      source: "duckduckgo",
      max_results: 5,
    });

    expect(result).toContain("Result One");
    expect(result).toContain("Result Two");
    expect(result).toContain("https://example.com/page1");
    expect(result).toContain("https://example.org/page2");
    expect(result).toContain("First snippet text");
    expect(result).toContain("Second snippet text");
    expect(result).toContain("via DuckDuckGo");
  });

  it("unwraps DuckDuckGo redirect URLs", async () => {
    const ddgHtml = `
      <html><body>
        <div class="result">
          <h2><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fencoded-url.com%2Fpath">Encoded</a></h2>
          <a class="result__snippet">snippet</a>
        </div>
      </body></html>
    `;

    globalThis.fetch = mock(() => Promise.resolve(mockResponse(ddgHtml)));

    const { createWebSearchTool } = await import("../../src/web/web-search");
    const tool = createWebSearchTool();
    const result = await tool.execute({
      query: "test",
      source: "duckduckgo",
      max_results: 5,
    });

    expect(result).toContain("https://encoded-url.com/path");
    expect(result).not.toContain("uddg");
  });
});

// -----------------------------------------------------------------------
// Wikipedia parser
// -----------------------------------------------------------------------

describe("Wikipedia search", () => {
  it("parses Wikipedia API JSON correctly", async () => {
    const wikiResponse = {
      query: {
        search: [
          { title: "TypeScript", snippet: "TypeScript is a <b>programming language</b>", pageid: 123 },
          { title: "JavaScript", snippet: "JavaScript is a <b>scripting language</b>", pageid: 456 },
        ],
      },
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(mockResponse(JSON.stringify(wikiResponse))),
    );

    const { createWebSearchTool } = await import("../../src/web/web-search");
    const tool = createWebSearchTool();
    const result = await tool.execute({
      query: "typescript",
      source: "wikipedia",
      max_results: 5,
    });

    expect(result).toContain("TypeScript");
    expect(result).toContain("JavaScript");
    expect(result).toContain("programming language");
    expect(result).toContain("scripting language");
    expect(result).toContain("en.wikipedia.org/wiki/TypeScript");
    expect(result).toContain("via Wikipedia");
  });
});

// -----------------------------------------------------------------------
// npm parser
// -----------------------------------------------------------------------

describe("npm search", () => {
  it("parses npm registry JSON correctly", async () => {
    const npmResponse = {
      objects: [
        {
          package: {
            name: "express",
            version: "4.18.2",
            description: "Fast, unopinionated, minimalist web framework",
            links: { npm: "https://www.npmjs.com/package/express" },
          },
        },
        {
          package: {
            name: "koa",
            version: "2.14.0",
            description: "Expressive middleware for node.js",
            links: { npm: "https://www.npmjs.com/package/koa" },
          },
        },
      ],
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(mockResponse(JSON.stringify(npmResponse))),
    );

    const { createWebSearchTool } = await import("../../src/web/web-search");
    const tool = createWebSearchTool();
    const result = await tool.execute({
      query: "web framework",
      source: "npm",
      max_results: 5,
    });

    expect(result).toContain("express@4.18.2");
    expect(result).toContain("koa@2.14.0");
    expect(result).toContain("Fast, unopinionated, minimalist web framework");
    expect(result).toContain("via npm");
  });
});

// -----------------------------------------------------------------------
// Hacker News parser (Algolia)
// -----------------------------------------------------------------------

describe("Hacker News search", () => {
  it("parses Algolia API JSON correctly", async () => {
    const hnResponse = {
      hits: [
        {
          title: "Show HN: A new open source project",
          url: "https://example.com/project",
          objectID: "12345",
          points: 42,
          num_comments: 15,
        },
        {
          title: "Ask HN: What are you working on?",
          url: null,
          objectID: "67890",
          points: 7,
          num_comments: 3,
        },
      ],
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(mockResponse(JSON.stringify(hnResponse))),
    );

    const { createWebSearchTool } = await import("../../src/web/web-search");
    const tool = createWebSearchTool();
    const result = await tool.execute({
      query: "hacker news project",
      source: "hackernews",
      max_results: 5,
    });

    expect(result).toContain("Show HN: A new open source project");
    expect(result).toContain("https://example.com/project");
    expect(result).toContain("42 points, 15 comments");
    expect(result).toContain("Ask HN: What are you working on?");
    expect(result).toContain("news.ycombinator.com/item?id=67890");
    expect(result).toContain("7 points, 3 comments");
    expect(result).toContain("via Hacker News");
  });
});

// -----------------------------------------------------------------------
// Auto routing
// -----------------------------------------------------------------------

describe("Auto routing", () => {
  it('routes to npm when query contains "npm"', async () => {
    const npmResponse = {
      objects: [
        {
          package: {
            name: "lodash",
            version: "4.17.21",
            description: "Lodash modular utilities",
            links: { npm: "https://www.npmjs.com/package/lodash" },
          },
        },
      ],
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(mockResponse(JSON.stringify(npmResponse))),
    );

    const { createWebSearchTool } = await import("../../src/web/web-search");
    const tool = createWebSearchTool();
    const result = await tool.execute({
      query: "lodash npm package",
      source: "auto",
      max_results: 5,
    });

    expect(result).toContain("lodash@4.17.21");
    expect(result).toContain("via npm");
  });

  it('routes to Wikipedia when query contains "wikipedia"', async () => {
    const wikiResponse = {
      query: {
        search: [
          { title: "React", snippet: "React is a JavaScript library", pageid: 789 },
        ],
      },
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(mockResponse(JSON.stringify(wikiResponse))),
    );

    const { createWebSearchTool } = await import("../../src/web/web-search");
    const tool = createWebSearchTool();
    const result = await tool.execute({
      query: "react wikipedia",
      source: "auto",
      max_results: 5,
    });

    expect(result).toContain("React");
    expect(result).toContain("via Wikipedia");
  });
});

// -----------------------------------------------------------------------
// Error handling
// -----------------------------------------------------------------------

describe("Error handling", () => {
  it('returns "No Results" when all sources fail', async () => {
    // Return error responses instead of throwing (throwing triggers
    // fetchWithRetry backoff which causes test timeouts)
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("error", { status: 500 })),
    );

    const { createWebSearchTool } = await import("../../src/web/web-search");
    const tool = createWebSearchTool();
    const result = await tool.execute({
      query: "nonexistent",
      source: "jina",
      max_results: 5,
    });

    expect(result).toContain("No Results Found");
    expect(result).toContain("nonexistent");
  });
});

// -----------------------------------------------------------------------
// Jina parser
// -----------------------------------------------------------------------

describe("Jina search", () => {
  it("parses Jina markdown output and extracts results", async () => {
    const jinaMarkdown = `
Title: First Result
URL Source: https://example.com/first
Markdown Content: This is the first result's content.
---

Title: Second Result
URL Source: https://example.org/second
Markdown Content: Content of the second result.
    `;

    globalThis.fetch = mock(() =>
      Promise.resolve(mockResponse(jinaMarkdown)),
    );

    const { createWebSearchTool } = await import("../../src/web/web-search");
    const tool = createWebSearchTool();
    const result = await tool.execute({
      query: "test",
      source: "jina",
      max_results: 5,
    });

    expect(result).toContain("First Result");
    expect(result).toContain("https://example.com/first");
    expect(result).toContain("Second Result");
    expect(result).toContain("https://example.org/second");
    expect(result).toContain("via Jina");
  });
});
