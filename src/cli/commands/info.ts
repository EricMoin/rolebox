import { defineCommand } from "citty";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { loadLock, findInLock } from "../config.ts";
import { getSyncTarget, getRolePath } from "../paths.ts";
import { computeIntegrity } from "../registry-client.ts";
import { DEFAULT_FUNCTIONS, RoleMode, SyncTarget } from "../../constants.ts";
import {
  bold,
  dim,
  green,
  yellow,
  red,
  cyan,
  SYM_OK,
  SYM_FAIL,
  SYM_WARN,
  SYM_ARROW,
  printHeader,
  printField,
  checkSymlink,
  listSymlinks,
} from "../format.ts";
import { homedir } from "node:os";

interface RoleYaml {
  name?: string;
  description?: string;
  model?: string;
  mode?: string;
  temperature?: number;
  top_p?: number;
  variant?: string;
  skills?: string[];
  opencode_skills?: string[];
  functions?: string[];
  disable_functions?: string[];
  subagents?: Array<{ name?: string; description?: string }>;
  collaboration?: {
    topology?: string;
    agents?: string[];
    max_iterations?: number;
    flow?: unknown[];
  };
  prompt?: string;
  prompt_file?: string;
}

interface InfoJson {
  role: string;
  name?: string;
  description?: string;
  version: string;
  registry: string;
  installedAt: string;
  integrity: string;
  path: string;
  model?: string;
  mode?: string;
  temperature?: number;
  skills: string[];
  functions: string[];
  subagents: Array<{ name: string; description?: string }>;
  collaboration?: { topology?: string; maxIterations?: number };
  sync: { synced: boolean; symlinkValid: boolean };
  integrityCheck?: { passed: boolean; expected: string; actual: string };
}

export async function info(roleId: string, jsonOutput: boolean, checkIntegrity: boolean): Promise<void> {
  const entry = findInLock(roleId);
  if (!entry) {
    throw new Error(`Role "${roleId}" is not installed. Run \`rolebox list\` to see installed roles.`);
  }

  const rolePath = getRolePath(entry.registry, entry.role, entry.version);
  const roleYamlPath = join(rolePath, "role.yaml");

  let roleConfig: RoleYaml = {};
  if (existsSync(roleYamlPath)) {
    try {
      roleConfig = yaml.load(readFileSync(roleYamlPath, "utf-8")) as RoleYaml || {};
    } catch {
      console.warn("Warning: Failed to load role YAML:", roleYamlPath);
      roleConfig = {};
    }
  }

  const syncTarget = getSyncTarget(SyncTarget.Opencode);
  const linkPath = join(syncTarget, entry.role);
  const sym = checkSymlink(linkPath, entry.role);
  const synced = sym.exists && sym.isSymlink;
  const symlinkValid = synced && sym.targetExists;

  const allSkills = [...(roleConfig.skills || []), ...(roleConfig.opencode_skills || [])];
  const allFunctions = roleConfig.functions || [...DEFAULT_FUNCTIONS];
  const subagents = [
    ...(roleConfig.subagents || []).map((s) => ({ name: s.name || "unnamed", description: s.description })),
    ...discoverFileSubagents(rolePath),
  ];

  let integrityResult: { passed: boolean; expected: string; actual: string } | undefined;
  if (checkIntegrity && existsSync(rolePath)) {
    const actual = await computeIntegrity(rolePath);
    integrityResult = {
      passed: actual === entry.integrity,
      expected: entry.integrity,
      actual,
    };
  }

  if (jsonOutput) {
    const output: InfoJson = {
      role: entry.role,
      name: roleConfig.name,
      description: roleConfig.description,
      version: entry.version,
      registry: entry.registry,
      installedAt: entry.installedAt,
      integrity: entry.integrity,
      path: rolePath,
      model: roleConfig.model,
      mode: roleConfig.mode,
      temperature: roleConfig.temperature,
      skills: allSkills,
      functions: allFunctions,
      subagents,
      ...(roleConfig.collaboration ? {
        collaboration: {
          topology: roleConfig.collaboration.topology,
          maxIterations: roleConfig.collaboration.max_iterations,
        },
      } : {}),
      sync: { synced, symlinkValid },
      ...(integrityResult ? { integrityCheck: integrityResult } : {}),
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Role header
  console.log("");
  console.log(`${bold(entry.role)}`);

  // Basic info
  printHeader("Details");
  if (roleConfig.name) printField("Name", roleConfig.name);
  if (roleConfig.description) printField("Description", roleConfig.description);
  printField("Version", entry.version);
  printField("Registry", entry.registry);
  printField("Installed", entry.installedAt);
  printField("Integrity", dim(entry.integrity));
  printField("Path", shortenPath(rolePath));

  // Model config
  if (roleConfig.model || roleConfig.mode || roleConfig.temperature) {
    printHeader("Model");
    if (roleConfig.model) printField("Model", roleConfig.model);
    printField("Mode", roleConfig.mode || RoleMode.Primary);
    if (roleConfig.temperature != null) printField("Temperature", String(roleConfig.temperature));
    if (roleConfig.top_p != null) printField("Top P", String(roleConfig.top_p));
    if (roleConfig.variant) printField("Variant", roleConfig.variant);
  }

  // Skills
  if (allSkills.length > 0) {
    printHeader(`Skills (${allSkills.length})`);
    const maxShow = 10;
    const shown = allSkills.slice(0, maxShow);
    for (const skill of shown) {
      console.log(`    ${dim("•")} ${skill}`);
    }
    if (allSkills.length > maxShow) {
      console.log(`    ${dim(`... and ${allSkills.length - maxShow} more`)}`);
    }
  }

  // Functions
  printHeader(`Functions (${allFunctions.length})`);
  console.log(`    ${allFunctions.join(", ")}`);
  if (roleConfig.disable_functions && roleConfig.disable_functions.length > 0) {
    console.log(`    ${dim("disabled:")} ${roleConfig.disable_functions.join(", ")}`);
  }

  // Subagents
  if (subagents.length > 0) {
    printHeader(`Subagents (${subagents.length})`);
    for (const sub of subagents) {
      const desc = sub.description ? dim(` — ${sub.description}`) : "";
      console.log(`    ${dim("•")} ${sub.name}${desc}`);
    }
  }

  // Collaboration
  if (roleConfig.collaboration) {
    printHeader("Collaboration");
    const collab = roleConfig.collaboration;
    if (collab.topology) printField("Topology", collab.topology, 4);
    if (collab.agents) printField("Agents", collab.agents.join(", "), 4);
    if (collab.max_iterations) printField("Max iters", String(collab.max_iterations), 4);
    if (collab.flow) printField("Custom flow", `${collab.flow.length} edges`, 4);
  }

  // Sync status
  printHeader("Sync");
  if (symlinkValid) {
    console.log(`  ${SYM_OK} Symlinked to ${dim(shortenPath(linkPath))}`);
  } else if (synced) {
    console.log(`  ${SYM_WARN} Symlink exists but target is ${red("missing")}`);
  } else {
    console.log(`  ${SYM_FAIL} Not synced. Run ${cyan("rolebox sync opencode")}`);
  }

  // Integrity check
  if (integrityResult) {
    console.log("");
    if (integrityResult.passed) {
      console.log(`  ${SYM_OK} Integrity check ${green("passed")}`);
    } else {
      console.log(`  ${SYM_FAIL} Integrity check ${red("FAILED")}`);
      console.log(`    Expected: ${dim(integrityResult.expected)}`);
      console.log(`    Actual:   ${dim(integrityResult.actual)}`);
      process.exitCode = 1;
    }
  }

  console.log("");
}

// ── Helpers ──────────────────────────────────────────────────────

function discoverFileSubagents(rolePath: string): Array<{ name: string; description?: string }> {
  const subagentsDir = join(rolePath, "subagents");
  if (!existsSync(subagentsDir)) return [];

  const results: Array<{ name: string; description?: string }> = [];
  try {
    const entries = readdirSync(subagentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subRoleYaml = join(subagentsDir, entry.name, "role.yaml");
      if (existsSync(subRoleYaml)) {
        try {
          const config = yaml.load(readFileSync(subRoleYaml, "utf-8")) as { name?: string; description?: string } || {};
          results.push({ name: config.name || entry.name, description: config.description });
        } catch {
          console.warn("Warning: Failed to load subagent YAML:", subRoleYaml);
          results.push({ name: entry.name });
        }
      }
    }
  } catch {
    // Best-effort — subagent discovery should not crash info
  }
  return results;
}

function shortenPath(p: string): string {
  const home = homedir();
  if (p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}

export default defineCommand({
  meta: {
    name: "info",
    description: "Show detailed info for an installed role",
  },
  args: {
    role: {
      type: "positional",
      description: "Role ID to inspect",
      required: true,
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
    },
    check: {
      type: "boolean",
      description: "Verify integrity hash",
    },
  },
  async run({ args }) {
    await info(args.role, args.json ?? false, args.check ?? false);
  },
});
