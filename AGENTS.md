# AGENTS.md

Guidance for coding agents working in this repository.

## Project overview

**rolebox** is a plugin that defines custom AI agent roles — each role gets its own prompts, models, skills, and permissions. It adds persistent memory, multi-agent dispatch, LSP integration, and engineering-team workflows, plus a TUI built on `@opentui`.

- **Language / runtime**: TypeScript (ESM, `"type": "module"`), run with **Bun**.
- **Build outputs**: `dist/` (library, TUI, dsh web client).

Key scripts (`package.json`):

| Script | Command |
| --- | --- |
| `build` | `tsc && bun run build:tui && bun run build:dsh-web-client` |
| `build:tui` | `bun run scripts/build-tui.ts` |
| `build:dsh-web-client` | `NODE_ENV=production bun run scripts/build-dsh-web-client.ts` |
| `typecheck` | `tsc --noEmit` |
| `test` | `bun run test:core && bun run test:tui` |
| `test:core` | `bun test --isolate --path-ignore-patterns=tests/tui` |
| `test:tui` | `bun test tests/tui/` |

---

## ⚠️ Testing policy — READ FIRST

> **DO NOT run the full test suite.**
> **Never run `bun test` (the full 411-file suite) during development.**

The repository has **411 `*.test.ts` files**. Running them all is slow, floods your context with unrelated output, and is **CI's job** — not a local development step. Running the whole suite locally wastes time and can mask the module you actually changed.

**Rule:** run **only the module-scoped slice(s)** for the code you touched. Design tests so they are partitioned by module; a change under `src/graph/**` should be verified with `tests/graph/`, not with the whole tree.

The full suite is reserved for:

- **CI** — `.github/workflows/ci.yml` runs the complete isolated core suite plus the non-isolated TUI suite, order-independence guards, and asserts a clean working tree after tests.
- **Explicit pre-release validation** requested by a maintainer.

### Run the right slice

```sh
# Module slice (replace <module> with a directory under tests/)
bun test --isolate tests/<module>/

# Single file (fastest inner loop)
bun test --isolate tests/<module>/<file>.test.ts

# TUI tests — NO --isolate (see reason below)
bun test tests/tui/

# Types only — no test run at all
bun run typecheck

# Full suite — CI / pre-release ONLY. Avoid locally.
bun test
```

**Why the TUI slice omits `--isolate`:** `@opentui/core` performs a top-level `await` that fails under `--isolate`. Core tests **must** use `--isolate`; TUI tests must **not**.

---

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
| `src/tui/**` | `tests/tui/` (no `--isolate`) |
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
| `src/index.ts`, `src/pi-extension.ts`, `src/dsh-plugin.ts` | `tests/index.test.ts`, `tests/pi-*.test.ts`, `tests/dsh-*.test.ts`, `tests/e2e.test.ts` |

Support directories (helpers, not modules): `tests/helpers/`, `tests/integration/`, `tests/monitor/`.

---

## Test-authoring conventions

- **Mirror the `src/` path** in `tests/` (e.g. a test for `src/graph/foo.ts` goes in `tests/graph/foo.test.ts`).
- **Name files** `<subject>.test.ts`.
- **Core tests need `--isolate`** when you run them (see policy above).
- **Keep the working tree clean** after tests — CI asserts a clean tree, so tests must not leave stray files behind.
- **Guard Unix-only tests** with `it.skipIf(!hasTar())` from `tests/helpers/tar.ts`.

---

## General conventions

- Keep changes **focused** — one concern per change.
- **No unrelated refactors**; do not rename, reformat, or "clean up" code outside your task.
- **Match existing style** in the file and module you are editing.
- Run `bun run typecheck` before declaring work done.
