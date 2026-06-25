import { basename } from "node:path";
import { join } from "node:path";
import { checkTargetDir, deriveRoleId, validateInitRoleId } from "./init-utils.js";
import { scaffoldRole } from "./init-scaffold.js";
import { runInteractiveWizard } from "./init-prompts.js";
import type { InitConfig, TemplateType } from "../templates/index.js";

/**
 * `rolebox init` — Scaffold a new role directory interactively or via flags.
 *
 * Usage:
 *   rolebox init [name] [--yes] [--template <type>] [-t <type>]
 *
 * Flags:
 *   --yes, -y                 Skip prompts, use sensible defaults
 *   --template <type>, -t     Template type (minimal, standard, subagents, collaboration)
 */
export async function init(args: string[]): Promise<void> {
  // -----------------------------------------------------------------------
  // 1. Parse CLI arguments
  // -----------------------------------------------------------------------
  let nameArg: string | undefined;
  let yes = false;
  let templateArg: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];

    if (a === "--yes" || a === "-y") {
      yes = true;
    } else if (a === "--template" || a === "-t") {
      i++;
      templateArg = args[i];
      if (!templateArg) {
        throw new Error("Expected a template type after --template/-t (minimal, standard, subagents, collaboration)");
      }
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}`);
    } else if (a.startsWith("-") && a !== "-y" && a !== "-t") {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      if (nameArg === undefined) {
        nameArg = a;
      }
    }
  }

  // -----------------------------------------------------------------------
  // 2. Validate template type
  // -----------------------------------------------------------------------
  const VALID_TEMPLATES: TemplateType[] = ["minimal", "standard", "subagents", "collaboration"];
  let templateType: TemplateType = "standard";

  if (templateArg) {
    if (!(VALID_TEMPLATES as string[]).includes(templateArg)) {
      throw new Error(
        `Unknown template '${templateArg}'. Valid options: ${VALID_TEMPLATES.join(", ")}`,
      );
    }
    templateType = templateArg as TemplateType;
  }

  // -----------------------------------------------------------------------
  // 3. Collect configuration
  // -----------------------------------------------------------------------
  let config: InitConfig;
  let targetDir: string;

  if (yes) {
    const rawName = nameArg ?? deriveRoleId(basename(process.cwd()));
    const validation = validateInitRoleId(rawName);

    if (!validation.valid) {
      throw new Error(`Invalid role name '${rawName}': ${validation.error}`);
    }

    const roleName = validation.normalized;
    const roleId = validation.normalized;

    config = {
      name: roleName,
      roleId,
      description: `A ${templateType} role created with rolebox init`,
    };

    targetDir = nameArg ? join(process.cwd(), nameArg) : process.cwd();
  } else {
    const wizardResult = await runInteractiveWizard({
      name: nameArg,
      ...(templateArg ? { template: templateArg } : {}),
    });

    if (wizardResult === null) {
      return;
    }

    config = wizardResult;
    targetDir = nameArg ? join(process.cwd(), nameArg) : process.cwd();
  }

  // -----------------------------------------------------------------------
  // 4. Check target directory
  // -----------------------------------------------------------------------
  const dirState = checkTargetDir(targetDir);

  if (dirState.hasRoleYaml) {
    throw new Error(`Target directory already contains a role.yaml: ${targetDir}`);
  }

  // -----------------------------------------------------------------------
  // 5. Scaffold the role
  // -----------------------------------------------------------------------
  await scaffoldRole(targetDir, config, templateType);

  // -----------------------------------------------------------------------
  // 6. Print success
  // -----------------------------------------------------------------------
  console.log(`\u2713 Created ${templateType} role at ${targetDir}`);
  console.log(`Run \`rolebox sync opencode\` to deploy`);
}
