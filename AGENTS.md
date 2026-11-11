# AGENTS.md

Guidance for coding agents working in this repository.

## Project overview

**rolebox** is a plugin that defines custom AI agent roles — each role gets its own prompts, models, skills, and permissions. It adds persistent memory, multi-agent dispatch, LSP integration, and engineering-team workflows, plus a TUI built on `@opentui`.

- **Language / runtime**: TypeScript (ESM, `"type": "module"`), run with **Node.js 26.4+**.
- **Package manager**: npm; install with `npm ci` using `package-lock.json`.
- **Build outputs**: `dist/` (library, TUI, dsh web client).

Key scripts (`package.json`):

| Script | Command |
| --- | --- |
| `build` | `node --import tsx scripts/build-all.ts` |
| `build:entry-aliases` | `node --import tsx scripts/build-entry-aliases.ts` |
| `build:tui` | `node --import tsx scripts/build-tui.ts` |
| `build:dsh-web-client` | `node --import tsx scripts/build-dsh-web-client.ts` |
| `typecheck` | `tsc --noEmit && tsc -p tsconfig.scripts.json && tsc -p tsconfig.tui-tests.json` |
| `test` | `node --experimental-ffi --import tsx scripts/test.ts` |
| `test:core` | `npm test -- --exclude=tests/tui/**` |
| `test:tui` | `npm test -- tests/tui/` |

---

## ⚠️ Privacy & leakage hygiene — applies to EVERY agent, every turn

Anything you write can become public: git history, commit messages, changelogs and release notes, workflow files, published package contents, and CI logs. Before emitting any output that leaves the session, verify it does not expose:

- **Private vendors / infrastructure** — internal hostnames or service names, provider or account keys, model codenames, or any identifier that is not already public.
- **Secrets and credentials** — tokens, API keys, passwords, private keys, `.npmrc` / environment values, CI secrets.
- **Personal / committer-identifying data** — usernames, home-directory paths, email addresses, machine-specific paths.

Rules:

- Use neutral placeholders in examples (`example-provider/model-name`, `/path/to/project`, `user@example.com`). Never paste real values.
- Do NOT announce, describe, or reference a cleanup or removal of such data in commit messages, changelogs, release notes, or docs — keep them generic.
- Before publishing, scan the artifact that actually leaves (for example `npm pack` output). Keep any blocklist or scan patterns out of version control.
- Never print, echo, log, or commit secret values. If a value may have been exposed, flag it for rotation.
- When in doubt, leave it out.

## Testing policy

Do not run the full test suite during local development. Run only the module slices affected by the change. The complete suite and randomized order guards belong to CI or explicit pre-release validation.

```sh
npm test -- tests/<module>/
npm test -- tests/<module>/<subject>.test.ts
npm run test:tui
npm run typecheck
npm run typecheck:tests
npm run test:browse:e2e
npm run test:package
```

Vitest runs on Node with isolated fork workers. TUI tests use the same isolation and require the Node FFI flag supplied by the test command. Do not disable isolation to work around module mocks.

## Module → test path mapping

Tests mirror their owning source module. Keep root-level tests only for root-level
source files, such as `src/logger.ts` and `src/project-config.ts`. Put tests that
span host adapters or complete plugin lifecycles under `tests/integration/`.
See [Repository structure](docs/project-structure.md) for the full layout.

| Source path | Test path |
| --- | --- |
| `src/<module>/**` | `tests/<module>/**` |
| `src/platform/adapters/<host>/<area>/**` | `tests/platform/adapters/<host>/<area>/**` |
| `src/platform/ports/**`, `system/**`, `model-catalog/**`, `worker-tools/**` | Matching directories under `tests/platform/` |
| `src/entries/<host>.ts` | `tests/entries/<host>/` |
| `src/function/**` | `tests/function/` |
| `src/copilot/**` | `tests/copilot/` |
| `src/loader/**` | `tests/loader/` |
| `src/resolver/**` | `tests/resolver/` |
| `src/sync/**` | `tests/sync/` |
| `src/terminal/**` | `tests/terminal/` |
| `scripts/**` | `tests/scripts/` |
| Cross-module and cross-host acceptance | `tests/integration/` |

Within an adapter, keep shared entry/facade tests at the adapter root and
feature-specific tests beside the matching source area. Do not recreate flat
`dsh-*`, `pi-*` or `function-*` collections at the `tests/` or `tests/platform/`
root. Shared test helpers belong in `tests/helpers/`; feature fixtures stay with
their owning tests.

---

## Test-authoring conventions

- **Mirror the `src/` path** in `tests/` (e.g. a test for `src/graph/foo.ts` goes in `tests/graph/foo.test.ts`).
- **Name files** `<subject>.test.ts`.
- **Preserve Vitest process isolation** when running tests.
- **Keep the working tree clean** after tests — CI asserts a clean tree, so tests must not leave stray files behind.
- **Guard Unix-only tests** with `it.skipIf(!hasTar())` from `tests/helpers/tar.ts`.

---

## General conventions

- Keep changes **focused** — one concern per change.
- **No unrelated refactors**; do not rename, reformat, or "clean up" code outside your task.
- **Match existing style** in the file and module you are editing.
- Run `npm run typecheck` before declaring work done.

---

## Built-in configuration skill maintenance

[`skills/rolebox-config/SKILL.md`](skills/rolebox-config/SKILL.md) and its
`references/` are the configuration guide shipped to agents with the package.
Keep them current **in the same change** whenever a feature is added, changed,
deprecated or removed and affects how an agent configures or uses rolebox.
Updating README or `docs/` alone does not satisfy this requirement.

Before editing a user-facing feature, read the relevant skill reference. Before
declaring the change complete, compare its final behavior with the guide and
update the affected instructions, examples and limitations:

| Changed surface | Skill reference |
| --- | --- |
| Harness integration, installation/sync, config paths, environment variables, model aliases, project defaults or automatic role activation | `references/configuration.md` |
| Role fields, model selection, permissions, inheritance, subagents or memory | `references/roles.md` |
| Skills, references, functions, activation or function state machines | `references/assets.md` |
| Dispatch, graphs, budgets, worker tools or role teams | `references/orchestration.md` |
| Hooks, recovery, Copilot, notifications, extensions, browser/desktop gates or LSP | `references/runtime.md` |

- Document effective runtime behavior: supported fields, values, defaults,
  precedence, scope, activation/reload steps and differences between harnesses.
  Parser acceptance or a declared type alone does not establish feature support.
- When implementing a previously unsupported capability, replace the skill's
  obsolete limitation; when changing or removing behavior, revise old examples
  and describe the supported replacement where one exists.
- Keep the guide self-contained inside `skills/rolebox-config/`. Link additional
  packaged references from `SKILL.md` when adding a configuration topic; agents
  must not need a source checkout or files omitted from the npm package.
- Edit the repository skill source, not copies installed in a harness home.
  Validate changed YAML/JSON examples and local reference links. Changes to skill
  packaging or synchronization also require the affected sync tests and
  `npm run build && npm run test:package`.
- In the completion report, identify the skill documentation updated, or explain
  why the change has no effect on agent-facing configuration or usage. Do not
  leave known contradictions for a later documentation pass.

---

## Host package versions

Host packages — `@opencode-ai/*`, `@deepseek-ai/*`, `@earendil-works/*` — are devDependencies that track their published channel at `latest`; the `@deepseek-ai/dsh-*` packages track `next`. The policy table lives in `scripts/host-versions.ts`; `npm run check:hosts` compares each resolved version against its channel and exits 1 when one is behind. The `host-versions.yml` workflow runs that daily and fails on drift, so a host release never blocks an unrelated PR.

```sh
npm run update:hosts            # bump pins, reinstall, typecheck, vocabulary guards
npm run update:hosts --dry-run  # print the edits, touch nothing
```

Releases are manual — there is no tag-triggered publish workflow.
