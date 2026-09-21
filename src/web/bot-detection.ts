import { createSubLogger } from "../logger.ts";

const log = createSubLogger("web:bot-detect");

// ── Marker tables ────────────────────────────────────────────────────────────

/** One body marker that identifies a protection vendor's interstitial. */
export interface BlockMarker {
  /** Vendor attributed when this marker is present. */
  provider: string;
  /** Case-insensitive substring to look for in the body sample. */
  marker: string;
  /**
   * The marker is a generic token that also occurs in ordinary content, so it
   * is only trusted next to a corroborated 403/429/503 status — never for the
   * advisory 2xx scan, where a false positive discards good content.
   */
  corroboratedOnly?: boolean;
}

/**
 * Strong interstitial markers, in attribution order (first match wins).
 *
 * These are page-level fingerprints, not generic words: "captcha" or
 * "blocked" alone appear in ordinary articles and must never classify a
 * legitimate body as blocked.
 */
export const BLOCK_MARKERS: readonly BlockMarker[] = [
  { provider: "cloudflare", marker: "just a moment" },
  { provider: "cloudflare", marker: "cf_chl_opt" },
  { provider: "cloudflare", marker: "cf-chl-" },
  { provider: "cloudflare", marker: "enable javascript and cookies to continue" },
  { provider: "cloudflare", marker: "checking your browser before accessing" },
  { provider: "cloudflare", marker: "attention required" },
  { provider: "cloudflare", marker: "ddos protection by" },
  { provider: "cloudflare", marker: "verify you are human" },
  { provider: "cloudflare", marker: "please verify you are a human" },
  { provider: "cloudflare", marker: "unusual traffic from your computer network" },
  { provider: "akamai", marker: "reference #", corroboratedOnly: true },
  { provider: "datadome", marker: "datadome" },
  { provider: "perimeterx", marker: "px-captcha" },
  { provider: "perimeterx", marker: "_px", corroboratedOnly: true },
  { provider: "incapsula", marker: "incapsula" },
  { provider: "incapsula", marker: "visid_incap" },
  { provider: "sucuri", marker: "sucuri_cloudproxy" },
];

/** Server / X-Powered-By values that name a known protection provider. */
const PROVIDER_HEADER_MARKERS: readonly BlockMarker[] = [
  { provider: "cloudflare", marker: "cloudflare" },
  { provider: "akamai", marker: "akamai" },
  { provider: "datadome", marker: "datadome" },
  { provider: "perimeterx", marker: "perimeterx" },
  { provider: "incapsula", marker: "incapsula" },
  { provider: "incapsula", marker: "imperva" },
  { provider: "sucuri", marker: "sucuri" },
];

/** Statuses where a bot-protection block is plausible enough to corroborate. */
const CORROBORATED_STATUSES = new Set([403, 429, 503]);

/**
 * Bodies at or above this size are never treated as an interstitial on a 2xx:
 * a long article is exactly the case a marker scan must not misclassify.
 */
const MAX_ADVISORY_SAMPLE_CHARS = 16384;

/**
 * First matching strong marker, or null.
 *
 * @param loweredSample - Lowercased body sample to scan.
 * @param corroborated - Whether the status already corroborates a block; only
 *   then are generic, collision-prone markers eligible.
 */
function findMarker(loweredSample: string, corroborated: boolean): BlockMarker | null {
  for (const entry of BLOCK_MARKERS) {
    if (entry.corroboratedOnly === true && !corroborated) continue;
    if (loweredSample.includes(entry.marker)) return entry;
  }
  return null;
}

/** Provider named by Server / X-Powered-By, or null. */
function providerFromHeaders(headers: Headers | null): string | null {
  if (headers === null) return null;
  const haystack = `${headers.get("server") ?? ""} ${headers.get("x-powered-by") ?? ""}`.toLowerCase();
  if (haystack.trim() === "") return null;
  for (const entry of PROVIDER_HEADER_MARKERS) {
    if (haystack.includes(entry.marker)) return entry.provider;
  }
  return null;
}

/** Result of classifying a response as a bot-protection block (or not). */
export interface BlockSignal {
  /** Whether the response should be treated as a block/interstitial. */
  blocked: boolean;
  /** Protection vendor, when one could be attributed. */
  provider: string | null;
  /** One-line explanation suitable for a user-facing message. */
  reason: string;
}

/**
 * Classify an HTTP response as a bot-protection block.
 *
 * - 403/429/503 count as blocked only with corroboration: a Cloudflare
 *   `cf-mitigated: challenge` header, a Server/X-Powered-By naming a known
 *   provider, or a strong interstitial marker in the body. A bare 403 may be a
 *   genuine authorization error and is reported as not blocked.
 * - 2xx signals are advisory: only a strong marker in a body shorter than
 *   16 KB sets `blocked`, and callers may still use the fetched body.
 * - Every other status is not a bot-protection signal.
 *
 * @param input - Status, optional headers, optional leading body text and the
 *   real size of the whole body.
 * @returns The classification plus a short human-readable reason.
 */
export function detectBlockSignal(input: {
  status: number;
  headers?: Headers | null;
  bodySample?: string | null;
  /**
   * Real size of the whole body — bytes when only bytes were read, characters
   * when the decoded text is at hand. Callers that pass a truncated
   * `bodySample` (the common case: the first 8 KB) must set this, otherwise the
   * advisory 2xx size guard can only see the sample and a long legitimate page
   * reads as an interstitial.
   */
  bodyLength?: number | null;
}): BlockSignal {
  const { status } = input;
  const headers = input.headers ?? null;
  const bodySample = input.bodySample ?? "";
  const declaredBodyLength = input.bodyLength;
  const bodyLength =
    declaredBodyLength === undefined || declaredBodyLength === null || !Number.isFinite(declaredBodyLength)
      ? bodySample.length
      : declaredBodyLength;
  const lowered = bodySample.slice(0, MAX_ADVISORY_SAMPLE_CHARS).toLowerCase();

  if (CORROBORATED_STATUSES.has(status)) {
    const cfMitigated = headers?.get("cf-mitigated") ?? null;
    if (cfMitigated !== null && cfMitigated.toLowerCase().includes("challenge")) {
      return {
        blocked: true,
        provider: "cloudflare",
        reason: `HTTP ${status} with a Cloudflare challenge (cf-mitigated: ${cfMitigated})`,
      };
    }

    const headerProvider = providerFromHeaders(headers);
    if (headerProvider !== null) {
      return {
        blocked: true,
        provider: headerProvider,
        reason: `HTTP ${status} served by ${headerProvider}, a known bot-protection provider`,
      };
    }

    const marker = findMarker(lowered, true);
    if (marker !== null) {
      return {
        blocked: true,
        provider: marker.provider,
        reason: `HTTP ${status} body contains a ${marker.provider} interstitial marker`,
      };
    }

    return {
      blocked: false,
      provider: null,
      reason: `HTTP ${status} without a bot-protection marker; treating it as a genuine client error`,
    };
  }

  if (status >= 200 && status < 300) {
    if (bodyLength >= MAX_ADVISORY_SAMPLE_CHARS) {
      return {
        blocked: false,
        provider: null,
        reason: `HTTP ${status} body is too large to inspect for an interstitial`,
      };
    }

    const marker = findMarker(lowered, false);
    if (marker !== null) {
      return {
        blocked: true,
        provider: marker.provider,
        reason: `HTTP ${status} body looks like a ${marker.provider} interstitial`,
      };
    }

    return { blocked: false, provider: null, reason: `HTTP ${status} has no bot-protection marker` };
  }

  return { blocked: false, provider: null, reason: `HTTP ${status} is not a bot-protection status` };
}

/**
 * Whether a Jina Reader response carries an error instead of content.
 *
 * Defensive heuristic against a remote service whose exact wording cannot be
 * verified offline, so it stays narrow: only the documented `Warning:`,
 * `Target URL returned error` and `Failed to fetch` forms, and only within
 * the first 500 characters.
 *
 * @param text - Raw Jina Reader response text.
 */
export function isJinaErrorBody(text: string): boolean {
  const head = text.slice(0, 500);
  const matched =
    head.includes("Warning:") ||
    head.includes("Target URL returned error") ||
    head.includes("Failed to fetch");
  if (matched) log.debug("Jina error body detected");
  return matched;
}
