import { describe, it, expect, beforeAll } from "bun:test";

describe("extractMetadata", () => {
  let extractMetadata: (html: string, baseUrl: string) => {
    title: string | null;
    description: string | null;
    author: string | null;
    published: string | null;
    favicon: string | null;
    image: string | null;
    canonical: string | null;
    siteName: string | null;
    type: string | null;
  };

  beforeAll(async () => {
    const mod = await import("../../src/web/metadata-extract");
    extractMetadata = mod.extractMetadata;
  });

  const BASE = "https://example.com";

  it("extracts standard meta tags (title, description, author)", () => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>My Page Title</title>
  <meta name="description" content="A short description of the page.">
  <meta name="author" content="Jane Doe">
</head>
<body><p>Hello</p></body>
</html>`;

    const meta = extractMetadata(html, BASE);

    expect(meta.title).toBe("My Page Title");
    expect(meta.description).toBe("A short description of the page.");
    expect(meta.author).toBe("Jane Doe");
  });

  it("extracts Open Graph tags (og:title, og:description, og:image, og:site_name, og:type)", () => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:title" content="OG Article Title">
  <meta property="og:description" content="OG description text.">
  <meta property="og:image" content="https://cdn.example.com/hero.png">
  <meta property="og:site_name" content="ExampleSite">
  <meta property="og:type" content="article">
</head>
<body></body>
</html>`;

    const meta = extractMetadata(html, BASE);

    expect(meta.title).toBe("OG Article Title");
    expect(meta.description).toBe("OG description text.");
    expect(meta.image).toBe("https://cdn.example.com/hero.png");
    expect(meta.siteName).toBe("ExampleSite");
    expect(meta.type).toBe("article");
  });

  it("extracts article metadata (article:published_time, article:author)", () => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta property="article:published_time" content="2026-01-15T10:30:00Z">
  <meta property="article:author" content="https://example.com/authors/john">
</head>
<body></body>
</html>`;

    const meta = extractMetadata(html, BASE);

    expect(meta.published).toBe("2026-01-15T10:30:00Z");
    expect(meta.author).toBe("https://example.com/authors/john");
  });

  it("resolves relative favicon URL to absolute", () => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <link rel="icon" href="/favicon.ico">
</head>
<body></body>
</html>`;

    const meta = extractMetadata(html, BASE);

    expect(meta.favicon).toBe("https://example.com/favicon.ico");
  });

  it("falls back to shortcut icon when link rel=icon is absent", () => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <link rel="shortcut icon" href="/images/fav.png">
</head>
<body></body>
</html>`;

    const meta = extractMetadata(html, BASE);

    expect(meta.favicon).toBe("https://example.com/images/fav.png");
  });

  it("extracts canonical URL and resolves relative form", () => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <link rel="canonical" href="/canonical-path">
</head>
<body></body>
</html>`;

    const meta = extractMetadata(html, BASE);

    expect(meta.canonical).toBe("https://example.com/canonical-path");
  });

  it("resolves relative og:image against baseUrl", () => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:image" content="/images/article-cover.jpg">
</head>
<body></body>
</html>`;

    const meta = extractMetadata(html, BASE);

    expect(meta.image).toBe("https://example.com/images/article-cover.jpg");
  });

  it("falls back title to og:title when <title> is absent", () => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:title" content="Fallback from OG">
</head>
<body></body>
</html>`;

    const meta = extractMetadata(html, BASE);

    expect(meta.title).toBe("Fallback from OG");
  });

  it("falls back description to og:description when meta name=description is absent", () => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:description" content="Fallback OG description">
</head>
<body></body>
</html>`;

    const meta = extractMetadata(html, BASE);

    expect(meta.description).toBe("Fallback OG description");
  });

  it("prefers <title> over og:title when both are present", () => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>HTML Title Wins</title>
  <meta property="og:title" content="OG Title Ignored">
</head>
<body></body>
</html>`;

    const meta = extractMetadata(html, BASE);

    expect(meta.title).toBe("HTML Title Wins");
  });

  it("prefers meta name=description over og:description when both are present", () => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta name="description" content="Standard description wins">
  <meta property="og:description" content="OG description ignored">
</head>
<body></body>
</html>`;

    const meta = extractMetadata(html, BASE);

    expect(meta.description).toBe("Standard description wins");
  });

  it("prefers meta name=author over article:author when both are present", () => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta name="author" content="Author Name">
  <meta property="article:author" content="https://article.author.url">
</head>
<body></body>
</html>`;

    const meta = extractMetadata(html, BASE);

    expect(meta.author).toBe("Author Name");
  });

  it("falls back published to meta name=date when article:published_time is absent", () => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta name="date" content="2026-03-20">
</head>
<body></body>
</html>`;

    const meta = extractMetadata(html, BASE);

    expect(meta.published).toBe("2026-03-20");
  });

  it("returns all nulls for fields that are absent from the HTML", () => {
    const html = `<!DOCTYPE html>
<html>
<head><title>Only Title</title></head>
<body></body>
</html>`;

    const meta = extractMetadata(html, BASE);

    expect(meta.title).toBe("Only Title");
    expect(meta.description).toBeNull();
    expect(meta.author).toBeNull();
    expect(meta.published).toBeNull();
    expect(meta.favicon).toBeNull();
    expect(meta.image).toBeNull();
    expect(meta.canonical).toBeNull();
    expect(meta.siteName).toBeNull();
    expect(meta.type).toBeNull();
  });

  it("handles empty HTML string gracefully (all nulls)", () => {
    const meta = extractMetadata("", BASE);

    expect(meta.title).toBeNull();
    expect(meta.description).toBeNull();
    expect(meta.author).toBeNull();
    expect(meta.published).toBeNull();
    expect(meta.favicon).toBeNull();
    expect(meta.image).toBeNull();
    expect(meta.canonical).toBeNull();
    expect(meta.siteName).toBeNull();
    expect(meta.type).toBeNull();
  });
});
