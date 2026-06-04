import fg from "fast-glob";
import yaml from "js-yaml";
import type { ResolvedSkill, SkillMetadata } from "./types";

interface Candidate {
  scope: ResolvedSkill["scope"];
  pattern: string;
}

// Resolution priority:
//  1. {roleDir}/skills/{name}/SKILL.md  (role-local directory)
//  2. {roleDir}/skills/{name}.md        (role-local single-file)
//  3. {globalSkillsDir}/{name}/SKILL.md (global directory)
//  4. {globalSkillsDir}/{name}.md       (global single-file)
function buildCandidates(
  name: string,
  roleDir: string,
  globalSkillsDir: string,
): Candidate[] {
  return [
    { scope: "rolebox", pattern: `${roleDir}/skills/${name}/SKILL.md` },
    { scope: "rolebox", pattern: `${roleDir}/skills/${name}.md` },
    { scope: "opencode", pattern: `${globalSkillsDir}/${name}/SKILL.md` },
    { scope: "opencode", pattern: `${globalSkillsDir}/${name}.md` },
  ];
}

/**
 * Resolve skill names to their file locations using fast-glob.
 *
 * For each skill name the four candidate locations are checked in priority
 * order.  The first existing file wins.  Skills that cannot be found in any
 * location are silently skipped (no error is thrown).
 */
export async function resolveSkills(
  skillNames: string[],
  roleDir: string,
  globalSkillsDir: string,
): Promise<ResolvedSkill[]> {
  const resolved: ResolvedSkill[] = [];

  for (const name of skillNames) {
    const candidates = buildCandidates(name, roleDir, globalSkillsDir);

    for (const candidate of candidates) {
      const matches = await fg(candidate.pattern, { onlyFiles: true });
      if (matches.length > 0) {
        const filePath = matches[0];
        let description = "";
        try {
          const content = await Bun.file(filePath).text();
          const { metadata } = parseFrontmatter(content);
          description = metadata.description ?? "";
        } catch {
          // If the file can't be read, use empty description
        }
        resolved.push({ name, description, scope: candidate.scope, filePath });
        break;
      }
    }
  }

  return resolved;
}

/**
 * Read the full SKILL.md content from the resolved skill's file path.
 *
 * @throws If the file cannot be read (e.g. it was deleted since resolution).
 */
export async function loadSkillContent(skill: ResolvedSkill): Promise<string> {
  const file = Bun.file(skill.filePath);

  if (!(await file.exists())) {
    throw new Error(
      `Skill file not found at "${skill.filePath}" for skill "${skill.name}". ` +
        `The file may have been deleted after resolution.`,
    );
  }

  return file.text();
}

/**
 * Parse YAML frontmatter from SKILL.md content.
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
