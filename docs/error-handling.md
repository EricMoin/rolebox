# Error Handling

> Part of the rolebox documentation. See [README](../README.md) for overview.

- Invalid YAML or missing files won't crash opencode. The broken role is skipped.
- Missing skills produce a warning but don't block the role.
- Missing functions are silently skipped.
- Invalid function activation syntax (uppercase, mid-sentence pipes) is left untouched in the message.
