import { describe, it, expect, beforeAll } from "bun:test";

describe("validateUrl", () => {
  let validateUrl: (url: string) => { valid: boolean; reason?: string };

  beforeAll(async () => {
    const mod = await import("../../src/web/ssrf-guard");
    validateUrl = mod.validateUrl;
  });

  // -----------------------------------------------------------------------
  // Basic input validation
  // -----------------------------------------------------------------------

  it("rejects empty string", () => {
    const result = validateUrl("");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("non-empty string");
  });

  it("rejects whitespace-only string", () => {
    const result = validateUrl("   ");
    expect(result.valid).toBe(false);
  });

  it("rejects URL with no protocol scheme", () => {
    const result = validateUrl("example.com/path");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("missing a protocol scheme");
  });

  // -----------------------------------------------------------------------
  // Protocol restrictions
  // -----------------------------------------------------------------------

  it("rejects file:// protocol", () => {
    const result = validateUrl("file:///etc/passwd");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("not allowed");
  });

  it("rejects ftp:// protocol", () => {
    const result = validateUrl("ftp://ftp.example.com/file");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("not allowed");
  });

  it("rejects data: URIs", () => {
    const result = validateUrl("data:text/html,<script>alert('xss')</script>");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("not allowed");
  });

  it("rejects javascript: URIs", () => {
    const result = validateUrl("javascript:alert('xss')");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("not allowed");
  });

  // -----------------------------------------------------------------------
  // Malformed URLs
  // -----------------------------------------------------------------------

  it("rejects malformed URL that cannot be parsed", () => {
    const result = validateUrl("http://");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("malformed");
  });

  it("rejects malformed URL with invalid characters", () => {
    const result = validateUrl("http://exa mple.com/path");
    expect(result.valid).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Internal hostnames
  // -----------------------------------------------------------------------

  it("blocks localhost", () => {
    const result = validateUrl("http://localhost:8080/secret");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("localhost");
    expect(result.reason).toContain("internal");
  });

  it("blocks *.local hostnames", () => {
    const result = validateUrl("http://myapp.local/api");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("internal");
  });

  it("blocks *.internal hostnames", () => {
    const result = validateUrl("http://database.internal/query");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("internal");
  });

  it("blocks bare 'local' hostname", () => {
    const result = validateUrl("http://local/");
    expect(result.valid).toBe(false);
  });

  it("blocks bare 'internal' hostname", () => {
    const result = validateUrl("http://internal/");
    expect(result.valid).toBe(false);
  });

  // -----------------------------------------------------------------------
  // RFC 1918 Private IPv4 — Class A (10.0.0.0/8)
  // -----------------------------------------------------------------------

  it("blocks 10.0.0.0/8 RFC 1918 Class A", () => {
    const result = validateUrl("http://10.0.0.1/admin");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("private");
  });

  it("blocks 10.255.255.255 (upper edge of Class A)", () => {
    const result = validateUrl("http://10.255.255.255/");
    expect(result.valid).toBe(false);
  });

  // -----------------------------------------------------------------------
  // RFC 1918 Private IPv4 — Class B (172.16.0.0/12)
  // -----------------------------------------------------------------------

  it("blocks 172.16.0.0/12 RFC 1918 Class B lower edge", () => {
    const result = validateUrl("http://172.16.0.1/");
    expect(result.valid).toBe(false);
  });

  it("blocks 172.31.255.255 (upper edge of Class B)", () => {
    const result = validateUrl("http://172.31.255.255/");
    expect(result.valid).toBe(false);
  });

  it("does NOT block 172.15.0.0/16 (outside Class B range)", () => {
    const result = validateUrl("http://172.15.0.1/");
    // Not in 172.16-31 range, so not private by this rule
    expect(result.valid).toBe(true);
  });

  it("does NOT block 172.32.0.0/16 (outside Class B range)", () => {
    const result = validateUrl("http://172.32.0.1/");
    expect(result.valid).toBe(true);
  });

  // -----------------------------------------------------------------------
  // RFC 1918 Private IPv4 — Class C (192.168.0.0/16)
  // -----------------------------------------------------------------------

  it("blocks 192.168.0.0/16 RFC 1918 Class C", () => {
    const result = validateUrl("http://192.168.1.1/");
    expect(result.valid).toBe(false);
  });

  it("blocks 192.168.255.255 (upper edge of Class C)", () => {
    const result = validateUrl("http://192.168.255.255/");
    expect(result.valid).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Loopback IPv4
  // -----------------------------------------------------------------------

  it("blocks 127.0.0.0/8 loopback range", () => {
    const result = validateUrl("http://127.0.0.1/");
    expect(result.valid).toBe(false);
  });

  it("blocks 127.255.255.255 (upper edge of loopback)", () => {
    const result = validateUrl("http://127.255.255.255/");
    expect(result.valid).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 0.0.0.0 (local binding)
  // -----------------------------------------------------------------------

  it("blocks 0.0.0.0", () => {
    const result = validateUrl("http://0.0.0.0/");
    expect(result.valid).toBe(false);
  });

  // =======================================================================
  // Link-local IPv4 (169.254.0.0/16) — RFC 3927
  // =======================================================================

  it("blocks 169.254.0.0/16 link-local (lower edge)", () => {
    const result = validateUrl("http://169.254.0.1/");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("link-local");
  });

  it("blocks 169.254.169.254 (AWS metadata endpoint)", () => {
    const result = validateUrl("http://169.254.169.254/");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("link-local");
  });

  it("blocks 169.254.255.255 (upper edge of link-local)", () => {
    const result = validateUrl("http://169.254.255.255/");
    expect(result.valid).toBe(false);
  });

  it("does NOT block 169.253.x.x (outside link-local range)", () => {
    const result = validateUrl("http://169.253.0.1/");
    expect(result.valid).toBe(true);
  });

  it("does NOT block 169.255.x.x (outside link-local range)", () => {
    const result = validateUrl("http://169.255.0.1/");
    expect(result.valid).toBe(true);
  });

  // -----------------------------------------------------------------------
  // IPv6 loopback
  // -----------------------------------------------------------------------

  it("blocks IPv6 loopback ::1", () => {
    const result = validateUrl("http://[::1]:8080/");
    expect(result.valid).toBe(false);
  });

  it("blocks IPv6 loopback ::1 (bracketless)", () => {
    const result = validateUrl("http://::1/");
    expect(result.valid).toBe(false);
  });

  // -----------------------------------------------------------------------
  // IPv4-mapped IPv6 private addresses
  // -----------------------------------------------------------------------

  it("blocks IPv4-mapped IPv6 for 127.0.0.1 (::ffff:127.0.0.1)", () => {
    const result = validateUrl("http://[::ffff:127.0.0.1]/");
    expect(result.valid).toBe(false);
  });

  it("blocks IPv4-mapped IPv6 for 10.0.0.1 (::ffff:10.0.0.1)", () => {
    const result = validateUrl("http://[::ffff:10.0.0.1]/");
    expect(result.valid).toBe(false);
  });

  it("blocks IPv4-mapped IPv6 for 192.168.1.1 (::ffff:192.168.1.1)", () => {
    const result = validateUrl("http://[::ffff:192.168.1.1]/");
    expect(result.valid).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Valid public URLs — must pass
  // -----------------------------------------------------------------------

  it("allows valid https URL to public host", () => {
    const result = validateUrl("https://example.com/page");
    expect(result.valid).toBe(true);
  });

  it("allows http URL to public host", () => {
    const result = validateUrl("http://example.com/page");
    expect(result.valid).toBe(true);
  });

  it("allows URL with ports", () => {
    const result = validateUrl("https://api.example.com:443/v1/data");
    expect(result.valid).toBe(true);
  });

  it("allows URL with query parameters", () => {
    const result = validateUrl("https://example.com/search?q=test&page=2");
    expect(result.valid).toBe(true);
  });

  it("allows URL with path and fragment", () => {
    const result = validateUrl("https://example.com/docs#section-1");
    expect(result.valid).toBe(true);
  });

  it("allows public IPv4 addresses not in private ranges", () => {
    const result = validateUrl("http://8.8.8.8/");
    expect(result.valid).toBe(true);
  });

  it("allows public IPv4 (93.184.216.34 example.com)", () => {
    const result = validateUrl("http://93.184.216.34/");
    expect(result.valid).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it("blocks https localhost too (not just http)", () => {
    const result = validateUrl("https://localhost:3000/");
    expect(result.valid).toBe(false);
  });

  it("rejects protocol-relative URL without scheme", () => {
    const result = validateUrl("//example.com/path");
    expect(result.valid).toBe(false);
  });

  it("rejects bare IP with no protocol", () => {
    const result = validateUrl("10.0.0.1");
    expect(result.valid).toBe(false);
  });

  it("rejects garbage input", () => {
    const result = validateUrl("not-a-url-at-all!!!");
    expect(result.valid).toBe(false);
  });
});
