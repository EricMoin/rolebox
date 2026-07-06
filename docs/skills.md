# Skills

> Part of the rolebox documentation. See [README](../README.md) for overview.

Skills are on-demand knowledge modules the agent loads via the `skill` tool when needed. Unlike functions (which are always-on once activated), skills are pulled in contextually.

```markdown
---
name: review-checklist
description: Comprehensive code review checklist
---

When reviewing code, check:
- Error handling completeness
- Input validation
- ...
```

## Resolution order

1. `{roleDir}/skills/{name}/SKILL.md` (role-local, directory)
2. `{roleDir}/skills/{name}.md` (role-local, single file)
3. `~/.config/opencode/skills/{name}/SKILL.md` (global, directory)
4. `~/.config/opencode/skills/{name}.md` (global, single file)

## Skill vs Function

| | Skill | Function |
|---|---|---|
| Activation | Agent decides via `skill` tool | User activates with `\|name\|` syntax |
| Lifetime | Single use per invocation | Persists for the session |
| Purpose | Reference knowledge | Behavior modification |
| Injection | On-demand into context | Always in system prompt while active |
