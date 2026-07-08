import { defineCommand } from "citty";
import * as clack from "@clack/prompts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { getSyncTarget } from "../paths.ts";
import { SyncTarget } from "../../constants.ts";
import { scanAvailableModels, scanRoleModels } from "../model-utils.ts";
import type { ModelOption, RoleModelEntry } from "../model-utils.ts";

// ── Constants ─────────────────────────────────────────────────────

const KEEP_CURRENT = "__keep__";
const CUSTOM = "__custom__";
const CONFIGURE_INDIVIDUALLY = "__individual__";
const APPLY_ALL = "__apply_all__";

// ── Helpers ───────────────────────────────────────────────────────

function modelLabel(m: ModelOption): string {
  return `${m.name} (${m.provider})`;
}

/**
 * Update the `model:` line in a YAML file using regex replacement.
 * Preserves all other content, formatting, and comments.
 * Returns true when a change was made.
 */
function updateModelInFile(filePath: string, newModel: string): boolean {
  const content = readFileSync(filePath, "utf-8");
  const updated = content.replace(/^(model\s*:).*$/m, `$1 ${newModel}`);
  if (updated === content) {
    // Model line not found — append it before the first blank line or at EOF
    const appended = content.trimEnd() + `\nmodel: ${newModel}\n`;
    writeFileSync(filePath, appended);
    return true;
  }
  writeFileSync(filePath, updated);
  return true;
}

/**
 * Build select options from available models, adding "Keep current" and
 * "Custom" options where appropriate.
 */
function buildModelOptions(
  available: ModelOption[],
  currentModel: string,
): Array<{ value: string; label: string; hint?: string }> {
  const options: Array<{ value: string; label: string; hint?: string }> = [];

  // Keep current — first option for quick skip
  if (currentModel && currentModel.trim().length > 0) {
    options.push({
      value: KEEP_CURRENT,
      label: `Keep current`,
      hint: currentModel,
    });
  }

  for (const m of available) {
    options.push({ value: m.id, label: modelLabel(m) });
  }

  options.push({
    value: CUSTOM,
    label: "Custom (enter manually)",
    hint: "Type any model identifier",
  });

  return options;
}

// ── Interactive Flow ──────────────────────────────────────────────

async function runInteractive(roleDir: string): Promise<void> {
  const available = scanAvailableModels();
  const allEntries = scanRoleModels(roleDir);

  if (allEntries.length === 0) {
    clack.log.error(
      `No role.yaml files found in ${relative(process.cwd(), roleDir)}`,
    );
    return;
  }

  // Separate primary (root role.yaml) from subagents
  const primaryPath = join(roleDir, "role.yaml");
  const primary = allEntries.find((e) => e.path === primaryPath);
  const subagents = allEntries.filter((e) => e.path !== primaryPath);

  const updated: Array<{ name: string; path: string; oldModel: string; newModel: string }> = [];

  clack.intro("rolebox config");

  // ── 1. Configure primary role ──────────────────────────────────────

  if (primary) {
    const primaryOptions = buildModelOptions(available, primary.model);
    const chosen = await clack.select({
      message: `Select model for ${primary.name}:`,
      options: primaryOptions,
    });

    if (clack.isCancel(chosen)) {
      clack.cancel("Operation cancelled.");
      return;
    }

    let newModel: string;
    if (chosen === KEEP_CURRENT) {
      newModel = primary.model;
    } else if (chosen === CUSTOM) {
      const custom = await clack.text({
        message: "Enter custom model identifier:",
        placeholder: "e.g. provider/model-name",
        validate(value) {
          if (value.trim().length === 0) return "Model identifier cannot be empty.";
        },
      });
      if (clack.isCancel(custom)) {
        clack.cancel("Operation cancelled.");
        return;
      }
      newModel = custom.trim();
    } else {
      newModel = chosen as string;
    }

    if (newModel !== primary.model) {
      updateModelInFile(primary.path, newModel);
      updated.push({
        name: primary.name,
        path: primary.path,
        oldModel: primary.model,
        newModel,
      });
    }
  }

  // ── 2. Configure subagents ────────────────────────────────────────

  if (subagents.length > 0) {
    const mode = await clack.select({
      message: "Configure subagents individually or apply one model to all?",
      options: [
        {
          value: APPLY_ALL,
          label: "Apply one model to all subagents",
          hint: `${subagents.length} subagent(s)`,
        },
        {
          value: CONFIGURE_INDIVIDUALLY,
          label: "Configure each subagent separately",
        },
      ],
    });

    if (clack.isCancel(mode)) {
      clack.cancel("Operation cancelled.");
      return;
    }

    if (mode === APPLY_ALL) {
      // Show a combined label for multi-selection context
      const subOptions = buildModelOptions(
        available,
        subagents.some((s) => s.model && s.model.trim().length > 0)
          ? subagents[0].model
          : "",
      );

      const chosen = await clack.select({
        message: `Select model for all ${subagents.length} subagent(s):`,
        options: subOptions,
      });

      if (clack.isCancel(chosen)) {
        clack.cancel("Operation cancelled.");
        return;
      }

      let newModel: string;
      if (chosen === KEEP_CURRENT) {
        newModel = subagents[0].model;
      } else if (chosen === CUSTOM) {
        const custom = await clack.text({
          message: "Enter custom model identifier for all subagents:",
          placeholder: "e.g. provider/model-name",
          validate(value) {
            if (value.trim().length === 0) return "Model identifier cannot be empty.";
          },
        });
        if (clack.isCancel(custom)) {
          clack.cancel("Operation cancelled.");
          return;
        }
        newModel = custom.trim();
      } else {
        newModel = chosen as string;
      }

      for (const sub of subagents) {
        if (newModel !== sub.model) {
          updateModelInFile(sub.path, newModel);
          updated.push({
            name: sub.name,
            path: sub.path,
            oldModel: sub.model,
            newModel,
          });
        }
      }
    } else {
      // Configure each subagent individually
      for (const sub of subagents) {
        const subOptions = buildModelOptions(available, sub.model);

        const chosen = await clack.select({
          message: `Select model for subagent "${sub.name}":`,
          options: subOptions,
        });

        if (clack.isCancel(chosen)) {
          clack.cancel("Operation cancelled.");
          return;
        }

        let newModel: string;
        if (chosen === KEEP_CURRENT) {
          newModel = sub.model;
        } else if (chosen === CUSTOM) {
          const custom = await clack.text({
            message: `Enter custom model identifier for "${sub.name}":`,
            placeholder: "e.g. provider/model-name",
            validate(value) {
              if (value.trim().length === 0) return "Model identifier cannot be empty.";
            },
          });
          if (clack.isCancel(custom)) {
            clack.cancel("Operation cancelled.");
            return;
          }
          newModel = custom.trim();
        } else {
          newModel = chosen as string;
        }

        if (newModel !== sub.model) {
          updateModelInFile(sub.path, newModel);
          updated.push({
            name: sub.name,
            path: sub.path,
            oldModel: sub.model,
            newModel,
          });
        }
      }
    }
  }

  // ── 3. Summary ────────────────────────────────────────────────────

  if (updated.length === 0) {
    clack.outro("No changes made.");
    return;
  }

  clack.log.success(`Updated ${updated.length} role.yaml file(s):`);
  for (const u of updated) {
    const relPath = relative(process.cwd(), u.path);
    clack.log.message(
      `  ${u.name}: ${u.oldModel || "(none)"} → ${u.newModel}`,
    );
  }
  clack.log.step(`Files: ${updated.length}`);
}

// ── Non-Interactive Flow ──────────────────────────────────────────

async function runNonInteractive(
  roleDir: string,
  model: string,
  primaryOnly: boolean,
): Promise<void> {
  const allEntries = scanRoleModels(roleDir);

  if (allEntries.length === 0) {
    console.error(`No role.yaml files found in ${roleDir}.`);
    process.exitCode = 1;
    return;
  }

  let targets: RoleModelEntry[];

  if (primaryOnly) {
    const primaryPath = join(roleDir, "role.yaml");
    const primary = allEntries.find((e) => e.path === primaryPath);
    if (!primary) {
      console.error(`No primary role.yaml found at ${primaryPath}.`);
      process.exitCode = 1;
      return;
    }
    targets = [primary];
  } else {
    targets = allEntries;
  }

  const updated: Array<{ name: string; path: string; oldModel: string }> = [];

  for (const entry of targets) {
    if (entry.model !== model) {
      updateModelInFile(entry.path, model);
      updated.push({ name: entry.name, path: entry.path, oldModel: entry.model });
    }
  }

  if (updated.length === 0) {
    console.log(`All role.yaml files already using model "${model}".`);
    return;
  }

  console.log(`Updated ${updated.length} role.yaml file(s) to model "${model}":`);
  for (const u of updated) {
    const relPath = relative(process.cwd(), u.path);
    console.log(`  ${u.name} (${relPath}): ${u.oldModel || "(none)"} → ${model}`);
  }
}

// ── Command Definition ────────────────────────────────────────────

export default defineCommand({
  meta: {
    name: "config",
    description: "Configure models for a role and its subagents",
  },
  args: {
    role: {
      type: "positional",
      description: "Role name to configure (must be synced)",
      required: true,
    },
    model: {
      type: "string",
      description: "Model ID to apply (non-interactive mode)",
      alias: "m",
    },
    "primary-only": {
      type: "boolean",
      description: "Only update the top-level role.yaml",
      alias: "p",
    },
  },
  async run({ args }) {
    const syncTarget = getSyncTarget(SyncTarget.Opencode);
    const roleDir = join(syncTarget, args.role);

    if (!existsSync(roleDir)) {
      console.error(
        `Role "${args.role}" not found at ${syncTarget}. Run \`rolebox sync\` first.`,
      );
      process.exitCode = 1;
      return;
    }

    if (args.model) {
      await runNonInteractive(roleDir, args.model, args["primary-only"] ?? false);
    } else {
      if (!process.stdin.isTTY) {
        console.error(
          "Interactive prompts require a TTY. Use --model for non-interactive mode.",
        );
        process.exitCode = 1;
        return;
      }
      await runInteractive(roleDir);
    }
  },
});
