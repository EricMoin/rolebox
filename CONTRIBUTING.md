# Contributing to rolebox

Thanks for your interest in rolebox! This document covers the basics.

## Issues

- Search existing issues before opening a new one.
- Include the rolebox version (`rolebox --version`) and relevant YAML/config.
- For bug reports, include steps to reproduce and expected vs actual behavior.

## Pull Requests

1. Fork the repo and create a branch from `main`.
2. Make your changes. Keep them focused — one feature or fix per PR.
3. Add or update tests where applicable.
4. Run the test suite:

   ```bash
   bun test
   ```

5. Open a PR against `main`. Describe what it does and why.

## Creating Roles

New to role authoring? See [docs/create-a-role.md](docs/create-a-role.md) for the full guide on role structure, schemas, and conventions.

## Style

- Keep YAML clean and readable — use anchors and aliases for reuse.
- Match the existing code style for TypeScript and Go helpers.
- Prefer small, focused commits over large ones.
