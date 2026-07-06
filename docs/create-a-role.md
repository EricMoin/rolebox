# Create a Role

> Part of the rolebox documentation. See [README](../README.md) for overview.

```bash
mkdir -p ~/.config/opencode/rolebox/copywriter
```

```yaml
# ~/.config/opencode/rolebox/copywriter/role.yaml
name: Copywriter
description: Writes concise, punchy copy.
prompt: |
  You are a copywriter. Short sentences. No jargon. Every word earns its place.
```

Restart opencode. The role appears in your agent list.

## Examples

### Code reviewer with custom plan function

```yaml
# rolebox/code-reviewer/role.yaml
name: Code Reviewer
description: Expert code reviewer
model: gpt-4
mode: subagent
temperature: 0.2
prompt: |
  You are an expert code reviewer. Review for correctness,
  performance, and readability. Be specific and actionable.
skills:
  - review-checklist
functions:
  - plan
permission:
  allow: [Read, Grep, Glob]
```

### Parameterized review function

```markdown
<!-- rolebox/code-reviewer/functions/review.md -->
---
name: review
description: Configurable code review
params:
  focus: correctness
  depth: normal
---

Review this code with focus on **{focus}**.

Depth level: **{depth}**
- normal: flag clear issues, suggest improvements
- deep: trace all code paths, verify edge cases, check error propagation
- surface: only obvious bugs and style issues
```

Usage: `|review:security,deep| check the new auth endpoints`
