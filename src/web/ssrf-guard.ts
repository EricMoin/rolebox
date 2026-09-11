import { createSubLogger } from "../logger.ts";

const log = createSubLogger("web:ssrf");

/** Pattern for IPv6 addresses (full or compressed). */
const IPV6_RE = /^[0-9a-f:]+$/i;

/** Pattern for common internal hostnames. */
const INTERNAL_HOSTNAME_RE = /^(.*\.)?(local|internal)$/i;

const LOCALHOST_RE = /^localhost$/i;

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Parse the host portion of a URL, stripping port and userinfo.
 * Handles IPv6 bracket notation and embedded credentials.
 */
function extractHost(url: string): string | null {
  try {
    // Handle protocol-relative URLs and ensure we have a protocol
    const normalized = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) ? url : `http://${url}`;
    const parsed = new URL(normalized);
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

/**
 * Check if a string is a bare IPv4 address (dotted decimal).
 */
function isIpv4Address(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    const n = parseInt(part, 10);
    return !isNaN(n) && n >= 0 && n <= 255 && String(n) === part;
  });
}

/**
 * Normalize an IPv6 address by expanding `::` into full zero-filled form.
 * Returns the normalized string or null on parse failure.
 */
function normalizeIpv6(host: string): string | null {
  // Strip brackets if present
  const raw = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  // Simple normalization: expand `::` into zero groups
  if (!raw.includes("::")) {
    // No compression — must be exactly 8 groups
    const groups = raw.split(":");
    if (groups.length !== 8) return null;
    if (groups.some((g) => g.length > 4)) return null;
    return groups.map((g) => g.padStart(4, "0")).join(":");
  }

  // `::` means one or more zeroed groups
  const parts = raw.split("::");
  if (parts.length !== 2) return null; // Multiple `::` is invalid

  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts[1] ? parts[1].split(":") : [];
  const missing = 8 - left.length - right.length;

  if (missing < 1) return null;

  const zeros = Array(missing).fill("0000");
  const all = [...left, ...zeros, ...right];

  if (all.length !== 8) return null;
  return all.map((g) => g.padStart(4, "0")).join(":");
}

/**
 * Check if a normalized 8-group IPv6 address is private (loopback or
 * IPv4-mapped private address in the ::ffff:0:0/96 range).
 */
function checkNormalizedIpv6(normalized: string): boolean {
  const groups = normalized.split(":");

  if (groups.length !== 8) return false;

  // ::1 — loopback
  if (groups.every((g, i) => (i === 7 ? g === "0001" : g === "0000"))) {
    return true;
  }

  // IPv4-mapped IPv6 (::ffff:0:0/96): group 5 (index 5) must be "ffff"
  if (groups[5] === "ffff") {
    // Extract embedded IPv4 from the last two 16-bit groups
    const g6 = parseInt(groups[6], 16);
    const g7 = parseInt(groups[7], 16);
    const ipv4 = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
    if (isPrivateIpv4(ipv4)) return true;
  }

  return false;
}

/**
 * Check if a host string resolves to a private, loopback, or otherwise
 * internal IP address.
 *
 * Detects:
 * - IPv4 loopback (127.x.x.x), RFC 1918 private ranges, and 0.0.0.0
 * - IPv6 loopback (::1)
 * - IPv4-mapped IPv6 private addresses (::ffff:0:0/96 with embedded private IPv4)
 * - Malformed addresses are treated as non-private (let URL.parse validate syntax)
 */
function isPrivateIp(host: string): boolean {
  // Strip brackets if present
  const raw = host.replace(/^\[|\]$/g, "");

  // ::1 — quick check
  if (raw === "::1") return true;

  // Plain IPv4 check
  if (isIpv4Address(raw)) {
    return isPrivateIpv4(raw);
  }

  // IPv6 — normalize then check
  if (raw.includes(":") || IPV6_RE.test(raw)) {
    const normalized = normalizeIpv6(raw);
    if (!normalized) return false; // Malformed, not private
    return checkNormalizedIpv6(normalized);
  }

  return false;
}

/**
 * Check if a bare IPv4 address (dotted decimal) is in a private range.
 */
function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10));

  // 0.0.0.0 — local binding
  if (parts[0] === 0 && parts[1] === 0 && parts[2] === 0 && parts[3] === 0) {
    return true;
  }

  // 127.x.x.x — loopback
  if (parts[0] === 127) return true;

  // 10.x.x.x — RFC 1918 Class A
  if (parts[0] === 10) return true;

  // 172.16.x.x - 172.31.x.x — RFC 1918 Class B
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;

  // 192.168.x.x — RFC 1918 Class C
  if (parts[0] === 192 && parts[1] === 168) return true;

  // 169.254.x.x — link-local (RFC 3927)
  if (parts[0] === 169 && parts[1] === 254) return true;

  return false;
}

/**
 * Check if a hostname is a common internal-only name (localhost, *.local, *.internal).
 */
function isInternalHostname(host: string): boolean {
  if (LOCALHOST_RE.test(host)) return true;
  if (INTERNAL_HOSTNAME_RE.test(host)) return true;
  return false;
}

/**
 * Validate a URL to protect against Server-Side Request Forgery (SSRF) attacks.
 *
 * Rejects:
 * - Non-http/https protocols (file://, ftp://, data:, javascript:, etc.)
 * - Private IP addresses (RFC 1918, loopback, link-local)
 * - Internal hostnames (localhost, *.local, *.internal)
 *
 * @param url - The URL to validate.
 * @returns `{ valid: true }` if the URL is safe, or `{ valid: false, reason }` if rejected.
 */
export function validateUrl(url: string): ValidationResult {
  // 1. Basic sanity — must be a non-empty string
  if (!url || typeof url !== "string") {
    return { valid: false, reason: "URL must be a non-empty string" };
  }

  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: "URL must be a non-empty string" };
  }

  // 2. Protocol check (before URL parsing to catch data:/javascript: URLs)
  const protocolMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!protocolMatch) {
    return { valid: false, reason: "URL is missing a protocol scheme" };
  }

  const protocol = protocolMatch[1].toLowerCase();

  // Reject non-http(s) protocols
  if (protocol !== "http" && protocol !== "https") {
    log.debug(`Rejected non-http protocol: ${protocol}://`);
    return { valid: false, reason: `Protocol '${protocol}:' is not allowed. Only http: and https: are permitted` };
  }

  // 3. Parse the URL
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, reason: "URL is malformed and cannot be parsed" };
  }

  const host = parsed.hostname;

  // 4. Reject empty hostnames
  if (!host || host.length === 0) {
    return { valid: false, reason: "URL has no hostname" };
  }

  // 5. Check internal hostnames
  if (isInternalHostname(host)) {
    log.debug(`Rejected internal hostname: ${host}`);
    return { valid: false, reason: `Hostname '${host}' resolves to an internal or local-only address` };
  }

  // 6. Check IP-based private addresses
  if (isPrivateIp(host)) {
    log.debug(`Rejected private IP: ${host}`);
    return { valid: false, reason: `IP address '${host}' is a private, loopback, or link-local address` };
  }

  log.debug(`URL validated: ${trimmed}`);
  return { valid: true };
}
