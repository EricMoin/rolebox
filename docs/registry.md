# Creating a Registry

> Part of the rolebox documentation. See [README](../README.md) for overview.

A registry is a repository — GitHub, GitLab, or a plain HTTP file server — with a
specific structure:

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
(the cache is keyed by source name, URL and resolved branch). See
[Source kinds](#source-kinds) below for GitLab and plain HTTP sources.

### Source kinds

Every source is one of three kinds — `github`, `gitlab`, or `http` — detected
from its URL alone. There is no `kind:` setting: a URL either identifies its
backend, or `rolebox registry add` refuses it with a hint naming the forms that
work. Nothing is probed over the network and no backend is guessed.

| URL | Kind | Why |
| --- | --- | --- |
| `https://github.com/owner/repo` | `github` | `github.com`, exactly `owner/repo` (+ optional `.git`) |
| `https://gitlab.com/group/sub/repo` | `gitlab` | gitlab.com; nested groups keep their subgroups |
| `https://gitlab.example.com/group/repo` | `gitlab` | gitlab-family host (`gitlab.*`, `*.gitlab.com`, `gitlab-*`, anything containing `gitlab`) |
| `https://code.example.com/group/repo/-/tree/main` | `gitlab` | the path contains a `/-/` segment; the route is normalized away |
| `https://roles.example.com/acme/registry.yaml` | `http` | the path names a `.yaml`/`.yml` file — the URL *is* the manifest |
| `https://code.example.com/owner/repo` | — | refused: the host identifies no backend |
| `https://github.com/o/r/blob/main/registry.yaml` | — | refused: a GitHub project URL is exactly `owner/repo` |

A refused URL reports, for example:

```
unrecognized source URL "https://roles.example.com/acme": expected a GitHub or GitLab project URL, or a registry.yaml URL (for example https://host/path/registry.yaml)
```

To host a source on a host that is not GitHub or GitLab-like — a self-hosted
GitLab served statically, or a plain HTTP file server — point at its
`registry.yaml` directly; that URL identifies the `http` kind. A self-hosted
GitLab served over its own API works through its host name (`gitlab.*`) or a
pasted `/-/` route.

| Kind | Manifest | Role archive |
| --- | --- | --- |
| `github` | `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/registry.yaml` | `https://api.github.com/repos/<owner>/<repo>/tarball/<ref>` |
| `gitlab` | `<project>/-/raw/<ref>/registry.yaml` | `<project>/-/archive/<ref>/<repo>-<ref>.tar.gz` |
| `http` | the source URL itself (it must end in `.yaml`/`.yml`) | `archive:` from the manifest, else `<base>/roles/<roleId>@<version>.tar.gz` |

`<project>` is the project URL (`https://gitlab.com/group/sub/repo`), and a
GitLab `<ref>` is URL-encoded as ONE path component — `feature/x` becomes
`feature%2Fx`. GitHub requests carry `Authorization: token $GITHUB_TOKEN` when
that variable is set; GitLab requests carry `PRIVATE-TOKEN: $GITLAB_TOKEN` when
`GITLAB_TOKEN` is set (required for private projects); plain HTTP sources send
no credentials at all.

#### The generic HTTP layout

Any static file server can host a source — no hosting API is involved:

```
https://roles.example.com/acme/          # the base
├── registry.yaml                        # manifest: name, description, url, roles
└── roles/
    ├── role-a@1.0.0.tar.gz              # <roleId>@<version>.tar.gz
    └── role-a.tar.gz                    # versionless fallback, used only on a 404
```

The source URL is the manifest itself — its directory is the base:

```bash
rolebox registry add https://roles.example.com/acme/registry.yaml
```

Each archive is a plain `tar.gz` whose contents ARE the role files — `role.yaml`
at the archive root, plus `skills/`, `functions/`, … Publish one with
`tar czf roles/role-a@1.0.0.tar.gz -C path/to/role-a .`. One leading path
component is stripped during extraction, so a wrapper directory or a
`roles/<roleId>/` tree inside the archive works too. A single archive may carry
several sibling role directories (`roles/<otherRoleId>/…`).

A manifest entry can name its own archive instead. The value is remote data, so
it may only stay on the manifest's **own origin**: a relative path resolves
against the manifest URL, an absolute URL is accepted when its origin matches, and
anything else — another host, a protocol-relative `//host/…`, a loopback or
link-local address, a non-http scheme — is refused before any request is made.

```yaml
roles:
  role-a:
    version: "1.0.0"
    description: Role A
    tags: [example]
    archive: dist/role-a.tar.gz                              # → <manifest dir>/dist/role-a.tar.gz
    # archive: https://roles.example.com/dist/role-a.tar.gz  # absolute, same origin
```

A source URL may still point anywhere you like, including a local or private
host — that is your own deliberate choice; the origin constraint exists only for
a location a *manifest* chose.

`archive:` is honored by `http` sources (git sources have a hosting API of their
own). Without it, the versioned `roles/<roleId>@<version>.tar.gz` is requested
first, and the versionless `roles/<roleId>.tar.gz` is requested only when the
versioned URL answers 404 — the version recorded in the lock file always comes
from the manifest. The versionless archive carries no version of its own, so
rolebox only requests it when it already has a version (from the role spec or the
manifest).

#### What a source is trusted with

A source is chosen by you, but everything it *returns* is treated as untrusted:

- **Credentials stay on the origin you configured.** `Authorization` (GitHub) and
  `PRIVATE-TOKEN` (GitLab) are attached per request and dropped on the first
  redirect that leaves that origin; redirects are followed by hand so a custom
  header is not carried along by the runtime.
- **Bounds on the response.** The manifest is capped at 8 MiB, an archive at
  64 MiB, the extracted tree at 256 MiB, and the manifest fetch has a 30-second
  timeout, so a stalled or oversized source fails with a named limit instead of
  hanging or exhausting memory.
- **Bounds on the manifest itself.** At most 10,000 roles, and a role id under a
  prototype key (`__proto__`, `constructor`, `prototype`) is refused.
- **Containment on extraction.** Entries that resolve outside the extract
  directory — `..` traversal, absolute names, escaping symlinks, hardlinks whose
  partner lies outside the tree — are refused, and the role directory actually
  delivered must be a real directory inside the tree.
- **Text is escaped where it is printed.** A version or description carrying
  control characters is rendered as `\xNN` instead of being emitted to the
  terminal, and a password embedded in a source URL is shown as `***@`.
- **A role id is a path segment.** Ids and versions must be free of separators,
  `..`, control characters and Windows-reserved names before they become a
  directory name.

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
