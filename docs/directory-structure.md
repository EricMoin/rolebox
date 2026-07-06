# Directory Structure

> Part of the rolebox documentation. See [README](../README.md) for overview.

```
~/.config/opencode/
├── opencode.jsonc
├── rolebox/
│   ├── copywriter/
│   │   └── role.yaml
│   ├── code-reviewer/
│   │   ├── role.yaml
│   │   ├── skills/
│   │   │   └── review-checklist.md
│   │   ├── functions/
│   │   │   └── plan.md          # Role-local override of built-in plan
│   │   └── references/          # Deep-knowledge documents
│   │       └── style-guide.md
│   ├── team-lead/
│   │   ├── role.yaml            # Parent role (can have inline subagents)
│   │   ├── references/
│   │   │   └── architecture.md
│   │   └── subagents/           # File-based subagents
│   │       └── researcher/
│   │           ├── role.yaml
│   │           └── skills/
│   │               └── research-checklist/
│   │                   ├── SKILL.md
│   │                   └── references/
│   │                       └── methodology.md
│   └── ...
├── functions/                    # Global user-defined functions
│   └── my-custom-fn.md
└── skills/                       # Global opencode skills
```
