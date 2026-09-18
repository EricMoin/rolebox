/**
 * Codex plugin-bundle writer.
 *
 * Codex is extended through a local plugin marketplace: a marketplace root
 * (`{codexHome}/rolebox-marketplace`) carrying
 * `.agents/plugins/marketplace.json` plus one directory per plugin, and a
 * plugin directory (`{marketplaceRoot}/plugins/rolebox`) whose
 * `.codex-plugin/plugin.json` declares the skills directory and the MCP server
 * config (`.mcp.json`). This module owns that layout and the managed
 * registration block in the Codex `config.toml`, so `rolebox sync codex` is
 * idempotent and never rewrites bytes outside its own block.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDirSymlink } from "../../../utils/symlink.ts";
import { PLUGIN_ID } from "../../../constants.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CodexPluginBundleOptions {
  /** Codex home directory (`$CODEX_HOME` or `~/.codex`). */
  codexHome: string;
  /** rolebox package root — the directory containing package.json. */
  packageRoot: string;
  /** rolebox package version, written into the plugin manifest. */
  version: string;
  /** Absolute path to the MCP server entry. Defaults to `{packageRoot}/dist/entries/codex.js`. */
  serverEntry?: string;
  /** Runtime that launches the server entry. Defaults to `node`. */
  runtimeCommand?: string;
}

export interface CodexPluginBundlePaths {
  /** Marketplace root: `{codexHome}/rolebox-marketplace`. */
  marketplaceDir: string;
  /** Plugin directory: `{marketplaceDir}/plugins/rolebox`. */
  pluginDir: string;
  /** `{pluginDir}/.codex-plugin/plugin.json`. */
  manifestPath: string;
  /** `{pluginDir}/.mcp.json`. */
  mcpConfigPath: string;
  /** `{marketplaceDir}/.agents/plugins/marketplace.json`. */
  marketplaceManifestPath: string;
  /** `{pluginDir}/skills` — the symlink exposing `{codexHome}/skills`. */
  skillsLinkPath: string;
  /** `{codexHome}/config.toml` — the managed registration block lives here. */
  configPath: string;
  /** Absolute path to the MCP server entry recorded in `.mcp.json`. */
  serverEntry: string;
}

// ── Managed config block ────────────────────────────────────────────────────

const MANAGED_START =
  "# >>> rolebox (managed) — do not edit; `rolebox sync codex` rewrites this block >>>";
const MANAGED_END = "# <<< rolebox (managed) <<<";

/** Escape a TOML basic-string value (backslash + double quote). */
function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** The managed `config.toml` block for a marketplace root. */
function buildManagedBlock(marketplaceDir: string): string {
  return [
    MANAGED_START,
    "[marketplaces.rolebox]",
    'source_type = "local"',
    `source = "${escapeTomlString(marketplaceDir)}"`,
    '[plugins."rolebox@rolebox"]',
    "enabled = true",
    MANAGED_END,
  ].join("\n");
}

/**
 * Locate the managed block in an existing config. `end` is exclusive and does
 * NOT consume the newline that terminates the end-marker line, so a replacement
 * can splice a fresh block in without losing the surrounding bytes.
 */
function findManagedRegion(content: string): { start: number; end: number } | null {
  const start = content.indexOf(MANAGED_START);
  if (start === -1) return null;
  const endMarker = content.indexOf(MANAGED_END, start);
  if (endMarker === -1) return null;
  return { start, end: endMarker + MANAGED_END.length };
}

// ── Bundle contents ─────────────────────────────────────────────────────────

function buildPluginManifest(version: string): Record<string, unknown> {
  return {
    name: PLUGIN_ID,
    version,
    description:
      "Define custom AI agent roles with per-role prompts, models, skills and permissions.",
    author: { name: PLUGIN_ID },
    homepage: "https://github.com/EricMoin/rolebox",
    license: "MIT",
    keywords: ["agents", "roles", "skills", "mcp", "developer-tools"],
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    interface: {
      displayName: PLUGIN_ID,
      shortDescription: "Role-based agents, skills and tools",
      longDescription:
        "Defines custom AI agent roles, each with its own prompts, models, skills and permissions, and exposes rolebox's role, skill and graph tools to Codex over MCP.",
      developerName: PLUGIN_ID,
      category: "Developer Tools",
      capabilities: ["Read", "Write"],
    },
  };
}

function buildMcpConfig(serverEntry: string, runtimeCommand: string): Record<string, unknown> {
  return {
    mcpServers: {
      [PLUGIN_ID]: {
        command: runtimeCommand,
        args: [serverEntry],
        startup_timeout_sec: 60,
        tool_timeout_sec: 600,
      },
    },
  };
}

function buildMarketplaceManifest(): Record<string, unknown> {
  return {
    name: PLUGIN_ID,
    interface: { displayName: PLUGIN_ID },
    plugins: [
      {
        name: PLUGIN_ID,
        source: { source: "local", path: `./plugins/${PLUGIN_ID}` },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Developer Tools",
      },
    ],
  };
}

/** Write JSON with the 2-space indent + trailing newline the Codex bundle uses. */
function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

/** Whether the existing symlink at `linkPath` already points at `targetDir`. */
function linkPointsAt(linkPath: string, targetDir: string): boolean {
  try {
    // Windows junctions read back with a \\?\ prefix; strip it before comparing.
    const current = readlinkSync(linkPath).replace(/^\\\\\?\\/, "");
    return resolve(current) === resolve(targetDir);
  } catch {
    return false;
  }
}

/**
 * Expose `{codexHome}/skills` to the plugin as `{pluginDir}/skills`.
 *
 * Only a symlink is ever created here: a correct link is left untouched
 * (idempotent re-sync), a wrong link is replaced, and a real directory/file is
 * never destroyed.
 */
function ensureSkillsLink(linkPath: string, targetDir: string): void {
  let linkStat: Stats | null = null;
  try {
    linkStat = lstatSync(linkPath);
  } catch {
    linkStat = null;
  }

  if (linkStat === null) {
    createDirSymlink(targetDir, linkPath);
    return;
  }
  if (!linkStat.isSymbolicLink()) return;
  if (linkPointsAt(linkPath, targetDir)) return;
  unlinkSync(linkPath);
  createDirSymlink(targetDir, linkPath);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Walk up from a module URL to the directory containing package.json — bounded
 * because a missing package.json must fail loudly rather than walk to `/`.
 */
export function resolveRoleboxPackageRoot(moduleUrl: string): string {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not resolve the rolebox package root from ${moduleUrl}`);
}

/**
 * Write the Codex plugin bundle (manifest, MCP config, marketplace manifest,
 * skills symlink) under `{codexHome}`. Idempotent: every file is rewritten
 * with identical bytes for identical options, and an existing correct skills
 * link is left untouched.
 */
export function writeCodexPluginBundle(
  opts: CodexPluginBundleOptions,
): CodexPluginBundlePaths {
  const marketplaceDir = join(opts.codexHome, "rolebox-marketplace");
  const pluginDir = join(marketplaceDir, "plugins", PLUGIN_ID);
  const serverEntry =
    opts.serverEntry ?? join(opts.packageRoot, "dist", "entries", "codex.js");

  const paths: CodexPluginBundlePaths = {
    marketplaceDir,
    pluginDir,
    manifestPath: join(pluginDir, ".codex-plugin", "plugin.json"),
    mcpConfigPath: join(pluginDir, ".mcp.json"),
    marketplaceManifestPath: join(marketplaceDir, ".agents", "plugins", "marketplace.json"),
    skillsLinkPath: join(pluginDir, "skills"),
    configPath: join(opts.codexHome, "config.toml"),
    serverEntry,
  };

  mkdirSync(dirname(paths.manifestPath), { recursive: true });
  mkdirSync(dirname(paths.mcpConfigPath), { recursive: true });
  mkdirSync(dirname(paths.marketplaceManifestPath), { recursive: true });
  mkdirSync(join(opts.codexHome, "skills"), { recursive: true });

  writeJson(paths.manifestPath, buildPluginManifest(opts.version));
  writeJson(paths.mcpConfigPath, buildMcpConfig(serverEntry, opts.runtimeCommand ?? "node"));
  writeJson(paths.marketplaceManifestPath, buildMarketplaceManifest());
  ensureSkillsLink(paths.skillsLinkPath, join(opts.codexHome, "skills"));

  return paths;
}

/** Remove the marketplace directory. `removed` is true when it existed. */
export function removeCodexPluginBundle(codexHome: string): { removed: boolean } {
  const marketplaceDir = join(codexHome, "rolebox-marketplace");
  const existed = existsSync(marketplaceDir);
  rmSync(marketplaceDir, { recursive: true, force: true });
  return { removed: existed };
}

/**
 * Register the rolebox marketplace + plugin in a Codex `config.toml`.
 *
 * The registration is a comment-delimited managed block: when one is already
 * present it is replaced in place (so a second run with the same marketplace
 * root is byte-identical), otherwise it is appended after a single newline
 * separator (a blank line when the file already ends with one). No other byte
 * of the user's file is touched. `changed` reports whether the file's bytes
 * actually changed.
 */
export function registerCodexPlugin(
  configPath: string,
  marketplaceDir: string,
): { changed: boolean } {
  const block = buildManagedBlock(marketplaceDir);
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf-8") : null;

  if (existing === null) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${block}\n`, "utf-8");
    return { changed: true };
  }

  const region = findManagedRegion(existing);
  let next: string;
  if (region) {
    next = existing.slice(0, region.start) + block + existing.slice(region.end);
  } else {
    // Exactly one leading newline: it terminates a non-empty file that lacks a
    // trailing one, and forms the blank line before the block otherwise. It is
    // also the single separator unregister removes, so the pre-existing bytes
    // come back either way.
    const separator = existing.length === 0 ? "" : "\n";
    next = `${existing}${separator}${block}\n`;
  }

  if (next === existing) return { changed: false };
  writeFileSync(configPath, next, "utf-8");
  return { changed: true };
}

/**
 * Remove the managed rolebox block from a Codex `config.toml`.
 *
 * Exactly the block and the single newline separator registration introduced
 * are removed, so a pre-existing file is restored byte for byte whether or not
 * it ended with a trailing newline. A file without a managed block (or a
 * missing file) is a no-op.
 */
export function unregisterCodexPlugin(configPath: string): { changed: boolean } {
  if (!existsSync(configPath)) return { changed: false };
  const existing = readFileSync(configPath, "utf-8");
  const region = findManagedRegion(existing);
  if (!region) return { changed: false };

  let start = region.start;
  let end = region.end;
  if (existing[end] === "\n") end++;
  // Drop the single separator newline the append introduced before the block:
  // it is removed when it forms a blank line (the common case) or when the
  // block is the tail of the file — including a file that originally had no
  // trailing newline, where the separator is the block's only predecessor.
  const blockIsTail = end === existing.length;
  if (
    start > 0 &&
    existing[start - 1] === "\n" &&
    (blockIsTail || start === 1 || existing[start - 2] === "\n")
  ) {
    start -= 1;
  }

  const next = existing.slice(0, start) + existing.slice(end);
  if (next === existing) return { changed: false };
  writeFileSync(configPath, next, "utf-8");
  return { changed: true };
}
