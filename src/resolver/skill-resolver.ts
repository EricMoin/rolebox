import { dirname, join } from "node:path";
import fg from "fast-glob";
import type { ResolvedReference, ResolvedSkill, SkillMetadata } from "../types.ts";
import { SkillScope, ReferenceScope } from "../constants.ts";
import { resolveAllReferences } from "./reference-resolver.ts";
import { skillDirPath, skillFilePath, toPosixPath, toNativePath } from "../utils/paths.ts";
import { createSubLogger, formatError } from "../logger.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { readTextFile, fileExists } from "../utils/fs.ts";

const log = createSubLogger("skill-resolver");

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
  const roleSkillsDir = join(roleDir, "skills");
  return [
    { scope: SkillScope.Rolebox, pattern: skillDirPath(roleSkillsDir, name) },
    { scope: SkillScope.Rolebox, pattern: skillFilePath(roleSkillsDir, name) },
    { scope: SkillScope.Opencode, pattern: skillDirPath(globalSkillsDir, name) },
    { scope: SkillScope.Opencode, pattern: skillFilePath(globalSkillsDir, name) },
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
  if (skillNames.length === 0) return [];

  // Collect all candidate patterns across all skill names for a single batch glob call
  const candidateTasks: { name: string; candidates: Candidate[] }[] = [];
  for (const name of skillNames) {
    candidateTasks.push({ name, candidates: buildCandidates(name, roleDir, globalSkillsDir) });
  }

  // fast-glob only officially supports forward-slash patterns. On win32 the
  // join()-built candidate patterns use backslashes; passing them verbatim
  // makes the static reader return backslash paths (no absolute:true -> no
  // unixify), which then never equal the toPosixPath(candidate.pattern)
  // comparison below. Normalize to forward slashes up front so matchedPaths
  // comes back forward-slash and agrees with the existing comparison. On
  // POSIX toPosixPath is a no-op, so behavior is unchanged there.
  const allPatterns = candidateTasks.flatMap(t => t.candidates.map(c => toPosixPath(c.pattern)));
  const matchedPaths = await fg(allPatterns, { onlyFiles: true });
  const matchSet = new Set(matchedPaths);

  // First pass: determine winner for each skill (fast — no I/O, just Set lookups)
  interface Winner {
    name: string;
    filePath: string;
    scope: ResolvedSkill["scope"];
  }
  const winners: Winner[] = [];
  const notFoundNames: string[] = [];

  for (const { name, candidates } of candidateTasks) {
    let found = false;
    for (const candidate of candidates) {
      // Normalize the join-built pattern to forward slashes so it agrees with
      // fast-glob's always-forward-slash match set on Windows.
      const pattern = toPosixPath(candidate.pattern);
      if (matchSet.has(pattern)) {
        // Store the real filesystem path (native separators on win32), not
        // the glob-normalized pattern: consumers use filePath for actual
        // fs access and path joins (dirname, symlink targets, Pi's
        // resources_discover), which must agree with join-built paths.
        winners.push({ name, filePath: toNativePath(pattern), scope: candidate.scope });
        found = true;
        break;
      }
    }
    if (!found) {
      notFoundNames.push(name);
    }
  }

  // Second pass: read files and resolve references in parallel
  const resolved: ResolvedSkill[] = await Promise.all(
    winners.map(async ({ name, filePath, scope }) => {
      let description = "";
      let references: ResolvedReference[] = [];
      try {
        const content = await readTextFile(filePath);
        const { metadata } = parseFrontmatter(content);
        description = metadata.description ?? "";

        // Resolve references for this skill from its directory
        const skillDir = dirname(filePath);
        references = await resolveAllReferences(
          skillDir,
          ReferenceScope.Skill,
          metadata.references as SkillMetadata["references"],
        );
      } catch (err) {
        // If the file can't be read, use empty description
        log.debug("Failed to read skill file", { filePath, error: formatError(err) });
      }
      return { name, description, scope, filePath, references };
    }),
  );

  // Log not-found names
  for (const name of notFoundNames) {
    const task = candidateTasks.find(t => t.name === name);
    if (task) {
      const candidatePaths = task.candidates.map(c => c.pattern);
      log.info(`Skill "${name}" not found. Searched:`, { candidates: candidatePaths });
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
  if (!(await fileExists(skill.filePath))) {
    throw new Error(
      `Skill file not found at "${skill.filePath}" for skill "${skill.name}". ` +
        `The file may have been deleted after resolution.`,
    );
  }

  return readTextFile(skill.filePath);
}
