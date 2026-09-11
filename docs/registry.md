# Creating a Registry

> Part of the rolebox documentation. See [README](../README.md) for overview.

A registry is a GitHub repository with a specific structure:

```
registry-repo/
├── registry.yaml
└── roles/
    ├── role-a/
    │   ├── role.yaml
    │   └── skills/
    └── role-b/
        ├── role.yaml
        └── skills/
```

The `registry.yaml` file must follow this format:

```yaml
name: my-registry
description: Description of the registry
url: https://github.com/user/my-registry
roles:
  role-a:
    version: "1.0.0"
    description: Role description
    tags: [tag1, tag2]
  role-b:
    version: "1.1.0"
    description: Another role
    tags: [tag3]
```

To publish your own registry:
1. Create a GitHub repository with the structure above
2. Add roles as subdirectories under `roles/`
3. Version management: use git tags on the repository (e.g., `v1.0.0`)
4. Users can add it: `rolebox registry add https://github.com/your-org/your-registry`

## Default Registry

The default registry is [oh-my-role](https://github.com/EricMoin/oh-my-role), which provides a curated set of roles:

- `emperor` — Top-level orchestrator with planner/executor/validator architecture
- `software-architect` — System design and architecture
- `react-frontend` — React/Next.js frontend development
- `ai-designer` — AI application design
- `tauri` — Desktop app development with Tauri
- `dart-flutter` — Cross-platform mobile and desktop with Flutter
