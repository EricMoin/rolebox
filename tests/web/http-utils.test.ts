import { describe, it, expect, mock, afterEach } from "bun:test";
import {
  __configureHostPacing,
  __resetHostPacing,
  BROWSER_CHROME_MAJOR,
  BROWSER_USER_AGENT,
  DEFAULT_USER_AGENT,
  buildBrowserHeaders,
  fetchWithCloudflareRetry,
  fetchWithTimeout,
  isRetryableStatus,
  parseRetryAfter,
  resolveDefaultUserAgent,
} from "../../src/web/http-utils";

// The per-host pacing gate defaults to a 1000 ms gap between request starts to
// the same origin, so a real process does not look like a burst. This suite is
// offline and reuses a few origins, so disable the gate here; the "per-host
// pacing" describe below re-enables a small interval locally and restores this
// configuration in afterEach.
__configureHostPacing({ minIntervalMs: 0, jitterMs: 0 });

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

  it("serializes concurrent acquires so each respects the refill window", async () => {
    const { TokenBucket } = await import("../../src/web/http-utils");

    // Rate = 600/min = 10/sec: one token refills every ~100 ms, capacity 600.
    const bucket = new TokenBucket(600);
    for (let i = 0; i < 600; i++) {
      await bucket.acquire();
    }

    // Four concurrent callers must wait for their own refill window instead of
    // all waking at once and driving the bucket negative.
    const start = Date.now();
    await Promise.all([bucket.acquire(), bucket.acquire(), bucket.acquire(), bucket.acquire()]);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(350);
  }, 10000);
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

  it("does not retry client errors other than 408/425/429", async () => {
    // A 403/404 will not become a success by repeating the request, and
    // retrying it only amplifies a block, so the error is thrown immediately.
    const { fetchWithRetry } = await import("../../src/web/http-utils");

    let attempts = 0;
    globalThis.fetch = mock(() => {
      attempts++;
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    await expect(
      fetchWithRetry("https://example.com", {}, 3, 10),
    ).rejects.toThrow(/HTTP 404|Failed to fetch/);
    // The client error is thrown on the first attempt — no retries.
    expect(attempts).toBe(1);
  });

  it("retries 408 and 425 like other transient statuses", async () => {
    const { fetchWithRetry } = await import("../../src/web/http-utils");

    let attempts = 0;
    globalThis.fetch = mock(() => {
      attempts++;
      if (attempts === 1) {
        return Promise.resolve(new Response("timeout", { status: 408 }));
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const response = await fetchWithRetry("https://example.com", {}, 2, 10);
    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
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

  it("sleeps between 5xx retries instead of hammering the server", async () => {
    const { fetchWithRetry } = await import("../../src/web/http-utils");

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("server error", { status: 500 })),
    );

    const start = Date.now();
    await expect(
      fetchWithRetry("https://example.com", {}, 3, 20),
    ).rejects.toThrow(/HTTP 500|Failed to fetch/);
    const elapsed = Date.now() - start;

    // Three status retries now sleep: 10..20 + 20..40 + 40..80 ms.
    expect(elapsed).toBeGreaterThanOrEqual(65);
  });
});

// -----------------------------------------------------------------------
// buildBrowserHeaders
// -----------------------------------------------------------------------

describe("buildBrowserHeaders", () => {
  it("returns an internally consistent browser profile", () => {
    const headers = buildBrowserHeaders();

    const major = /Chrome\/(\d+)/.exec(headers["User-Agent"])?.[1];
    expect(major).toBe(BROWSER_CHROME_MAJOR);
    expect(headers["User-Agent"]).toBe(BROWSER_USER_AGENT);
    expect(headers["sec-ch-ua"]).toContain(`v="${BROWSER_CHROME_MAJOR}"`);
    expect(headers["sec-ch-ua-mobile"]).toBe("?0");
    expect(headers["sec-ch-ua-platform"]).toBe('"macOS"');
    expect(headers["Accept"]).toBe("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    expect(headers["Accept-Language"]).toBe("en-US,en;q=0.9");
    expect(headers["Sec-Fetch-Site"]).toBe("none");
    expect(headers["Sec-Fetch-Mode"]).toBe("navigate");
    expect(headers["Sec-Fetch-User"]).toBe("?1");
    expect(headers["Sec-Fetch-Dest"]).toBe("document");
    expect(headers["Upgrade-Insecure-Requests"]).toBe("1");
  });

  it("never sets Accept-Encoding", () => {
    const keys = Object.keys(buildBrowserHeaders()).map((key) => key.toLowerCase());
    expect(keys).not.toContain("accept-encoding");
  });

  it("returns a fresh object on every call", () => {
    const first = buildBrowserHeaders();
    const second = buildBrowserHeaders();

    expect(first).not.toBe(second);
    first["User-Agent"] = "mutated";
    expect(second["User-Agent"]).toBe(BROWSER_USER_AGENT);
  });

  it("honours Accept and Accept-Language overrides", () => {
    const headers = buildBrowserHeaders({ accept: "application/json", language: "de-DE,de;q=0.9" });
    expect(headers["Accept"]).toBe("application/json");
    expect(headers["Accept-Language"]).toBe("de-DE,de;q=0.9");
  });

  it("adds Referer and same-origin Sec-Fetch-Site when a referer is given", () => {
    const headers = buildBrowserHeaders({ referer: "https://example.com/from" });
    expect(headers["Referer"]).toBe("https://example.com/from");
    expect(headers["Sec-Fetch-Site"]).toBe("same-origin");
  });
});

// -----------------------------------------------------------------------
// resolveDefaultUserAgent
// -----------------------------------------------------------------------

describe("resolveDefaultUserAgent", () => {
  const NEUTRAL = "rolebox-web/1.0 (+https://www.npmjs.com/package/rolebox)";

  it("falls back to the neutral default when unset, empty or whitespace-only", () => {
    expect(resolveDefaultUserAgent(undefined)).toBe(NEUTRAL);
    expect(resolveDefaultUserAgent("")).toBe(NEUTRAL);
    expect(resolveDefaultUserAgent("   ")).toBe(NEUTRAL);
  });

  it("returns a valid configured value trimmed and unchanged", () => {
    expect(resolveDefaultUserAgent("rolebox-web/1.0 (+ops@example.com)")).toBe("rolebox-web/1.0 (+ops@example.com)");
    expect(resolveDefaultUserAgent("  rolebox-web/1.0 (+ops@example.com)  ")).toBe("rolebox-web/1.0 (+ops@example.com)");
  });

  it("rejects header injection, control characters and non-ASCII values", () => {
    expect(resolveDefaultUserAgent("rolebox-web/1.0\r\nX-Injected: 1")).toBe(NEUTRAL);
    expect(resolveDefaultUserAgent("rolebox-web/1.0\tX-Injected: 1")).toBe(NEUTRAL);
    expect(resolveDefaultUserAgent("rolebox-web/1.0\u0000")).toBe(NEUTRAL);
    expect(resolveDefaultUserAgent("rolebox-web/1.0 (+ü@example.com)")).toBe(NEUTRAL);
  });

  it("rejects a value longer than 256 characters after trimming", () => {
    expect(resolveDefaultUserAgent("a".repeat(300))).toBe(NEUTRAL);
    expect(resolveDefaultUserAgent(`  ${"a".repeat(300)}  `)).toBe(NEUTRAL);
    // 256 characters after trimming is the boundary and is still accepted.
    const boundary = "a".repeat(256);
    expect(resolveDefaultUserAgent(boundary)).toBe(boundary);
  });

  it("keeps the neutral default free of personal data", () => {
    const neutral = resolveDefaultUserAgent(undefined);
    expect(neutral).not.toContain("@");
    expect(neutral).not.toMatch(/[\r\n\t]/);
    expect(/^[\x20-\x7e]+$/.test(neutral)).toBe(true);
  });
});

// -----------------------------------------------------------------------
// parseRetryAfter / isRetryableStatus
// -----------------------------------------------------------------------

describe("parseRetryAfter", () => {
  it("parses delta-seconds into milliseconds", () => {
    expect(parseRetryAfter("120", 1000, 180000)).toBe(120000);
    expect(parseRetryAfter("0", 1000, 60000)).toBe(0);
    expect(parseRetryAfter(" 1.5 ", 1000, 60000)).toBe(1500);
  });

  it("parses an HTTP-date in the future", () => {
    const header = new Date(Date.now() + 5000).toUTCString();
    const waitMs = parseRetryAfter(header, 1000, 60000);
    // HTTP-dates have one-second resolution, so allow for truncation.
    expect(waitMs).toBeGreaterThanOrEqual(3500);
    expect(waitMs).toBeLessThanOrEqual(5000);
  });

  it("ignores an HTTP-date in the past, NaN and negative values", () => {
    const past = new Date(Date.now() - 60000).toUTCString();
    expect(parseRetryAfter(past, 2500, 60000)).toBe(2500);
    expect(parseRetryAfter("not-a-delay", 2500, 60000)).toBe(2500);
    expect(parseRetryAfter("-5", 2500, 60000)).toBe(2500);
  });

  it("returns the fallback when the header is absent", () => {
    expect(parseRetryAfter(null, 3000, 10000)).toBe(3000);
  });

  it("clamps to [0, maxMs]", () => {
    expect(parseRetryAfter("3600", 1000, 10000)).toBe(10000);
    expect(parseRetryAfter("0", -100, 10000)).toBe(0);
  });
});

describe("isRetryableStatus", () => {
  it("retries only transient statuses", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504, 599]) {
      expect({ status, retryable: isRetryableStatus(status) }).toEqual({ status, retryable: true });
    }
    for (const status of [200, 201, 204, 301, 302, 400, 401, 403, 404, 418, 422, 499]) {
      expect({ status, retryable: isRetryableStatus(status) }).toEqual({ status, retryable: false });
    }
  });
});

// -----------------------------------------------------------------------
// Per-host pacing
// -----------------------------------------------------------------------

describe("per-host pacing", () => {
  afterEach(() => {
    delete process.env.ROLEBOX_WEB_HOST_MIN_INTERVAL_MS;
    __resetHostPacing();
    // Reset restores the 1000 ms environment default; disable the gate again
    // so later tests in this file are not delayed.
    __configureHostPacing({ minIntervalMs: 0, jitterMs: 0 });
  });

  it("spaces two sequential same-origin request starts by the interval", async () => {
    __configureHostPacing({ minIntervalMs: 80, jitterMs: 0 });
    globalThis.fetch = mock(() => Promise.resolve(new Response("ok", { status: 200 })));

    await fetchWithTimeout("https://pacing-a.example.com/one", {}, 5000);
    const start = Date.now();
    await fetchWithTimeout("https://pacing-a.example.com/two", {}, 5000);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(70);
  });

  it("serializes concurrent same-origin callers", async () => {
    __configureHostPacing({ minIntervalMs: 80, jitterMs: 0 });
    globalThis.fetch = mock(() => Promise.resolve(new Response("ok", { status: 200 })));

    const start = Date.now();
    await Promise.all([
      fetchWithTimeout("https://pacing-b.example.com/one", {}, 5000),
      fetchWithTimeout("https://pacing-b.example.com/two", {}, 5000),
      fetchWithTimeout("https://pacing-b.example.com/three", {}, 5000),
    ]);
    const elapsed = Date.now() - start;

    // Three starts, two gaps.
    expect(elapsed).toBeGreaterThanOrEqual(150);
  });

  it("does not delay a different origin", async () => {
    __configureHostPacing({ minIntervalMs: 80, jitterMs: 0 });
    globalThis.fetch = mock(() => Promise.resolve(new Response("ok", { status: 200 })));

    await fetchWithTimeout("https://pacing-c.example.com/one", {}, 5000);
    const start = Date.now();
    await fetchWithTimeout("https://pacing-d.example.com/one", {}, 5000);

    expect(Date.now() - start).toBeLessThan(60);
  });

  it("removes the delay when the interval is configured to 0", async () => {
    __configureHostPacing({ minIntervalMs: 0, jitterMs: 0 });
    globalThis.fetch = mock(() => Promise.resolve(new Response("ok", { status: 200 })));

    const start = Date.now();
    await fetchWithTimeout("https://pacing-e.example.com/one", {}, 5000);
    await fetchWithTimeout("https://pacing-e.example.com/two", {}, 5000);

    expect(Date.now() - start).toBeLessThan(30);
  });

  it("honours ROLEBOX_WEB_HOST_MIN_INTERVAL_MS after a reset", async () => {
    process.env.ROLEBOX_WEB_HOST_MIN_INTERVAL_MS = "0";
    __resetHostPacing();
    globalThis.fetch = mock(() => Promise.resolve(new Response("ok", { status: 200 })));

    const start = Date.now();
    await fetchWithTimeout("https://pacing-f.example.com/one", {}, 5000);
    await fetchWithTimeout("https://pacing-f.example.com/two", {}, 5000);

    // The env value (0) is honoured: the reset restores the default 1000 ms
    // interval (plus up to 250 ms jitter), which this bound excludes.
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("keeps later same-origin callers moving when the wait fails", async () => {
    __configureHostPacing({ minIntervalMs: 80, jitterMs: 0 });
    globalThis.fetch = mock(() => Promise.resolve(new Response("ok", { status: 200 })));

    await fetchWithTimeout("https://pacing-g.example.com/one", {}, 5000);

    // Fail the pacing timer for exactly one request. The gate rejects, but it
    // must still release this origin's slot; before that guarantee the next
    // caller to the same origin waited on a chain that never settled.
    const realSetTimeout = globalThis.setTimeout;
    let timerCalls = 0;
    globalThis.setTimeout = ((handler: () => void, timeout?: number) => {
      timerCalls += 1;
      if (timerCalls === 1) throw new Error("timer unavailable");
      return realSetTimeout(handler, timeout);
    }) as typeof globalThis.setTimeout;

    try {
      await expect(fetchWithTimeout("https://pacing-g.example.com/two", {}, 5000)).rejects.toThrow(
        "timer unavailable",
      );
      expect(timerCalls).toBe(1);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    const response = await fetchWithTimeout("https://pacing-g.example.com/three", {}, 5000);
    expect(response.status).toBe(200);
  }, 10000);

  it("skips pacing for malformed and non-http URLs", async () => {
    __configureHostPacing({ minIntervalMs: 5000, jitterMs: 0 });
    globalThis.fetch = mock(() => Promise.resolve(new Response("ok", { status: 200 })));

    const start = Date.now();
    await fetchWithTimeout("not a url", {}, 5000);
    await fetchWithTimeout("ftp://example.com/file", {}, 5000);
    await fetchWithTimeout("not a url", {}, 5000);

    expect(Date.now() - start).toBeLessThan(100);
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

  it("defaults the User-Agent only when the caller did not set one", async () => {
    let captured: Record<string, string> | undefined;
    globalThis.fetch = mock((_url: string, opts: RequestInit = {}) => {
      captured = opts.headers as Record<string, string>;
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    await fetchWithTimeout("https://ua-default.example.com/", {}, 5000);
    expect(captured?.["User-Agent"]).toBe(DEFAULT_USER_AGENT);

    await fetchWithTimeout("https://ua-custom.example.com/", { headers: { "User-Agent": "custom/1.0" } }, 5000);
    expect(captured?.["User-Agent"]).toBe("custom/1.0");
  });
});

// -----------------------------------------------------------------------
// fetchWithCloudflareRetry
// -----------------------------------------------------------------------

describe("fetchWithCloudflareRetry", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("makes one browser-profiled request and does not retry a challenge", async () => {
    let attempts = 0;
    let captured: Record<string, string> | undefined;

    globalThis.fetch = mock((_url: string, opts: RequestInit = {}) => {
      attempts++;
      captured = opts.headers as Record<string, string>;
      return Promise.resolve(
        new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } }),
      );
    });

    const response = await fetchWithCloudflareRetry("https://cf.example.com/page", {}, 5000);

    expect(response.status).toBe(403);
    expect(attempts).toBe(1);
    expect(captured?.["User-Agent"]).toBe(BROWSER_USER_AGENT);
    expect(captured?.["Sec-Fetch-Mode"]).toBe("navigate");
  });

  it("lets caller headers win over the browser profile", async () => {
    let captured: Record<string, string> | undefined;

    globalThis.fetch = mock((_url: string, opts: RequestInit = {}) => {
      captured = opts.headers as Record<string, string>;
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    await fetchWithCloudflareRetry(
      "https://cf-headers.example.com/",
      { headers: { "User-Agent": "custom-agent", Accept: "application/json" } },
      5000,
    );

    expect(captured?.["User-Agent"]).toBe("custom-agent");
    expect(captured?.["Accept"]).toBe("application/json");
    expect(captured?.["Accept-Language"]).toBe("en-US,en;q=0.9");
  });

  it("retries exactly once after a short Retry-After on 429", async () => {
    let attempts = 0;

    globalThis.fetch = mock(() => {
      attempts++;
      if (attempts === 1) {
        return Promise.resolve(new Response("slow down", { status: 429, headers: { "Retry-After": "0" } }));
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const response = await fetchWithCloudflareRetry("https://cf-retry.example.com/", {}, 5000);

    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
  });

  it("does not retry when Retry-After exceeds the 5s cap", async () => {
    let attempts = 0;

    globalThis.fetch = mock(() => {
      attempts++;
      return Promise.resolve(new Response("slow down", { status: 429, headers: { "Retry-After": "30" } }));
    });

    const response = await fetchWithCloudflareRetry("https://cf-capped.example.com/", {}, 5000);

    expect(response.status).toBe(429);
    expect(attempts).toBe(1);
  });

  it("returns a network error response instead of throwing", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("socket closed")));

    const response = await fetchWithCloudflareRetry("https://cf-down.example.com/", {}, 5000);

    expect(response.status).toBe(0);
    expect(response.ok).toBe(false);
  });
});
