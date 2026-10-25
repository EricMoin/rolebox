import { describe, it, expect, beforeEach, vi } from "vitest";

const available = { playwright: false, crawlee: false };

describe("browser-detect", () => {
  let detectBrowserCapabilities: () => Promise<{
    playwright: boolean;
    crawlee: boolean;
    checked: boolean;
  }>;
  let getCachedCapabilities: () => {
    playwright: boolean;
    crawlee: boolean;
    checked: boolean;
  };
  let __resetBrowserDetection: () => void;

  beforeEach(async () => {
    vi.resetModules();
    available.playwright = false;
    available.crawlee = false;
    vi.doMock("playwright", () => {
      if (!available.playwright) throw new Error("Playwright fixture is unavailable");
      return {};
    });
    vi.doMock("crawlee", () => {
      if (!available.crawlee) throw new Error("Crawlee fixture is unavailable");
      return {};
    });
    const mod = await import("../../src/web/browser-detect.ts");
    detectBrowserCapabilities = mod.detectBrowserCapabilities;
    getCachedCapabilities = mod.getCachedCapabilities;
    __resetBrowserDetection = mod.__resetBrowserDetection;
  });

  // -----------------------------------------------------------------------
  // Initial state before detection
  // -----------------------------------------------------------------------

  it("getCachedCapabilities returns initial false state before detection", () => {
    const caps = getCachedCapabilities();
    expect(caps.playwright).toBe(false);
    expect(caps.crawlee).toBe(false);
    expect(caps.checked).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Detection without installed packages
  // -----------------------------------------------------------------------

  it("detectBrowserCapabilities reports no backends when packages are absent", async () => {
    const caps = await detectBrowserCapabilities();
    expect(caps.playwright).toBe(false);
    expect(caps.crawlee).toBe(false);
    expect(caps.checked).toBe(true);
  });

  it.each([[true, false], [false, true], [true, true]])("detects installed backends: playwright=%s, crawlee=%s", async (playwright, crawlee) => {
    Object.assign(available, { playwright, crawlee });
    expect(await detectBrowserCapabilities()).toEqual({ playwright, crawlee, checked: true });
  });

  // -----------------------------------------------------------------------
  // Caching behavior
  // -----------------------------------------------------------------------

  it("results are cached after first detection call", async () => {
    const first = await detectBrowserCapabilities();
    const second = await detectBrowserCapabilities();

    // Second call should return the same object reference (cached)
    expect(second).toBe(first);
    expect(second.checked).toBe(true);
  });

  it("subsequent calls return instantly without re-importing", async () => {
    await detectBrowserCapabilities();
    const cached = getCachedCapabilities();
    expect(cached.checked).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Reset
  // -----------------------------------------------------------------------

  it("__resetBrowserDetection resets all capabilities to false", () => {
    __resetBrowserDetection();
    const caps = getCachedCapabilities();
    expect(caps.playwright).toBe(false);
    expect(caps.crawlee).toBe(false);
    expect(caps.checked).toBe(false);
  });

  it("detection can re-run after reset", async () => {
    // First detection
    await detectBrowserCapabilities();
    expect(getCachedCapabilities().checked).toBe(true);

    // Reset
    __resetBrowserDetection();
    expect(getCachedCapabilities().checked).toBe(false);

    // Re-detect — triggers new dynamic imports
    const caps = await detectBrowserCapabilities();
    expect(caps.checked).toBe(true);
  });

  // -----------------------------------------------------------------------
  // getCachedCapabilities consistency
  // -----------------------------------------------------------------------

  it("getCachedCapabilities matches last detection result", async () => {
    await detectBrowserCapabilities();
    const detected = getCachedCapabilities();
    const direct = await detectBrowserCapabilities();

    expect(detected.playwright).toBe(direct.playwright);
    expect(detected.crawlee).toBe(direct.crawlee);
    expect(detected.checked).toBe(true);
  });
});
