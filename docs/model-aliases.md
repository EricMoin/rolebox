# Model Aliases

> Part of the rolebox documentation. See [README](../README.md) for overview.

Roles published on the [oh-my-role registry](https://github.com/EricMoin/oh-my-role) often use
placeholder model names (e.g. `PLACEHOLDER`, `YOUR_MODEL_HERE`) instead of real provider/model
identifiers. Rather than editing each role's `role.yaml` manually, define local alias mappings
once in `role_config.yaml`.

## Where the file lives

`role_config.yaml` sits in the harness's config directory
(`{configDir}/role_config.yaml`, `src/resolver/model-resolver.ts`):

| Harness | Path |
|---|---|
| opencode | `~/.config/opencode/role_config.yaml` (same directory as `opencode.jsonc`) |
| pi | `~/.pi/agent/role_config.yaml` |
| dsh | `~/.dsh/role_config.yaml` (`$DSH_HOME/role_config.yaml` when `DSH_HOME` is set) |

```yaml
model_aliases:
  PLACEHOLDER: openrouter/anthropic/claude-sonnet-4
  YOUR_MODEL_HERE: anthropic/claude-opus-4
  # key = placeholder string from role.yaml
  # value = provider/model_id for your actual model
```

## How resolution works

At role load time, each `model:` field goes through a non-destructive three-step fallback chain:

1. **Known models first** — if the value matches a model already configured in the harness's
   provider/model catalog, it passes through unchanged.
2. **Alias lookup** — if not known, rolebox checks `model_aliases` in `role_config.yaml`. When a
   match is found, the mapped value is used. This is a **single hop** — there is no recursive
   chaining (an alias value that is itself an alias key is not resolved again).
3. **Passthrough with warning** — if neither matches, the original value is preserved and a warning
   is logged. Loading never fails because of an unrecognized model.

This resolution covers both the role-level `model` field and all subagent `model` fields, including
inherited values. The resolver is `resolveModel` in `src/resolver/model-resolver.ts`; see
[role.yaml Reference](role-yaml.md) for the field it applies to.

## Error handling

- **Missing config file** — treated as an empty alias map; no error.
- **Malformed YAML** — warns and falls back to empty aliases; loading continues.
- **Invalid alias entries** (empty keys, non-string values, empty values) — skipped with a warning;
  valid entries in the same file still apply.

## Hot-reload

Edits to `role_config.yaml` take effect on the next hot-reload cycle or role bootstrap. No process
restart is required for the primary runtime. For CLI tools that bypass the bootstrap path, a restart
is needed.
