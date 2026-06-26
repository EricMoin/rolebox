import { defineCommand } from "citty";
import { basename } from "node:path";
import { join } from "node:path";
import { checkTargetDir, deriveRoleId, validateInitRoleId } from "./init-utils.ts";
import { scaffoldRole } from "./init-scaffold.ts";
import { runInteractiveWizard } from "./init-prompts.ts";
import type { InitConfig, TemplateType } from "../templates/index.ts";

const VALID_TEMPLATES: TemplateType[] = ["minimal", "standard", "subagents", "collaboration"];

export async function init(nameArg: string | undefined, yes: boolean, templateArg: string | undefined): Promise<void> {
  // -----------------------------------------------------------------------
  // 1. Validate template type
  // -----------------------------------------------------------------------
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

export default defineCommand({
  meta: {
    name: "init",
    description: "Scaffold a new role interactively",
  },
  args: {
    name: {
      type: "positional",
      description: "Role name",
    },
    yes: {
      type: "boolean",
      alias: ["y"],
      description: "Skip prompts, use sensible defaults",
    },
    template: {
      type: "enum",
      alias: ["t"],
      description: "Template type",
      options: VALID_TEMPLATES,
    },
  },
  async run({ args }) {
    await init(args.name, args.yes ?? false, args.template);
  },
});
