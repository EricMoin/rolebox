import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync, renameSync, realpathSync, lstatSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { getDataDir } from "./paths.ts";
import { parseRegistryManifestFromYaml } from "./schemas.ts";
import type { RegistryManifest } from "./types.ts";
import { DEFAULT_GIT_BRANCH, REGISTRY_CACHE_TTL_MS } from "../constants.ts";
import type { DownloadProgress, Phase } from "./download-progress.ts";

// Defaults for the hardened download path. Both are overridable per-call via
// {@link DownloadRoleOptions} so tests can exercise timeout / retry cheaply.
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_DOWNLOAD_MAX_RETRIES = 2;

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

/** Exponential backoff between retry attempts: attempt 1 → 300ms, 2 → 600ms. */
function backoffMs(attempt: number): number {
  return 300 * Math.pow(2, attempt - 1);
}

// ── GitHub URL Parsing ────────────────────────────────────────────

/**
 * Parse a GitHub URL (https or git@) into owner and repo.
 */
export function parseGitHubUrl(url: string): { owner: string; repo: string } {
  // https://github.com/owner/repo
  // https://github.com/owner/repo.git
  let match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }

  // git@github.com:owner/repo.git
  match = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }

  throw new Error(`invalid GitHub URL: "${url}". Expected https://github.com/owner/repo or git@github.com:owner/repo.git`);
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
 * Fetch a registry manifest from a GitHub raw content URL with caching.
 */
export async function fetchRegistryManifest(
  registry: { name: string; url: string },
  ref?: string,
  options?: { noCache?: boolean }
): Promise<RegistryManifest> {
  const cacheDir = join(getDataDir(), "cache", registry.name);
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

  // Build URL
  const { owner, repo } = parseGitHubUrl(registry.url);
  const branch = ref || DEFAULT_GIT_BRANCH;
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/registry.yaml`;

  // Prepare headers
  const headers: Record<string, string> = {};
  if (process.env.GITHUB_TOKEN) {
    headers["Authorization"] = `token ${process.env.GITHUB_TOKEN}`;
  }

  // Fetch
  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("network") || msg.toLowerCase().includes("connection") || msg.toLowerCase().includes("fetch")) {
      throw new Error(`network error fetching registry "${registry.name}": ${msg}`);
    }
    throw new Error(`failed to fetch registry "${registry.name}": ${msg}`);
  }

  // HTTP status handling
  if (response.status === 404) {
    throw new Error(`registry "${registry.name}" not found at ${url}`);
  }

  if (response.status === 403) {
    throw new Error(`rate limited fetching registry "${registry.name}". Set GITHUB_TOKEN for higher rate limits.`);
  }

  if (!response.ok) {
    throw new Error(`failed to fetch registry "${registry.name}": HTTP ${response.status}`);
  }

  const yaml = await response.text();

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
}

/**
 * Download a role from a GitHub registry tarball and extract it.
 */
export async function downloadRole(
  registry: { name: string; url: string },
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
  const maxAttempts = maxRetries + 1;
  const fail = (phase: Phase, reason: string, attempt = 1, attempts = 1) => {
    progress?.phaseFail(phase, { asset, reason, attempt, maxAttempts: attempts });
  };

  const { owner, repo } = parseGitHubUrl(registry.url);
  const branch = ref || DEFAULT_GIT_BRANCH;
  const url = `https://api.github.com/repos/${owner}/${repo}/tarball/${branch}`;

  const headers: Record<string, string> = {};
  if (process.env.GITHUB_TOKEN) {
    headers["Authorization"] = `token ${process.env.GITHUB_TOKEN}`;
  }

  // Create temporary directories.
  //
  // BOTH tmpDir and outputDir are cleaned up on every exit path. The existing
  // finally covered only tmpDir; outputDir (the `rolebox-out-*` dir) leaked on
  // any failure before the final rename. We track `committed` so the success
  // path's returned outputDir is NOT removed, while every failure path removes
  // both.
  const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-"));
  const archivePath = join(tmpDir, "archive.tar.gz");
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

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        response = await fetch(url, { headers, redirect: "follow", signal: controller.signal });
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
          fail("downloading", `role "${roleId}" not found in registry "${registry.name}"`, attempt, maxAttempts);
          throw new Error(`role "${roleId}" not found in registry "${registry.name}"`);
        }
        if (!response.ok) {
          clearTimeout(timer);
          fail("downloading", `HTTP ${response.status}`, attempt, maxAttempts);
          throw new Error(`failed to download role "${roleId}": HTTP ${response.status}`);
        }
        break;
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

    if (response === undefined || downloadController === undefined || downloadTimer === undefined) {
      throw downloadError ?? new Error(`failed to download role "${roleId}"`);
    }

    // Stream the body to disk, reporting bytes as they arrive. Fall back to
    // arrayBuffer if the response has no streamable body. Surface Content-Length
    // via progress and treat a truncated body (bytes read < Content-Length) as
    // an explicit error rather than a silent success.
    const total = Number(response.headers.get("content-length")) || 0;
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            received += value.byteLength;
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
      if (total > 0 && received < total) {
        const msg = `truncated download for role "${roleId}": expected ${total} bytes (Content-Length) but received ${received}; refusing to use the incomplete archive`;
        fail("downloading", msg);
        throw new Error(msg);
      }
      writeFileSync(archivePath, Buffer.concat(chunks));
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (total > 0 && buffer.byteLength < total) {
        const msg = `truncated download for role "${roleId}": expected ${total} bytes (Content-Length) but received ${buffer.byteLength}; refusing to use the incomplete archive`;
        fail("downloading", msg);
        throw new Error(msg);
      }
      writeFileSync(archivePath, buffer);
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
        const proc = runSpawn("tar", ["xzf", archivePath, "--strip-components=1", "-C", extractDir], {
          stdio: "inherit",
        });
        proc.on("error", reject);
        proc.on("close", resolve);
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
      const degradedRoleDir = join(extractDir, "roles", roleId);
      if (process.platform === "win32" && existsSync(degradedRoleDir)) {
        console.warn(
          `Warning: tar reported failure (exit ${exitCode}) extracting role "${roleId}" on Windows; this is usually caused by symlink creation requiring elevated privileges (Developer Mode). Degrading to a copy of the extracted files; symlinks may be missing or materialized as regular files.`,
        );
      } else {
        const msg = `extraction failed for role "${roleId}": tar exited with code ${exitCode ?? 1}`;
        fail("extracting", msg);
        throw new Error(msg);
      }
    }

    // Zip-slip / path-traversal safety: verify that no extracted entry resolves
    // outside extractDir (covers `..` traversal, absolute paths, and symlinks
    // escaping the tree). Fails with an actionable error instead of trusting tar.
    assertExtractionWithinDir(extractDir, roleId);

    const roleDir = join(extractDir, "roles", roleId);
    if (!existsSync(roleDir)) {
      const msg = `extraction failed for role "${roleId}": role directory not found at ${roleDir}`;
      fail("extracting", msg);
      throw new Error(msg);
    }

    // Move role directory to stable output location before tmpDir cleanup
    rmSync(outputDir, { recursive: true, force: true });
    renameSync(roleDir, outputDir);
    committed = true;
    progress?.phaseComplete("extracting");

    return outputDir;
  } finally {
    // Always clean up the temporary extraction workspace. Additionally remove
    // the `rolebox-out-*` outputDir on every FAILURE path — only the committed
    // (successfully renamed) outputDir survives.
    rmSync(tmpDir, { recursive: true, force: true });
    if (!committed) {
      rmSync(outputDir, { recursive: true, force: true });
    }
  }
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
 * Reject archives whose entries escape the extraction directory (zip-slip /
 * path traversal). Uses `realpathSync` so symlinks pointing outside the tree are
 * caught, not just `..` / absolute path names.
 *
 * On Windows, broken symlinks (a byproduct of tar failing to create symlinks
 * without privileges) degrade to a warning + skip rather than a hard failure;
 * on other platforms a broken symlink is treated as a corrupt archive.
 */
function assertExtractionWithinDir(extractDir: string, roleId: string): void {
  let realRoot: string;
  try {
    realRoot = realpathSync(extractDir);
  } catch {
    return; // extract dir missing/unreadable; the caller's role-dir check reports it
  }
  const rootPrefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;

  for (const rel of collectEntries(extractDir)) {
    const full = join(extractDir, rel);
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
        `extraction failed for role "${roleId}": entry "${rel}" resolves outside the extract directory (${real}); refusing unsafe archive (zip-slip / path traversal)`,
      );
    }
  }
}

// ── Integrity ─────────────────────────────────────────────────────

function walkFiles(dir: string, prefix: string = ""): Array<{ relativePath: string; data: Buffer }> {
  const results: Array<{ relativePath: string; data: Buffer }> = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const relPath = prefix ? join(prefix, entry) : entry;
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...walkFiles(fullPath, relPath));
      } else if (stat.isFile()) {
        results.push({ relativePath: relPath, data: readFileSync(fullPath) });
      }
    } catch {
      // Skip files we can't read
    }
  }
  return results;
}

/**
 * Compute SHA256 hash of all files in a directory for lock file integrity.
 */
export async function computeIntegrity(dirPath: string): Promise<string> {
  const files = walkFiles(dirPath);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(file.data);
  }

  return `sha256-${hash.digest("hex")}`;
}
