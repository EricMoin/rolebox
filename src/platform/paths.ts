import os from "node:os";
import { join } from "node:path";

/**
 * Platform-specific directory paths.
 *
 * Each platform (Opencode, Pi, etc.) provides its own set of paths
 * for agent files, config, skills, sessions, and extensions.
 */
export interface PlatformPaths {
  /** Platform identifier (e.g. `"opencode"`, `"pi"`). */
  platformId: string;
  /** Directory where agent definition files are stored. */
  agentsDir: string;
  /** Platform configuration directory. */
  configDir: string;
  /** Directory where skill files are stored. */
  skillsDir: string;
  /** Optional sessions directory. */
  sessionsDir?: string;
  /** Optional extensions directory. */
  extensionsDir?: string;
}

/**
 * Returns platform paths for the Opencode platform.
 *
 * - `configDir`: respects `XDG_CONFIG_HOME`, defaults to `~/.config/opencode`
 * - `agentsDir`: `~/.claude/agents`
 * - `skillsDir`: `{configDir}/skills`
 */
export function defaultPlatformPaths(): PlatformPaths {
  const xdg = process.env.XDG_CONFIG_HOME;
  const configDir = xdg
    ? join(xdg, "opencode")
    : join(os.homedir(), ".config", "opencode");
  return {
    platformId: "opencode",
    configDir,
    agentsDir: join(os.homedir(), ".claude", "agents"),
    skillsDir: join(configDir, "skills"),
  };
}

/**
 * Returns platform paths for the Pi platform.
 *
 * - `configDir`: `~/.pi/agent`
 * - `agentsDir`: `~/.pi/agent/skills`
 * - `skillsDir`: `~/.pi/agent/skills`
 * - `sessionsDir`: `~/.pi/agent/sessions`
 * - `extensionsDir`: `~/.pi/agent/extensions`
 */
export function piPlatformPaths(): PlatformPaths {
  const base = join(os.homedir(), ".pi", "agent");
  return {
    platformId: "pi",
    configDir: base,
    agentsDir: join(base, "skills"),
    skillsDir: join(base, "skills"),
    sessionsDir: join(base, "sessions"),
    extensionsDir: join(base, "extensions"),
  };
}
