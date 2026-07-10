import { describe, it, expect, beforeAll } from "bun:test";

describe("convertHtmlToMarkdown", () => {
  let convertHtmlToMarkdown: (html: string, url?: string) => string;

  beforeAll(async () => {
    const mod = await import("../../src/web/html-to-markdown");
    convertHtmlToMarkdown = mod.convertHtmlToMarkdown;
  });

  it("removes script and style elements", () => {
    const html = `
      <html><body>
        <script>alert('xss')</script>
        <style>.red { color: red; }</style>
        <p>Hello world</p>
      </body></html>
    `;
    const result = convertHtmlToMarkdown(html);
    expect(result).not.toContain("alert");
    expect(result).not.toContain("color: red");
    expect(result).toContain("Hello world");
  });

  it("removes nav, footer, header, aside elements", () => {
    const html = `
      <html><body>
        <nav>Navigation links</nav>
        <footer>Copyright 2024</footer>
        <header>Header content</header>
        <aside>Sidebar</aside>
        <main><p>Main content</p></main>
      </body></html>
    `;
    const result = convertHtmlToMarkdown(html);
    expect(result).not.toContain("Navigation links");
    expect(result).not.toContain("Copyright 2024");
    expect(result).not.toContain("Header content");
    expect(result).not.toContain("Sidebar");
    expect(result).toContain("Main content");
  });

  it("extracts main content area when available", () => {
    const html = `
      <html><body>
        <div class="sidebar">Ignore me</div>
        <main><h1>Title</h1><p>Body text</p></main>
        <footer>Footer</footer>
      </body></html>
    `;
    const result = convertHtmlToMarkdown(html);
    expect(result).toContain("Title");
    expect(result).toContain("Body text");
    expect(result).not.toContain("Ignore me");
    expect(result).not.toContain("Footer");
  });

  it("falls back to article when no main element", () => {
    const html = `
      <html><body>
        <article><h2>Article Title</h2><p>Article content</p></article>
      </body></html>
    `;
    const result = convertHtmlToMarkdown(html);
    expect(result).toContain("Article Title");
    expect(result).toContain("Article content");
  });

  it("falls back to body when no main or article", () => {
    const html = `<html><body><p>Just body text</p></body></html>`;
    const result = convertHtmlToMarkdown(html);
    expect(result).toContain("Just body text");
  });

  it("converts headings to ATX-style markdown", () => {
    const html = `<h1>H1</h1><h2>H2</h2><h3>H3</h3>`;
    const result = convertHtmlToMarkdown(html);
    expect(result).toContain("# H1");
    expect(result).toContain("## H2");
    expect(result).toContain("### H3");
  });

  it("converts links to inline markdown", () => {
    const html = `<p>Visit <a href="https://example.com">Example</a> today.</p>`;
    const result = convertHtmlToMarkdown(html);
    expect(result).toContain("[Example](https://example.com)");
  });

  it("converts code blocks to fenced code", () => {
    const html = `<pre><code>const x = 1;</code></pre>`;
    const result = convertHtmlToMarkdown(html);
    expect(result).toContain("```");
    expect(result).toContain("const x = 1;");
  });

  it("adds source attribution when url is provided", () => {
    const html = `<p>Some content</p>`;
    const result = convertHtmlToMarkdown(html, "https://example.com/page");
    expect(result).toContain("> Source: https://example.com/page");
  });

  it("does not add source attribution when url is omitted", () => {
    const html = `<p>Some content</p>`;
    const result = convertHtmlToMarkdown(html);
    expect(result).not.toContain("> Source:");
  });

  it("truncates output at approximately 30KB", () => {
    // Create enough text to exceed 30KB
    const longText = "A".repeat(35000);
    const html = `<html><body><p>${longText}</p></body></html>`;
    const result = convertHtmlToMarkdown(html);
    // 30KB = 30720 bytes, but conversion overhead adds some chars.
    // Allow generous margin — just verify it's truncated.
    expect(Buffer.byteLength(result, "utf-8")).toBeLessThan(33000);
    expect(result).toContain("(truncated to 30KB)");
  });

  it("handles malformed HTML gracefully via fallback", () => {
    // Cheerio handles most malformed HTML, but non-HTML strings should still work
    const html = "Just plain text <<< not >>> HTML!";
    const result = convertHtmlToMarkdown(html);
    expect(result).toBeTruthy();
  });
});
