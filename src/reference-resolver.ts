import { resolve as pathResolve, relative, dirname, basename, extname } from "node:path";
import fg from "fast-glob";
import yaml from "js-yaml";
import type { ReferenceEntry, ResolvedReference } from "./types.ts";
import type { ReferenceScope } from "./constants.ts";
import { createSubLogger, formatError } from "./logger.ts";

const log = createSubLogger("reference-resolver");

/**
 * Derive a human-readable name from a reference file path.
 * "theory/core-principles.md" → "theory/core-principles"
 */
function deriveNameFromPath(relPath: string): string {
  const ext = extname(relPath);
  const withoutExt = ext ? relPath.slice(0, -ext.length) : relPath;
  // Strip leading "references/" prefix if present
  return withoutExt.replace(/^references\//, "");
}

/**
 * Generate a fallback description from a filename.
 * "core-principles" → "Core Principles"
 */
function deriveDescriptionFromName(name: string): string {
  const filename = basename(name);
  return filename
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Extract description from a markdown file's YAML frontmatter.
 * Returns undefined if no frontmatter or no description field.
 */
async function extractFrontmatterDescription(
  filePath: string,
): Promise<string | undefined> {
  try {
    const content = await Bun.file(filePath).text();
    const trimmed = content.trimStart();

    if (!trimmed.startsWith("---")) return undefined;

    const endIdx = trimmed.indexOf("\n---", 3);
    if (endIdx === -1) return undefined;

    const yamlStr = trimmed.slice(4, endIdx);
    const parsed = yaml.load(yamlStr);

    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const meta = parsed as Record<string, unknown>;
      if (typeof meta.description === "string") {
        return meta.description;
      }
    }
  } catch (err) {
    // File unreadable or invalid frontmatter — skip
    log.debug("Failed to read file", { path: filePath, error: formatError(err) });
  }
  return undefined;
}

/**
 * Auto-discover all .md files in a `references/` directory.
 * Returns resolved references with descriptions from frontmatter or auto-generated.
 */
export async function discoverReferences(
  baseDir: string,
  scope: ReferenceScope,
): Promise<ResolvedReference[]> {
  const refsDir = pathResolve(baseDir, "references");
  let matches: string[];

  try {
    matches = await fg("**/*.md", {
      cwd: refsDir,
      absolute: true,
      onlyFiles: true,
    });
  } catch {
    return [];
  }

  const resolved: ResolvedReference[] = [];

  for (const filePath of matches) {
    const relativePath = relative(baseDir, filePath);
    const name = deriveNameFromPath(relativePath);
    const frontmatterDesc = await extractFrontmatterDescription(filePath);
    const description = frontmatterDesc ?? deriveDescriptionFromName(name);

    resolved.push({ name, filePath, description, scope, relativePath });
  }

  // Sort for deterministic output
  resolved.sort((a, b) => a.name.localeCompare(b.name));
  return resolved;
}

/**
 * Resolve explicit reference declarations from role.yaml or SKILL.md frontmatter.
 * Merges with auto-discovered references, with explicit entries taking priority
 * for description overrides.
 */
export async function resolveExplicitReferences(
  declarations: Record<string, string | ReferenceEntry>,
  baseDir: string,
  scope: ReferenceScope,
): Promise<ResolvedReference[]> {
  const resolved: ResolvedReference[] = [];

  for (const [key, value] of Object.entries(declarations)) {
    const entry: ReferenceEntry =
      typeof value === "string" ? { path: value } : value;

    const filePath = pathResolve(baseDir, entry.path);

    try {
      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        log.warn(`Skipping reference "${key}": file not found at "${entry.path}"`);
        continue;
      }
    } catch (err) {
      log.debug("Failed to check file existence", { path: filePath, error: formatError(err) });
      continue;
    }

    const relativePath = relative(baseDir, filePath);
    const name = key;
    let description: string;

    if (entry.description) {
      description = entry.description;
    } else {
      const frontmatterDesc = await extractFrontmatterDescription(filePath);
      description = frontmatterDesc ?? deriveDescriptionFromName(name);
    }

    resolved.push({ name, filePath, description, scope, relativePath });
  }

  return resolved;
}

/**
 * Resolve all references for a given directory:
 * 1. Auto-discover references/ directory
 * 2. Apply explicit declarations as overrides (for descriptions)
 * 3. Merge with explicit-only entries (files outside references/)
 *
 * Deduplication: explicit entries override auto-discovered ones by filePath.
 */
export async function resolveAllReferences(
  baseDir: string,
  scope: ReferenceScope,
  explicitDeclarations?: Record<string, string | ReferenceEntry>,
): Promise<ResolvedReference[]> {
  const discovered = await discoverReferences(baseDir, scope);

  if (!explicitDeclarations || Object.keys(explicitDeclarations).length === 0) {
    return discovered;
  }

  const explicit = await resolveExplicitReferences(
    explicitDeclarations,
    baseDir,
    scope,
  );

  // Build a map keyed by absolute filePath for deduplication
  const byPath = new Map<string, ResolvedReference>();

  for (const ref of discovered) {
    byPath.set(ref.filePath, ref);
  }

  // Explicit entries override discovered ones (for description enrichment)
  for (const ref of explicit) {
    byPath.set(ref.filePath, ref);
  }

  const merged = Array.from(byPath.values());
  merged.sort((a, b) => a.name.localeCompare(b.name));
  return merged;
}
