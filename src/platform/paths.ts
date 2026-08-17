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
 * Per pi's documented environment variables, the config directory resolves
 * as `$PI_CODING_AGENT_DIR` when set (non-blank), otherwise `~/.pi/agent`;
 * a blank env value is treated as unset.
 *
 * - `configDir`: `$PI_CODING_AGENT_DIR` or `~/.pi/agent`
 * - `agentsDir`: `{configDir}/skills`
 * - `skillsDir`: `{configDir}/skills`
 * - `sessionsDir`: `{configDir}/sessions`
 * - `extensionsDir`: `{configDir}/extensions`
 */
export function piPlatformPaths(): PlatformPaths {
  const base = process.env.PI_CODING_AGENT_DIR?.trim()
    ? process.env.PI_CODING_AGENT_DIR
    : join(os.homedir(), ".pi", "agent");
  return {
    platformId: "pi",
    configDir: base,
    agentsDir: join(base, "skills"),
    skillsDir: join(base, "skills"),
    sessionsDir: join(base, "sessions"),
    extensionsDir: join(base, "extensions"),
  };
}

/**
 * Returns platform paths for the dsh (DeepSeek Harness) platform.
 *
 * Per the dsh plugin contract (§5.1), the dsh home directory resolves as
 * `$DSH_HOME` when set (non-blank), otherwise `~/.dsh`; a blank env value is
 * treated as unset.
 *
 * - `configDir`: dsh home (`$DSH_HOME` or `~/.dsh`)
 * - `agentsDir`: `{configDir}/skills` (mirrors the pi pattern — dsh has no
 *   native agents directory, so rolebox agent files live under the home tree)
 * - `skillsDir`: `{configDir}/skills`
 * - `sessionsDir`: `{configDir}/sessions` (documented `dshHomePath('sessions')`)
 */
export function dshPlatformPaths(): PlatformPaths {
  const dshHome = process.env.DSH_HOME?.trim()
    ? process.env.DSH_HOME
    : join(os.homedir(), ".dsh");
  return {
    platformId: "dsh",
    configDir: dshHome,
    agentsDir: join(dshHome, "skills"),
    skillsDir: join(dshHome, "skills"),
    sessionsDir: join(dshHome, "sessions"),
  };
}
