# role.yaml Reference

> Part of the rolebox documentation. See [README](../README.md) for overview.

The full schema for a role's `role.yaml` file.

```yaml
# Required
name: string
description: string
prompt: |                     # Or use prompt_file (mutually exclusive)
  Your system prompt here...

# Optional
version: string               # Semantic version (e.g. "1.0.0")
model: string                 # Canonical "provider/model-id" (see Model references)
mode: primary | subagent | all  # Default: "primary"
color: string                 # UI color
variant: string               # Model variant
temperature: number           # 0.0 - 2.0
top_p: number                 # 0.0 - 1.0
prompt_file: string           # Path to external prompt file

# Skills
skills:                       # From rolebox/{role}/skills/
  - my-skill
opencode_skills:              # From the harness's global skills dir
  - humanizer

# Functions
functions:                    # Additional functions beyond built-in defaults (merge, not replace)
  - plan                       # Built-in defaults ([plan, execute, loop]) always present
  - execute                    # unless explicitly removed via disable_functions
  - my-custom-fn
disable_functions:            # Remove specific built-in functions
  - execute

# References (explicit declarations — auto-discovery needs no config)
references:
  api-spec: references/api-spec.md
  design-guide:
    path: docs/design-guide.md
    description: Custom description

# Subagents
subagents:                    # Inline child agents (see [Subagents](subagents.md))
  - name: string
    description: string
    prompt: string
    # ... same fields as role.yaml

# Dispatch configuration (override defaults for subagent dispatch)
dispatch:
  maxInputTokensPerRequest: number  # Max cumulative input tokens per request (default: unlimited / opt-in)
  maxOutputTokensPerRequest: number # Max cumulative output tokens per request (default: unlimited / opt-in)
  maxCostPerRequest: number         # Max cumulative cost (USD) per request (default: unlimited / opt-in)
  maxInputTokensPerSession: number  # Max input tokens per dispatched session (default: unlimited / opt-in)
  maxCostPerSession: number         # Max cost (USD) per dispatched session (default: unlimited / opt-in)
  budgetSampleIntervalMs: number    # Budget sampling interval in ms (default: 30000)
  backgroundStaleTimeoutMs: number  # Stale timeout for background tasks (default: 900000)
  syncPromptTimeoutMs: number       # Timeout for sync prompt (default: 600000)

# Custom Hooks (see [Custom Hooks](hooks.md))
hooks:
  builtin:                          # Enable/disable built-in hooks
    auto_activate: true
  custom:
    - name: string                  # Hook identifier
      description: string           # Human-readable description
      events: [string]              # Events: chat.message, tool.execute.before, tool.execute.after, system.transform, event
      module: string                # Path to hook module file
      config: {}                    # Arbitrary config passed to the hook
      filter:                       # Conditions to limit when the hook fires
        tools: [string]             # Only for these tool names
        eventTypes: [string]        # Only for these event subtypes
      priority: number              # Execution order (lower = earlier, default 50)
      phase: before | after         # Phase relative to built-in (default: after)

# Permissions
permission:
  allow:
    - Read
    - Grep
  deny:
    - Bash
tools:
  Bash: false
```

## Model references

`model:` is a **canonical `provider/model-id` string**. The provider is the
segment before the first slash and the model id is everything after it, so a
multi-segment model id survives intact:

```yaml
model: openrouter/anthropic/claude-sonnet-4
model: openrouter-anthropic/anthropic/claude-opus-4.8
#     └── provider ──┘ └──────── model id ─────────┘
```

At load time the value is run through the model resolver
(`src/resolver/model-resolver.ts`): a value already present in the harness's
model catalog passes through, a configured
[`model_aliases`](model-aliases.md) entry maps to its
canonical target (single hop), and anything unrecognized passes through
unchanged with a log hint. Bare names therefore work only through that
alias/passthrough path — prefer the explicit `provider/model-id` form.

*From `src/resolver/model-resolver.ts` — `resolveModel`'s priority order (known model → alias → passthrough):*

```ts
  // Priority 1: known model (already canonical) → passthrough
  if (knownModelIds.has(model)) {
    return model;
  }

  // Priority 2: alias mapping → single-hop resolution
  const aliased = modelAliases.get(model);
  if (aliased !== undefined) {
    return aliased;
  }

  // Priority 3: unrecognized → info + passthrough original
  log.info(
    `Model "${model}" is not a known model and has no alias configured. ` +
      `Passing through as-is. You can add an alias in role_config.yaml under the "model_aliases" key. ` +
      `Example: model_aliases:\n  "${model}": provider/model_id`,
  );
  return model;
```

How the split is consumed per platform:
- **opencode** writes the string verbatim as the agent's `model:` field
  (`src/platform/adapters/opencode/agent-registrar.ts`).
- **pi** splits on the first slash and resolves the pair against pi's model
  registry (`src/platform/adapters/pi/role-switcher.ts`,
  `src/pi-extension.ts`).
- **dsh** splits on the first slash into `agentOptions.provider` +
  `agentOptions.model` at spawn
  (`src/platform/adapters/dsh/agent-registrar.ts`; see the
  [dsh plugin contract](dsh-plugin-contract.md) §4.2).

*From `src/platform/adapters/opencode/agent-registrar.ts` — `serializeAgentFile` writes the agent's `model:` field verbatim:*

```ts
function serializeAgentFile(agent: AgentDefinition): string {
  const lines = [
    ROLEBOX_AGENT_MARKER,
    "---",
    `name: ${agent.name}`,
    `description: ${agent.description}`,
  ];
  if (agent.mode) lines.push(`mode: ${agent.mode}`);
  if (agent.model) lines.push(`model: ${agent.model}`);
  lines.push("---", "", agent.systemPrompt);
  return lines.join("\n");
}
```

*From `src/platform/adapters/pi/role-switcher.ts` — `applyModel` splits on the first slash via `splitModel` and resolves against pi's model registry:*

```ts
  /** Attempt to switch the active model to the role's model. */
  async function applyModel(ctx: any, role: AgentDefinition): Promise<void> {
    const parsed = splitModel(role.model);
    if (!parsed) return;
    try {
      const model = ctx?.modelRegistry?.find?.(parsed.provider, parsed.id);
      if (model && typeof pi.setModel === "function") {
        const ok = await pi.setModel(model);
        if (!ok) {
          log.debug("setModel returned false", { role: role.id, model: role.model });
        }
```

*From `src/platform/adapters/dsh/agent-registrar.ts` — `mergeAgentOptions`, the actual first-slash split into `agentOptions.provider` + `agentOptions.model`:*

```ts
  const ref = splitModel(definition.model);
  if (!ref) return { ...(base ?? {}), model: definition.model };
  if (providerRoutes && !isRouteRegistered(providerRoutes, ref.provider)) {
    log.warn(
      `DshAgentRegistrar: provider route '${ref.provider}' for agent ` +
        `'${definition.id}' (model '${definition.model}') has no registered dsh ` +
        `llm adapter; degrading to model-only '${ref.id}' so the spawn inherits ` +
        `the runtime default provider instead of failing with NO_ADAPTER.`,
    );
    return { ...(base ?? {}), model: ref.id };
  }
  return { ...(base ?? {}), provider: ref.provider, model: ref.id };
```

## Environment variable interpolation

Use `{env:VARIABLE_NAME}` anywhere in role.yaml. Resolved at startup.

```yaml
model: "{env:PREFERRED_MODEL}"
prompt: |
  You work for {env:COMPANY_NAME}...
```

*From `src/resolver/env-resolver.ts` — `resolveEnvVars` substitutes `{env:VARIABLE_NAME}` and preserves unresolved placeholders:*

```ts
/**
 * Replace `{env:VARIABLE_NAME}` placeholders with actual environment values.
 *
 * @param value - The string potentially containing env var placeholders.
 * @returns The resolved string with environment variables substituted.
 *          Unresolvable placeholders are left as-is.
 */
export function resolveEnvVars(value: string): string {
  return value.replace(ENV_VAR_PATTERN, (match, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      log.info(`Environment variable "${varName}" is not set; keeping placeholder "${match}". Set it with: export ${varName}=value`);
      return match;
    }
    return envValue;
  });
}
```
