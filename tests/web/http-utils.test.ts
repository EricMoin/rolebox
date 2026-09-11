import { describe, it, expect, mock, afterEach } from "bun:test";

// -----------------------------------------------------------------------
// TokenBucket
// -----------------------------------------------------------------------

describe("TokenBucket", () => {
  it("provides tokens up to the rate limit immediately", async () => {
    const { TokenBucket } = await import("../../src/web/http-utils");

    const bucket = new TokenBucket(5); // 5 tokens per minute
    for (let i = 0; i < 5; i++) {
      const start = Date.now();
      await bucket.acquire();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(50);
    }
  });

  it("exhaustion causes acquire to wait for token refill", async () => {
    const { TokenBucket } = await import("../../src/web/http-utils");

    // Rate = 600/min = 10 per second, capacity = 1
    // After consuming the only token, next acquire waits ~100ms for 1 refill
    const bucket = new TokenBucket(600);
    // Consume all tokens (capacity = 600). We'll consume all but wait for refill.
    // Simpler: use capacity = 1 by consuming 600 times... no, that's a lot.
    // Better approach: TokenBucket(600) gives 600 tokens. After 600 acquires (0), wait.
    for (let i = 0; i < 600; i++) {
      await bucket.acquire();
    }
    // All tokens consumed. Next acquire must wait.
    const start = Date.now();
    await bucket.acquire();
    const elapsed = Date.now() - start;
    // At 600/min (10/sec), 1 token refills in ~100ms
    expect(elapsed).toBeGreaterThanOrEqual(80);
  });

  it("tokens refill gradually over time", async () => {
    const { TokenBucket } = await import("../../src/web/http-utils");

    // Rate = 1200/min = 20 per second
    // Consume initial tokens, then measure refill for 2 tokens
    const bucket = new TokenBucket(1200);
    for (let i = 0; i < 1200; i++) {
      await bucket.acquire();
    }
    // Consumed all 1200. Wait briefly to accumulate tokens.
    const start = Date.now();
    await bucket.acquire(); // wait for 1 token
    const elapsed = Date.now() - start;
    // 1200/min = 20/sec → 1 token = 50ms
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});

// -----------------------------------------------------------------------
// fetchWithRetry
// -----------------------------------------------------------------------

describe("fetchWithRetry", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("resolves successfully on first try", async () => {
    const { fetchWithRetry } = await import("../../src/web/http-utils");

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("ok", { status: 200 })),
    );

    const response = await fetchWithRetry("https://example.com");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe("ok");
  });

  it("retries on 5xx server errors", async () => {
    const { fetchWithRetry } = await import("../../src/web/http-utils");

    let attempts = 0;
    globalThis.fetch = mock(() => {
      attempts++;
      if (attempts <= 2) {
        return Promise.resolve(new Response("server error", { status: 500 }));
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const response = await fetchWithRetry(
      "https://example.com",
      {},
      3,  // maxRetries
      10, // baseDelayMs — small for test speed
    );
    expect(response.status).toBe(200);
    expect(attempts).toBe(3);
  });

  it("retries on 4xx client errors (non-429) because the throw is caught by the generic retry loop", async () => {
    // Note: the source code throws on 4xx, which lands in the catch block
    // and triggers retry. This is current behavior.
    const { fetchWithRetry } = await import("../../src/web/http-utils");

    let attempts = 0;
    globalThis.fetch = mock(() => {
      attempts++;
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    await expect(
      fetchWithRetry("https://example.com", {}, 3, 10),
    ).rejects.toThrow(/HTTP 404|Failed to fetch/);
    // The throw on 4xx is caught by the catch block and retried.
    expect(attempts).toBe(4); // attempt 0..3 = 4 total
  });

  it("retries on 429 and respects Retry-After header", async () => {
    const { fetchWithRetry } = await import("../../src/web/http-utils");

    let attempts = 0;
    globalThis.fetch = mock(() => {
      attempts++;
      if (attempts === 1) {
        return Promise.resolve(
          new Response("rate limited", {
            status: 429,
            headers: { "Retry-After": "0" },
          }),
        );
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const response = await fetchWithRetry(
      "https://example.com",
      {},
      3,
      10,
    );
    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
  });

  it("throws after max retries exhausted on 5xx", async () => {
    const { fetchWithRetry } = await import("../../src/web/http-utils");

    let attempts = 0;
    globalThis.fetch = mock(() => {
      attempts++;
      return Promise.resolve(new Response("server error", { status: 500 }));
    });

    await expect(
      fetchWithRetry("https://example.com", {}, 2, 10),
    ).rejects.toThrow(/Failed to fetch|HTTP 500/);
    // maxRetries=2 means attempts 0, 1, 2 = 3 total
    expect(attempts).toBe(3);
  });

  it("retries on network errors", async () => {
    const { fetchWithRetry } = await import("../../src/web/http-utils");

    let attempts = 0;
    globalThis.fetch = mock(() => {
      attempts++;
      if (attempts <= 2) {
        return Promise.reject(new Error("network failure"));
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const response = await fetchWithRetry(
      "https://example.com",
      {},
      3,
      10,
    );
    expect(response.status).toBe(200);
    expect(attempts).toBe(3);
  });
});

// -----------------------------------------------------------------------
// fetchWithTimeout
// -----------------------------------------------------------------------

describe("fetchWithTimeout", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("resolves normally when fetch completes in time", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("ok", { status: 200 })),
    );

    const { fetchWithTimeout } = await import("../../src/web/http-utils");
    const response = await fetchWithTimeout("https://example.com", {}, 5000);
    expect(response.status).toBe(200);
  });

  it("passes an AbortSignal to the fetch call", async () => {
    let passedSignal: AbortSignal | undefined;

    globalThis.fetch = mock((url: string, opts: RequestInit = {}) => {
      passedSignal = opts.signal as AbortSignal;
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const { fetchWithTimeout } = await import("../../src/web/http-utils");
    await fetchWithTimeout("https://example.com", {}, 5000);

    expect(passedSignal).toBeDefined();
    expect(passedSignal!.aborted).toBe(false);
  });
});
