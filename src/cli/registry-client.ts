import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, chmodSync, rmSync, renameSync, realpathSync, lstatSync, readlinkSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { getDataDir } from "./paths.ts";
import { parseRegistryManifestFromYaml } from "./schemas.ts";
import type { RegistryEntry, RegistryManifest } from "./types.ts";
import { DEFAULT_GIT_BRANCH, REGISTRY_CACHE_TTL_MS } from "../constants.ts";
import type { DownloadProgress, Phase } from "./download-progress.ts";
import { archiveUrlCandidates, manifestUrlFor, parseRegistryUrl } from "./source-url.ts";
import type { SourceKind } from "./source-url.ts";

// Defaults for the hardened download path. Both are overridable per-call via
// {@link DownloadRoleOptions} so tests can exercise timeout / retry cheaply.
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_DOWNLOAD_MAX_RETRIES = 2;

// Hard limits for everything a source can send. A registry manifest is a small
// document and a role archive is a small tarball, so these caps refuse a
// hostile source long before it can exhaust memory or fill the disk. The
// per-call overrides exist for tests, not for production tuning.
const DEFAULT_MANIFEST_TIMEOUT_MS = 30_000;
const DEFAULT_MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
const EXTRACT_SIZE_POLL_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

/** Exponential backoff between retry attempts: attempt 1 → 300ms, 2 → 600ms. */
function backoffMs(attempt: number): number {
  return 300 * Math.pow(2, attempt - 1);
}

// ── Source Headers ────────────────────────────────────────────────

/**
 * Request headers for a source kind. GitHub keeps its `token` header exactly as
 * before, GitLab adds `PRIVATE-TOKEN` (needed for private projects), and a plain
 * HTTP file server gets no credentials at all — only the `Accept` header that
 * says what a server without an API is being asked for.
 */
function sourceRequestHeaders(kind: SourceKind): Record<string, string> {
  if (kind === "github") {
    return process.env.GITHUB_TOKEN ? { Authorization: `token ${sanitizeEnvValue(process.env.GITHUB_TOKEN)}` } : {};
  }
  if (kind === "gitlab") {
    return process.env.GITLAB_TOKEN ? { "PRIVATE-TOKEN": sanitizeEnvValue(process.env.GITLAB_TOKEN) } : {};
  }
  return { Accept: HTTP_SOURCE_ACCEPT };
}

/**
 * A credential read from the environment, safe to put in a request header.
 *
 * A value with a trailing newline or CR would otherwise throw inside `fetch`
 * with the value echoed in the error (and print on the way out), so control
 * characters are stripped here — at the boundary — rather than at each message.
 */
function sanitizeEnvValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, "").trim();
}

/**
 * Text from a remote manifest, made safe to print.
 *
 * A manifest supplies role ids, versions and descriptions, and a raw newline or
 * ESC in one of them can forge a CLI line or drive the terminal. Control
 * characters are rendered as `\xNN` escapes instead of being emitted, so the
 * output still says what arrived.
 */
export function escapeForDisplay(value: unknown): string {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (ch) => {
    const code = ch.codePointAt(0)!.toString(16).padStart(2, "0").toUpperCase();
    return `\\x${code}`;
  });
}

/**
 * A URL as it may appear in output: the userinfo section is replaced by
 * `***@`, so a password embedded in a source URL is never echoed into a
 * terminal or a CI log. The URL itself is used unchanged everywhere else.
 */
export function redactUrlForDisplay(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username === "" && parsed.password === "") return url;
    parsed.username = "***";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/** The `Accept` header an `http` source sends: it has no API, only a file server. */
const HTTP_SOURCE_ACCEPT = "application/yaml, text/yaml, text/plain, */*";

/** Redirect hops a source fetch follows before it gives up. */
const MAX_SOURCE_REDIRECTS = 10;

/** Headers that authenticate a request: they never leave the origin they were built for. */
const CREDENTIAL_HEADERS = new Set(["authorization", "private-token"]);

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** The same headers without anything that authenticates the request. */
function withoutCredentials(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADERS.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

/**
 * Fetch a source URL, following redirects by hand.
 *
 * `redirect: "follow"` deletes `Authorization` on a cross-origin hop by spec,
 * but forwards a custom header — GitLab's `PRIVATE-TOKEN` — to whatever host a
 * redirect names. Following the hops here keeps every credential bound to the
 * origin the source resolved to: the first hop to a different origin drops the
 * credential headers, and they stay dropped for the rest of the chain.
 */
async function fetchSourceUrl(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  const origin = new URL(url).origin;
  let currentUrl = url;
  let currentHeaders = headers;

  for (let hop = 0; hop <= MAX_SOURCE_REDIRECTS; hop++) {
    const response = await fetch(currentUrl, { headers: currentHeaders, redirect: "manual", signal });
    const location = isRedirectStatus(response.status) ? response.headers.get("location") : null;
    if (location === null) return response;

    let target: URL;
    try {
      target = new URL(location, currentUrl);
    } catch {
      throw new Error(
        `source URL ${redactUrlForDisplay(currentUrl)} redirected to an invalid location "${location}"`,
      );
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error(
        `source URL ${redactUrlForDisplay(currentUrl)} redirected to unsupported scheme "${target.protocol.replace(/:$/, "")}"`,
      );
    }
    if (target.origin !== origin) currentHeaders = withoutCredentials(currentHeaders);
    currentUrl = target.toString();
  }

  throw new Error(
    `too many redirects (more than ${MAX_SOURCE_REDIRECTS}) fetching ${redactUrlForDisplay(url)}`,
  );
}

/**
 * Read a response body with a hard byte cap. Content-Length is checked first
 * when the server declares one, and the streamed bytes are counted whatever it
 * declares, so a chunked or lying server cannot make the client buffer an
 * unbounded body.
 */
async function readBodyWithCap(response: Response, maxBytes: number, what: string): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length")) || 0;
  if (declared > maxBytes) {
    throw new Error(
      `${what} is larger than the ${maxBytes}-byte limit (Content-Length: ${declared}); refusing to read it`,
    );
  }

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error(
        `${what} is larger than the ${maxBytes}-byte limit (received ${buffer.byteLength} bytes); refusing to read it`,
      );
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // The cap refusal below is the error that matters.
      }
      throw new Error(
        `${what} is larger than the ${maxBytes}-byte limit (received ${received} bytes); refusing to read it`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// ── Version Resolution ────────────────────────────────────────────

/**
 * Resolve the version for a role from the registry manifest.
 */
export function resolveVersion(manifest: RegistryManifest, roleId: string): string {
  const role = manifest.roles[roleId];
  if (!role) {
    throw new Error(`role "${roleId}" not found in registry "${manifest.name}"`);
  }
  return role.version;
}

// ── Registry Manifest Fetching ────────────────────────────────────

/**
 * Filesystem-safe form of a source name. Names come from user config (or the
 * repo basename), so they are sanitized before being used as a path component.
 */
function safeCacheName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40) || "registry";
}

/**
 * Cache directory for one source+branch pair. The digest covers the URL and the
 * resolved branch, so two sources that share a name — or one repo pinned to two
 * branches — never read each other's cached manifest.
 */
function registryCacheDir(registry: RegistryEntry, branch: string): string {
  // The source URL is validated before it becomes a cache key: a non-http(s)
  // value must fail here rather than be hashed into a path.
  const scheme = new URL(registry.url).protocol;
  if (scheme !== "http:" && scheme !== "https:") {
    throw new Error(
      `invalid registry URL "${registry.url}": unsupported scheme "${scheme.replace(/:$/, "")}" (expected http or https)`,
    );
  }
  const digest = createHash("sha256").update(`${registry.url}\n${branch}`).digest("hex").slice(0, 8);
  return join(getDataDir(), "cache", `${safeCacheName(registry.name)}-${digest}`);
}

/**
 * Fetch a registry manifest for a source, with caching.
 *
 * The URL is derived from the source kind: a GitHub raw content URL, a GitLab
 * `/-/raw/<ref>/` URL, or the direct `http` manifest URL. The branch is `ref`,
 * else the entry's own `ref`, else DEFAULT_GIT_BRANCH; an explicitly passed ref
 * always wins (and is ignored by `http` sources, which have no ref).
 *
 * The request is bounded: it carries a timeout and the body is read through a
 * hard byte cap, so a stalled or oversized source cannot wedge or exhaust the
 * caller. `timeoutMs` / `maxBytes` override those limits for tests only.
 */
export async function fetchRegistryManifest(
  registry: RegistryEntry,
  ref?: string,
  options?: { noCache?: boolean; timeoutMs?: number; maxBytes?: number }
): Promise<RegistryManifest> {
  const branch = ref ?? registry.ref ?? DEFAULT_GIT_BRANCH;
  const cacheDir = registryCacheDir(registry, branch);
  const cacheFile = join(cacheDir, "registry.yaml");
  const timestampFile = join(cacheDir, ".timestamp");

  // Check cache if enabled
  if (!options?.noCache) {
    try {
      if (existsSync(timestampFile) && existsSync(cacheFile)) {
        const ts = readFileSync(timestampFile, "utf-8");
        const cachedAt = new Date(ts).getTime();
        if (!isNaN(cachedAt) && Date.now() - cachedAt < REGISTRY_CACHE_TTL_MS) {
          const cached = readFileSync(cacheFile, "utf-8");
          return parseRegistryManifestFromYaml(cached);
        }
      }
    } catch {
      // Cache read failed — skip cache, continue without
    }
  }

  // Build the URL and headers for this source's kind (github | gitlab | http).
  // Parsing here validates the URL before it is ever used to build a request.
  const parsed = parseRegistryUrl(registry.url);
  const url = manifestUrlFor(registry, branch);
  const headers = sourceRequestHeaders(parsed.kind);

  // Fetch. The signal covers the whole exchange — connect, headers and body — so
  // a server that answers with one chunk and then stalls fails with an
  // actionable timeout instead of hanging install/update/search/status.
  const timeoutMs = options?.timeoutMs ?? DEFAULT_MANIFEST_TIMEOUT_MS;
  const maxBytes = options?.maxBytes ?? DEFAULT_MANIFEST_MAX_BYTES;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const timedOut = () =>
    new Error(
      `timed out fetching registry "${registry.name}" from ${url} after ${Math.round(timeoutMs / 1000)}s`,
    );

  let response: Response;
  try {
    response = await fetchSourceUrl(url, headers, timeoutSignal);
  } catch (err) {
    if (timeoutSignal.aborted) throw timedOut();
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("network") || msg.toLowerCase().includes("connection") || msg.toLowerCase().includes("fetch")) {
      throw new Error(`network error fetching registry "${registry.name}": ${msg}`);
    }
    throw new Error(`failed to fetch registry "${registry.name}": ${msg}`);
  }

  // HTTP status handling. GitHub keeps its historical messages; GitLab and
  // plain HTTP sources name the credential that actually helps (a GitLab
  // project is private, not "rate limited", and an HTTP server has no token).
  if (response.status === 404) {
    throw new Error(`registry "${registry.name}" not found at ${redactUrlForDisplay(url)}`);
  }

  if (response.status === 403 && parsed.kind === "github") {
    throw new Error(`rate limited fetching registry "${registry.name}". Set GITHUB_TOKEN for higher rate limits.`);
  }

  if ((response.status === 401 || response.status === 403) && parsed.kind === "gitlab") {
    throw new Error(
      `failed to fetch registry "${registry.name}": HTTP ${response.status}. Set GITLAB_TOKEN if the project is private.`,
    );
  }

  if (!response.ok) {
    throw new Error(`failed to fetch registry "${registry.name}": HTTP ${response.status}`);
  }

  let yaml: string;
  try {
    yaml = (await readBodyWithCap(response, maxBytes, `registry "${registry.name}" manifest`)).toString("utf-8");
  } catch (err) {
    if (timeoutSignal.aborted) throw timedOut();
    throw err;
  }

  // Parse
  let manifest: RegistryManifest;
  try {
    manifest = parseRegistryManifestFromYaml(yaml);
  } catch (err) {
    throw new Error(`invalid registry.yaml from "${registry.name}": ${(err as Error).message}`);
  }

  // Cache
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile, yaml, "utf-8");
    writeFileSync(timestampFile, new Date().toISOString(), "utf-8");
  } catch {
    // Non-fatal: cache write failure
  }

  return manifest;
}

// ── Role Download ─────────────────────────────────────────────────

/**
 * Optional dependency injection for downloadRole's process invocation.
 *
 * Tests inject recording/spying spawn functions here; production callers
 * omit it and get the real spawn/spawnSync from node:child_process. This
 * seam exists because mocking the node:child_process builtin (or a re-export)
 * via mock.module hangs in Bun when a real child is spawned.
 */
export interface DownloadRoleProcess {
  spawn: typeof spawn;
  spawnSync: typeof spawnSync;
}

/**
 * Optional progress reporter for {@link downloadRole}.
 *
 * Added as an optional trailing parameter (via {@link DownloadRoleOptions}) so
 * the exported signature stays backward-compatible: existing callers that omit
 * it get silent, buffer-based streaming and no phase/byte reporting.
 */
export interface DownloadRoleOptions {
  /** Progress reporter; when supplied, the response body is streamed and
   *  byte counts are reported via `update`, with phase lifecycle reporting for
   *  downloading / verifying / extracting. */
  progress?: DownloadProgress;
  /** Per-attempt download timeout in ms. Defaults to {@link DEFAULT_DOWNLOAD_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Number of retries on transient network error (total attempts = retries + 1).
   *  Defaults to {@link DEFAULT_DOWNLOAD_MAX_RETRIES}. */
  maxRetries?: number;
  /** Hard cap on the archive body in bytes. Defaults to
   *  {@link DEFAULT_ARCHIVE_MAX_BYTES}. */
  maxBytes?: number;
  /** Hard cap on the bytes the archive may extract to. Defaults to
   *  {@link DEFAULT_MAX_EXTRACTED_BYTES}. */
  maxExtractedBytes?: number;
  /** Manifest-declared archive location for this role (`roles.<id>.archive`).
   *  Absolute http(s) URLs are used as-is only when they stay on the manifest's
   *  own origin; a relative path resolves against the manifest URL. Honored by
   *  `http` sources; git sources keep their hosting API paths. */
  archivePath?: string;
}

/**
 * Total size of the entries under `dir`, without following symlinks, stopping
 * as soon as the running total passes `limit`. Used to bound decompression.
 */
function treeSizeBytes(dir: string, limit: number): number {
  let total = 0;
  const walk = (current: string): void => {
    if (total > limit) return;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (total > limit) return;
      const full = join(current, entry);
      try {
        const stat = lstatSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else {
          total += stat.size;
        }
      } catch {
        // The entry vanished mid-walk; the next poll sees the settled tree.
      }
    }
  };
  walk(dir);
  return total;
}

/**
 * Make a tree removable by its owner: a hostile archive can leave a directory
 * at mode 0500 (or worse), which makes a plain recursive `rmSync` fail with
 * EACCES while it is walking the tree.
 */
function makeTreeRemovable(dir: string): void {
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best-effort: removal below reports what is left.
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      if (lstatSync(full).isDirectory()) makeTreeRemovable(full);
    } catch {
      // A vanished or unsupported entry cannot block the removal retry.
    }
  }
}

/**
 * Remove a temporary directory on any exit path. A hostile archive must not be
 * able to abandon the extracted tree in TMPDIR: the removal is retried once
 * after repairing the tree's modes, and cleanup itself never throws — an error
 * here would mask the real failure and skip the remaining cleanup.
 */
function removeDirBestEffort(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    // Retry after repairing modes.
  }
  makeTreeRemovable(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: never replace the caller's error with a cleanup error.
  }
}

/**
 * Download a role archive from a source and extract it.
 *
 * The archive URL comes from the source kind: the GitHub tarball API, the
 * GitLab `/-/archive/<ref>/<repo>-<ref>.tar.gz` path, or the `http` layout
 * (`<base>/roles/<roleId>@<version>.tar.gz`, with the versionless
 * `<base>/roles/<roleId>.tar.gz` tried only when the versioned URL answers 404,
 * or the manifest's own `archive` when it declares one). The branch is `ref`,
 * else the entry's own `ref`, else DEFAULT_GIT_BRANCH; an explicitly passed ref
 * always wins.
 */
export async function downloadRole(
  registry: RegistryEntry,
  roleId: string,
  _version: string,
  ref?: string,
  deps?: DownloadRoleProcess,
  options?: DownloadRoleOptions
): Promise<string> {
  const runSpawn = deps?.spawn ?? spawn;
  const runSpawnSync = deps?.spawnSync ?? spawnSync;
  const progress = options?.progress;
  const asset = `${roleId}@${_version}`;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const maxRetries = options?.maxRetries ?? DEFAULT_DOWNLOAD_MAX_RETRIES;
  const maxBytes = options?.maxBytes ?? DEFAULT_ARCHIVE_MAX_BYTES;
  const maxExtractedBytes = options?.maxExtractedBytes ?? DEFAULT_MAX_EXTRACTED_BYTES;
  const maxAttempts = maxRetries + 1;
  const fail = (phase: Phase, reason: string, attempt = 1, attempts = 1) => {
    progress?.phaseFail(phase, { asset, reason, attempt, maxAttempts: attempts });
  };

  const parsed = parseRegistryUrl(registry.url);
  const branch = ref ?? registry.ref ?? DEFAULT_GIT_BRANCH;
  const candidates = archiveUrlCandidates(
    registry,
    roleId,
    _version,
    options?.archivePath,
    branch,
  );
  const headers = sourceRequestHeaders(parsed.kind);

  // Create temporary directories.
  //
  // BOTH tmpDir and outputDir are cleaned up on every exit path. The existing
  // finally covered only tmpDir; outputDir (the `rolebox-out-*` dir) leaked on
  // any failure before the final rename. We track `committed` so the success
  // path's returned outputDir is NOT removed, while every failure path removes
  // both.
  const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-"));
  const archiveFile = join(tmpDir, "archive.tar.gz");
  const extractDir = join(tmpDir, "extracted");
  const outputDir = mkdtempSync(join(tmpdir(), "rolebox-out-"));
  let committed = false;

  try {
    // ── Download tarball with timeout + bounded retry ────────────────
    // Each attempt gets its own AbortController; the timeout is kept alive
    // through body streaming so a stalled body also aborts. Network errors
    // (fetch rejection) and timeouts are retried up to `maxRetries` times with
    // exponential backoff, reported via the progress module as attempt N/M.
    // Non-retryable HTTP statuses (404, other non-2xx) fail immediately.
    progress?.phaseStart("downloading", asset);
    let response: Response | undefined;
    let downloadError: Error | undefined;
    let downloadController: AbortController | undefined;
    let downloadTimer: ReturnType<typeof setTimeout> | undefined;
    let url = candidates[0];

    // Candidate URLs are walked in order. git sources have exactly one; an
    // `http` source has a versionless fallback, and ONLY a 404 on the previous
    // candidate moves the walk on — any other status, timeout or network error
    // fails exactly as it does for a single-URL source.
    candidatesLoop:
    for (let candidate = 0; candidate < candidates.length; candidate++) {
      url = candidates[candidate];
      const hasFallback = candidate < candidates.length - 1;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          response = await fetchSourceUrl(url, headers, controller.signal);
        } catch (err) {
          clearTimeout(timer);
          const aborted = controller.signal.aborted;
          const msg = err instanceof Error ? err.message : String(err);
          downloadError = aborted
            ? new Error(`timed out downloading role "${roleId}" from ${url} after ${Math.round(timeoutMs / 1000)}s`)
            : new Error(`network error downloading role "${roleId}": ${msg}`);
        }

        if (response !== undefined) {
          // Fetch succeeded. Keep the controller/timer alive for body streaming.
          downloadController = controller;
          downloadTimer = timer;

          if (response.status === 404) {
            clearTimeout(timer);
            if (hasFallback) {
              response = undefined;
              downloadController = undefined;
              downloadTimer = undefined;
              continue candidatesLoop;
            }
            fail("downloading", `role "${roleId}" not found in registry "${registry.name}"`, attempt, maxAttempts);
            throw new Error(`role "${roleId}" not found in registry "${registry.name}"`);
          }
          if (!response.ok) {
            clearTimeout(timer);
            fail("downloading", `HTTP ${response.status}`, attempt, maxAttempts);
            throw new Error(`failed to download role "${roleId}": HTTP ${response.status}`);
          }
          break candidatesLoop;
        }

        // Fetch failed (network or timeout). Retry with backoff, or throw on the
        // final attempt.
        const err = downloadError!;
        if (attempt < maxAttempts) {
          progress?.phaseFail("downloading", { asset, reason: err.message, attempt, maxAttempts });
          await delay(backoffMs(attempt));
        } else {
          fail("downloading", err.message, attempt, maxAttempts);
          throw err;
        }
      }
    }

    if (response === undefined || downloadController === undefined || downloadTimer === undefined) {
      throw downloadError ?? new Error(`failed to download role "${roleId}"`);
    }

    // Stream the body to disk, reporting bytes as they arrive. Fall back to
    // arrayBuffer if the response has no streamable body. Surface Content-Length
    // via progress and treat a truncated body (bytes read < Content-Length) as
    // an explicit error rather than a silent success. The size cap is checked
    // against the declared length first and against the streamed bytes below,
    // so a hostile source cannot buffer an unbounded archive.
    const total = Number(response.headers.get("content-length")) || 0;
    if (total > maxBytes) {
      clearTimeout(downloadTimer);
      const msg = `role "${roleId}" archive is larger than the ${maxBytes}-byte limit (Content-Length: ${total}); refusing to download it`;
      fail("downloading", msg);
      throw new Error(msg);
    }
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      let oversize: string | undefined;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            received += value.byteLength;
            if (received > maxBytes) {
              oversize = `role "${roleId}" archive is larger than the ${maxBytes}-byte limit (received ${received} bytes); refusing to download it`;
              try {
                await reader.cancel();
              } catch {
                // The cap refusal below is the error that matters.
              }
              break;
            }
            chunks.push(value);
            progress?.update({ received, total });
          }
        }
      } catch (err) {
        clearTimeout(downloadTimer);
        if (downloadController.signal.aborted) {
          const msg = `timed out downloading role "${roleId}" from ${url} after ${Math.round(timeoutMs / 1000)}s`;
          fail("downloading", msg);
          throw new Error(msg);
        }
        const msg = err instanceof Error ? err.message : String(err);
        fail("downloading", msg);
        throw new Error(`network error downloading role "${roleId}": ${msg}`);
      }
      clearTimeout(downloadTimer);
      if (oversize !== undefined) {
        fail("downloading", oversize);
        throw new Error(oversize);
      }
      if (total > 0 && received < total) {
        const msg = `truncated download for role "${roleId}": expected ${total} bytes (Content-Length) but received ${received}; refusing to use the incomplete archive`;
        fail("downloading", msg);
        throw new Error(msg);
      }
      writeFileSync(archiveFile, Buffer.concat(chunks));
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) {
        const msg = `role "${roleId}" archive is larger than the ${maxBytes}-byte limit (received ${buffer.byteLength} bytes); refusing to download it`;
        fail("downloading", msg);
        throw new Error(msg);
      }
      if (total > 0 && buffer.byteLength < total) {
        const msg = `truncated download for role "${roleId}": expected ${total} bytes (Content-Length) but received ${buffer.byteLength}; refusing to use the incomplete archive`;
        fail("downloading", msg);
        throw new Error(msg);
      }
      writeFileSync(archiveFile, buffer);
    }
    progress?.phaseComplete("downloading");

    // Extract, verify, and move to stable location
    mkdirSync(extractDir, { recursive: true });

    // Verify tar is available on PATH before attempting extraction
    progress?.phaseStart("verifying", asset);
    const tarCheck = runSpawnSync("tar", ["--version"], { stdio: "ignore" });
    if (tarCheck.status !== 0 && tarCheck.error) {
      fail("verifying", "tar binary not found — please install tar");
      throw new Error("tar binary not found — please install tar");
    }
    progress?.phaseComplete("verifying");

    progress?.phaseStart("extracting", asset);
    let exitCode: number | null;
    try {
      exitCode = await new Promise<number | null>((resolve, reject) => {
        const proc = runSpawn("tar", ["xzf", archiveFile, "--strip-components=1", "-C", extractDir], {
          stdio: "inherit",
        });
        // A hostile archive can expand far beyond the bytes it weighs. The tree
        // tar is writing is measured while it runs and tar is killed once the
        // cap is crossed, so a decompression bomb cannot fill the disk first.
        let oversizeKill = false;
        const sizeTimer = setInterval(() => {
          if (oversizeKill) return;
          if (treeSizeBytes(extractDir, maxExtractedBytes) > maxExtractedBytes) {
            oversizeKill = true;
            proc.kill("SIGKILL");
          }
        }, EXTRACT_SIZE_POLL_MS);
        proc.on("error", (err) => {
          clearInterval(sizeTimer);
          reject(err);
        });
        proc.on("close", (code) => {
          clearInterval(sizeTimer);
          if (oversizeKill) {
            reject(
              new Error(
                `archive expands beyond the ${maxExtractedBytes}-byte extraction limit; refusing to extract it`,
              ),
            );
          } else {
            resolve(code);
          }
        });
      });
    } catch (err) {
      const msg = `extraction failed for role "${roleId}": ${(err as Error).message}`;
      fail("extracting", msg);
      throw new Error(msg);
    }

    if ((exitCode ?? 1) !== 0) {
      // On Windows, bsdtar can fail creating symlinks without Developer Mode or
      // elevated privilege even though the archive's regular files were
      // extracted. Degrade to a copy (the files are present; symlinks are
      // missing/broken) with a clear warning instead of hard-failing — but only
      // if the role dir actually landed. Otherwise this is a real failure.
      const degradedRoleDir = resolveExtractedRoleDir(extractDir, roleId, parsed.kind);
      if (process.platform === "win32" && degradedRoleDir !== undefined) {
        console.warn(
          `Warning: tar reported failure (exit ${exitCode}) extracting role "${roleId}" on Windows; this is usually caused by symlink creation requiring elevated privileges (Developer Mode). Degrading to a copy of the extracted files; symlinks may be missing or materialized as regular files.`,
        );
      } else {
        const msg = `extraction failed for role "${roleId}": tar exited with code ${exitCode ?? 1}`;
        fail("extracting", msg);
        throw new Error(msg);
      }
    }

    // An archive that finished between two size polls is caught here, before
    // anything is verified or delivered.
    const extractedBytes = treeSizeBytes(extractDir, maxExtractedBytes);
    if (extractedBytes > maxExtractedBytes) {
      const msg = `extraction failed for role "${roleId}": archive expands beyond the ${maxExtractedBytes}-byte extraction limit (${extractedBytes} bytes extracted); refusing to use it`;
      fail("extracting", msg);
      throw new Error(msg);
    }

    // Zip-slip / path-traversal safety: verify that no extracted entry resolves
    // outside extractDir (covers `..` traversal, absolute paths, and symlinks
    // escaping the tree). Fails with an actionable error instead of trusting tar.
    assertExtractionWithinDir(extractDir, roleId);

    const roleDir = resolveExtractedRoleDir(extractDir, roleId, parsed.kind);
    if (roleDir === undefined) {
      const msg = `extraction failed for role "${roleId}": role directory not found at ${join(extractDir, "roles", roleId)}`;
      fail("extracting", msg);
      throw new Error(msg);
    }

    // Move role directory to stable output location before tmpDir cleanup
    rmSync(outputDir, { recursive: true, force: true });
    renameSync(roleDir, outputDir);
    // Containment was verified on <tmp>/extracted; the move re-anchors every
    // relative symlink in the tree, so the tree that is actually delivered is
    // checked again where it now lives. A link that left the role's own
    // directory (and so points at a sibling after the move) is refused here.
    assertExtractionWithinDir(outputDir, roleId);
    committed = true;
    progress?.phaseComplete("extracting");

    return outputDir;
  } finally {
    // Always clean up the temporary extraction workspace. Additionally remove
    // the `rolebox-out-*` outputDir on every FAILURE path — only the committed
    // (successfully renamed) outputDir survives. Both removals are best-effort:
    // a hostile archive must not be able to leak a tree here, and a cleanup
    // error must not replace the failure that is already propagating.
    removeDirBestEffort(tmpDir);
    if (!committed) {
      removeDirBestEffort(outputDir);
    }
  }
}

/**
 * Whether `candidate` is a real directory (not a symlink) whose realpath stays
 * inside `root`. `existsSync` alone accepts a symlinked role directory, which
 * the move below would then relocate out of the checked tree.
 */
function isRealDirInside(root: string, candidate: string): boolean {
  let stat;
  try {
    stat = lstatSync(candidate);
  } catch {
    return false;
  }
  if (!stat.isDirectory()) return false;

  let real: string;
  let realRoot: string;
  try {
    real = realpathSync(candidate);
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  return real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
}

/**
 * Which directory inside the extraction tree holds the role. The result is a
 * real directory inside extractDir: a symlinked role directory (or one whose
 * realpath leaves the tree) is refused instead of being renamed out of the
 * checked tree, where the move would re-anchor its target.
 *
 * github/gitlab archives have exactly one layout after `--strip-components=1`:
 * `roles/<roleId>/`. A plain `http` tarball may instead carry the role files
 * themselves, so it also accepts `<extractDir>/<roleId>` and — when
 * `<extractDir>/role.yaml` exists — the extract directory itself.
 */
function resolveExtractedRoleDir(
  extractDir: string,
  roleId: string,
  kind: SourceKind,
): string | undefined {
  const candidates = [join(extractDir, "roles", roleId)];
  if (kind === "http") {
    candidates.push(join(extractDir, roleId));
    if (existsSync(join(extractDir, "role.yaml"))) candidates.push(extractDir);
  }

  for (const candidate of candidates) {
    if (lstatSync(candidate, { throwIfNoEntry: false }) === undefined) continue;
    if (isRealDirInside(extractDir, candidate)) return candidate;
    throw new Error(
      `extraction failed for role "${roleId}": ${candidate} is not a real directory inside the extract directory; refusing unsafe archive (zip-slip / path traversal)`,
    );
  }
  return undefined;
}

/**
 * Walk `dir` and return every entry as a path relative to `dir`.
 */
function collectEntries(dir: string): string[] {
  const out: string[] = [];
  function walk(d: string, rel: string) {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry);
      const r = rel ? join(rel, entry) : entry;
      out.push(r);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, r);
    }
  }
  walk(dir, "");
  return out;
}

/**
 * Reject trees whose entries escape the directory being checked (zip-slip /
 * path traversal). Uses `realpathSync` so symlinks pointing outside the tree are
 * caught, not just `..` / absolute path names. It runs on the extraction
 * directory after tar and again on the delivered role directory after the move,
 * so containment holds of the tree that is actually installed.
 *
 * On Windows, broken symlinks (a byproduct of tar failing to create symlinks
 * without privileges) degrade to a warning + skip rather than a hard failure;
 * on other platforms a broken symlink is treated as a corrupt archive.
 */
function assertExtractionWithinDir(root: string, roleId: string): void {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return; // directory missing/unreadable; the caller's role-dir check reports it
  }
  const rootPrefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;

  for (const rel of collectEntries(root)) {
    const full = join(root, rel);
    let real: string;
    try {
      real = realpathSync(full);
    } catch {
      // Broken symlink or unreadable entry.
      if (process.platform === "win32") {
        console.warn(
          `Warning: entry "${rel}" in role "${roleId}" is a broken symlink; on Windows symlink creation may require elevated privileges. Skipping entry (degraded extraction).`,
        );
        continue;
      }
      throw new Error(
        `extraction failed for role "${roleId}": entry "${rel}" is a broken symlink; refusing to use a corrupt archive`,
      );
    }
    if (real !== realRoot && !real.startsWith(rootPrefix)) {
      throw new Error(
        `extraction failed for role "${roleId}": entry "${rel}" resolves outside ${root} (${real}); refusing unsafe archive (zip-slip / path traversal)`,
      );
    }
  }
}

// ── Integrity ─────────────────────────────────────────────────────

/** One tree entry as it enters the digest: its shape, not just its bytes. */
interface IntegrityEntry {
  relativePath: string;
  /** `f` regular file, `l` symlink, `d` directory (empty contents still recorded). */
  kind: "f" | "l" | "d";
  /** File contents, or the link target for a symlink, or `""` for a directory. */
  data: Buffer;
}

/**
 * Walk `dir` for the integrity digest.
 *
 * Every entry counts, including its kind and a symlink's target: the digest is
 * an identity for WHAT was installed, and symlinks are hashed as links rather
 * than followed (a link out of the tree must not read as the tree it points
 * at). An entry that cannot be read or stat'd is an error, not a silent
 * omission — a digest that covers "whatever was readable" pins nothing.
 *
 * Field framing is length-prefixed so two different trees cannot produce the
 * same byte stream by concatenation (for example a file named `a` with content
 * `Xb\0Y` versus files `a`/`b` with contents `X`/`Y`).
 */
function walkFiles(dir: string, prefix: string = ""): IntegrityEntry[] {
  const results: IntegrityEntry[] = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const relPath = prefix ? join(prefix, entry) : entry;
    const stat = lstatSync(fullPath);
    if (stat.isDirectory()) {
      results.push({ relativePath: relPath, kind: "d", data: Buffer.alloc(0) });
      results.push(...walkFiles(fullPath, relPath));
    } else if (stat.isSymbolicLink()) {
      results.push({ relativePath: relPath, kind: "l", data: Buffer.from(readlinkSync(fullPath)) });
    } else if (stat.isFile()) {
      results.push({ relativePath: relPath, kind: "f", data: readFileSync(fullPath) });
    } else {
      throw new Error(
        `cannot compute integrity of ${relPath}: unsupported entry type (not a file, directory or symlink)`,
      );
    }
  }
  return results;
}

/** Hash one length-prefixed field, so field boundaries cannot be forged. */
function hashField(hash: ReturnType<typeof createHash>, value: Buffer | string): void {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf-8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(buffer.byteLength));
  hash.update(length);
  hash.update(buffer);
}

/**
 * Compute SHA256 hash of all entries in a directory for lock file integrity.
 *
 * Throws when the tree cannot be read in full: a partial digest would pin a
 * different tree than the one on disk.
 */
export async function computeIntegrity(dirPath: string): Promise<string> {
  const files = walkFiles(dirPath);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const hash = createHash("sha256");
  for (const file of files) {
    hashField(hash, file.relativePath);
    hashField(hash, file.kind);
    hashField(hash, file.data);
  }

  return `sha256-${hash.digest("hex")}`;
}
