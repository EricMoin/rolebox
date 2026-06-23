import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { getDataDir } from "./paths.js";
import { parseRegistryManifestFromYaml } from "./schemas.js";
import type { RegistryManifest } from "./types.js";

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

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
        if (!isNaN(cachedAt) && Date.now() - cachedAt < CACHE_TTL_MS) {
          const cached = readFileSync(cacheFile, "utf-8");
          return parseRegistryManifestFromYaml(cached);
        }
      }
    } catch (err) {
      // Cache read failure: proceed to fetch
      const _msg = err instanceof Error ? err.message : String(err);
      void _msg;
    }
  }

  // Build URL
  const { owner, repo } = parseGitHubUrl(registry.url);
  const branch = ref || "main";
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
 * Download a role from a GitHub registry tarball and extract it.
 */
export async function downloadRole(
  registry: { name: string; url: string },
  roleId: string,
  _version: string,
  ref?: string
): Promise<string> {
  const { owner, repo } = parseGitHubUrl(registry.url);
  const branch = ref || "main";
  const url = `https://api.github.com/repos/${owner}/${repo}/tarball/${branch}`;

  const headers: Record<string, string> = {};
  if (process.env.GITHUB_TOKEN) {
    headers["Authorization"] = `token ${process.env.GITHUB_TOKEN}`;
  }

  // Create temp directory
  const tmpDir = mkdtempSync(join(tmpdir(), "rolebox-"));
  const archivePath = join(tmpDir, "archive.tar.gz");

  // Download tarball
  let response: Response;
  try {
    response = await fetch(url, { headers, redirect: "follow" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`network error downloading role "${roleId}": ${msg}`);
  }

  if (response.status === 404) {
    throw new Error(`role "${roleId}" not found in registry "${registry.name}"`);
  }

  if (!response.ok) {
    throw new Error(`failed to download role "${roleId}": HTTP ${response.status}`);
  }

  // Write archive to disk
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(archivePath, buffer);

  // Extract using tar
  const extractDir = join(tmpDir, "extracted");
  mkdirSync(extractDir, { recursive: true });

  let exitCode: number;
  try {
    const proc = Bun.spawn(
      ["tar", "xzf", archivePath, "--strip-components=1", `--include=*/roles/${roleId}/*`, "-C", extractDir],
      {
        stdout: "inherit",
        stderr: "inherit",
      }
    );
    exitCode = (await proc.exited) ?? 1;
  } catch (err) {
    throw new Error(`extraction failed for role "${roleId}": ${(err as Error).message}`);
  }

  // Clean up archive regardless of success
  try { unlinkSync(archivePath); } catch { /* ignore */ }

  if (exitCode !== 0) {
    throw new Error(`extraction failed for role "${roleId}": tar exited with code ${exitCode}`);
  }

  const roleDir = join(extractDir, "roles", roleId);
  if (!existsSync(roleDir)) {
    throw new Error(`extraction failed for role "${roleId}": role directory not found at ${roleDir}`);
  }

  return roleDir;
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
