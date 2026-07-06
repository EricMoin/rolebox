# References

> Part of the rolebox documentation. See [README](../README.md) for overview.

References are deep-knowledge documents that agents can read on demand for contextual information. Unlike skills (which are instruction sets), references provide raw domain knowledge — theory, specifications, guides, etc.

## Auto-discovery

Place markdown files in a `references/` directory. They are discovered automatically:

```
my-role/
├── role.yaml
└── references/
    ├── api-spec.md
    └── theory/
        └── core-principles.md
```

All `.md` files under `references/` are recursively discovered. Descriptions are extracted from YAML frontmatter (if present) or auto-generated from the filename.

## Explicit declarations

Declare references in `role.yaml` for files outside `references/` or to provide custom descriptions:

```yaml
references:
  api-spec: references/api-spec.md
  design-guide:
    path: docs/design-guide.md
    description: Internal design system documentation
```

## Skill-specific references

Skills can also have their own references:

```
skills/
└── my-skill/
    ├── SKILL.md
    └── references/
        └── domain-theory.md
```

References declared in a skill's SKILL.md frontmatter work the same way:

```markdown
---
name: my-skill
description: Does something
references:
  theory: references/domain-theory.md
---
```

## Resolution

- Role-level references are discovered from `{roleDir}/references/`
- Skill-level references are discovered from `{roleDir}/skills/{name}/references/`
- Explicit declarations override auto-discovered descriptions for the same file
- All references are surfaced to the agent in an `<available_references>` block
