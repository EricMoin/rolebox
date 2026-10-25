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

New tests mirror the `src/` module path under `tests/`. Root-level `tests/*.test.ts` hold **cross-cutting unit tests** for modules that have no dedicated directory (and integration/e2e coverage).

| `src/` path | Test path |
| --- | --- |
| `src/asset/**` | `tests/asset/` |
| `src/cli/**` | `tests/cli/` |
| `src/core/**` | `tests/core/` |
| `src/dispatch/**` | `tests/dispatch/` |
| `src/extensions/**` | `tests/extensions/` |
| `src/graph/**` | `tests/graph/` |
| `src/hashline/**` | `tests/hashline/` |
| `src/hooks/**` | `tests/hooks/` |
| `src/loop/**` | `tests/loop/` |
| `src/lsp/**` | `tests/lsp/` |
| `src/memory/**` | `tests/memory/` |
| `src/notifications/**` | `tests/notifications/` |
| `src/platform/**` | `tests/platform/` |
| `src/prompt/**` | `tests/prompt/` |
| `src/recovery/**` | `tests/recovery/` |
| `src/session/**` | `tests/session/` |
| `src/signal/**` | `tests/signal/` |
| `src/tui/**` | `tests/tui/` |
| `src/utils/**` | `tests/utils/` |
| `src/web/**` | `tests/web/` |

**Cross-cutting / no dedicated test directory** — tests live at the `tests/` root:

| `src/` path | Test path |
| --- | --- |
| `src/function/**` | `tests/function-*.test.ts`, `tests/handlers.test.ts`, `tests/conditions.test.ts`, `tests/observe.test.ts`, `tests/continuation.test.ts` |
| `src/copilot/**` | `tests/copilot-*.test.ts` |
| `src/loader/**` | `tests/role-loader*.test.ts`, `tests/open-roles.test.ts` |
| `src/resolver/**` | `tests/*-resolver.test.ts`, `tests/resolver-recursive.test.ts` |
| `src/sync/**` | `tests/agent-registry.test.ts` |
| `src/terminal/**` | `tests/interactive-terminal.test.ts` |
| `src/logger.ts` | `tests/logger.test.ts` |
| `src/entries/opencode.ts`, `src/entries/pi.ts`, `src/entries/dsh.ts` | `tests/index.test.ts`, `tests/pi-*.test.ts`, `tests/dsh-*.test.ts`, `tests/e2e.test.ts` |

Support directories (helpers, not modules): `tests/helpers/`, `tests/integration/`, `tests/monitor/`.

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

## Host package versions

Host packages — `@opencode-ai/*`, `@deepseek-ai/*`, `@earendil-works/*` — are devDependencies that track their published channel at `latest`; the `@deepseek-ai/dsh-*` packages track `next`. The policy table lives in `scripts/host-versions.ts`; `npm run check:hosts` compares each resolved version against its channel and exits 1 when one is behind. The `host-versions.yml` workflow runs that daily and fails on drift, so a host release never blocks an unrelated PR.

```sh
npm run update:hosts            # bump pins, reinstall, typecheck, vocabulary guards
npm run update:hosts --dry-run  # print the edits, touch nothing
```

Releases are manual — there is no tag-triggered publish workflow.
