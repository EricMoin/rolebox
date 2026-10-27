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

## Loading references

Main agents and sub-agents use `load_reference({ name: "api-spec" })` to load a
reference by its exact listed name. The tool returns its full content and
resolved path, including references listed by `load_role_skill`. Use
`reference_search` to search for passages instead.

Visibility matches `load_role_skill`: callers can load resources in their owning
role tree, including nested sub-agents. Other roles' private resources are
excluded from lookups and available-name lists. For duplicate names, deeper
sub-agent resources take precedence over ancestor resources; role references
take precedence over skill references at the same level. Relative file links
resolve against the loaded reference's directory.

## Resolution

- Role-level references are discovered from `{roleDir}/references/`
- Skill-level references are discovered from `{roleDir}/skills/{name}/references/`
- Explicit declarations override auto-discovered descriptions for the same file
- All references are surfaced to the agent in the `## Available references` section — one bullet per reference carrying its name and description. When every reference of the role sits under one directory (so each name locates its own file), that directory is stated once as a `Base directory:` line; otherwise each bullet also carries its own readable path
