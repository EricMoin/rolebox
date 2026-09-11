import { describe, it, expect, beforeAll, beforeEach } from "bun:test";

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

  beforeAll(async () => {
    const mod = await import("../../src/web/browser-detect");
    detectBrowserCapabilities = mod.detectBrowserCapabilities;
    getCachedCapabilities = mod.getCachedCapabilities;
    __resetBrowserDetection = mod.__resetBrowserDetection;
  });

  beforeEach(() => {
    __resetBrowserDetection();
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
    // In the test environment, playwright and crawlee are not installed
    // (they are optional peer dependencies)
    expect(caps.playwright).toBe(false);
    expect(caps.crawlee).toBe(false);
    expect(caps.checked).toBe(true);
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
