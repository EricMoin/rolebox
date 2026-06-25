import * as clack from '@clack/prompts';
import type { InitConfig, TemplateType } from '../templates/index.js';
import { validateInitRoleId } from './init-utils.js';

/**
 * Interactive wizard for `rolebox init` — collects role configuration via
 * a series of @clack/prompts steps.
 *
 * @param defaults - Pre-populated values (e.g. from CLI flags).
 * @returns A complete InitConfig, or `null` if the user cancelled.
 */
export async function runInteractiveWizard(
  defaults: Partial<InitConfig>,
): Promise<InitConfig | null> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'Interactive prompts require a TTY. Use --yes for non-interactive mode.',
    );
  }

  clack.intro('rolebox init');

  const template = await clack.select({
    message: 'Select a template:',
    options: [
      {
        value: 'standard' as TemplateType,
        label: 'Standard Role',
        hint: 'YAML + prompt file + skills & functions dirs',
      },
      {
        value: 'minimal' as TemplateType,
        label: 'Minimal Role',
        hint: 'Just YAML config + prompt file',
      },
      {
        value: 'subagents' as TemplateType,
        label: 'Role with Subagents',
        hint: 'Parent role + child sub-agents',
      },
      {
        value: 'collaboration' as TemplateType,
        label: 'Collaboration Role',
        hint: 'Multi-agent with collaboration topology',
      },
    ],
    initialValue: 'standard',
  });

  if (clack.isCancel(template)) {
    clack.cancel('Operation cancelled.');
    return null;
  }

  const name = await clack.text({
    message: 'Role name (e.g. "Code Reviewer"):',
    placeholder: 'My Role',
    defaultValue: defaults.name,
    validate(value) {
      if (value.trim().length === 0) {
        return 'Role name must not be empty.';
      }
      const result = validateInitRoleId(value);
      if (!result.valid) return result.error;
    },
  });

  if (clack.isCancel(name)) {
    clack.cancel('Operation cancelled.');
    return null;
  }

  const roleId = defaults.roleId ?? validateInitRoleId(name).normalized;

  const description = await clack.text({
    message: 'Short description:',
    placeholder: 'What does this role do?',
    defaultValue: defaults.description,
  });

  if (clack.isCancel(description)) {
    clack.cancel('Operation cancelled.');
    return null;
  }

  const MODEL_OPTIONS: { value: string; label: string; hint?: string }[] = [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4', label: 'GPT-4' },
    { value: 'claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
    { value: 'claude-3-sonnet', label: 'Claude 3 Sonnet' },
    { value: 'claude-opus', label: 'Claude Opus' },
    { value: 'gemini-pro', label: 'Gemini Pro' },
    { value: 'deepseek', label: 'DeepSeek' },
    { value: '__custom__', label: 'Custom...', hint: 'Enter any model name' },
  ];

  const modelChoice = await clack.select({
    message: 'Select default model:',
    options: MODEL_OPTIONS,
    initialValue: defaults.model ?? 'gpt-4o',
  });

  if (clack.isCancel(modelChoice)) {
    clack.cancel('Operation cancelled.');
    return null;
  }

  let model: string | undefined;

  if (modelChoice === '__custom__') {
    const customModel = await clack.text({
      message: 'Enter custom model name:',
      placeholder: 'e.g. llama-3-70b',
    });

    if (clack.isCancel(customModel)) {
      clack.cancel('Operation cancelled.');
      return null;
    }
    model = customModel.trim() || undefined;
  } else {
    model = modelChoice;
  }

  let subagentNames: string[] | undefined;

  if (template === 'subagents' || template === 'collaboration') {
    const countStr = await clack.text({
      message: 'Number of subagents:',
      placeholder: '2',
      defaultValue: String(defaults.subagentNames?.length ?? 2),
      validate(value) {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          return 'Must be a positive integer (e.g. 2).';
        }
        if (n > 10) return 'Maximum 10 subagents.';
      },
    });

    if (clack.isCancel(countStr)) {
      clack.cancel('Operation cancelled.');
      return null;
    }

    const count = Number(countStr);
    subagentNames = [];

    for (let i = 0; i < count; i++) {
      const subName = await clack.text({
        message: `Subagent ${i + 1} name (e.g. "Researcher"):`,
        placeholder: `Subagent ${i + 1}`,
        defaultValue: defaults.subagentNames?.[i],
        validate(value) {
          if (value.trim().length === 0) {
            return 'Name must not be empty.';
          }
          if (value.length > 50) return 'Name too long (max 50 characters).';
        },
      });

      if (clack.isCancel(subName)) {
        clack.cancel('Operation cancelled.');
        return null;
      }
      subagentNames.push(subName.trim());
    }
  }

  let topology: string | undefined;

  if (template === 'collaboration') {
    const topoChoice = await clack.select({
      message: 'Select collaboration topology:',
      options: [
        { value: 'pipeline', label: 'Pipeline', hint: 'A → B → C (sequential)' },
        { value: 'review-loop', label: 'Review Loop', hint: 'A ↔ B (revision cycles)' },
        { value: 'star', label: 'Star', hint: 'Parallel fan-out' },
      ],
      initialValue: (defaults.topology as string) ?? 'pipeline',
    });

    if (clack.isCancel(topoChoice)) {
      clack.cancel('Operation cancelled.');
      return null;
    }
    topology = topoChoice;
  }

  const previewLines = [
    `Template:     ${template}`,
    `Name:         ${name}`,
    `Role ID:      ${roleId}`,
    `Description:  ${description}`,
    model ? `Model:        ${model}` : null,
    subagentNames?.length
      ? `Subagents:    ${subagentNames.join(', ')}`
      : null,
    topology ? `Topology:     ${topology}` : null,
  ].filter(Boolean) as string[];

  clack.note(previewLines.join('\n'), 'Configuration Preview');

  const confirmed = await clack.confirm({
    message: 'Create this role?',
  });

  if (clack.isCancel(confirmed) || !confirmed) {
    clack.cancel('Operation cancelled.');
    return null;
  }

  clack.outro('Scaffolding role...');

  const config: InitConfig = {
    name,
    roleId,
    description,
  };

  if (model) config.model = model;
  if (subagentNames?.length) config.subagentNames = subagentNames;
  if (topology) config.topology = topology;

  return config;
}
