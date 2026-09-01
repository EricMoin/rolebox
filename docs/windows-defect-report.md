# Windows Adversarial Campaign — Consolidated Defect Report

**Subtask 10 / 10 — final defect aggregation.** Documentation only. **No production source
under `src/` was modified.** This report consolidates the full two-round adversarial
Windows test campaign for the rolebox CLI.

- **Round 1** — run `33476863229`, commit `40fe4db176804263521ef31ed4bc657877a7df44`,
  workflow `Windows Adversarial` (`.github/workflows/windows-adversarial.yml`), `windows-latest`.
  Suite rendered **73 tests / 128 assertions / 16 failures**. Source of truth: the real CI
  evidence in `.rolebox/evidence/round-1/evidence/`.
- **Round 2** — run `33477954903`, commit `2539a1a311a7e51fae68dab119c06a15efab80ea`,
  same workflow, `windows-latest`. Suite rendered **85 tests / 136 assertions / 27 failures**.
  Source of truth: `.rolebox/evidence/round-2/evidence/`.
- **Campaign terminated after round 2** (`TERMINATION: no new problem classes`). No round 3.
  Both rounds were executed on the real cloud `windows-latest` runner with CI **ACTIVE** (no
  degraded-mode darwin-sim fallback was the source of truth for any fact below).

**Evidence files consulted (authoritative Windows CI set):** all `junit-windows.xml` reports and
every `*.json` record under `.rolebox/evidence/round-{1,2}/evidence/windows-campaign/**`.
> Note: the top-level `.rolebox/evidence/windows-campaign/**` tree is a **darwin-local
> re-simulation** (commands point at `/Users/mgl/.bun/bin/bun` and `/var/folders/...`). It is
> NOT the authoritative Windows evidence; the round-1/round-2 `windows-campaign` trees (commands
> at `C:\Users\runneradmin\.bun\bin\bun.exe D:\a\rolebox\rolebox\dist\cli\main.js`) are used
> throughout this report for repro/expected/actual excerpts.

---

## 1. Defect Counts (top-level summary)

### 1.1 By problem class (unique CLI defects)

| Problem class | Unique defects (WIN-xxx) | Red-test failures R1+R2 | Failing tests mapped |
|---------------|:------------------------:|:----------------------:|----------------------|
| **ANSIs-console** | 2 | 3 + 6 = 9 | 9 |
| **shell-semantics** | 1 | 1 + 1 = 2 | 2 |
| **encoding-CRLF** | 2 | 2 + 4 = 6 | 6 |
| **env-resolution** | 1 | 1 + 3 = 4 | 4 |
| **path-handling** | 4 | 6 + 9 = 15 | 15 |
| **symlink-junction** | 2 | 2 + 2 = 4 | 4 |
| **Total (CLI defects)** | **12** | **16 + 27 = 43** | **43** |

Plus **1 test-harness defect** (HAR-001, not a CLI defect) — accounted separately (2 red tests
in round 2, 1 in round 1 after reclassification). See §4.

### 1.2 By severity (unique CLI defects)

| Severity | Count | Defects |
|----------|:-----:|---------|
| **critical** — data loss / silent corruption / feature totally broken | 2 | WIN-008, WIN-009 |
| **major** — feature broken with workaround | 7 | WIN-002, WIN-004, WIN-005, WIN-006, WIN-007, WIN-011, WIN-012 |
| **minor** — cosmetic / output | 3 | WIN-001, WIN-003, WIN-010 |
| **Total** | **12** | |

### 1.3 RAW red-test failures vs unique defects

Every red test across both rounds' junit reports is mapped to exactly one defect entry below
(§2/§3). The same root cause is reproduced by multiple tests per round and across rounds; that
dedup is why 43 raw failures collapse to **12 unique CLI defects** (plus 1 harness defect).

---

## 2. Consensus Reconciliation (counts vs triage files)

The triage files and the junit data were cross-checked. **Two discrepancies in the round-2
triage summary table are reconciled here** (the per-test classification in `round-2/triage.md`
"Per-Failure Triage" and the junit XML are authoritative and unambiguous; the summary table rows
have arithmetic slips):

1. **round-2 triage row `ANSIs-console = 5` is undercounted.** The per-test breakdown gives
   **6** ANSI failures in round 2: `scenario-1` (piped SGR), `scenario-2` (NO_COLOR),
   `scenario-6` (monitor alt-screen/hang), `scenario-7` (TERM=dumb), `scenario-8` (TERM empty),
   `scenario-9` (NO_COLOR+FORCE_COLOR). The table dropped `scenario-6` from the total column
   even though it correctly lists it as a root cause (rc-A2). **Corrected value: 6.**
2. **round-2 triage row `encoding-CRLF = 2` is undercounted.** The row only listed the **2 new**
   round-2 instances (`mixed-CRLF migrate`, `markdown \r`); the **2 carried-over** round-1
   instances (`migrate`, `reference-search`) were omitted from the total column.
   **Corrected value: 4.**

With both corrections, the round-2 class rows sum to **27** (6+1+4+3+9+2+2), matching the
junit `failures="27"`. The uncorrected table summed to 24 (dropped `scenario-6` = −1, dropped
2 carried-over CRLF = −2).

Round-1's table is **internally consistent (sums to 16)** but its `encoding-CRLF = 3` row counts
the GBK/chcp-936 failure (`scenario-4`) as a genuine CLI defect (rc-E1). Round 2 **reclassified
rc-E1 as a test-harness cmd-quoting bug, not a CLI defect** (the CLI never launched — the command
failed with `'"C:\Users\runneradmin\.bun\bin\bun.exe"' is not recognized`). The true round-1
class counts are **encoding-CRLF = 2** and **harness-bug = 1**. This correction is applied
consistently throughout this report (the GBK/chcp failures appear under §4, not §2).

**Bottom line:** 16 (R1) + 27 (R2) = 43 raw failures. After dedup by root cause and after
moving the harness bug out of the CLI-defect set: **12 unique CLI defects + 1 harness defect.**

---

## 3. Defect Inventory

Each entry gives (a) ID, (b) title, (c) problem class, (d) exact repro, (e) expected vs actual,
(f) `src/` file:line evidence, (g) severity, (h) re-runnable failing test, (i) round discovered.

---

### WIN-001 — Unconditional ANSI SGR color: `NO_COLOR` / `TERM` / non-TTY ignored
- **(c) Problem class:** ANSIs-console (root cause rc-A1)
- **(d) Repro** (env: `NO_COLOR=1`, or `TERM=dumb`, or `TERM=` empty, or stdout piped/non-TTY;
  fixture: `dist/cli/main.js`), run on `windows-latest`:
  ```
  C:\Users\runneradmin\.bun\bin\bun.exe D:\a\rolebox\rolebox\dist\cli\main.js status
  C:\Users\runneradmin\.bun\bin\bun.exe D:\a\rolebox\rolebox\dist\cli\main.js info software-architect
  ```
  (also under `NO_COLOR=1`, `TERM=dumb`, `TERM=` empty, and `NO_COLOR=1 + FORCE_COLOR=1`)
- **(e) Expected vs actual** (evidence `console:piped-ansi-sgr-leak`, `no-color-not-honored`,
  `term-dumb-sgr-leak`, `term-empty-sgr-leak`, `no-color-force-color-precedence`):
  - Expected: `no ANSI SGR escape bytes in piped stdout` / `NO_COLOR suppresses ANSI color`.
  - Actual: `76 SGR seq(s) detected; first="\x1b[1m"; exit=0` (status) and
    `56 SGR seq(s) detected; first="\x1b[1m"; exit=0` (info), identically under NO_COLOR, TERM=dumb,
    TERM empty, and NO_COLOR+FORCE_COLOR. `exit=0`.
- **(f) Evidence in `src/`:** `src/cli/format.ts:13-28` (the `bold/dim/red/…` helpers wrap strings
  in `\x1b[…m` with **no TTY / NO_COLOR / TERM / FORCE_COLOR awareness**), consumed by
  `src/cli/commands/status.ts:19-35` and `src/cli/commands/info.ts:13-29`; `src/cli/config.ts`
  (FORCE_COLOR/precedence not handled).
- **(g) Severity:** **minor** (output/cosmetic, but a documented-contract violation — `NO_COLOR=1`
  is a conventional opt-out that here has no effect, which breaks downstream color-stripping/piping).
- **(h) Failing tests** (all reproduce the same root cause; each re-runnable:
  `bun test tests/windows-adversarial/console.test.ts -t "<name>"` on `windows-latest`):
  - `console.test.ts` — `scenario-1: list/status/info with stdout PIPED emit no ANSI SGR bytes`
  - `console.test.ts` — `scenario-2: list/status/info under NO_COLOR=1 emit no ANSI SGR bytes`
  - `console.test.ts` — `scenario-7: list/status/info with TERM=dumb emit no ANSI SGR bytes`
  - `console.test.ts` — `scenario-8: list/status/info with TERM empty emit no ANSI SGR bytes`
  - `console.test.ts` — `scenario-9: NO_COLOR=1 + FORCE_COLOR=1 → NO_COLOR wins, no ANSI SGR`
- **(i) Round discovered:** round 1 (extended in round 2 with scenario-7/8/9).

---

### WIN-002 — `monitor --watch` writes the alt-screen escape and hangs when stdout is a pipe
- **(c) Problem class:** ANSIs-console (root cause rc-A2)
- **(d) Repro** (stdout piped/non-TTY — CI runs the CLI with `stdout` captured):
  ```
  C:\Users\runneradmin\.bun\bin\bun.exe D:\a\rolebox\rolebox\dist\cli\main.js monitor --watch
  ```
- **(e) Expected vs actual** (evidence `console:monitor-alt-screen-in-pipe`,
  `monitor-alt-screen-dangling`, `monitor-pipe-no-actionable-exit`):
  - Expected: `monitor --watch detects non-TTY and does NOT write \x1b[?1049h (alt-screen) into the pipe`;
    `monitor --watch exits or prints an actionable non-TTY error instead of hanging`.
  - Actual: `alt_screen_enter_hex=1b 5b 3f 31 30 34 39 68 1b 5b 32 4a 1b 5b 48 20; alt_screen_leave_present=false; exit=null; timed_out=true; sgr_count=168; stdout_len=3248`
    — the alt-screen **enter** escape is written to a pipe, the matching **leave** escape is never
    written, and the process **hangs** (killed only by the test timeout, `exit=null`).
- **(f) Evidence in `src/`:** `src/cli/commands/monitor.ts:87` (`process.stdout.write("\x1b[?1049h")`
  — written **unconditionally**, with no `isTTY`/`isatty` guard); `monitor.ts:93` (the matching
  `\x1b[?1049l` leave only fires in the `SIGINT` handler — never in a pipe); `monitor.ts:105`
  (`\x1b[2J\x1b[H` also written unconditionally for `json`/`export`);
  `monitor.ts:82-97` (the `while (true)` loop has no non-TTY exit path).
- **(g) Severity:** **major** (feature broken — `monitor --watch` never exits/errors under a pipe
  and never restores the terminal; workaround: run in a real TTY / avoid `--watch` in CI).
- **(h) Failing test** (`bun test tests/windows-adversarial/console.test.ts -t "<name>"`):
  - `console.test.ts` — ``scenario-6: `rolebox monitor --watch` with stdout piped must not emit alt-screen and must exit/error actionably``
- **(i) Round discovered:** round 1 (reproduced identically in round 2).

---

### WIN-003 — `cmd.exe` vs `powershell` produce divergent semantic output
- **(c) Problem class:** shell-semantics (root cause rc-S1)
- **(d) Repro** (wrap the CLI in both shells and compare after ANSI-strip/CRLF-normalize):
  ```
  cmd /c "bun D:\a\rolebox\rolebox\dist\cli\main.js list" ^| powershell -Command "bun D:\a\rolebox\rolebox\dist\cli\main.js list"
  ```
- **(e) Expected vs actual** (evidence `console:shell-output-divergence`):
  - Expected: both wrappers `exit 0` and produce byte-identical output after ANSI-strip/CRLF-normalize.
  - Actual: `cmd_exit=1; ps_exit=1; base_exit=0; equal=false; cmd_len=0, ps_len=0, base_len=107`
    — both shell-wrapped invocations fail (`exit 1`, empty output) while the direct invocation
    succeeds. (Caveat: the observed `cmd_exit=1`/`ps_exit=1` with empty output overlaps the
    harness cmd-quoting fragility seen in HAR-001 — see §4 — so this defect and the harness bug
    share a shell-invocation seam; triage keeps scenario-3 under shell-semantics.)
- **(f) Evidence in `src/`:** `src/cli/main.ts:38-52` (the `cleanup()` update-check hook /
  argument parsing surface reached by the shell wrapper).
- **(g) Severity:** **minor** (output/semantic divergence — commands still succeed when invoked
  directly; the workaround is to invoke the CLI without the shell wrapper).
- **(h) Failing test** (`bun test tests/windows-adversarial/console.test.ts -t "<name>"`):
  - `console.test.ts` — `scenario-3: cmd.exe and powershell produce byte-identical semantic output (plain `list`)`
- **(i) Round discovered:** round 1 (reproduced in round 2).

---

### WIN-004 — `migrate` leaves CRLF (`\r`) residue in output (split-on-`\n`)
- **(c) Problem class:** encoding-CRLF (root cause rc-E2)
- **(d) Repro** (fixture: a CRLF source `role.yaml`; and a **mixed** CRLF/LF source):
  ```
  C:\Users\runneradmin\.bun\bin\bun.exe D:\a\rolebox\rolebox\dist\cli\main.js migrate C:\Users\RUNNER~1\AppData\Local\Temp\rolebox-wintest-sc2-<rand>\role.yaml
  ```
  (and the same over a mixed `\n`/`\r\n` fixture `rolebox-wintest-sc2mix-<rand>\role.yaml`)
- **(e) Expected vs actual** (evidence `file-io:migrate-crlf-residue`,
  `migrate-mixed-crlf-residue`):
  - Expected: migrated output has no line ending in `\r`.
  - Actual (CRLF fixture): `13/61 output lines still end with '\r' (first at line 0)`.
  - Actual (mixed fixture): `4/17 output lines still end with '\r' (first at line 0)`.
- **(f) Evidence in `src/`:** `src/cli/commands/migrate.ts:100` (`const lines = text.split("\n");`
  — splits on `\n` only, so each CRLF line keeps its trailing `\r`); `src/cli/commands/migrate.ts:124`
  (same split inside `findCollaborationBlock`); the rebuild is `lines.join("\n")` (`:104`) with only
  the final line trimmed (`:106`, `commented.replace(/\s+$/, "")`) — interior `\r` survives.
- **(g) Severity:** **major** (silent byte corruption of migrated role YAML — the leftover `\r`
  re-introduces the CRLF-on-LF residue the migration is meant to normalize; the running tool still
  emits output, so this is "feature broken with workaround" rather than a hard data-loss).
- **(h) Failing tests** (`bun test tests/windows-adversarial/file-io.test.ts -t "<name>"`):
  - `file-io.test.ts` — `migrate output lines contain no trailing \r`
  - `file-io.test.ts` — `MIXED CRLF/LF: migrate output lines carry trailing \r on CRLF lines (split-on-'\n' residue)`
- **(i) Round discovered:** round 1 (extended in round 2 with the mixed-CRLF instance).

---

### WIN-005 — `reference_search` leaks `\r` (and a BOM) into matched line/context
- **(c) Problem class:** encoding-CRLF (root cause rc-E3)
- **(d) Repro** (fixture: a CRLF + BOM markdown reference doc that contains the line
  `This is the target line.`):
  ```
  createReferenceSearchTool.execute({ query: 'target', format: 'json' })     // and format: 'markdown'
  ```
- **(e) Expected vs actual** (evidence `file-io:reference-search-crlf-residue`,
  `reference-search-markdown-crlf-residue`):
  - Expected: matched line and context contain no `\r` or `\ufeff` residue (frontmatter.ts
    normalizes CRLF; reference-search should too).
  - Actual (json): `matchedLine='...target line.\r' ctxBefore='["\ufeff# Core Theory\r","\r"]'`.
  - Actual (markdown): `markdown output contains \r; outTextPreview="## Reference Search Results: ...\r..."`.
- **(f) Evidence in `src/`:** `src/utils/reference-search.ts:84` and `:90`
  (`const lines = content.split("\n");` — split-on-`\n` again; the BOM/CRLF in the source is
  carried into the split elements and matched lines without normalization).
- **(g) Severity:** **major** (silent corruption of search-tool output consumed by agents — the
  `matchedLine`/context carries `\r` and a BOM, so line numbers and string matching can be wrong).
- **(h) Failing tests** (`bun test tests/windows-adversarial/file-io.test.ts -t "<name>"`):
  - `file-io.test.ts` — `frontmatter normalizes CRLF; reference search line numbers stay correct`
  - `file-io.test.ts` — ``MARKDOWN format: reference_search over a CRLF+BOM doc leaks \r into matched context``
- **(i) Round discovered:** round 1 (extended in round 2 with the markdown-renderer instance).

---

### WIN-006 — `ROLEBOX_DATA_DIR` / `ROLEBOX_CONFIG_DIR` retain literal surrounding quotes
- **(c) Problem class:** env-resolution (root cause rc-V1)
- **(d) Repro** (env var set with literal quotes — the Windows `set "C:\path\..."` quirk):
  ```
  ROLEBOX_DATA_DIR="\"C:\Users\RUNNER~1\AppData\Local\Temp\rb-encoding-<rand>\""
  ROLEBOX_DATA_DIR="\"C:\Users\RUNNER~1\AppData\Local\Temp\rb-encoding2-<rand> with spaces\""
  ROLEBOX_CONFIG_DIR="\"C:\Users\RUNNER~1\AppData\Local\Temp\rb-cfg-<rand> cfg dir\""
  ```
- **(e) Expected vs actual** (evidence `env:s4-quotes-not-stripped-defect`,
  `s4b-quotes-with-spaces-not-stripped`, `s7-config-quotes-with-spaces-not-stripped`):
  - Expected: quotes stripped → resolves to `C:\...\Temp\rb-encoding-<rand>` (a usable dir).
  - Actual: `getDataDir()="\"C:\Users\RUNNER~1\AppData\Local\Temp\rb-encoding-<rand>\""` — **literal
    quotes retained** (invalid path on Windows); `normalized="C:\...\rb-encoding2-<rand> with spaces\"`
    retains a trailing quote; the config-dir analog (`getConfigDir()`) fails identically.
- **(f) Evidence in `src/`:** `src/cli/paths.ts:66-67` (`const override = process.env.ROLEBOX_DATA_DIR; if (override) return override;`
  — the quoted string is returned **verbatim**, never stripped); `src/cli/paths.ts:99-100`
  (the `ROLEBOX_CONFIG_DIR` analog). `process.env` values arrive with literal quotes under
  `set "VAR=...value..."` / cmd quoting, and the code does not `trim` or unquote.
- **(g) Severity:** **major** (feature broken — an intentionally quoted Windows env override does
  not resolve, so the data/config dir falls back to a wrong/invalid location; workaround: set the
  env var without surrounding quotes).
- **(h) Failing tests** (`bun test tests/windows-adversarial/env.test.ts -t "<name>"`):
  - `env.test.ts` — `S4: ROLEBOX_DATA_DIR trailing-backslash / quotes / forward-slash encodings`
  - `env.test.ts` — `S4b: quoted ROLEBOX_DATA_DIR with spaces retains literal quotes ...`
  - `env.test.ts` — `S7: ROLEBOX_CONFIG_DIR quoted-with-spaces retains literal quotes (config-dir analog)`
- **(i) Round discovered:** round 1 (S4), extended in round 2 (S4b, S7).

---

### WIN-007 — Guard miss: Windows-reserved names (with extension / trailing space·dot) admitted
- **(c) Problem class:** path-handling (root cause rc-P1)
- **(d) Repro** (seam: call the guard / `getRolePath` with a Windows-normalized form; and a
  real-CLI variant that syncs such a roleId from the lock):
  ```
  getRolePath("oh-my-role", "CON.", "1.0.0")
  getRolePath("oh-my-role", "con.", "1.0.0")
  getRolePath("oh-my-role", "CON. ", "1.0.0")
  getRolePath("oh-my-role", "CON .", "1.0.0")
  getRolePath("oh-my-role", "CON.txt", "1.0.0")
  getRolePath("oh-my-role", "NUL.txt", "1.0.0")
  getRolePath("oh-my-role", "COM3.", "1.0.0")
  getRolePath("oh-my-role", "LPT9.", "1.0.0")
  getRolePath("oh-my-role", "LPT1.txt", "1.0.0")
  ```
- **(e) Expected vs actual** (evidence `paths:guardmiss-trailing-dot`, `guardmiss-trailing-space`,
  `guardmiss-reserved-and-extension`, `guardmiss-reserved-space`, and the eight `guardmiss-r2-reserved-*`
  records):
  - Expected: reject with `"Windows reserved device name"` / `"starts with a dot"` / `"is empty"`.
  - Actual: `NOT rejected — guard admitted the Windows-reserved form verbatim` (all forms).
    The real-CLI variant (`real-CLI evidence: guard-miss vectors are actually admitted by sync`)
    asserts the vectors are admitted by `sync`, i.e. they reach the filesystem without validation.
- **(f) Evidence in `src/`:** `src/cli/paths.ts:187-191` (`WIN_RESERVED_NAMES` — a `Set` of **bare**
  names (`CON`, `PRN`, `AUX`, `NUL`, `COM1..9`, `LPT1..9`) that does **not** match forms with an
  extension (`CON.txt`) or a trailing dot/space (`CON.`); `:219` (`WIN_RESERVED_NAMES.has(value.toUpperCase())`
  — exact-set match, no stripping of trailing `.`/space); `:209` (`value.startsWith(".")` — rejects a
  **leading** dot only, never a trailing one); `:224-226` (`value.trim() === ""` — only rejects an
  all-whitespace value, not a value with a trailing space). Windows strips trailing dots/spaces
  before matching device names, and here the guard neither strips nor matches those normalized forms.
- **(g) Severity:** **major** (path-safety / defense-in-depth gap: any crafted roleId in this family
  bypasses `assertSafePathSegment` and reaches `join(getRolesDir(), ...)`/`rmSync`-adjacent paths,
  where Windows normalizes it into a collision/mangling. The workaround is only "don't use such
  names", which is exactly what the guard is meant to enforce).
- **(h) Failing tests** (`bun test tests/windows-adversarial/paths.test.ts -t "<name>"`):
  - `paths.test.ts` — `GUARD MISS: trailing dot in roleId is admitted verbatim (Windows strips it → mangling)`
  - `paths.test.ts` — `GUARD MISS: trailing space in roleId is admitted verbatim (Windows strips it → mangling)`
  - `paths.test.ts` — `GUARD MISS: reserved device name WITH extension (CON.txt) is admitted verbatim`
  - `paths.test.ts` — `GUARD MISS: reserved name with trailing space (CON ) is admitted verbatim`
  - `paths.test.ts` — `GUARD MISS (round 2): Windows-normalized reserved-name forms are admitted verbatim`
- **(i) Round discovered:** round 1 (4 forms), extended in round 2 (Windows-normalized forms).

---

### WIN-008 — `sync` silently clobbers a case-colliding role's symlink on a case-insensitive FS
- **(c) Problem class:** path-handling (root cause rc-P2)
- **(d) Repro** (both `MyRole` and `myrole` installed — same source dir on a case-insensitive FS):
  ```
  C:\Users\runneradmin\.bun\bin\bun.exe D:\a\rolebox\rolebox\dist\cli\main.js sync opencode
  ```
  (and a **multi-cluster** variant colliding across `registry`/`version`: `Role@v1` vs `role@V1`)
- **(e) Expected vs actual** (evidence `paths:case-collision-sync-clobber`,
  `case-collision-multiclust-clobber`):
  - Expected: both case-variant roles stay reachable, OR the collision is detected/refused (no silent drop).
  - Actual: `reported "Synced 2" but only 1 reachable symlink(s) on disk (["MyRole"])` (sync)
    and `multi-cluster case-collision defect: 2 synced, 1 reachable (["role"])` (multi-cluster).
    `exit=0` — silent: the CLI reports success while dropping a role.
- **(f) Evidence in `src/`:** `src/cli/commands/sync.ts:31-34` (`targetPath = join(syncTarget, role)`;
  the two case-variants map to the **same** target path on NTFS), `sync.ts:44-58` (the
  `lstatSync`→`unlinkSync`→`createDirSymlink` branch: the second collision target unlinks the first
  and re-creates it under a different case, and **both** iterations `synced++`), `sync.ts:95`
  (`console.log(parts.join(", "))` — reports `Synced 2` regardless of the resulting reachability).
- **(g) Severity:** **critical** (silent data loss — a locked, previously-reachable role's sync
  target silently disappears while the CLI reports success; this is exactly the "silent drop on a
  case-insensitive FS" failure mode).
- **(h) Failing tests** (`bun test tests/windows-adversarial/paths.test.ts -t "<name>"`):
  - `paths.test.ts` — `DEFECT: sync silently clobbers a case-colliding role's symlink on a case-insensitive FS`
  - `paths.test.ts` — `DEFECT (round 2): sync clobbers a case collision ACROSS role AND version (multi-cluster)`
- **(i) Round discovered:** round 1 (extended in round 2 with the multi-cluster instance).

---

### WIN-009 — `uninstall` of one case-variant deletes the shared source dir → data loss
- **(c) Problem class:** path-handling (**new root cause in round 2**; sits under the existing
  case-collision/path-handling family)
- **(d) Repro** (both `MyRole` and `myrole` installed sharing one source dir on a case-insensitive FS):
  ```
  C:\Users\runneradmin\.bun\bin\bun.exe D:\a\rolebox\rolebox\dist\cli\main.js uninstall MyRole
  ```
- **(e) Expected vs actual** (evidence `paths:case-collision-uninstall-clobber`):
  - Expected: uninstalling `MyRole` leaves the `myrole` source dir + symlink reachable and its lock
    entry resolvable.
  - Actual: `sourceGone=true myroleLinkReachable=false lockStillHasMyRole=true uninstallExit=0`
    — the lower-case role's source dir and symlink are deleted while its lock entry survives, and
    the exit code is 0 (silent).
- **(f) Evidence in `src/`:** `src/cli/commands/uninstall.ts:52-54` (`rmSync(getRolePath(...), { recursive: true, force: true })`
  — runs on the **shared** path (both variants resolve to the same dir on NTFS), deleting the source
  for **both** variants); `src/cli/config.ts:103-110` (`removeFromLock(roleId, registry)` filters the
  lock by the **exact** `role`/`registry` pair and removes only the upper-case entry, so the
  lower-case role's lock entry survives pointing at a now-deleted dir/symlink); the symlink-cleanup
  loop at `uninstall.ts:66-71` removes only the matched link.
- **(g) Severity:** **critical** (permanent silent data loss — a still-locked role loses its source
  dir and symlink while the tool exits 0; the most destructive defect of the campaign).
- **(h) Failing test** (`bun test tests/windows-adversarial/paths.test.ts -t "<name>"`):
  - `paths.test.ts` — `DEFECT (round 2): uninstalling one case-variant clobbers the other's source (data loss)`
- **(i) Round discovered:** round 2.

---

### WIN-010 — a literal backslash in a path segment yields empty `discoverRoles`
- **(c) Problem class:** path-handling (root cause rc-P3 — triage labels it an **OBSERVATION**)
- **(d) Repro** (seam: a role tree containing a segment with a literal backslash):
  ```
  discoverRoles(tree)
  ```
- **(e) Expected vs actual** (evidence `paths:glob-backslash-segment-observation`):
  - Expected: `N/A — observation: documented behavior`.
  - Actual: `discoverRoles returned ["TestRole"] (empty) for a path containing a literal backslash segment`.
- **(f) Evidence in `src/`:** `src/loader/role-loader.ts:53` and `src/utils/paths.ts:20-34`
  (the role-discovery walk that feeds the glob/pattern; a literal `\` in a segment makes the
  pattern fail to match, silently returning empty).
- **(g) Severity:** **minor** (documented observation; a role whose directory name literally
  contains a `\` silently vanishes from search — but on Windows `\` is a separator, so such a name
  cannot be created on a real win32 path; the observation was captured on darwin's fast-glob).
- **(h) Failing test** (`bun test tests/windows-adversarial/paths.test.ts -t "<name>"`):
  - `paths.test.ts` — `OBSERVATION: a literal backslash in a path segment yields empty discoverRoles (darwin fast-glob)`
- **(i) Round discovered:** round 1 (reproduced in round 2).

---

### WIN-011 — `uninstall` leaves a stale junction when `unlinkSync` throws `EPERM`
- **(c) Problem class:** symlink-junction (root cause rc-L1)
- **(d) Repro** (Windows junction semantic: a dir-reparse point that `unlinkSync` cannot remove —
  the harness sim forces `fs.unlinkSync` to throw `EPERM` for sync-target paths, reproducing what a
  real junction does on win32):
  ```
  uninstall(adversary-fixture) with fs.unlinkSync mocked to EPERM for sync-target paths (Windows junction semantics)
  ```
- **(e) Expected vs actual** (evidence `symlink:sim-uninstall-unlink-on-junction`):
  - Expected: sync target empty after uninstall.
  - Actual: `junction SURVIVED uninstall (stale): ...\rolebox-wintest-symlink-<rand>\xdg\opencode\rolebox\adversary-fixture (lock still references role: false)`.
- **(f) Evidence in `src/`:** `src/cli/commands/uninstall.ts:66-67`
  (`if (lstatSync(fullPath).isSymbolicLink()) { unlinkSync(fullPath); }` — on win32 `lstatSync(...).isSymbolicLink()`
  is **true** for a directory junction, so `unlinkSync` is attempted and throws `EPERM`; a junction
  must be removed with `rmdir`/`fs.rm`); `uninstall.ts:69-71` (the `catch` swallows it and only
  `console.warn`s, leaving the junction behind).
- **(g) Severity:** **major** (feature broken — uninstall does not clean up a junctioned sync target,
  leaving a stale link that subsequent status/sync reads treat as present; workaround: `rmdir` the
  leftover manually).
- **(h) Failing test** (`bun test tests/windows-adversarial/symlink-lifecycle.test.ts -t "<name>"`):
  - `symlink-lifecycle.test.ts` — ``sim(win32): uninstall leaves a stale junction when unlinkSync throws EPERM (junction needs rmdir)``
- **(i) Round discovered:** round 1 (reproduced in round 2).

---

### WIN-012 — `sync` hard-crashes (uncaught `EPERM`) when removing an existing junction
- **(c) Problem class:** symlink-junction (root cause rc-L2)
- **(d) Repro** (junction present as a sync target; harness sim forces `fs.unlinkSync` to throw `EPERM`):
  ```
  sync('opencode') in-process with fs.unlinkSync mocked to EPERM for an existing junction
  ```
- **(e) Expected vs actual** (evidence `symlink:sim-resync-unlink-on-junction-crash`):
  - Expected: `sync resolves without throwing (EPERM handled / junction replaced)`.
  - Actual: `sync THREW (hard-crash path): Error: EPERM: operation not permitted, unlink '...\rolebox-wintest-symlink-<rand>\xdg\opencode\rolebox\adversary-fixture'`.
- **(f) Evidence in `src/`:** `src/cli/commands/sync.ts:56` (`unlinkSync(targetPath)` in the
  `else if (targetStat.isSymbolicLink())` branch — **no `try/catch`**; an `EPERM` from a junction
  propagates uncaught and the whole `sync` command crashes with a raw error).
- **(g) Severity:** **major** (feature broken — `sync` crashes with an uncaught `EPERM` on a
  junctioned target; workaround: remove the junction manually first).
- **(h) Failing test** (`bun test tests/windows-adversarial/symlink-lifecycle.test.ts -t "<name>"`):
  - `symlink-lifecycle.test.ts` — ``sim(win32): re-sync hard-crashes when unlinkSync throws EPERM on an existing junction``
- **(i) Round discovered:** round 1 (reproduced in round 2).

---

### HAR-001 — Test-harness cmd-quoting bug (NOT a CLI defect): `chcp`-wrapped invocations can't find the CLI
- **(c) Problem class:** test-harness defect (explicitly **NOT** a CLI defect)
- **(d) Repro** (the harness invokes the CLI through `cmd /c` with a quoted `bun.exe` path that the
  harness's `winQuote`/double-quote handling strips):
  ```
  chcp 936 >nul && "C:\Users\runneradmin\.bun\bin\bun.exe" "D:\a\rolebox\rolebox\dist\cli\main.js" list
  chcp 936 >nul && "C:\Users\runneradmin\.bun\bin\bun.exe" "D:\a\rolebox\rolebox\dist\cli\main.js" info cjk-role
  chcp 437 >nul && "C:\Users\runneradmin\.bun\bin\bun.exe" "D:\a\rolebox\rolebox\dist\cli\main.js" list
  ```
- **(e) Expected vs actual** (evidence `console:gbk-codepage-mojibake`, `chp437-ascii-corruption`):
  - Expected: UTF-8/CJK (or plain ASCII) output survives the codepage, `exit 0`.
  - Actual: `includes_utf8_cjk=false; exit=1; stdout_hex=;` / `includes_ascii=false; exit=1; stdout_len=0`
    — the **CLI never launched**: the command fails at the shell layer with
    `'"C:\Users\runneradmin\.bun\bin\bun.exe"' is not recognized as an internal or external command`, `exit=1`.
- **(f) Evidence in `src/`:** **none** — this is a test-harness (quoting) defect, not a rollout of
  `src/` behavior. The CLI is not executed at all. (Round-1 triage had mislabelled the GBK case as
  rc-E1/encoding-CRLF; round-2 evidence proved it was a harness bug and re-bucketed it.)
- **(g) Severity:** **N/A (test-only)** — produces a red test but does **not** represent a CLI defect.
  It must be excluded from the CLI-defect counts ($1.1).
- **(h) Failing tests** (`bun test tests/windows-adversarial/console.test.ts -t "<name>"`):
  - `console.test.ts` — ``scenario-4: rolebox list/info under cmd chcp 936 (GBK) preserves UTF-8 CJK (no mojibake)``
  - `console.test.ts` — ``scenario-10: rolebox list under cmd chcp 437 preserves a plain ASCII role name (no corruption)``
- **(i) Round discovered:** round 1 (scenario-4, misclassified), confirmed + extended in round 2
  (scenario-10). This is why `file-io: GBK-encoded bytes in a role description` (a genuinely passing
  test) and the `console` GBK tests must be told apart.

---

## 4. Test-Harness Defects, Reclassification, and Non-CLI Red Tests

Round 2's reclassification removed `rc-E1` (GBK) from the genuine CLI-defect list. Both chcp cases
(`scenario-4`, `scenario-10`) are **test-harness cmd-quoting bugs** — the CLI is never launched, so
they are recorded under HAR-001 and **excluded** from the CLI-defect counts in §1.1. This is the
single correction to round-1's numbers: round-1 `encoding-CRLF` was 3 (inflated by the GBK case);
the true CLI count is 2 (WIN-004, WIN-005), and the GBK red test belongs to the harness.

---

## 5. Not-Reproduced / Refuted Suspects (turned out fine)

Because the campaign's purpose is adversarial, it also pre-identified candidates that **did not**
yield a defect. These are **excluded** from the defect list:

- **`file-locking` (live-handle `moveDir` / `uninstall rmSync`)** — **confirmed negative** in both
  rounds. `install.test.ts` and `file-io.test.ts` locking tests: **0 failures**. No file-locking
  defect exists. (`tests/windows-adversarial/file-io.test.ts` — `moveDir under a live handle (locking)`
  and `uninstall rmSync on a locked dir (locking)`; both passed.)
- **`round2: re-sync to pi and dsh targets is idempotent (3 runs)`** — **PASSED** on `windows-latest`.
  Real re-sync to `pi`/`dsh` does **not** hard-crash. This narrows WIN-012: the `EPERM` hard-crash is
  reproduced **only** by the forced-`EPERM` junction **sim**, not by a plain re-sync on the default
  runner without a locked/denied handle.
- **S3 `rolebox_data_dir` (lowercase) env casing** — **PASSED** (`env:s3-env-casing-ok`). On
  Windows the env is case-insensitive and the lowercase override resolves correctly.
- **S5 blank-vs-unset env (`PI_CODING_AGENT_DIR` / `DSH_HOME`)** — **PASSED**
  (`env:s5-blank-treated-as-unset-ok`); blank/whitespace/unset all fall back to the homespace base.
- **S6 opencode Windows config location** — **CORRECT** (by-hand observation
  `env:opencode-windows-config-location.json`, verdict `CORRECT`, `defect: false`). rolebox's
  `defaultPlatformPaths()` → `%USERPROFILE%\.config\opencode` matches opencode's real global config
  location. A minor, non-defective observation about `{configDir}/opencode.jsonc` integration
  detection was noted but is **not** a defect.
- **`scenario-5: download progress in CI mode emits degraded lines with no CR-overdraw artifacts`**
  — **PASSED** both rounds (no `\r`-overdraw artifact in CI mode).
- **Cluster A (install/init/registry)** — all `install.test.ts` tests (symlink-preserving install,
  tar-failure actionability, spaced/`>200`-char data dirs, update-swap-under-live-handle, piped-stdin
  TTY guards, `tar`-unavailable error) — **0 failures** in both rounds.
- **`file-io: loadConfig/loadLock` CRLF/BOM parse (`status --json` / `list --json`)** — **PASSED**.
- **`file-io: GBK-encoded bytes in a role description` → valid U+FFFD replacement** — **PASSED**.

---

## 6. Coverage Gaps (what the campaign could not execute)

The following were out of reach for the bounded round; each has a concrete reason:

- **`install-guard-not-surfaced`** — `assertSafePathSegment` is **unreachable** in the real install
  path before registry resolution: `install foo\bar` fails earlier (at `resolveVersion` /
  registry-manifest resolution, `src/cli/commands/install.ts:119-131`, `:172`) rather than surfacing
  the guard message (`src/cli/paths.ts:198`). Recorded as a coverage limitation in **both** rounds;
  closing it requires a mocked `fetchRegistryManifest` fixture (deferred).
- **Unicode full-width reserved names** (`ＮＵＬ`, `ＣＯＮ`) — intentionally **not** asserted as
  MUST-reject because on darwin there is no way to verify windows NTFS case-folding of full-width
  characters; a hard assertion could produce a false-positive "defect". Kept as a triangulation note.
- **Delayed-expansion `!` / `%VAR%` env variants** — only corrupt when the value reaches the CLI
  through a shell (cmd). The harness spawns the CLI **without** a shell, so the seam cannot observe
  the expansion artifact; a real-shell variant needs a new fixture (deferred).
- **Degraded CI mode** — the campaign never ran degraded: `gh auth status` succeeded before **both**
  rounds (`✓ Logged in ... scopes include repo`), so the real cloud CI path was used throughout and
  **no degraded-mode fallback was ever exercised**. There is therefore **no coverage** of degraded
  CI behavior for the `download progress` (`scenario-5`) path or any other degraded-mode branch.
- **True interactive Windows terminal semantics** — the `monitor` cluster tests run `--watch` with
  **stdout piped**. A real Windows console / ConEmu / Windows-PTY / mintty alt-screen **leave**
  (`\x1b[?1049l`) behavior was **not** exercised (unreachable in CI). Only the pipe path is covered.
- **Junction with locked/denied handle on the real runner** — the WIN-011/WIN-012 `EPERM` paths were
  reproduced by a forced-`EPERM` **sim**, not by a genuinely locked/denied junction on the default
  runner (the round-2 `pi`/`dsh` real re-sync passed, confirming the runner's junctions are removable).
- **`file-locking` cross-platform** — covered as a confirmed negative; no further locking fixtures
  were added. (Do not re-derive; see round-1 handoff note.)

---

## 7. Top-5 Highest-Severity Defects

Ranked critical first, then by impact:

1. **WIN-009 — `uninstall` deletes a shared case-colliding source dir (silent data loss).** The most
   destructive defect of the campaign: a still-locked role loses its source dir **and** sync symlink
   while the tool exits 0 (`uninstall.ts:52-54` + `config.ts:103-110`). **critical.**
2. **WIN-008 — `sync` silently drops a case-colliding role's symlink.** Reports `Synced 2` but only
   1 reachable (`sync.ts:31-58` + `:95`). **critical.**
3. **WIN-007 — guard miss admits Windows-reserved/normalized roleIds.** Any one of `CON.`, `CON.txt`,
   `CON `, `NUL.txt`, … bypasses `assertSafePathSegment` and reaches the filesystem
   (`paths.ts:187-191`, `:209`, `:219`, `:224-226`). **major** (path-safety defense-in-depth hole).
4. **WIN-002 — `monitor --watch` writes alt-screen + hangs on a pipe.** No `isTTY` guard
   (`monitor.ts:87`); hangs with `exit=null` in CI. **major.**
5. **WIN-011 — `uninstall` leaves a stale junction on `EPERM`.** `unlinkSync` on a junction throws and
   the catch swallows it (`uninstall.ts:66-71`). **major.**

---

## 8. Verification of this Report

- `docs/windows-defect-report.md` **exists** at the repo root `docs/` directory.
- **Grep-able cross-check:** every `WIN-XXX` entry below names a re-runnable failing test
  (`tests/windows-adversarial/<file>.test.ts — <test name>`); each is verifiable with
  `bun test tests/windows-adversarial/<file>.test.ts -t "<name>"` on `windows-latest`.
- **Counts reconciled with the triage files:** 16 (R1) + 27 (R2) = 43 raw red tests
  → **12 unique CLI defects** (2 critical / 7 major / 3 minor) + **1 harness defect**.
  The round-2 triage summary-table arithmetic slip (ANSI 5→6, CRLF 2→4) and the round-1
  rc-E1→HAR-001 reclassification are both documented and reconciled in §2.
- No production source under `src/` was modified. This is documentation only.

---

## 9. Fix Verification Status (subtask 11/11 — final)

**Fixes landed on `test/windows-adversarial` and validated green on the real `windows-latest`
`Windows Adversarial` CI run `33483060862`.** Every CLI defect in §3 (WIN-001…WIN-012) and the
test-harness defect (HAR-001) is confirmed **fixed**; the suite renders **85 tests / 0 failures**
on that run. The fixes were authored in subtasks 1-10 (committed here); the subtask-11 pass only
ran verification, committed them in per-cluster commits, and updated this report. No production
source in `src/` was changed by the verification pass itself.

**Local validation (darwin) — subtask 11:**
- `bun test tests/windows-adversarial tests/cli tests/utils` → **739 pass / 4 skip / 0 fail** (743 tests), exit 0.
- `bun run typecheck` (`tsc --noEmit`) → **clean** (exit 0).

**CI validation (real `windows-latest`) — `Windows Adversarial` workflow:**
- Run **`33483060862`** → `https://github.com/EricMoin/rolebox/actions/runs/33483060862`, conclusion **success**.
- `junit-windows.xml` (downloaded `evidence` artifact): **tests = 85, failures = 0, errors = 0, skipped = 0**.
- **Before vs after:** round-1 `33476863229` → **16** failures; round-2 `33477954903` → **27** failures;
  post-fix `33483060862` → **0** failures.

### Per-defect final status

| ID | Severity | Fix commit | Status |
|----|:--------:|:----------:|--------|
| WIN-001 | minor | `e3def38` | fixed in commit e3def38, test green on run 33483060862, 2026-09-01 |
| WIN-002 | major | `e3def38` | fixed in commit e3def38, test green on run 33483060862, 2026-09-01 |
| WIN-003 | minor | `86c2fea` | fixed in commit 86c2fea (harness seam), test green on run 33483060862, 2026-09-01 |
| WIN-004 | major | `d29b85c` | fixed in commit d29b85c, test green on run 33483060862, 2026-09-01 |
| WIN-005 | major | `d29b85c` | fixed in commit d29b85c, test green on run 33483060862, 2026-09-01 |
| WIN-006 | major | `dd0ba65` | fixed in commit dd0ba65, test green on run 33483060862, 2026-09-01 |
| WIN-007 | major | `dd0ba65` | fixed in commit dd0ba65, test green on run 33483060862, 2026-09-01 |
| WIN-008 | critical | `141da46` | fixed in commit 141da46, test green on run 33483060862, 2026-09-01 |
| WIN-009 | critical | `141da46` | fixed in commit 141da46, test green on run 33483060862, 2026-09-01 |
| WIN-010 | minor | `0f8f3ce` | fixed in commit 0f8f3ce, test green on run 33483060862, 2026-09-01 |
| WIN-011 | major | `141da46` | fixed in commit 141da46, test green on run 33483060862, 2026-09-01 |
| WIN-012 | major | `141da46` | fixed in commit 141da46, test green on run 33483060862, 2026-09-01 |
| HAR-001 | N/A (test-only) | `86c2fea`, `89585b1` | fixed in commit 86c2fea + 89585b1, test green on run 33483060862, 2026-09-01 |

### Residual open items

- **None.** The `Windows Adversarial` suite is green on `windows-latest` (85 tests / 0 failures on
  run `33483060862`). The `monitor` pipe/interactivity and junction-sim gaps documented in §6 are
  **coverage limitations**, not red tests (they require a real interactive terminal or a genuinely
  locked/denied junction host to exercise).
- WIN-003's scenario-3 now passes on run `33483060862` — the harness `cmd /d /s /c` + verbatim +
  `winQuote` seam fix (commit `86c2fea`) removed the shell-invocation divergence it shared with
  HAR-001, so **no genuine cmd-vs-powershell CLI divergence remains** and no `src/cli/main.ts` change
  was needed.
- WIN-010 remains a **POSIX-only observation** (a literal `\` home is not creatable on a real win32
  path, where `\` is a separator); the fix closes the darwin `fast-glob` empty-discovery case without
  altering win32 pattern semantics.
