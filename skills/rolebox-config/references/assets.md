# Assets and functions

## Skills

```text
<role-dir>/
  role.yaml
  skills/review-checklist/
    SKILL.md
    references/review-standard.md
```

`SKILL.md`:

```markdown
---
name: review-checklist
description: Review changes for correctness and regression risks.
---

Read the requested diff and its callers. Report defects with concrete evidence.
Read [the review standard](references/review-standard.md) when judging findings.
```

List `review-checklist` under `skills` in the owning role. A single
`skills/review-checklist.md` file also works. Lookup tries the role's directory
skill, role's single-file skill, harness-global directory skill, then global
single-file skill. The historical key `opencode_skills` declares global skills
for the active harness, including Pi, DSH and Codex.

Skills supply instructions on demand. For role skills, use
`load_role_skill({ name: "review-checklist" })` when available; it returns content
and reference metadata. Resource visibility includes the owning role and its own
nested children, with deeper children taking precedence on name collisions.
Other roles' private workflow bodies are not available. Native host catalogs can
have broader workspace scope, so do not infer private access from a catalog name.

`rolebox-config` is a packaged global skill independent of any role. Its name
does not use the `rolebox--` prefix reserved for generated role skill entries.
It can be discovered by the host's ordinary skill mechanism; a role can also
declare `opencode_skills: [rolebox-config]` to resolve it as a role resource.

## References

Markdown files anywhere beneath `<role-dir>/references/` or a skill's
`references/` directory are discovered recursively. Use these for specifications
and background knowledge rather than executable workflow instructions.

For a custom name, external location or description, declare:

```yaml
references:
  api-spec: references/api-spec.md
  review-standard:
    path: docs/review-standard.md
    description: Acceptance criteria for this role's reviews.
```

The same `references` map can appear in skill frontmatter. Paths resolve from
the declaring role/skill directory. `load_reference({ name: "api-spec" })` loads
the whole document; `reference_search` searches passages. Use names returned by
discovery instead of guessing nested IDs. Read files directly when the loader
is unavailable. Reference-relative links resolve beside the reference.

## Functions

Functions are persistent session behavior modules. Defaults are `plan`,
`execute` and `loop`. `functions` adds names to these defaults with deduplication;
`disable_functions` removes names from the merged result.

```yaml
functions: [review]
disable_functions: [execute]
auto_activate: [review]
locked: false
```

Search order is `<role-dir>/functions/<name>.md`,
`<harness-home>/functions/<name>.md`, then the package's built-in functions.
Do not edit package files to override a built-in; create a local function with
the same name.

`functions/review.md`:

```markdown
---
name: review
description: Review a change with a configurable focus.
params:
  focus: correctness
  depth: normal
---

Review the requested change for {focus}, using {depth} depth.
Explain actionable findings and the evidence supporting each one.
```

In hosts that support function activation:

```text
|review| inspect this change
|review:security,deep| inspect the authentication change
|review focus=security depth=deep| inspect the authentication change
|plan|execute| implement the agreed change
```

Positional values follow parameter declaration order; omitted values use their
defaults. Active functions persist for the session. `auto_activate` activates
the listed functions without a user prefix; `locked: true` prevents deactivation
by the user or transitions. Do not set it unless that behavior is wanted.

### Function state-machine metadata

| Frontmatter | Meaning |
| --- | --- |
| `phase`, `priority` | Workflow phase and prompt ordering priority |
| `requires` | Other function dependencies |
| `produces`, `consumes` | Named artifact produced/consumed by the function |
| `gate` | Condition checked for gate-based transitions |
| `continue_until`, `continue_max` | Completion condition and bounded continuation cap |
| `requires_evidence` | Evidence tags tracked by observations |
| `observe` | Reactions to `tool_after`, `message` or `activate` |
| `transitions` | Conditions plus `activate` / `deactivate` function lists |
| `state_schema_version`, `handlers` | State version and custom handler module |

For example, a function that tracks a successful verification tool:

```yaml
name: verify-change
description: Track verification before completing a change.
phase: execute
priority: 30
requires_evidence: [verification]
continue_until: evidence_met
continue_max: 3
observe:
  - on: tool_after
    tool: example_check
    when_output:
      contains: PASS
    set_evidence: verification
transitions:
  - when: evidence_met
    deactivate: [verify-change]
```

Replace `example_check` with an available tool whose output actually establishes
the intended result. Observation filters use case-sensitive `contains` and
`not_contains`; argument filters use `when_args.match` and `when_args.not_match`
maps. Observers can `inject` instructions, `capture_artifact` from a named fenced
assistant block, `capture_payload_as` from a tool's `payload`, or `sync_todos`
from `todowrite`.

Conditions are strings or nested `{ all: [...] }`, `{ any: [...] }`, `{ not: ... }`
objects. Built-ins include `artifact_exists(name)`, `plan_todos_complete`,
`evidence_met`, `tool_observed(name)`, `signal_observed(type)`, `turn_count(n)`,
`state_eq(key=value)` and `plan_incomplete(name)`. The historical `user_approval`
condition only checks whether the user messaged this turn; it does not establish
approval authority for an external action or a graph outcome. These function
conditions are separate from graph-v3 acceptance and operator policies.

`plan` instructs investigation and planning; `execute` instructs implementation
and verification. `loop` dispatches a fixed number of rounds to isolated child
workers, for example `|loop:3,inherit| perform the assigned review`. Its origin
session orchestrates; a user message cancels a running loop. `fresh` omits prior
round context while `inherit` passes the previous summary.

DSH's function listing does not itself activate `|name|` instructions. Codex MCP
does not install rolebox's prompt-transform hooks in Codex. Use an explicit task
or loaded skill on hosts where persistent function activation is unavailable.

## Diagnose missing resources

Use `asset_search`, `asset_inspect` and `asset_validate` where registered. Check
the active role tree, exact declared names, file existence and YAML frontmatter.
Adding a file alone does not add an undeclared skill to the role's skill list.
References beneath `references/` do auto-discover. A missing resource should be
fixed in its owning role, rather than copying another role's private assets into
the global directory.
