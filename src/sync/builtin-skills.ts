import { existsSync, lstatSync, mkdirSync, readlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSubLogger, formatError } from "../logger.ts";
import { createDirSymlink } from "../utils/symlink.ts";

const skillsRoot = fileURLToPath(new URL("../../skills/", import.meta.url));
const builtinSkills = ["rolebox-config"] as const;
const log = createSubLogger("sync");

/**
 * Expose packaged skills through the host's global discovery directory.
 * Existing files/directories are preserved; directory links are refreshed on
 * upgrades. Failures are logged without preventing installation or host startup.
 */
export function syncBuiltinSkills(globalSkillsDir: string): void {
  for (const name of builtinSkills) {
    const source = join(skillsRoot, name);
    if (!existsSync(join(source, "SKILL.md"))) continue;
    const destination = join(globalSkillsDir, name);
    try {
      mkdirSync(globalSkillsDir, { recursive: true });
      let existing;
      try {
        existing = lstatSync(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (existing) {
        if (!existing.isSymbolicLink()) {
          log.warn("Built-in skill destination already exists; leaving it unchanged", { destination });
          continue;
        }
        const target = readlinkSync(destination).replace(/^\\\\\?\\/, "").replace(/^UNC\\/i, "\\\\");
        if (resolve(dirname(destination), target) === resolve(source)) continue;
        unlinkSync(destination);
      }
      createDirSymlink(source, destination);
    } catch (error) {
      log.warn("Failed to sync built-in skill", { destination, error: formatError(error) });
    }
  }
}
