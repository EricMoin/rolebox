/**
 * File-generation core engine for `rolebox init`.
 *
 * Produces role.yaml and PROMPT.md (plus subagent scaffolding) for all 4
 * built-in template types. Uses js-yaml `dump()` for all YAML generation —
 * never hand-written YAML strings.
 *
 * @module
 */

import { dump } from "js-yaml";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { templates, type InitConfig, type TemplateType } from "../templates/index.js";
import { DEFAULT_FUNCTIONS, GraphTemplate } from "../../constants.js";

// ---------------------------------------------------------------------------
// YAML helpers
// ---------------------------------------------------------------------------

/** Shared js-yaml dump options to avoid automatic line wrapping. */
const YAML_OPTS = {
  lineWidth: -1,
  noRefs: true,
  sortKeys: false,
} as const;

// ---------------------------------------------------------------------------
// getReadmeContentFromTemplate
// ---------------------------------------------------------------------------

/** Extract a template's static README content, or undefined when it doesn't exist or is dynamic. */
function getReadmeContentFromTemplate(
  templateType: TemplateType,
  relPath: string,
): string | undefined {
  const template = templates[templateType];
  const file = template?.files.find((f) => f.relativePath === relPath);
  return file && typeof file.content === "string"
    ? (file.content as string)
    : undefined;
}

// ---------------------------------------------------------------------------
// generateRoleYaml
// ---------------------------------------------------------------------------

/**
 * Build a role.yaml object per template type, then serialise it with js-yaml.
 *
 * | Template      | Includes                                           |
 * |---------------|----------------------------------------------------|
 * | minimal       | name, description, prompt_file                     |
 * | standard      | + skills: [], functions: [plan, execute]           |
 * | subagents     | standard + subagents array (inline)                |
 * | collaboration | subagents + collaboration block                    |
 */
export function generateRoleYaml(
  config: InitConfig,
  templateType: TemplateType,
): string {
  const base = {
    name: config.name,
    description: config.description,
    prompt_file: "PROMPT.md" satisfies string,
  };

  // model and temperature are optional extras
  const extras: Record<string, unknown> = {};
  if (config.model) extras.model = config.model;
  if (config.temperature !== undefined) extras.temperature = config.temperature;

  switch (templateType) {
    // ── minimal ──────────────────────────────────────────────────────────
    case "minimal":
      return dump({ ...base, ...extras }, YAML_OPTS);

    // ── standard ─────────────────────────────────────────────────────────
    case "standard":
      return dump(
        {
          ...base,
          ...extras,
          skills: [] as string[],
          functions: [...DEFAULT_FUNCTIONS],
        },
        YAML_OPTS,
      );

    // ── subagents ────────────────────────────────────────────────────────
    case "subagents": {
      const names = config.subagentNames ?? [];
      const subagents = names.map((s) => ({
        name: s,
        description: `Sub-agent: ${s}`,
        prompt_file: "PROMPT.md" satisfies string,
      }));
      return dump(
        {
          ...base,
          ...extras,
          skills: [] as string[],
          functions: [...DEFAULT_FUNCTIONS],
          subagents,
        },
        YAML_OPTS,
      );
    }

    // ── collaboration ────────────────────────────────────────────────────
    case "collaboration": {
      const names = config.subagentNames ?? [];
      const subagents = names.map((s) => ({
        name: s,
        description: `Sub-agent: ${s}`,
        prompt_file: "PROMPT.md" satisfies string,
      }));
      const agents = names.map((s) => s.toLowerCase().replace(/\s+/g, "-"));
      return dump(
        {
          ...base,
          ...extras,
          skills: [] as string[],
          functions: [...DEFAULT_FUNCTIONS],
          subagents,
          collaboration: {
            topology: config.topology ?? GraphTemplate.Pipeline,
            agents,
            max_iterations: 3,
          },
        },
        YAML_OPTS,
      );
    }

    default: {
      // Exhaustiveness check — should never happen at runtime
      const _exhaustive: never = templateType;
      throw new Error(`Unknown template type: ${_exhaustive}`);
    }
  }
}

// ---------------------------------------------------------------------------
// generatePromptFile
// ---------------------------------------------------------------------------

/**
 * Build the content of PROMPT.md for a given template type.
 *
 * The content is meaningful (not a bare "PLACEHOLDER") and varies by template:
 *
 * - **minimal** — generic TODO skeleton
 * - **standard** — structured skeleton with role positioning and behaviour
 *   constraints
 * - **subagents** — team-coordination prompt skeleton
 * - **collaboration** — collaborative-workflow prompt skeleton
 */
export function generatePromptFile(
  config: InitConfig,
  templateType: TemplateType,
): string {
  const name = config.name;
  const desc = config.description;

  switch (templateType) {
    // ── minimal ──────────────────────────────────────────────────────────
    case "minimal":
      return [
        `# ${name}`,
        "",
        `TODO: Write your system prompt here.`,
        "",
        desc,
        "",
      ].join("\n");

    // ── standard ─────────────────────────────────────────────────────────
    case "standard":
      return [
        `# ${name}`,
        "",
        `You are ${desc}.`,
        "",
        "## Instructions",
        "",
        "TODO: Define your role behaviour, constraints, and output format.",
        "",
        "## Code of Conduct",
        "",
        "- Be precise and actionable.",
        "- Verify assumptions before acting.",
        "- Communicate clearly and concisely.",
        "",
      ].join("\n");

    // ── subagents ────────────────────────────────────────────────────────
    case "subagents": {
      const subagentList =
        (config.subagentNames ?? []).length > 0
          ? config.subagentNames!
              .map((s) => `  - ${s}`)
              .join("\n")
          : "  - TODO: add sub-agent names";
      return [
        `# ${name}`,
        "",
        `You coordinate a team of sub-agents to accomplish complex tasks.`,
        "",
        `Your role: ${desc}`,
        "",
        "## Team",
        "",
        subagentList,
        "",
        "## Coordination",
        "",
        "TODO: Define how you delegate work and integrate results.",
        "",
        "- Use `task()` to dispatch work to sub-agents.",
        "- Collect and reconcile outputs before responding.",
        "- Escalate only when the team is blocked.",
        "",
      ].join("\n");
    }

    // ── collaboration ────────────────────────────────────────────────────
    case "collaboration": {
      const topology = config.topology ?? GraphTemplate.Pipeline;
      return [
        `# ${name}`,
        "",
        `You lead a collaborative workflow using a **${topology}** topology.`,
        "",
        `Your role: ${desc}`,
        "",
        "## Workflow",
        "",
        "TODO: Describe the hand-off sequence between agents.",
        "",
        `The collaboration graph (topology: ${topology}) routes work`,
        "automatically. Follow the graph state shown in each turn.",
        "",
        "## Guidelines",
        "",
        "- Dispatch work according to the collaboration graph.",
        "- Respect `max_iterations` — don't loop indefinitely.",
        "- Summarise final output when the workflow completes.",
        "",
      ].join("\n");
    }

    default: {
      const _exhaustive: never = templateType;
      throw new Error(`Unknown template type: ${_exhaustive}`);
    }
  }
}

// ---------------------------------------------------------------------------
// scaffoldRole
// ---------------------------------------------------------------------------

/**
 * Collect all template files in memory, then write them atomically to
 * `targetDir`.  Creates any missing parent directories.
 *
 * For `subagents` and `collaboration` templates a `subagents/{name}/`
 * directory is created for each sub-agent, each containing its own
 * `role.yaml` and `PROMPT.md`.
 */
export async function scaffoldRole(
  targetDir: string,
  config: InitConfig,
  templateType: TemplateType,
): Promise<void> {
  // Phase 1 — collect all files in memory
  const files = new Map<string, string>();

  // Main role.yaml
  files.set("role.yaml", generateRoleYaml(config, templateType));

  // Main PROMPT.md
  files.set("PROMPT.md", generatePromptFile(config, templateType));

  // Extra directories for non-minimal templates — use rich content from templates
  if (templateType !== "minimal") {
    const skillsReadme = getReadmeContentFromTemplate(
      templateType,
      "skills/README.md",
    );
    const functionsReadme = getReadmeContentFromTemplate(
      templateType,
      "functions/README.md",
    );
    files.set(
      "skills/README.md",
      skillsReadme ??
        "<!-- Add skill files (.md) or directories (with SKILL.md) here. -->\n",
    );
    files.set(
      "functions/README.md",
      functionsReadme ??
        "<!-- Add function .md files here. -->\n",
    );
  }

  // Sub-agent scaffolding for subagents and collaboration templates
  const needsSubagents =
    templateType === "subagents" || templateType === "collaboration";
  if (needsSubagents) {
    // Extra READMEs only present in subagents/collaboration templates
    const subagentsReadme = getReadmeContentFromTemplate(
      templateType,
      "subagents/README.md",
    );
    const referencesReadme = getReadmeContentFromTemplate(
      templateType,
      "references/README.md",
    );
    if (subagentsReadme) files.set("subagents/README.md", subagentsReadme);
    if (referencesReadme) files.set("references/README.md", referencesReadme);

    const names = config.subagentNames ?? [];
    for (const name of names) {
      const dir = `subagents/${name}`;
      files.set(
        join(dir, "role.yaml"),
        dump(
          {
            name,
            description: `Sub-agent: ${name}`,
            prompt_file: "PROMPT.md" satisfies string,
          },
          YAML_OPTS,
        ),
      );
      files.set(
        join(dir, "PROMPT.md"),
        [
          `# ${name}`,
          "",
          `You are a sub-agent of **${config.name}**.`,
          "",
          `Role: Sub-agent — ${name}`,
          "",
          "TODO: Write your specialised system prompt here.",
          "",
          "## Behaviour",
          "",
          "- Focus on your assigned domain.",
          "- Report results clearly to the orchestrator.",
          "- Ask for clarification when the task is ambiguous.",
          "",
        ].join("\n"),
      );
    }
  }

  // Phase 2 — write atomically (ensure parent dirs exist first)
  for (const [relPath, content] of files) {
    const fullPath = join(targetDir, relPath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
  }
}
