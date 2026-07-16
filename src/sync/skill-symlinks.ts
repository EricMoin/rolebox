import path from "node:path";
import { mkdirSync, rmdirSync, readdirSync, unlinkSync, symlinkSync, lstatSync, existsSync, readlinkSync, rmSync } from "node:fs";
import type { ResolvedRole } from "../types.ts";
import { SkillScope, ROLEBOX_SKILL_PREFIX, SKILL_MD } from "../constants.ts";
import { createSubLogger, formatError } from "../logger.ts";

const log = createSubLogger("sync");

function ensureSymlinkTarget(symlinkPath: string, targetPath: string): void {
  try {
    const stat = lstatSync(symlinkPath);
    if (stat.isSymbolicLink()) {
      const existing = readlinkSync(symlinkPath);
      if (existing === targetPath) return; // already points to correct target, skip
      unlinkSync(symlinkPath);
    } else if (stat.isDirectory()) {
      rmSync(symlinkPath, { recursive: true, force: true });
    } else {
      unlinkSync(symlinkPath);
    }
  } catch {
    // ENOENT — clear to proceed
  }
}

function createSkillEntry(entryPath: string, filePath: string): void {
  const isDirectorySkill = path.basename(filePath).toLowerCase() === SKILL_MD.toLowerCase();
  try {
    if (isDirectorySkill) {
      ensureSymlinkTarget(entryPath, path.dirname(filePath));
      symlinkSync(path.dirname(filePath), entryPath);
    } else {
      mkdirSync(entryPath, { recursive: true });
      const innerPath = path.join(entryPath, SKILL_MD);
      ensureSymlinkTarget(innerPath, filePath);
      symlinkSync(filePath, innerPath);
    }
  } catch (err) {
    log.warn("Failed to create skill symlink", { entryPath, filePath, error: formatError(err) });
  }
}

/**
 * Sync rolebox skills into ~/.config/opencode/skills/ for oh-my-openagent discovery.
 *
 * oh-my-openagent's loadSkillsFromDir treats symlinks as directories:
 * it resolves them and looks for SKILL.md inside. So:
 * - Directory skills (with SKILL.md): create symlink to the directory
 * - Single-file skills (.md): create a wrapper directory with SKILL.md symlink inside
 */
export function syncSkillSymlinks(resolvedRoles: ResolvedRole[], globalSkillsDir: string): void {
  const entries: { entryName: string; filePath: string }[] = [];
  for (const role of resolvedRoles) {
    for (const skill of role.skills) {
      if (skill.scope !== SkillScope.Rolebox) continue;
      if (!existsSync(skill.filePath)) continue;
      entries.push({ entryName: `${ROLEBOX_SKILL_PREFIX}${skill.name}`, filePath: skill.filePath });
    }
    for (const sub of role.subagents) {
      for (const skill of sub.skills) {
        if (skill.scope !== SkillScope.Rolebox) continue;
        if (!existsSync(skill.filePath)) continue;
        entries.push({ entryName: `${ROLEBOX_SKILL_PREFIX}${sub.id}~${skill.name}`, filePath: skill.filePath });
      }
    }
  }

  // Don't materialize a global skills/ directory when there is nothing to sync
  // and none exists yet — that empty folder is the "mystery" folder users see.
  if (entries.length === 0 && !existsSync(globalSkillsDir)) return;

  try {
    mkdirSync(globalSkillsDir, { recursive: true });
  } catch (err) {
    log.debug("Failed to create directory", { dir: globalSkillsDir, error: formatError(err) });
    return;
  }

  try {
    const existing = readdirSync(globalSkillsDir);
    for (const entry of existing) {
      if (!entry.startsWith(ROLEBOX_SKILL_PREFIX)) continue;
      const entryPath = path.join(globalSkillsDir, entry);
      try {
        const stat = lstatSync(entryPath);
        if (stat.isSymbolicLink()) {
          unlinkSync(entryPath);
        } else if (stat.isDirectory()) {
          const inner = path.join(entryPath, SKILL_MD);
          try { unlinkSync(inner); } catch (err) { log.debug("Cleanup failed", { path: inner, error: formatError(err) }); }
          try { rmdirSync(entryPath); } catch (err) { log.debug("Cleanup failed", { path: entryPath, error: formatError(err) }); }
        }
      } catch (err) {
        log.debug("Failed to check entry", { path: entryPath, error: formatError(err) });
        continue;
      }
    }
  } catch (err) {
    log.warn("Failed to read skills directory", { dir: globalSkillsDir, error: formatError(err) });
  }

  for (const { entryName, filePath } of entries) {
    createSkillEntry(path.join(globalSkillsDir, entryName), filePath);
  }
}
