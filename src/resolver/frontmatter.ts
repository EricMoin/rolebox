import yaml from "js-yaml";
import type { SkillMetadata } from "../types.ts";

/**
 * Parse YAML frontmatter from markdown content.
 *
 * Frontmatter is delimited by `---` lines at the very start of the file.
 *
 * @returns `metadata` — parsed frontmatter keys (empty object if none/invalid)
 *          `body`    — everything after the closing `---` (or the entire
 *                      content when no frontmatter is present).
 */
export function parseFrontmatter(content: string): {
  metadata: SkillMetadata;
  body: string;
} {
  const trimmed = content.trimStart();

  if (!trimmed.startsWith("---")) {
    return { metadata: {}, body: content };
  }

  const endIdx = trimmed.indexOf("\n---", 3);
  if (endIdx === -1) {
    return { metadata: {}, body: content };
  }

  const yamlStr = trimmed.slice(4, endIdx);
  let body = trimmed.slice(endIdx + 4);
  if (body.startsWith("\n")) {
    body = body.slice(1);
  }

  try {
    const parsed = yaml.load(yamlStr);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { metadata: parsed as SkillMetadata, body };
    }
    return { metadata: {}, body };
  } catch {
    return { metadata: {}, body: content };
  }
}
