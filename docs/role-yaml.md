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
model: string                 # e.g. "gpt-4", "claude-3-sonnet"
mode: primary | subagent | all  # Default: "primary"
color: string                 # UI color
variant: string               # Model variant
temperature: number           # 0.0 - 2.0
top_p: number                 # 0.0 - 1.0
prompt_file: string           # Path to external prompt file

# Skills
skills:                       # From rolebox/{role}/skills/
  - my-skill
opencode_skills:              # From ~/.config/opencode/skills/
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

# Collaboration Graph (see [Collaboration Graph](collaboration-graph.md))
collaboration:
  topology: pipeline | review-loop | star  # Built-in topology
  agents: [agent-a, agent-b]               # Agent slugs (lowercase name)
  flow:                                     # Custom edges (string or object)
    - "from -> to: label"
    - { from: a, to: b, label: x, exit: true }
  max_iterations: number                   # Loop limit (default: 3 for cycles)
  termination:                             # Loop termination conditions
    any_of:                                # Stop when ANY condition fires
      - { max_iterations: 5 }
      - { timeout_ms: 120000 }
      - { converged: "description" }
      - { result_matches: { agent: name, contains: "text" } }
      - { stuck: { repeats: 2 } }
    all_of:                                # Stop when ALL conditions are met
      - { max_iterations: 2 }
      - { result_matches: { agent: name, contains: "APPROVED" } }

# Dispatch configuration (override defaults for subagent dispatch)
dispatch:
  maxConcurrent: number             # Max concurrent background tasks (default: 5)
  maxQueueDepth: number             # Max queued tasks (default: 10)
  syncReservedSlots: number         # Slots reserved for sync dispatch (default: 1)
  maxActivePerParent: number        # Max active tasks per parent session (default: 3)
  maxTotalSessionsPerRequest: number # Max cumulative sessions per user request (default: unlimited / opt-in)
  maxInputTokensPerRequest: number  # Max cumulative input tokens per request (default: unlimited / opt-in)
  maxOutputTokensPerRequest: number # Max cumulative output tokens per request (default: unlimited / opt-in)
  maxCostPerRequest: number         # Max cumulative cost (USD) per request (default: unlimited / opt-in)
  maxInputTokensPerSession: number  # Max input tokens per dispatched session (default: unlimited / opt-in)
  maxCostPerSession: number         # Max cost (USD) per dispatched session (default: unlimited / opt-in)
  budgetSampleIntervalMs: number    # Budget sampling interval in ms (default: 30000)
  backgroundStaleTimeoutMs: number  # Stale timeout for background tasks (default: 900000)
  syncAcquireTimeoutMs: number      # Timeout to acquire sync slot (default: 120000)
  syncPromptTimeoutMs: number       # Timeout for sync prompt (default: 600000)
  retryAfterMs: number              # Delay before retry after failure (default: 30000)
  backpressureMaxRetries: number    # Max backpressure retries (default: 5)
  backpressureMaxDelayMs: number    # Max backpressure delay (default: 60000)

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

## Environment variable interpolation

Use `{env:VARIABLE_NAME}` anywhere in role.yaml. Resolved at startup.

```yaml
model: "{env:PREFERRED_MODEL}"
prompt: |
  You work for {env:COMPANY_NAME}...
```
