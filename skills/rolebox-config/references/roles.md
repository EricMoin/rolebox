# Roles

## A working role

Create `<role-root>/reviewer/role.yaml`:

```yaml
name: Reviewer
description: Reviews changes for correctness and missing verification.
model: example-provider/model-name
mode: primary
temperature: 0.2
prompt: |
  Review the requested change. Explain actionable defects with evidence.
skills:
  - review-checklist
memory:
  inject: true
  max_inject: 10
  min_relevance: medium
  scope: both
```

Create the declared skill before loading this role; see [Assets](assets.md).
The directory `reviewer` is the ID. Top-level IDs cannot contain the reserved
`--` separator. Give each role a non-empty `name`, a useful `description` and
either `prompt` or `prompt_file`. `prompt_file` is relative to the role directory;
use one prompt source to avoid ambiguity.

## Role fields

| Field | Meaning |
| --- | --- |
| `name`, `description` | Display name and discovery description |
| `prompt` / `prompt_file` | Inline instructions / path to instruction file |
| `version` | Optional role version string |
| `model` | Canonical provider/model string, alias, or inherited host default when absent |
| `mode` | `primary` (default), `subagent` or `all` |
| `color`, `variant` | Host-dependent display/model metadata |
| `temperature`, `top_p` | Model sampling settings; keep within the provider's supported ranges |
| `skills`, `opencode_skills` | Role-local and harness-global skill names |
| `functions`, `disable_functions` | Add to default functions / remove named functions |
| `auto_activate`, `locked` | Automatically activate listed functions / prevent their deactivation |
| `references` | Map of reference names to paths or `{ path, description }` |
| `permission`, `tools` | Role tool policy, subject to host enforcement |
| `memory` | Summary injection and DSH recall settings |
| `subagents` | Inline child definitions; directories also work |
| `dispatch` | Background and synchronous prompt timeouts |
| `hooks`, `copilot` | Lifecycle and continuation behavior |
| `graph` | Legacy selector only; see [Orchestration](orchestration.md) for effective graph configuration |

`open`, `exports` and `open_roles` are accepted legacy fields with no discovery
effect. All resolved top-level roles are discoverable; children stay private to
their owning role tree. Do not use those fields to publish a child.

The current YAML loader does not retain `notifications` or `extensions`, even
though programmatic role types expose them. See [Runtime features](runtime.md)
for effective notification configuration and the extension limitation.

`{env:VARIABLE_NAME}` is substituted in string values at load time, including
prompt files. Missing variables stay as placeholders. Keep credentials in the
environment or host credential store; do not print resolved secrets.

Model strings split at the first `/`: `example-provider/family/model-name`
keeps `family/model-name` as the model ID. Rolebox aliases map IDs; actual provider
registration and authentication belong to the harness.

## Tools and permissions

```yaml
permission:
  allow: [read, glob, grep]
  deny: [bash]
tools:
  bash: false
```

Replace these names with exact tools registered by the host. Host permissions,
approval handling, plugin feature gates and adapter support still apply. A YAML
entry does not create a tool or grant OS access. Codex maps supported feature denials
to native-agent settings and enforces attributed-role restrictions on rolebox MCP
calls; arbitrary native per-tool policies remain unsupported. See the mapping below.

## Subagents

Inline children can share a role's directory:

```yaml
subagents:
  - name: Researcher
    description: Finds primary evidence for the assigned question.
    prompt: |
      Research the assigned question and return sources and uncertainties.
    model: example-provider/research-model
```

For private assets, create
`<role-root>/reviewer/subagents/researcher/role.yaml` with its own `skills/`,
`functions/` and `references/`. Directory children are discovered automatically.
Inline and directory children can coexist; use distinct names.

Child IDs use the parent ID plus a slug of the child's name, separated by `--`,
for example `reviewer--researcher`. Discover the actual resolved ID before
dispatching. Children are always `subagent` mode. Recursive nesting is bounded
to three levels by default.

Child names are compared by that canonical slug: case and whitespace/hyphen
variants share one identity. Later inline definitions replace earlier ones;
inline definitions take precedence over directory definitions with the same ID.

Unset `model`, `color`, `variant`, `temperature`, `top_p`, `permission`, `tools`
and `memory` inherit from the parent. An explicit child value replaces the
parent value for that field; a partial `memory` block is not a deep merge.
Prompts, skill/function lists, `auto_activate` and `locked` do not inherit.
Default built-in functions are resolved separately for each child.

## Codex role mapping

`rolebox sync codex` exports public top-level roles as native agents. For a role ID
`reviewer`, the ordinary native name is `rolebox--reviewer`; unusual IDs use a stable
sanitized name with a digest suffix. Native files carry `name`, `description` and
`developer_instructions`, plus supported model and feature settings. Sync preserves
user edits and unmanaged collisions. Restart Codex to refresh its agent catalog.

Private children keep canonical IDs such as `reviewer--researcher` and in-memory
prompt/model/resource descriptors. They are excluded from native global discovery.
A role may target its direct children in `graph_declare`; another role or an
unattributed root conversation cannot target those children. Native `spawn_agent`
discovery alone does not publish private rolebox children. The resolver retains
deeper nested descriptors, but graph workers cannot recursively dispatch and those
deeper private descendants have no general launch path in this integration.

Bare native model IDs map directly. A `provider/model` maps only when its provider
matches the effective inherited Codex provider. Sync cannot infer that provider and
omits a qualified override with a warning, while managed graph execution reads the
parent's provider. Use a Codex alias resolving to a bare native ID when generating
native files. The adapter never overrides the provider or installs credentials.

`variant` maps to `model_reasoning_effort` for `none`, `minimal`, `low`, `medium`,
`high`, `xhigh`, `max` and `ultra`, subject to the selected model's support. Managed
workers inherit the parent's effort when no role variant is set. Other variants,
`temperature` and `top_p` are omitted with warnings.

Native files only reduce supported feature groups. A false `tools` entry or
matching `permission.deny` can disable shell (`shell_tool`, `bash`, `shell`,
`exec_command` or `write_stdin`), apps, plugins, memories (`memories` or
`memory_tool`), or permission requests (`request_permissions_tool`). These settings
cannot enable a capability disabled by the parent, widen sandbox/approval policy,
or provide arbitrary native per-tool enforcement.
Native feature denials also match trailing-star permission patterns; a matching
`permission.deny` takes precedence over an explicit `tools` grant for that alias.

For rolebox MCP calls, the host's thread identity resolves the native `agentRole`
back to its canonical role. A stale generated role is refused until sync/restart.
`permission.deny` wins; the `tools` map uses an exact name before the longest
matching trailing-star rule, and otherwise allows the tool. These restrictions
apply to rolebox's own tools, including browser/desktop tools, independently of
global registration gates. A graph worker's dedicated `graph_submit_outcome`
channel remains available; it does not grant graph control or recursive dispatch.

## Memory

```yaml
memory:
  inject: true
  max_inject: 10
  min_relevance: medium
  scope: both
  session_focus: true
  recall: true
  recall_mode: auto
```

| Setting | Default and allowed values |
| --- | --- |
| `inject` | `true`; include memory summaries in the prompt |
| `max_inject` | `10`; integer 0–100 |
| `min_relevance` | `medium`; `low`, `medium`, `high` |
| `scope` | `both`; `role`, `workspace`, `both` |
| `session_focus` | `true`; DSH session focus across compaction |
| `recall` | `true`; DSH relevant-memory search for each human prompt |
| `recall_mode` | `auto`; `auto`, `always`, `deterministic` |

`auto` adds a one-shot query scout only when workspace memory has at least 20
entries and deterministic search finds fewer than two. `always` scouts each new
human prompt; `deterministic` never scouts. Other hosts do not implement these
DSH-specific prompt blocks.

`inject: false` or `max_inject: 0` disables automatic summaries, not the memory
tools. `memory_write`, `memory_recall`, `memory_list`, `memory_read` and
`memory_update` operate within the caller's allowed workspace/role scope.
Add `functions: [memory]` for optional consolidation instructions where function
activation is supported. In DSH, request consolidation directly instead of
assuming `|memory|` activates instructions. A memory setting never grants tools
that the parent or host has denied.

Persistent entries live in the workspace's `.rolebox/memory.db`. A `workspace`
entry is shared across roles in that workspace; a `role` entry stays associated
with its role. With no active role, write workspace memories explicitly.
