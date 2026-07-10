import { createSubLogger } from "../logger.ts";

const log = createSubLogger("web:http");

const DEFAULT_USER_AGENT = "rolebox-web-tool/1.0 (Bun; +https://github.com/EricMoin/rolebox)";
const BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRatePerMs: number;

  constructor(ratePerMinute: number) {
    this.maxTokens = ratePerMinute;
    this.tokens = ratePerMinute;
    this.lastRefill = Date.now();
    this.refillRatePerMs = ratePerMinute / 60000;
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      const waitMs = Math.ceil((1 - this.tokens) / this.refillRatePerMs);
      log.debug(`Rate limited, waiting ${waitMs}ms`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      this.refill();
    }
    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRatePerMs);
    this.lastRefill = now;
  }
}

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 15000,
): Promise<Response> {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "User-Agent": DEFAULT_USER_AGENT,
      ...options.headers,
    },
  });
  return response;
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  maxRetries = 3,
  baseDelayMs = 1000,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, options);

      if (response.ok) return response;

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const waitMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : baseDelayMs * Math.pow(2, attempt);
        log.debug(`429 rate limited on ${url}, waiting ${waitMs}ms (attempt ${attempt + 1})`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }

      // Client errors (4xx) other than 429 — don't retry
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
      }

      // Server errors (5xx) — retry
      lastError = new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === maxRetries) break;
      const delay = baseDelayMs * Math.pow(2, attempt);
      log.debug(`Fetch failed for ${url}: ${lastError.message}, retrying in ${delay}ms (attempt ${attempt + 1})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError ?? new Error(`Failed to fetch ${url} after ${maxRetries} retries`);
}

/**
 * Fetch a URL with Cloudflare bot-detection retry.
 * 
 * First attempt uses browser-like headers. If the response is HTTP 403
 * with Cloudflare challenge indicators (cf-mitigated header or challenge page),
 * retries once with a simplified User-Agent.
 */
export async function fetchWithCloudflareRetry(
  url: string,
  options: RequestInit = {},
  timeoutMs = 30000,
): Promise<Response> {
  // First attempt with browser UA
  const response = await fetchWithTimeout(url, {
    ...options,
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      ...options.headers,
    },
  }, timeoutMs);

  // Check for Cloudflare challenge
  if (response.status === 403) {
    const cfMitigated = response.headers.get("cf-mitigated");
    if (cfMitigated === "challenge" || cfMitigated?.includes("challenge")) {
      log.debug(`Cloudflare challenge detected for ${url}, retrying with simple UA`);
      // Retry with a simple, honest User-Agent (Cloudflare sometimes allows non-browser UAs)
      return fetchWithTimeout(url, {
        ...options,
        headers: {
          "User-Agent": "rolebox-web-fetch/1.0",
          ...(options.headers || {}),
        },
      }, timeoutMs);
    }
  }

  return response;
}

export { DEFAULT_USER_AGENT, BROWSER_USER_AGENT };
