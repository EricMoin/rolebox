# Cross-Platform Audit: rolebox install/update path

**Scope.** `src/cli/main.ts`, `src/cli/commands/install.ts`, `src/cli/commands/update.ts`,
`src/cli/registry-client.ts` (`downloadRole` / `fetchRegistryManifest` / `computeIntegrity`),
`src/cli/paths.ts`, `src/platform/paths.ts`, `src/cli/fs-utils.ts` (`moveDir`),
`src/cli/config.ts`, `src/cli/commands/sync.ts`, `src/cli/commands/uninstall.ts`,
`src/cli/version-check.ts`.

**Method.** Pure audit — no source file was modified. Every finding cites `file:line`.
Severity: **HIGH** = data-loss/security/correctness bug that can strand or corrupt installs;
**MED** = portability or robustness gap that fails on a supported platform or under partial failure;
**LOW** = polish / hardening / observability.

---

## Axis 1 — Path / directory differences across macOS / Linux / Windows

**F1.1 [HIGH] No macOS branch in `getDataDir` / `getConfigDir`; macOS inherits the XDG/Linux layout.**
`src/cli/paths.ts` (`getDataDir`) and `src/cli/paths.ts` (`getConfigDir`) branch only on
`process.platform === "win32"`. On macOS the code falls through to the XDG path
(`$XDG_DATA_HOME` or `~/.local/share/rolebox`) and (`$XDG_CONFIG_HOME` or `~/.config/rolebox`).
macOS apps conventionally use `~/Library/Application Support/rolebox`, so the default location is
non-native but *functional* (homedir is writable). The real risk is divergence: any code or user
expectation built on the macOS convention will miss these dirs. Note this is a *design* divergence,
not a crash.

**F1.2 [MED] `defaultPlatformPaths()` and `piPlatformPaths()` are hard-coded to `~/.config` / `~/.pi` with no Windows branch.**
`src/platform/paths.ts` (`defaultPlatformPaths`) ignores `%APPDATA%`/`%LOCALAPPDATA%` and always
returns `~/.config/opencode` and `~/.claude/agents`. `src/platform/paths.ts`
(`piPlatformPaths`) always returns `~/.pi/agent/*`. On Windows these resolve to
`C:\Users\<user>\.config\opencode` and `C:\Users\<user>\.pi\agent\*`, which are legal but
non-standard, and `sync`/`uninstall` (which read `getSyncTarget`, `src/cli/paths.ts`) will write
symlinks under those non-native locations. Contrast with the rolebox dirs (`paths.ts`) which do
handle win32 — the *sync target* side does not.

**F1.3 [LOW] Windows path-length exposure.** All role dirs are built by string interpolation
`${roleId}@${version}` (`src/cli/paths.ts`) and `join`'d under `%LOCALAPPDATA%\rolebox\roles\<registry>\<roleId>@<version>`
(`src/cli/paths.ts`). Long `registry` + `roleId` + `version` segments can approach the classic
260-char MAX_PATH limit, especially with the `@version` suffix. Node's fs on modern Windows handles
long paths only when the OS long-path policy is enabled; there is no `\\?\` prefixing and no length
check anywhere in the install/update path.

**F1.4 [LOW] Case-sensitivity mismatch is not accounted for.** Role IDs and registry names are used
verbatim as directory names (`src/cli/paths.ts`, from `parseRoleSpec`, `src/cli/commands/install.ts`).
On case-insensitive filesystems (default macOS, Windows) `Foo` and `foo` collide as directory names;
on Linux they are distinct. `findInLock` / lock-keying uses exact string match
(`src/cli/config.ts`), so a case-only rename on macOS/Windows can desync the
directory from the lock. No normalization is applied.

---

## Axis 2 — Writability / accessibility

**F2.1 [HIGH] No writability pre-check before any `mkdirSync` / `writeFileSync`.**
`ensureConfigDir` (`src/cli/config.ts`) blindly `mkdirSync(getConfigDir(), { recursive: true })`
with no `accessSync(W_OK)` / try-catch surface; it is called from `saveConfig`/`loadConfig`
(`config.ts`). Install does the same before writing the role dir:
`mkdirSync(join(targetDir, ".."), { recursive: true })` (`src/cli/commands/install.ts`) and
`update.ts`. `writeFileSync` failures surface as raw `ENOENT`/`EACCES` errors with no guidance
(e.g., "config dir not writable; set XDG_CONFIG_HOME"). There is no elevation assumption in code
(e.g., no `sudo`), which is good, but no graceful degradation either.

**F2.2 [MED] Cache and version-check writes swallow failures silently (no user signal).**
Registry manifest caching (`src/cli/registry-client.ts`) wraps `mkdirSync`/`writeFileSync` in
`try/catch {}` — a read-only data dir degrades to a cache-miss silently (functional, but the user is
never told the cache is being bypassed). Version-check cache write is likewise best-effort
(`src/cli/version-check.ts`). This is acceptable for the non-critical version banner but masks
a genuinely unwritable data dir.

**F2.3 [MED] `chmod`/exec-bit and symlink assumptions are Unix-centric.**
`sync` relies on `symlinkSync` (`src/cli/commands/sync.ts`) with no copy fallback and no
privilege detection (see F6.1 / Anchor 11). `uninstall` assumes symlinks are removable via
`unlinkSync` (`src/cli/commands/uninstall.ts`) with only a coarse best-effort wrapper
(`uninstall.ts`). Nothing in the audited code calls `chmod`/`chmodSync`, so there is no
exec-bit no-op issue on Windows, but the symlink operations themselves are the platform-fragile
point (Windows requires Developer Mode or elevated privilege for symlink creation).

**F2.4 [LOW] No read-permission handling when walking files for integrity.**
`walkFiles` (`src/cli/registry-client.ts`) silently `catch {}` on unreadable files/dirs
(`registry-client.ts`), so an integrity hash can be computed over a *partial* file set without
warning — masking a real permission problem as a "valid" hash.

---

## Axis 3 — Missing-directory fallback

**F3.1 [HIGH] No `ROLEBOX_DATA_DIR` / `ROLEBOX_CONFIG_DIR` override, and no env → platform → cwd-local → temp fallback chain for rolebox dirs.**
`getDataDir` (`src/cli/paths.ts`) honors only `LOCALAPPDATA` (win32) and `XDG_DATA_HOME`.
`getConfigDir` (`src/cli/paths.ts`) honors only `APPDATA` (win32) and `XDG_CONFIG_HOME`.
There is **no** rolebox-specific env override, no cwd-local fallback, and no OS-temp fallback. The
contrast pattern exists in `resolveLogFilePath` (`src/logger.ts`): env var (`ROLEBOX_LOG_FILE`)
→ project-local `.rolebox` dir (`_baseDirectory`, `logger.ts`) → config dir (`logger.ts`)
→ `os.tmpdir()` (`logger.ts`) → `null` (disable). The rolebox data/config resolution has no
such chain, so if `~/.config`/`~/.local/share` (or `%APPDATA%`/`%LOCALAPPDATA%`) are unavailable or
unwritable, the CLI has no built-in fallback and no clear message about *where* it tried to write.

`src/logger.ts` — `resolveLogFilePath` (the fallback-chain contrast):

```ts
export function resolveLogFilePath(): string | null {
  // 1. Explicit env var
  if (process.env.ROLEBOX_LOG_FILE) {
    const result = ensureLogDir(process.env.ROLEBOX_LOG_FILE);
    if (result) return result;
  }

  // 2. Project-local .rolebox dir (set via configureLogDirectory)
  if (_baseDirectory) {
    const localPath = join(_baseDirectory, ".rolebox", "logs", "rolebox.log");
    const result = ensureLogDir(localPath);
    if (result) return result;
  }

  // 3. Config dir (fallback for CLI / pre-init calls)
  try {
    const configLogPath = join(getConfigDir(), "logs", "rolebox.log");
    const result = ensureLogDir(configLogPath);
    if (result) return result;
  } catch {
    // getConfigDir itself shouldn't throw, but guard anyway
  }

  // 4. OS-native temp directory fallback (cross-platform)
  const tmpPath = join(tmpdir(), "rolebox.log");
  const tmpResult = ensureLogDir(tmpPath);
  if (tmpResult) return tmpResult;

  // All failed — disable file logging
  return null;
}
```

*Post-audit: `getDataDir`/`getConfigDir` gained `ROLEBOX_DATA_DIR`/`ROLEBOX_CONFIG_DIR` overrides and an explicit darwin branch (the env override closes the "no override" half of this finding; no cwd-local/temp fallback chain was added). See the Remediation status sections below. The `resolveLogFilePath` contrast above is unchanged.*

**F3.2 [MED] Recursive creation exists but is fragmented, and the chosen location is never surfaced.**
`mkdirSync(..., { recursive: true })` is used at `src/cli/config.ts`, `src/cli/commands/install.ts`,
`src/cli/commands/update.ts`, `src/cli/registry-client.ts`, `src/cli/commands/sync.ts`,
`src/cli/version-check.ts`. So missing parents *are* created. But no command prints the resolved
data/config/roles directory to the user, and there is no documented fallback chain (see F3.1) — the
user has no way to know or change where roles land except via XDG/LOCALAPPDATA env vars, which are
not documented in the CLI help.

---

## Axis 4 — Error capture and unpack robustness

**F4.1 [HIGH] No timeout/abort on the role download fetch.** `fetch(url, { headers, redirect: "follow" })`
(`src/cli/registry-client.ts`) has no `AbortController`/`signal`, unlike the version-check fetch
which uses `AbortController` + 3s timeout (`src/cli/version-check.ts`). A stalled download can
hang the CLI indefinitely. No retry logic exists for either manifest or role download.

`src/cli/version-check.ts` — `checkForUpdate` (`AbortController` + 3s timeout):

```ts
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(NPM_REGISTRY_URL, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
```

*Post-audit: `downloadRole` now wraps its own fetch in an `AbortController` with a 30s timeout and bounded retry — see “Remediation status — post-audit” below. The version-check contrast above is unchanged.*

**F4.2 [HIGH] Whole-body `arrayBuffer()` buffering with no size cap.** The entire tarball is read into
memory at `src/cli/registry-client.ts` (`Buffer.from(await response.arrayBuffer())`). Large roles
consume unbounded memory; there is no content-length guard and no stream-to-disk writing. The test
`registry-client.test.ts` exercises a small in-memory archive, so the buffering path is not
stress-tested.

**F4.3 [MED] HTTP/redirect/partial-body handling is partial.** Non-200 is handled (`registry-client.ts`
for role; `registry-client.ts` for manifest, including 404/403/other), and `redirect: "follow"`
is set. But there is no partial-body detection, no `Content-Length` verification against bytes read,
and no retry on transient failure. A truncated-but-200 body is written to disk and handed to `tar`,
which will fail with a generic tar error (see F4.5).

**F4.4 [MED] Integrity is computed but never verified against an expected value.** `computeIntegrity`
(`src/cli/registry-client.ts`) produces a SHA-256 over the installed tree and stores it in the
lock (`install.ts`; `update.ts`). It is a *record*, not a *check*: nothing compares it
to a manifest-declared or previously-pinned value, and `update` never compares the previous lock
integrity to the new tree. A corrupt download that still extracts will be recorded as "valid."

`src/cli/registry-client.ts` — `computeIntegrity`:

```ts
export async function computeIntegrity(dirPath: string): Promise<string> {
  const files = walkFiles(dirPath);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(file.data);
  }

  return `sha256-${hash.digest("hex")}`;
}
```

*Post-audit: install/update now verify the computed digest against a manifest-declared value when one is present — see “Remediation status — post-audit” below.*

**F4.5 [HIGH] External `tar` spawn with `stdio:"inherit"`, no zip-slip validation, no in-process extraction.**
`runSpawn("tar", ["xzf", archivePath, "--strip-components=1", "-C", extractDir], { stdio: "inherit" })`
(`src/cli/registry-client.ts`). `tar --strip-components=1` strips only the top level; a
malicious archive entry like `../../etc/foo` or an absolute path is **not** validated before
extraction (no zip-slip check on entry names). `stdio:"inherit"` leaks raw tar output to the
terminal and makes programmatic error capture harder (only the exit code is used,
`registry-client.ts`). Also relies on an external `tar` on PATH — pre-checked at
`registry-client.ts` (`spawnSync("tar", ["--version"])`), but the check only verifies the
binary exists, not the version/behavior differences between GNU tar, BSD tar, and Windows bsdtar.

`src/cli/registry-client.ts` — `downloadRole` external tar extraction:

```ts
        const proc = runSpawn("tar", ["xzf", archivePath, "--strip-components=1", "-C", extractDir], {
          stdio: "inherit",
        });
```

*Post-audit: extraction now runs `assertExtractionWithinDir` after tar, which resolves every entry and rejects any path escaping the extract dir (zip-slip / traversal) — see “Remediation status — post-audit” below.*

**F4.6 [HIGH] `rolebox-out-*` temp leak on failure.** `outputDir = mkdtempSync(join(tmpdir(), "rolebox-out-"))`
is created at `src/cli/registry-client.ts`, but the `finally` block (`registry-client.ts`)
removes only `tmpDir`. If `fetch` fails, the response is non-OK, `tar` fails, or the role dir is
missing (any exit before `registry-client.ts`), `outputDir` is orphaned and accumulates in the
system temp dir.

**F4.7 [HIGH] No rollback: the old version is removed before the new download completes.**
In `install` (`src/cli/commands/install.ts`) the old version directory is `rmSync`'d *before*
`downloadRole` is called (`install.ts`); if the download/extract fails the old version is gone and
the lock is stale. In `update`, the download completes first (`update.ts`) but the existing target
dir is `rmSync`'d (`update.ts`) before `moveDir` (`update.ts`) and integrity (`update.ts`)
succeed — a failure between those steps leaves a missing/partial target with no restoration of the
prior state. The extract-to-temp-then-rename model exists (`registry-client.ts`) but is not
carried through to an atomic swap of the *target* directory (install.ts `rmSync`+`moveDir` is
not atomic).

**F4.8 [MED] Error context is inconsistent and sometimes swallowed.**
`downloadRole`/`fetchRegistryManifest` throw informative messages (e.g., `registry-client.ts,
104,108,112,185,189,193,220,224,229`). But `update` wraps per-role failures in a `console.warn`
(`update.ts`) and continues, and `install`'s `mkdirSync`/`rmSync`/`moveDir` failures
(`install.ts`) propagate raw `NodeJS.ErrnoException` with no role/registry context. `moveDir`
(`src/cli/fs-utils.ts`) handles only `EXDEV`; other rename failures (e.g., `EACCES`, `EPERM` on
Windows, `ENOTEMPTY`) rethrow raw. Uninstall symlink cleanup is silently best-effort
(`uninstall.ts`). Version-check swallows all errors by design (`version-check.ts`).

`src/cli/fs-utils.ts` — `moveDir` (`EXDEV`-only fallback):

```ts
export function moveDir(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === "EXDEV") {
      cpSync(src, dest, { recursive: true });
      rmSync(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}
```

**F4.9 [LOW] `parseRoleSpec` accepts `@` and `:` separators but does not reject path-unfriendly characters.**
`src/cli/commands/install.ts` splits on the first `:` and last `@` but never validates the
remaining `roleId`/`registry`/`version` for `/`, `\`, `..`, or `@`. These flow into
`getRolePath` → `join` and `rmSync` (see F6.2 / Anchor 4).

`src/cli/commands/install.ts` — `parseRoleSpec`:

```ts
export function parseRoleSpec(spec: string): { roleId: string; registry?: string; version?: string } {
  let remaining = spec;
  let registry: string | undefined;
  let version: string | undefined;

  const colonIdx = remaining.indexOf(":");
  if (colonIdx !== -1) {
    registry = remaining.slice(0, colonIdx);
    remaining = remaining.slice(colonIdx + 1);
  }

  const atIdx = remaining.lastIndexOf("@");
  if (atIdx !== -1) {
    version = remaining.slice(atIdx + 1);
    remaining = remaining.slice(0, atIdx);
  }

  return { roleId: remaining, registry, version };
}
```

*Post-audit: `getRolePath` now validates every segment via `assertSafePathSegment`, so these unvalidated segments can no longer escape `{rolesDir}` — see the Remediation status section below.*

---

## Axis 5 — Verification

**F5.1 [HIGH] CI runs a single OS.** `.github/workflows/ci.yml` uses `runs-on: ubuntu-latest`
only. No macOS, Windows, or WSL matrix. All the platform-sensitive code in Axes 1-2 (win32 branches,
symlink creation, tar variant) is never exercised in CI.

**F5.2 [MED] Install/update command tests mock the entire registry client.**
`tests/cli/commands/install.test.ts` `mock.module`'s `fetchRegistryManifest`, `downloadRole`,
`resolveVersion`, and `computeIntegrity`, so the command-level tests never hit real download,
extraction, or integrity. (Refinement: real tar extraction *is* covered at the unit level in
`tests/cli/registry-client.test.ts` using a real in-memory tarball; but streaming/partial-body
behavior is not, and no test exercises a real end-to-end install.)

**F5.3 [MED] Path tests assert only POSIX defaults; Windows branches are untested.**
`tests/cli/paths.test.ts` asserts `~/.local/share/rolebox` and `~/.config/rolebox` (POSIX) and
XDG override (`paths.test.ts`). `LOCALAPPDATA`/`APPDATA` are captured in the env save/restore
(`paths.test.ts`) but never set, so the win32 branches of `getDataDir`/`getConfigDir`
(`paths.ts`) are untested.

**F5.4 [LOW] `sync`/`uninstall` symlink behavior and `moveDir` cross-device fallback are untested.**
There is no test for `sync.ts` symlink creation/cleanup, and no test for `fs-utils.moveDir`'s EXDEV
copy fallback (`src/cli/fs-utils.ts`) — the fallback that is specifically needed on Linux when
`/tmp` is tmpfs and the target is on the home filesystem.

---

## Anchor verification

The following known anchors were explicitly checked. Status: **confirm** (verified true),
**refute** (verified false), or **refine** (true but with nuance).

| # | Anchor | Status | Evidence |
|---|--------|--------|----------|
| A1 | macOS not branched in `getDataDir`/`getConfigDir` | **Confirm** | `src/cli/paths.ts` branch only on `win32`; macOS falls through to XDG/`~/.local` / `~/.config`. |
| A2 | No `ROLEBOX_DATA_DIR`/`ROLEBOX_CONFIG_DIR` override and no env→platform→cwd-local→temp fallback chain | **Confirm** | `src/cli/paths.ts` honor only `LOCALAPPDATA`/`APPDATA`/`XDG_*`. Contrast `src/logger.ts` (`ROLEBOX_LOG_FILE` → cwd-local → config → tmpdir → null). |
| A3 | No writability pre-check before `mkdir`/write | **Confirm** | `src/cli/config.ts`; `src/cli/commands/install.ts`; `src/cli/commands/update.ts`. |
| A4 | Unsanitized `roleId`/`registry` → `getRolePath` → `rmSync` arbitrary-delete/traversal risk | **Confirm** | `src/cli/paths.ts` joins raw `registry`/`roleId@version`; `rmSync` at `install.ts`, `update.ts`. Input from `parseRoleSpec` (`install.ts`) is unsanitized. |
| A5 | No timeout/abort on the download fetch | **Confirm** | `src/cli/registry-client.ts` — no signal; contrast `src/cli/version-check.ts` (has AbortController). |
| A6 | Whole-body `arrayBuffer()` buffering; no retry | **Confirm** | `src/cli/registry-client.ts`. No retry on fetch failure or non-2xx. |
| A7 | Integrity computed post-install but never verified against expected value | **Confirm** | `src/cli/registry-client.ts` computes; `install.ts` / `update.ts` store; never compared. |
| A8 | External `tar` with `--strip-components=1` and `stdio:"inherit"`, no zip-slip validation | **Confirm** | `src/cli/registry-client.ts`. |
| A9 | `rolebox-out-*` temp leak | **Confirm** | `src/cli/registry-client.ts` (created) vs its `finally` (removes only `tmpDir`). |
| A10 | No rollback: old version removed before new download completes | **Confirm** | `src/cli/commands/install.ts` (`rmSync` old) before `downloadRole` (`install.ts`); `update.ts` `rmSync` target before `moveDir` (`update.ts`). |
| A11 | Windows symlink privilege assumption with no copy fallback | **Confirm** | `src/cli/commands/sync.ts` `symlinkSync` with no catch/fallback. |
| A12 | CI runs ubuntu-latest only | **Confirm** | `.github/workflows/ci.yml`. |
| A13 | Tests mock `downloadRole`/`fetchRegistryManifest` so real tar extraction and streaming are never exercised | **Refine** | Command-level tests mock the client (`tests/cli/commands/install.test.ts`), and streaming is never exercised; but real `tar` extraction IS exercised at unit level in `tests/cli/registry-client.test.ts` (real tarball, real `tar`). "Never exercised" is too strong for extraction; accurate for streaming and end-to-end install. |
| A14 | `tests/cli/paths.test.ts` asserts only POSIX defaults; Windows branches untested | **Confirm** | `tests/cli/paths.test.ts`; win32 branches (`paths.ts`) never set `LOCALAPPDATA`/`APPDATA`. |

---

## Summary severity table

| ID | Finding | Severity | Axis |
|----|---------|----------|------|
| F4.7 | No rollback — old version removed before new download completes | HIGH | 4 |
| F4.1 | No timeout/abort on role download fetch | HIGH | 4 |
| F4.2 | Whole-body buffering, no size cap | HIGH | 4 |
| F4.5 | External `tar`, `stdio:"inherit"`, no zip-slip validation | HIGH | 4 |
| F4.6 | `rolebox-out-*` temp leak on failure | HIGH | 4 |
| F2.1 | No writability pre-check before mkdir/write | HIGH | 2 |
| F3.1 | No rolebox env override / fallback chain | HIGH | 3 |
| F5.1 | CI runs ubuntu-latest only | HIGH | 5 |
| F4.4 | Integrity computed but never verified | MED | 4 |
| F1.2 | Sync-target paths hard-coded to `~/.config`/`~/.pi` (no Windows branch) | MED | 1 |
| F2.2 | Cache/version-check writes silently swallowed | MED | 2 |
| F2.3 | Symlink assumptions Unix-centric, no copy fallback | MED | 2 |
| F3.2 | Chosen location never surfaced; fallback undocumented | MED | 3 |
| F4.3 | Partial-body/redirect handling incomplete, no retry | MED | 3/4 |
| F4.8 | Error context inconsistent, some swallowed | MED | 4 |
| F5.2 | Install/update tests mock registry client | MED | 5 |
| F5.3 | Path tests cover POSIX only; Windows branches untested | MED | 5 |
| F1.1 | No macOS branch (non-native dirs on macOS) | LOW | 1 |
| F1.3 | Windows path-length exposure (MAX_PATH) | LOW | 1 |
| F1.4 | Case-sensitivity mismatch not handled | LOW | 1 |
| F2.4 | Integrity walk silently skips unreadable files | LOW | 2 |
| F4.9 | `parseRoleSpec` doesn't reject path-unfriendly chars | LOW | 4 |
| F5.4 | `sync`/`uninstall`/`moveDir` EXDEV untested | LOW | 5 |

**Counts:** HIGH 7, MED 10, LOW 6.

---

## Prioritized remediation list

1. **[HIGH] Add timeout/abort + streaming download + size cap + retry to `downloadRole`.**
   `src/cli/registry-client.ts`. Use `AbortController` with a configurable timeout (mirror
   `version-check.ts`), stream the body to `archivePath` with a `Content-Length` cap, and add a
   bounded retry on transient failure. Blocks F4.1, F4.2, F4.3.
2. **[HIGH] Add rollback / atomic swap for install and update.**
   Never `rmSync` an existing version before the new artifact is fully extracted and integrity-checked.
   Extract to a temp dir, verify, then atomically replace the target (rename over, or keep a backup and
   restore on failure). Covers `install.ts` and `update.ts`. Blocks F4.7.
3. **[HIGH] Replace external `tar` with an in-process, zip-slip-safe extraction.**
   Validate every archive entry name (reject absolute paths and `..` traversal) before writing; if
   keeping `tar`, drop `stdio:"inherit"` (pipe and capture) and add explicit entry-name validation.
   Blocks F4.5.
4. **[HIGH] Sanitize `roleId`/`registry`/`version` and scope `rmSync` targets.**
   Validate in `parseRoleSpec`/`getRolePath` (`install.ts`, `paths.ts`) that the resulting
   path stays within `{rolesDir}` before any `rmSync` (`install.ts`, `update.ts`). Blocks F4.9 / A4.
5. **[HIGH] Fix temp leak: clean `outputDir` on every failure path.**
   Track `outputDir` in the `finally` (`registry-client.ts`) and remove it unless it was
   successfully renamed to its stable target. Blocks F4.6.
6. **[HIGH] Add writability pre-checks and a documented fallback chain for data/config dirs.**
   Check `W_OK` (or wrap with actionable context) before `mkdir`/`write`; add `ROLEBOX_DATA_DIR` /
   `ROLEBOX_CONFIG_DIR` env overrides and a fallback chain (env → platform default → cwd-local →
   OS temp) like `resolveLogFilePath` (`src/logger.ts`); surface the resolved location to the
   user. Blocks F2.1, F3.1, F3.2.
7. **[HIGH] Expand the CI platform matrix.**
   Add macOS and Windows jobs to `.github/workflows/ci.yml` (and WSL where practical). Blocks F5.1.
8. **[MED] Verify integrity against an expected value.**
   Compare the computed integrity to the lock entry (and/or a manifest-declared digest) on install and
   update; warn/fail on mismatch. Blocks F4.4.
9. **[MED] Add a symlink copy-fallback for Windows.**
   In `sync.ts`, wrap `symlinkSync` in try/catch and fall back to `cpSync` when symlink creation
   is not permitted. Blocks F2.3 / A11.
10. **[MED] Windows-aware sync-target paths.** Add `%APPDATA%`/`%LOCALAPPDATA%` handling in
    `defaultPlatformPaths`/`piPlatformPaths` (`src/platform/paths.ts`). Blocks F1.2.
11. **[MED/LOW] Add targeted tests.** Windows path-branch tests (`paths.ts` win32), `moveDir` EXDEV
    fallback, `sync` symlink/fallback, and a partial-body/truncated-archive download test. Blocks
    F5.3, F5.4.

---

## CI / test coverage gaps

1. **Single-OS CI.** `.github/workflows/ci.yml` (`runs-on: ubuntu-latest`) never runs macOS or
   Windows, so the win32 branches (`paths.ts`), symlink creation (`sync.ts`), and
   `tar` variant behavior are never validated. (F5.1)
2. **Command-level mocks.** `tests/cli/commands/install.test.ts` mocks the whole registry
   client, so no test covers real download → extraction → integrity → lock wiring end-to-end. Real
   extraction is only covered in `tests/cli/registry-client.test.ts`. (F5.2)
3. **No streaming / partial-body / timeout tests.** All download tests use small in-memory
   `Response` bodies; the whole-body `arrayBuffer` path and the missing timeout are untested. (F5.2)
4. **Windows path branches untested.** `tests/cli/paths.test.ts` asserts POSIX defaults only;
   `LOCALAPPDATA`/`APPDATA` are captured but never exercised. (F5.3)
5. **Symlink and cross-device move untested.** No tests for `sync.ts` symlink create/cleanup, no
   test for `fs-utils.moveDir` EXDEV copy fallback, no test for `uninstall.ts` symlink cleanup.
   (F5.4)
6. **No rollback / failure-injection tests.** No test verifies that a failed download leaves prior
   state intact, that `rolebox-out-*` dirs are cleaned on failure, or that a corrupt/truncated
   archive fails cleanly. (F4.6, F4.7)

---

*Audit generated from the source tree as of the audit date. No source files were modified.*

---

## Remediation status — Subtask 6 (path hardening)

The following findings were addressed by the path-hardening subtask (see `src/cli/paths.ts`,
`src/cli/fs-utils.ts`, `src/cli/config.ts`, `src/cli/commands/install.ts`,
`src/cli/commands/update.ts`, `src/cli/commands/uninstall.ts`):

- **A4 / F4.9 — Sanitization (HIGH).** `getRolePath` now validates `registry`, `roleId`, and
  `version` via `assertSafePathSegment` (rejects path separators, `..` traversal, leading dots,
  Windows-invalid characters `: * ? " < > |`, and Windows reserved device names `CON/PRN/AUX/NUL/COM1-9/LPT1-9`)
  with an actionable error naming the offending segment. Because every install/update/uninstall/sync/info
  path is derived from `getRolePath`, the arbitrary-delete vector into `rmSync` (`install.ts`,
  `update.ts`, `uninstall.ts`) is closed.

  `src/cli/paths.ts` — `getRolePath` (current):

```ts
export function getRolePath(registry: string, roleId: string, version: string): string {
  assertSafePathSegment(registry, "registry");
  assertSafePathSegment(roleId, "roleId");
  assertSafePathSegment(version, "version");
  return join(getRolesDir(), registry, `${roleId}@${version}`);
}
```

  `src/cli/paths.ts` — `assertSafePathSegment` (separator / traversal / leading-dot checks; the
  Windows-invalid-character, reserved-device-name, and empty-value checks follow):

```ts
export function assertSafePathSegment(value: string, label: string): void {
  if (value.includes("/") || value.includes("\\")) {
    throw new Error(
      `${label} '${value}' contains a path separator; refusing to use it in a filesystem path`,
    );
  }
  if (value.includes("..")) {
    throw new Error(
      `${label} '${value}' contains '..' (path traversal); refusing to use it in a filesystem path`,
    );
  }
  if (value.startsWith(".")) {
    throw new Error(
      `${label} '${value}' starts with a dot; refusing to use it in a filesystem path`,
    );
  }
```
- **F3.1 / F2.1 — Env overrides + writability pre-checks (HIGH).** `getDataDir` / `getConfigDir` now honor
  `ROLEBOX_DATA_DIR` / `ROLEBOX_CONFIG_DIR` before XDG / APPDATA / LOCALAPPDATA defaults. Directory creation
  in `config.ts`, `install.ts`, and `update.ts` now routes through `ensureWritableDir`, which fails with a
  clear `directory <X> is not writable; set ROLEBOX_CONFIG_DIR / ROLEBOX_DATA_DIR or fix permissions`
  message instead of an opaque `EACCES`.

  `src/cli/paths.ts` — `getDataDir` (current; `getConfigDir` mirrors this with `ROLEBOX_CONFIG_DIR` /
  `XDG_CONFIG_HOME` / `APPDATA`):

```ts
  const override = process.env.ROLEBOX_DATA_DIR;
  if (override) return override;

  // XDG_DATA_HOME is honored on ALL platforms (including win32) so the data dir
  // can be isolated consistently on Windows too. This sits below the
  // ROLEBOX_DATA_DIR override and above the platform-specific branches.
  const xdgData = process.env.XDG_DATA_HOME;
  if (xdgData) return join(xdgData, "rolebox");

  if (getPlatform() === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "rolebox");
  }

  // Darwin (macOS): deliberate parity with opencode's config location
  // (~/.local/share / ~/.config), NOT ~/Library/Application Support.
  // Relocating would orphan existing installs, so keep the XDG-style layout.
  if (getPlatform() === "darwin") {
    const xdg = process.env.XDG_DATA_HOME;
    if (xdg) return join(xdg, "rolebox");
    return join(homedir(), ".local", "share", "rolebox");
  }
```

  `src/cli/config.ts` — `ensureConfigDir`:

```ts
export function ensureConfigDir(): void {
  ensureWritableDir(getConfigDir());
}
```

  `src/cli/fs-utils.ts` — `ensureWritableDir`:

```ts
export function ensureWritableDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (isEACCES(err)) {
      throw new Error(NOT_WRITABLE_HINT.replace("%s", dir));
    }
    throw err;
  }
  try {
    accessSync(dir, constants.W_OK);
  } catch (err) {
    if (isEACCES(err)) {
      throw new Error(NOT_WRITABLE_HINT.replace("%s", dir));
    }
    throw err;
  }
}
```
- **F1.1 — macOS branch (LOW).** `getDataDir` / `getConfigDir` now have an explicit darwin branch. The
  decision is deliberate: **keep `~/.config` / `~/.local/share` parity with opencode; do NOT relocate to
  `~/Library/Application Support`** — relocating would orphan existing installs. This rationale is
  documented in the code comment and asserted by tests in `tests/cli/paths.test.ts`.

  `src/cli/paths.ts` — `getConfigDir` darwin branch (current):

```ts
  // Darwin (macOS): deliberate parity with opencode's config location
  // (~/.config / ~/.local/share), NOT ~/Library/Application Support.
  // Relocating would orphan existing installs, so keep the XDG-style layout.
  if (getPlatform() === "darwin") {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg) return join(xdg, "rolebox");
    return join(homedir(), ".config", "rolebox");
  }
```

Out of scope for this subtask (tracked by subtask 7): download/extract/rollback behavior (F4.1, F4.2,
F4.4, F4.5, F4.6, F4.7, F4.8) and the CI platform matrix (F5.1).

---

## Remediation status — post-audit (download / extract / CI hardening)

The findings above are a point-in-time snapshot of the tree as of the audit date; their `file:line`
pointers are kept as the historical record, and several symbols have since moved (for example,
`moveDir` now lives at `src/cli/fs-utils.ts`). After the Subtask 6 path hardening documented
above, the download / extract path and the CI platform matrix were hardened as well. The snippets
below show the **current** implementation for the affected findings, so the finding prose above is
superseded wherever the two disagree.

**F4.1 / A5 — Download timeout + abort.** `downloadRole` now wraps each fetch attempt in an
`AbortController` with a configurable timeout (`DEFAULT_DOWNLOAD_TIMEOUT_MS`, 30s):

`src/cli/registry-client.ts` — `downloadRole` (timeout + abort per attempt):

```ts
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        response = await fetch(url, { headers, redirect: "follow", signal: controller.signal });
```

**F4.2 / A6 — Streaming body (`arrayBuffer` is now only a no-stream fallback).** The body is read as
a stream with a `Content-Length`-derived total and byte-count progress; `Buffer.from(await
response.arrayBuffer())` survives only for responses without a readable body, and a short read is now
an explicit error:

`src/cli/registry-client.ts` — `downloadRole` (Content-Length + streaming read loop):

```ts
    const total = Number(response.headers.get("content-length")) || 0;
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            received += value.byteLength;
            progress?.update({ received, total });
          }
        }
```

**F4.4 / A7 — Integrity is now verified when the manifest declares a digest.** Install (and update)
compare the computed SHA-256 against `manifest.roles[...].integrity` before the swap and refuse on
mismatch:

`src/cli/commands/install.ts` — `install` (manifest-digest verification):

```ts
  const integrity = await computeIntegrity(extractedDir);
  const expectedIntegrity = manifest.roles[parsed.roleId]?.integrity;
  if (expectedIntegrity) {
    // Manifest-declared digest available: the computed digest MUST match.
    if (integrity !== expectedIntegrity) {
      const msg = `integrity check failed for role "${parsed.roleId}@${version}": expected ${expectedIntegrity}, computed ${integrity}; refusing to install`;
      progress.phaseFail("verifying", { asset: `${parsed.roleId}@${version}`, reason: msg, attempt: 1, maxAttempts: 1 });
      throw new Error(msg);
    }
```

**F4.5 / A8 — Zip-slip / traversal validation added.** After extraction, every entry is resolved with
`realpathSync` and rejected if it lands outside the extract directory:

`src/cli/registry-client.ts` — `assertExtractionWithinDir` (escape check):

```ts
    if (real !== realRoot && !real.startsWith(rootPrefix)) {
      throw new Error(
        `extraction failed for role "${roleId}": entry "${rel}" resolves outside the extract directory (${real}); refusing unsafe archive (zip-slip / path traversal)`,
      );
    }
```

**F4.6 / A9 — `rolebox-out-*` temp dir is cleaned on every failure path.** A `committed` flag keeps
only the successfully renamed output directory; the `finally` removes both temp dirs otherwise:

`src/cli/registry-client.ts` — `downloadRole` (finally cleanup):

```ts
  } finally {
    // Always clean up the temporary extraction workspace. Additionally remove
    // the `rolebox-out-*` outputDir on every FAILURE path — only the committed
    // (successfully renamed) outputDir survives.
    rmSync(tmpDir, { recursive: true, force: true });
    if (!committed) {
      rmSync(outputDir, { recursive: true, force: true });
    }
  }
```

**F2.3 / A11 — Windows uses junctions (no Developer Mode / elevation needed).** `sync` no longer calls
`symlinkSync` directly; the shared helper creates a `"junction"` on Windows and a plain symlink
elsewhere. A copy fallback is still absent (EPERM is logged and rethrown):

`src/utils/symlink.ts` — `createDirSymlink` (Windows junction):

```ts
export function createDirSymlink(target: string, link: string): void {
  try {
    if (isWindows()) {
      // Junctions require an absolute native drive path. skill filePaths are
      // POSIX-normalized, so dirname-derived targets carry forward slashes on
      // win32; normalize to native separators before handing to libuv.
      fs.symlinkSync(path.win32.resolve(target), path.win32.resolve(link), "junction");
    } else {
      fs.symlinkSync(target, link);
    }
```

**F5.1 / A12 — CI runs a cross-platform matrix.** The workflow now runs on all three supported
platforms:

`.github/workflows/ci.yml` — `test` job strategy:

```yml
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
```
