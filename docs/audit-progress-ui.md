# Audit: CLI Progress/Output During Role Download

**Status:** Pure audit — no source files modified. One new doc only.
**Scope:** Goal B — confirm the "frozen" download root cause, inventory reusable primitives, map the missing flag/env surface, and sketch the fix.
**Baseline:** `bun run typecheck` exits **0**.

---

## 1. Root cause: confirmed "frozen" download behavior

The reported symptom — the terminal appears to hang with zero output during `rolebox install` / `rolebox update` — is **confirmed** by reading the actual code. There is no incremental progress output anywhere in the download path; the user sees only a start line and then silence until the process completes.

### 1a. Command handlers emit only start/end lines

`src/cli/commands/install.ts` emits exactly two `console.log` calls, both **after** the download+extract+move+hash pipeline has fully completed:

- `install.ts:101` — `const extractedDir = await downloadRole(...)` runs the whole download (no output inside).
- `install.ts:127` — `console.log(\`✓ Installed ${parsed.roleId}@${version} from ${registryName}\`)` — printed only on success.
- `install.ts:130` — `console.log(\`Run \`rolebox sync opencode\` to deploy\`)` — the follow-up hint.

There is **no** "resolving", "downloading", or "extracting" line emitted before/around the work. Before `downloadRole` returns, the user sees nothing (aside from the already-installed short-circuit at `install.ts:88`).

`src/cli/commands/update.ts` emits per-role start/end lines but **no download-time progress**:

- `update.ts:73` — `const extractedDir = await downloadRole(...)` — again silent.
- `update.ts:92` — `console.log(\`✓ Updated ${entry.role} from ${entry.version} to ${latestVersion}\`)` — printed only after the full pipeline completes.
- Warnings on failure at `update.ts:47`, `update.ts:55`, `update.ts:61`, `update.ts:95`.

So a single large role tarball over a slow link produces: one initial message (if any) and then a long silent gap — perceived as frozen.

### 1b. `downloadRole` is a single silent `fetch → arrayBuffer → writeFileSync → tar`

`src/cli/registry-client.ts`, `downloadRole` (lines 155–241) performs the download as one uninterruptible, non-streamed, non-instrumented sequence:

- `registry-client.ts:182` — `response = await fetch(url, { headers, redirect: "follow" })` — the tarball fetch resolves only when the **entire** body is buffered (no stream consumption).
- `registry-client.ts:197` — `const buffer = Buffer.from(await response.arrayBuffer())` — the body is fully materialized into memory; **zero incremental reads**, so no byte-progress can be observed.
- `registry-client.ts:198` — `writeFileSync(archivePath, buffer)` — synchronous disk write of the whole buffer.
- `registry-client.ts:205-208` — `runSpawnSync("tar", ["--version"], { stdio: "ignore" })` — tar availability probe (silent).
- `registry-client.ts:212-218` — `runSpawn("tar", ["xzf", archivePath, "--strip-components=1", "-C", extractDir], { stdio: "inherit" })` — extraction streams directly to the user's **stdout/stderr** (because of `stdio: "inherit"`), which can actually emit tar's own verbose output in some tar variants — but with no `-v` flag tar is silent by default. So extraction is also silent in practice.

**Conclusion:** The download is one silent `fetch` + `arrayBuffer()` with zero incremental output, followed by a silent `tar` extraction, followed by the end success line. This confirms the "frozen" report exactly. No refinement needed.

### 1c. Contributing factor worth noting

`stdio: "inherit"` on the tar child (`registry-client.ts:214`) means tar's stderr (if any) is passed straight to the terminal. This is fine today (tar is silent without `-v`), but it is an awkward seam for progress capture: once a progress renderer is added, extraction progress should either be delegated to the renderer or the child should be given `stdio: "pipe"` and its output relayed through the phase renderer.

---

## 2. Inventory of reusable in-repo primitives

**No new dependency is required.** A `ReadableStream` body reader plus the existing `format.ts` / `display-helpers.ts` primitives are sufficient. All ANSI color + bar + glyph needs are already covered in-repo, and `@clack/prompts` is already a dependency (though its interactive `spinner`/`progress` API is TTY-gated — see note below).

### 2a. `src/cli/format.ts` — ANSI + bar primitives

- `format.ts:13-28` — ANSI color/wrap helpers: `bold`, `dim`, `red`, `green`, `yellow`, `cyan`, `magenta`, `white`, `gray`, `soft`, `border`, `sub`, `bright`.
- `format.ts:32-51` — status symbols and phase glyphs: `SYM_OK`, `SYM_FAIL`, `SYM_WARN`, `SYM_ARROW`, `SYM_BULLET`, plus phase icons `SYM_DISPATCH` (`▶`), `SYM_AWAIT` (`◷`), `SYM_SUMMARIZE` (`◆`), `SYM_COMPLETE` (`✓`), `SYM_ERROR` (`✗`), `SYM_CANCELLED` (`⊘`).
- `format.ts:55-69` — `stripAnsi`, `padEnd`, `padRight` for alignment that survives ANSI codes.
- `format.ts:78-82` — **`bar(current, total, width=10)`** — draws `■■■□□□□□□□`-style determinate bars. Directly reusable for the download byte-progress.

### 2b. `src/utils/display-helpers.ts` — shared pure helpers

- `display-helpers.ts:15-22` — `formatDuration(ms)` — human-readable duration (for elapsed-time and ETA display).
- `display-helpers.ts:28-33` — `compactDuration(ms)` — single-unit compact duration.
- `display-helpers.ts:40-43` — `truncate(s, maxLen)` — ellipsis truncation for long asset names.
- `display-helpers.ts:67-71` — **`barSegments(current, total, width=6)`** — returns `{ filled, empty }`, the numeric segment model behind a bar (composable with `format.ts` colors).
- `display-helpers.ts:79-88` — **`statusGlyph(status)`** — canonical glyph per status (`running ▸`, `completed ✓`, `error ✗`, `pending ●`, `cancelled ⊘`, `timeout ⏱`). Reusable for phase status.

### 2c. `@clack/prompts` — already a dependency

Confirmed in `package.json:63` (`"@clack/prompts": "^0.9.0"`) and used in:

- `src/cli/commands/init/init-prompts.ts:1` — `import * as clack from '@clack/prompts'`
- `src/cli/commands/config.ts:2` — `import * as clack from "@clack/prompts"`
- `src/cli/commands/checkpoint/checkpoint-clean.ts:12` — `import * as clack from "@clack/prompts"`

**Note:** `@clack/prompts`'s `spinner()` and `progress()` are interactive/TTY-oriented and their rendering is controlled by the library. For a CLI progress bar that must also degrade to plain lines in non-TTY/CI/piped output, the lightweight in-repo primitives (`format.ts` `bar()` + ANSI helpers + `display-helpers.ts`) are the better building blocks than reaching into clack's TTY renderer. Clack stays the choice for *interactive prompts* (init/config), not for download progress.

### 2d. New-dependency verdict

**Expected answer holds: NO new dependency.** The plan is:

1. Stream the response body with `response.body.getReader()` (Web `ReadableStream`, available in Bun and Node 18+ — no polyfill needed).
2. Accumulate bytes and render with `format.ts` `bar()`/ANSI helpers and `display-helpers.ts` `formatDuration()`/`barSegments()`/`statusGlyph()`.

If a team member still prefers a progress library (e.g. `cli-progress`), that would be a **new** runtime dependency and must be justified + Windows-terminal-verified. Not recommended — the existing primitives cover the surface.

---

## 3. Missing flag / env surface

Currently **none** of the standard degradation/verbosity controls exist on `install` / `update`.

### 3a. Missing flags

- **No `--quiet` / `-q`** on either command — there is no way to suppress progress output. `install.ts:133-148` and `update.ts:108-128` declare only positional `role` (and `--no-cache` on update).
- **No `--verbose` / `-v`** — no way to request additional detail.
- **No `--no-progress`** — no way to disable the animated/bar rendering specifically (a common escape hatch in CI and scripts).

### 3b. Missing env/terminal degradation

- **`NO_COLOR`** — not honored anywhere in the download path. (Per the `no-color.org` convention, presence = disable color.)
- **`TERM=dumb`** — not checked.
- **`CI`** — not checked in `install.ts` / `update.ts` (only in `postinstall.ts:34`).
- **`process.stdout.isTTY`** — not consulted in `install.ts` / `update.ts`.

Without these, a piped or CI invocation of `rolebox install` gets the same rendering as an interactive one — which for a future animated progress bar would corrupt logs and produce terminal-escape soup.

### 3c. Precedent to follow — existing TTY/CI detection in the repo

The repo already has the exact pattern to replicate, in two places:

- `src/cli/postinstall.ts:32-36`:
  - `if (!process.stdout.isTTY) return;` (line 32)
  - `if (process.env["CI"]) return;` (line 34)
  - `if (process.env["ROLEBOX_NO_WELCOME"]) return;` (line 36) — an existing `ROLEBOX_*` opt-out env var.
- `src/cli/commands/init/init-prompts.ts:15-19`:
  - `if (!process.stdin.isTTY) { throw new Error('Interactive prompts require a TTY...') }` — stdin-TTY guard for interactive UI.

**Recommended surface to add** (mirroring this precedent):

- A small shared helper, e.g. `isInteractive()` = `process.stdout.isTTY && !process.env["CI"] && process.env["TERM"] !== "dumb"`.
- `--quiet`, `--verbose`, `--no-progress` boolean args on both commands.
- Honor `NO_COLOR` in the progress renderer (prefer plain glyphs/ASCII when set).
- Follow the existing `ROLEBOX_*` opt-out convention if a dedicated env var is desired (e.g. `ROLEBOX_NO_PROGRESS`).

---

## 4. Design sketch

### 4a. Phase model

A download is decomposed into named phases, each with a start line and a completion status. Reuse `format.ts` phase glyphs (`SYM_DISPATCH`/`SYM_AWAIT`/`SYM_COMPLETE`/`SYM_ERROR`) and `SYM_ARROW`/`SYM_BULLET` for flow.

```
rolebox install acme/architect@2.0.0
  resolving   → acme/architect@2.0.0
  downloading → acme/architect@2.0.0  ████████□□ 4.2 MB / 5.0 MB  (12.4s)
  verifying   → acme/architect@2.0.0  ✓ sha256-9f2c…
  extracting  → acme/architect@2.0.0  ✓
  installing  → acme/architect@2.0.0  ✓
✓ Installed acme/architect@2.0.0 from acme
Run `rolebox sync opencode` to deploy
```

Phase behavior:
- **resolving** — printed before `fetchRegistryManifest`/`resolveVersion`.
- **downloading** — printed when `downloadRole` begins the tarball fetch; this is where live byte-progress lives (4b).
- **verifying** — printed before `computeIntegrity`; complete line shows the short hash.
- **extracting** — printed before the tar spawn.
- **installing** — printed before `moveDir`/lock update.
- **done** — the existing success line (`install.ts:127` / `update.ts:92`), kept for compatibility.

Each non-final phase emits `SYM_AWAIT` (spinner glyph) while active, then re-renders the line with `SYM_COMPLETE` (✓) or `SYM_ERROR` (✗) + reason on completion/failure.

### 4b. Determinate vs indeterminate rendering

**Determinate (Content-Length present):** The GitHub tarball redirect (`api.github.com/.../tarball` → `codeload.github.com`) typically provides `Content-Length` on the final response. When `response.headers.get("content-length")` parses to a positive number:

- Render a determinate bar via `format.ts` `bar(byteCount, totalBytes)` on a single line.
- Show byte count + total and elapsed via `display-helpers.ts` `formatDuration()`.
- Redraw in place using `\r` + ANSI clear-to-EOL (`\x1b[K`) so it stays one line.

**Indeterminate (no Content-Length):** When absent, show an animated glyph + accumulated byte counter:

```
  downloading → acme/architect@2.0.0  ◷ 1,234,567 bytes (23s)
```

- Rotate a spinner glyph (`│/─\` or reuse `SYM_AWAIT` `◷`) on an interval timer.
- Counter updates from the accumulated `bytesRead`.

### 4c. Streaming implementation note (the mechanism enabling 4b)

To observe byte progress, `downloadRole` must consume the body incrementally instead of `await response.arrayBuffer()` (`registry-client.ts:197`). Sketch:

```
const reader = response.body!.getReader();
let received = 0;
const total = Number(response.headers.get("content-length") ?? 0);
const chunks: Uint8Array[] = [];
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  chunks.push(value);
  received += value.byteLength;
  progressCallback?.({ received, total });   // → renderer (determinate or counter)
}
const buffer = Buffer.concat(chunks);
writeFileSync(archivePath, buffer);
```

The renderer is injected as an optional callback (or an options param) so `downloadRole` stays testable and the current silent default is preserved for non-interactive callers. The tar child should be switched from `stdio: "inherit"` (`registry-client.ts:214`) to `stdio: "pipe"` so its output can be relayed through the phase renderer (and not corrupt the progress line).

### 4d. Degraded plain-line mode (non-TTY / CI / piped)

When `!isInteractive()` (i.e. no TTY, or `CI` set, or `TERM=dumb`), **do not** render bars, spinners, or `\r`-overwriting:

- Emit each phase as a **plain static line** with no ANSI color, no carriage-return redraw, no spinner glyphs.
- The "downloading" line carries just the start message; if streaming is active, emit a **periodic plain line** (e.g. every 2s) with a byte counter: `  downloading → acme/architect@2.0.0 … 4.2 MB`. No bar, no `\r`.
- Honor `NO_COLOR` / `--no-progress` the same way (suppress color + bar rendering).
- Keep exit codes and the final success/failure lines identical to today so scripts that parse output are not broken.

### 4e. Failure rendering

When a phase fails, render a line naming the failed asset, the reason, and (when applicable) the retry attempt:

```
  downloading → acme/architect@2.0.0  ✗ network error downloading role "architect": …
  retrying    → acme/architect@2.0.0  attempt 2/3
```

- **failed asset** — the `roleId@version` string.
- **reason** — reuse the existing error messages from `registry-client.ts` (`network error downloading role`, `failed to download role … HTTP 403/404`, `extraction failed … tar exited with code …`, lines 185/190/193/224).
- **retry N/M** — a bounded retry counter (default, e.g. 3 attempts) around `downloadRole`; the retry-aware loop lives in the command handlers (`install.ts` / `update.ts`) or inside `downloadRole` via an options param. On final failure, rethrow the last error so the existing `update.ts:94-96` catch still surfaces `Warning: failed to update …`.

### 4f. Flag/env resolution order (proposed precedence)

1. `--quiet` → suppress all progress lines (only errors/final success).
2. `--no-progress` → keep phase lines but never render bars/spinners (plain lines, even on TTY).
3. `--verbose` → also emit per-phase detail (e.g. full URL, byte totals, tar output).
4. Else if `!isInteractive()` (no TTY / `CI` / `TERM=dumb`) → degraded plain periodic-line mode.
5. Else (interactive default) → animated determinate/indeterminate rendering.
6. `NO_COLOR` (or `--no-color`) → strip ANSI everywhere regardless of the above.

---

## Acceptance

- [x] Doc exists at `docs/audit-progress-ui.md` documenting the frozen root cause with `file:line` evidence.
- [x] Primitive-reuse recommendation stated (NO new dependency; `ReadableStream` + `format.ts` suffices).
- [x] Missing flag/env surface mapped.
- [x] Concrete design sketch provided (phase lines, determinate/indeterminate, degraded mode, failure rendering).
- [x] `bun run typecheck` exits **0** (verified: `tsc --noEmit`, `EXIT_STATUS=0`).

No source files were modified.
