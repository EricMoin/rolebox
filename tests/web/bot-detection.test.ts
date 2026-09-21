import { describe, it, expect } from "bun:test";
import { BLOCK_MARKERS, detectBlockSignal, isJinaErrorBody } from "../../src/web/bot-detection";

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

// -----------------------------------------------------------------------
// Status + corroboration
// -----------------------------------------------------------------------

describe("detectBlockSignal", () => {
  it("flags a Cloudflare 403 challenge from the cf-mitigated header", () => {
    const signal = detectBlockSignal({
      status: 403,
      headers: headers({ "cf-mitigated": "challenge" }),
    });

    expect(signal.blocked).toBe(true);
    expect(signal.provider).toBe("cloudflare");
    expect(signal.reason.length).toBeGreaterThan(0);
  });

  it("flags a Cloudflare challenge body on a 200 (advisory)", () => {
    const body = "<html><head><title>Just a moment...</title></head><body>cf_chl_opt</body></html>";
    const signal = detectBlockSignal({ status: 200, bodySample: body });

    expect(signal.blocked).toBe(true);
    expect(signal.provider).toBe("cloudflare");
  });

  it("flags a Cloudflare challenge body on a 503", () => {
    const signal = detectBlockSignal({
      status: 503,
      bodySample: "Checking your browser before accessing the site.",
    });

    expect(signal.blocked).toBe(true);
    expect(signal.provider).toBe("cloudflare");
  });

  it("does not flag a plain 403 with a JSON auth error body", () => {
    const signal = detectBlockSignal({
      status: 403,
      headers: headers({ "content-type": "application/json" }),
      bodySample: JSON.stringify({ error: "forbidden", message: "Invalid API key" }),
    });

    expect(signal.blocked).toBe(false);
    expect(signal.provider).toBeNull();
    expect(signal.reason).toContain("403");
  });

  it("does not flag a long legitimate 200 article that mentions captcha", () => {
    const body = "captcha ".repeat(4000);
    expect(body.length).toBeGreaterThan(16384);

    const signal = detectBlockSignal({ status: 200, bodySample: body });

    expect(signal.blocked).toBe(false);
    expect(signal.provider).toBeNull();
  });

  it("skips the advisory 2xx scan when the real body is long", () => {
    // A 36 KB article that quotes an interstitial string in its first 8 KB.
    const article = `<html><body><p>Just a moment...</p>${"<p>lorem ipsum dolor sit amet consectetur</p>".repeat(1200)}</body></html>`;
    expect(article.length).toBeGreaterThan(16384);

    // The caller only hands over a short prefix, so it reports the real length.
    const signal = detectBlockSignal({
      status: 200,
      bodySample: article.slice(0, 8192),
      bodyLength: article.length,
    });

    expect(signal.blocked).toBe(false);
    expect(signal.provider).toBeNull();
  });

  it("still flags a short 200 interstitial without an explicit bodyLength", () => {
    const signal = detectBlockSignal({ status: 200, bodySample: "Just a moment..." });

    expect(signal.blocked).toBe(true);
    expect(signal.provider).toBe("cloudflare");
  });

  it("keeps collision-prone tokens out of the advisory 2xx scan", () => {
    const akamai = detectBlockSignal({ status: 200, bodySample: "See Reference #42 for details." });
    expect(akamai.blocked).toBe(false);

    const perimeterx = detectBlockSignal({ status: 200, bodySample: "<p>Use the --space_px token.</p>" });
    expect(perimeterx.blocked).toBe(false);
  });

  it("still attributes those tokens on a corroborated 403", () => {
    const akamai = detectBlockSignal({ status: 403, bodySample: "Access Denied. Reference #18.abcd1234" });
    expect(akamai.blocked).toBe(true);
    expect(akamai.provider).toBe("akamai");

    const perimeterx = detectBlockSignal({
      status: 403,
      bodySample: "<script>window._pxAppId = 'PX1234';</script>",
    });
    expect(perimeterx.blocked).toBe(true);
    expect(perimeterx.provider).toBe("perimeterx");
  });

  it("marks the collision-prone tokens as corroborated-only", () => {
    const generic = BLOCK_MARKERS.filter((entry) => entry.corroboratedOnly === true).map((entry) => entry.marker);

    expect(generic).toContain("reference #");
    expect(generic).toContain("_px");
  });

  it("does not flag a 404", () => {
    const signal = detectBlockSignal({ status: 404, bodySample: "Not Found" });

    expect(signal.blocked).toBe(false);
    expect(signal.provider).toBeNull();
  });

  it("attributes DataDome and Sucuri interstitials", () => {
    const datadome = detectBlockSignal({
      status: 403,
      bodySample: "<script>window.datadome = { config: {} }</script>",
    });
    expect(datadome.blocked).toBe(true);
    expect(datadome.provider).toBe("datadome");

    const sucuri = detectBlockSignal({
      status: 403,
      bodySample: "Sucuri WebSite Firewall - Access Denied (sucuri_cloudproxy)",
    });
    expect(sucuri.blocked).toBe(true);
    expect(sucuri.provider).toBe("sucuri");
  });

  it("attributes Akamai and PerimeterX interstitials", () => {
    const akamai = detectBlockSignal({
      status: 403,
      bodySample: "Access Denied. Reference #18.abcd1234",
    });
    expect(akamai.blocked).toBe(true);
    expect(akamai.provider).toBe("akamai");

    const perimeterx = detectBlockSignal({
      status: 403,
      bodySample: "<div id=\"px-captcha\"></div>",
    });
    expect(perimeterx.blocked).toBe(true);
    expect(perimeterx.provider).toBe("perimeterx");
  });

  it("attributes a provider named by Server or X-Powered-By", () => {
    const byServer = detectBlockSignal({ status: 429, headers: headers({ server: "AkamaiGHost" }) });
    expect(byServer.blocked).toBe(true);
    expect(byServer.provider).toBe("akamai");

    const byPoweredBy = detectBlockSignal({
      status: 503,
      headers: headers({ "x-powered-by": "Sucuri/Cloudproxy" }),
    });
    expect(byPoweredBy.blocked).toBe(true);
    expect(byPoweredBy.provider).toBe("sucuri");
  });

  it("keeps the marker table lowercase and single-sourced", () => {
    expect(BLOCK_MARKERS.length).toBeGreaterThan(10);
    for (const entry of BLOCK_MARKERS) {
      expect(entry.provider.length).toBeGreaterThan(0);
      expect(entry.marker).toBe(entry.marker.toLowerCase());
    }
  });
});

// -----------------------------------------------------------------------
// Jina error bodies
// -----------------------------------------------------------------------

describe("isJinaErrorBody", () => {
  it("detects the Warning: form", () => {
    expect(isJinaErrorBody("Warning: Target URL returned error 403: Forbidden")).toBe(true);
  });

  it("detects the Target URL returned error form", () => {
    expect(isJinaErrorBody("Target URL returned error 429: Too Many Requests")).toBe(true);
  });

  it("detects the Failed to fetch form", () => {
    expect(isJinaErrorBody("Failed to fetch https://example.com")).toBe(true);
  });

  it("does not match ordinary markdown content", () => {
    const markdown = [
      "# Handling network errors",
      "",
      "This article explains how a request can fail and how to recover.",
      "",
      "```js",
      "try { await fetch(url); } catch (error) { report(error); }",
      "```",
      "",
      "Further reading: the warning label is rendered by the client.",
    ].join("\n");

    expect(isJinaErrorBody(markdown)).toBe(false);
  });

  it("only inspects the first 500 characters", () => {
    expect(isJinaErrorBody("x".repeat(600) + "Warning: delayed")).toBe(false);
  });
});
