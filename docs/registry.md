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

## Sources

Rolebox reads roles from one or more **sources**. The built-in source —
[oh-my-role](https://github.com/EricMoin/oh-my-role) — is always available, and custom
sources are added on top of it, so search and install span all of them instead of
replacing the built-in one:

```bash
rolebox registry list                       # Every effective source
rolebox registry add https://github.com/your-org/your-registry
rolebox registry default your-registry      # Resolve unprefixed roles here first
rolebox registry remove your-registry
```

Each source is a registry repository, and each may pin the branch or tag its
`registry.yaml` and role tarballs are read from:

```yaml
registries:
  - name: oh-my-role
    url: https://github.com/EricMoin/oh-my-role
    default: true
  - name: your-registry
    url: https://github.com/your-org/your-registry
    ref: v2
```

A source without `ref` is read from `main`. The same repository can be added twice
under different names to expose two branches, and every source is cached separately
(the cache is keyed by source name, URL and resolved branch).

### Resolution order

`rolebox install <role>` resolves an unprefixed role in this order:

1. the **default** source: the first entry flagged `default: true`, or the built-in
   source when no entry claims it;
2. then the remaining sources in config order.

The first source that publishes the role wins: the version, the tarball and the lock
entry all come from it. A source that cannot be fetched is skipped with a `Warning:`
line rather than failing the lookup, even when a later source answers. When no source
publishes the role, the error names the sources that were searched and any that could
not be reached; when none of them could be reached at all, it says that instead of
reporting the role as absent. When several sources publish the same role,
`rolebox search` notes the alternatives and a `source:role` spec (for example
`rolebox install your-registry:role-a`) selects one explicitly.

`rolebox update <role>` does not resolve through this order: it walks the copies
recorded in the lock file and updates each one from the source it was installed from,
so a bare role updates every copy — each success line names its source — and a
`source:role` spec narrows the update to that copy.

Setting `registries: []` in `config.yaml` opts out of every source, the built-in one
included.

## Default Registry

The default registry is [oh-my-role](https://github.com/EricMoin/oh-my-role), which
provides a curated set of roles. It is the built-in source: always available, and the
default one unless a custom source claims `default: true`:

- `emperor` — Top-level orchestrator with planner/executor/validator architecture
- `software-architect` — System design and architecture
- `react-frontend` — React/Next.js frontend development
- `ai-designer` — AI application design
- `tauri` — Desktop app development with Tauri
- `dart-flutter` — Cross-platform mobile and desktop with Flutter
