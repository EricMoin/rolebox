import { createSubLogger } from "../logger.ts";

const log = createSubLogger("web:http");

// ── Identity & browser header profile ────────────────────────────────────────

/**
 * Neutral project identification sent when no override is configured and no
 * browser profile is requested: the published npm package page is the public
 * contact point, so no personal address ever ships as a default.
 */
const NEUTRAL_USER_AGENT = "rolebox-web/1.0 (+https://www.npmjs.com/package/rolebox)";

/** Longest accepted {@link resolveDefaultUserAgent} override, after trimming. */
const MAX_USER_AGENT_LENGTH = 256;

/** Printable ASCII only (U+0020..U+007E): excludes CR, LF, TAB and non-ASCII. */
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7e]+$/;

/**
 * Resolve the self-identifying User-Agent from an operator-provided value.
 *
 * The value is external input that ends up in an HTTP header, so it is
 * sanitised: after trimming it must be printable ASCII (U+0020..U+007E, which
 * rejects CR, LF, TAB and every other control or non-ASCII character) and at
 * most 256 characters. Anything else falls back to the neutral project agent,
 * and the reason is logged without echoing the value — it may be a personal
 * address.
 *
 * @param raw - Raw `ROLEBOX_WEB_USER_AGENT` value (or undefined when unset).
 * @returns The trimmed valid value, or the neutral default.
 */
export function resolveDefaultUserAgent(raw?: string): string {
  if (raw === undefined) return NEUTRAL_USER_AGENT;

  const trimmed = raw.trim();
  if (trimmed === "") return NEUTRAL_USER_AGENT;

  if (trimmed.length > MAX_USER_AGENT_LENGTH) {
    log.warn("Ignoring invalid ROLEBOX_WEB_USER_AGENT (longer than 256 characters)");
    return NEUTRAL_USER_AGENT;
  }

  if (!PRINTABLE_ASCII_PATTERN.test(trimmed)) {
    log.warn("Ignoring invalid ROLEBOX_WEB_USER_AGENT (control or non-ASCII characters)");
    return NEUTRAL_USER_AGENT;
  }

  return trimmed;
}

/**
 * Self-identifying agent used when no browser profile is requested.
 *
 * Override `ROLEBOX_WEB_USER_AGENT` to identify your own installation, for
 * example `"rolebox-web/1.0 (+you@example.com)"`. It is never populated from
 * local machine identity (git settings, host name, account name or home
 * directory) automatically. {@link resolveDefaultUserAgent} documents the
 * sanitising rules applied to the configured value.
 */
export const DEFAULT_USER_AGENT = resolveDefaultUserAgent(process.env.ROLEBOX_WEB_USER_AGENT);

/** Chrome major version advertised by {@link BROWSER_USER_AGENT} and its client hints. */
export const BROWSER_CHROME_MAJOR = "140";

/**
 * Chrome-on-macOS User-Agent. Derived from {@link BROWSER_CHROME_MAJOR} so it
 * stays internally consistent with the sec-ch-ua client hints.
 */
export const BROWSER_USER_AGENT =
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${BROWSER_CHROME_MAJOR}.0.0.0 Safari/537.36`;

/** Default document Accept header for the browser profile. */
const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

/** Default Accept-Language for the browser profile. */
const BROWSER_ACCEPT_LANGUAGE = "en-US,en;q=0.9";

/** Platform advertised through the (quoted) sec-ch-ua-platform client hint. */
const BROWSER_PLATFORM = "macOS";

/** Options accepted by {@link buildBrowserHeaders}. */
export interface BrowserHeaderOptions {
  /** Accept header; defaults to a browser document Accept. */
  accept?: string;
  /** Referer to send; also switches Sec-Fetch-Site from "none" to "same-origin". */
  referer?: string;
  /** Accept-Language value; defaults to "en-US,en;q=0.9". */
  language?: string;
}

/**
 * Build a fresh browser-like header set (Chrome on macOS).
 *
 * The profile is internally consistent — User-Agent, sec-ch-ua and
 * sec-ch-ua-platform all describe the same browser — and deliberately omits
 * Accept-Encoding: the runtime already negotiates and transparently decodes
 * gzip/br/zstd, so a hand-written value only adds a fingerprint.
 *
 * @param opts - Optional Accept / Referer / Accept-Language overrides.
 * @returns A new header record on every call; callers may mutate it freely.
 */
export function buildBrowserHeaders(opts: BrowserHeaderOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": BROWSER_USER_AGENT,
    Accept: opts.accept ?? BROWSER_ACCEPT,
    "Accept-Language": opts.language ?? BROWSER_ACCEPT_LANGUAGE,
    "sec-ch-ua":
      `"Chromium";v="${BROWSER_CHROME_MAJOR}", "Not)A;Brand";v="8", "Google Chrome";v="${BROWSER_CHROME_MAJOR}"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": `"${BROWSER_PLATFORM}"`,
    "Sec-Fetch-Site": opts.referer ? "same-origin" : "none",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-User": "?1",
    "Sec-Fetch-Dest": "document",
    "Upgrade-Insecure-Requests": "1",
  };
  if (opts.referer) {
    headers["Referer"] = opts.referer;
  }
  return headers;
}

// ── Header merging ───────────────────────────────────────────────────────────

/** Convert any HeadersInit form to a plain record, preserving the caller's casing. */
function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  if (headers === undefined) return record;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key) record[key] = value;
    }
    return record;
  }
  for (const [key, value] of Object.entries(headers)) {
    record[key] = value;
  }
  return record;
}

/**
 * Merge header records with "extra wins" semantics, case-insensitively: a key
 * in `extra` replaces a differently-cased key from `base` instead of sending
 * both.
 */
function mergeHeaderRecords(base: Record<string, string>, extra: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const lowered = key.toLowerCase();
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === lowered) delete merged[existing];
    }
    merged[key] = value;
  }
  return merged;
}

/** Add the default User-Agent only when the caller did not supply one. */
function withDefaultUserAgent(headers: HeadersInit | undefined): Record<string, string> {
  const record = headersToRecord(headers);
  const hasUserAgent = Object.keys(record).some((key) => key.toLowerCase() === "user-agent");
  if (hasUserAgent) return record;
  return { "User-Agent": DEFAULT_USER_AGENT, ...record };
}

// ── Per-host politeness gate ─────────────────────────────────────────────────

/** Default minimum gap between request starts to the same origin. */
const DEFAULT_HOST_MIN_INTERVAL_MS = 1000;

/** Default random jitter added on top of the minimum gap. */
const DEFAULT_HOST_JITTER_MS = 250;

/** Origin bookkeeping is bounded so a long-lived process cannot grow forever. */
const MAX_PACED_ORIGINS = 256;

interface HostPacingConfig {
  minIntervalMs: number;
  jitterMs: number;
}

let pacingOverride: HostPacingConfig | null = null;
const hostChains = new Map<string, Promise<void>>();
const hostLastStart = new Map<string, number>();

/** Resolve the environment default for the minimum same-origin gap. */
function envHostMinIntervalMs(): number {
  const raw = process.env.ROLEBOX_WEB_HOST_MIN_INTERVAL_MS;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_HOST_MIN_INTERVAL_MS;
}

/** Current pacing configuration: an explicit override or the environment defaults. */
function currentPacing(): HostPacingConfig {
  if (pacingOverride !== null) return pacingOverride;
  return { minIntervalMs: envHostMinIntervalMs(), jitterMs: DEFAULT_HOST_JITTER_MS };
}

/**
 * Override the per-origin pacing gate for the current process.
 *
 * Intended for tests and operational tuning. Omitted fields keep their
 * environment/default value.
 *
 * @param opts - `minIntervalMs` (>= 0) and/or `jitterMs` (>= 0).
 */
export function __configureHostPacing(opts: { minIntervalMs?: number; jitterMs?: number }): void {
  const minIntervalMs =
    opts.minIntervalMs !== undefined && Number.isFinite(opts.minIntervalMs) && opts.minIntervalMs >= 0
      ? opts.minIntervalMs
      : envHostMinIntervalMs();
  const jitterMs =
    opts.jitterMs !== undefined && Number.isFinite(opts.jitterMs) && opts.jitterMs >= 0
      ? opts.jitterMs
      : DEFAULT_HOST_JITTER_MS;
  pacingOverride = { minIntervalMs, jitterMs };
}

/** Clear all pacing state and restore the environment defaults. */
export function __resetHostPacing(): void {
  pacingOverride = null;
  hostChains.clear();
  hostLastStart.clear();
}

/** Origin key for pacing; null for non-http(s) and malformed URLs. */
function pacedOrigin(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.origin;
}

/** Evict the oldest origins once the bounded map overflows. */
function trimPacedOrigins(): void {
  while (hostChains.size > MAX_PACED_ORIGINS) {
    const oldest = hostChains.keys().next().value;
    if (oldest === undefined) return;
    hostChains.delete(oldest);
    hostLastStart.delete(oldest);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until this origin's next request start is allowed.
 *
 * Same-origin callers are serialized through a per-origin promise chain, so
 * concurrent callers cannot stamp the same start time and race; different
 * origins use independent chains and never block each other. The gate advances
 * this origin's chain even when the wait fails, so one rejected request cannot
 * poison later callers.
 */
async function acquireHostSlot(url: string): Promise<void> {
  const origin = pacedOrigin(url);
  if (origin === null) return;

  const prior = hostChains.get(origin) ?? Promise.resolve();
  let release: () => void = () => {};
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  hostChains.set(
    origin,
    prior.then(() => slot, () => slot),
  );
  trimPacedOrigins();

  await prior.catch(() => undefined);

  // The slot must be released even when the wait fails (an unavailable timer,
  // for instance): a rejected gate that leaves the chain pending would block
  // every later caller to this origin forever.
  try {
    const { minIntervalMs, jitterMs } = currentPacing();
    const last = hostLastStart.get(origin);
    let waitMs = last === undefined ? 0 : Math.max(0, minIntervalMs - (Date.now() - last));
    if (jitterMs > 0) waitMs += Math.random() * jitterMs;
    if (waitMs > 0) await sleep(waitMs);
    hostLastStart.set(origin, Date.now());
  } finally {
    release();
  }
}

// ── Token bucket ─────────────────────────────────────────────────────────────

/**
 * Simple token bucket rate limiter.
 *
 * Capacity equals `ratePerMinute`, so a fresh bucket allows an immediate
 * burst of `ratePerMinute` acquires and then refills continuously with
 * elapsed wall time. `acquire()` is serialized through an internal promise
 * chain so concurrent callers cannot observe the same token budget (which
 * could drive the bucket negative and exceed the advertised rate).
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRatePerMs: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(ratePerMinute: number) {
    this.maxTokens = ratePerMinute;
    this.tokens = ratePerMinute;
    this.lastRefill = Date.now();
    this.refillRatePerMs = ratePerMinute > 0 ? ratePerMinute / 60000 : 0;
  }

  acquire(): Promise<void> {
    const run = this.queue.then(() => this.acquireInner());
    // Keep the chain usable even if an acquire rejects.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async acquireInner(): Promise<void> {
    // A non-positive rate has no refill schedule; never block forever on it.
    if (this.refillRatePerMs <= 0) return;
    this.refill();
    while (this.tokens < 1) {
      const waitMs = Math.ceil((1 - this.tokens) / this.refillRatePerMs);
      log.debug(`Rate limited, waiting ${waitMs}ms`);
      await sleep(waitMs);
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

// ── Retry policy ─────────────────────────────────────────────────────────────

/** Cap for one exponential-backoff sleep. */
const MAX_BACKOFF_MS = 8000;

/** Cap for one server-provided Retry-After sleep. */
const MAX_RETRY_AFTER_MS = 10000;

/**
 * Parse a Retry-After value into an unclamped delay in milliseconds.
 *
 * Accepts delta-seconds and HTTP-date forms. Anything unusable — a NaN date, a
 * negative number, or an HTTP-date already in the past — is ignored so the
 * caller can fall back to its own backoff instead of retrying immediately.
 */
function parseRetryAfterValue(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    if (delta >= 0) return delta;
  }
  return null;
}

/**
 * Delay to wait before honouring a Retry-After header.
 *
 * @param value - Raw Retry-After header value (or null when absent).
 * @param fallbackMs - Delay to use when the header is absent or unusable.
 * @param maxMs - Upper bound; the result is clamped to [0, maxMs].
 * @returns A finite, non-negative delay in milliseconds.
 */
export function parseRetryAfter(value: string | null, fallbackMs: number, maxMs: number): number {
  const parsed = value === null ? null : parseRetryAfterValue(value);
  const chosen = parsed === null ? fallbackMs : parsed;
  const capped = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : 0;
  if (!Number.isFinite(chosen) || chosen <= 0) return 0;
  return Math.min(chosen, capped);
}

/**
 * Whether a non-ok HTTP status is worth retrying.
 *
 * 408/425/429 and any 5xx are transient; every other client error (403, 404,
 * ...) will not become a success by repeating the request.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/** Exponential backoff with downward jitter: [0.5x, 1x) of the capped delay. */
function backoffDelayMs(attempt: number, baseDelayMs: number): number {
  const base = Math.min(baseDelayMs * Math.pow(2, attempt), MAX_BACKOFF_MS);
  return base * (0.5 + Math.random() * 0.5);
}

// ── Fetch helpers ────────────────────────────────────────────────────────────

/**
 * Fetch a URL with an abort timeout, a per-origin politeness gate and a
 * default User-Agent.
 *
 * The gate spaces request *starts* to the same origin (see
 * {@link __configureHostPacing}) and always releases its slot; non-http(s) and
 * malformed URLs bypass it. A caller-supplied User-Agent always wins.
 *
 * @param url - Absolute request URL.
 * @param options - Standard RequestInit; `signal` is replaced by the timeout signal.
 * @param timeoutMs - Abort timeout in milliseconds.
 * @returns The fetch Response.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 15000,
): Promise<Response> {
  await acquireHostSlot(url);
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
    headers: withDefaultUserAgent(options.headers),
  });
}

/**
 * Fetch a URL with bounded retries and a predictable delay policy.
 *
 * - 408/425/429 and 5xx are retried; every other 4xx throws immediately.
 * - 429/503 honour Retry-After (capped at 10s) and fall back to backoff.
 * - Other transient statuses and network errors use exponential backoff with
 *   downward jitter (capped at 8s).
 *
 * @param url - Absolute request URL.
 * @param options - Standard RequestInit.
 * @param maxRetries - Retries after the first attempt (default 3).
 * @param baseDelayMs - Base for the exponential backoff (default 1000).
 * @param timeoutMs - Per-attempt abort timeout (default 15000).
 * @returns The first ok Response.
 * @throws Error with the last failure ("HTTP <status> <statusText> for <url>"
 *   or the network error / "Failed to fetch <url> after <n> retries").
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  maxRetries = 3,
  baseDelayMs = 1000,
  timeoutMs = 15000,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetchWithTimeout(url, options, timeoutMs);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === maxRetries) break;
      const delay = backoffDelayMs(attempt, baseDelayMs);
      log.debug(`Fetch failed for ${url}: ${lastError.message}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1})`);
      await sleep(delay);
      continue;
    }

    if (response.ok) return response;

    const status = response.status;
    const statusError = new Error(`HTTP ${status} ${response.statusText} for ${url}`);

    if (!isRetryableStatus(status)) {
      // Client errors other than 408/425/429 are not retried: repeating a
      // 403/404 cannot succeed and only amplifies a block.
      throw statusError;
    }

    lastError = statusError;
    if (attempt === maxRetries) break;

    const exponentialFallback = backoffDelayMs(attempt, baseDelayMs);
    const waitMs =
      status === 429 || status === 503
        ? parseRetryAfter(response.headers.get("Retry-After"), exponentialFallback, MAX_RETRY_AFTER_MS)
        : exponentialFallback;
    log.debug(`HTTP ${status} for ${url}, retrying in ${Math.round(waitMs)}ms (attempt ${attempt + 1})`);
    await sleep(waitMs);
  }

  throw lastError ?? new Error(`Failed to fetch ${url} after ${maxRetries} retries`);
}

/** Longest Retry-After a Cloudflare-style retry will honour automatically. */
const CLOUDFLARE_RETRY_AFTER_MAX_MS = 5000;

/**
 * Fetch a URL once with the browser header profile, plus one bounded retry.
 *
 * Caller headers win over the profile. There is no User-Agent-downgrade retry:
 * a fake non-browser UA does not clear a JS challenge, and the extra immediate
 * request is exactly the pattern that triggers blocks — the caller should
 * escalate to another provider instead. The one exception is a 429/503 whose
 * Retry-After is present and resolves to <= 5s: that response is retried
 * exactly once.
 *
 * Never throws: a network-level failure is returned as the canonical network
 * error Response (status 0), so callers can always inspect `status`/`ok`.
 *
 * @param url - Absolute request URL.
 * @param options - Standard RequestInit; `headers` are merged over the profile.
 * @param timeoutMs - Per-attempt abort timeout (default 30000).
 * @returns The last Response obtained (or a network error Response).
 */
export async function fetchWithCloudflareRetry(
  url: string,
  options: RequestInit = {},
  timeoutMs = 30000,
): Promise<Response> {
  const headers = mergeHeaderRecords(buildBrowserHeaders(), headersToRecord(options.headers));
  const requestOptions: RequestInit = { ...options, headers };

  let response: Response;
  try {
    response = await fetchWithTimeout(url, requestOptions, timeoutMs);
  } catch (error) {
    log.debug(`Fetch failed for ${url}: ${error instanceof Error ? error.message : String(error)}`);
    return Response.error();
  }

  if (response.status !== 429 && response.status !== 503) return response;

  const retryAfter = response.headers.get("Retry-After");
  const waitMs = retryAfter === null ? null : parseRetryAfterValue(retryAfter);
  if (waitMs === null || waitMs > CLOUDFLARE_RETRY_AFTER_MAX_MS) return response;

  log.debug(`HTTP ${response.status} for ${url}, retrying once in ${Math.round(waitMs)}ms`);
  await sleep(waitMs);
  try {
    return await fetchWithTimeout(url, requestOptions, timeoutMs);
  } catch (error) {
    log.debug(`Retry failed for ${url}: ${error instanceof Error ? error.message : String(error)}`);
    return response;
  }
}
