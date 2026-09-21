import { describe, it, expect, mock, afterEach } from "bun:test";
import { __configureHostPacing } from "../../src/web/http-utils";

// The per-origin pacing gate defaults to a 1000 ms gap (plus jitter) between
// request starts to the same origin. This suite is offline and reuses the same
// mocked origins, so disable the gate; afterEach restores the disabled state.
__configureHostPacing({ minIntervalMs: 0, jitterMs: 0 });

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  __configureHostPacing({ minIntervalMs: 0, jitterMs: 0 });
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
  // HN auto-routing
  // -----------------------------------------------------------------------

  it('routes to Hacker News when query contains "hacker news"', async () => {
    const hnResponse = {
      hits: [
        {
          title: "Show HN: A new project",
          url: "https://example.com/project",
          objectID: "123",
          points: 10,
          num_comments: 5,
        },
      ],
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(mockResponse(JSON.stringify(hnResponse))),
    );

    const { createWebSearchTool } = await import("../../src/web/web-search");
    const tool = createWebSearchTool();
    const result = await tool.execute({
      query: "hacker news new framework",
      source: "auto",
      max_results: 5,
    });

    expect(result).toContain("Show HN: A new project");
    expect(result).toContain("via Hacker News");
  });

  it('routes to Hacker News when query contains "hn " prefix', async () => {
    const hnResponse = {
      hits: [
        { title: "HN: TypeScript tips", url: null, objectID: "999", points: 25, num_comments: 8 }],
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(mockResponse(JSON.stringify(hnResponse))),
    );

    const { createWebSearchTool } = await import("../../src/web/web-search");
    const tool = createWebSearchTool();
    const result = await tool.execute({
      query: "hn typescript",
      source: "auto",
      max_results: 5,
    });

    expect(result).toContain("HN: TypeScript tips");
    expect(result).toContain("via Hacker News");
  });
});

describe("Result limits and empty results", () => {
  it("passes max_results to Wikipedia API", async () => {
    let capturedUrl = "";

    globalThis.fetch = mock((url: string) => {
      capturedUrl = url;
      const wikiResponse = {
        query: {
          search: [
            { title: "A", snippet: "Item A", pageid: 1 },
            { title: "B", snippet: "Item B", pageid: 2 },
          ],
        },
      };
      return Promise.resolve(mockResponse(JSON.stringify(wikiResponse)));
    });

    const { createWebSearchTool } = await import("../../src/web/web-search");
    const tool = createWebSearchTool();
    await tool.execute({
      query: "test wikipedia",
      source: "auto",
      max_results: 2,
    });

    expect(capturedUrl).toContain("srlimit=2");
  });
  it('returns "No Results" for empty Wikipedia response', async () => {
    const emptyResponse = { query: { search: [] } };

    globalThis.fetch = mock(() =>
      Promise.resolve(mockResponse(JSON.stringify(emptyResponse))),
    );

    const { createWebSearchTool } = await import("../../src/web/web-search");
    const tool = createWebSearchTool();
    const result = await tool.execute({
      query: "nonexistent",
      source: "wikipedia",
      max_results: 5,
    });

    expect(result).toContain("No Results Found");
  });

  it('returns "No Results" for empty HN response', async () => {
    const emptyResponse = { hits: [] };

    globalThis.fetch = mock(() =>
      Promise.resolve(mockResponse(JSON.stringify(emptyResponse))),
    );

    const { createWebSearchTool } = await import("../../src/web/web-search");
    const tool = createWebSearchTool();
    const result = await tool.execute({
      query: "nothing",
      source: "hackernews",
      max_results: 5,
    });

    expect(result).toContain("No Results Found");
  });
});

// -----------------------------------------------------------------------
// npm routing precision
// -----------------------------------------------------------------------

describe("Auto routing precision", () => {
  it("does not query the npm registry for a general multi-word query", async () => {
    const requestedUrls: string[] = [];

    globalThis.fetch = mock((url: string) => {
      requestedUrls.push(url);
      return Promise.resolve(mockResponse(`
Title: Parsing YAML in Python
URL Source: https://example.com/yaml-python
Markdown Content: How to parse YAML with PyYAML.
`));
    });

    const { createWebSearchTool } = await import("../../src/web/web-search");
    const tool = createWebSearchTool();
    const result = await tool.execute({
      query: "how to parse yaml in python",
      source: "auto",
      max_results: 5,
    });

    expect(requestedUrls.some((u) => u.includes("registry.npmjs.org"))).toBe(false);
    expect(result).toContain("Parsing YAML in Python");
    expect(result).toContain("via Jina");
  });

  it("routes a bare package name and an npm keyword query to npm", async () => {
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

    for (const query of ["lodash", "npm lodash"]) {
      const requestedUrls: string[] = [];

      globalThis.fetch = mock((url: string) => {
        requestedUrls.push(url);
        return Promise.resolve(mockResponse(JSON.stringify(npmResponse)));
      });

      const { createWebSearchTool } = await import("../../src/web/web-search");
      const tool = createWebSearchTool();
      const result = await tool.execute({ query, source: "auto", max_results: 5 });

      expect(requestedUrls.some((u) => u.includes("registry.npmjs.org"))).toBe(true);
      expect(result).toContain("lodash@4.17.21");
      expect(result).toContain("via npm");
    }
  });

  it("keeps a general multi-word package query out of the npm registry", async () => {
    const requestedUrls: string[] = [];

    globalThis.fetch = mock((url: string) => {
      requestedUrls.push(url);
      return Promise.resolve(mockResponse(`
Title: Comparing Python package managers
URL Source: https://example.com/python-package-managers
Markdown Content: pip, poetry and uv compared.
`));
    });

    const { createWebSearchTool } = await import("../../src/web/web-search");
    const tool = createWebSearchTool();
    const result = await tool.execute({
      query: "python package manager comparison",
      source: "auto",
      max_results: 5,
    });

    // Mentioning "package" must not route the query to the registry...
    expect(requestedUrls.some((u) => u.includes("registry.npmjs.org"))).toBe(false);
    // ...and the query that is routed keeps its single spaces.
    const jinaUrl = requestedUrls.find((u) => u.startsWith("https://s.jina.ai/")) ?? "";
    expect(jinaUrl).toContain("python%20package%20manager%20comparison");
    for (const url of requestedUrls) {
      expect(url).not.toContain("%20%20");
      expect(url).not.toContain("  ");
    }
    expect(result).toContain("Comparing Python package managers");
    expect(result).toContain("via Jina");
  });

  it("forwards only the package name for keyword-wrapped npm lookups", async () => {
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

    for (const query of ["lodash", "npm lodash", "lodash npm package"]) {
      const requestedUrls: string[] = [];

      globalThis.fetch = mock((url: string) => {
        requestedUrls.push(url);
        return Promise.resolve(mockResponse(JSON.stringify(npmResponse)));
      });

      const { createWebSearchTool } = await import("../../src/web/web-search");
      const tool = createWebSearchTool();
      const result = await tool.execute({ query, source: "auto", max_results: 5 });

      const npmUrl = requestedUrls.find((u) => u.includes("registry.npmjs.org")) ?? "";
      expect(npmUrl).toContain("text=lodash&");
      expect(npmUrl).not.toContain("%20");
      expect(result).toContain("lodash@4.17.21");
    }
  });
});

// -----------------------------------------------------------------------
// Result hygiene
// -----------------------------------------------------------------------

describe("Result hygiene", () => {
  it("deduplicates results that share a normalized URL", async () => {
    const jinaMarkdown = `
Title: Duplicate One
URL Source: https://example.com/dup/
Markdown Content: First copy.
---

Title: Duplicate Two
URL Source: https://example.com/dup
Markdown Content: Second copy.
`;

    globalThis.fetch = mock(() => Promise.resolve(mockResponse(jinaMarkdown)));

    const { createWebSearchTool } = await import("../../src/web/web-search");
    const tool = createWebSearchTool();
    const result = await tool.execute({ query: "duplicate", source: "jina", max_results: 5 });

    expect(result).toContain("Duplicate One");
    expect(result).not.toContain("Duplicate Two");
    const occurrences = result.split("https://example.com/dup").length - 1;
    expect(occurrences).toBe(1);
  });

  it("escapes link delimiters in titles and snippets", async () => {
    const jinaMarkdown = `
Title: Array [index] access
URL Source: https://example.com/array
Markdown Content: Use arr[0] to read the first item.
`;

    globalThis.fetch = mock(() => Promise.resolve(mockResponse(jinaMarkdown)));

    const { createWebSearchTool } = await import("../../src/web/web-search");
    const tool = createWebSearchTool();
    const result = await tool.execute({ query: "array access", source: "jina", max_results: 5 });

    expect(result).toContain("Array \\[index\\] access");
    expect(result).toContain("arr\\[0\\]");
    expect(result).toContain("(https://example.com/array)");
  });
});

// -----------------------------------------------------------------------
// Query normalization
// -----------------------------------------------------------------------

describe("Query normalization", () => {
  it("collapses doubled whitespace before provider requests", async () => {
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
    const requestedUrls: string[] = [];

    globalThis.fetch = mock((url: string) => {
      requestedUrls.push(url);
      return Promise.resolve(mockResponse(JSON.stringify(npmResponse)));
    });

    const { createWebSearchTool } = await import("../../src/web/web-search");
    const tool = createWebSearchTool();
    const result = await tool.execute({
      query: "lodash  npm   package",
      source: "auto",
      max_results: 5,
    });

    const npmUrl = requestedUrls.find((u) => u.includes("registry.npmjs.org")) ?? "";
    expect(npmUrl).toContain("text=lodash&");
    for (const url of requestedUrls) {
      expect(url).not.toContain("%20%20");
    }
    expect(result).toContain("lodash@4.17.21");
  });

  it("collapses doubled whitespace in a general Jina query", async () => {
    const jinaMarkdown = `
Title: Parsing YAML in Python
URL Source: https://example.com/yaml-python
Markdown Content: How to parse YAML with PyYAML.
`;
    const requestedUrls: string[] = [];

    globalThis.fetch = mock((url: string) => {
      requestedUrls.push(url);
      return Promise.resolve(mockResponse(jinaMarkdown));
    });

    const { createWebSearchTool } = await import("../../src/web/web-search");
    const tool = createWebSearchTool();
    const result = await tool.execute({
      query: "how  to   parse yaml",
      source: "auto",
      max_results: 5,
    });

    const jinaUrl = requestedUrls.find((u) => u.startsWith("https://s.jina.ai/")) ?? "";
    expect(jinaUrl).toContain("how%20to%20parse%20yaml");
    for (const url of requestedUrls) {
      expect(url).not.toContain("%20%20");
    }
    expect(result).toContain("Parsing YAML in Python");
  });
});

