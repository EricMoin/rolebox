import { defineCommand } from "citty";
import * as clack from "@clack/prompts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { getSyncTarget } from "../paths.ts";
import { samePath } from "../../utils/paths.ts";
import { SyncTarget, SYNC_TARGET_VALUES } from "../../constants.ts";
import { scanModelsForTarget } from "../../platform/model-catalog/index.ts";
import { scanRoleModels } from "../role-models.ts";
import { assertInteractiveContext, pickSyncedRole, pickTarget } from "../pick.ts";
import type { PromptApi } from "../pick.ts";
import type { ModelOption } from "../../platform/model-catalog/index.ts";
import type { RoleModelEntry } from "../role-models.ts";

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

/**
 * Split a role's scanned `role.yaml` entries into its primary (the root
 * `{roleDir}/role.yaml`) and its subagents (every other entry).
 *
 * Matching is separator-insensitive via {@link samePath}: fast-glob returns
 * forward-slash absolute paths while `join` builds native-separator paths, so a
 * strict `===` comparison could misclassify the primary as a subagent on win32.
 * When no entry matches the root, `primary` is undefined and every entry is
 * returned as a subagent.
 */
export function partitionRoleEntries(
  entries: RoleModelEntry[],
  roleDir: string,
): { primary?: RoleModelEntry; subagents: RoleModelEntry[] } {
  const primary = entries.find((e) => samePath(e.path, join(roleDir, "role.yaml")));
  const subagents = entries.filter((e) => e !== primary);
  return { primary, subagents };
}

/**
 * The clack surface the interactive flow needs: the shared {@link PromptApi}
 * plus `text` and the full `log` namespace. Defaults to the real module; tests
 * inject a scripted fake (same seam as {@link configInteractive}).
 */
export type ConfigPrompts = Omit<PromptApi, "log"> & {
  text: typeof clack.text;
  log: typeof clack.log;
};

// ── Interactive Flow ──────────────────────────────────────────────

/**
 * Interactive model configuration for one role.
 *
 * `projectDir` selects the directory whose project-level opencode documents
 * contribute models; it is a parameter (not an ambient `process.cwd()` read at
 * the call sites below) so a test can exercise a project config without
 * `process.chdir()`, which is process-global and unsafe under Bun's parallel
 * test files.
 */
export async function runInteractive(
  roleDir: string,
  target: string,
  prompts: ConfigPrompts = clack,
  projectDir: string = process.cwd(),
): Promise<void> {
  const available = scanModelsForTarget(target, { projectDir });
  const allEntries = scanRoleModels(roleDir);

  if (allEntries.length === 0) {
    prompts.log.error(
      `No role.yaml files found in ${relative(process.cwd(), roleDir)}`,
    );
    return;
  }

  // Separate primary (root role.yaml) from subagents
  const { primary, subagents } = partitionRoleEntries(allEntries, roleDir);

  const updated: Array<{ name: string; path: string; oldModel: string; newModel: string }> = [];

  prompts.intro("rolebox config");

  // ── 1. Configure primary role ──────────────────────────────────────

  if (primary) {
    const primaryOptions = buildModelOptions(available, primary.model);
    const chosen = await prompts.select({
      message: `Select model for ${primary.name}:`,
      options: primaryOptions,
    });

    if (prompts.isCancel(chosen)) {
      prompts.cancel("Operation cancelled.");
      return;
    }

    let newModel: string;
    if (chosen === KEEP_CURRENT) {
      newModel = primary.model;
    } else if (chosen === CUSTOM) {
      const custom = await prompts.text({
        message: "Enter custom model identifier:",
        placeholder: "e.g. provider/model-name",
        validate(value) {
          if (value.trim().length === 0) return "Model identifier cannot be empty.";
        },
      });
      if (prompts.isCancel(custom)) {
        prompts.cancel("Operation cancelled.");
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
    const mode = await prompts.select({
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

    if (prompts.isCancel(mode)) {
      prompts.cancel("Operation cancelled.");
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

      const chosen = await prompts.select({
        message: `Select model for all ${subagents.length} subagent(s):`,
        options: subOptions,
      });

      if (prompts.isCancel(chosen)) {
        prompts.cancel("Operation cancelled.");
        return;
      }

      let newModel: string;
      if (chosen === KEEP_CURRENT) {
        newModel = subagents[0].model;
      } else if (chosen === CUSTOM) {
        const custom = await prompts.text({
          message: "Enter custom model identifier for all subagents:",
          placeholder: "e.g. provider/model-name",
          validate(value) {
            if (value.trim().length === 0) return "Model identifier cannot be empty.";
          },
        });
        if (prompts.isCancel(custom)) {
          prompts.cancel("Operation cancelled.");
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

        const chosen = await prompts.select({
          message: `Select model for subagent "${sub.name}":`,
          options: subOptions,
        });

        if (prompts.isCancel(chosen)) {
          prompts.cancel("Operation cancelled.");
          return;
        }

        let newModel: string;
        if (chosen === KEEP_CURRENT) {
          newModel = sub.model;
        } else if (chosen === CUSTOM) {
          const custom = await prompts.text({
            message: `Enter custom model identifier for "${sub.name}":`,
            placeholder: "e.g. provider/model-name",
            validate(value) {
              if (value.trim().length === 0) return "Model identifier cannot be empty.";
            },
          });
          if (prompts.isCancel(custom)) {
            prompts.cancel("Operation cancelled.");
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
    prompts.outro("No changes made.");
    return;
  }

  prompts.log.success(`Updated ${updated.length} role.yaml file(s):`);
  for (const u of updated) {
    const relPath = relative(process.cwd(), u.path);
    prompts.log.message(
      `  ${u.name}: ${u.oldModel || "(none)"} → ${u.newModel}`,
    );
  }
  prompts.log.step(`Files: ${updated.length}`);
}

/**
 * Interactive flow for `rolebox config` without a role: pick a synced role
 * and return its name, or undefined when the user cancels. `prompts` is
 * injectable for tests.
 */
export async function configInteractive(
  prompts: PromptApi = clack,
  hint: string = "Pass the role explicitly, e.g. `rolebox config <role>`.",
  target: string = SYNC_TARGET_VALUES[0],
): Promise<string | undefined> {
  assertInteractiveContext("config", hint);
  const picked = await pickSyncedRole(target, "Select a role to configure:", prompts);
  return picked ?? undefined;
}

/**
 * Resolve which sync target `rolebox config` should operate on.
 *
 * Behavior (registry-driven — the picker derives its choices from
 * `PLATFORM_REGISTRY`, with no per-platform branches):
 *   - An explicit `--target`/`-t` always wins and never prompts.
 *   - Interactive mode (no `--model`) with `--target` omitted prompts for a
 *     target. When the role is already known, targets where it is synced are
 *     surfaced first — falling back to every valid target when none have it —
 *     so the user is not led to a target where `config` would immediately
 *     fail with "no roles synced".
 *   - Non-interactive mode (`--model` given) with `--target` omitted keeps the
 *     historical opencode default and never blocks on a prompt.
 *
 * Returns the target id, or undefined when the user cancels the menu.
 */
export async function resolveConfigTarget(opts: {
  explicitTarget?: string;
  role?: string;
  interactive: boolean;
  prompts?: PromptApi;
}): Promise<string | undefined> {
  const { explicitTarget, role, interactive, prompts = clack } = opts;

  if (explicitTarget) return explicitTarget;
  if (!interactive) return SyncTarget.Opencode;

  assertInteractiveContext(
    "config",
    "Pass --target explicitly, or use --model for non-interactive mode.",
  );
  const picked = await pickTarget(role, "Select a sync target:", prompts);
  return picked ?? undefined;
}

// ── Non-Interactive Flow ──────────────────────────────────────────

export async function runNonInteractive(
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
    const { primary } = partitionRoleEntries(allEntries, roleDir);
    if (!primary) {
      console.error(`No primary role.yaml found at ${join(roleDir, "role.yaml")}.`);
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
      description: "Role name to configure (must be synced). Omit for interactive selection",
      required: false,
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
    target: {
      type: "string",
      description: "Sync target: opencode, pi, or dsh (default: opencode)",
      alias: "t",
    },
  },
  async run({ args }) {
    let role: string | undefined = args.role;

    // Explicit --target wins; otherwise prompt only in the interactive path.
    // `--model` marks the non-interactive path, where an omitted target keeps
    // the opencode default and must not block on a prompt.
    const target = await resolveConfigTarget({
      explicitTarget: args.target,
      role,
      interactive: !args.model,
      prompts: clack,
    });
    if (!target) return;

    if (!role) {
      const hint = args.model
        ? `Pass the role explicitly, e.g. \`rolebox config <role> --model ${args.model}\`.`
        : "Pass the role explicitly, e.g. `rolebox config <role>`.";
      role = await configInteractive(clack, hint, target);
      if (!role) return;
    }

    const syncTarget = getSyncTarget(target);
    const roleDir = join(syncTarget, role);

    if (!existsSync(roleDir)) {
      // Sweep every supported target (opencode / pi / dsh) so a role synced to
      // a different target gets an actionable cross-target hint instead of a
      // bare "run sync first" dead end.
      const syncedElsewhere: SyncTarget[] = [];
      for (const candidate of SYNC_TARGET_VALUES) {
        if (candidate === target) continue;
        try {
          if (existsSync(join(getSyncTarget(candidate), role))) {
            syncedElsewhere.push(candidate);
          }
        } catch {
          // Best-effort — a broken target path must not mask the not-found error
        }
      }

      const base = `Role '${role}' not found in target '${target}' at ${syncTarget}.`;
      const hint =
        syncedElsewhere.length > 0
          ? ` It is synced to: ${syncedElsewhere.join(", ")}. Retry with \`rolebox config ${role} --target ${syncedElsewhere[0]}\`.`
          : " Run `rolebox sync` first.";
      console.error(base + hint);
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
      await runInteractive(roleDir, target);
    }
  },
});
