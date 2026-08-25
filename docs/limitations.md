# Limitations

> Part of the rolebox documentation. See [README](../README.md) for overview.

- No role inheritance
- No runtime role switching
- Functions persist for the entire session (no per-message deactivation yet)
- No conditional functions based on project context
- Recursive file-based subagent nesting is supported (max depth: 3). `--` is reserved as the parent/child separator.
- `--` is reserved in role IDs (used as the parent/child separator)

## Pi (plugin platform) parity

Tool-surface parity with the opencode plugin is enforced by `tests/pi-parity.test.ts`: the shared opencode tool surface — hashline/memory/web/signal/asset/reference/session/graph_*/task_* plus memory_update/lsp_*/function_graph/skill_compose/context_assemble — is registered by `PiLightweightServiceStack` on Pi. See [compatibility.md](compatibility.md) for the parity matrix.

- `dispatch_*` / `loop_*` / `task_retry` are intentionally withheld on both platforms: orchestration is graph-only, and bare dispatch/loop calls would bypass the graph engine's budget accounting, approval gates, and loop caps.
- `asset_hot_reload` is opencode-only and is deliberately not forwarded to Pi.

### Platform-inherent gaps (explicit non-goals on Pi)

Pi runs `PiLightweightServiceStack` instead of the full PluginCore service stack, so the following opencode-only subsystems are out of scope on Pi:

- Hot reload (`asset_hot_reload` tool + `HotReloadService`)
- Extensions (the PluginCore `ExtensionService` extension loader)
- Recovery engine (`RecoveryService` / `RecoveryEngine` crash and error-recovery strategies; only graph-engine startup recovery runs on Pi)
- TUI (the interactive terminal UI binary is opencode-only)

## hashline_edit concurrency semantics

`hashline_edit` serializes edits to the same file **within a single process** (per-path async mutex covering the full read → validate → compute → recheck → write cycle) and rejects duplicate file paths in one batch, including platform-appropriate case aliases on case-insensitive filesystems (darwin/win32).

- **In-process safety**: concurrent `hashline_edit` calls to the same file cannot lost-update each other — they serialize, and the stale caller fails with a version-mismatch error. Overlapping multi-file batches acquire locks in a global sorted order, so they cannot deadlock.
- **External / cross-process changes** are only caught by a best-effort pre-write re-check: each file's content version is recomputed immediately before writing and compared to the version observed during the read phase (to-be-created files must still be absent). A file changed between that re-check and the rename (a small window) is not detected — this is **not** a strict cross-process CAS. On any detected conflict the whole batch fails with zero writes; re-run `hashline_read` and retry.
- **A batch is not a cross-file transaction**: files are written one at a time (per-file temp + atomic rename), so a write failure or crash mid-batch can leave earlier files updated and later files untouched. Writes are not fsync-durable; they protect against torn/partial writes within the process, not power loss.
