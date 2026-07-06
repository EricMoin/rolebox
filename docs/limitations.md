# Limitations

> Part of the rolebox documentation. See [README](../README.md) for overview.

- No role inheritance
- No runtime role switching
- Functions persist for the entire session (no per-message deactivation yet)
- No conditional functions based on project context
- Recursive file-based subagent nesting is supported (max depth: 3). `--` is reserved as the parent/child separator.
- `--` is reserved in role IDs (used as the parent/child separator)
